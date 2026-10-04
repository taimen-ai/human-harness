import { afterEach, describe, expect, it } from 'vitest'
import { SURFACE_VERSION } from '../src/surface.ts'
import { harness, SECRET, SseReader, type Harness } from './surface-harness.ts'

const P = '/internal/harness/surface'
const R1 = '0b6c1f2e-5d3a-4c1b-9e8f-7a6b5c4d3e2f'
const R2 = '1c7d2e3f-6e4b-4d2c-8f9a-8b7c6d5e4f30'
const screen = { kind: 'process_instance', id: 'pi-1', label: 'Оплата счёта INV-1', url: '/console/processes/pi-1', projection: { step: 'approve', since: '2026-09-29T09:00:00Z' } }
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

let h: Harness
afterEach(async () => { await h?.close() })

const stream = (after?: string) => new SseReader(`${h.base}${P}/stream`, { authorization: `Bearer ${SECRET}`, ...(after ? { 'last-event-id': after } : {}) })

/** Ход беседы: реплика человека из источника и ответ ассистента. */
function turn(n: number, source: Record<string, unknown>, text: string, answer: string, id = `u${n}`) {
  h.emit('turn/start', { turn: n })
  h.emit('user/message', { id, role: 'user', source, content: [{ type: 'text', text }] })
  h.emit('assistant/message', { turn: n, step: 1, message: { id: `a${n}`, role: 'assistant', content: [{ type: 'text', text: answer }] } })
  h.emit('turn/end', { turn: n, reason: { kind: 'completed' } })
}

describe('POST surface/message', () => {
  it('реплика консоли и реплика Telegram ложатся в одну беседу', async () => {
    h = await harness()
    const inbound = await h.post('/internal/harness/inbound', { channel: 'telegram', text: 'из телефона' })
    expect(inbound.status).toBe(202)
    const res = await h.post(`${P}/message`, { requestId: R1, text: 'Почему стоит этот счёт?', screenContext: screen }, { 'x-harness-surface': 'console' })
    expect(res.status).toBe(202)
    expect(res.headers.get('x-harness-surface-version')).toBe(SURFACE_VERSION)
    const body = await res.json()
    expect(h.followups).toHaveLength(2)
    expect(body).toEqual({ requestId: R1, messageId: h.followups[1]!.id, queued: false })
    expect(h.followups[0]!.source).toMatchObject({ kind: 'channel', channel: 'telegram' })
    // Та же сессия беседы; источник — поверхность, проекция экрана в журнал не пишется.
    expect(h.followups[1]!.source).toEqual({
      kind: 'surface', surface: 'console', requestId: R1,
      screenContext: { kind: 'process_instance', id: 'pi-1', label: 'Оплата счёта INV-1', url: '/console/processes/pi-1' },
    })
    expect(h.followups[1]!.content).toEqual([{ type: 'text', text: 'Почему стоит этот счёт?' }])
    // Полный контекст экрана ждёт вход хода (секция screen-context) и отдаётся один раз.
    expect(h.surface.takeScreenContext(R1)).toEqual(screen)
    expect(h.surface.takeScreenContext(R1)).toBeUndefined()
  })

  it('идемпотентность по requestId: то же тело — тот же ответ, другое — 409', async () => {
    h = await harness()
    const first = await (await h.post(`${P}/message`, { requestId: R1, text: 'раз' })).json()
    const again = await h.post(`${P}/message`, { requestId: R1, text: 'раз' })
    expect(again.status).toBe(202)
    expect(await again.json()).toEqual(first)
    expect(h.followups).toHaveLength(1)
    const reused = await h.post(`${P}/message`, { requestId: R1, text: 'два' })
    expect(reused.status).toBe(409)
    expect((await reused.json()).error.code).toBe('request_id_reused')
  })

  it('занятый ассистент — очередь хода', async () => {
    h = await harness()
    h.agent.status = 'running'
    expect((await (await h.post(`${P}/message`, { requestId: R1, text: 'в очередь' })).json()).queued).toBe(true)
  })

  it('контекст экрана больше 8 КБ — 413, без секрета — 401, чужая поверхность — 400', async () => {
    h = await harness()
    const big = await h.post(`${P}/message`, { requestId: R1, text: 'x', screenContext: { ...screen, projection: { blob: 'я'.repeat(5000) } } })
    expect(big.status).toBe(413)
    expect((await big.json()).error.code).toBe('screen_context_too_large')
    const anon = await fetch(`${h.base}${P}/message`, { method: 'POST', body: '{}' })
    expect(anon.status).toBe(401)
    const wrong = await h.post(`${P}/message`, { requestId: R1, text: 'x' }, { 'x-harness-surface': 'telegram' })
    expect(wrong.status).toBe(400)
    expect(h.followups).toHaveLength(0)
  })
})

