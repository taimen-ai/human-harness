import { describe, expect, it, vi } from 'vitest'
import type { ControlPlaneClient } from '../src/client.ts'
import { delegationBody, review, runProgress } from '../src/delegation.ts'

const page = <T>(items: T[]) => ({ items, nextCursor: null })

describe('поручение', () => {
  it('задача с исполнителем, владельцем-поручившим, происхождением harness и приёмкой поручившим', () => {
    const body = delegationBody({ title: 'Проверить счёт', assigneeId: 'agent-1', workspaceId: 'ws' }, 'me', 's1')
    expect(body).toMatchObject({
      title: 'Проверить счёт', assigneeId: 'agent-1', ownerId: 'me', workspaceId: 'ws',
      origin: { kind: 'harness', ref: 'session:s1' },
      acceptance: [{ key: 'delegator-review', kind: 'human', spec: { approver: 'me' } }],
    })
  })

  it('без приёмки — без критерия human', () => {
    expect(delegationBody({ title: 'x', assigneeId: 'a', review: false }, 'me', null)).not.toHaveProperty('acceptance')
  })
})

function client(over: Partial<Record<keyof ControlPlaneClient, unknown>> = {}) {
  return {
    getTask: vi.fn(async () => ({ id: 't1', publicId: 'TASK-000001', title: 'Проверить счёт', status: 'in_review', systemStatusCategory: 'active', assigneeId: 'agent-1', verification: { status: 'waiting_human' } })),
    listRuns: vi.fn(async () => page([
      { id: 'r-old', status: 'failed', startedAt: '2026-09-26T08:00:00Z' },
      { id: 'r-new', status: 'succeeded', startedAt: '2026-09-26T09:00:00Z', finishedAt: '2026-09-26T09:10:00Z' },
    ])),
    listRunActions: vi.fn(async () => page(Array.from({ length: 20 }, (_, i) => ({ action: `tool.Read`, status: 'completed', startedAt: `2026-09-26T09:0${i % 10}:00Z`, createdAt: 'x', metadata: { summary: `шаг ${i}` } })))),
    listCheckpoints: vi.fn(async () => page([{ createdAt: 'c', kind: 'progress', data: { done: ['a'] } }])),
    listArtifacts: vi.fn(async () => page([{ id: 'art-1', type: 'report', name: 'итог', uri: null, createdAt: 'a', contentState: 'stored', mediaType: 'application/pdf', sizeBytes: 10 }])),
    listApprovals: vi.fn(async () => page([{ id: 'ap-plain', gate: false, createdAt: 'x' }, { id: 'ap-gate', gate: true, createdAt: '2026-09-26T09:11:00Z' }])),
    decideApproval: vi.fn(async (id: string, decision: string) => ({ id, status: decision === 'approve' ? 'approved' : 'rejected' })),
    ...over,
  } as unknown as ControlPlaneClient & Record<string, ReturnType<typeof vi.fn>>
}

describe('ход поручения', () => {
  it('последний прогон, хвост действий, checkpoints, артефакты и ожидающая приёмка', async () => {
    const c = client()
    const progress = await runProgress(c, 'TASK-000001')
    expect(progress.run?.id).toBe('r-new')
    expect(c.listRunActions).toHaveBeenCalledWith('r-new', { limit: 200 }, undefined)
    expect(progress.actions).toHaveLength(15)
    expect(progress.actions.at(-1)?.summary).toBe('шаг 19')
    expect(progress.artifacts[0]).toEqual({ id: 'art-1', type: 'report', name: 'итог', uri: null, contentState: 'stored', mediaType: 'application/pdf', sizeBytes: 10, createdAt: 'a' })
    expect(progress.pendingReview).toEqual({ approvalId: 'ap-gate', requestedAt: '2026-09-26T09:11:00Z' })
    expect(progress.verification).toEqual({ status: 'waiting_human' })
  })
})

describe('приёмка', () => {
  it('принять — approve gate-approval стадии проверки', async () => {
    const c = client()
    const result = await review(c, 'TASK-000001', 'accept', null)
    expect(c.decideApproval).toHaveBeenCalledWith('ap-gate', 'approve', null, undefined, undefined)
    expect(result).toMatchObject({ task: 'TASK-000001', approvalId: 'ap-gate', decision: 'accept' })
  })

  it('вернуть — только с замечанием, reject с ним', async () => {
    const c = client()
    await expect(review(c, 'TASK-000001', 'return', ' ')).rejects.toMatchObject({ code: 'comment_required' })
    await review(c, 'TASK-000001', 'return', 'добавь сверку с договором')
    expect(c.decideApproval).toHaveBeenCalledWith('ap-gate', 'reject', 'добавь сверку с договором', undefined, undefined)
  })

  it('нечего принимать — понятный отказ, без решения', async () => {
    const c = client({ listApprovals: vi.fn(async () => page([])) })
    await expect(review(c, 'TASK-000001', 'accept', null)).rejects.toMatchObject({ code: 'no_pending_review' })
    expect(c.decideApproval).not.toHaveBeenCalled()
  })
})
