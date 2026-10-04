import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { absoluteConsoleLinks, ChannelBridge, fitProposalLinks, type NotificationBody } from '../src/channel.ts'
import type { ControlPlaneClient } from '../src/client.ts'
import { consoleUrl } from '../src/names.ts'
import type { ControlPlane } from '../src/service.ts'
import { registerTools } from '../src/tools.ts'

const WS = 'b0000000-0000-4000-8000-000000000001'
const EXEC = 'a0000000-0000-4000-8000-000000000001'

/** Параметры ссылки так, как их прочтёт консоль. */
function params(url: string): Record<string, string> {
  const parsed = new URL(url, 'https://console.example.com')
  expect(parsed.pathname).toBe('/console/work/new')
  return Object.fromEntries(parsed.searchParams)
}

describe('consoleUrl.proposal — ссылка-предложение работы', () => {
  it('рядом с consoleUrl.task: тот же адрес консоли, поля в порядке контракта', () => {
    expect(consoleUrl.task('TASK-1')).toBe('/console/work/TASK-1')
    expect(consoleUrl.proposal({ title: 'Отчёт', type: 'coding-task', exec: EXEC, owner: 'o-1', due: '2026-10-10', ws: WS, result: 'PDF', basis: 'письмо' }))
      .toBe(`/console/work/new?title=%D0%9E%D1%82%D1%87%D1%91%D1%82&type=coding-task&exec=${EXEC}&owner=o-1&due=2026-10-10&ws=${WS}&result=PDF&basis=%D0%BF%D0%B8%D1%81%D1%8C%D0%BC%D0%BE`)
  })

  it('кодирует значения: пробелы, &, =, #, ?, + и переводы строк не ломают ссылку', () => {
    const title = 'A & B = C #1? 50%+ / «к»\nвторая строка'
    const url = consoleUrl.proposal({ title, result: 'x&type=evil' })
    expect(url).not.toMatch(/[\s#]/)
    expect(params(url)).toEqual({ title, result: 'x&type=evil' })
  })

  it('скобки, апостроф, «!», «*» и хвостовая точка не рвут ссылку: markdown и разбор консоли видят все поля', () => {
    const proposal = {
      title: 'Оплатить счёт (ООО Ромашка)', type: 'pay-invoice', exec: EXEC, due: '2026-10-10', ws: WS,
      result: "Платёж д'Артаньяну проведён!", basis: 'Письмо *срочно* (вх. 12).',
    }
    const url = consoleUrl.proposal(proposal)
    expect(url).not.toMatch(/[()'!*]|\.$/)
    // Как консоль ищет предложения в ответе (screens/work/proposal.ts, findProposals):
    // адрес до пробела, угловой или круглой скобки, «]»; хвостовая пунктуация и кавычки срезаются.
    const found = [...`Предлагаю: [Завести работу: ${proposal.title}](${url}).`.matchAll(/\/console\/work\/new\?[^\s<>()\]]+/g)]
      .map(m => m[0].replace(/[.,;:!?»"']+$/, ''))
    expect(found).toEqual([url])
    expect(params(found[0]!)).toEqual(proposal)
  })

  it('пустые, пробельные, null и undefined поля отбрасываются; значения обрезаются по краям', () => {
    const url = consoleUrl.proposal({ title: '  Сделать  ', type: '', exec: null, owner: undefined, due: '   ', ws: WS, result: ' ', basis: null })
    expect(params(url)).toEqual({ title: 'Сделать', ws: WS })
    expect(url).not.toContain('exec=')
  })

  it('title обязателен: пустой — ошибка, а не ссылка без названия', () => {
    expect(() => consoleUrl.proposal({ title: '' })).toThrow(/title обязателен/)
    expect(() => consoleUrl.proposal({ title: '   ' })).toThrow(/title обязателен/)
  })

  it('режет по пределам консоли: title — 500, result и basis — 2000; ровно на пределе — без изменений', () => {
    const p = params(consoleUrl.proposal({ title: 'т'.repeat(600), result: 'р'.repeat(2500), basis: 'о'.repeat(2000) }))
    expect(p.title).toBe('т'.repeat(500))
    expect(p.result).toBe('р'.repeat(2000))
    expect(p.basis).toBe('о'.repeat(2000))
    expect(params(consoleUrl.proposal({ title: 'т'.repeat(500) })).title).toHaveLength(500)
  })

  it('не рвёт суррогатную пару на пределе: эмодзи не превращается в ошибку кодирования', () => {
    const title = `${'a'.repeat(499)}😀хвост`
    const p = params(consoleUrl.proposal({ title }))
    expect(p.title).toBe('a'.repeat(499))
    expect(params(consoleUrl.proposal({ title: '😀'.repeat(300) })).title).toBe('😀'.repeat(250))
  })

  it('due — ГГГГ-ММ-ДД или ISO date-time; иное — ошибка, а не ссылка, которую консоль молча урежет', () => {
    expect(params(consoleUrl.proposal({ title: 't', due: '2026-10-10' })).due).toBe('2026-10-10')
    expect(params(consoleUrl.proposal({ title: 't', due: '2026-10-10T15:00:00+03:00' })).due).toBe('2026-10-10T15:00:00+03:00')
    expect(params(consoleUrl.proposal({ title: 't', due: '2026-10-10T12:00Z' })).due).toBe('2026-10-10T12:00Z')
    for (const due of ['завтра', '10.10.2026', '2026-13-40', '2026-10-10 15:00']) {
      expect(() => consoleUrl.proposal({ title: 't', due }), due).toThrow(/due/)
    }
  })
})

/** Инструменты `cp_*` на заглушке ctx; подтверждения нет — мутация бы отказала. */
function harness(over: Partial<Record<keyof ControlPlaneClient, unknown>> = {}, workspaceId: string | null = WS) {
  const c = {
    createTask: vi.fn(async () => { throw new Error('createTask не должен вызываться') }),
    listTaskTypes: vi.fn(async () => ({ items: [
      { id: 'tt-1', key: 'coding-task', version: 9, displayName: 'Coding task', description: 'Код', status: 'active', fieldSchema: {} },
    ], nextCursor: null })),
    listTaskTypeExecutors: vi.fn(async () => ({ items: [
      { principalId: EXEC, kind: 'agent', displayName: 'coder', roles: [], reason: 'agent_task_types' },
    ] })),
    ...over,
  } as unknown as ControlPlaneClient & Record<string, ReturnType<typeof vi.fn>>
  const tools = new Map<string, ToolDefinition>()
  const approval = { request: vi.fn(async () => 'allowed-once') }
  const ctx = { tools: { register: (d: ToolDefinition) => { tools.set(d.name, d); return () => tools.delete(d.name) } }, get: () => approval } as unknown as Context
  const cp = { client: c, scope: async () => ({ workspaceId, slug: null, name: null, workspaceIds: workspaceId ? [workspaceId] : [] }) } as unknown as ControlPlane
  registerTools(ctx, cp, { confirmMutations: true })
  const run = (name: string, args: Record<string, unknown> = {}) =>
    tools.get(name)!.execute(args as never, { name, callId: 'c1', signal: new AbortController().signal, agent: {} } as never)
  return { c, tools, run, approval }
}

describe('инструменты предложения работы', () => {
  it('cp_task_types — разрешённые в выбранном workspace активные типы', async () => {
    const { c, run } = harness()
    const result = await run('cp_task_types') as { workspaceId: string, items: { id: string, key: string }[] }
    expect(c.listTaskTypes).toHaveBeenCalledWith({ workspaceId: WS, status: 'active' }, expect.anything())
    expect(result).toEqual({ workspaceId: WS, items: [{ id: 'tt-1', key: 'coding-task', version: 9, displayName: 'Coding task', description: 'Код' }], truncated: false })
  })

  it('cp_task_types и cp_task_type_executors без workspace — понятный отказ, не весь tenant', async () => {
    const { c, run } = harness({}, null)
    await expect(run('cp_task_types')).rejects.toThrow(/workspace не выбран/)
    await expect(run('cp_task_type_executors', { typeId: 'tt-1' })).rejects.toThrow(/workspace не выбран/)
    expect(c.listTaskTypes).not.toHaveBeenCalled()
  })

  it('cp_task_type_executors — кто может взять тип в workspace', async () => {
    const { c, run } = harness()
    const result = await run('cp_task_type_executors', { typeId: 'tt-1', workspaceId: 'ws-x' }) as { items: { principalId: string }[] }
    expect(c.listTaskTypeExecutors).toHaveBeenCalledWith('tt-1', 'ws-x', expect.anything())
    expect(result.items.map(e => e.principalId)).toEqual([EXEC])
  })

  it('cp_propose_task отвечает ссылкой и ничего не заводит: ни POST /tasks, ни подтверждения', async () => {
    const { c, run, approval } = harness()
    const result = await run('cp_propose_task', { title: 'Починить вход', type: 'coding-task', exec: EXEC, due: '2026-10-10', result: 'PR', basis: 'жалоба' }) as { url: string }
    expect(params(result.url)).toEqual({ title: 'Починить вход', type: 'coding-task', exec: EXEC, due: '2026-10-10', ws: WS, result: 'PR', basis: 'жалоба' })
    expect(c.createTask).not.toHaveBeenCalled()
    expect(approval.request).not.toHaveBeenCalled()
  })

  it('cp_propose_task без исполнителя — ссылка без exec; повтор — та же ссылка', async () => {
    const { run } = harness()
    const first = await run('cp_propose_task', { title: 'Отчёт', exec: '' }) as { url: string }
    const again = await run('cp_propose_task', { title: 'Отчёт', exec: '' }) as { url: string }
    expect(first.url).toBe(`/console/work/new?title=%D0%9E%D1%82%D1%87%D1%91%D1%82&ws=${WS}`)
    expect(again.url).toBe(first.url)
  })

  it('cp_propose_task: явный ws главнее scope; без scope — ссылка без ws', async () => {
    expect(params((await harness().run('cp_propose_task', { title: 't', ws: 'ws-2' }) as { url: string }).url).ws).toBe('ws-2')
    expect(params((await harness({}, null).run('cp_propose_task', { title: 't' }) as { url: string }).url).ws).toBeUndefined()
  })

  it('cp_propose_task без title или с неверным сроком — отказ', async () => {
    const { run } = harness()
    await expect(run('cp_propose_task', { title: ' ' })).rejects.toThrow(/title обязателен/)
    await expect(run('cp_propose_task', { title: 't', due: 'в пятницу' })).rejects.toThrow(/due/)
  })
})

describe('правило персоны: «поручи…» — ссылка-предложение, а не cp_create_task', () => {
  const patch = readFileSync(new URL('../../bundle/cordis.patch.yml', import.meta.url), 'utf8')
  const section = (from: string, to: string) => patch.slice(patch.indexOf(`      ${from}`), patch.indexOf(`      ${to}`))

  it('«Поручения»: не вызывать cp_create_task и cp_delegate, подобрать тип и исполнителя, ответить ссылкой', () => {
    const rule = section('Поручения.', 'Своя работа человека.')
    expect(rule).toContain('НЕ вызывай cp_create_task и cp_delegate')
    expect(rule).toContain('cp_task_types')
    expect(rule).toContain('cp_task_type_executors')
    expect(rule).toContain('cp_propose_task')
    expect(rule).toContain('[Завести работу: что сделать](url)')
    expect(rule).toContain('Исполнителя не нашёл — ссылка без исполнителя')
    expect(rule).toContain('нужна ваша подпись')
  })

  it('правило 1, консоль и Telegram не ведут «поручи…» к созданию задачи', () => {
    const rules = section('Правила работы.', 'Канал.')
    expect(rules).not.toContain('cp_create_task')
    expect(rules).toContain('cp_propose_task')
    expect(section('Консоль.', 'Одно окно.')).toContain('Новую работу не заводи сам')
    const channel = section('Канал.', 'Консоль.')
    expect(channel).toContain('cp_propose_task')
    expect(channel).toContain('обычной ссылкой')
    expect(channel).not.toMatch(/Черновик поручения или задачи покажи текстом и сразу/)
  })

  it('описания cp_create_task и cp_delegate отсылают просьбу человека к cp_propose_task', () => {
    const { tools } = harness()
    expect(tools.get('cp_create_task')!.description).toContain('cp_propose_task')
    expect(tools.get('cp_delegate')!.description).toContain('cp_propose_task')
  })
})

describe('ссылка-предложение в Telegram', () => {
  const WINDOW = 'https://platform.example.com/console/?assistant=open'

  it('относительные ссылки консоли становятся полными от адреса окна, остальное не меняется', () => {
    const url = consoleUrl.proposal({ title: 'Отчёт', ws: WS })
    expect(absoluteConsoleLinks(`[Завести работу: Отчёт](${url})`, WINDOW)).toBe(`[Завести работу: Отчёт](https://platform.example.com${url})`)
    expect(absoluteConsoleLinks(`см. ${url}`, WINDOW)).toBe(`см. https://platform.example.com${url}`)
    expect(absoluteConsoleLinks('уже https://x.example.com/console/work/1 и a/console/b', WINDOW)).toBe('уже https://x.example.com/console/work/1 и a/console/b')
    expect(absoluteConsoleLinks(`[x](${url})`, null)).toBe(`[x](${url})`)
    expect(absoluteConsoleLinks(`[x](${url})`, 'не адрес')).toBe(`[x](${url})`)
  })

  it('канал отдаёт ответ со ссылкой как обычный текст: без кнопок подтверждения, параметры целы', async () => {
    const sent: NotificationBody[] = []
    const b = new ChannelBridge({ notify: { send: async (body) => { sent.push(body) } }, me: async () => 'me', windowUrl: WINDOW, log: { info: () => undefined, warn: () => undefined } })
    const url = consoleUrl.proposal({ title: 'Починить вход', exec: EXEC, ws: WS })
    b.onSessionEvent('s1', { type: 'user/message', data: { source: { kind: 'channel', channel: 'telegram' } } })
    b.onSessionEvent('s1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `Предлагаю: [Завести работу: Починить вход](${url})` }] } } })
    b.onSessionEvent('s1', { type: 'turn/end', data: {} })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.actions).toBeUndefined()
    const link = /\((https:[^)]+)\)/.exec(sent[0]!.body!)![1]!
    expect(params(link)).toEqual({ title: 'Починить вход', exec: EXEC, ws: WS })
    expect(new URL(link).origin).toBe('https://platform.example.com')
  })

  it('длинные result и basis ужимаются до предела канала: ссылка цела, title и прочие поля на месте', async () => {
    const sent: NotificationBody[] = []
    const info = vi.fn()
    const b = new ChannelBridge({ notify: { send: async (body) => { sent.push(body) } }, me: async () => 'me', windowUrl: WINDOW, log: { info, warn: () => undefined } })
    const url = consoleUrl.proposal({ title: 'Счёт (ООО Ромашка)', exec: EXEC, ws: WS, result: 'р'.repeat(2000), basis: 'о'.repeat(2000) })
    expect(url.length).toBeGreaterThan(3500)
    b.onSessionEvent('s1', { type: 'user/message', data: { source: { kind: 'channel', channel: 'telegram' } } })
    b.onSessionEvent('s1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `Предлагаю: [Завести работу](${url}).` }] } } })
    b.onSessionEvent('s1', { type: 'turn/end', data: {} })
    await new Promise(resolve => setTimeout(resolve, 0))
    const body = sent[0]!.body!
    expect(body.length).toBeLessThanOrEqual(3500)
    expect(body).toMatch(/\)\.$/)
    const p = params(/\((https:[^)]+)\)/.exec(body)![1]!)
    expect(p).toMatchObject({ title: 'Счёт (ООО Ромашка)', exec: EXEC, ws: WS })
    expect(p.result).toBe('р'.repeat(200))
    expect(p.basis).toBe('о'.repeat(200))
    expect(info).toHaveBeenCalledWith(`channel: ответ отправлен в канал (${body.length} симв.)`)
  })

  it('fitProposalLinks: короткий текст не трогает; не влезает и так — result и basis отбрасываются; чужие ссылки целы', () => {
    const url = consoleUrl.proposal({ title: 'Отчёт', result: 'р'.repeat(2000) })
    expect(fitProposalLinks(`см. ${url}`, 100_000)).toBe(`см. ${url}`)
    const tight = fitProposalLinks(`см. ${url} и /console/work/new?ws=x и /console/work/TASK-1`, 120)
    expect(tight).toBe(`см. ${consoleUrl.proposal({ title: 'Отчёт' })} и /console/work/new?ws=x и /console/work/TASK-1`)
  })

  it('длинный ответ со ссылкой с неверным due уходит в канал, ссылка не меняется', async () => {
    const sent: NotificationBody[] = []
    const warn = vi.fn()
    const b = new ChannelBridge({ notify: { send: async (body) => { sent.push(body) } }, me: async () => 'me', windowUrl: null, log: { info: () => undefined, warn } })
    const link = `/console/work/new?title=%D0%9E%D1%82%D1%87%D1%91%D1%82&due=friday&result=${'%D1%80'.repeat(100)}`
    const text = `Предлагаю: [Завести работу](${link})\n${'текст '.repeat(700)}`
    expect(text.length).toBeGreaterThan(3500)
    b.onSessionEvent('s1', { type: 'user/message', data: { source: { kind: 'channel', channel: 'telegram' } } })
    b.onSessionEvent('s1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    b.onSessionEvent('s1', { type: 'turn/end', data: {} })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(warn).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.body).toHaveLength(3500)
    expect(sent[0]!.body).toContain(`(${link})`)
  })

  it('fitProposalLinks: неверный due — ссылка как есть, соседние ссылки всё равно ужимаются', () => {
    const bad = '/console/work/new?title=x&due=friday&result=long'
    const good = consoleUrl.proposal({ title: 'Отчёт', result: 'р'.repeat(2000) })
    expect(fitProposalLinks(`${bad} и ${good}`, 120)).toBe(`${bad} и ${consoleUrl.proposal({ title: 'Отчёт' })}`)
    expect(fitProposalLinks(`${bad}.`, 10)).toBe(`${bad}.`)
  })

  it('fitProposalLinks: точка конца предложения после голого адреса не попадает в последнее поле', () => {
    const url = consoleUrl.proposal({ title: 'Отчёт', result: 'р'.repeat(2000), basis: 'письмо' })
    const fitted = fitProposalLinks(`Предлагаю: ${url}. Подпишите?!`, 600)
    expect(fitted).toBe(`Предлагаю: ${consoleUrl.proposal({ title: 'Отчёт', result: 'р'.repeat(50), basis: 'письмо' })}. Подпишите?!`)
    expect(fitted).not.toContain('%2E')
    expect(params(fitted.slice('Предлагаю: '.length).split(' ')[0]!.replace(/\.$/, '')).basis).toBe('письмо')
  })
  it('fitProposalLinks: закрывающая кавычка после адреса остаётся в тексте, basis не меняется', () => {
    const url = consoleUrl.proposal({ title: 'Отчёт', result: 'р'.repeat(2000), basis: 'письмо' })
    const short = consoleUrl.proposal({ title: 'Отчёт', result: 'р'.repeat(50), basis: 'письмо' })
    const window = 'https://console.example/console/assistant'
    for (const [open, close] of [['«', '»'], ['"', '"'], ["'", "'"], ['«', '».']]) {
      const text = absoluteConsoleLinks(`Предлагаю: ${open}${url}${close} Подпишите?`, window)
      const fitted = fitProposalLinks(text, 600)
      expect(fitted).toBe(absoluteConsoleLinks(`Предлагаю: ${open}${short}${close} Подпишите?`, window))
      expect(fitted.endsWith(`${close} Подпишите?`)).toBe(true)
      const found = /\/console\/work\/new\?[^\s<>()\]]+/.exec(fitted)![0].replace(/[.,;:!?»"']+$/, '')
      expect(params(found).basis).toBe('письмо')
    }
  })
})
