/**
 * Поверхность беседы на участке launcher'а (TAI-ADR-0051, амендмент 2026-09-29;
 * контракт `docs/contracts/harness-surface`, версия `surface/1`):
 * `<mount>/_launcher/internal/principals/{p}/surface/{message,stream,history,approval}`
 * → контейнер `/internal/harness/surface/*` с Bearer секрета контейнера.
 *
 * Launcher проверяет человека, будит контейнер и проксирует; смысла беседы он не
 * знает и тел не хранит и не журналирует — в журнал доступа идут только метод,
 * путь, статус, время и `requestId`.
 *
 * Кто вызывает: access token IAM человека (обмен `federation:exchange`), audience
 * `human-harness`, scope `harness:use`, `principal_type=human`. Principal сверяется
 * по `sub`: IAM выпускает federation-токен с `sub = str(principal.id)` — это и есть
 * IAM principal (iam-service `federation:exchange` → `token_issuer().issue(subject=
 * principal.id, …)`, `tokens.py`: `"sub": str(subject)`); claim `principal_id` IAM
 * не выпускает вовсе.
 *
 * Сон и пробуждение. Будят контейнер `message`, `approval` и `history`; простой
 * сбрасывают только `message` и `approval`. Поток контейнер **не будит**: к спящему
 * он отдаёт `sleeping` и ждёт с heartbeat, пока контейнер не разбудит кто-то другой
 * (`fleet.onWake`) — тогда `waking` и подключение к потоку контейнера, дальше идёт
 * `ready` самого контейнера. Контейнер уснул при открытом потоке — снова
 * `sleeping`, соединение остаётся открытым: закрытие с переподключением не должно
 * будить контейнер по кругу.
 *
 * Синтетические события (`sleeping`, `waking`) идут без строки `id:` — SSE при
 * этом сохраняет прежний Last-Event-ID клиента. Их `cursor` — последний курсор
 * беседы, известный launcher'у (из `id:` потока контейнера или из запроса
 * клиента), а если его нет — локальная метка `launcher.<тип>.<мс>`. Такую метку
 * launcher, получив обратно в `Last-Event-ID` или `after`, в контейнер не
 * передаёт. Контейнер без курсора отдаёт только живые события, и его `ready`
 * придёт без `resumed: true` — клиент тогда перечитывает `history`.
 */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { verifyIamToken, type Jwks } from './crypto.ts'
import type { Fleet, Upstream } from './fleet.ts'
import type { Journal } from './journal.ts'

export const SURFACE_VERSION = 'surface/1'
export const SURFACE_OPS = { message: 'POST', stream: 'GET', history: 'GET', approval: 'POST' } as const
export type SurfaceOp = keyof typeof SURFACE_OPS
export const SURFACE_AUDIENCE = 'human-harness'
export const SURFACE_SCOPE = 'harness:use'
/** Префикс курсора синтетических событий launcher'а. */
export const SYNTHETIC_CURSOR = 'launcher.'
/** Лимиты участка launcher'а (контракт, «Лимиты участка launcher'а»). */
export const BODY_LIMIT = 64 * 1024
export const MAX_STREAMS = 8
export const RESPONSE_TIMEOUT_MS = 30_000
/** Контейнер ответил на поток `429` — повтор через столько, без пробуждения. */
export const STREAM_RETRY_MS = 5_000
const PING_MS = 15_000
/** Курсор непрозрачен, но это одна строка печатного ASCII без пробелов, не длиннее 200. */
const CURSOR = /^[\x21-\x7e]{1,200}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Поверхность называет вызывающий; каналы и окно входят своими путями. */
const SURFACE_NAME = /^[a-z][a-z0-9-]{0,31}$/
const RESERVED_SURFACES = new Set(['telegram', 'window'])
/** Из ответа контейнера наружу уходят только эти заголовки. */
const RESPONSE_HEADERS = ['content-type', 'cache-control', 'x-harness-surface-version'] as const

export interface SurfaceDeps {
  iam: { issuer: string, tenantId: string }
  startTimeoutMs: number
  /** Ожидание ответа контейнера после готовности; по умолчанию 30 с. */
  responseTimeoutMs?: number
  /** Пауза перед повтором подключения к потоку контейнера после его `429`; по умолчанию 5 с. */
  streamRetryMs?: number
  fleet: Pick<Fleet, 'person' | 'ensure' | 'upstream' | 'touch' | 'awake' | 'onStop' | 'onWake'>
  jwks: Jwks
  journal: Journal
}

class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-harness-surface-version': SURFACE_VERSION }).end(JSON.stringify(value))
}