describe('GET surface/stream', () => {
  it('вид всей беседы: ходы, поверхности сообщений, инструменты без аргументов', async () => {
    h = await harness()
    const sse = stream()
    await sse.waitFor(e => e.some(x => x.type === 'ready'))
    expect(sse.response.headers.get('x-harness-surface-version')).toBe(SURFACE_VERSION)
    h.emit('turn/start', { turn: 1 })
    h.emit('user/message', { id: 'u1', source: { kind: 'surface', surface: 'console', requestId: R1, screenContext: { kind: 'work', url: '/console/work/T-1' } }, content: [{ type: 'text', text: 'что с задачей?' }] })
    h.emit('user/message', { id: 'ctx', source: { kind: 'screen-context', form: 'snapshot' }, content: [{ type: 'text', text: 'секция' }] })
    h.surface.onAssistantStream('s1', { type: 'chunk', attemptId: 'att-1', chunk: { type: 'text-delta', index: 0, text: 'Смотрю' } })
    h.emit('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'mcp__dsh__cp_get_task', arguments: '{"ref":"SECRET-ARG"}' })
    h.emit('tool/result', { turn: 1, step: 1, message: { id: 't1', role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'RESULT' }] } })
    h.emit('assistant/message', { turn: 1, step: 2, message: { id: 'a1', content: [{ type: 'text', text: 'Задача ждёт ревью.' }] } })
    h.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    turn(2, { kind: 'channel', channel: 'telegram' }, '[Из Telegram] а счёт?', 'Счёт оплачен.')
    turn(3, { kind: 'user' }, 'из окна', 'Ответ окну.')
    await sse.waitFor(e => e.filter(x => x.type === 'turn.ended').length === 3)
    sse.close()
    const types = sse.events.map(e => e.type)
    expect(types).toEqual([
      'ready',
      'turn.started', 'message', 'delta', 'tool.summary', 'tool.summary', 'message', 'turn.ended',
      'turn.started', 'message', 'message', 'turn.ended',
      'turn.started', 'message', 'message', 'turn.ended',
    ])
    const [, started, userMsg, delta, toolStart, toolDone, answer, ended] = sse.events
    expect(started).toMatchObject({ turnId: 's1.1', requestId: R1 })
    expect(userMsg!.message).toEqual({ id: 'u1', role: 'user', surface: 'console', text: 'что с задачей?', at: userMsg!.message.at, requestId: R1, screenContext: { kind: 'work', url: '/console/work/T-1' } })
    expect(delta).toMatchObject({ messageId: 'att-1', text: 'Смотрю' })
    expect(toolStart).toMatchObject({ tool: 'cp_get_task', status: 'started', turnId: 's1.1' })
    expect(toolDone).toMatchObject({ tool: 'cp_get_task', status: 'succeeded' })
    expect(JSON.stringify(sse.events)).not.toMatch(/SECRET-ARG|RESULT/)
    expect(answer!.message).toMatchObject({ role: 'assistant', text: 'Задача ждёт ревью.' })
    expect(answer!.message.surface).toBeUndefined()
    expect(ended).toMatchObject({ turnId: 's1.1', requestId: R1, status: 'completed' })
    // Ходы Telegram и окна: без requestId, поверхность сообщения — откуда написано.
    expect(sse.events[8]).not.toHaveProperty('requestId')
    expect(sse.events[9]!.message).toMatchObject({ surface: 'telegram', text: 'а счёт?' })
    expect(sse.events[13]!.message).toMatchObject({ surface: 'window', text: 'из окна' })
    // id: SSE — курсор, event: — тип.
    for (const e of sse.events) { expect(e.sseId).toBe(e.cursor); expect(e.sseEvent).toBe(e.type) }
  })

  it('возобновление по Last-Event-ID отдаёт события после курсора; чужой курсор — resumed: false', async () => {
    h = await harness()
    turn(1, { kind: 'user' }, 'раз', 'один')
    await h.surface.settled()
    const first = stream()
    await first.waitFor(e => e.some(x => x.type === 'ready'))
    first.close()
    const cursor = first.events[0]!.cursor
    turn(2, { kind: 'user' }, 'два', 'второй')
    await h.surface.settled()
    const resumed = stream(cursor)
    await resumed.waitFor(e => e.some(x => x.type === 'turn.ended'))
    resumed.close()
    expect(resumed.events[0]).toMatchObject({ type: 'ready', resumed: true })
    expect(resumed.events.filter(e => e.type === 'message').map(e => e.message.text)).toEqual(['два', 'второй'])

    const stale = stream('deadbeef.3')
    await stale.waitFor(e => e.some(x => x.type === 'ready'))
    await new Promise(resolve => setTimeout(resolve, 50))
    stale.close()
    expect(stale.events).toHaveLength(1)
    expect(stale.events[0]).toMatchObject({ type: 'ready', resumed: false })
  })
})

