import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ControlPlaneError, type ControlPlaneClient } from '../src/client.ts'
import { participants, PrincipalNames } from '../src/names.ts'
import type { ControlPlane } from '../src/service.ts'
import { registerTools } from '../src/tools.ts'

const page = <T>(items: T[], nextCursor: string | null = null) => ({ items, nextCursor })
const forbidden = (permission: string) => new ControlPlaneError(403, 'forbidden', 'Permission denied', { required: [permission] })

const CODER = 'a0000000-0000-4000-8000-000000000001'
const CODER2 = 'a0000000-0000-4000-8000-000000000003'
const HUMAN = 'a0000000-0000-4000-8000-000000000002'

function client(over: Partial<Record<keyof ControlPlaneClient, unknown>> = {}) {
  return {
    listAgents: vi.fn(async () => page([
      { key: 'coder', displayName: 'coder', principalId: CODER, status: 'active', state: 'running' },
      { key: 'coder-2', displayName: 'coder-2', principalId: CODER2, status: 'active', state: 'stopped' },
      { key: 'old', displayName: 'old', principalId: null, status: 'retired', state: 'stopped' },
    ])),
    listPrincipals: vi.fn(async () => page([
      { id: CODER, displayName: 'Autonomous Runner', kind: 'agent', status: 'active' },
      { id: HUMAN, displayName: 'Анна Петрова', kind: 'human', status: 'active' },
    ])),
    ...over,
  } as unknown as ControlPlaneClient & Record<string, ReturnType<typeof vi.fn>>
}

describe('имена участников', () => {
  it('агент — именем из реестра, человек — из principals, неизвестный — без имени', async () => {
    const names = new PrincipalNames(client())
    expect(await names.name(CODER)).toEqual({ id: CODER, name: 'coder', kind: 'agent', agentKey: 'coder' })
    expect(await names.name(HUMAN)).toEqual({ id: HUMAN, name: 'Анна Петрова', kind: 'human' })
    expect(await names.name('zzz')).toEqual({ id: 'zzz', name: null, kind: null })
    expect(await names.name(null)).toBeNull()
  })

  it('справочник кэшируется: повторные имена без новых запросов в ядро', async () => {
    let now = 0
    const c = client()
    const names = new PrincipalNames(c, () => now)
    await Promise.all([names.name(CODER), names.name(HUMAN)])
    await names.name(CODER2)
    expect(c.listAgents).toHaveBeenCalledTimes(1)
    now = 6 * 60_000
    await names.name(CODER)
    expect(c.listAgents).toHaveBeenCalledTimes(2)
  })

  it('агенты для поручения — активные из реестра, с ключом и ссылкой на экран агента', async () => {
    const directory = await new PrincipalNames(client()).directory()
    expect(participants(directory, 'agent')).toEqual([
      { id: CODER, displayName: 'coder', kind: 'agent', key: 'coder', status: 'active', state: 'running', url: '/console/agents/coder' },
      { id: CODER2, displayName: 'coder-2', kind: 'agent', key: 'coder-2', status: 'active', state: 'stopped', url: '/console/agents/coder-2' },
    ])
    expect(participants(directory, 'human')?.map(p => p.displayName)).toEqual(['Анна Петрова'])
  })

  it('без agents.read — агенты из principals; без обоих прав — null и пометки', async () => {
    const noRegistry = await new PrincipalNames(client({ listAgents: vi.fn(async () => { throw forbidden('agents.read') }) })).directory()
    expect(participants(noRegistry, 'agent')?.map(p => [p.id, p.displayName])).toEqual([[CODER, 'Autonomous Runner']])
    expect(noRegistry.degraded).toEqual(['agents: 403 forbidden (agents.read)'])

    const none = await new PrincipalNames(client({
      listAgents: vi.fn(async () => { throw forbidden('agents.read') }),
      listPrincipals: vi.fn(async () => { throw forbidden('principals.read') }),
    })).directory()
    expect(participants(none, 'agent')).toBeNull()
    expect(none.byId.size).toBe(0)
  })

  it('прерванный первый вызов не роняет параллельный: загрузка идёт не под его сигналом', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const c = client()
    const listAgents = c.listAgents as ReturnType<typeof vi.fn>
    listAgents.mockImplementationOnce(async (_q: unknown, signal: AbortSignal) => {
      await gate
      expect(signal.aborted).toBe(false)
      return page([{ key: 'coder', displayName: 'coder', principalId: CODER, status: 'active', state: 'running' }])
    })
    const names = new PrincipalNames(c)
    const aborted = new AbortController()
    const first = names.directory(aborted.signal)
    const second = names.directory()
    aborted.abort(new Error('человек ушёл'))
    await expect(first).rejects.toThrow('человек ушёл')
    release()
    expect((await second).byId.get(CODER)?.name).toBe('coder')
    expect(listAgents).toHaveBeenCalledTimes(1)
  })

  it('неудача загрузки помнится 30 с: цикл по именам не грузит справочник заново', async () => {
    let now = 0
    const listPrincipals = vi.fn(async () => { throw new ControlPlaneError(503, 'unavailable', 'down') })
    const c = client({ listPrincipals })
    const names = new PrincipalNames(c, () => now)
    for (let i = 0; i < 25; i++) expect(await names.name(CODER).catch(() => null)).toBeNull()
    expect(listPrincipals).toHaveBeenCalledTimes(1)
    now = 31_000
    await names.name(CODER).catch(() => null)
    expect(listPrincipals).toHaveBeenCalledTimes(2)
  })

  it('ошибка не по праву — не деградация, а ошибка', async () => {
    const names = new PrincipalNames(client({ listPrincipals: vi.fn(async () => { throw new ControlPlaneError(500, 'internal', 'boom') }) }))
    await expect(names.directory()).rejects.toMatchObject({ status: 500 })
  })
})

