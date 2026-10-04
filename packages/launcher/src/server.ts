/**
 * HTTP-сервер launcher'а (TAI-ADR-0051 п.2):
 * - `<mount>/_launcher/{login,callback,logout,health}` — вход человека;
 * - `POST <mount>/_launcher/internal/principals/{id}/inbound` — вход каналов
 *   (access token IAM, audience `human-harness`, scope `harness:inbound`);
 * - `<mount>/_launcher/internal/principals/{id}/surface/{message,stream,history,approval}` —
 *   поверхность беседы (консоль; access token IAM человека, scope `harness:use`),
 *   см. `surface.ts`;
 * - всё остальное — прокси HTTP и WebSocket в контейнер principal из cookie.
 *
 * Изоляция: контейнер выбирается только по подписанной cookie launcher'а, адреса
 * чужого харнесса в запросе нет. Cookie launcher'а в контейнер не уходит; вместо
 * неё — заголовок `X-Harness-Launcher` (HMAC секретом контейнера), входящий
 * заголовок с тем же именем срезается.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import type { LauncherConfig } from './config.ts'
import { cookie, LAUNCHER_HEADER, launcherHeader, parseCookies, seal, unseal, verifyIamToken, type Jwks } from './crypto.ts'
import type { Fleet, Upstream } from './fleet.ts'
import type { Iam, Oidc } from './identity.ts'
import type { Journal } from './journal.ts'
import { Surface, type SurfaceOp } from './surface.ts'

export const SESSION_COOKIE = 'hh_session'
export const PKCE_COOKIE = 'hh_pkce'
const SESSION_TTL_MS = 12 * 3600_000
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

export interface ServerDeps {
  config: Pick<LauncherConfig, 'mount' | 'publicUrl' | 'secureCookies' | 'cookieSecret' | 'iam' | 'startTimeoutMs'>
  fleet: Fleet
  oidc: Pick<Oidc, 'start' | 'exchange'>
  iam: Pick<Iam, 'federate'>
  jwks: Jwks
  journal: Journal
  /** Тонкая настройка поверхности (тесты): ожидание ответа контейнера и пауза повтора потока. */
  surface?: { responseTimeoutMs?: number, streamRetryMs?: number }
}

