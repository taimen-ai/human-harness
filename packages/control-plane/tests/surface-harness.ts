/**
 * Стенд для тестов поверхности беседы: настоящие DshConversation, ChannelBridge,
 * SurfaceBridge, ApprovalHub и служебные маршруты контейнера на HTTP-сервере;
 * подделаны только службы хоста DSH (сессии) и notification-service.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ApprovalHub, type ApprovalOutcome } from '../src/approvals.ts'
import { ChannelBridge, type NotificationBody } from '../src/channel.ts'
import { DshConversation, type JournalEvent } from '../src/conversation.ts'
import { internalHandlers } from '../src/launcher-seam.ts'
import { SurfaceBridge, type SurfaceEvent } from '../src/surface.ts'

export const SECRET = 'container-secret'
export const SESSION = 's1'
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined }

export interface Harness {
  base: string
  surface: SurfaceBridge
  hub: ApprovalHub
  channel: ChannelBridge
  /** Уведомления, ушедшие в notification-service (Telegram). */
  sent: NotificationBody[]
  /** Реплики, дописанные в беседу (`agent.followup`). */
  followups: { id: string, content: unknown, source: Record<string, unknown> }[]
  agent: { status: 'idle' | 'running' }
  journal: JournalEvent[]
  /** Событие журнала беседы — как его разносит `session/event` в index.ts. */
  emit(type: string, data: unknown): JournalEvent
  /** Запрос подтверждения от ассистента (waterfall `approval/request`). */
  ask(toolName: string, window?: () => Promise<ApprovalOutcome>, signal?: AbortSignal): Promise<ApprovalOutcome>
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>
  get(path: string, headers?: Record<string, string>): Promise<Response>
  close(): Promise<void>
}

export interface HarnessOptions {
  timeoutMs?: number
  notify?: (body: NotificationBody) => Promise<void>
  /** `sessions.flush` хоста: журнал записан, доставка ещё не вернулась (гонки с очередью событий). */
  flush?: () => Promise<boolean>
  /** Человек открыл беседу в консоли (проактивность: сводка «пока вас не было»). */
  presence?: () => void
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const sent: NotificationBody[] = []
  const followups: Harness['followups'] = []
  const journal: JournalEvent[] = []
  const agent = {
    status: 'idle' as 'idle' | 'running',
    session: { id: SESSION, get seq() { return journal.length } },
    followup: (message: { id: string, content: unknown, source: Record<string, unknown> }) => { followups.push(message) },
  }
  const host = {
    workspaceController: { create: async () => ({ workspace: { workspaceId: 'w1', sessionIds: [SESSION] } }) },
    sessionController: {
      list: async () => ({ items: [{ sessionId: SESSION, blank: false, updatedAt: 1, running: agent.status === 'running' }] }),
      create: async () => { throw new Error('беседа уже есть') },
      resolveAgent: async () => ({ agent }),
      page: async (request: { throughSeq: number, beforeSeq?: number, maxMessages?: number }) => {
        const end = Math.min(request.throughSeq + 1, request.beforeSeq ?? request.throughSeq + 1)
        let start = end
        let count = 0
        while (start > 0 && count < (request.maxMessages ?? 50)) {
          start -= 1
          if (journal[start]!.type === 'user/message' || journal[start]!.type === 'assistant/message') count += 1
        }
        return { records: journal.slice(start, end).map(event => ({ type: 'event', event })), hasMore: start > 0 }
      },
    },
    sessions: { flush: async () => (options.flush !== undefined ? options.flush() : true) },
  }
  const conversation = new DshConversation('/work/assistant')
  conversation.bind(host as never)
  const channel = new ChannelBridge({ notify: { send: options.notify ?? (async (body) => { sent.push(body) }) }, me: async () => 'cp-me', log: quiet })
  const surface = new SurfaceBridge({ conversation, log: quiet, ...(options.presence ? { presence: options.presence } : {}) })
  const hub = new ApprovalHub({
    publish: event => surface.publishApproval(event),
    channel,
    turnOf: id => surface.turnOf(id),
    consoleListening: id => surface.consoleListening(id),
    log: quiet,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  })
  surface.attachApprovals(hub)
  const handlers = internalHandlers(SECRET, {
    secret: SECRET,
    principalId: () => 'p1',
    conversation,
    approvals: hub,
    surface,
    nextWakeAt: async () => null,
    log: quiet,
  })
  const server: Server = createServer((req, res) => {
    const handler = handlers[new URL(req.url ?? '/', 'http://x').pathname]
    if (handler === undefined) { res.writeHead(404).end(); return }
    void handler(req, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const auth = { authorization: `Bearer ${SECRET}` }
  return {
    base, surface, hub, channel, sent, followups, agent, journal,
    emit(type, data) {
      const event = { type, seq: journal.length, time: Date.parse('2026-09-29T10:00:00Z') + journal.length * 1000, data }
      journal.push(event)
      channel.onSessionEvent(SESSION, event)
      surface.onSessionEvent(SESSION, event)
      return event
    },
    ask(toolName, window = async () => 'unavailable', signal) {
      return hub.request({ agent: { session: { id: SESSION } }, toolName, reason: 'нужно для дела', signal }, window)
    },
    post: (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    get: (path, headers = {}) => fetch(`${base}${path}`, { headers: { ...auth, ...headers } }),
    close: async () => {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

/** Читатель SSE: копит события, ждёт нужное. */
export class SseReader {
  readonly events: (SurfaceEvent & { sseId: string, sseEvent: string })[] = []
  comments = 0
  private readonly controller = new AbortController()
  private waiters: (() => void)[] = []
  readonly done: Promise<void>
  response!: Response

  constructor(url: string, headers: Record<string, string>) {
    this.done = (async () => {
      this.response = await fetch(url, { headers, signal: this.controller.signal })
      const reader = this.response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let cut: number
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, cut)
            buffer = buffer.slice(cut + 2)
            if (block.startsWith(':')) { this.comments += 1; continue }
            const field = (name: string) => block.split('\n').find(line => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? ''
            this.events.push({ ...JSON.parse(field('data')), sseId: field('id'), sseEvent: field('event') })
          }
          for (const wake of this.waiters.splice(0)) wake()
        }
      } catch { /* закрыт */ }
    })()
  }

  async waitFor(predicate: (events: SseReader['events']) => boolean, ms = 2000): Promise<void> {
    const deadline = Date.now() + ms
    while (!predicate(this.events)) {
      if (Date.now() > deadline) throw new Error(`не дождались событий: ${this.events.map(e => e.type).join(', ')}`)
      await new Promise<void>(resolve => { this.waiters.push(resolve); setTimeout(resolve, 20) })
    }
  }

  close(): void {
    this.controller.abort()
  }
}