describe('GET surface/history', () => {
  it('страницы сообщений от новых к старым с курсором nextBefore', async () => {
    h = await harness()
    turn(1, { kind: 'user' }, 'первый', 'ответ 1')
    h.emit('user/message', { id: 'pe', source: { kind: 'platform-event' }, content: [{ type: 'text', text: 'событие платформы' }] })
    turn(2, { kind: 'surface', surface: 'console', requestId: R2, screenContext: null }, 'второй', 'ответ 2')
    const page1 = await (await h.get(`${P}/history?limit=3`)).json()
    expect(page1.items.map((m: { text: string }) => m.text)).toEqual(['ответ 2', 'второй', 'ответ 1'])
    expect(page1.items[1]).toMatchObject({ surface: 'console', requestId: R2 })
    expect(page1.nextBefore).not.toBeNull()
    const page2 = await (await h.get(`${P}/history?limit=3&before=${page1.nextBefore}`)).json()
    expect(page2).toEqual({ items: [expect.objectContaining({ text: 'первый', surface: 'window' })], nextBefore: null })
    expect((await h.get(`${P}/history?limit=0`)).status).toBe(400)
  })

  it('открытие беседы в консоли — присутствие человека; листание назад — нет', async () => {
    let present = 0
    h = await harness({ presence: () => { present += 1 } })
    turn(1, { kind: 'user' }, 'первый', 'ответ 1')
    turn(2, { kind: 'user' }, 'второй', 'ответ 2')
    const page1 = await (await h.get(`${P}/history?limit=2`)).json()
    expect(present).toBe(1)
    await h.get(`${P}/history?limit=2&before=${page1.nextBefore}`)
    expect(present).toBe(1)
  })
})

