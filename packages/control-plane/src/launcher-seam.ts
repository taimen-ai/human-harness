/**
 * Шов харнесса с launcher'ом (TAI-ADR-0051 п.2). Контейнер недоступен снаружи:
 * запросы приходят только через launcher, который подписывает их заголовком
 * `X-Harness-Launcher` (HMAC общего секрета контейнера над `ts.principal`).
 *
 * - `GET /_harness/health` — готовность (без аутентификации, без данных): за launcher'ом —
 *   готовность беседы, иначе веб-хоста. Launcher зовёт его перед каждым проксируемым
 *   запросом (`Fleet.ensure` → `waitReady`), поэтому в нём нет тяжёлых проверок;
 * - `GET /_harness/enter` — заголовок launcher'а для principal этого контейнера →
 *   redirect на `authenticatedUrl()` DSH: браузер получает штатную cookie DSH;
 *   без заголовка — 401;
 * - `GET /internal/harness/status` — идёт ли ход и ближайшее напоминание (сон и
 *   пробуждение контейнера);
 * - `POST /internal/harness/inbound` — сообщение канала (Telegram) в беседу;
 * - `/internal/harness/surface/{message,stream,history,approval}` — API поверхности
 *   беседы (контракт `surface/1`, см. `surface.ts`).
 * Служебные маршруты — bearer тем же секретом.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ApprovalHub } from './approvals.ts'
import type { DshConversation } from './conversation.ts'
import { SurfaceError, surfaceHandlers, type Handler, type SurfaceBridge } from './surface.ts'

export const LAUNCHER_HEADER = 'x-harness-launcher'
const SKEW_SECONDS = 60

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Проверить `v1.<ts>.<hmac>` для principal этого контейнера. */
export function verifyLauncherHeader(secret: string, principalId: string, header: string | undefined, now = Date.now()): boolean {
  const match = /^v1\.(\d+)\.([\w-]+)$/.exec(header ?? '')
  if (match === null) return false
  const ts = Number(match[1])
  if (Math.abs(Math.floor(now / 1000) - ts) > SKEW_SECONDS) return false
  return safeEqual(match[2]!, createHmac('sha256', secret).update(`${ts}.${principalId}`).digest('base64url'))
}

/** Внешний адрес окна по заголовкам launcher'а: схема, хост и префикс монтирования. */
export function publicBase(req: IncomingMessage): string {
  const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim()
  const proto = first(req.headers['x-forwarded-proto']) ?? 'http'
  const host = first(req.headers['x-forwarded-host']) ?? first(req.headers.host) ?? 'localhost'
  const prefix = (first(req.headers['x-forwarded-prefix']) ?? '').replace(/\/+$/, '')
  return `${proto}://${host}${prefix}/`
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body))
}

/** Лимит тела служебных запросов (контракт surface/1: тот же у launcher'а). */
export const BODY_LIMIT = 64 * 1024

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new SurfaceError(413, 'body_too_large', 'тело больше 64 КБ')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
}

export interface LauncherSeamOptions {
  /** Секрет контейнера от launcher'а; без него работают только health и локальный вход DSH. */
  secret: string | null
  principalId: () => string | null
  conversation: Pick<DshConversation, 'deliver' | 'busy' | 'ready'>
  /** Гонка подтверждений между поверхностями; без неё нажатия из канала не принимаются. */
  approvals: ApprovalHub | null
  /** API поверхности беседы; без него маршруты `/internal/harness/surface/*` не монтируются. */
  surface: SurfaceBridge | null
  nextWakeAt: () => Promise<string | null>
  log?: { warn(msg: string): void }
}

/** Проверка `Authorization: Bearer <секрет контейнера>` — общая для всех служебных маршрутов. */
export function bearerCheck(secret: string): (req: IncomingMessage) => boolean {
  return req => safeEqual(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''), secret)
}

