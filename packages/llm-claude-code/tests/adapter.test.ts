/**
 * Адаптер `claude-code` против поддельного Claude Agent SDK. Поток проверяется
 * штатным сборщиком DSH (`BlockAssembler`) — тот же алгоритм собирает ответ в
 * цикле агента, значит адаптер соблюдает контракт потока DSH.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { BlockAssembler, type GenerateOptions, type RequestMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AUTH_TEXT, ClaudeCodeAdapter, RATE_LIMIT_TEXT, type RunQuery } from '../src/adapter.ts'
import { createBridge, TOOL_PREFIX, type ExecuteTool } from '../src/bridge.ts'
import { coldPrompt, turnInput } from '../src/messages.ts'
import { SessionLinks } from '../src/sessions.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'claude-code-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const system = (text: string): RequestMessage => ({ id: 'm0', role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } }) as unknown as RequestMessage
const user = (id: string, text: string): RequestMessage => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }) as unknown as RequestMessage
const assistant = (id: string, text: string): RequestMessage => ({ id, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'claude-code', model: 'm' } }) as unknown as RequestMessage

function sdk(session: string, events: object[]): SDKMessage[] {
  return events.map(event => ({ session_id: session, uuid: 'u', parent_tool_use_id: null, ...event }) as unknown as SDKMessage)
}

const streamed = (id: string, text: string): object[] => [
  { type: 'stream_event', event: { type: 'message_start', message: { id } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
  { type: 'assistant', message: { id, content: [{ type: 'text', text }] } },
]
const result = { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90 } }

function adapter(runQuery: RunQuery, toolsFor: (id: string) => ExecuteTool | undefined = () => undefined) {
  const links = new SessionLinks(join(dir, 'links.json'))
  return { links, adapter: new ClaudeCodeAdapter({ runQuery, links, toolsFor, cwd: dir, models: [{ id: 'claude-sonnet-5', name: 'Sonnet' }], maxTurns: 40 }) }
}

async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = []
  const assembler = new BlockAssembler()
  for await (const chunk of stream) { chunks.push(chunk); assembler.push(chunk) }
  return { chunks, blocks: assembler.blocks(), usage: assembler.usage, finish: assembler.finish }
}

function request(messages: RequestMessage[], over: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'claude-code', model: 'claude-sonnet-5', messages, sessionId: 'dsh-1' as GenerateOptions['sessionId'], ...over }
}

describe('разбор истории', () => {
  it('новый ввод — хвост после последнего ответа, промпт — ведущее system-сообщение', () => {
    const input = turnInput([system('ты ассистент'), user('1', 'привет'), assistant('2', 'здравствуй'), user('3', 'что по счёту?')])
    expect(input.system).toBe('ты ассистент')
    expect(input.prompt).toBe('что по счёту?')
    expect(input.transcript).toContain('Пользователь: привет')
    expect(coldPrompt(input)).toContain('<conversation>')
  })

  it('контекст роли user подписан по источнику, а не «Пользователь»', () => {
    const context = (id: string, text: string, source: object): RequestMessage => ({ id, role: 'user', content: [{ type: 'text', text }], source }) as unknown as RequestMessage
    const input = turnInput([
      system('ты ассистент'),
      user('1', 'привет'),
      assistant('2', 'здравствуй'),
      user('3', 'почему стоит?'),
      context('4', '<screen-context>\nэкран\n</screen-context>', { kind: 'screen-context', form: 'snapshot', sections: [] }),
      context('5', 'сейчас 10:00', { kind: 'time-context', form: 'snapshot', sections: [] }),
      context('6', '[Из Telegram] ок', { kind: 'channel', channel: 'telegram' }),
    ])
    expect(input.transcript).toContain('Пользователь: почему стоит?')
    expect(input.transcript).toContain('Контекст экрана: <screen-context>')
    expect(input.transcript).toContain('Контекст: сейчас 10:00')
    expect(input.transcript).toContain('Пользователь: [Из Telegram] ок')
    expect(input.transcript).not.toContain('Пользователь: <screen-context>')
  })
})

describe('ClaudeCodeAdapter', () => {
  it('отдаёт текст по контракту DSH, запоминает сессию Claude и usage', async () => {
    const calls: { prompt: string, options: Options }[] = []
    const { adapter: a, links } = adapter(async function* ({ prompt, options }) {
      calls.push({ prompt, options })
      yield* sdk('claude-A', [...streamed('msg1', 'Готово.'), result])
    })
    const out = await collect(a.stream(request([system('p'), user('1', 'сделай')])))
    expect(out.blocks).toEqual([{ type: 'text', text: 'Готово.' }])
    expect(out.finish).toEqual({ kind: 'stop' })
    expect(out.usage).toMatchObject({ inputTokens: 100, outputTokens: 5, cacheReadTokens: 90 })
    expect((await links.get('dsh-1'))?.claudeSessionId).toBe('claude-A')
    expect(calls[0]!.options).toMatchObject({ tools: [], settingSources: [], strictMcpConfig: true, systemPrompt: 'p', model: 'claude-sonnet-5' })
    expect(calls[0]!.options.resume).toBeUndefined()
  })

  it('следующий ход продолжает сессию Claude и шлёт только новый ввод', async () => {
    const calls: { prompt: string, options: Options }[] = []
    const { adapter: a, links } = adapter(async function* ({ prompt, options }) {
      calls.push({ prompt, options })
      yield* sdk('claude-A', [...streamed('m', 'ок'), result])
    })
    await links.set('dsh-1', 'claude-A')
    await collect(a.stream(request([system('p'), user('1', 'раз'), assistant('2', 'ок'), user('3', 'два')])))
    expect(calls[0]!.options.resume).toBe('claude-A')
    expect(calls[0]!.prompt).toBe('два')
  })

  it('потерянная сессия Claude — повтор хода со всей историей', async () => {
    const calls: { prompt: string, options: Options }[] = []
    const { adapter: a, links } = adapter(async function* ({ prompt, options }) {
      calls.push({ prompt, options })
      if (options.resume) throw new Error('No conversation found with session ID: claude-OLD')
      yield* sdk('claude-NEW', [...streamed('m', 'продолжаю'), result])
    })
    await links.set('dsh-1', 'claude-OLD')
    const out = await collect(a.stream(request([system('p'), user('1', 'раз'), assistant('2', 'ок'), user('3', 'два')])))
    expect(out.blocks).toEqual([{ type: 'text', text: 'продолжаю' }])
    expect(calls).toHaveLength(2)
    expect(calls[1]!.options.resume).toBeUndefined()
    expect(calls[1]!.prompt).toContain('Пользователь: раз')
    expect((await links.get('dsh-1'))?.claudeSessionId).toBe('claude-NEW')
  })

  it('лимит подписки — понятный ответ, а не ошибка цикла', async () => {
    const { adapter: a } = adapter(async function* () {
      yield* sdk('c', [{ type: 'assistant', error: 'rate_limit', message: { id: 'x', content: [] } }, result])
    })
    const out = await collect(a.stream(request([user('1', 'привет')])))
    expect(out.blocks).toEqual([{ type: 'text', text: RATE_LIMIT_TEXT }])
    expect(out.finish).toEqual({ kind: 'stop' })
  })

  it('истёкший токен подписки — понятный ответ, сессия Claude не теряется', async () => {
    const { adapter: a, links } = adapter(async function* () {
      throw new Error('Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed')
    })
    await links.set('dsh-1', 'claude-A')
    const out = await collect(a.stream(request([user('1', 'привет')])))
    expect(out.blocks).toEqual([{ type: 'text', text: AUTH_TEXT }])
    expect(out.finish).toEqual({ kind: 'stop' })
    expect((await links.get('dsh-1'))?.claudeSessionId).toBe('claude-A')
  })

  it('встроенные инструменты Claude запрещены, инструменты харнесса разрешены', async () => {
    let options: Options | undefined
    const { adapter: a } = adapter(async function* (params) { options = params.options; yield* sdk('c', [result]) })
    await collect(a.stream(request([user('1', 'x')])))
    const can = options!.canUseTool!
    const signal = new AbortController().signal
    expect(await can('Bash', {}, { signal } as never)).toMatchObject({ behavior: 'deny' })
    expect(await can(`${TOOL_PREFIX}cp_whoami`, {}, { signal } as never)).toMatchObject({ behavior: 'allow' })
  })

  it('вспомогательный вызов (заголовок сессии) — без инструментов и без сессии Claude', async () => {
    let options: Options | undefined
    const { adapter: a, links } = adapter(async function* (params) { options = params.options; yield* sdk('aux', [...streamed('t', 'Счёт поставщика'), result]) })
    await collect(a.stream(request([user('1', 'x')], { purpose: 'session-title' })))
    expect(options).toMatchObject({ persistSession: false, maxTurns: 1 })
    expect(options!.mcpServers).toBeUndefined()
    expect(await links.get('dsh-1')).toBeUndefined()
  })
})

describe('MCP-мост', () => {
  async function connect(server: McpServer): Promise<Client> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientSide)
    return client
  }

  it('отдаёт инструменты агента с их схемами и исполняет через DSH', async () => {
    const executed: { name: string, args: unknown }[] = []
    const events: string[] = []
    const execute: ExecuteTool = async (name, args) => {
      executed.push({ name, args })
      return { isError: false, content: [{ type: 'text', text: 'TASK-000001' }] }
    }
    const server = createBridge(
      [{ name: 'cp_get_task', description: 'Задача', parameters: { properties: { ref: { type: 'string' } }, required: ['ref'] } }],
      execute, new AbortController().signal, e => events.push(`${e.phase}:${e.name}`),
    )
    const client = await connect(server)
    const listed = await client.listTools()
    expect(listed.tools[0]).toMatchObject({ name: 'cp_get_task', inputSchema: { type: 'object', required: ['ref'] } })
    const called = await client.callTool({ name: 'cp_get_task', arguments: { ref: 'TASK-000001' } })
    expect(called).toMatchObject({ isError: false, content: [{ type: 'text', text: 'TASK-000001' }] })
    expect(executed).toEqual([{ name: 'cp_get_task', args: { ref: 'TASK-000001' } }])
    expect(events).toEqual(['start:cp_get_task', 'end:cp_get_task'])
    expect(await client.callTool({ name: 'rm_rf', arguments: {} })).toMatchObject({ isError: true })
    await client.close()
  })
})

describe('связи сессий', () => {
  it('переживают перезапуск: запись атомарна и читается заново', async () => {
    const path = join(dir, 'links.json')
    await new SessionLinks(path).set('dsh-1', 'claude-A')
    expect(await new SessionLinks(path).get('dsh-1')).toMatchObject({ claudeSessionId: 'claude-A' })
    expect(JSON.parse(await readFile(path, 'utf8'))['dsh-1'].claudeSessionId).toBe('claude-A')
  })
})
