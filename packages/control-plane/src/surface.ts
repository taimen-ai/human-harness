/**
 * API поверхности беседы в контейнере (контракт `surface/1`,
 * superproject `docs/contracts/harness-surface/`; амендмент TAI-ADR-0051 2026-09-29).
 * Консоль — третья поверхность той же единственной беседы после окна и Telegram.
 *
 * - `message` — реплика ложится в беседу (`DshConversation`) с источником
 *   `{kind: 'surface', surface, requestId, screenContext}`; идемпотентность по
 *   `requestId`; занятый ассистент — очередь хода (`followup`).
 * - `stream` — SSE вида всей беседы: журнал сессии беседы (`session/event`) и живые
 *   токены (`agent/assistant-stream`) переводятся в события контракта.
 * - `history` — страница сообщений из журнала беседы (`sessionController.page`).
 * - `approval` — ответ на подтверждение в общем {@link ApprovalHub}.
 *
 * Курсор потока — `<эпоха процесса>.<номер>`, события хранятся в кольцевом буфере
 * памяти ({@link RING_LIMIT} последних). `ready` приходит ровно один раз на
 * подключение и всегда несёт `resumed`: `true` — события после курсора
 * (`Last-Event-ID` / `after`) отданы из буфера; `false` — курсора нет, он из другой
 * эпохи (контейнер перезапускался, например после сна) или старше буфера — клиент
 * перечитывает `history`.
 *
 * Лимиты: не больше {@link MAX_STREAMS} потоков сразу (`429 too_many_streams`),
 * медленный читатель, у которого в буфере сокета скопилось больше
 * {@link MAX_BUFFERED_BYTES}, отключается (переподключится с курсором); тело
 * запроса — до 64 КБ (`413 body_too_large`). `delta` в буфер не пишется: это живое отображение,
 * итог хода всегда приходит `message`, а id у `delta` — курсор последнего события
 * буфера, так что возобновление с него ничего не теряет.
 *
 * `delta` берётся из хука хоста `agent/assistant-stream` (кадры `text-delta`
 * драйвера модели). Его `messageId` — id попытки модели (`attemptId`): id итогового
 * сообщения до фиксации хода неизвестен.
 *
 * Приватность: тексты сообщений не пишутся в журнал процесса — только requestId,
 * длины и коды.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApprovalHub, ApprovalStreamEvent, Decision, Surface } from './approvals.ts'
import type { Delivery, DeliverMeta, JournalEvent, SurfaceScreenRef } from './conversation.ts'

export const SURFACE_VERSION = 'surface/1'
export const SURFACE_VERSION_HEADER = 'x-harness-surface-version'
export const SURFACE_HEADER = 'x-harness-surface'
/** Поверхности, которые говорят через этот API (окно и Telegram входят своими путями). */
export const API_SURFACES = ['console'] as const
export const SCREEN_CONTEXT_MAX_BYTES = 8 * 1024
export const RING_LIMIT = 1000
export const HEARTBEAT_MS = 15_000
export const MAX_STREAMS = 8
export const MAX_BUFFERED_BYTES = 1024 * 1024
const IDEMPOTENCY_LIMIT = 500
/** Сколько ход, вызванный репликой консоли, считается её ходом до того, как очередь событий его увидит. */
const CONSOLE_TURN_GRACE_MS = 60_000
/** Сколько последних requestId реплик консоли помнит очередь событий (защита от гонки с доставкой). */
const SEEN_REQUESTS_LIMIT = 100
const SCREEN_LIMIT = 100