async function readBody(req: IncomingMessage): Promise<string> {
  if (Number(req.headers['content-length'] ?? 0) > BODY_LIMIT) throw new Refusal(413, 'body_too_large', `тело больше ${BODY_LIMIT} байт`)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new Refusal(413, 'body_too_large', `тело больше ${BODY_LIMIT} байт`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const synthetic = (cursor: string | null): boolean => cursor !== null && cursor.startsWith(SYNTHETIC_CURSOR)

function whitelisted(headers: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of RESPONSE_HEADERS) {
    const value = headers[name]
    if (typeof value === 'string') out[name] = value
  }
  out['x-harness-surface-version'] ??= SURFACE_VERSION
  out['cache-control'] ??= 'no-store'
  return out
}

export class Surface {
  private readonly streams = new Map<string, number>()

  constructor(private readonly deps: SurfaceDeps) {}

  /** `logPath` — путь запроса без query: в журнал доступа не попадают ни тела, ни курсоры. */
  async handle(req: IncomingMessage, res: ServerResponse, principalId: string, op: SurfaceOp, logPath: string): Promise<void> {
    const started = Date.now()
    // Клиент может уйти, пока идёт проверка токена (JWKS): `close` к концу проверки
    // уже прошёл, и подписка в `stream()` его не увидит. Флаг ставится сразу.
    let gone = false
    res.once('close', () => { gone = true })
    let requestId: string | undefined
    const access = (status: number): void => {
      this.deps.journal('surface.access', { method: req.method, path: logPath, status, ms: Date.now() - started, ...(requestId !== undefined ? { requestId } : {}) })
    }
    try {
      if (req.method !== SURFACE_OPS[op]) throw new Refusal(405, 'method_not_allowed', `${op}: только ${SURFACE_OPS[op]}`)
      await this.authorize(req, principalId)
      if (op === 'stream') {
        // Ушедший клиент не занимает слот потока и не открывает поток в контейнер.
        if (gone || req.destroyed || res.destroyed || res.socket?.destroyed === true) return access(499)
        return this.stream(req, res, principalId, access)
      }
      let body: string | undefined
      if (req.method === 'POST') {
        body = await readBody(req)
        let parsed: unknown
        try { parsed = JSON.parse(body) } catch { throw new Refusal(400, 'bad_request', 'тело — JSON') }
        const id = (parsed as { requestId?: unknown } | null)?.requestId
        if (op === 'message' && typeof id === 'string' && UUID.test(id)) requestId = id
      }
      const upstream = await this.wake(principalId)
      // Сообщение и решение — действие человека; история будит, но простой не сбрасывает.
      if (op === 'message' || op === 'approval') this.deps.fleet.touch(principalId)
      const search = new URL(req.url ?? '/', 'http://launcher').search
      const reply = await this.call(upstream, `${op}${search}`, req.method, this.headers(req, upstream, body !== undefined ? { 'content-type': 'application/json' } : {}), body)
      res.writeHead(reply.status, reply.headers).end(reply.body)
      access(reply.status)
    } catch (error) {
      const refusal = this.refusal(error)
      if (!res.headersSent) json(res, refusal.status, { error: { code: refusal.code, message: refusal.message } })
      else res.destroy()
      access(refusal.status)
    }
  }

  private refusal(error: unknown): Refusal {
    if (error instanceof Refusal) return error
    const status = (error as { status?: number }).status
    if (status === 504) return new Refusal(504, 'waking_timeout', 'рабочее место не успело проснуться')
    this.deps.journal('surface.error', { error: String(error) })
    return new Refusal(502, 'harness_unavailable', 'рабочее место недоступно')
  }

  private async authorize(req: IncomingMessage, principalId: string): Promise<void> {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
    const claims = bearer === undefined ? null : await verifyIamToken(bearer, this.deps.jwks, {
      issuer: this.deps.iam.issuer, audience: SURFACE_AUDIENCE, tenantId: this.deps.iam.tenantId, scope: null,
    })
    if (claims === null) throw new Refusal(401, 'unauthorized', `нужен токен IAM audience ${SURFACE_AUDIENCE}`)
    if (!claims.scope.includes(SURFACE_SCOPE)) throw new Refusal(403, 'forbidden', `нужен scope ${SURFACE_SCOPE}`)
    if (claims.principal_type !== 'human') throw new Refusal(403, 'forbidden', 'поверхность беседы — только для человека')
    // `sub` federation-токена IAM — сам IAM principal (см. шапку модуля).
    if (claims.sub !== principalId) throw new Refusal(403, 'forbidden', 'чужой principal')
    // Реестр проверяется после сверки principal: чужой не узнает, заведено ли рабочее место.
    if (this.deps.fleet.person(principalId) === null) throw new Refusal(404, 'principal_unknown', 'у principal нет рабочего места')
  }

  /** Разбудить контейнер; не дольше бюджета холодного старта (`LAUNCHER_START_TIMEOUT_SECONDS`). */
  private async wake(principalId: string): Promise<Upstream> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('waking_timeout'), { status: 504 })), this.deps.startTimeoutMs)
    })
    try {
      return await Promise.race([this.deps.fleet.ensure(principalId), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  private headers(req: IncomingMessage, upstream: Upstream, extra: Record<string, string>): Record<string, string> {
    const named = req.headers['x-harness-surface']
    const surface = typeof named === 'string' && SURFACE_NAME.test(named) && !RESERVED_SURFACES.has(named) ? named : 'console'
    const out: Record<string, string> = { ...extra, authorization: `Bearer ${upstream.secret}`, 'x-harness-surface': surface }
    const version = req.headers['x-harness-surface-version']
    if (typeof version === 'string') out['x-harness-surface-version'] = version
    if (typeof req.headers.accept === 'string' && out.accept === undefined) out.accept = req.headers.accept
    return out
  }

  private open(upstream: Upstream, op: string, init: { method?: string | undefined, headers: Record<string, string>, body?: string | undefined, signal?: AbortSignal | undefined }): Promise<IncomingMessage> {
    const target = new URL(upstream.url)
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest({
        host: target.hostname, port: Number(target.port || 80), method: init.method ?? 'GET',
        path: `/internal/harness/surface/${op}`, headers: init.headers, signal: init.signal,
      }, resolve)
      outgoing.on('error', reject)
      outgoing.end(init.body)
    })
  }

  /** Короткий вызов контейнера: ответ целиком не дольше `responseTimeoutMs`, иначе 504 `harness_timeout`. */
  private async call(upstream: Upstream, op: string, method: string | undefined, headers: Record<string, string>, body: string | undefined): Promise<{ status: number, headers: Record<string, string>, body: Buffer }> {
    const signal = AbortSignal.timeout(this.deps.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS)
    try {
      const reply = await this.open(upstream, op, { method, headers, body, signal })
      const chunks: Buffer[] = []
      for await (const chunk of reply as AsyncIterable<Buffer>) chunks.push(chunk)
      return { status: reply.statusCode ?? 502, headers: whitelisted(reply.headers), body: Buffer.concat(chunks) }
    } catch (error) {
      if (signal.aborted) throw new Refusal(504, 'harness_timeout', 'рабочее место не ответило вовремя')
      throw error
    }
  }

  /**
   * `GET …/surface/stream`: SSE без буферизации (события пересылаются целиком по
   * мере прихода). Контейнер поток не будит — см. шапку модуля.
   */
  private stream(req: IncomingMessage, res: ServerResponse, principalId: string, access: (status: number) => void): void {
    const query = new URL(req.url ?? '/', 'http://launcher').searchParams
    const header = req.headers['last-event-id']
    const given = [typeof header === 'string' ? header : null, query.get('after')]
    for (const cursor of given) {
      if (cursor !== null && !CURSOR.test(cursor)) throw new Refusal(400, 'invalid_cursor', 'Last-Event-ID и after — до 200 печатных символов')
    }
    const open = this.streams.get(principalId) ?? 0
    if (open >= MAX_STREAMS) throw new Refusal(429, 'too_many_streams', `не больше ${MAX_STREAMS} потоков на человека`)
    this.streams.set(principalId, open + 1)

    // Курсор, с которого подключаться к контейнеру: синтетический в контейнер не уходит.
    let cursor = given.find(c => c !== null && !synthetic(c)) ?? null
    let state: 'idle' | 'connecting' | 'live' | 'backoff' | 'sleeping' | 'waking' | 'closed' = 'idle'
    let upstreamAbort: AbortController | null = null
    let retry: NodeJS.Timeout | undefined
    let pending = ''
    // В журнал доступа — последний статус ответа контейнера (200 — пока подключения не было).
    let status = 200

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no',
      'x-harness-surface-version': SURFACE_VERSION,
    })
    res.flushHeaders()
    res.socket?.setNoDelay(true)

    const write = (text: string): void => { if (state !== 'closed' && !res.writableEnded && !res.destroyed) res.write(text) }
    const event = (type: 'sleeping' | 'waking'): void => {
      write(`event: ${type}\ndata: ${JSON.stringify({ type, cursor: cursor ?? `${SYNTHETIC_CURSOR}${type}.${Date.now()}`, at: new Date().toISOString() })}\n\n`)
    }
    const detach = (): void => {
      clearTimeout(retry)
      upstreamAbort?.abort()
      upstreamAbort = null
      pending = ''
    }
    const sleep = (): void => {
      detach()
      if (state === 'sleeping' || state === 'closed') return
      state = 'sleeping'
      event('sleeping')
    }
    const close = (): void => {
      if (state === 'closed') return
      detach()
      state = 'closed'
      clearInterval(ping)
      offStop()
      offWake()
      const left = (this.streams.get(principalId) ?? 1) - 1
      if (left > 0) this.streams.set(principalId, left)
      else this.streams.delete(principalId)
      if (!res.writableEnded) res.end()
      access(status)
    }
    /** Пересылать только целые события и запоминать их `id:` — курсор для переподключения. */
    const forward = (chunk: Buffer): void => {
      pending += chunk.toString('utf8')
      const end = Math.max(pending.lastIndexOf('\n\n') + 2, pending.lastIndexOf('\r\n\r\n') + 4)
      if (end < 2) return
      const complete = pending.slice(0, end)
      pending = pending.slice(end)
      for (const line of complete.split(/\r?\n/)) {
        if (line.startsWith('id:')) cursor = line.slice(3).replace(/^ /, '') || cursor
      }
      write(complete)
    }
    /** Потеря потока контейнера: спит — ждём пробуждения; бодр — закрываем, клиент переподключится без пробуждения. */
    const lost = (): void => {
      if (state === 'closed' || state === 'sleeping') return
      detach()
      void this.deps.fleet.awake(principalId).catch(() => false).then((awake) => {
        if (state === 'closed') return
        if (awake) close()
        else sleep()
      })
    }
    // Адрес без `ensure`: поток не будит и не ждёт старта, он подключается только к бодрому контейнеру.
    const connect = async (): Promise<void> => {
      if (state === 'closed') return
      state = 'connecting'
      const abort = new AbortController()
      upstreamAbort = abort
      try {
        const target = this.deps.fleet.upstream(principalId)
        const reply = await this.open(target, 'stream', {
          headers: this.headers(req, target, { accept: 'text/event-stream', ...(cursor !== null ? { 'last-event-id': cursor } : {}) }),
          signal: abort.signal,
        })
        if (abort.signal.aborted) { reply.destroy(); return }
        status = reply.statusCode ?? 502
        if (status === 429) {
          // Контейнер перегружен потоками — держим клиента и повторяем позже; не будим.
          reply.resume()
          upstreamAbort = null
          state = 'backoff'
          retry = setTimeout(() => {
            void this.deps.fleet.awake(principalId).catch(() => false).then((awake) => {
              if (state !== 'backoff') return
              if (awake) void connect()
              else sleep()
            })
          }, this.deps.streamRetryMs ?? STREAM_RETRY_MS)
          return
        }
        if (reply.statusCode !== 200) {
          reply.resume()
          write(`: harness ${reply.statusCode ?? 502}\n\n`)
          return close()
        }
        state = 'live'
        reply.on('data', forward)
        reply.on('end', () => { if (upstreamAbort === abort) lost() })
        reply.on('error', () => { if (upstreamAbort === abort) lost() })
      } catch {
        if (upstreamAbort === abort) lost()
      }
    }

    const ping = setInterval(() => { if (state !== 'live') write(': ping\n\n') }, PING_MS)
    const offStop = this.deps.fleet.onStop((id) => { if (id === principalId) sleep() })
    // Контейнер проснулся, пока поток ещё выяснял, бодр ли он (`state === 'idle'`):
    // событие уже прошло, ждать следующего нельзя.
    let wokeWhileIdle = false
    const offWake = this.deps.fleet.onWake((id, phase) => {
      if (id !== principalId || state === 'closed') return
      if (state === 'idle' && phase !== 'failed') { wokeWhileIdle = phase === 'ready'; return }
      if (phase === 'failed') return sleep()
      if (state !== 'sleeping' && state !== 'waking') return
      if (state === 'sleeping') { state = 'waking'; event('waking') }
      if (phase === 'ready') void connect()
    })
    res.on('close', close)
    // Запись в уже уничтоженный ответ не должна ронять процесс необработанным 'error'.
    res.on('error', close)

    // Поток не будит: спит — `sleeping` и ждём; бодр — сразу к потоку контейнера.
    void this.deps.fleet.awake(principalId).catch(() => false).then((awake) => {
      if (state !== 'idle') return
      if (awake || wokeWhileIdle) void connect()
      else sleep()
    })
  }
}
