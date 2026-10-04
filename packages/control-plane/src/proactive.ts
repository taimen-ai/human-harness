/**
 * Проактивность ассистента (spec human-harness FR-003/FR-004, TAI-ADR-0051 п.6).
 *
 * Событие ядра проходит правила значимости. Значимое свежее (`now`) копится
 * `burstMs` (20 с) от первого и уходит в беседу одним ходом ассистента:
 * сообщение-факт с пометкой источника `platform-event`, на которое модель
 * отвечает предложением действия. Незначимое (`digest`) и всё, что пришло
 * пока человека не было (старше `freshMs`, например догон журнала после сна
 * контейнера), копится в сводку «пока тебя не было» — она уходит одним ходом,
 * когда человек снова открывает окно.
 *
 * Очередь и сводка пишутся в файл до того, как потребитель отметит событие
 * обработанным: перезапуск контейнера между событием и ходом ничего не теряет.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { evaluate, type AttentionMatch, type EvaluateDeps, type RuleSet } from './attention-rules.ts'
import type { JournalEvent } from './events.ts'

/** Источник сообщения в журнале беседы: не человек, а событие платформы. */
export const PLATFORM_EVENT_SOURCE = 'platform-event'

export interface ConversationPort {
  /** Дописать ход в единственную беседу человека; бросает, если беседа недоступна. */
  deliver(text: string, sourceKind: string): Promise<unknown>
}

interface ProactiveState {
  pending: AttentionMatch[]
  digest: AttentionMatch[]
  /** Когда человек последний раз был в окне (мс). */
  lastSeenAt: number | null
  /** Последние доставленные `event.id` — вторая линия дедупа после курсора потребителя. */
  delivered: string[]
}

export class ProactiveStateFile {
  private cache: ProactiveState | undefined

  constructor(private readonly path: string) {}

  load(): ProactiveState {
    if (this.cache !== undefined) return this.cache
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<ProactiveState>
      this.cache = { pending: raw.pending ?? [], digest: raw.digest ?? [], lastSeenAt: raw.lastSeenAt ?? null, delivered: raw.delivered ?? [] }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.cache = { pending: [], digest: [], lastSeenAt: null, delivered: [] }
    }
    return this.cache
  }

  save(state: ProactiveState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    renameSync(tmp, this.path)
    this.cache = state
  }
}

export interface ProactiveOptions {
  rules: RuleSet
  deps: () => Promise<EvaluateDeps>
  conversation: ConversationPort
  state: ProactiveStateFile
  /** Окно группировки лавины. */
  burstMs?: number
  /** Событие старше — «пока тебя не было», а не повод прийти сейчас. */
  freshMs?: number
  /** Отсутствие дольше — возвращение человека показывает сводку. */
  awayMs?: number
  /** Пауза перед повтором недоставленного хода. */
  retryMs?: number
  /** Сигнал UI: «Важное» могло измениться. */
  onSignal?: () => void
  log: { info(msg: string): void, warn(msg: string): void }
  now?: () => number
}

const DIGEST_MAX = 100
const DELIVERED_MAX = 1000

export class Proactive {
  private timer: NodeJS.Timeout | null = null
  private flushing: Promise<void> | null = null
  private readonly now: () => number

  constructor(private readonly options: ProactiveOptions) {
    this.now = options.now ?? Date.now
  }

  /** Обработчик потребителя событий: бросает — событие повторится. */
  async handle(event: JournalEvent): Promise<void> {
    const match = await evaluate(this.options.rules, event, await this.options.deps())
    if (match === null) return
    const state = this.options.state.load()
    if (state.delivered.includes(match.eventId)) return
    this.options.onSignal?.()
    const stale = this.now() - Date.parse(event.occurredAt) > (this.options.freshMs ?? 120_000)
    if (match.significance === 'digest' || stale) {
      const digest = [...state.digest.filter(m => m.eventId !== match.eventId), match].slice(-DIGEST_MAX)
      this.options.state.save({ ...state, digest })
      return
    }
    if (state.pending.some(m => m.eventId === match.eventId)) return
    this.options.state.save({ ...state, pending: [...state.pending, match] })
    this.schedule(this.options.burstMs ?? 20_000)
  }