const SCREEN_KINDS = new Set(['pulse', 'work', 'run', 'process_instance', 'rule', 'agent', 'principal', 'package', 'approval', 'artifact', 'knowledge', 'org', 'journal', 'other'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface SurfaceMessage {
  id: string
  role: 'user' | 'assistant'
  surface?: Surface
  text: string
  at: string
  requestId?: string
  screenContext?: SurfaceScreenRef
}

/** Событие потока без курсора и времени. */
export type SurfaceEventBody =
  | { type: 'ready', resumed: boolean }
  | { type: 'message', message: SurfaceMessage }
  | { type: 'delta', messageId: string, text: string }
  | { type: 'turn.started', turnId: string, requestId?: string }
  | { type: 'turn.ended', turnId: string, requestId?: string, status: 'completed' | 'failed' | 'cancelled', error?: string }
  | { type: 'tool.summary', turnId: string, tool: string, title: string, status: 'started' | 'succeeded' | 'failed' }
  | ApprovalStreamEvent

export type SurfaceEvent = SurfaceEventBody & { cursor: string, at: string }

/** Порт беседы: {@link DshConversation} на хосте, подделка в тестах. */
export interface SurfaceConversation {
  sessionId(): Promise<string>
  deliver(text: string, sourceKind: string, meta: DeliverMeta): Promise<Delivery>
  page(sessionId: string, beforeSeq: number | undefined, maxMessages: number): Promise<{ events: JournalEvent[], hasMore: boolean }>
}

export class SurfaceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map(part => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : '')).join('').trim()
}

/** Пометку канала для модели (`[Из Telegram] `) человеку не показываем. */
function stripChannelMark(text: string): string {
  return text.replace(/^\[Из [^\]]{1,40}\]\s*/, '')
}

function screenRef(value: unknown): SurfaceScreenRef | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (typeof v.kind !== 'string' || typeof v.url !== 'string') return undefined
  return {
    kind: v.kind,
    ...(typeof v.id === 'string' ? { id: v.id } : {}),
    ...(typeof v.label === 'string' ? { label: v.label } : {}),
    url: v.url,
  }
}

/**
 * Сообщение журнала → сообщение поверхности. Показываются только реплики человека
 * (окно, Telegram, поверхности API) и текст ассистента; события платформы, секции
 * контекста и вызовы инструментов — нет.
 */
export function toSurfaceMessage(event: JournalEvent): SurfaceMessage | null {
  const data = (event.data ?? {}) as Record<string, unknown>
  const at = new Date(event.time).toISOString()
  if (event.type === 'user/message') {
    const source = (data.source ?? {}) as Record<string, unknown>
    let surface: Surface
    let extra: Partial<SurfaceMessage> = {}
    if (source.kind === 'user') surface = 'window'
    else if (source.kind === 'channel' && source.channel === 'telegram') surface = 'telegram'
    else if (source.kind === 'surface' && source.surface === 'console') {
      surface = 'console'
      const ref = screenRef(source.screenContext)
      extra = { ...(typeof source.requestId === 'string' ? { requestId: source.requestId } : {}), ...(ref ? { screenContext: ref } : {}) }
    } else return null
    const text = textOf(data.content)
    return { id: String(data.id ?? `seq-${event.seq}`), role: 'user', surface, text: surface === 'telegram' ? stripChannelMark(text) : text, at, ...extra }
  }
  if (event.type === 'assistant/message') {
    const message = (data.message ?? {}) as Record<string, unknown>
    const text = textOf(message.content)
    if (text === '') return null
    return { id: String(message.id ?? `seq-${event.seq}`), role: 'assistant', text, at }
  }
  return null
}

/** Имя инструмента для человека: без служебного префикса MCP. */
export function toolTitle(name: string): { tool: string, title: string } {
  const tool = name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '').slice(0, 200)
  return { tool, title: `Инструмент ${tool}`.slice(0, 300) }
}

function turnStatus(reason: unknown): { status: 'completed' | 'failed' | 'cancelled', error?: string } {
  const kind = (reason as { kind?: unknown } | undefined)?.kind
  if (kind === 'completed' || kind === 'max-tokens') return { status: 'completed' }
  if (kind === 'error') {
    const message = String(((reason as { error?: { message?: unknown } }).error?.message) ?? 'error')
    return { status: 'failed', error: message.slice(0, 500) }
  }
  if (kind === 'blocked') return { status: 'failed', error: 'blocked' }
  return { status: 'cancelled' }
}

interface OpenTurn {
  turn: number
  turnId: string
  announced: boolean
  requestId?: string
  tools: Map<string, string>
}

