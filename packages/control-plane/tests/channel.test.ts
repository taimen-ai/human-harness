import { describe, expect, it, vi } from 'vitest'
import { ChannelBridge, channelWindowUrl, HARNESS_APPROVAL, NotifyClient, type NotificationBody } from '../src/channel.ts'

const quiet = { info: () => undefined, warn: () => undefined }
const ME = 'cp-principal-1'

const WINDOW = 'https://platform.example.com/console/?assistant=open'

function bridge(over: { send?: (body: NotificationBody) => Promise<void>, windowUrl?: string | null } = {}) {
  const sent: NotificationBody[] = []
  const b = new ChannelBridge({
    notify: { send: over.send ?? (async (body) => { sent.push(body) }) },
    me: async () => ME,
    windowUrl: over.windowUrl === undefined ? WINDOW : over.windowUrl,
    maxText: 50,
    log: quiet,
  })
  return { b, sent }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const userMessage = (kind: string) => ({ type: 'user/message', data: { source: { kind, channel: 'telegram' }, content: [{ type: 'text', text: 'вопрос' }] } })
const assistant = (text: string) => ({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } } })
const turnEnd = { type: 'turn/end', data: { turn: 1, reason: 'completed' } }

describe('канал — вторая поверхность беседы', () => {
  it('ответ на реплику из канала уходит человеку уведомлением', async () => {
    const { b, sent } = bridge()
    b.onSessionEvent('s1', userMessage('channel'))
    expect(b.isChannelTurn('s1')).toBe(true)
    b.onSessionEvent('s1', assistant('Сначала посмотрю задачи.'))
    b.onSessionEvent('s1', assistant('Готово: одно решение ждёт.'))
    b.onSessionEvent('s1', turnEnd)
    await flush()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ recipient: { kind: 'principal', id: ME }, type: 'harness.reply', body: 'Готово: одно решение ждёт.' })
    expect(b.isChannelTurn('s1')).toBe(false)
  })

  it('ход из окна в канал не отвечает', async () => {
    const { b, sent } = bridge()
    b.onSessionEvent('s1', userMessage('user'))
    b.onSessionEvent('s1', assistant('ответ в окне'))
    b.onSessionEvent('s1', turnEnd)
    await flush()
    expect(sent).toEqual([])
  })

  it('длинный ответ обрезается со ссылкой в окно', async () => {
    const { b, sent } = bridge()
    b.onSessionEvent('s1', userMessage('channel'))
    b.onSessionEvent('s1', assistant('x'.repeat(200)))
    b.onSessionEvent('s1', turnEnd)
    await flush()
    expect(sent[0]!.body!.length).toBeLessThan(80)
    expect(sent[0]!.body).toContain('Полностью — в окне')
    expect(sent[0]!.links).toEqual([{ label: 'Открыть окно', url: WINDOW }])
  })

  it('без адреса окна ответ уходит без ссылки и без отсылки к окну', async () => {
    const { b, sent } = bridge({ windowUrl: null })
    b.onSessionEvent('s1', userMessage('channel'))
    b.onSessionEvent('s1', assistant('x'.repeat(200)))
    b.onSessionEvent('s1', turnEnd)
    await flush()
    expect(sent[0]!.links).toBeUndefined()
    expect(sent[0]!.body).not.toContain('в окне')
  })

  it('«Открыть окно» ведёт туда, куда указал launcher, иначе — на веб-хост харнесса', () => {
    expect(channelWindowUrl({ windowUrl: WINDOW, publicUrl: 'https://platform.example.com/harness' })).toBe(WINDOW)
    expect(channelWindowUrl({ publicUrl: 'https://h.example.com/' })).toBe('https://h.example.com/')
    expect(channelWindowUrl({ publicUrl: 'https://h.example.com' })).toBe('https://h.example.com/')
    expect(channelWindowUrl({})).toBeNull()
  })

  it('подтверждение: кнопки в канале несут id общего запроса', async () => {
    const { b, sent } = bridge()
    await b.confirm('req-1', { toolName: 'cp_create_task', reason: 'создать задачу' })
    expect(sent).toHaveLength(1)
    const actions = sent[0]!.actions!
    expect(actions.map(a => a.data)).toEqual([
      { kind: HARNESS_APPROVAL, requestId: 'req-1', decision: 'approve' },
      { kind: HARNESS_APPROVAL, requestId: 'req-1', decision: 'reject' },
    ])
    expect(sent[0]!.body).toContain('cp_create_task')
  })

  it('ход консоли в канал не отвечает, даже если перед ним был ход из Telegram', async () => {
    const { b, sent } = bridge()
    b.onSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    b.onSessionEvent('s1', userMessage('channel'))
    b.onSessionEvent('s1', assistant('ответ в Telegram'))
    b.onSessionEvent('s1', turnEnd)
    b.onSessionEvent('s1', { type: 'turn/start', data: { turn: 2 } })
    b.onSessionEvent('s1', { type: 'user/message', data: { source: { kind: 'surface', surface: 'console', requestId: 'r' }, content: [] } })
    b.onSessionEvent('s1', assistant('ответ в консоли'))
    b.onSessionEvent('s1', { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await flush()
    expect(sent.map(n => n.body)).toEqual(['ответ в Telegram'])
  })

  it('в Telegram уходят только ходы канала telegram', async () => {
    const { b, sent } = bridge()
    b.onSessionEvent('s1', { type: 'user/message', data: { source: { kind: 'channel', channel: 'max' }, content: [] } })
    b.onSessionEvent('s1', assistant('ответ'))
    b.onSessionEvent('s1', turnEnd)
    await flush()
    expect(sent).toEqual([])
    expect(b.isChannelTurn('s1')).toBe(false)
  })

  it('служебная реплика внутри хода (секция контекста) не снимает ход канала', () => {
    const { b } = bridge()
    b.onSessionEvent('s1', userMessage('channel'))
    b.onSessionEvent('s1', { type: 'user/message', data: { source: { kind: 'time-context', form: 'snapshot' }, content: [] } })
    expect(b.isChannelTurn('s1')).toBe(true)
  })

  it('клиент notification-service: токен audience notification-service, повтор после 401', async () => {
    const identity = { authorization: vi.fn(async () => 'Bearer t'), invalidate: vi.fn() }
    let calls = 0
    const fetchImpl = vi.fn(async () => new Response('{}', { status: ++calls === 1 ? 401 : 201 }))
    await new NotifyClient('http://notify:8000/', identity, fetchImpl as unknown as typeof fetch)
      .send({ recipient: { kind: 'principal', id: ME }, type: 't', title: 'x' }, 'key-1')
    expect(identity.authorization).toHaveBeenCalledWith('notification-service')
    expect(identity.invalidate).toHaveBeenCalledWith('notification-service')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [url, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit]
    expect(url).toBe('http://notify:8000/api/v1/notifications')
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe('key-1')
  })
})


describe('пометка канала для модели', () => {
  it('реплика из Telegram помечается человекочитаемым именем канала', async () => {
    const { channelName } = await import('../src/conversation.ts')
    expect(channelName('telegram')).toBe('Telegram')
    expect(channelName(undefined)).toBe('канала')
  })
})
