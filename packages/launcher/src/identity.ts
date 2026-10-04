/**
 * Вход человека: OIDC Keycloak (Authorization Code + PKCE S256) → токен IdP →
 * IAM `federation:exchange` → IAM principal. Launcher не хранит токены: ему
 * нужен только principal, чтобы выбрать контейнер. Sweep читает статус principal
 * в IAM (bootstrap-токен — единственный путь IAM к статусу, см. отступление VI).
 */
import { createHash } from 'node:crypto'
import { randomToken } from './crypto.ts'

export interface OidcEndpoints {
  authorization_endpoint: string
  token_endpoint: string
  end_session_endpoint?: string
}

export interface PkceStart {
  url: string
  state: string
  verifier: string
}

export class Oidc {
  private endpoints: Promise<OidcEndpoints> | null = null

  constructor(
    private readonly issuer: string,
    private readonly clientId: string,
    private readonly scopes: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  discover(): Promise<OidcEndpoints> {
    this.endpoints ??= this.fetchImpl(`${this.issuer}/.well-known/openid-configuration`).then(async (r) => {
      if (!r.ok) throw new Error(`OIDC discovery ${this.issuer}: ${r.status}`)
      return await r.json() as OidcEndpoints
    }).catch((error: unknown) => { this.endpoints = null; throw error })
    return this.endpoints
  }

  async start(redirectUri: string): Promise<PkceStart> {
    const { authorization_endpoint } = await this.discover()
    const verifier = randomToken(48)
    const state = randomToken(16)
    const url = new URL(authorization_endpoint)
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: this.scopes,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString()
    return { url: url.toString(), state, verifier }
  }

  /** Код → access token IdP (его audience должен совпасть с настройкой IdP в IAM). */
  async exchange(code: string, verifier: string, redirectUri: string): Promise<string> {
    const { token_endpoint } = await this.discover()
    const response = await this.fetchImpl(token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, client_id: this.clientId }).toString(),
    })
    if (!response.ok) throw new Error(`OIDC token: ${response.status}`)
    const body = await response.json() as { access_token?: string }
    if (typeof body.access_token !== 'string') throw new Error('OIDC token: нет access_token')
    return body.access_token
  }
}

export type PrincipalStatus = 'active' | 'paused' | 'disabled' | 'gone'

export class Iam {
  constructor(
    private readonly url: string,
    private readonly tenantId: string,
    private readonly bootstrapToken: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Токен IdP → IAM principal (только человек; отключённый получает отказ IAM). */
  async federate(identityProvider: string, token: string, audience: string, scopes: string[]): Promise<{ principalId: string }> {
    const response = await this.fetchImpl(`${this.url}/api/v1/tenants/${this.tenantId}/federation:exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identityProvider, token, audience, scopes }),
    })
    const body = await response.json().catch(() => ({})) as { principalId?: string, error?: { code?: string } }
    if (!response.ok || typeof body.principalId !== 'string') {
      throw Object.assign(new Error(`IAM federation: ${response.status} ${body.error?.code ?? ''}`.trim()), { status: response.status, code: body.error?.code })
    }
    return { principalId: body.principalId }
  }

  /** Статус principal; `gone` — нет в tenant'е. null — статус узнать нельзя (нет bootstrap-токена или IAM недоступен). */
  async status(principalId: string): Promise<PrincipalStatus | null> {
    if (this.bootstrapToken === null) return null
    const response = await this.fetchImpl(`${this.url}/api/v1/tenants/${this.tenantId}/principals/${principalId}`, {
      headers: { 'x-iam-bootstrap-token': this.bootstrapToken },
    }).catch(() => null)
    if (response === null) return null
    if (response.status === 404) return 'gone'
    if (!response.ok) return null
    const body = await response.json() as { status?: string }
    return body.status === 'active' || body.status === 'paused' || body.status === 'disabled' ? body.status : null
  }
}