export interface SurfaceBridgeOptions {
  conversation: SurfaceConversation
  log: { info(msg: string): void, warn(msg: string): void }
  /**
   * Человек открыл беседу в консоли (первая страница истории). Веб-окна у харнесса нет,
   * поэтому сводку «пока вас не было» (проактивность) будит именно это открытие.
   */
  presence?: () => void
  ringLimit?: number
  now?: () => number
}

type Subscriber = (event: SurfaceEvent) => void

export class SurfaceBridge {
  private readonly epoch = randomBytes(4).toString('hex')
  private counter = 0
  private readonly ring: SurfaceEvent[] = []
  private readonly subscribers = new Set<Subscriber>()
  private chain: Promise<void> = Promise.resolve()
  private conversationId: { id: string | null, at: number } | null = null
  private turn: OpenTurn | null = null
  /**
   * Реплика консоли, доставленная свободному ассистенту: её ход начинается сразу, а
   * очередь событий журнала ({@link map}) может отставать. `requestId` хода известен
   * с доставки, поэтому «ход вызван сообщением консоли» (правило b) действует с этого
   * момента, а не с момента, когда очередь дойдёт до реплики.
   *
   * Метка снимается, когда очередь видит реплику (дальше ход знает `requestId` сам) или
   * конец её хода: `turnId` — ход, который очередь увидела начавшимся после доставки.
   * Конец хода снимает метку и без реплики в журнале — отклонённый или прерванный шаг
   * пишет только `turn/start` и `turn/end`. Иначе метка дожила бы до чужого хода.
   */
  private consoleTurn: { sessionId: string, requestId: string, at: number, turnId?: string } | null = null
  /** Сколько `turn/start` видела очередь и какой последним: ход реплики, начавшийся до возврата доставки. */
  private turnStarts = 0
  private lastStartedTurnId: string | null = null
  /** requestId реплик консоли, до которых очередь уже дошла (последние {@link SEEN_REQUESTS_LIMIT}). */
  private readonly seenRequests = new Set<string>()
  private readonly requests = new Map<string, { fingerprint: string, result: Promise<{ requestId: string, messageId: string, queued: boolean }> }>()
  /** Полный контекст экрана до входа хода: секция `screen-context` (проекция в журнал не пишется). */
  private readonly screens = new Map<string, Record<string, unknown>>()
  private approvals: ApprovalHub | null = null
  private readonly now: () => number

  constructor(private readonly options: SurfaceBridgeOptions) {
    this.now = options.now ?? Date.now
  }

  attachApprovals(hub: ApprovalHub): void {
    this.approvals = hub
  }

  /** Журнал процесса (без текстов сообщений). */
  get log(): SurfaceBridgeOptions['log'] {
    return this.options.log
  }

  /** Сколько клиентов сейчас читают поток. */
  subscriberCount(): number {
    return this.subscribers.size
  }

  /**
   * Может ли консоль ответить на подтверждение хода этой сессии: ход вызван её
   * сообщением или к потоку подключён хотя бы один клиент.
   */
  consoleListening(sessionId: string): boolean {
    if (this.subscribers.size > 0) return true
    if (this.conversationId?.id !== sessionId) return false
    if (this.turn?.requestId !== undefined) return true
    const delivered = this.consoleTurn
    return delivered !== null && delivered.sessionId === sessionId && this.now() - delivered.at < CONSOLE_TURN_GRACE_MS
  }

  // ---- поток -----------------------------------------------------------

  private get lastCursor(): string {
    return `${this.epoch}.${this.counter}`
  }

  private push(body: SurfaceEventBody, buffered = true): void {
    if (buffered) this.counter += 1
    const event = { ...body, cursor: this.lastCursor, at: new Date(this.now()).toISOString() } as SurfaceEvent
    if (buffered) {
      this.ring.push(event)
      if (this.ring.length > (this.options.ringLimit ?? RING_LIMIT)) this.ring.shift()
    }
    for (const subscriber of this.subscribers) {
      try { subscriber(event) } catch { /* подписчик отвалился — его снимет close */ }
    }
  }

  /** Упорядоченная обработка: события журнала, токены и подтверждения — одной очередью. */
  private enqueue(task: () => Promise<void> | void): void {
    this.chain = this.chain.then(task).catch((error: unknown) => this.options.log.warn(`surface: событие беседы не обработано: ${String(error)}`))
  }

