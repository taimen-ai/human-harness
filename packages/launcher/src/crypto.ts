/**
 * Подписи launcher'а:
 * - cookie сессии и PKCE — `base64url(json).base64url(hmac)`, со сроком;
 * - заголовок `X-Harness-Launcher` для контейнера — `v1.<ts>.<hmac(ts.principal)>`
 *   общим секретом контейнера (плагин харнесса проверяет его на `/_harness/enter`);
 * - проверка access token IAM (RS256) по JWKS — для служебного входа каналов.
 */
import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature, type JsonWebKey } from 'node:crypto'

export const LAUNCHER_HEADER = 'x-harness-launcher'

const b64 = (data: Buffer | string): string => Buffer.from(data).toString('base64url')

function hmac(secret: Buffer | string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url')
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/** Подписанное значение со сроком годности (мс эпохи). */
export function seal(secret: Buffer, value: Record<string, unknown>, expiresAt: number): string {
  const body = b64(JSON.stringify({ ...value, exp: expiresAt }))
  return `${body}.${hmac(secret, body)}`
}

export function unseal<T extends Record<string, unknown>>(secret: Buffer, token: string | undefined, now = Date.now()): T | null {
  if (token === undefined) return null
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  if (!safeEqual(token.slice(dot + 1), hmac(secret, body))) return null
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp?: number }
    if (typeof value.exp !== 'number' || value.exp <= now) return null
    return value
  } catch {
    return null
  }
}

/** Заголовок, которым launcher подтверждает контейнеру identity запроса. */
export function launcherHeader(secret: string, principalId: string, now = Date.now()): string {
  const ts = Math.floor(now / 1000)
  return `v1.${ts}.${hmac(secret, `${ts}.${principalId}`)}`
}

/** Проверка заголовка на стороне контейнера (зеркало плагина харнесса, для тестов). */
export function checkLauncherHeader(secret: string, principalId: string, header: string | undefined, now = Date.now(), skewSeconds = 60): boolean {
  const match = /^v1\.(\d+)\.([\w-]+)$/.exec(header ?? '')
  if (match === null) return false
  const ts = Number(match[1])
  if (Math.abs(Math.floor(now / 1000) - ts) > skewSeconds) return false
  return safeEqual(match[2]!, hmac(secret, `${ts}.${principalId}`))
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

export function cookie(name: string, value: string, options: { path: string, secure: boolean, maxAgeSeconds: number }): string {
  return [
    `${name}=${encodeURIComponent(value)}`, `Path=${options.path}`, 'HttpOnly', 'SameSite=Lax',
    ...(options.secure ? ['Secure'] : []), `Max-Age=${options.maxAgeSeconds}`,
  ].join('; ')
}

export interface IamClaims {
  iss: string
  sub: string
  /** IAM выпускает строкой; массив допускается на будущее (RFC 7519). */
  aud: string | string[]
  tenant_id: string
  scope: string[]
  exp: number
  nbf?: number
  principal_type?: string
}

/** JWKS IAM с кэшем; ключ ищется по `kid`, неизвестный `kid` перечитывает набор. */
export class Jwks {
  private keys = new Map<string, JsonWebKey>()
  private fetchedAt = 0

  constructor(private readonly url: string, private readonly fetchImpl: typeof fetch = fetch, private readonly ttlMs = 10 * 60_000) {}

  async key(kid: string): Promise<JsonWebKey | null> {
    if (!this.keys.has(kid) || Date.now() - this.fetchedAt > this.ttlMs) await this.refresh()
    return this.keys.get(kid) ?? null
  }

  private async refresh(): Promise<void> {
    const response = await this.fetchImpl(this.url)
    if (!response.ok) throw new Error(`JWKS ${this.url}: ${response.status}`)
    const body = await response.json() as { keys?: (JsonWebKey & { kid?: string })[] }
    this.keys = new Map((body.keys ?? []).filter(k => typeof k.kid === 'string').map(k => [k.kid!, k]))
    this.fetchedAt = Date.now()
  }
}

/**
 * Проверить access token IAM: подпись RS256, срок, issuer, audience, tenant и scope.
 * `scope: null` — scope здесь не сверяется, его проверяет вызывающий: так
 * отсутствие scope даёт 403, а не 401 (поверхность беседы). Параметр обязателен,
 * чтобы пропуск проверки был виден в месте вызова.
 */
export async function verifyIamToken(token: string, jwks: Jwks, expect: { issuer: string, audience: string, tenantId: string, scope: string | null }, now = Date.now()): Promise<IamClaims | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as { alg?: string, kid?: string }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null
    const jwk = await jwks.key(header.kid)
    if (jwk === null) return null
    const ok = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2]!, 'base64url'))
    if (!ok) return null
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as IamClaims
    const seconds = Math.floor(now / 1000)
    if (typeof claims.exp !== 'number' || claims.exp <= seconds) return null
    if (typeof claims.nbf === 'number' && claims.nbf > seconds + 30) return null
    const audience = Array.isArray(claims.aud) ? claims.aud.includes(expect.audience) : claims.aud === expect.audience
    if (claims.iss !== expect.issuer || !audience || claims.tenant_id !== expect.tenantId) return null
    if (!Array.isArray(claims.scope) || (expect.scope !== null && !claims.scope.includes(expect.scope))) return null
    return claims
  } catch {
    return null
  }
}
