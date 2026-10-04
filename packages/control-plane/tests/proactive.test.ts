import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ControlPlaneError, type ControlPlaneClient } from '../src/client.ts'
import { evaluate, eventTypesOf, parseRules, RuleError, type EvaluateDeps, type TaskFacts } from '../src/attention-rules.ts'
import { CursorFile, EventConsumer, type JournalEvent } from '../src/events.ts'
import { PLATFORM_EVENT_SOURCE, Proactive, ProactiveStateFile } from '../src/proactive.ts'
import { loadRules } from '../src/proactivity.ts'
import { ChangeSignal } from '../src/signal.ts'

const ME = 'me-0000'
const AGENT = 'agent-01'
const NOW = Date.parse('2026-09-26T12:00:00Z')
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined }
const dir = () => mkdtempSync(join(tmpdir(), 'proactive-'))

let seq = 0
function ev(type: string, over: Partial<JournalEvent> = {}): JournalEvent {
  seq += 1
  return {
    id: `e${seq}`, type, entityType: 'run', entityId: `x${seq}`, actorId: AGENT, payload: { taskId: 't1' },
    occurredAt: new Date(NOW - 1000).toISOString(), cursor: `c${seq}`, ...over,
  }
}

const tasks: Record<string, TaskFacts> = {
  t1: { id: 't1', publicId: 'TASK-000001', title: 'Сверить акты', assigneeId: AGENT, createdBy: ME, ownerId: null },
  t2: { id: 't2', publicId: 'TASK-000002', title: 'Чужая задача', assigneeId: AGENT, createdBy: 'someone', ownerId: null },
}
const deps: EvaluateDeps = { me: { principalId: ME, roleIds: ['role-fin'] }, task: async id => tasks[id] ?? null }

describe('правила значимости', () => {
  const rules = loadRules()

  it('файл правил пакета проходит проверку и даёт фильтр типов', () => {
    expect(rules.rules.length).toBeGreaterThan(3)
    expect(eventTypesOf(rules)).toContain('approval.requested')
    expect(eventTypesOf(rules)).toContain('run.succeeded')
  })

  it('ошибка в правиле называет правило и поле', () => {
    expect(() => parseRules({ version: 1, rules: [{ key: 'x', version: 1, on: ['run.succeeded'], concerns: 'mine', significance: 'now', message: 'm', action: 'a' }] }))
      .toThrow(RuleError)
    expect(() => parseRules({ version: 1, rules: [{ key: 'x', version: 1, on: ['run.succeeded'], concerns: 'any', significance: 'now', message: 'm', action: 'a', extra: 1 }] }))
      .toThrow(/неизвестное поле extra/)
  })

  it('завершение поручения агентом касается того, кто поручил', async () => {
    const match = await evaluate(rules, ev('run.succeeded'), deps)
    expect(match).toMatchObject({ rule: 'delegation.run-succeeded@1', significance: 'now', ref: 'TASK-000001' })
    expect(match?.message).toContain('Сверить акты')
  })

  it('чужое поручение и собственные действия человека не касаются', async () => {
    expect(await evaluate(rules, ev('run.succeeded', { payload: { taskId: 't2' } }), deps)).toBeNull()
    expect(await evaluate(rules, ev('run.succeeded', { actorId: ME }), deps)).toBeNull()
  })

  it('согласование по роли человека — значимо; по чужой роли — нет', async () => {
    const mine = ev('approval.requested', { entityType: 'approval', payload: { taskId: 't2', requiredRoleId: 'role-fin', taskPublicId: 'TASK-000002', taskTitle: 'Чужая задача' } })
    expect(await evaluate(rules, mine, deps)).toMatchObject({ rule: 'approval.requested.mine@1', ref: 'TASK-000002' })
    const other = ev('approval.requested', { entityType: 'approval', payload: { taskId: 't2', requiredRoleId: 'role-ops' } })
    expect(await evaluate(rules, other, deps)).toBeNull()
  })

  it('назначение задачи человеку — условие when с $me', async () => {
    const assigned = ev('task.updated', { entityType: 'task', entityId: 't2', actorId: 'boss', payload: { publicId: 'TASK-000002', changes: { assignee_id: ME } } })
    expect(await evaluate(rules, assigned, deps)).toMatchObject({ rule: 'task.assigned-to-me@1' })
    const other = ev('task.updated', { entityType: 'task', entityId: 't2', actorId: 'boss', payload: { changes: { assignee_id: AGENT } } })
    expect(await evaluate(rules, other, deps)).toBeNull()
  })
})

