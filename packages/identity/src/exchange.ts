/**
 * Обмен Platform Access Token на access token конкретного audience:
 * `POST {iam}/api/v1/platform-access-tokens:exchange` с телом
 * `{token, audience, scopes}` → `{accessToken, expiresIn}`.
 */
import { IdentityError } from './errors.ts'

export interface ExchangeRequest {
  readonly iamUrl: string
  readonly platformAccessToken: string
  readonly audience: string
  readonly scopes: readonly string[]
  readonly fetch?: typeof fetch
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number
}

export interface ExchangedToken {
  readonly accessToken: string
  /** Секунд до истечения, как ответил IAM. */
  readonly expiresIn: number
}

/** Выполнить обмен. Ошибки IAM переводятся в коды IdentityError. */
export async function exchangePlatformAccessToken(request: ExchangeRequest): Promise<ExchangedToken> {
  const doFetch = request.fetch ?? fetch
  const url = `${request.iamUrl.replace(/\/+$/, '')}/api/v1/platform-access-tokens:exchange`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 15_000)
  const onAbort = () => controller.abort()
  request.signal?.addEventListener('abort', onAbort, { once: true })
  let response: Response
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        token: request.platformAccessToken,
        audience: request.audience,
        scopes: [...request.scopes],
      }),
      signal: controller.signal,
    })
  } catch (error) {
    throw new IdentityError('iam_unreachable', `IAM недоступен: ${describe(error)}`, { cause: error })
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', onAbort)
  }

  if (response.status === 401) {
    throw new IdentityError('iam_invalid_token', 'IAM отверг Platform Access Token: он истёк или отозван')
  }
  if (response.status === 403) {
    throw new IdentityError('iam_audience_not_allowed', `токен не допущен к audience ${request.audience}`)
  }
  if (response.status >= 400) {
    throw new IdentityError('iam_exchange_failed', `IAM ответил ${response.status} на обмен`)
  }
  let payload: { accessToken?: unknown, expiresIn?: unknown }
  try {
    payload = await response.json() as typeof payload
  } catch (error) {
    throw new IdentityError('iam_exchange_malformed', 'IAM вернул не-JSON ответ на обмен', { cause: error })
  }
  const accessToken = typeof payload.accessToken === 'string' ? payload.accessToken : ''
  const expiresIn = typeof payload.expiresIn === 'number' ? payload.expiresIn : Number.NaN
  if (accessToken === '' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new IdentityError('iam_exchange_malformed', 'IAM вернул пустой или истёкший credential')
  }
  return { accessToken, expiresIn }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
