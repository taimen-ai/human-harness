import { describe, expect, it, vi } from 'vitest'
import { ControlPlaneError, type ControlPlaneClient } from '../src/client.ts'
import { PrincipalNames } from '../src/names.ts'
import { failureOf, processInstance, taskIdsIn } from '../src/processes.ts'
import type { ProcessJournalEntry } from '../src/shared/types.ts'

const page = <T>(items: T[], nextCursor: string | null = null) => ({ items, nextCursor })
const forbidden = (permission: string) => new ControlPlaneError(403, 'forbidden', 'Permission denied', { required: [permission] })

const CODER = 'a0000000-0000-4000-8000-000000000001'
const HUMAN = 'a0000000-0000-4000-8000-000000000002'
const INSTANCE = 'b0000000-0000-4000-8000-000000000001'

const entry = (seq: number, kind: string, element: string | null, data: Record<string, unknown>, actorId: string | null = null): ProcessJournalEntry =>
  ({ seq, at: `2026-09-30T10:0${seq}:00Z`, kind, element, reason: `${String(data.decision ?? kind)}`, actorId, eventId: null, data })

const JOURNAL: ProcessJournalEntry[] = [
  entry(1, 'input', null, { input: { kind: 'event' } }, HUMAN),
  entry(1, 'transition', 'register', { decision: 'step_completed', createdTaskId: 't-review' }),
  entry(2, 'input', null, { input: { kind: 'skill' } }, CODER),
  entry(2, 'error', 'pay', { decision: 'error_raised', error: { type: 'skill_failed', status: 502, detail: 'bank gateway timeout' } }),
  entry(2, 'error', null, { decision: 'failed', error: { type: 'skill_failed', status: 502, detail: 'bank gateway timeout' } }),
]

/** Журнал ядра: фильтр `kind`, страницы по `limit`, курсор — позиция следующей записи. */
function journalApi(entries: ProcessJournalEntry[]) {
  return vi.fn(async (_id: string, query: { kind?: string, limit?: number, cursor?: string | null }) => {
    const selected = query.kind ? entries.filter(e => e.kind === query.kind) : entries
    const from = query.cursor ? Number(query.cursor) : 0
    const to = from + (query.limit ?? 50)
    return page(selected.slice(from, to), to < selected.length ? String(to) : null)
  })
}

const task = (id: string, publicId: string, assigneeId: string | null) =>
  ({ id, publicId, title: `Задача ${publicId}`, status: 'todo', systemStatusCategory: 'todo', assigneeId })

function client(over: Partial<Record<keyof ControlPlaneClient, unknown>> = {}) {
  return {
    getProcessInstance: vi.fn(async () => ({
      id: INSTANCE, definitionKey: 'bill-payment', definitionVersion: 3, instanceKey: 'INV-1', status: 'failed', outcome: null,
      workspaceId: 'ws-1', data: { amount: 100 }, stages: [], openElements: [], timers: [],
      startedAt: '2026-09-30T10:00:00Z', updatedAt: '2026-09-30T10:02:00Z', completedAt: '2026-09-30T10:02:00Z',
    })),
    processJournal: journalApi(JOURNAL),
    getProcessDefinition: vi.fn(async () => ({ key: 'bill-payment', version: 3, displayName: 'Оплата счёта' })),
    getTask: vi.fn(async (id: string) => {
      if (id === 't-review') return task('t-review', 'TASK-000010', HUMAN)
      throw new ControlPlaneError(404, 'not_found', 'Task not found')
    }),
    listTasks: vi.fn(async () => page([task('t-review', 'TASK-000010', HUMAN), task('t-fix', 'TASK-000011', CODER)])),
    listAgents: vi.fn(async () => page([{ key: 'coder', displayName: 'coder', principalId: CODER, status: 'active', state: 'running' }])),
    listPrincipals: vi.fn(async () => page([
      { id: CODER, displayName: 'Coder principal', kind: 'agent', status: 'active' },
      { id: HUMAN, displayName: 'Анна Петрова', kind: 'human', status: 'active' },
    ])),
    ...over,
  } as unknown as ControlPlaneClient & Record<string, ReturnType<typeof vi.fn>>
}