/** Инструменты `cp_*` на заглушке ctx: реестр инструментов и сервис Control Plane. */
function harness(c: ControlPlaneClient) {
  const tools = new Map<string, ToolDefinition>()
  const ctx = { tools: { register: (d: ToolDefinition) => { tools.set(d.name, d); return () => tools.delete(d.name) } }, get: () => undefined } as unknown as Context
  const cp = { client: c, scope: async () => ({ workspaceId: 'ws-1', slug: null, name: null, workspaceIds: ['ws-1'] }) } as unknown as ControlPlane
  registerTools(ctx, cp, { confirmMutations: true })
  const run = (name: string, args: Record<string, unknown> = {}) =>
    tools.get(name)!.execute(args as never, { name, callId: 'c1', signal: new AbortController().signal } as never)
  return { tools, run }
}

describe('инструменты имён и участников', () => {
  it('cp_agents — имена и ключи реестра', async () => {
    const { run } = harness(client())
    const result = await run('cp_agents') as { items: { displayName: string, key: string }[] }
    expect(result.items.map(a => a.key)).toEqual(['coder', 'coder-2'])
  })

  it('cp_agents без прав на оба источника — понятный отказ с нужными правами', async () => {
    const { run } = harness(client({
      listAgents: vi.fn(async () => { throw forbidden('agents.read') }),
      listPrincipals: vi.fn(async () => { throw forbidden('principals.read') }),
    }))
    await expect(run('cp_agents')).rejects.toThrow(/agents\.read или principals\.read/)
  })

  it('cp_workspace_members — участники по /participants: держатель роли без членства в выдаче, роли без повторов', async () => {
    // Ядро отдаёт роль, если она принадлежит ws-1 (назначение здесь, в предке или на
    // весь tenant) или назначена в самом ws-1; роль ws-1, назначенная на двух уровнях, приходит дважды.
    const ROLE_WS = { roleId: 'r-acc', slug: 'accounting', name: 'Бухгалтерия', roleWorkspaceId: 'ws-1', assignmentWorkspaceId: 'ws-1' }
    const ROLE_WS_TENANT = { roleId: 'r-fin', slug: 'finance-director', name: 'Финансовый директор', roleWorkspaceId: 'ws-1', assignmentWorkspaceId: null }
    const ROLE_WS_ANCESTOR = { roleId: 'r-fin', slug: 'finance-director', name: 'Финансовый директор', roleWorkspaceId: 'ws-1', assignmentWorkspaceId: 'ws-root' }
    const TENANT_ROLE_HERE = { roleId: 'r-audit', slug: 'auditor', name: 'Аудитор', roleWorkspaceId: null, assignmentWorkspaceId: 'ws-1' }
    const listWorkspaceParticipants = vi.fn(async () => page([
      { principalId: HUMAN, kind: 'human', displayName: 'Анна Петрова', status: 'active', member: false, roles: [ROLE_WS, ROLE_WS_TENANT, ROLE_WS_ANCESTOR, TENANT_ROLE_HERE] },
      { principalId: CODER, kind: 'agent', displayName: 'Autonomous Runner', status: 'active', member: true, roles: [] },
      { principalId: 'p-unknown', kind: 'human', displayName: 'Борис Иванов', status: 'active', member: false, roles: [ROLE_WS, ROLE_WS] },
    ]))
    const listWorkspaceMembers = vi.fn(async () => page([]))
    const { run } = harness(client({ listWorkspaceParticipants, listWorkspaceMembers }))
    const result = await run('cp_workspace_members') as {
      workspaceId: string
      items: { principalId: string, name: string, kind: string, agentKey: string | null, member: boolean, roles: { roleId: string, slug: string }[] }[]
      degraded: string[]
    }
    expect(listWorkspaceParticipants).toHaveBeenCalledWith('ws-1', { limit: 200, cursor: null }, expect.anything())
    expect(listWorkspaceMembers).not.toHaveBeenCalled()
    expect(result.workspaceId).toBe('ws-1')
    expect(result.degraded).toEqual([])
    expect(result.items.map(p => [p.name, p.kind, p.agentKey, p.member])).toEqual([
      ['Анна Петрова', 'human', null, false],
      ['coder', 'agent', 'coder', true],
      ['Борис Иванов', 'human', null, false],
    ])
    expect(result.items[0]!.roles).toEqual([ROLE_WS, ROLE_WS_TENANT, TENANT_ROLE_HERE])
    expect(result.items[1]!.roles).toEqual([])
    expect(result.items[2]!.roles.map(r => r.slug)).toEqual(['accounting'])
  })

  it('cp_workspace_members листает страницы участников по курсору', async () => {
    const listWorkspaceParticipants = vi.fn()
      .mockResolvedValueOnce(page([{ principalId: HUMAN, kind: 'human', displayName: 'Анна Петрова', status: 'active', member: true, roles: [] }], 'c2'))
      .mockResolvedValueOnce(page([{ principalId: CODER, kind: 'agent', displayName: 'coder', status: 'active', member: false, roles: [] }]))
    const { run } = harness(client({ listWorkspaceParticipants }))
    const result = await run('cp_workspace_members', { workspaceId: 'ws-2' }) as { items: { principalId: string }[], truncated: boolean }
    expect(listWorkspaceParticipants).toHaveBeenNthCalledWith(2, 'ws-2', { limit: 200, cursor: 'c2' }, expect.anything())
    expect(result.items.map(p => p.principalId)).toEqual([HUMAN, CODER])
    expect(result.truncated).toBe(false)
  })

  it.each([
    [403, forbidden('org.read'), 'participants: 403 (org.read, principals.read)'],
    [404, new ControlPlaneError(404, 'not_found', 'Not Found'), 'participants: 404 (ядро без /participants)'],
  ])('cp_workspace_members: /participants ответил %i — явные члены из /members и пометка в degraded', async (_status, error, mark) => {
    const listWorkspaceParticipants = vi.fn(async () => { throw error })
    const listWorkspaceMembers = vi.fn(async () => page([
      { id: 'm1', workspaceId: 'ws-1', principalId: HUMAN, createdAt: '2026-09-01T00:00:00Z' },
      { id: 'm2', workspaceId: 'ws-1', principalId: CODER, createdAt: '2026-09-02T00:00:00Z' },
    ]))
    const { run } = harness(client({ listWorkspaceParticipants, listWorkspaceMembers }))
    const result = await run('cp_workspace_members') as {
      items: { name: string, kind: string | null, agentKey: string | null, member: boolean, roles: unknown }[]
      degraded: string[]
    }
    expect(listWorkspaceMembers).toHaveBeenCalledWith('ws-1', { limit: 200, cursor: null }, expect.anything())
    expect(result.items.map(p => [p.name, p.kind, p.agentKey, p.member, p.roles])).toEqual([
      ['Анна Петрова', 'human', null, true, null],
      ['coder', 'agent', 'coder', true, null],
    ])
    expect(result.degraded).toEqual([mark])
  })

  it('cp_workspace_members: ошибка /participants не по праву — отказ, без отката на /members', async () => {
    const listWorkspaceMembers = vi.fn(async () => page([]))
    const { run } = harness(client({
      listWorkspaceParticipants: vi.fn(async () => { throw new ControlPlaneError(500, 'internal', 'boom') }),
      listWorkspaceMembers,
    }))
    await expect(run('cp_workspace_members')).rejects.toThrow(/500 internal/)
    expect(listWorkspaceMembers).not.toHaveBeenCalled()
  })

  it('cp_get_task — имена исполнителя и владельца, ссылка на задачу', async () => {
    const { run } = harness(client({
      getTask: vi.fn(async () => ({ id: 't1', publicId: 'TASK-000001', title: 'x', assigneeId: CODER2, ownerId: HUMAN })),
      getTaskTransitions: vi.fn(async () => []),
      listArtifacts: vi.fn(async () => page([])),
    }))
    expect(await run('cp_get_task', { ref: 'TASK-000001' })).toMatchObject({ assignee: 'coder-2', owner: 'Анна Петрова', url: '/console/work/TASK-000001' })
  })

  it('отказ ядра по праву называет нужное право', async () => {
    const { tools, run } = harness(client({ getProcessInstance: vi.fn(async () => { throw forbidden('processes.read') }) }))
    expect(tools.has('cp_process_instance') && tools.has('cp_find_process_instances')).toBe(true)
    await expect(run('cp_process_instance', { instanceId: 'x' })).rejects.toThrow(/403 forbidden: Permission denied \(нужно право: processes\.read\)/)
  })
})