function pagedClient(pages: JournalEvent[][], extra: Record<string, unknown> = {}) {
  const all = pages.flat()
  const listEvents = vi.fn(async (query: { cursor?: string | null, tail?: number }) => {
    if (query.tail !== undefined) return { items: [], nextCursor: 'c-tail', hasMore: false }
    const start = query.cursor ? all.findIndex(e => e.cursor === query.cursor) + 1 : 0
    const size = pages[0]?.length ?? 1
    const items = all.slice(start, start + size)
    const last = items.at(-1)
    return { items, nextCursor: last ? last.cursor : (query.cursor ?? 'c0'), hasMore: start + size < all.length }
  })
  return { listEvents, eventsSocketUrl: () => 'ws://x', authorization: async () => 'Bearer t', invalidateToken: () => undefined, ...extra }
}

function consumer(client: object, store: CursorFile, handler: (e: JournalEvent) => Promise<void>, start: 'latest' | 'earliest' = 'earliest') {
  return new EventConsumer({ client: client as unknown as ControlPlaneClient, types: ['run.'], store, handler, start, socketFactory: null, log: quiet, retryInitialMs: 5, now: () => NOW })
}

describe('потребитель событий (CP-ADR-0069)', () => {
  it('падение посреди страницы: после перезапуска ни потерь, ни повторов', async () => {
    const events = [ev('run.succeeded'), ev('run.succeeded'), ev('run.succeeded'), ev('run.succeeded')]
    const client = pagedClient([events.slice(0, 2), events.slice(2)])
    const store = new CursorFile(join(dir(), 'cursor.json'))
    const seen: string[] = []
    let failOn: string | null = events[1]!.id
    const handler = async (e: JournalEvent) => {
      if (e.id === failOn) throw new Error('обработчик упал')
      seen.push(e.id)
    }
    const first = consumer(client, store, handler)
    first.start(); await first.idle(); await first.stop()
    expect(seen).toEqual([events[0]!.id])
    failOn = null
    const second = consumer(client, new CursorFile(store['path' as never] as string), handler)
    second.start(); await second.idle(); await second.stop()
    expect(seen).toEqual(events.map(e => e.id))
  })

  it('повтор события с тем же id не обрабатывается дважды', async () => {
    const e = ev('run.succeeded')
    const replay = { ...e, cursor: 'c-replay' }
    const client = pagedClient([[e, replay]])
    const handler = vi.fn(async () => undefined)
    const c = consumer(client, new CursorFile(join(dir(), 'cursor.json')), handler)
    c.start(); await c.idle(); await c.stop()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('первый запуск без курсора начинает после последнего события', async () => {
    const client = pagedClient([[ev('run.succeeded')]])
    const store = new CursorFile(join(dir(), 'cursor.json'))
    const handler = vi.fn(async () => undefined)
    const c = consumer(client, store, handler, 'latest')
    c.start(); await c.idle(); await c.stop()
    expect(handler).not.toHaveBeenCalled()
    expect(store.load().cursor).toBe('c-tail')
  })

  it('отказ в подписке останавливает потребителя', async () => {
    const client = pagedClient([], { listEvents: vi.fn(async () => { throw new ControlPlaneError(403, 'forbidden', 'нет events.read') }) })
    const c = consumer(client, new CursorFile(join(dir(), 'cursor.json')), async () => undefined)
    c.start(); await c.idle()
    expect(c.running).toBe(false)
    expect(client.listEvents).toHaveBeenCalledTimes(1)
  })

  it('кадр WebSocket только будит чтение', async () => {
    const e = ev('run.succeeded')
    const client = pagedClient([[e]])
    let socket: { onmessage: ((x: unknown) => void) | null } = { onmessage: null }
    const handler = vi.fn(async () => undefined)
    const c = new EventConsumer({
      client: client as unknown as ControlPlaneClient, types: ['run.'], store: new CursorFile(join(dir(), 'cursor.json')), handler, start: 'earliest',
      socketFactory: () => (socket = { onmessage: null, onclose: null, onerror: null, close: () => undefined } as never), log: quiet, pollIntervalMs: 3_600_000,
    })
    c.start(); await c.idle()
    await vi.waitFor(() => expect(socket.onmessage).not.toBeNull())
    await c.idle()
    const before = client.listEvents.mock.calls.length
    socket.onmessage?.({ data: JSON.stringify({ id: 'kadr' }) })
    await c.idle(); await c.stop()
    expect(client.listEvents.mock.calls.length).toBeGreaterThan(before)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

function proactive(over: { now?: () => number } = {}) {
  const deliveries: { text: string, kind: string }[] = []
  const signal = new ChangeSignal()
  const p = new Proactive({
    rules: loadRules(),
    deps: async () => deps,
    conversation: { deliver: async (text, kind) => { deliveries.push({ text, kind }) } },
    state: new ProactiveStateFile(join(dir(), 'proactive.json')),
    burstMs: 3_600_000,
    onSignal: () => signal.bump(),
    log: quiet,
    now: over.now ?? (() => NOW),
  })
  return { p, deliveries, signal }
}

describe('проактивность', () => {
  it('завершение поручения — ход ассистента с предложением действия, без вопроса человека', async () => {
    const { p, deliveries, signal } = proactive()
    await p.handle(ev('run.succeeded'))
    expect(deliveries).toHaveLength(0)
    await p.flush()
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]!.kind).toBe(PLATFORM_EVENT_SOURCE)
    expect(deliveries[0]!.text).toContain('TASK-000001')
    expect(deliveries[0]!.text).toContain('Предложи:')
    expect(signal.current).toBe(1)
    p.dispose()
  })

  it('лавина по одной задаче — одно сообщение; повтор события — без второго', async () => {
    const { p, deliveries } = proactive()
    const run = ev('run.succeeded')
    await p.handle(run)
    await p.handle(ev('approval.requested', { entityType: 'approval', payload: { taskId: 't1', assignedPrincipalId: ME, taskPublicId: 'TASK-000001', taskTitle: 'Сверить акты' } }))
    await p.handle(run)
    await p.flush()
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]!.text).toContain('2 события')
    await p.handle(run)
    await p.flush()
    expect(deliveries).toHaveLength(1)
    p.dispose()
  })

  it('незначимое — только в сводке при возвращении человека', async () => {
    let now = NOW
    const { p, deliveries } = proactive({ now: () => now })
    await p.presence()
    await p.handle(ev('task.verified', { entityType: 'task', entityId: 't1' }))
    await p.flush()
    expect(deliveries).toHaveLength(0)
    now += 60_000
    await p.presence()
    expect(deliveries).toHaveLength(0)
    now += 30 * 60_000
    await p.presence()
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]!.text).toContain('Пока его не было')
    now += 30 * 60_000
    await p.presence()
    expect(deliveries).toHaveLength(1)
    p.dispose()
  })

  it('старое значимое событие (догон после сна) — в сводку, а не отдельным ходом', async () => {
    const { p, deliveries } = proactive()
    await p.handle(ev('run.failed', { occurredAt: new Date(NOW - 3 * 3600_000).toISOString(), payload: { taskId: 't1', reason: 'тесты упали' } }))
    await p.flush()
    expect(deliveries).toHaveLength(0)
    await p.presence()
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]!.text).toContain('тесты упали')
    p.dispose()
  })

  it('недоставленный ход остаётся в очереди и уходит после перезапуска', async () => {
    const path = join(dir(), 'proactive.json')
    const failing = new Proactive({
      rules: loadRules(), deps: async () => deps, state: new ProactiveStateFile(path), burstMs: 3_600_000, retryMs: 3_600_000, log: quiet, now: () => NOW,
      conversation: { deliver: async () => { throw new Error('беседа недоступна') } },
    })
    await failing.handle(ev('run.succeeded'))
    await failing.flush()
    failing.dispose()
    const delivered: string[] = []
    const restarted = new Proactive({
      rules: loadRules(), deps: async () => deps, state: new ProactiveStateFile(path), burstMs: 3_600_000, log: quiet, now: () => NOW,
      conversation: { deliver: async (text) => { delivered.push(text) } },
    })
    await restarted.flush()
    expect(delivered).toHaveLength(1)
    restarted.dispose()
  })
})

describe('сигнал окну', () => {
  it('long-poll отвечает на изменение и по таймауту', async () => {
    const signal = new ChangeSignal()
    const waiting = signal.wait(0, 10_000)
    signal.bump()
    expect(await waiting).toBe(1)
    expect(await signal.wait(1, 10)).toBe(1)
  })
})
