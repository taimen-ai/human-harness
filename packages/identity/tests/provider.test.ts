import { describe, expect, it, vi } from 'vitest'
import { IdentityProvider } from '../src/index.ts'

const ISSUER = 'https://cp.example/iam'
const TENANT = 't-1'

function fetchStub(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

describe('IdentityProvider', () => {
  it('обменивает PAT и кэширует до порога обновления', async () => {
    let now = 1_000_000
    const doFetch = fetchStub(200, { accessToken: 'at-1', expiresIn: 600 })
    const provider = new IdentityProvider({
      iamUrl: ISSUER, tenantId: TENANT, refreshMarginSeconds: 60,
      audiences: { 'control-plane': ['control-plane:read'] },
      credentialsFile: '/dev/null',
    }, () => now, doFetch as unknown as typeof fetch)
    // Подменяем чтение PAT через переменные окружения процесса теста.
    process.env.IAM_PLATFORM_ACCESS_TOKEN = 'pat'
    process.env.IAM_CREDENTIAL_MODE = 'environment'
    try {
      expect(await provider.accessToken('control-plane')).toBe('at-1')
      expect(await provider.accessToken('control-plane')).toBe('at-1')
      expect(doFetch).toHaveBeenCalledTimes(1)
      const [, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit]
      expect(JSON.parse(String(init.body))).toEqual({ token: 'pat', audience: 'control-plane', scopes: ['control-plane:read'] })
      now += 550_000 // осталось 50 с < margin 60 с → обновление
      expect(await provider.accessToken('control-plane')).toBe('at-1')
      expect(doFetch).toHaveBeenCalledTimes(2)
    } finally {
      delete process.env.IAM_PLATFORM_ACCESS_TOKEN
      delete process.env.IAM_CREDENTIAL_MODE
    }
  })

  it('401 от IAM — iam_invalid_token', async () => {
    const provider = new IdentityProvider({
      iamUrl: ISSUER, tenantId: TENANT, refreshMarginSeconds: 60,
      audiences: { 'control-plane': [] }, credentialsFile: '/dev/null',
    }, () => 0, fetchStub(401, {}) as unknown as typeof fetch)
    process.env.IAM_PLATFORM_ACCESS_TOKEN = 'pat'
    process.env.IAM_CREDENTIAL_MODE = 'environment'
    try {
      await expect(provider.accessToken('control-plane')).rejects.toMatchObject({ code: 'iam_invalid_token' })
    } finally {
      delete process.env.IAM_PLATFORM_ACCESS_TOKEN
      delete process.env.IAM_CREDENTIAL_MODE
    }
  })
})
