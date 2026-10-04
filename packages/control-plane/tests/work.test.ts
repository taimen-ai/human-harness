import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ControlPlaneError, type ControlPlaneClient } from '../src/client.ts'
import { CLAIM_TTL_SECONDS, WorkState, WorkTracker } from '../src/work.ts'

const page = <T>(items: T[]) => ({ items, nextCursor: null })

function setup(session = 's1', over: Record<string, unknown> = {}) {
  const client = {
    getTask: vi.fn(async () => ({ id: 't1', publicId: 'TASK-000001', title: 'Подготовить акт' })),
    listRuns: vi.fn(async () => page([{ id: 'r-prev', status: 'failed', startedAt: '2026-09-26T08:00:00Z' }])),
    claimTask: vi.fn(async () => ({ id: 'c1', fencingToken: 3 })),
    startRun: vi.fn(async () => ({ id: 'r1', status: 'running', startedAt: '2026-09-26T09:00:00Z' })),
    runContext: vi.fn(async () => ({ instructions: { layers: [] } })),
    listCheckpoints: vi.fn(async () => page([{ kind: 'progress', data: { done: 'черновик' }, createdAt: 'x' }])),
    createCheckpoint: vi.fn(async (_run: string, body: unknown) => body),
    createArtifact: vi.fn(async (body: unknown) => body),
    uploadArtifactContent: vi.fn(async () => ({ contentRef: 'ac_1', sizeBytes: 2, mediaType: 'application/pdf', sha256: 'x' })),
    succeedRun: vi.fn(async () => ({ ok: true })),
    failRun: vi.fn(async () => ({ ok: true })),
    releaseClaim: vi.fn(async () => ({})),
    heartbeatClaim: vi.fn(async () => ({})),
    ...over,
  }
  const state = new WorkState(join(mkdtempSync(join(tmpdir(), 'work-')), 'work.json'))
  let current = session
  const tracker = new WorkTracker(client as unknown as ControlPlaneClient, state, async () => current, () => new Date('2026-09-26T09:00:00Z'))
  return { client, state, tracker, switchSession: (s: string) => { current = s } }
}

describe('исполнение работы человеком', () => {
  it('взять: claim и run под сессией харнесса, контекст и checkpoints прошлого прогона', async () => {
    const { client, tracker, state } = setup()
    const result = await tracker.take('TASK-000001', 'подготовлю акт')
    expect(client.claimTask).toHaveBeenCalledWith('TASK-000001', { sessionId: 's1', ttlSeconds: CLAIM_TTL_SECONDS, intent: 'подготовлю акт' }, undefined)
    expect(client.startRun).toHaveBeenCalledWith('TASK-000001', { claimId: 'c1', fencingToken: 3 }, undefined)
    expect(result.work).toMatchObject({ taskRef: 'TASK-000001', claimId: 'c1', runId: 'r1', sessionId: 's1' })
    expect(result.previous).toMatchObject({ runId: 'r-prev', status: 'failed', checkpoints: [{ kind: 'progress', data: { done: 'черновик' } }] })
    expect(state.load()).toHaveLength(1)
  })

  it('повторное взятие той же задачи ничего не создаёт', async () => {
    const { client, tracker } = setup()
    await tracker.take('TASK-000001', null)
    await tracker.take('TASK-000001', null)
    expect(client.claimTask).toHaveBeenCalledTimes(1)
  })

  it('работа закрытой сессии не считается активной (после перезапуска берётся заново)', async () => {
    const { tracker, switchSession } = setup()
    await tracker.take('TASK-000001', null)
    switchSession('s2')
    expect(await tracker.active()).toEqual([])
    await expect(tracker.checkpoint('TASK-000001', 'progress', {})).rejects.toMatchObject({ code: 'work_not_taken' })
  })

  it('checkpoint и артефакт пишутся в run взятой работы; пустой артефакт отвергается', async () => {
    const { client, tracker } = setup()
    await tracker.take('TASK-000001', null)
    await tracker.checkpoint('TASK-000001', 'decision', { choice: 'шаблон Б' })
    expect(client.createCheckpoint).toHaveBeenCalledWith('r1', { kind: 'decision', data: { choice: 'шаблон Б' } }, undefined)
    await tracker.artifact('TASK-000001', { type: 'document', name: 'Акт', uri: 'https://sed.example/doc/1' })
    expect(client.createArtifact).toHaveBeenCalledWith({ type: 'document', name: 'Акт', task: 'TASK-000001', runId: 'r1', uri: 'https://sed.example/doc/1', metadata: {} }, undefined)
    await expect(tracker.artifact('TASK-000001', { type: 'x', name: 'y' })).rejects.toMatchObject({ code: 'artifact_empty' })
  })

  it('сдать — run succeeded с completeTask, работа забыта', async () => {
    const { client, tracker } = setup()
    await tracker.take('TASK-000001', null)
    await tracker.complete('TASK-000001', 'акт готов')
    expect(client.succeedRun).toHaveBeenCalledWith('r1', { output: { summary: 'акт готов' }, completeTask: true }, undefined)
    expect(await tracker.active()).toEqual([])
  })

  it('вернуть без результата — run failed и claim освобождён', async () => {
    const { client, tracker } = setup()
    await tracker.take('TASK-000001', null)
    await tracker.release('TASK-000001', 'нужны данные от бухгалтерии')
    expect(client.failRun).toHaveBeenCalledWith('r1', { failureReason: 'нужны данные от бухгалтерии' }, undefined)
    expect(client.releaseClaim).toHaveBeenCalledWith('c1', 'нужны данные от бухгалтерии', undefined)
    expect(await tracker.active()).toEqual([])
  })

  it('heartbeat продлевает claims и забывает потерянные', async () => {
    const { client, tracker } = setup('s1', { heartbeatClaim: vi.fn(async () => { throw new ControlPlaneError(409, 'stale_claim', 'gone') }) })
    await tracker.take('TASK-000001', null)
    await tracker.heartbeat()
    expect(client.heartbeatClaim).toHaveBeenCalledWith('c1', CLAIM_TTL_SECONDS, undefined)
    expect(await tracker.active()).toEqual([])
  })
})


describe('файл результатом работы (H008b)', () => {
  it('файл загружается в хранилище ядра, артефакт ссылается на загрузку', async () => {
    const { client, tracker } = setup()
    await tracker.take('TASK-000001', null)
    const data = new Uint8Array([80, 75])
    const artifact = await tracker.artifact('TASK-000001', { type: 'document', name: 'Акт', file: { name: 'akt.pdf', mediaType: 'application/pdf', data } })
    expect(client.uploadArtifactContent).toHaveBeenCalledWith(data, 'application/pdf', undefined)
    expect(artifact).toMatchObject({ type: 'document', name: 'Акт', task: 'TASK-000001', runId: 'r1', contentRef: 'ac_1' })
  })

  it('артефакт — что-то одно', async () => {
    const { tracker } = setup()
    await tracker.take('TASK-000001', null)
    await expect(tracker.artifact('TASK-000001', { type: 'document', name: 'x', uri: 'https://x', file: { name: 'a', mediaType: 'text/plain', data: new Uint8Array() } })).rejects.toMatchObject({ code: 'artifact_ambiguous' })
    await expect(tracker.artifact('TASK-000001', { type: 'document', name: 'x' })).rejects.toMatchObject({ code: 'artifact_empty' })
  })
})
