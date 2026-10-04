/**
 * Адаптер модели DSH «claude-code» (TAI-ADR-0051 п.4, амендмент 2026-09-26).
 *
 * Один вызов модели циклом DSH = один ход Claude Code (Claude Agent SDK) с
 * `resume` сессии Claude, привязанной к сессии DSH. Внутри хода Claude сам
 * вызывает инструменты агента DSH через MCP-мост (`bridge.ts`), поэтому адаптер
 * отдаёт циклу финальный текст без блоков `tool-call`: цикл DSH записывает
 * ответ ассистента и заканчивает ход. Вызовы инструментов видны строками в блоке
 * рассуждений. Токен подписки (`CLAUDE_CODE_OAUTH_TOKEN`) читает сам Claude Code
 * из окружения процесса; адаптер его не касается и никуда не пишет.
 */
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  ContentBlock, GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk, TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { createBridge, SERVER_NAME, TOOL_PREFIX, type ExecuteTool } from './bridge.ts'
import { coldPrompt, turnInput } from './messages.ts'
import type { SessionLinks } from './sessions.ts'

export const PROVIDER = 'claude-code'

/** Запуск хода Claude Agent SDK (`query`); подменяется в тестах. */
export type RunQuery = (params: { prompt: string, options: Options }) => AsyncIterable<SDKMessage>

export interface ClaudeCodeAdapterOptions {
  runQuery: RunQuery
  links: SessionLinks
  /** Исполнитель инструментов DSH для сессии; undefined — у сессии нет живого агента. */
  toolsFor: (sessionId: string) => ExecuteTool | undefined
  /** Рабочий каталог Claude Code: от него зависит место транскриптов, `resume` требует тот же. */
  cwd: string
  models: readonly { id: string, name: string }[]
  maxTurns: number
  /**
   * Токен подписки на каждый ход (файл секрета контейнера). Передаётся только процессу
   * Claude Code, в окружении DSH его нет — инструмент Bash ассистента его не видит.
   */
  oauthToken?: () => string | undefined
  log?: (message: string) => void
}

export const AUTH_TEXT = 'Claude Code не авторизован: токен подписки истёк или не задан. Обновите его (`claude setup-token`) в секретах харнесса — до этого ассистент не отвечает, а экран «Важное» и уведомления работают.'

/** Ошибка авторизации Claude Code (истёкший или отсутствующий токен подписки). */
function isAuthFailure(error: unknown): boolean {
  return /failed to authenticate|oauth session expired|invalid api key|not logged in|authentication_failed/i.test(String(error))
}

export const RATE_LIMIT_TEXT = 'Лимит подписки Claude сейчас исчерпан — ответить не получится. Экран «Важное» и уведомления продолжают работать; попробуйте позже.'

/** Сборка потока блоков DSH: текст и строки активности, индексы по порядку появления. */
class Blocks {
  private next = 0
  private readonly open = new Map<'text' | 'reasoning', { index: number, text: string }>()
  private readonly order: ('text' | 'reasoning')[] = []

  append(kind: 'text' | 'reasoning', text: string): StreamChunk[] {
    if (text === '') return []
    const chunks: StreamChunk[] = []
    let block = this.open.get(kind)
    if (block === undefined) {
      block = { index: this.next++, text: '' }
      this.open.set(kind, block)
      this.order.push(kind)
      chunks.push({ type: 'block-start', index: block.index, blockType: kind })
    }
    block.text += text
    chunks.push(kind === 'text'
      ? { type: 'text-delta', index: block.index, text }
      : { type: 'reasoning-delta', index: block.index, text })
    return chunks
  }

  hasText(): boolean {
    return (this.open.get('text')?.text ?? '') !== ''
  }

  close(): StreamChunk[] {
    return this.order.map((kind) => {
      const block = this.open.get(kind)!
      const assembled: ContentBlock = kind === 'text' ? { type: 'text', text: block.text } : { type: 'reasoning', text: block.text }
      return { type: 'block-end', index: block.index, block: assembled }
    })
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  const text = JSON.stringify(args)
  return text.length > 120 ? `${text.slice(0, 117)}…` : text
}

function usageOf(message: Extract<SDKMessage, { type: 'result' }>): TokenUsage {
  const usage = message.usage as unknown as Record<string, number | undefined>
  const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  const output = usage.output_tokens ?? 0
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    ...(usage.cache_read_input_tokens ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
    ...(usage.cache_creation_input_tokens ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}),
  }
}

/** Признак потерянной сессии Claude: транскрипт не найден, `resume` невозможен. */
function isMissingSession(error: unknown): boolean {
  return /no conversation found|session.*not found|could not resume/i.test(String(error))
}

/** Готовый ответ без вызова модели: один текстовый блок и `stop`. */
function* answer(text: string): Iterable<StreamChunk> {
  const blocks = new Blocks()
  yield* blocks.append('text', text)
  yield* blocks.close()
  yield { type: 'finish', reason: { kind: 'stop' } }
}