function page(res: ServerResponse, status: number, title: string, text: string): void {
  const body = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
    + `<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1d2a2e"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body></html>`
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body)
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value))
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('тело запроса слишком большое'), { status: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export class LauncherServer {
  readonly server: Server
  private readonly mount: string
  private readonly cookiePath: string
  private readonly surface: Surface

  constructor(private readonly deps: ServerDeps) {
    this.mount = deps.config.mount
    this.cookiePath = this.mount === '' ? '/' : this.mount
    this.surface = new Surface({
      iam: deps.config.iam, startTimeoutMs: deps.config.startTimeoutMs, fleet: deps.fleet, jwks: deps.jwks, journal: deps.journal,
      ...deps.surface,
    })
    this.server = createServer((req, res) => { void this.handle(req, res) })
    this.server.on('upgrade', (req, socket, head) => { void this.upgrade(req, socket, head) })
  }

  private path(req: IncomingMessage): { path: string, query: URLSearchParams } | null {
    const url = new URL(req.url ?? '/', 'http://launcher')
    if (this.mount !== '' && url.pathname !== this.mount && !url.pathname.startsWith(`${this.mount}/`)) return null
    const path = url.pathname.slice(this.mount.length) || '/'
    return { path, query: url.searchParams }
  }

  private principal(req: IncomingMessage): string | null {
    const session = unseal<{ principalId: string }>(this.deps.config.cookieSecret, parseCookies(req.headers.cookie)[SESSION_COOKIE])
    return session?.principalId ?? null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const target = this.path(req)
      if (target === null) return page(res, 404, 'Не найдено', 'Адрес вне рабочего места.')
      const { path, query } = target
      if (path === '/_launcher/health') return json(res, 200, { ok: true })
      if (path === '/_launcher/login') return await this.login(res, query.get('next'))
      if (path === '/_launcher/callback') return await this.callback(req, res, query)
      if (path === '/_launcher/logout') {
        res.setHeader('set-cookie', cookie(SESSION_COOKIE, '', { path: this.cookiePath, secure: this.deps.config.secureCookies, maxAgeSeconds: 0 }))
        return page(res, 200, 'Вы вышли', `<a href="${this.mount}/_launcher/login">Войти снова</a>`)
      }
      const inbound = /^\/_launcher\/internal\/principals\/([0-9a-f-]{36})\/inbound$/.exec(path)
      if (inbound !== null && req.method === 'POST') return await this.inbound(req, res, inbound[1]!)
      const surface = /^\/_launcher\/internal\/principals\/([0-9a-f-]{36})\/surface\/(message|stream|history|approval)$/.exec(path)
      // Простой здесь не сбрасывается заранее: решает сама поверхность (поток и история — нет).
      if (surface !== null) return await this.surface.handle(req, res, surface[1]!, surface[2] as SurfaceOp, `${this.mount}${path}`)
      if (path.startsWith('/_launcher/')) return page(res, 404, 'Не найдено', 'Такого адреса у launcher нет.')

      const principalId = this.principal(req)
      if (principalId === null) {
        if (req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')) {
          res.writeHead(302, { location: `${this.mount}/_launcher/login?next=${encodeURIComponent(path)}` }).end()
          return
        }
        return json(res, 401, { error: { code: 'unauthenticated', message: 'нужен вход' } })
      }
      if (this.deps.fleet.person(principalId) === null) return page(res, 403, 'Рабочее место не выдано', 'Для вашей учётной записи рабочее место ещё не заведено. Обратитесь к администратору.')
      const upstream = await this.deps.fleet.ensure(principalId)
      this.deps.fleet.touch(principalId)
      await this.proxy(req, res, upstream, principalId, path)
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500
      this.deps.journal('request.failed', { url: req.url, status, error: String(error) })
      if (!res.headersSent) page(res, status >= 400 && status < 600 ? status : 500, 'Рабочее место недоступно', status === 504 ? 'Рабочее место не успело запуститься. Обновите страницу через минуту.' : 'Произошла ошибка. Попробуйте ещё раз.')
      else res.destroy()
    }
  }

  private redirectUri(): string {
    return `${this.deps.config.publicUrl}/_launcher/callback`
  }

  private async login(res: ServerResponse, next: string | null): Promise<void> {
    const start = await this.deps.oidc.start(this.redirectUri())
    const safeNext = next !== null && next.startsWith('/') && !next.startsWith('//') ? next : '/'
    res.setHeader('set-cookie', cookie(PKCE_COOKIE, seal(this.deps.config.cookieSecret, { state: start.state, verifier: start.verifier, next: safeNext }, Date.now() + 10 * 60_000), {
      path: this.cookiePath, secure: this.deps.config.secureCookies, maxAgeSeconds: 600,
    }))
    res.writeHead(302, { location: start.url }).end()
  }

  private async callback(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<void> {
    const pkce = unseal<{ state: string, verifier: string, next: string }>(this.deps.config.cookieSecret, parseCookies(req.headers.cookie)[PKCE_COOKIE])
    const code = query.get('code')
    if (pkce === null || code === null || query.get('state') !== pkce.state) {
      return page(res, 400, 'Вход не завершён', `Сессия входа устарела. <a href="${this.mount}/_launcher/login">Войти снова</a>`)
    }
    const token = await this.deps.oidc.exchange(code, pkce.verifier, this.redirectUri())
    let principalId: string
    try {
      principalId = (await this.deps.iam.federate(this.deps.config.iam.identityProvider, token, this.deps.config.iam.audience, this.deps.config.iam.scopes)).principalId
    } catch (error) {
      this.deps.journal('login.refused', { error: String(error) })
      return page(res, 403, 'Вход запрещён', 'Учётная запись не прошла проверку в IAM (отключена или не связана).')
    }
    this.deps.journal('login', { principalId })
    res.setHeader('set-cookie', [
      cookie(SESSION_COOKIE, seal(this.deps.config.cookieSecret, { principalId }, Date.now() + SESSION_TTL_MS), { path: this.cookiePath, secure: this.deps.config.secureCookies, maxAgeSeconds: SESSION_TTL_MS / 1000 }),
      cookie(PKCE_COOKIE, '', { path: this.cookiePath, secure: this.deps.config.secureCookies, maxAgeSeconds: 0 }),
    ])
    // Вход в DSH: контейнер по заголовку launcher'а выдаёт штатную cookie DSH.
    res.writeHead(302, { location: `${this.mount}/_harness/enter?next=${encodeURIComponent(pkce.next)}` }).end()
  }

  private async inbound(req: IncomingMessage, res: ServerResponse, principalId: string): Promise<void> {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
    const claims = bearer === undefined ? null : await verifyIamToken(bearer, this.deps.jwks, {
      issuer: this.deps.config.iam.issuer, audience: 'human-harness', tenantId: this.deps.config.iam.tenantId, scope: 'harness:inbound',
    })
    if (claims === null) return json(res, 401, { error: { code: 'unauthenticated', message: 'нужен токен IAM audience human-harness со scope harness:inbound' } })
    if (this.deps.fleet.person(principalId) === null) return json(res, 404, { error: { code: 'harness_not_found', message: 'у principal нет рабочего места' } })
    const body = JSON.parse(await readBody(req) || '{}') as { text?: unknown, channel?: unknown, messageId?: unknown, approval?: unknown }
    if (typeof body.channel !== 'string') return json(res, 400, { error: { code: 'bad_request', message: 'channel обязателен' } })
    const messageId = typeof body.messageId === 'string' ? { messageId: body.messageId } : {}
    const approval = body.approval as { id?: unknown, decision?: unknown } | undefined
    if (approval !== undefined) {
      // Нажатие подтверждения харнесса в канале (TAI-ADR-0051 п.7).
      if (typeof approval.id !== 'string' || approval.id.length > 200 || (approval.decision !== 'approve' && approval.decision !== 'reject')) {
        return json(res, 400, { error: { code: 'bad_request', message: 'approval: id и decision (approve|reject)' } })
      }
      await this.deps.fleet.inbound(principalId, { channel: body.channel, ...messageId, approval: { id: approval.id, decision: approval.decision } })
    } else {
      if (typeof body.text !== 'string' || body.text.trim() === '') {
        return json(res, 400, { error: { code: 'bad_request', message: 'text или approval обязательны' } })
      }
      await this.deps.fleet.inbound(principalId, { text: body.text.slice(0, 8000), channel: body.channel, ...messageId })
    }
    this.deps.journal('inbound', { principalId, channel: body.channel, caller: claims.sub })
    json(res, 202, { accepted: true })
  }

  /** Заголовки к контейнеру: без hop-by-hop, без cookie launcher'а и чужого заголовка launcher'а. */
  private forwardHeaders(req: IncomingMessage, upstream: Upstream, principalId: string): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name) || name === LAUNCHER_HEADER) continue
      if (name === 'cookie') {
        const kept = String(value).split(';').map(s => s.trim()).filter(s => s !== '' && !s.startsWith(`${SESSION_COOKIE}=`) && !s.startsWith(`${PKCE_COOKIE}=`))
        if (kept.length > 0) out.cookie = kept.join('; ')
        continue
      }
      out[name] = value
    }
    const publicUrl = new URL(this.deps.config.publicUrl)
    out[LAUNCHER_HEADER] = launcherHeader(upstream.secret, principalId)
    out['x-harness-principal'] = principalId
    out['x-forwarded-proto'] = publicUrl.protocol.replace(':', '')
    out['x-forwarded-host'] = String(req.headers.host ?? publicUrl.host)
    out['x-forwarded-prefix'] = this.mount
    return out
  }

  private proxy(req: IncomingMessage, res: ServerResponse, upstream: Upstream, principalId: string, path: string): Promise<void> {
    const target = new URL(upstream.url)
    const search = new URL(req.url ?? '/', 'http://launcher').search
    return new Promise((resolve) => {
      const outgoing = httpRequest({
        host: target.hostname, port: Number(target.port || 80), method: req.method, path: `${path}${search}`,
        headers: this.forwardHeaders(req, upstream, principalId),
      }, (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502
        // Cookie DSH истекла — заново через вход launcher'а, а не голый 401.
        if (status === 401 && req.method === 'GET' && (req.headers.accept ?? '').includes('text/html') && path !== '/_harness/enter') {
          upstreamRes.resume()
          res.writeHead(302, { location: `${this.mount}/_harness/enter?next=${encodeURIComponent(path)}` }).end()
          return resolve()
        }
        const headers = { ...upstreamRes.headers }
        for (const name of HOP_BY_HOP) delete headers[name]
        res.writeHead(status, headers)
        upstreamRes.pipe(res)
        upstreamRes.on('end', resolve)
        upstreamRes.on('error', () => { res.destroy(); resolve() })
      })
      outgoing.on('error', (error) => {
        this.deps.journal('proxy.error', { principalId, path, error: String(error) })
        if (!res.headersSent) page(res, 502, 'Рабочее место недоступно', 'Не удалось связаться с рабочим местом. Обновите страницу.')
        else res.destroy()
        resolve()
      })
      req.pipe(outgoing)
    })
  }

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const refuse = (status: number, text: string): void => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    try {
      const target = this.path(req)
      const principalId = this.principal(req)
      if (target === null) return refuse(404, 'Not Found')
      if (principalId === null) return refuse(401, 'Unauthorized')
      if (this.deps.fleet.person(principalId) === null) return refuse(403, 'Forbidden')
      const upstream = await this.deps.fleet.ensure(principalId)
      this.deps.fleet.touch(principalId)
      const url = new URL(upstream.url)
      const search = new URL(req.url ?? '/', 'http://launcher').search
      const headers = this.forwardHeaders(req, upstream, principalId)
      headers.connection = 'Upgrade'
      headers.upgrade = String(req.headers.upgrade ?? 'websocket')
      const upstreamSocket = connect(Number(url.port || 80), url.hostname, () => {
        const lines = [`${req.method ?? 'GET'} ${target.path}${search} HTTP/1.1`]
        for (const [name, value] of Object.entries(headers)) for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`)
        upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`)
        if (head.length > 0) upstreamSocket.write(head)
        upstreamSocket.pipe(socket)
        socket.pipe(upstreamSocket)
      })
      const close = (): void => { upstreamSocket.destroy(); socket.destroy() }
      upstreamSocket.on('error', close)
      socket.on('error', close)
      upstreamSocket.on('close', () => socket.destroy())
      socket.on('close', () => upstreamSocket.destroy())
    } catch (error) {
      this.deps.journal('upgrade.failed', { url: req.url, error: String(error) })
      refuse((error as { status?: number }).status ?? 502, 'Bad Gateway')
    }
  }
}
