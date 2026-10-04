/**
 * Порт единственной беседы человека на хосте DSH (spec human-harness FR-001).
 * Беседа — последняя непустая корневая сессия среди членов workspace ассистента
 * (пустые черновики не в счёт); если бесед ещё нет, сессия создаётся в этом
 * workspace — иначе клиент DSH её не увидит (он знает только сессии workspace). Хост —
 * единственный источник: окно спрашивает id беседы у него (`/api/harness/conversation`).
 * Ход дописывается как штатный `dsh-schedule`: `resolveAgent` → `followup` →
 * `sessions.flush` (доставка считается состоявшейся после записи журнала).
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { ConversationPort } from './proactive.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Ход, который харнесс вписал по событию платформы (не слова человека). */
    'platform-event': { kind: 'platform-event' } & ContextFormed
    /** Сообщение человека из канала (Telegram), доставленное launcher'ом. */
    'channel': { kind: 'channel', channel: string } & ContextFormed
    /**
     * Сообщение человека с поверхности беседы по API поверхности (контракт `surface/1`).
     * `screenContext` — только kind/id/label/url: проекция экрана в журнал не пишется.
     */
    'surface': { kind: 'surface', surface: string, requestId: string, screenContext: SurfaceScreenRef | null } & ContextFormed
    /** Контекст экрана поверхности, вписанный в ход секцией; не слова человека. */
    'screen-context': { kind: 'screen-context' } & ContextFormed
  }
}

/** Ссылка на экран поверхности в источнике сообщения (без проекции). */
export interface SurfaceScreenRef {
  kind: string
  id?: string
  label?: string
  url: string
}

/** Итог доставки сообщения в беседу. */
export interface Delivery {
  sessionId: string
  messageId: string
  /** Ассистент был занят: сообщение встало в очередь хода. */
  queued: boolean
}

export interface DeliverMeta {
  channel?: string
  surface?: { surface: string, requestId: string, screenContext: SurfaceScreenRef | null }
}

/** Запись журнала беседы в форме, которую читают поверхности. */
export interface JournalEvent {
  type: string
  seq: number
  time: number
  data?: unknown
}

export function channelName(channel: string | undefined): string {
  return channel === 'telegram' ? 'Telegram' : (channel ?? 'канала')
}

export class DshConversation implements ConversationPort {
  /** Контекст с `sessionController` и `sessions`: cordis отдаёт службы только через inject. */
  private ctx: Context | null = null

  constructor(private readonly workspacePath: string) {}

  /** Привязать к scoped-контексту `ctx.inject(['sessionController', 'sessions', 'workspaceController'])`; вернуть отвязку. */
  bind(ctx: Context): () => void {
    this.ctx = ctx
    return () => { if (this.ctx === ctx) this.ctx = null }
  }

  /** Службы сессий DSH уже привязаны: беседу можно читать и дополнять. */
  ready(): boolean {
    return this.ctx !== null
  }

  private host(): Context {
    if (this.ctx === null) throw new Error('беседа недоступна: на этом хосте нет веб-сессий DSH')
    return this.ctx
  }

  /** Id беседы: последняя непустая корневая сессия workspace ассистента или новая в нём. */
  async sessionId(signal: AbortSignal = AbortSignal.timeout(10_000)): Promise<SessionId> {
    const host = this.host()
    // Идемпотентно: регистрирует каталог ассистента workspace'ом или возвращает существующий.
    const { workspace } = await host.workspaceController.create({ path: this.workspacePath })
    const members = new Set<string>(workspace.sessionIds)
    const { items } = await host.sessionController.list({}, signal)
    const own = items
      .filter(item => members.has(item.sessionId) && item.origin !== 'subagent' && item.parentSessionId === undefined)
      .sort((a, b) => Number(a.blank) - Number(b.blank) || b.updatedAt - a.updatedAt)
    if (own[0] !== undefined) return own[0].sessionId
    const created = await host.sessionController.create({ workspaceId: workspace.workspaceId })
    return created.sessionId
  }

  /** Идёт ли ход ассистента в какой-либо сессии (контейнер нельзя усыплять). */
  async busy(): Promise<boolean> {
    const { items } = await this.host().sessionController.list({}, AbortSignal.timeout(5000))
    return items.some(item => item.running)
  }

  private async agent(sessionId: SessionId) {
    const resolved = await this.host().sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw new Error(`беседа ${sessionId} недоступна: ${String((resolved.error as { message?: unknown }).message ?? resolved.error)}`)
    return resolved.agent
  }

  /**
   * Дописать реплику в беседу штатным `followup` (режим `queue`: занятый ассистент
   * возьмёт её следующим ходом).
   */
  async deliver(text: string, sourceKind: string, meta: DeliverMeta = {}): Promise<Delivery> {
    const sessionId = await this.sessionId()
    const agent = await this.agent(sessionId)
    // Модель видит только текст: пометка канала говорит ей, что окна перед человеком может не
    // быть — спрашивать текстом, а не виджетом вопроса (персона, правило «Канал»).
    const body = sourceKind === 'channel' ? `[Из ${channelName(meta.channel)}] ${text}` : text
    const message = createUserMessage({
      content: [{ type: 'text', text: body }],
      source: sourceKind === 'user' ? { kind: 'user' }
        : sourceKind === 'channel' ? { kind: 'channel', channel: meta.channel ?? 'unknown' }
          : sourceKind === 'surface' && meta.surface !== undefined ? { kind: 'surface', ...meta.surface }
            : { kind: 'platform-event' },
    })
    const queued = agent.status === 'running'
    agent.followup(message)
    if (!await this.host().sessions.flush(agent.session)) throw new Error('журнал беседы не подтвердил запись')
    return { sessionId, messageId: String(message.id), queued }
  }

  /**
   * Страница журнала беседы назад от `beforeSeq` (не включая): штатное `page`
   * контроллера сессий, без синхронного чтения лога.
   */
  async page(sessionId: string, beforeSeq: number | undefined, maxMessages: number, signal: AbortSignal = AbortSignal.timeout(10_000)): Promise<{ events: JournalEvent[], hasMore: boolean }> {
    const agent = await this.agent(sessionId as SessionId)
    const throughSeq = Number(agent.session.seq) - 1
    if (throughSeq < 0) return { events: [], hasMore: false }
    const page = await this.host().sessionController.page({
      address: { kind: 'session', sessionId: sessionId as SessionId },
      throughSeq,
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      maxMessages,
    }, signal)
    return { events: page.records.map(record => record.event), hasMore: page.hasMore }
  }
}
