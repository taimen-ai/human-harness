/**
 * `@human-harness/dsh-identity` — сервис `ctx.harnessIdentity`: кто этот процесс в IAM
 * и как получить access token для сервисов платформы. PAT берётся из локального
 * хранилища IAM, обменивается по требованию и кэшируется до порога обновления
 * (см. `iam_client` control-plane). Секреты не попадают ни в конфигурацию, ни в
 * журнал: наружу отдаётся только принадлежность (issuer, tenant, principal).
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { exchangePlatformAccessToken } from './exchange.ts'
import { resolvePlatformAccessToken } from './pat-store.ts'

export { IdentityError, type IdentityErrorCode } from './errors.ts'
export { exchangePlatformAccessToken, type ExchangedToken, type ExchangeRequest } from './exchange.ts'
export {
  defaultCredentialsPath, ENV_MODE, ENV_PAT, ENV_PRINCIPAL, resolvePlatformAccessToken, type PatStoreOptions,
} from './pat-store.ts'

export const name = 'harness-identity'

export interface Config {
  /** Публичный issuer IAM, например `http://localhost/iam`. */
  iamUrl: string
  /** Tenant IAM (UUID). */
  tenantId: string
  /** IAM principal этого процесса; обязателен, если у tenant'а несколько записей. */
  principalId?: string
  /** Явный путь к файлу учётных данных IAM (иначе `$XDG_CONFIG_HOME/iam/credentials.json`). */
  credentialsFile?: string
  /** Audience → scopes, которые процесс вправе запрашивать. */
  audiences: Record<string, string[]>
  /** За сколько секунд до истечения обновлять токен. */
  refreshMarginSeconds: number
}

export const Config: Schema<Config> = Schema.object({
  iamUrl: Schema.string().required().description('Публичный issuer IAM'),
  tenantId: Schema.string().required().description('Tenant IAM (UUID)'),
  principalId: Schema.string().description('IAM principal процесса'),
  credentialsFile: Schema.string().description('Путь к credentials.json IAM'),
  audiences: Schema.dict(Schema.array(Schema.string()))
    .default({ 'control-plane': ['control-plane:read', 'control-plane:write'] })
    .description('Audience → scopes для обмена'),
  refreshMarginSeconds: Schema.number().default(60),
})

/** Описание identity без секретов — для журнала и tool-ответов. */
export interface IdentityDescription {
  readonly issuer: string
  readonly tenantId: string
  readonly principalId: string | undefined
  readonly audiences: readonly string[]
}

/** Наружная поверхность сервиса. */
export interface HarnessIdentity {
  /** Access token для audience; обменивается или берётся из кэша. */
  accessToken(audience: string, signal?: AbortSignal): Promise<string>
  /** Заголовок `Authorization` для audience. */
  authorization(audience: string, signal?: AbortSignal): Promise<string>
  /** Сбросить кэш audience (сервер ответил 401 — токен отозван раньше срока). */
  invalidate(audience: string): void
  describe(): IdentityDescription
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    harnessIdentity: HarnessIdentity
  }
}

interface CachedToken {
  token: string
  expiresAtMs: number
}

/** Реализация сервиса: чистый класс без наследования от cordis Service — в профиле dsh не должно быть второй копии cordis. */
export class IdentityProvider implements HarnessIdentity {
  private readonly cache = new Map<string, CachedToken>()
  private readonly inflight = new Map<string, Promise<string>>()

  constructor(
    private readonly config: Config,
    private readonly now: () => number = () => Date.now(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  describe(): IdentityDescription {
    return {
      issuer: this.config.iamUrl,
      tenantId: this.config.tenantId,
      principalId: this.config.principalId,
      audiences: Object.keys(this.config.audiences),
    }
  }

  invalidate(audience: string): void {
    this.cache.delete(audience)
  }

  async authorization(audience: string, signal?: AbortSignal): Promise<string> {
    return `Bearer ${await this.accessToken(audience, signal)}`
  }

  async accessToken(audience: string, signal?: AbortSignal): Promise<string> {
    const cached = this.cache.get(audience)
    if (cached !== undefined && this.now() + this.config.refreshMarginSeconds * 1000 < cached.expiresAtMs) {
      return cached.token
    }
    const pending = this.inflight.get(audience)
    if (pending !== undefined) return pending
    const promise = this.refresh(audience, signal).finally(() => this.inflight.delete(audience))
    this.inflight.set(audience, promise)
    return promise
  }

  private async refresh(audience: string, signal?: AbortSignal): Promise<string> {
    const scopes = this.config.audiences[audience]
    if (scopes === undefined) {
      throw new Error(`harness-identity: audience ${JSON.stringify(audience)} не объявлен в конфигурации`)
    }
    const pat = resolvePlatformAccessToken({
      issuer: this.config.iamUrl,
      tenantId: this.config.tenantId,
      principalId: this.config.principalId,
      credentialsFile: this.config.credentialsFile,
    })
    const exchanged = await exchangePlatformAccessToken({
      iamUrl: this.config.iamUrl,
      platformAccessToken: pat,
      audience,
      scopes,
      fetch: this.fetchImpl,
      signal,
    })
    this.cache.set(audience, { token: exchanged.accessToken, expiresAtMs: this.now() + exchanged.expiresIn * 1000 })
    return exchanged.accessToken
  }
}

/**
 * Плагин: публикует `ctx.harnessIdentity`. Проверяет наличие PAT при загрузке,
 * чтобы неправильная установка падала громко, а не при первом запросе модели.
 */
export function apply(ctx: Context, config: Config): void {
  const provider = new IdentityProvider(config)
  // Ранняя проверка: токен есть и однозначен. Сам обмен — лениво, по первому запросу.
  resolvePlatformAccessToken({
    issuer: config.iamUrl,
    tenantId: config.tenantId,
    principalId: config.principalId,
    credentialsFile: config.credentialsFile,
  })
  ctx.provide('harnessIdentity', provider)
  ctx.logger.info(
    `harness-identity: issuer ${config.iamUrl}, tenant ${config.tenantId}`
    + (config.principalId ? `, principal ${config.principalId}` : ''),
  )
}