  /** Дождаться обработки уже поставленных событий (тесты, ответы маршрутов). */
  settled(): Promise<void> {
    return this.chain
  }

  /** Событие подтверждения от {@link ApprovalHub}. */
  publishApproval(event: ApprovalStreamEvent): void {
    this.enqueue(() => this.push(event))
  }

  /** Подписка с возобновлением; возвращает события после курсора и отписку. */
  subscribe(after: string | null, subscriber: Subscriber): { ready: SurfaceEvent, replay: SurfaceEvent[], close: () => void } {
    let replay: SurfaceEvent[] = []
    let resumed = false
    if (after !== null) {
      const [epoch, n] = after.split('.')
      const seq = Number(n)
      const first = this.ring.length > 0 ? this.counter - this.ring.length + 1 : this.counter + 1
      resumed = epoch === this.epoch && Number.isSafeInteger(seq) && seq >= first - 1 && seq <= this.counter
      if (resumed) replay = this.ring.filter(e => Number(e.cursor.split('.')[1]) > seq)
    }
    const ready = { type: 'ready', resumed, cursor: this.lastCursor, at: new Date(this.now()).toISOString() } as SurfaceEvent
    this.subscribers.add(subscriber)
    return { ready, replay, close: () => { this.subscribers.delete(subscriber) } }
  }

  // ---- журнал беседы → события --------------------------------------------

  private async currentConversation(): Promise<string | null> {
    const at = this.now()
    if (this.conversationId !== null && at - this.conversationId.at < 30_000) return this.conversationId.id
    let id: string | null = null
    try {
      id = await this.options.conversation.sessionId()
    } catch {
      id = this.conversationId?.id ?? null
    }
    this.conversationId = { id, at }
    return id
  }

  /** Текущий ход беседы для `turnId` подтверждения. */
  turnOf(sessionId: string): string | undefined {
    return this.conversationId?.id === sessionId ? this.turn?.turnId : undefined
  }

  /** Наблюдатель `session/event` (global). */
  onSessionEvent(sessionId: string, event: JournalEvent): void {
    this.enqueue(async () => {
      if (await this.currentConversation() !== sessionId) return
      this.map(sessionId, event)
    })
  }

  /** Наблюдатель `agent/assistant-stream`: живые токены ответа. */
  onAssistantStream(sessionId: string, frame: { type: string, attemptId?: unknown, chunk?: unknown }): void {
    if (frame.type !== 'chunk') return
    const chunk = (frame.chunk ?? {}) as { type?: unknown, text?: unknown }
    if (chunk.type !== 'text-delta' || typeof chunk.text !== 'string' || chunk.text === '') return
    const text = chunk.text
    this.enqueue(async () => {
      if (await this.currentConversation() !== sessionId) return
      this.announce()
      this.push({ type: 'delta', messageId: String(frame.attemptId ?? ''), text }, false)
    })
  }

  private announce(): void {
    const turn = this.turn
    if (turn === null || turn.announced) return
    turn.announced = true
    this.push({ type: 'turn.started', turnId: turn.turnId, ...(turn.requestId !== undefined ? { requestId: turn.requestId } : {}) })
  }

