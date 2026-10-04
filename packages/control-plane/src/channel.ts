/**
 * Канал (Telegram) — вторая поверхность той же беседы (TAI-ADR-0051 п.7, spec
 * human-harness, сценарий 9):
 * - реплика человека из канала приходит ходом с источником `channel` (launcher →
 *   `/internal/harness/inbound`);
 * - ответ ассистента на такой ход уходит обратно в канал уведомлением человеку
 *   (notification-service, `POST /api/v1/notifications`); длинный — обрезается со
 *   ссылкой в окно;
 * - в канал уходят ТОЛЬКО ходы, пришедшие из Telegram: ход окна, консоли или
 *   события платформы в канал не отвечает (амендмент TAI-ADR-0051 2026-09-29);
 * - смешанная очередь: реплики из Telegram и консоли (окна) встают в одну очередь
 *   ходов беседы, но каждая `followup`-реплика — отдельный ход. Чей ход, решает его
 *   первая реплика человека после `turn/start`: ход из Telegram отвечает в Telegram,
 *   следующий в очереди ход консоли — только в поток консоли (в канал ничего). Если
 *   реплика консоли или окна вошла в ход из Telegram шагом (steer), ход перестаёт
 *   быть ходом канала и его ответ в Telegram не уходит — человек уже в консоли;
 * - если в этом ходе инструменту нужно подтверждение, человек получает кнопки
 *   `harness_approval` в канале; нажатие возвращается тем же inbound и решается в
 *   общем {@link ApprovalHub}: окно, консоль и канал гоняются, побеждает первый.
 *
 * Уведомления шлёт сам человек: токен его PAT для audience `notification-service`.
 */
import { randomUUID } from 'node:crypto'
import type { TokenSource } from './client.ts'
import { consoleUrl, type WorkProposal } from './names.ts'

export const NOTIFY_AUDIENCE = 'notification-service'
export const HARNESS_APPROVAL = 'harness_approval'

export interface NotificationAction {
  id: string
  label: string
  data: Record<string, unknown>
}

export interface NotificationBody {
  recipient: { kind: 'principal', id: string }
  type: string
  title: string
  body?: string
  links?: { label: string, url: string }[]
  actions?: NotificationAction[]
}

export interface NotifySender {
  send(body: NotificationBody, idempotencyKey: string): Promise<void>
}

/** Клиент notification-service от имени человека. */
export class NotifyClient implements NotifySender {
  private readonly base: string

  constructor(baseUrl: string, private readonly identity: TokenSource, private readonly fetchImpl: typeof fetch = fetch) {
    this.base = baseUrl.replace(/\/+$/, '')
  }

  async send(body: NotificationBody, idempotencyKey: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(`${this.base}/api/v1/notifications`, {
        method: 'POST',
        headers: {
          authorization: await this.identity.authorization(NOTIFY_AUDIENCE),
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })
      if (response.status === 401 && attempt === 0) {
        this.identity.invalidate(NOTIFY_AUDIENCE)
        continue
      }
      if (!response.ok) throw new Error(`notification-service ответил ${response.status}`)
      return
    }
  }
}

/** Канал, ответы в который уходят уведомлением. Другие каналы в беседу пока не пишут. */
export const REPLY_CHANNEL = 'telegram'

interface ChannelTurn {
  channel: string
  texts: string[]
}

export interface ChannelBridgeOptions {
  notify: NotifySender
  /** Principal человека в Control Plane — адресат уведомлений. */
  me: () => Promise<string>
  /** Куда ведёт ссылка «Открыть окно» в ответе канала (полный адрес, как есть). */
  windowUrl?: string | null
  /** Сколько символов ответа отправлять в канал. */
  maxText?: number
  log: { info(msg: string): void, warn(msg: string): void }
}

interface SessionEventLike {
  type: string
  data?: unknown
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map(part => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : '')).join('').trim()
}

/**
 * Ссылка «Открыть окно» в ответах канала. За launcher'ом её задаёт он
 * (`HARNESS_WINDOW_URL` — консоль с открытым ассистентом); у харнесса, запущенного
 * отдельно, — его собственный веб-хост (`HARNESS_PUBLIC_URL`).
 */
export function channelWindowUrl(config: { publicUrl?: string | undefined, windowUrl?: string | undefined }): string | null {
  if (config.windowUrl) return config.windowUrl
  return config.publicUrl ? `${config.publicUrl.replace(/\/+$/, '')}/` : null
}

/**
 * Ссылки ассистента на экраны консоли относительны (`/console/work/new?…`): в окне и
 * консоли они открываются как есть, а в мессенджере нужен полный адрес. Достраиваются
 * от адреса окна — консоль с открытым ассистентом; без него текст не меняется.
 */
