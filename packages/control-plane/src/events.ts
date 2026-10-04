/**
 * Потребитель журнала событий Control Plane внутри харнесса — TypeScript-версия
 * контракта CP-ADR-0069:
 * - источник истины один — `GET /events` от сохранённого курсора с фильтром типов;
 * - WebSocket `/events/ws` только будит цикл чтения, кадры не обрабатываются;
 * - страховочный опрос раз в `pollIntervalMs` (30 с) покрывает отсутствие сокета;
 * - курсор и отметки `event.id` двигаются после каждого события, поэтому
 *   перезапуск посреди страницы не теряет хвост и не повторяет начало;
 * - упавшая страница читается заново с паузой 1 с → 60 с; отказ в подписке
 *   (401/403/404/422) останавливает потребителя — повтор его не изменит.
 *
 * Хранилище — файл в `$DSH_HOME/harness` (контейнер одного человека, одна
 * запись курсора), запись атомарна.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ControlPlaneError, type ControlPlaneClient } from './client.ts'

/** Событие журнала в форме `EventOut` ядра плюс непрозрачный курсор. */
export interface JournalEvent {
  id: string
  type: string
  entityType: string
  entityId: string
  actorId: string | null
  workspaceId?: string | null
  schemaVersion?: number
  payload: Record<string, unknown>
  occurredAt: string
  cursor: string
}

export interface CursorState {
  cursor: string | null
  /** `event.id` → время обработки (мс); отметки старше `DEDUP_RETENTION_MS` удаляются. */
  handled: Record<string, number>
}

export const DEDUP_RETENTION_MS = 7 * 24 * 3600_000
const DEDUP_MAX = 5000

export class CursorFile {
  private cache: CursorState | undefined

  constructor(private readonly path: string) {}

  load(): CursorState {
    if (this.cache !== undefined) return this.cache
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<CursorState>
      this.cache = { cursor: typeof raw.cursor === 'string' ? raw.cursor : null, handled: raw.handled ?? {} }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.cache = { cursor: null, handled: {} }
    }
    return this.cache
  }

  save(state: CursorState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    renameSync(tmp, this.path)
    this.cache = state
  }
}

/** Минимум WebSocket, который нужен будильнику; в тестах подменяется. */
export interface WakeSocket {
  onmessage: ((event: unknown) => void) | null
  onclose: ((event: { code: number }) => void) | null
  onerror: ((event: unknown) => void) | null
  close(): void
}

export type WakeSocketFactory = (url: string, authorization: string) => WakeSocket

export const defaultSocketFactory: WakeSocketFactory = (url, authorization) => {
  // Node ≥ 22: WebSocket из undici принимает заголовки вторым аргументом.
  const Ctor = globalThis.WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WakeSocket
  return new Ctor(url, { headers: { authorization } })
}

export interface EventConsumerOptions {
  client: ControlPlaneClient
  /** Префиксы типов событий (фильтр ADR-0068), например `approval.`. */
  types: string[]
  store: CursorFile
  handler: (event: JournalEvent) => Promise<void>
  /** Первая позиция без сохранённого курсора: `latest` — только новое (по умолчанию). */
  start?: 'latest' | 'earliest'
  pollIntervalMs?: number
  retryInitialMs?: number
  retryMaxMs?: number
  pageSize?: number
  socketFactory?: WakeSocketFactory | null
  log: { info(msg: string): void, warn(msg: string): void, error(msg: string): void }
  now?: () => number
}

const FATAL = new Set([401, 403, 404, 422])

export class EventConsumer {
  private stopped = true
  private draining: Promise<void> | null = null
  private again = false
  private pollTimer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private retryMs: number
  private socket: WakeSocket | null = null
  private socketTimer: NodeJS.Timeout | null = null
  private socketRetryMs: number
  private readonly now: () => number
  /** Последняя ошибка чтения (для диагностики в UI). */
  lastError: string | null = null

  constructor(private readonly options: EventConsumerOptions) {
    this.now = options.now ?? Date.now
    this.retryMs = options.retryInitialMs ?? 1000
    this.socketRetryMs = options.retryInitialMs ?? 1000
  }

