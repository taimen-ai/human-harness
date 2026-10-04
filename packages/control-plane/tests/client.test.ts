import { describe, expect, it, vi } from 'vitest'
import { ControlPlaneClient, ControlPlaneError } from '../src/client.ts'

function identity() {
  let n = 0
  return {
    authorization: vi.fn(async () => `Bearer tok-${++n}`),
    invalidate: vi.fn(),
  }
}

describe('ControlPlaneClient', () => {
  it('ставит bearer, Idempotency-Key и If-Match; при 401 сбрасывает токен и повторяет один раз', async () => {
    const calls: { url: string, init: RequestInit }[] = []
    const doFetch = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      if (calls.length === 1) return new Response('{}', { status: 401 })
      return new Response(JSON.stringify({ id: 'x', version: 2 }), { status: 200 })
    })
    const id = identity()
    const client = new ControlPlaneClient({ serverUrl: 'https://cp.example/', identity: id, fetch: doFetch as unknown as typeof fetch })
    const out = await client.updateTask('TASK-1', { status: 'done' }, 1)
    expect(out).toEqual({ id: 'x', version: 2 })
    expect(calls).toHaveLength(2)
    expect(id.invalidate).toHaveBeenCalledWith('control-plane')
    const headers = calls[1]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tok-2')
    expect(headers['if-match']).toBe('"1"')
    expect(headers['idempotency-key']).toMatch(/^[0-9a-f]{32}$/)
    expect(calls[1]!.url).toBe('https://cp.example/api/v1/tasks/TASK-1')
  })

  it('переводит конверт ошибки сервера в ControlPlaneError', async () => {
    const doFetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'task_claimed', message: 'claimed', details: { claimId: 'c' }, request_id: 'req-1' } }), { status: 409 }))
    const client = new ControlPlaneClient({ serverUrl: 'https://cp.example', identity: identity(), fetch: doFetch as unknown as typeof fetch })
    await expect(client.getTask('TASK-2')).rejects.toMatchObject({ status: 409, code: 'task_claimed', requestId: 'req-1' } satisfies Partial<ControlPlaneError>)
  })

  it('пропускает пустые query-параметры', async () => {
    const doFetch = vi.fn(async (url: URL | string) => new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200, headers: { 'x-url': String(url) } }))
    const client = new ControlPlaneClient({ serverUrl: 'https://cp.example', identity: identity(), fetch: doFetch as unknown as typeof fetch })
    await client.listTasks({ assigneeId: 'p', status: undefined, limit: 100, cursor: null })
    expect(String((doFetch.mock.calls[0] as unknown as [URL])[0])).toBe('https://cp.example/api/v1/tasks?assigneeId=p&limit=100')
  })
})