describe('подтверждения гоняются между поверхностями', () => {
  it('ответ консоли закрывает запрос в Telegram; нажатие в Telegram после — already_resolved', async () => {
    h = await harness()
    const sse = stream()
    await sse.waitFor(e => e.some(x => x.type === 'ready'))
    h.emit('turn/start', { turn: 1 })
    h.emit('user/message', { id: 'u1', source: { kind: 'channel', channel: 'telegram' }, content: [{ type: 'text', text: '[Из Telegram] создай задачу' }] })
    await h.surface.settled()
    const outcome = h.ask('cp_create_task')
    await sse.waitFor(e => e.some(x => x.type === 'approval.requested'))
    await flush()
    const requested = sse.events.find(e => e.type === 'approval.requested')!
    expect(requested).toMatchObject({ toolName: 'cp_create_task', reason: 'нужно для дела', turnId: 's1.1' })
    // В Telegram ушли кнопки того же запроса.
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.actions![0]!.data.requestId).toBe(requested.approvalRequestId)

    const decided = await h.post(`${P}/approval`, { approvalRequestId: requested.approvalRequestId, decision: 'allow' })
    expect(await decided.json()).toEqual({ status: 'resolved' })
    await expect(outcome).resolves.toBe('allowed-once')
    const press = await h.post('/internal/harness/inbound', { channel: 'telegram', approval: { id: requested.approvalRequestId, decision: 'reject' } })
    expect(await press.json()).toEqual({ accepted: true, resolved: false, status: 'already_resolved' })
    const again = await h.post(`${P}/approval`, { approvalRequestId: requested.approvalRequestId, decision: 'reject' })
    expect(await again.json()).toEqual({ status: 'already_resolved', decision: 'allow', surface: 'console' })
    await sse.waitFor(e => e.some(x => x.type === 'approval.resolved'))
    sse.close()
    expect(sse.events.find(e => e.type === 'approval.resolved')).toMatchObject({ approvalRequestId: requested.approvalRequestId, decision: 'allow', surface: 'console' })
  })

  it('нажатие в Telegram первым — консоль получает already_resolved', async () => {
    h = await harness()
    h.emit('turn/start', { turn: 1 })
    h.emit('user/message', { id: 'u1', source: { kind: 'channel', channel: 'telegram' }, content: [] })
    await h.surface.settled()
    const outcome = h.ask('cp_update_task')
    await flush()
    const id = String(h.sent[0]!.actions![0]!.data.requestId)
    const press = await h.post('/internal/harness/inbound', { channel: 'telegram', approval: { id, decision: 'reject' } })
    expect(await press.json()).toEqual({ accepted: true, resolved: true, status: 'resolved' })
    await expect(outcome).resolves.toBe('rejected')
    const late = await h.post(`${P}/approval`, { approvalRequestId: id, decision: 'allow' })
    expect(await late.json()).toEqual({ status: 'already_resolved', decision: 'reject', surface: 'telegram' })
  })

  it('ход консоли: подтверждение без окна DSH отвечается из консоли и в Telegram не уходит', async () => {
    h = await harness()
    turn(1, { kind: 'surface', surface: 'console', requestId: R1, screenContext: null }, 'сделай', 'сделал')
    h.emit('turn/start', { turn: 2 })
    h.emit('user/message', { id: 'u2', source: { kind: 'surface', surface: 'console', requestId: R2, screenContext: null }, content: [{ type: 'text', text: 'и ещё' }] })
    await h.surface.settled()
    // Окна нет: штатный ответчик DSH сразу даёт 'unavailable' — это не отказ.
    const outcome = h.ask('cp_create_task', async () => 'unavailable')
    await flush()
    const [id] = h.hub.pendingIds()
    expect(id).toBeDefined()
    expect(await (await h.post(`${P}/approval`, { approvalRequestId: id, decision: 'reject', comment: 'не сейчас' })).json()).toEqual({ status: 'resolved' })
    await expect(outcome).resolves.toBe('rejected')
    h.emit('assistant/message', { turn: 2, step: 1, message: { id: 'a2', content: [{ type: 'text', text: 'не стал' }] } })
    h.emit('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await flush()
    // Ни ответы ходов консоли, ни подтверждение — в notification-service не ходили.
    expect(h.sent).toEqual([])
  })

  it('окно ответило первым — консоль видит already_resolved от окна', async () => {
    h = await harness()
    const sse = stream()
    await sse.waitFor(e => e.some(x => x.type === 'ready'))
    await expect(h.ask('cp_create_task', async () => 'allowed-once')).resolves.toBe('allowed-once')
    await sse.waitFor(e => e.some(x => x.type === 'approval.resolved'))
    sse.close()
    const resolved = sse.events.find(e => e.type === 'approval.resolved')!
    expect(resolved).toMatchObject({ decision: 'allow', surface: 'window' })
    expect(await (await h.post(`${P}/approval`, { approvalRequestId: resolved.approvalRequestId, decision: 'reject' })).json())
      .toEqual({ status: 'already_resolved', decision: 'allow', surface: 'window' })
  })

  it('без ответа запрос истекает: cancelled, консоли — expired; неизвестный id — 404', async () => {
    h = await harness({ timeoutMs: 20 })
    const sse = stream()
    await sse.waitFor(e => e.some(x => x.type === 'ready'))
    const outcome = h.ask('cp_create_task')
    await flush()
    const [id] = h.hub.pendingIds()
    await expect(outcome).resolves.toBe('cancelled')
    sse.close()
    expect(await (await h.post(`${P}/approval`, { approvalRequestId: id, decision: 'allow' })).json()).toEqual({ status: 'expired' })
    expect((await h.post(`${P}/approval`, { approvalRequestId: 'nope', decision: 'allow' })).status).toBe(404)
  })

  it('ход прерван до решения: approval.resolved cancelled, консоли — already_resolved(cancelled), не expired', async () => {
    h = await harness()
    const sse = stream()
    await sse.waitFor(e => e.some(x => x.type === 'ready'))
    const abort = new AbortController()
    const outcome = h.ask('cp_create_task', () => new Promise(() => undefined), abort.signal)
    await flush()
    const [id] = h.hub.pendingIds()
    abort.abort()
    await expect(outcome).resolves.toBe('cancelled')
    await sse.waitFor(e => e.some(x => x.type === 'approval.resolved'))
    sse.close()
    expect(sse.events.find(e => e.type === 'approval.resolved')).toEqual(expect.objectContaining({ approvalRequestId: id, decision: 'cancelled' }))
    expect(await (await h.post(`${P}/approval`, { approvalRequestId: id, decision: 'allow' })).json()).toEqual({ status: 'already_resolved', decision: 'cancelled' })
  })

  it('комментарий решения уходит в approval.resolved', async () => {
    h = await harness()
    const sse = stream()
    await sse.waitFor(e => e.some(x => x.type === 'ready'))
    const outcome = h.ask('cp_create_task')
    await flush()
    await h.post(`${P}/approval`, { approvalRequestId: h.hub.pendingIds()[0], decision: 'reject', comment: 'не в этот раз' })
    await expect(outcome).resolves.toBe('rejected')
    await sse.waitFor(e => e.some(x => x.type === 'approval.resolved'))
    sse.close()
    expect(sse.events.find(e => e.type === 'approval.resolved')).toMatchObject({ decision: 'reject', surface: 'console', comment: 'не в этот раз' })
  })
})

