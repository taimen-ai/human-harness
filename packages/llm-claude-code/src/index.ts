/**
 * `@human-harness/dsh-llm-claude-code` — провайдер модели DSH `claude-code`: ход
 * ассистента Human Harness исполняет Claude Code по подписке владельца
 * (TAI-ADR-0051 п.4, амендмент 2026-09-26). Цикл агента, сессии, журнал,
 * подтверждения и проактивный `followup` остаются штатными DSH.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import { ClaudeCodeAdapter, PROVIDER } from './adapter.ts'
import type { ExecuteTool } from './bridge.ts'
import { defaultStateDir, SessionLinks } from './sessions.ts'

export { ClaudeCodeAdapter, PROVIDER, RATE_LIMIT_TEXT, type RunQuery } from './adapter.ts'
export { createBridge, inputSchema, TOOL_PREFIX } from './bridge.ts'
export { coldPrompt, turnInput } from './messages.ts'
export { SessionLinks } from './sessions.ts'

export const name = 'harness-llm-claude-code'
export const inject = ['llm', 'tools', 'agents']

export interface ModelEntry {
  id: string
  name: string
}

export interface Config {
  /** Модели, которые провайдер объявляет в выборе DSH. */
  models: ModelEntry[]
  /** Лимит шагов Claude Code на один ход ассистента. */
  maxTurns: number
  /** Каталог состояния: связи сессий и рабочий каталог Claude Code (по умолчанию $DSH_HOME/harness). */
  stateDir?: string
  /** Файл с токеном подписки (`claude setup-token`); иначе Claude Code берёт `CLAUDE_CODE_OAUTH_TOKEN` из окружения. */
  oauthTokenFile?: string
}

export const Config: Schema<Config> = Schema.object({
  models: Schema.array(Schema.object({
    id: Schema.string().required(),
    name: Schema.string().required(),
  })).default([
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
  ]),
  maxTurns: Schema.number().default(40),
  stateDir: Schema.string().description('Каталог состояния провайдера (по умолчанию $DSH_HOME/harness)'),
  oauthTokenFile: Schema.string().description('Файл токена подписки Claude'),
})

/** Токен перечитывается на каждый ход: владелец меняет файл без перезапуска контейнера. */
function readToken(path: string): string | undefined {
  try {
    const token = readFileSync(path, 'utf8').trim()
    return token === '' ? undefined : token
  } catch {
    return undefined
  }
}

export function apply(ctx: Context, config: Config): void {
  const stateDir = config.stateDir ?? defaultStateDir()
  // Рабочий каталог Claude Code постоянный: от него зависит место транскриптов, а resume требует тот же.
  const cwd = join(stateDir, 'claude-code')
  mkdirSync(cwd, { recursive: true, mode: 0o700 })

  const toolsFor = (sessionId: string): ExecuteTool | undefined => {
    const agent = ctx.agents.get(sessionId as Parameters<typeof ctx.agents.get>[0])
    if (agent === undefined) return undefined
    return async (toolName, args, signal) => {
      const result = await ctx.tools.execute({
        callId: `claude-code:${randomUUID()}` as ToolCallId,
        name: toolName,
        arguments: args,
        agent,
        signal,
      })
      return { isError: result.isError, content: result.content }
    }
  }

  const adapter = new ClaudeCodeAdapter({
    runQuery: ({ prompt, options }) => query({ prompt, options }),
    links: new SessionLinks(join(stateDir, 'claude-sessions.json')),
    toolsFor,
    cwd,
    models: config.models,
    maxTurns: config.maxTurns,
    ...(config.oauthTokenFile ? { oauthToken: () => readToken(config.oauthTokenFile!) } : {}),
    log: message => ctx.logger.info(message),
  })
  ctx.llm.registerAdapter([PROVIDER], adapter as unknown as LlmAdapter)
  ctx.logger.info(`claude-code: провайдер зарегистрирован, моделей ${config.models.length}`)
}
