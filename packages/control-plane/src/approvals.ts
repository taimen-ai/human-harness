/**
 * Подтверждения ассистента гоняются между поверхностями беседы (амендмент
 * TAI-ADR-0051 2026-09-29, контракт `surface/1`): окно (штатный ответчик DSH через
 * `next()`), консоль (`POST …/surface/approval`) и Telegram (кнопки в канале, только
 * для ходов из Telegram). Побеждает первый ответ, остальные получают
 * `already_resolved`; через 10 минут без ответа запрос отменяется (`cancelled`).
 *
 * Кто ждёт ответа (контракт, «Кто ждёт ответа»). `'unavailable'` от окна значит
 * «окна нет». Ход ждёт другие поверхности, только если ответить есть кому:
 * - ход из Telegram и кнопки туда доставлены;
 * - ход вызван сообщением консоли;
 * - к потоку консоли подключён хотя бы один клиент.
 * Иначе (проактивный ход, никого нет) — сразу `'unavailable'`, как до поверхностей:
 * ход не висит 10 минут и не держит очередь и контейнер.
 *
 * Кто может ответить, проверяется один раз — в момент запроса. Поток консоли,
 * открытый после этого, уже отказанный запрос не вернёт: он получит следующий.
 * Поток, закрытый во время ожидания, ожидание не прерывает: запрос ждёт решения
 * до срока, а консоль ответит на него, когда вернётся (`approval.requested` есть в
 * буфере потока, решение — `POST …/surface/approval`).
 *
 * Реестр решённых запросов — в памяти процесса (последние {@link SETTLED_LIMIT}).
 * Комментарий решения хранится в нём и уходит в поток `approval.resolved`; в журнал
 * сессии DSH не пишется: у `Session.append` нет пометки `ignorable`, а незнакомое
 * обязательное событие сделало бы журнал нечитаемым. В журнал процесса — только
 * факт решения, поверхность и длина комментария (приватность).
 *
 * TODO(surface/1): поле `comment` у `approval.resolved` в схеме контракта
 * (суперпроект, `docs/contracts/harness-surface/event.schema.json`) не описано —
 * оно идёт как необязательное поле, которое контракт разрешает добавлять без смены
 * версии. Описать его в схеме — следующим амендментом `surface/1` в суперпроекте;
 * здесь контракт не меняется.
 */
import { randomUUID } from 'node:crypto'

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
export type Surface = 'window' | 'telegram' | 'console'
export type Decision = 'allow' | 'reject'

export const APPROVAL_TIMEOUT_MS = 10 * 60_000
const SETTLED_LIMIT = 500

/** Запрос `approval/request` DSH — ровно те поля, которые нужны хабу. */
export interface ApprovalRequestLike {
  agent: { session: { id: unknown } }
  toolName: string
  reason?: string | undefined
  signal?: AbortSignal | undefined
}

/** Событие потока поверхности (без курсора и времени — их ставит поток). */
export type ApprovalStreamEvent =
  | { type: 'approval.requested', approvalRequestId: string, turnId?: string, toolName: string, reason: string, expiresAt: string }
  /** `comment` — вне схемы `surface/1` до её следующего амендмента (см. шапку модуля). */
  | { type: 'approval.resolved', approvalRequestId: string, decision: Decision | 'cancelled', surface?: Surface, comment?: string }

export type DecideResult =
  | { status: 'resolved' }
  | { status: 'already_resolved', decision: Decision | 'cancelled', surface?: Surface }
  | { status: 'expired' }

export interface ApprovalChannel {
  isChannelTurn(sessionId: string): boolean
  confirm(requestId: string, question: { toolName: string, reason?: string | undefined }): Promise<void>
}

export interface ApprovalHubOptions {
  /** Консоль участвует: запросы уходят в поток поверхности. */
  publish: ((event: ApprovalStreamEvent) => void) | null
  channel: ApprovalChannel | null
  /** Текущий ход беседы для `turnId` (если сессия — беседа человека). */
  turnOf?: (sessionId: string) => string | undefined
  /** Консоль может ответить: ход вызван её сообщением или к потоку подключён клиент. */
  consoleListening?: (sessionId: string) => boolean
  timeoutMs?: number
  log: { info?(msg: string): void, warn(msg: string): void }
  now?: () => number
}

/** Почему запрос закрыт: решение поверхности, таймаут, отмена хода, некому ответить. */
type Ending = 'decided' | 'timeout' | 'aborted' | 'unavailable'

interface Pending {
  finish: (outcome: ApprovalOutcome, ending: Ending, surface?: Surface, comment?: string) => void
}

interface Settled {
  decision: Decision | 'cancelled'
  surface?: Surface
  ending: Ending
  comment?: string
}

function decisionOf(outcome: ApprovalOutcome): Decision | 'cancelled' {
  return outcome === 'allowed-once' ? 'allow' : outcome === 'rejected' ? 'reject' : 'cancelled'
}