describe('экземпляр процесса для ассистента', () => {
  it('упавший экземпляр: шаг и ошибка из журнала, ссылки на экземпляр, его задачи и задачу-исправление', async () => {
    const c = client()
    const view = await processInstance(c, new PrincipalNames(c), INSTANCE)

    // Два прохода: весь журнал (хвост) и записи-ошибки фильтром ядра.
    expect(c.processJournal).toHaveBeenCalledWith(INSTANCE, { limit: 200, cursor: null }, undefined)
    expect(c.processJournal).toHaveBeenCalledWith(INSTANCE, { kind: 'error', limit: 200, cursor: null }, undefined)
    expect(c.getProcessDefinition).toHaveBeenCalledWith('bill-payment@3', undefined)
    expect(view.url).toBe(`/console/processes/${INSTANCE}`)
    expect(view.instance).toMatchObject({ status: 'failed', instanceKey: 'INV-1', process: { key: 'bill-payment', version: 3, displayName: 'Оплата счёта' } })
    // Решение failed без шага — шаг берётся из поднятой ошибки.
    expect(view.failure).toMatchObject({ element: 'pay', error: { type: 'skill_failed', status: 502, detail: 'bank gateway timeout' }, seq: 2 })
    expect(view.errors).toHaveLength(2)
    expect(view.journalTotal).toBe(5)
    expect(view.tasks).toEqual([{ publicId: 'TASK-000010', title: 'Задача TASK-000010', status: 'todo', systemStatusCategory: 'todo', assignee: 'Анна Петрова', url: '/console/work/TASK-000010' }])
    // Поиск по полному id экземпляра; задача, заведённая самим экземпляром, в исправления не попадает.
    expect(c.listTasks).toHaveBeenCalledWith({ q: INSTANCE, limit: 20 }, undefined)
    expect(view.fixTasks.map(t => [t.publicId, t.assignee, t.url])).toEqual([['TASK-000011', 'coder', '/console/work/TASK-000011']])
    // Участники журнала названы по имени, агент — именем из реестра.
    expect(view.journal.filter(e => e.kind === 'input').map(e => e.actor)).toEqual(['Анна Петрова', 'coder'])
    expect(view.degraded).toEqual([])
  })

  it('идущий экземпляр: текущий шаг с его задачей, без падения', async () => {
    const c = client({
      getProcessInstance: vi.fn(async () => ({
        id: INSTANCE, definitionKey: 'bill-payment', definitionVersion: 3, instanceKey: 'INV-2', status: 'running', outcome: null, workspaceId: null,
        data: {}, stages: [], timers: [], openElements: [{ id: 'approve', kind: 'human', since: '2026-09-30T11:00:00Z', taskId: 't-review', approvalIds: [] }],
        startedAt: 'x', updatedAt: 'y', completedAt: null,
      })),
      processJournal: journalApi([JOURNAL[0]!]),
      listTasks: vi.fn(async () => page([])),
    })
    const view = await processInstance(c, new PrincipalNames(c), INSTANCE)
    expect(view.failure).toBeNull()
    expect(view.currentSteps).toEqual([{ element: 'approve', kind: 'human', since: '2026-09-30T11:00:00Z', task: expect.objectContaining({ publicId: 'TASK-000010', assignee: 'Анна Петрова' }), approvalIds: [] }])
    expect(view.fixTasks).toEqual([])
  })

  it('журнал длиннее тысячи записей: причина — решение failed в конце, хвост — последние 25', async () => {
    const long: ProcessJournalEntry[] = [
      entry(1, 'error', 'check', { decision: 'error_caught', error: { type: 'old_caught' } }),
      ...Array.from({ length: 1500 }, (_, i) => entry(2 + i, 'transition', 'loop', { decision: 'step_completed' })),
      entry(1502, 'error', 'pay', { decision: 'error_raised', error: { type: 'skill_failed', detail: 'bank gateway timeout' } }),
      entry(1502, 'error', null, { decision: 'failed', error: { type: 'skill_failed', detail: 'bank gateway timeout' } }),
    ]
    const c = client({ processJournal: journalApi(long), listTasks: vi.fn(async () => page([])) })
    const view = await processInstance(c, new PrincipalNames(c), INSTANCE)
    expect(view.failure).toMatchObject({ element: 'pay', error: { type: 'skill_failed', detail: 'bank gateway timeout' }, seq: 1502 })
    expect(view.errors.map(e => e.seq)).toEqual([1, 1502, 1502])
    expect(view.journalTotal).toBe(1503)
    expect(view.journalTruncated).toBe(false)
    expect(view.journal).toHaveLength(25)
    expect(view.journal.at(-1)).toMatchObject({ seq: 1502, kind: 'error' })
    expect(view.journal[0]!.seq).toBe(1479)
  })

  it('без права на справочник имён — id вместо имени и пометка, какого права не хватило', async () => {
    const c = client({
      listAgents: vi.fn(async () => { throw forbidden('agents.read') }),
      listPrincipals: vi.fn(async () => { throw forbidden('principals.read') }),
    })
    const view = await processInstance(c, new PrincipalNames(c), INSTANCE)
    expect(view.journal.find(e => e.kind === 'input')?.actor).toBe(HUMAN)
    expect(view.degraded).toEqual(['agents: 403 forbidden (agents.read)', 'principals: 403 forbidden (principals.read)'])
  })

  it('нет права processes.read — отказ ядра доходит до инструмента как есть', async () => {
    const c = client({ getProcessInstance: vi.fn(async () => { throw forbidden('processes.read') }) })
    await expect(processInstance(c, new PrincipalNames(c), INSTANCE)).rejects.toMatchObject({ status: 403, details: { required: ['processes.read'] } })
  })
})

describe('журнал экземпляра', () => {
  it('id задач на любой глубине до трёх, как на экране консоли', () => {
    expect([...taskIdsIn({ a: { taskId: 't1', b: { taskIds: ['t2', ''] } }, createdTaskId: 't3', deep: { x: { y: { z: { taskId: 'too-deep' } } } } })]).toEqual(['t1', 't2', 't3'])
  })

  it('упавший без решения failed — последняя поднятая ошибка; идущий без ошибок — null', () => {
    const raised = entry(4, 'error', 'check', { decision: 'error_raised', error: { type: 'x' } })
    expect(failureOf({ status: 'failed' }, [raised])).toMatchObject({ element: 'check', error: { type: 'x' } })
    expect(failureOf({ status: 'running' }, [JOURNAL[0]!])).toBeNull()
  })
})