describe('кто ждёт ответа на подтверждение', () => {
  it('проактивный ход без подписчиков потока сразу получает unavailable', async () => {
    h = await harness()
    h.emit('turn/start', { turn: 1 })
    h.emit('user/message', { id: 'pe', source: { kind: 'platform-event' }, content: [{ type: 'text', text: 'событие' }] })
    await h.surface.settled()
    const started = Date.now()
    await expect(h.ask('cp_create_task', async () => 'unavailable')).resolves.toBe('unavailable')
    expect(Date.now() - started).toBeLessThan(500)
    expect(h.hub.pendingIds()).toEqual([])
    expect(h.sent).toEqual([])
  })

  it('сообщение консоли в очереди не держит проактивный ход 10 минут', async () => {
    h = await harness()
    h.emit('turn/start', { turn: 1 })
    h.emit('user/message', { id: 'pe', source: { kind: 'platform-event' }, content: [] })
    await h.surface.settled()
    h.agent.status = 'running'
    const queued = await (await h.post(`${P}/message`, { requestId: R1, text: 'в очередь' })).json()
    expect(queued.queued).toBe(true)
    // Текущий ход — не консоли, потока никто не читает: подтверждение не ждёт.
    await expect(h.ask('cp_create_task', async () => 'unavailable')).resolves.toBe('unavailable')
  })

  it('с подписчиком потока ход ждёт, и консоль может ответить', async () => {
    h = await harness()
    h.emit('turn/start', { turn: 1 })
    h.emit('user/message', { id: 'pe', source: { kind: 'platform-event' }, content: [] })
    await h.surface.settled()
    const sse = stream()
    await sse.waitFor(e => e.some(x => x.type === 'ready'))
    expect(h.surface.subscriberCount()).toBe(1)
    const outcome = h.ask('cp_create_task', async () => 'unavailable')
    await sse.waitFor(e => e.some(x => x.type === 'approval.requested'))
    const id = sse.events.find(e => e.type === 'approval.requested')!.approvalRequestId
    expect(await (await h.post(`${P}/approval`, { approvalRequestId: id, decision: 'allow' })).json()).toEqual({ status: 'resolved' })
    await expect(outcome).resolves.toBe('allowed-once')
    sse.close()
  })

  it('ход консоли без открытого потока ждёт ответа, даже если очередь событий отстала (правило b)', async () => {
    h = await harness()
    const sent = await (await h.post(`${P}/message`, { requestId: R1, text: 'создай задачу' })).json()
    expect(sent.queued).toBe(false)
    expect(h.surface.subscriberCount()).toBe(0)
    // Ход уже идёт, а очередь событий ещё не дошла ни до turn/start, ни до реплики консоли.
    let finished = false
    const outcome = h.ask('cp_create_task', async () => 'unavailable')
    void outcome.then(() => { finished = true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(finished).toBe(false)
    const [id] = h.hub.pendingIds()
    expect(id).toBeDefined()
    // Очередь догнала ход; консоль отвечает на запрос, как только откроет поток.
    h.emit('turn/start', { turn: 1 })
    h.emit('user/message', { id: 'u1', source: { kind: 'surface', surface: 'console', requestId: R1, screenContext: null }, content: [{ type: 'text', text: 'создай задачу' }] })
    await h.surface.settled()
    expect(await (await h.post(`${P}/approval`, { approvalRequestId: id, decision: 'allow' })).json()).toEqual({ status: 'resolved' })
    await expect(outcome).resolves.toBe('allowed-once')
    expect(h.sent).toEqual([])
  })

  it('ход консоли закончился — следующий проактивный ход без потока снова получает unavailable сразу', async () => {
    h = await harness()
    await h.post(`${P}/message`, { requestId: R1, text: 'привет' })
    turn(1, { kind: 'surface', surface: 'console', requestId: R1, screenContext: null }, 'привет', 'здравствуйте')
    h.emit('turn/start', { turn: 2 })
    h.emit('user/message', { id: 'pe', source: { kind: 'platform-event' }, content: [] })
    await h.surface.settled()
    await expect(h.ask('cp_create_task', async () => 'unavailable')).resolves.toBe('unavailable')
    expect(h.hub.pendingIds()).toEqual([])
  })

  /** Ответ подтверждения, если он пришёл сразу; иначе — `'ждёт'` (ход ждал бы решения до 10 минут). */
  const immediate = (outcome: Promise<unknown>) => Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('ждёт'), 300))])

  it('очередь прошла ход консоли до возврата flush — метка не ставится, следующий проактивный ход получает unavailable сразу', async () => {
    let emitted = false
    h = await harness({
      timeoutMs: 1000,
      // Журнал записан, очередь событий успевает пройти весь ход консоли, а доставка ещё не вернулась.
      flush: async () => {
        if (!emitted) {
          emitted = true
          turn(1, { kind: 'surface', surface: 'console', requestId: R1, screenContext: null }, 'привет', 'здравствуйте')
          await h.surface.settled()
        }
        return true
      },
    })
    const sent = await (await h.post(`${P}/message`, { requestId: R1, text: 'привет' })).json()
    expect(sent.queued).toBe(false)
    h.emit('turn/start', { turn: 2 })
    h.emit('user/message', { id: 'pe', source: { kind: 'platform-event' }, content: [] })
    await h.surface.settled()
    await expect(immediate(h.ask('cp_create_task', async () => 'unavailable'))).resolves.toBe('unavailable')
    expect(h.hub.pendingIds()).toEqual([])
  })

  it('шаг консоли отклонён (turn/start и turn/end без реплики) — метка снимается концом хода', async () => {
    h = await harness({ timeoutMs: 1000 })
    const sent = await (await h.post(`${P}/message`, { requestId: R1, text: 'удали всё' })).json()
    expect(sent.queued).toBe(false)
    // Ход реплики: шаг отклонён, реплики с requestId в журнале нет.
    h.emit('turn/start', { turn: 1 })
    h.emit('turn/end', { turn: 1, reason: { kind: 'blocked' } })
    h.emit('turn/start', { turn: 2 })
    h.emit('user/message', { id: 'pe', source: { kind: 'platform-event' }, content: [] })
    await h.surface.settled()
    await expect(immediate(h.ask('cp_create_task', async () => 'unavailable'))).resolves.toBe('unavailable')
    expect(h.hub.pendingIds()).toEqual([])
  })

  it('отклонённый шаг консоли прошёл очередь до возврата flush — метка не ставится', async () => {
    let emitted = false
    h = await harness({
      timeoutMs: 1000,
      flush: async () => {
        if (!emitted) {
          emitted = true
          h.emit('turn/start', { turn: 1 })
          h.emit('turn/end', { turn: 1, reason: { kind: 'blocked' } })
          await h.surface.settled()
        }
        return true
      },
    })
    await h.post(`${P}/message`, { requestId: R1, text: 'удали всё' })
    h.emit('turn/start', { turn: 2 })
    h.emit('user/message', { id: 'pe', source: { kind: 'platform-event' }, content: [] })
    await h.surface.settled()
    await expect(immediate(h.ask('cp_create_task', async () => 'unavailable'))).resolves.toBe('unavailable')
  })

  it('ход консоли начался до возврата flush и ещё идёт — он ждёт ответа консоли', async () => {
    let emitted = false
    h = await harness({
      timeoutMs: 1000,
      flush: async () => {
        if (!emitted) {
          emitted = true
          h.emit('turn/start', { turn: 1 })
          await h.surface.settled()
        }
        return true
      },
    })
    await h.post(`${P}/message`, { requestId: R1, text: 'создай задачу' })
    await expect(immediate(h.ask('cp_create_task', async () => 'unavailable'))).resolves.toBe('ждёт')
    expect(h.hub.pendingIds()).toHaveLength(1)
  })

  it('ход из Telegram: кнопки не доставлены и консоль не слушает — сразу unavailable', async () => {
    h = await harness({ notify: async () => { throw new Error('503') } })
    h.emit('turn/start', { turn: 1 })
    h.emit('user/message', { id: 'u1', source: { kind: 'channel', channel: 'telegram' }, content: [] })
    await h.surface.settled()
    await expect(h.ask('cp_create_task', async () => 'unavailable')).resolves.toBe('unavailable')
  })
})