  get running(): boolean {
    return !this.stopped
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    const poll = this.options.pollIntervalMs ?? 30_000
    this.pollTimer = setInterval(() => this.wake(), poll)
    this.pollTimer.unref?.()
    this.wake()
    this.connectSocket()
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const timer of [this.pollTimer, this.retryTimer, this.socketTimer]) if (timer !== null) clearTimeout(timer)
    this.pollTimer = this.retryTimer = this.socketTimer = null
    const socket = this.socket
    this.socket = null
    if (socket !== null) { socket.onclose = null; socket.close() }
    await this.draining?.catch(() => undefined)
  }

  /** Разбудить цикл чтения; вызов во время чтения даёт ещё один проход. */
  wake(): void {
    if (this.stopped) return
    if (this.draining !== null) { this.again = true; return }
    this.draining = this.drainLoop().finally(() => { this.draining = null })
  }

  /** Дождаться текущего прохода (для тестов и корректной остановки). */
  async idle(): Promise<void> {
    while (this.draining !== null) await this.draining.catch(() => undefined)
  }

  private async drainLoop(): Promise<void> {
    do {
      this.again = false
      try {
        await this.drain()
        this.lastError = null
        this.retryMs = this.options.retryInitialMs ?? 1000
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
        if (error instanceof ControlPlaneError && FATAL.has(error.status)) {
          this.options.log.error(`events: подписка отклонена (${error.status} ${error.code}) — потребитель остановлен`)
          this.stopped = true
          return
        }
        this.options.log.warn(`events: чтение не прошло, повтор через ${this.retryMs} мс: ${this.lastError}`)
        const delay = this.retryMs
        this.retryMs = Math.min(this.retryMs * 2, this.options.retryMaxMs ?? 60_000)
        if (this.retryTimer === null && !this.stopped) {
          this.retryTimer = setTimeout(() => { this.retryTimer = null; this.wake() }, delay)
          this.retryTimer.unref?.()
        }
        return
      }
    } while (this.again && !this.stopped)
  }

  private async drain(): Promise<void> {
    const { client, store } = this.options
    const types = this.options.types.join(',')
    let state = store.load()
    if (state.cursor === null) {
      const start = this.options.start ?? 'latest'
      if (start === 'latest') {
        const tail = await client.listEvents({ tail: 1, types })
        state = { ...state, cursor: tail.nextCursor }
        store.save(state)
        this.options.log.info('events: первая позиция — после последнего события журнала')
        return
      }
    }
    for (;;) {
      if (this.stopped) return
      const page = await client.listEvents({ cursor: state.cursor, limit: this.options.pageSize ?? 200, types })
      for (const raw of page.items) {
        if (this.stopped) return
        const event = raw as unknown as JournalEvent
        if (state.handled[event.id] === undefined) {
          await this.options.handler(event)
          state = { cursor: event.cursor, handled: { ...state.handled, [event.id]: this.now() } }
        } else {
          state = { ...state, cursor: event.cursor }
        }
        store.save(state)
      }
      state = { cursor: page.nextCursor, handled: prune(state.handled, this.now()) }
      store.save(state)
      if (!page.hasMore) return
    }
  }

  private connectSocket(): void {
    const factory = this.options.socketFactory === undefined ? defaultSocketFactory : this.options.socketFactory
    if (factory === null || this.stopped) return
    void (async () => {
      try {
        const after = this.options.store.load().cursor ?? '0'
        const url = this.options.client.eventsSocketUrl({ after, types: this.options.types.join(',') })
        const socket = factory(url, await this.options.client.authorization())
        this.socket = socket
        socket.onmessage = () => {
          this.socketRetryMs = this.options.retryInitialMs ?? 1000
          this.wake()
        }
        socket.onerror = () => undefined
        socket.onclose = (event) => {
          if (this.socket !== socket) return
          this.socket = null
          if (event.code === 4401) this.options.client.invalidateToken()
          this.scheduleReconnect()
        }
        // После любого (пере)подключения — один проход вне очереди.
        this.wake()
      } catch (error) {
        this.options.log.warn(`events: WebSocket не открыт: ${error instanceof Error ? error.message : String(error)}`)
        this.scheduleReconnect()
      }
    })()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.socketTimer !== null) return
    const delay = this.socketRetryMs
    this.socketRetryMs = Math.min(this.socketRetryMs * 2, this.options.retryMaxMs ?? 60_000)
    this.socketTimer = setTimeout(() => { this.socketTimer = null; this.connectSocket() }, delay)
    this.socketTimer.unref?.()
  }
}

function prune(handled: Record<string, number>, now: number): Record<string, number> {
  const fresh = Object.entries(handled).filter(([, at]) => now - at < DEDUP_RETENTION_MS)
  fresh.sort((a, b) => b[1] - a[1])
  return Object.fromEntries(fresh.slice(0, DEDUP_MAX))
}