export class ApprovalHub {
  private readonly pending = new Map<string, Pending>()
  private readonly settled = new Map<string, Settled>()

  constructor(private readonly options: ApprovalHubOptions) {}

  /** Слушатель waterfall `approval/request`. */
  request(req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const sessionId = String(req.agent.session.id)
    const channelTurn = this.options.channel?.isChannelTurn(sessionId) ?? false
    const publish = this.options.publish
    const consoleListening = publish !== null && (this.options.consoleListening?.(sessionId) ?? false)
    // Кроме окна, ответить некому — штатное поведение DSH ('unavailable' без окна сразу).
    if (!consoleListening && !channelTurn) return next()

    const id = randomUUID()
    const timeoutMs = this.options.timeoutMs ?? APPROVAL_TIMEOUT_MS
    const now = this.options.now ?? Date.now
    // Канал держит ожидание, только если кнопки доставлены.
    let channel: 'none' | 'sending' | 'delivered' | 'failed' = channelTurn ? 'sending' : 'none'
    let windowAbsent = false
    const nobodyElse = (): boolean => !consoleListening && channel !== 'sending' && channel !== 'delivered'
    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => finish('cancelled', 'timeout'), timeoutMs)
      timer.unref?.()
      const onAbort = (): void => finish('cancelled', 'aborted')
      const finish = (value: ApprovalOutcome, ending: Ending, surface?: Surface, comment?: string): void => {
        if (!this.pending.has(id)) return
        clearTimeout(timer)
        req.signal?.removeEventListener('abort', onAbort)
        this.pending.delete(id)
        const decision = decisionOf(value)
        const by = surface !== undefined && decision !== 'cancelled' ? { surface } : {}
        const note = comment !== undefined && comment !== '' ? { comment } : {}
        this.remember(id, { decision, ending, ...by, ...note })
        publish?.({ type: 'approval.resolved', approvalRequestId: id, decision, ...by, ...note })
        this.options.log.info?.(`approvals: ${id} ${decision} (${ending}${surface ? `, ${surface}` : ''}${comment ? `, комментарий ${comment.length} симв.` : ''})`)
        resolve(value)
      }
      this.pending.set(id, { finish })
      if (req.signal?.aborted) { finish('cancelled', 'aborted'); return }
      req.signal?.addEventListener('abort', onAbort, { once: true })
    })
    if (this.pending.has(id)) {
      const turnId = this.options.turnOf?.(sessionId)
      publish?.({
        type: 'approval.requested',
        approvalRequestId: id,
        ...(turnId !== undefined ? { turnId } : {}),
        toolName: req.toolName,
        reason: (req.reason ?? '').slice(0, 2000),
        expiresAt: new Date(now() + timeoutMs).toISOString(),
      })
      if (channelTurn) {
        this.options.channel!.confirm(id, { toolName: req.toolName, reason: req.reason }).then(
          () => { channel = 'delivered' },
          (error: unknown) => {
            // Канал недоступен — он выбывает из гонки; если окна нет и консоль не слушает — отказ сразу.
            channel = 'failed'
            this.options.log.warn(`approvals: подтверждение не отправлено в канал: ${String(error)}`)
            if (windowAbsent && nobodyElse()) this.pending.get(id)?.finish('unavailable', 'unavailable')
          },
        )
      }
      next().then(
        (value) => {
          if (value === 'unavailable') {
            windowAbsent = true
            if (nobodyElse()) this.pending.get(id)?.finish('unavailable', 'unavailable')
            return // окна нет — ждём поверхности, которые могут ответить
          }
          this.pending.get(id)?.finish(value, value === 'cancelled' ? 'aborted' : 'decided', value === 'cancelled' ? undefined : 'window')
        },
        () => undefined,
      )
    }
    return outcome
  }

  /** Ответ поверхности. `null` — такого запроса не было (или он забыт после перезапуска). */
  decide(id: string, decision: Decision, surface: Surface, comment?: string): DecideResult | null {
    const pending = this.pending.get(id)
    if (pending !== undefined) {
      pending.finish(decision === 'allow' ? 'allowed-once' : 'rejected', 'decided', surface, comment)
      return { status: 'resolved' }
    }
    const settled = this.settled.get(id)
    if (settled === undefined) return null
    // Истёк по сроку — expired; отменён ходом или «некому ответить» — решён как cancelled.
    if (settled.ending === 'timeout') return { status: 'expired' }
    return { status: 'already_resolved', decision: settled.decision, ...(settled.surface !== undefined ? { surface: settled.surface } : {}) }
  }

  /** Запросы, ждущие ответа (для тестов и диагностики). */
  pendingIds(): string[] {
    return [...this.pending.keys()]
  }

  private remember(id: string, value: Settled): void {
    this.settled.set(id, value)
    if (this.settled.size > SETTLED_LIMIT) this.settled.delete(this.settled.keys().next().value!)
  }
}
