/**
 * HTTP-маршруты для браузерной половины (`/api/harness/*`) через exact Fetch
 * routes Connection DSH: браузер аутентифицирован cookie харнесса, PAT остаётся
 * на хосте. Мутации (решение по approval, переход статуса задачи) идут прямыми
 * доменными endpoint'ами ядра с Idempotency-Key и If-Match; авторизацию
 * повторно проверяет Control Plane — панель ничего не решает сама.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { ControlPlaneError } from './client.ts'
import type { DshConversation } from './conversation.ts'
import type { Proactivity } from './proactivity.ts'
import { nextWakeAt } from './proactivity.ts'
import type { ControlPlane } from './service.ts'
import type { ChangeSignal } from './signal.ts'

export const ROUTE_PREFIX = '/api/harness'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

function failure(error: unknown): Response {
  if (error instanceof ControlPlaneError) {
    return json({ error: { code: error.code, message: error.message, status: error.status, requestId: error.requestId ?? null } }, error.status === 0 ? 503 : error.status)
  }
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown }).code
  return json({ error: { code: typeof code === 'string' ? code : 'internal', message } }, typeof code === 'string' && code.startsWith('iam_') ? 401 : 500)
}

/** Смонтировать маршруты, когда доступен `ctx.connection` (в headless его нет). */
export interface RouteExtras {
  signal: ChangeSignal
  proactivity: Proactivity | null
  conversation: DshConversation
}

export function mountRoutes(ctx: Context, cp: ControlPlane, extras: RouteExtras): void {
  // Окно открыто и опрашивает «Важное» — человек здесь; вернувшемуся — сводка.
  const present = (): void => { void extras.proactivity?.proactive.presence() }
  ctx.inject(['connection'], (scoped) => {
    const get = (path: string, handler: (request: Request) => Promise<unknown>) => {
      scoped.effect(() => scoped.connection.fetch.register({
        path: `${ROUTE_PREFIX}/${path}`,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            return json(await handler(request))
          } catch (error) {
            return failure(error)
          }
        },
      }), `harness: route ${path}`)
    }
    const post = (path: string, handler: (request: Request, body: Record<string, unknown>) => Promise<unknown>) => {
      scoped.effect(() => scoped.connection.fetch.register({
        path: `${ROUTE_PREFIX}/${path}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const body = request.headers.get('content-length') === '0' ? {} : await request.json().catch(() => ({})) as Record<string, unknown>
            return json(await handler(request, body))
          } catch (error) {
            return failure(error)
          }
        },
      }), `harness: route ${path}`)
    }

    get('whoami', (request) => { present(); return cp.whoami(request.signal) })
    get('attention', (request) => { present(); return cp.attention(request.signal) })
    // Long-poll: ответ, как только событие ядра коснулось человека (или через 25 с).
    get('changes', async (request) => {
      const after = Number(new URL(request.url).searchParams.get('after') ?? '0')
      return { seq: await extras.signal.wait(Number.isFinite(after) ? after : 0, 25_000, request.signal) }
    })
    // «Обсудить в беседе»: элемент «Важного» становится репликой человека в единственной беседе.
    post('attention.discuss', async (_request, body) => {
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 300) : ''
      const ref = typeof body.ref === 'string' ? body.ref.trim().slice(0, 80) : ''
      if (title === '') throw new ControlPlaneError(400, 'bad_request', 'title обязателен')
      await extras.conversation.deliver(`Обсудим из «Важного»: ${title}${ref ? ` (${ref})` : ''}. Что здесь нужно от меня?`, 'user')
      return { delivered: true }
    })
    // Id единственной беседы: окно открывает её, а не черновик новой сессии.
    get('conversation', async () => ({ sessionId: await extras.conversation.sessionId() }))
    get('wake', async () => ({ nextWakeAt: await nextWakeAt(scoped) }))
    post('attention.feedback', (_request, body) => {
      const itemKey = typeof body.itemKey === 'string' ? body.itemKey : ''
      const verdict = body.verdict === 'useful' ? 'useful' : body.verdict === 'not_needed' ? 'not_needed' : null
      if (itemKey === '' || verdict === null) throw new ControlPlaneError(400, 'bad_request', 'itemKey и verdict (useful|not_needed) обязательны')
      return cp.attentionFeedback(itemKey, verdict, typeof body.comment === 'string' ? body.comment : null)
    })
    get('workspaces', (request) => cp.workspaces(request.signal))
    post('workspace.select', (request, body) => cp.selectWorkspace(typeof body.workspaceId === 'string' && body.workspaceId !== '' ? body.workspaceId : null, request.signal))
    post('approvals.decide', (_request, body) => {
      const approvalId = typeof body.approvalId === 'string' ? body.approvalId : ''
      const decision = body.decision === 'reject' ? 'reject' : body.decision === 'approve' ? 'approve' : null
      if (approvalId === '' || decision === null) throw new ControlPlaneError(400, 'bad_request', 'approvalId и decision (approve|reject) обязательны')
      const comment = typeof body.comment === 'string' && body.comment.trim() !== '' ? body.comment.trim() : null
      if (decision === 'reject' && comment === null) throw new ControlPlaneError(400, 'comment_required', 'отклонение требует комментария')
      const key = typeof body.idempotencyKey === 'string' && body.idempotencyKey !== '' ? body.idempotencyKey : undefined
      return cp.client.decideApproval(approvalId, decision, comment, key)
    })
    post('tasks.transition', (_request, body) => {
      const ref = typeof body.ref === 'string' ? body.ref : ''
      const status = typeof body.status === 'string' ? body.status : ''
      const version = typeof body.version === 'number' ? body.version : Number.NaN
      if (ref === '' || status === '' || !Number.isFinite(version)) throw new ControlPlaneError(400, 'bad_request', 'ref, status и version обязательны')
      return cp.client.updateTask(ref, { status }, version)
    })
    scoped.logger.info(`control-plane: маршруты ${ROUTE_PREFIX}/{whoami,conversation,attention,changes,attention.discuss,attention.feedback,wake,workspaces,approvals.decide,tasks.transition,workspace.select} смонтированы`)
  })
}