  private map(sessionId: string, event: JournalEvent): void {
    const data = (event.data ?? {}) as Record<string, unknown>
    switch (event.type) {
      case 'turn/start': {
        const n = Number(data.turn)
        this.turn = { turn: n, turnId: `${sessionId}.${n}`, announced: false, tools: new Map() }
        this.turnStarts += 1
        this.lastStartedTurnId = this.turn.turnId
        // Первый ход после доставки реплики консоли — её ход: его конец снимет метку.
        if (this.consoleTurn !== null && this.consoleTurn.turnId === undefined) this.consoleTurn.turnId = this.turn.turnId
        return
      }
      case 'user/message': {
        const source = (data.source ?? {}) as Record<string, unknown>
        // Ход объявляется по первой реплике: только теперь известно, кто его вызвал.
        if (this.turn !== null && !this.turn.announced && source.kind === 'surface' && typeof source.requestId === 'string') {
          this.turn.requestId = source.requestId
        }
        // Очередь дошла до реплики консоли: дальше ход знает её requestId сам.
        if (source.kind === 'surface' && typeof source.requestId === 'string') {
          this.rememberSeen(source.requestId)
          if (this.consoleTurn?.requestId === source.requestId) this.consoleTurn = null
        }
        this.announce()
        const message = toSurfaceMessage(event)
        if (message !== null) this.push({ type: 'message', message })
        return
      }
      case 'assistant/message': {
        this.announce()
        const message = toSurfaceMessage(event)
        if (message !== null) this.push({ type: 'message', message })
        return
      }
      case 'tool/call': {
        this.announce()
        if (this.turn === null) return
        const { tool, title } = toolTitle(String(data.name ?? 'tool'))
        this.turn.tools.set(String(data.callId), tool)
        this.push({ type: 'tool.summary', turnId: this.turn.turnId, tool, title, status: 'started' })
        return
      }
      case 'tool/result': {
        if (this.turn === null) return
        const message = (data.message ?? {}) as { toolCallId?: unknown, isError?: unknown }
        const tool = this.turn.tools.get(String(message.toolCallId))
        if (tool === undefined) return
        this.turn.tools.delete(String(message.toolCallId))
        this.push({ type: 'tool.summary', turnId: this.turn.turnId, tool, title: toolTitle(tool).title, status: message.isError === true ? 'failed' : 'succeeded' })
        return
      }
      case 'turn/end': {
        const turn = this.turn
        if (turn === null) return
        this.announce()
        this.turn = null
        const mark = this.consoleTurn
        if (mark !== null && (mark.turnId === turn.turnId || (turn.requestId !== undefined && turn.requestId === mark.requestId))) this.consoleTurn = null
        this.push({ type: 'turn.ended', turnId: turn.turnId, ...(turn.requestId !== undefined ? { requestId: turn.requestId } : {}), ...turnStatus(data.reason) })
        return
      }
      default:
    }
  }

  // ---- сообщение --------------------------------------------------------

  /** Принять реплику поверхности (тело уже разобрано из JSON). */
  async message(surface: string, body: unknown): Promise<{ requestId: string, messageId: string, queued: boolean }> {
    const parsed = parseMessage(body)
    const fingerprint = createHash('sha256').update(JSON.stringify([surface, parsed.text, parsed.screenContext])).digest('hex')
    const known = this.requests.get(parsed.requestId)
    if (known !== undefined) {
      if (known.fingerprint !== fingerprint) throw new SurfaceError(409, 'request_id_reused', 'requestId уже использован с другим телом')
      return known.result
    }
    const result = (async () => {
      const startsBefore = this.turnStarts
      const screen = parsed.screenContext
      if (screen !== null) this.rememberScreen(parsed.requestId, screen)
      const ref = screen === null ? null : screenRef(screen)!
      const delivery = await this.options.conversation.deliver(parsed.text, 'surface', {
        surface: { surface, requestId: parsed.requestId, screenContext: ref },
      })
      this.conversationId = { id: delivery.sessionId, at: this.now() }
      // Свободный ассистент начинает ход этой репликой сразу: requestId хода — с доставки.
      // Реплика в очереди (ассистент занят) своего хода ещё не начала — текущий ход не её.
      if (!delivery.queued) this.markConsoleTurn(delivery.sessionId, parsed.requestId, startsBefore)
      this.options.log.info(`surface: сообщение ${parsed.requestId} (${surface}, ${parsed.text.length} симв.) принято${delivery.queued ? ', в очереди' : ''}`)
      return { requestId: parsed.requestId, messageId: delivery.messageId, queued: delivery.queued }
    })()
    this.requests.set(parsed.requestId, { fingerprint, result })
    if (this.requests.size > IDEMPOTENCY_LIMIT) this.requests.delete(this.requests.keys().next().value!)
    result.catch(() => {
      // Недоставленное можно повторить тем же requestId.
      if (this.requests.get(parsed.requestId)?.result === result) this.requests.delete(parsed.requestId)
      this.screens.delete(parsed.requestId)
    })
    return result
  }

