import { describe, expect, it, vi } from 'vitest'
import { ControlPlaneClient, ControlPlaneError } from '../src/client.ts'
import { ControlPlaneService } from '../src/service.ts'

const identity = () => ({ authorization: vi.fn(async () => 'Bearer t'), invalidate: vi.fn(), describe: () => ({ issuer: 'i', tenantId: 't', principalId: 'p' }) })

describe('«Важное» (me/attention)', () => {
  it('клиент передаёт scope workspace с потомками и кодирует itemKey в обратной связи', async () => {
    const urls: string[] = []
    const doFetch = vi.fn(async (url: URL | string, init?: RequestInit) => {
      urls.push(`${init?.method ?? 'GET'} ${String(url)}`)
      return new Response(JSON.stringify({ items: [], degraded: [], generatedAt: '2026-09-26T00:00:00Z' }), { status: 200 })
    })
    const client = new ControlPlaneClient({ serverUrl: 'https://cp.example', identity: identity(), fetch: doFetch as unknown as typeof fetch })
    await client.attention({ workspaceId: 'ws-1' })
    await client.attention({})
    await client.attentionFeedback('decision.approval@1:abc', { verdict: 'not_needed' })
    expect(urls[0]).toBe('GET https://cp.example/api/v1/me/attention?workspaceId=ws-1&includeDescendants=true')
    expect(urls[1]).toBe('GET https://cp.example/api/v1/me/attention')
    expect(urls[2]).toBe('POST https://cp.example/api/v1/me/attention/decision.approval%401%3Aabc:feedback')
  })

  function service(attention: () => Promise<unknown>) {
    const client = {
      serverUrl: 'https://cp.example',
      openSession: async () => ({ id: 's1', expiresAt: '2026-09-26T01:00:00Z' }),
      heartbeatSession: async () => ({ id: 's1', expiresAt: '2026-09-26T01:00:00Z' }),
      harnessContext: async () => ({ tenant: { id: 't', slug: 't', name: 'T' }, principal: { id: 'me', kind: 'human', displayName: 'Me', status: 'active' }, permissions: [] }),
      attention,
    } as unknown as ControlPlaneClient
    const state = { get: () => ({}), set: () => undefined }
    return new ControlPlaneService({
      client, identity: identity() as never, state: state as never, clientVersion: 't', sessionTtlSeconds: 300,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })
  }

  it('ядро без маршрута me/attention — пустое «Важное» с пометкой, а не ошибка окна', async () => {
    const list = await service(async () => { throw new ControlPlaneError(404, 'not_found', 'Not Found') }).attention()
    expect(list.items).toEqual([])
    expect(list.degraded[0]).toMatchObject({ rule: 'me/attention', reasonCode: 'endpoint_missing' })
  })

  it('прочие ошибки ядра не маскируются', async () => {
    await expect(service(async () => { throw new ControlPlaneError(403, 'permission_denied', 'no') }).attention()).rejects.toMatchObject({ status: 403 })
  })
})