export function absoluteConsoleLinks(text: string, windowUrl: string | null): string {
  if (!windowUrl || !URL.canParse(windowUrl)) return text
  return text.replace(/(^|[\s(<"'])(\/console\/[^\s)<>"']*)/g, (_match, lead: string, path: string) => `${lead}${new URL(path, windowUrl).href}`)
}

const PROPOSAL_LINK = /\/console\/work\/new\?[^\s<>()\]]+/g
/** Пределы result и basis, до которых ужимаются ссылки-предложения; 0 — поле отбрасывается. */
const PROPOSAL_SQUEEZE = [500, 200, 50, 0]

/**
 * Ссылка-предложение кодирует result и basis целиком (кириллица — по 6 символов на букву),
 * и длинный ответ мессенджер обрезал бы посреди ссылки. Если текст длиннее `max`, поля
 * result и basis в ссылках ужимаются ступенями до тех пор, пока текст не влезет;
 * остальные поля и текст вокруг не меняются. Ссылка, которую консоль не собрала бы
 * (например, `due=friday`), остаётся как есть: тогда ответ просто обрезается.
 */
export function fitProposalLinks(text: string, max: number): string {
  if (text.length <= max) return text
  let fitted = text
  for (const limit of PROPOSAL_SQUEEZE) {
    fitted = text.replace(PROPOSAL_LINK, match => {
      // Пунктуация и закрывающие кавычки в конце голого адреса — текст вокруг, а не значение
      // поля: консоль срезает тот же хвост (screens/work/proposal.ts, findProposals), а ссылка
      // консоли кодирует эти знаки в значениях (encodeParam), сырых в хвосте их нет.
      const tail = /[.,;:!?»"']+$/.exec(match)?.[0] ?? ''
      const link = match.slice(0, match.length - tail.length)
      const params = Object.fromEntries(new URL(link, 'http://console.invalid').searchParams) as Partial<WorkProposal>
      if (!params.title) return match
      try {
        return `${consoleUrl.proposal({ ...params, title: params.title }, { result: limit, basis: limit })}${tail}`
      } catch {
        // Ссылку модель написала руками (due=friday): ответ важнее ужатия — она остаётся как есть.
        return match
      }
    })
    if (fitted.length <= max) break
  }
  return fitted
}

export class ChannelBridge {
  private readonly turns = new Map<string, ChannelTurn>()

  constructor(private readonly options: ChannelBridgeOptions) {}

  /** Идёт ли в сессии ход, начатый репликой из канала. */
  isChannelTurn(sessionId: string): boolean {
    return this.turns.has(sessionId)
  }

  /** Наблюдатель журнала сессии (`session/event`). */
  onSessionEvent(sessionId: string, event: SessionEventLike): void {
    const data = (event.data ?? {}) as Record<string, unknown>
    if (event.type === 'turn/start') {
      // Новый ход: чей он — решит первая реплика хода.
      this.turns.delete(sessionId)
      return
    }
    if (event.type === 'user/message') {
      const source = (data.source ?? {}) as { kind?: unknown, channel?: unknown }
      if (source.kind === 'channel' && source.channel === REPLY_CHANNEL) {
        if (!this.turns.has(sessionId)) this.turns.set(sessionId, { channel: REPLY_CHANNEL, texts: [] })
      } else if (source.kind === 'channel' || source.kind === 'user' || source.kind === 'surface') {
        // Человек продолжил в окне, консоли или другом канале — ответ туда, а не в Telegram.
        this.turns.delete(sessionId)
      }
      return
    }
    const turn = this.turns.get(sessionId)
    if (turn === undefined) return
    if (event.type === 'assistant/message') {
      const message = (data.message ?? {}) as { content?: unknown }
      const text = textOf(message.content)
      if (text !== '') turn.texts.push(text)
    } else if (event.type === 'turn/end') {
      this.turns.delete(sessionId)
      const answer = turn.texts.at(-1)
      if (answer !== undefined) void this.reply(answer).catch((error: unknown) => this.options.log.warn(`channel: ответ в канал не отправлен: ${String(error)}`))
    }
  }

  private async reply(text: string): Promise<void> {
    const max = this.options.maxText ?? 3500
    const url = this.options.windowUrl || null
    const full = fitProposalLinks(absoluteConsoleLinks(text, url), max)
    const cut = full.length > max
    await this.options.notify.send({
      recipient: { kind: 'principal', id: await this.options.me() },
      type: 'harness.reply',
      title: 'Ассистент',
      body: cut ? `${full.slice(0, max - 1)}…${url ? '\nПолностью — в окне.' : ''}` : full,
      ...(url ? { links: [{ label: 'Открыть окно', url }] } : {}),
    }, `harness-reply-${randomUUID()}`)
    this.options.log.info(`channel: ответ отправлен в канал (${full.length} симв.)`)
  }

  /**
   * Отправить в канал кнопки подтверждения запроса `requestId` (id общего {@link ApprovalHub}).
   * Нажатие приходит через `/internal/harness/inbound` и решается в хабе. Бросает, если
   * канал недоступен: тогда он выбывает из гонки, решение остаётся за другими поверхностями.
   */
  async confirm(requestId: string, question: { toolName: string, reason?: string | undefined }): Promise<void> {
    await this.options.notify.send({
      recipient: { kind: 'principal', id: await this.options.me() },
      type: 'harness.confirmation',
      title: 'Ассистент просит подтверждения',
      body: [`Действие: ${question.toolName}`, question.reason ? `Зачем: ${question.reason}` : ''].filter(Boolean).join('\n'),
      actions: [
        { id: 'approve', label: 'Разрешить', data: { kind: HARNESS_APPROVAL, requestId, decision: 'approve' } },
        { id: 'reject', label: 'Отклонить', data: { kind: HARNESS_APPROVAL, requestId, decision: 'reject' } },
      ],
    }, `harness-confirmation-${requestId}`)
  }
}