describe('лимиты потока и тела', () => {
  it('больше 8 потоков — 429 too_many_streams', async () => {
    h = await harness()
    const open = Array.from({ length: 8 }, () => stream())
    for (const s of open) await s.waitFor(e => e.some(x => x.type === 'ready'))
    const ninth = await h.get(`${P}/stream`)
    expect(ninth.status).toBe(429)
    expect((await ninth.json()).error.code).toBe('too_many_streams')
    for (const s of open) s.close()
  })

  it('неверный курсор потока и истории — 400 invalid_cursor, как у launcher\'а', async () => {
    h = await harness()
    const long = await h.get(`${P}/stream`, { 'last-event-id': 'c'.repeat(201) })
    expect(long.status).toBe(400)
    expect((await long.json()).error.code).toBe('invalid_cursor')
    const after = await h.get(`${P}/stream?after=${'c'.repeat(201)}`)
    expect(after.status).toBe(400)
    expect((await after.json()).error.code).toBe('invalid_cursor')
    const before = await h.get(`${P}/history?before=abc`)
    expect(before.status).toBe(400)
    expect((await before.json()).error.code).toBe('invalid_cursor')
    expect(h.surface.subscriberCount()).toBe(0)
  })

  it('ready — ровно один на подключение и всегда с resumed', async () => {
    h = await harness()
    const sse = stream()
    await sse.waitFor(e => e.some(x => x.type === 'ready'))
    turn(1, { kind: 'user' }, 'раз', 'один')
    await sse.waitFor(e => e.some(x => x.type === 'turn.ended'))
    sse.close()
    expect(sse.events.filter(e => e.type === 'ready')).toEqual([expect.objectContaining({ resumed: false })])
  })

  it('медленный читатель отключается, а не копит события в памяти', async () => {
    const { SurfaceBridge, surfaceHandlers } = await import('../src/surface.ts')
    const { EventEmitter } = await import('node:events')
    const bridge = new SurfaceBridge({ conversation: { sessionId: async () => 's1', deliver: async () => { throw new Error('нет') }, page: async () => ({ events: [], hasMore: false }) }, log: { info: () => undefined, warn: () => undefined } })
    const handler = surfaceHandlers({ bridge, authorized: () => true, readJson: async () => ({}), maxBufferedBytes: 1000 })['/internal/harness/surface/stream']!
    const req = Object.assign(new EventEmitter(), { method: 'GET', url: '/internal/harness/surface/stream', headers: {} })
    let buffered = 0
    let destroyed = false
    const res = Object.assign(new EventEmitter(), {
      writeHead: () => res,
      write: (chunk: string) => { buffered += chunk.length; return false }, // клиент не читает
      destroy: () => { destroyed = true },
    })
    Object.defineProperty(res, 'writableLength', { get: () => buffered })
    await handler(req as never, res as never)
    expect(bridge.subscriberCount()).toBe(1)
    for (let i = 0; i < 20 && !destroyed; i += 1) bridge.publishApproval({ type: 'approval.requested', approvalRequestId: `a${i}`, toolName: 't', reason: 'x'.repeat(100), expiresAt: new Date().toISOString() })
    await bridge.settled()
    expect(destroyed).toBe(true)
    expect(bridge.subscriberCount()).toBe(0)
  })

  it('тело больше 64 КБ — 413 body_too_large; сбой беседы — 503 без текста исключения', async () => {
    h = await harness()
    const big = await h.post(`${P}/message`, { requestId: R1, text: 'я'.repeat(40_000) })
    expect(big.status).toBe(413)
    expect((await big.json()).error.code).toBe('body_too_large')
    const inbound = await h.post('/internal/harness/inbound', { channel: 'telegram', text: 'я'.repeat(40_000) })
    expect(inbound.status).toBe(413)
    const broken = await harness()
    try {
      // Беседа недоступна: хост без сессий.
      ;(broken.surface as unknown as { options: { conversation: { deliver: () => Promise<never> } } }).options.conversation.deliver = async () => { throw new Error('/data/secret/path упал') }
      const res = await broken.post(`${P}/message`, { requestId: R2, text: 'x' })
      expect(res.status).toBe(503)
      const text = await res.text()
      expect(text).not.toContain('/data/secret')
      expect(JSON.parse(text).error.code).toBe('conversation_unavailable')
    } finally {
      await broken.close()
    }
  })
})