  /**
   * Пометить ход реплики консоли как её ход (правило b) — если очередь событий его ещё
   * не догнала. Журнал пишется до возврата `flush`, и очередь могла пройти ход, пока
   * доставка ждала: тогда метка не ставится или сразу привязывается к уже начатому ходу.
   */
  private markConsoleTurn(sessionId: string, requestId: string, startsBefore: number): void {
    // Очередь уже видела реплику: ход знает свой requestId (или уже закончился).
    if (this.seenRequests.has(requestId)) return
    const started = this.turnStarts - startsBefore
    // Ход реплики начался и за ним уже следующий — её ход закончился.
    if (started > 1) return
    let turnId: string | undefined
    if (started === 1) {
      // Ход начался во время доставки: открыт — метка его; закрыт (отклонённый шаг) — метки нет.
      if (this.turn === null || this.turn.turnId !== this.lastStartedTurnId) return
      turnId = this.turn.turnId
    }
    this.consoleTurn = { sessionId, requestId, at: this.now(), ...(turnId !== undefined ? { turnId } : {}) }
  }

  private rememberSeen(requestId: string): void {
    this.seenRequests.delete(requestId)
    this.seenRequests.add(requestId)
    if (this.seenRequests.size > SEEN_REQUESTS_LIMIT) this.seenRequests.delete(this.seenRequests.values().next().value!)
  }

  private rememberScreen(requestId: string, screen: Record<string, unknown>): void {
    this.screens.set(requestId, screen)
    if (this.screens.size > SCREEN_LIMIT) this.screens.delete(this.screens.keys().next().value!)
  }

  /**
   * Контекст экрана для хода: забирается один раз, когда реплика входит в шаг
   * (`agent/pre-step`), и вписывается секцией `screen-context` (`screen-context.ts`);
   * реплика, не вошедшая в ход, выбрасывает его тем же вызовом.
   */
  takeScreenContext(requestId: string): Record<string, unknown> | undefined {
    const screen = this.screens.get(requestId)
    this.screens.delete(requestId)
    return screen
  }

  // ---- история ----------------------------------------------------------

  async history(before: string | null, limit: number): Promise<{ items: SurfaceMessage[], nextBefore: string | null }> {
    let beforeSeq: number | undefined
    if (before === null) this.options.presence?.()
    if (before !== null) {
      beforeSeq = Number(before)
      if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0) throw new SurfaceError(400, 'invalid_cursor', 'before — курсор из nextBefore')
    }
    const sessionId = await this.options.conversation.sessionId()
    const collected: { seq: number, message: SurfaceMessage }[] = []
    let cursor = beforeSeq
    let exhausted = false
    // Реплики человека и ответы — часть сообщений журнала: листаем, пока не наберём limit.
    for (let round = 0; round < 10 && collected.length < limit; round += 1) {
      const page = await this.options.conversation.page(sessionId, cursor, Math.min(300, limit * 3))
      const found: { seq: number, message: SurfaceMessage }[] = []
      for (const event of page.events) {
        const message = toSurfaceMessage(event)
        if (message !== null) found.push({ seq: event.seq, message })
      }
      collected.unshift(...found)
      if (!page.hasMore || page.events.length === 0) { exhausted = true; break }
      cursor = page.events[0]!.seq
    }
    // collected — по возрастанию; отдаём новые limit, курсор — самое старое из отданных.
    const items = collected.slice(-limit)
    const more = collected.length > limit || !exhausted
    return {
      items: items.map(item => item.message).reverse(),
      nextBefore: !more ? null : items.length > 0 ? String(items[0]!.seq) : cursor !== undefined ? String(cursor) : null,
    }
  }

  // ---- подтверждение ----------------------------------------------------

  approval(surface: Surface, body: unknown) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new SurfaceError(400, 'bad_request', 'тело — объект')
    const b = body as Record<string, unknown>
    for (const key of Object.keys(b)) if (!['approvalRequestId', 'decision', 'comment'].includes(key)) throw new SurfaceError(400, 'bad_request', `лишнее поле ${key}`)
    if (typeof b.approvalRequestId !== 'string' || b.approvalRequestId === '' || b.approvalRequestId.length > 200) throw new SurfaceError(400, 'bad_request', 'approvalRequestId обязателен')
    if (b.decision !== 'allow' && b.decision !== 'reject') throw new SurfaceError(400, 'bad_request', 'decision: allow | reject')
    if (b.comment !== undefined && (typeof b.comment !== 'string' || b.comment.length > 2000)) throw new SurfaceError(400, 'bad_request', 'comment — строка до 2000')
    const comment = typeof b.comment === 'string' && b.comment.trim() !== '' ? b.comment.trim() : undefined
    const result = this.approvals?.decide(b.approvalRequestId, b.decision as Decision, surface, comment) ?? null
    if (result === null) throw new SurfaceError(404, 'approval_not_found', 'запроса подтверждения нет')
    return result
  }
}