export class ClaudeCodeAdapter {
  constructor(private readonly options: ClaudeCodeAdapterOptions) {}

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Claude Code' }
  }

  providerRetryPolicy(): undefined {
    return undefined
  }

  imageRequestPricing(): undefined {
    return undefined
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.options.models.map(model => ({ provider, id: model.id, name: model.name }))
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const known = this.options.models.find(m => m.id === model)
    return { provider, id: model, name: known?.name ?? model }
  }

  async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) }
  }

  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    const input = turnInput(request.messages, request.system)
    const sessionId = request.sessionId as string | undefined
    // Вспомогательный вызов (заголовок сессии, сжатие) — без инструментов и без сессии Claude.
    const auxiliary = request.purpose !== undefined || sessionId === undefined
    const execute = auxiliary ? undefined : this.options.toolsFor(sessionId!)
    const link = auxiliary ? undefined : await this.options.links.get(sessionId!)
    try {
      yield* this.turn(request, input, execute, link?.claudeSessionId, sessionId, auxiliary)
    } catch (error) {
      if (isAuthFailure(error)) {
        this.options.log?.('claude-code: ошибка авторизации Claude Code')
        yield* answer(AUTH_TEXT)
        return
      }
      if (link === undefined || !isMissingSession(error)) throw error
      // Транскрипт Claude потерян (новый контейнер без volume): история уходит текстом.
      this.options.log?.(`claude-code: сессия ${link.claudeSessionId} не найдена, ход со всей историей`)
      await this.options.links.forget(sessionId!)
      yield* this.turn(request, input, execute, undefined, sessionId, auxiliary)
    }
  }

  private async *turn(
    request: GenerateOptions,
    input: ReturnType<typeof turnInput>,
    execute: ExecuteTool | undefined,
    resume: string | undefined,
    sessionId: string | undefined,
    auxiliary: boolean,
  ): AsyncIterable<StreamChunk> {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    request.signal?.addEventListener('abort', onAbort, { once: true })
    const blocks = new Blocks()
    const activity: string[] = []
    const tools = execute === undefined ? [] : (request.tools ?? [])
    const bridge = tools.length === 0 || execute === undefined
      ? undefined
      : createBridge(tools, execute, controller.signal, (event) => {
        activity.push(event.phase === 'start'
          ? `→ ${event.name} ${summarizeArgs(event.args)}\n`
          : `${event.isError ? '✗' : '✓'} ${event.name}\n`)
      })
    const token = this.options.oauthToken?.()
    const options: Options = {
      model: request.model,
      cwd: this.options.cwd,
      abortController: controller,
      includePartialMessages: true,
      maxTurns: auxiliary ? 1 : this.options.maxTurns,
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      persistSession: !auxiliary,
      permissionMode: 'default',
      ...(token !== undefined ? { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token } } : {}),
      canUseTool: async (toolName) => toolName.startsWith(TOOL_PREFIX)
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: 'Встроенные инструменты Claude Code отключены: пользуйтесь инструментами харнесса.' },
      ...(input.system !== '' ? { systemPrompt: input.system } : {}),
      ...(bridge ? { mcpServers: { [SERVER_NAME]: { type: 'sdk' as const, name: SERVER_NAME, instance: bridge } } } : {}),
      ...(resume ? { resume } : {}),
    }
    const prompt = resume ? input.prompt : coldPrompt(input)
    const streamedMessages = new Set<string>()
    let currentMessage: string | undefined
    let usage: TokenUsage | undefined
    let rateLimited = false
    try {
      for await (const message of this.options.runQuery({ prompt: prompt === '' ? '…' : prompt, options })) {
        if (!auxiliary && sessionId !== undefined && 'session_id' in message && typeof message.session_id === 'string' && message.session_id !== '') {
          await this.options.links.set(sessionId, message.session_id)
        }
        // Строки активности — между сообщениями, когда вызов уже начался или закончился.
        while (activity.length > 0) yield* blocks.append('reasoning', activity.shift()!)
        if (message.type === 'assistant' && message.error === 'authentication_failed') throw new Error('authentication_failed')
        if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
          const event = message.event
          if (event.type === 'message_start') {
            currentMessage = event.message.id
            if (blocks.hasText()) yield* blocks.append('text', '\n\n')
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              if (currentMessage !== undefined) streamedMessages.add(currentMessage)
              yield* blocks.append('text', event.delta.text)
            } else if (event.delta.type === 'thinking_delta') {
              yield* blocks.append('reasoning', event.delta.thinking)
            }
          }
        } else if (message.type === 'assistant' && message.parent_tool_use_id === null) {
          if (message.error === 'rate_limit') rateLimited = true
          // Без частичных сообщений текст приходит целиком — отдаём его, если не стримили.
          if (!streamedMessages.has(message.message.id)) {
            for (const block of message.message.content) {
              if (block.type === 'text') yield* blocks.append('text', (blocks.hasText() ? '\n\n' : '') + block.text)
            }
          }
        } else if (message.type === 'result') {
          usage = usageOf(message)
          if (message.subtype !== 'success' && !blocks.hasText()) {
            yield* blocks.append('text', message.subtype === 'error_max_turns'
              ? 'Ход ассистента превысил лимит шагов и остановлен. Напишите, продолжить ли.'
              : 'Ход ассистента прервался с ошибкой. Попробуйте ещё раз.')
          }
        }
      }
    } finally {
      request.signal?.removeEventListener('abort', onAbort)
      await bridge?.close().catch(() => undefined)
    }
    while (activity.length > 0) yield* blocks.append('reasoning', activity.shift()!)
    if (rateLimited && !blocks.hasText()) yield* blocks.append('text', RATE_LIMIT_TEXT)
    yield* blocks.close()
    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
