import { describe, expect, it } from 'vitest'
import { IdentityError } from '../src/errors.ts'
import { resolvePlatformAccessToken } from '../src/pat-store.ts'

const ISSUER = 'https://cp.example/iam'
const TENANT = 't-1'

function store(document: Record<string, unknown>) {
  return (path: string) => (path === '/creds.json' ? JSON.stringify(document) : (() => { throw new Error('ENOENT') })())
}

describe('resolvePlatformAccessToken', () => {
  it('берёт единственную запись issuer|tenant', () => {
    const token = resolvePlatformAccessToken({
      issuer: `${ISSUER}/`, tenantId: TENANT, credentialsFile: '/creds.json', environ: {},
      readFile: store({ [`${ISSUER}|${TENANT}`]: { token: 'iam_pat_x' } }),
    })
    expect(token).toBe('iam_pat_x')
  })

  it('при нескольких записях без principal — ambiguous', () => {
    expect(() => resolvePlatformAccessToken({
      issuer: ISSUER, tenantId: TENANT, credentialsFile: '/creds.json', environ: {},
      readFile: store({
        [`${ISSUER}|${TENANT}|p1`]: { token: 'a' },
        [`${ISSUER}|${TENANT}|p2`]: { token: 'b' },
      }),
    })).toThrowError(expect.objectContaining({ code: 'iam_credential_ambiguous' }))
  })

  it('principal выбирает свою запись из нескольких', () => {
    const token = resolvePlatformAccessToken({
      issuer: ISSUER, tenantId: TENANT, principalId: 'p2', credentialsFile: '/creds.json', environ: {},
      readFile: store({
        [`${ISSUER}|${TENANT}|p1`]: { token: 'a' },
        [`${ISSUER}|${TENANT}|p2`]: { token: 'b' },
      }),
    })
    expect(token).toBe('b')
  })

  it('переменная окружения требует режима environment', () => {
    expect(() => resolvePlatformAccessToken({
      issuer: ISSUER, tenantId: TENANT, credentialsFile: '/creds.json',
      environ: { IAM_PLATFORM_ACCESS_TOKEN: 'env-pat' }, readFile: store({}),
    })).toThrowError(IdentityError)
    expect(resolvePlatformAccessToken({
      issuer: ISSUER, tenantId: TENANT, credentialsFile: '/creds.json',
      environ: { IAM_PLATFORM_ACCESS_TOKEN: 'env-pat', IAM_CREDENTIAL_MODE: 'environment' }, readFile: store({}),
    })).toBe('env-pat')
  })

  it('отсутствие файла — not_authenticated', () => {
    expect(() => resolvePlatformAccessToken({
      issuer: ISSUER, tenantId: TENANT, credentialsFile: '/missing.json', environ: {}, readFile: store({}),
    })).toThrowError(expect.objectContaining({ code: 'iam_not_authenticated' }))
  })
})