interface ParsedMessage {
  requestId: string
  text: string
  screenContext: Record<string, unknown> | null
}

function parseMessage(body: unknown): ParsedMessage {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new SurfaceError(400, 'bad_request', 'тело — объект')
  const b = body as Record<string, unknown>
  for (const key of Object.keys(b)) if (!['requestId', 'text', 'screenContext'].includes(key)) throw new SurfaceError(400, 'bad_request', `лишнее поле ${key}`)
  if (typeof b.requestId !== 'string' || !UUID.test(b.requestId)) throw new SurfaceError(400, 'bad_request', 'requestId — UUID')
  if (typeof b.text !== 'string' || b.text.length < 1 || b.text.length > 20_000 || b.text.trim() === '') throw new SurfaceError(400, 'bad_request', 'text — 1..20000 символов')
  const screen = b.screenContext ?? null
  if (screen !== null) {
    if (Buffer.byteLength(JSON.stringify(screen), 'utf8') > SCREEN_CONTEXT_MAX_BYTES) throw new SurfaceError(413, 'screen_context_too_large', 'screenContext больше 8 КБ')
    validateScreen(screen)
  }
  return { requestId: b.requestId.toLowerCase(), text: b.text, screenContext: screen as Record<string, unknown> | null }
}

function validateScreen(value: unknown): void {
  const bad = (why: string): never => { throw new SurfaceError(400, 'bad_request', `screenContext: ${why}`) }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad('объект')
  const v = value as Record<string, unknown>
  const allowed = ['kind', 'id', 'label', 'url', 'workspaceId', 'projection', 'capturedAt']
  for (const key of Object.keys(v)) if (!allowed.includes(key)) bad(`лишнее поле ${key}`)
  if (typeof v.kind !== 'string' || !SCREEN_KINDS.has(v.kind)) bad('kind')
  if (typeof v.url !== 'string' || !v.url.startsWith('/') || v.url.length > 500) bad('url — относительный адрес')
  for (const key of ['id', 'label'] as const) if (v[key] !== undefined && (typeof v[key] !== 'string' || (v[key] as string).length > 200)) bad(key)
  if (v.workspaceId !== undefined && (typeof v.workspaceId !== 'string' || !UUID.test(v.workspaceId))) bad('workspaceId')
  if (v.projection !== undefined && (typeof v.projection !== 'object' || v.projection === null || Array.isArray(v.projection))) bad('projection')
  if (v.capturedAt !== undefined && (typeof v.capturedAt !== 'string' || Number.isNaN(Date.parse(v.capturedAt)))) bad('capturedAt')
}

// ---- HTTP (участок контейнера) ----------------------------------------------

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    [SURFACE_VERSION_HEADER]: SURFACE_VERSION,
  }).end(JSON.stringify(body))
}

function fail(res: ServerResponse, error: unknown, log: SurfaceBridgeOptions['log']): void {
  if (error instanceof SurfaceError) return send(res, error.status, { error: { code: error.code, message: error.message } })
  // Текст исключения может нести детали хоста — наружу только код, подробности в журнал.
  log.warn(`surface: беседа недоступна: ${String(error instanceof Error ? error.message : error)}`)
  send(res, 503, { error: { code: 'conversation_unavailable', message: 'беседа недоступна' } })
}