/** Служебные маршруты контейнера (bearer секретом): статус, inbound канала, поверхность. */
export function internalHandlers(secret: string, options: LauncherSeamOptions): Record<string, Handler> {
  const bearer = bearerCheck(secret)
  return {
    '/internal/harness/status': async (req, res) => {
      if (!bearer(req)) return reply(res, 401, { error: 'unauthorized' })
      reply(res, 200, {
        busy: await options.conversation.busy().catch(() => false),
        nextWakeAt: await options.nextWakeAt().catch(() => null),
      })
    },
    '/internal/harness/inbound': async (req, res) => {
      if (req.method !== 'POST') return reply(res, 405, { error: 'method_not_allowed' })
      if (!bearer(req)) return reply(res, 401, { error: 'unauthorized' })
      try {
        const body = await readJson(req)
        if (typeof body.channel !== 'string') return reply(res, 400, { error: 'channel обязателен' })
        const approval = body.approval as { id?: unknown, decision?: unknown } | undefined
        if (approval !== undefined) {
          if (typeof approval.id !== 'string' || (approval.decision !== 'approve' && approval.decision !== 'reject')) {
            return reply(res, 400, { error: 'approval: id и decision (approve|reject)' })
          }
          // Уже решено на другой поверхности или истекло — нажатие ничего не меняет, но и не ошибка канала.
          const decided = options.approvals?.decide(approval.id, approval.decision === 'approve' ? 'allow' : 'reject', 'telegram') ?? null
          return reply(res, 202, { accepted: true, resolved: decided?.status === 'resolved', status: decided?.status ?? 'unknown' })
        }
        if (typeof body.text !== 'string' || body.text.trim() === '') return reply(res, 400, { error: 'text или approval обязательны' })
        await options.conversation.deliver(body.text, 'channel', { channel: body.channel })
        reply(res, 202, { accepted: true })
      } catch (error) {
        if (error instanceof SurfaceError) return reply(res, error.status, { error: error.code })
        options.log?.warn(`inbound: беседа недоступна: ${String(error)}`)
        reply(res, 503, { error: 'conversation_unavailable' })
      }
    },
    ...(options.surface !== null ? surfaceHandlers({ bridge: options.surface, authorized: bearer, readJson }) : {}),
  }
}

/**
 * `GET /_harness/health`. За launcher'ом (есть секрет) готовность — это готовность
 * беседы: веб-хост отвечает раньше, чем DSH привяжет службы сессий, и launcher,
 * поверивший раннему 200, отдавал первым запросам холодного старта
 * `503 conversation_unavailable`. Без launcher'а — готовность веб-хоста.
 */
export function healthHandler(options: Pick<LauncherSeamOptions, 'secret' | 'conversation'>): Handler {
  const behindLauncher = options.secret !== null && options.secret !== ''
  return (_req, res) => {
    if (behindLauncher && !options.conversation.ready()) return reply(res, 503, { ok: false, reason: 'conversation_not_ready' })
    reply(res, 200, { ok: true })
  }
}

export function mountLauncherSeam(ctx: Context, options: LauncherSeamOptions): void {
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: '/_harness/health',
      handler: healthHandler(options),
    }), 'harness: health')
  })
  const secret = options.secret
  if (secret === null || secret === '') return
  ctx.inject(['webServer', 'connection'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: '/_harness/enter',
      handler: (req, res) => {
        const principalId = options.principalId()
        if (principalId === null || !verifyLauncherHeader(secret, principalId, req.headers[LAUNCHER_HEADER] as string | undefined)) {
          reply(res, 401, { error: { code: 'launcher_required', message: 'вход только через launcher' } })
          return
        }
        res.writeHead(302, { location: scoped.connection.authenticatedUrl(publicBase(req)), 'cache-control': 'no-store' }).end()
      },
    }), 'harness: launcher enter')
  })

  ctx.inject(['webServer'], (scoped) => {
    for (const [path, handler] of Object.entries(internalHandlers(secret, options))) {
      scoped.effect(() => scoped.webServer.register({ kind: 'exact', path, handler }), `harness: ${path}`)
    }
  })
}