  /** Вызвать при старте: недоставленная очередь прошлого процесса уходит заново. */
  resume(): void {
    if (this.options.state.load().pending.length > 0) this.schedule(this.options.burstMs ?? 20_000)
  }

  /** Человек открыл окно (или UI опрашивает «Важное»). Вернувшемуся после отсутствия — сводка. */
  async presence(): Promise<void> {
    const state = this.options.state.load()
    const now = this.now()
    const away = state.lastSeenAt === null || now - state.lastSeenAt > (this.options.awayMs ?? 10 * 60_000)
    this.options.state.save({ ...state, lastSeenAt: now })
    if (!away || state.digest.length === 0) return
    const digest = state.digest
    try {
      await this.options.conversation.deliver(renderDigest(digest), PLATFORM_EVENT_SOURCE)
      const after = this.options.state.load()
      const sent = new Set(digest.map(m => m.eventId))
      this.options.state.save({ ...after, digest: after.digest.filter(m => !sent.has(m.eventId)), delivered: remember(after.delivered, sent) })
      this.options.log.info(`proactive: сводка «пока тебя не было» — ${digest.length} событий`)
    } catch (error) {
      // Сводка останется до следующего возвращения; окно при этом работает.
      this.options.state.save({ ...this.options.state.load(), lastSeenAt: state.lastSeenAt })
      this.options.log.warn(`proactive: сводка не доставлена: ${String(error)}`)
    }
  }

  /** Доставить накопленное сейчас (для тестов и остановки). */
  async flush(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
    if (this.flushing !== null) return this.flushing
    this.flushing = this.deliverPending().finally(() => { this.flushing = null })
    return this.flushing
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(delayMs: number): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => { this.timer = null; void this.flush() }, delayMs)
    this.timer.unref?.()
  }

  private async deliverPending(): Promise<void> {
    const pending = this.options.state.load().pending
    if (pending.length === 0) return
    try {
      await this.options.conversation.deliver(renderBurst(pending), PLATFORM_EVENT_SOURCE)
    } catch (error) {
      this.options.log.warn(`proactive: ход не доставлен, повтор через ${this.options.retryMs ?? 60_000} мс: ${String(error)}`)
      this.schedule(this.options.retryMs ?? 60_000)
      return
    }
    const sent = new Set(pending.map(m => m.eventId))
    const state = this.options.state.load()
    this.options.state.save({ ...state, pending: state.pending.filter(m => !sent.has(m.eventId)), delivered: remember(state.delivered, sent) })
    this.options.log.info(`proactive: ход ассистента по ${pending.length} событиям`)
    if (this.options.state.load().pending.length > 0) this.schedule(this.options.burstMs ?? 20_000)
  }
}

function remember(delivered: string[], sent: Set<string>): string[] {
  return [...delivered.filter(id => !sent.has(id)), ...sent].slice(-DELIVERED_MAX)
}

/** Одно событие на объект: из лавины по одной задаче остаётся самое позднее каждого правила. */
function collapse(matches: AttentionMatch[]): AttentionMatch[] {
  const byKey = new Map<string, AttentionMatch>()
  for (const m of matches) byKey.set(`${m.rule}|${m.ref ?? m.entityId}`, m)
  return [...byKey.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
}

function line(m: AttentionMatch): string {
  return `- ${m.message}\n  Предложи: ${m.action}\n  (правило ${m.rule}, событие ${m.eventType} ${m.eventId}${m.ref ? `, ${m.ref}` : ''})`
}

export function renderBurst(matches: AttentionMatch[]): string {
  const items = collapse(matches)
  return [
    '[Событие платформы — сообщение харнесса, не человека.]',
    items.length === 1 ? 'Произошло то, что касается человека:' : `Произошло ${items.length} события, касающихся человека:`,
    ...items.map(line),
    'Скажи человеку об этом коротко и предложи действие. Не пересказывай событие и ничего не меняй без его согласия.',
  ].join('\n')
}

export function renderDigest(matches: AttentionMatch[]): string {
  const items = collapse(matches)
  return [
    '[Событие платформы — сообщение харнесса, не человека.]',
    `Человек вернулся. Пока его не было, произошло ${items.length} (старые — первыми):`,
    ...items.map(line),
    'Дай одну короткую сводку «пока тебя не было»: сначала то, что требует решения человека, остальное — одной строкой. Предложи, с чего начать.',
  ].join('\n')
}