function surfaceOf(req: IncomingMessage): Surface {
  const raw = String(req.headers[SURFACE_HEADER] ?? 'console').trim().toLowerCase()
  if (!(API_SURFACES as readonly string[]).includes(raw)) throw new SurfaceError(400, 'unsupported_surface', `поверхность ${raw} не говорит через этот API`)
  return raw as Surface
}

export interface SurfaceHttpOptions {
  bridge: SurfaceBridge
  /** Проверка Bearer секрета контейнера (та же, что у `/internal/harness/inbound`). */
  authorized: (req: IncomingMessage) => boolean
  readJson: (req: IncomingMessage) => Promise<unknown>
  heartbeatMs?: number
  maxStreams?: number
  maxBufferedBytes?: number
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

export const SURFACE_PREFIX = '/internal/harness/surface'

/** Обработчики `/internal/harness/surface/{message,stream,history,approval}`. */
export function surfaceHandlers(options: SurfaceHttpOptions): Record<string, Handler> {
  const { bridge } = options
  const guard = (method: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void): Handler => async (req, res) => {
    if (req.method !== method) return send(res, 405, { error: { code: 'method_not_allowed', message: method } })
    if (!options.authorized(req)) return send(res, 401, { error: { code: 'unauthorized', message: 'нужен секрет контейнера' } })
    try {
      await handler(req, res)
    } catch (error) {
      fail(res, error, bridge.log)
    }
  }
  const body = async (req: IncomingMessage): Promise<unknown> => {
    try {
      return await options.readJson(req)
    } catch (error) {
      if (error instanceof SurfaceError) throw error
      throw new SurfaceError(400, 'bad_request', 'тело — JSON')
    }
  }
  return {
    [`${SURFACE_PREFIX}/message`]: guard('POST', async (req, res) => {
      const surface = surfaceOf(req)
      send(res, 202, await bridge.message(surface, await body(req)))
    }),
    [`${SURFACE_PREFIX}/approval`]: guard('POST', async (req, res) => {
      const surface = surfaceOf(req)
      send(res, 200, bridge.approval(surface, await body(req)))
    }),
    [`${SURFACE_PREFIX}/history`]: guard('GET', async (req, res) => {
      surfaceOf(req)
      const url = new URL(req.url ?? '/', 'http://container')
      const limitRaw = url.searchParams.get('limit')
      const limit = limitRaw === null ? 50 : Number(limitRaw)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SurfaceError(400, 'bad_request', 'limit — 1..100')
      send(res, 200, await bridge.history(url.searchParams.get('before'), limit))
    }),
    [`${SURFACE_PREFIX}/stream`]: guard('GET', (req, res) => {
      surfaceOf(req)
      const url = new URL(req.url ?? '/', 'http://container')
      const lastEventId = req.headers['last-event-id']
      const after = (Array.isArray(lastEventId) ? lastEventId[0] : lastEventId) ?? url.searchParams.get('after')
      if (after !== null && after.length > 200) throw new SurfaceError(400, 'invalid_cursor', 'курсор длиннее 200 символов')
      if (bridge.subscriberCount() >= (options.maxStreams ?? MAX_STREAMS)) throw new SurfaceError(429, 'too_many_streams', 'слишком много открытых потоков')
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        [SURFACE_VERSION_HEADER]: SURFACE_VERSION,
      })
      const maxBuffered = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES
      let stopped = false
      const write = (chunk: string): void => {
        if (stopped) return
        res.write(chunk)
        // Медленный читатель: не копим события в памяти — отключаем, он вернётся с курсором.
        if (res.writableLength > maxBuffered) {
          bridge.log.warn('surface: поток отключён — читатель не успевает')
          stop()
          res.destroy()
        }
      }
      const writeEvent = (event: SurfaceEvent): void => write(`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      const { ready, replay, close } = bridge.subscribe(after && after !== '' ? after : null, writeEvent)
      const heartbeat = setInterval(() => write(': ping\n\n'), options.heartbeatMs ?? HEARTBEAT_MS)
      heartbeat.unref?.()
      function stop(): void { stopped = true; clearInterval(heartbeat); close() }
      writeEvent(ready)
      for (const event of replay) writeEvent(event)
      req.on('close', stop)
      res.on('close', stop)
    }),
  }
}
