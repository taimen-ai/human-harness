/**
 * MCP-мост: инструменты агента DSH для Claude Code.
 *
 * Claude видит те же инструменты, что цикл DSH передал адаптеру (`GenerateOptions.tools`),
 * со своими JSON Schema, под именами `mcp__dsh__<имя>`. Вызов исполняется через
 * `ctx.tools.execute` — весь конвейер DSH: политики `tools/pre-execute`,
 * подтверждение человека (`ctx.approval`), песочница, `tools/post-execute`.
 * Собственных встроенных инструментов у Claude нет (`tools: []`), поэтому мимо
 * конвейера DSH он ничего не выполняет.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'

export const SERVER_NAME = 'dsh'
export const TOOL_PREFIX = `mcp__${SERVER_NAME}__`

/** Итог одного вызова инструмента в форме, которую понимает мост. */
export interface BridgeResult {
  isError: boolean
  content: readonly ContentBlock[]
}

/** Исполнить инструмент DSH по имени и аргументам (в плагине — `ctx.tools.execute`). */
export type ExecuteTool = (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<BridgeResult>

/** Наблюдатель вызовов — для строк активности в ленте. */
export type ToolObserver = (event: { phase: 'start', name: string, args: Record<string, unknown> } | { phase: 'end', name: string, isError: boolean }) => void

interface McpContent { type: 'text', text: string }

function toMcpContent(blocks: readonly ContentBlock[]): McpContent[] {
  const content: McpContent[] = []
  for (const block of blocks) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text })
    else if (block.type === 'image') content.push({ type: 'text', text: '[изображение в результате инструмента не передаётся]' })
    else if (block.type !== 'reasoning') content.push({ type: 'text', text: JSON.stringify(block) })
  }
  return content.length > 0 ? content : [{ type: 'text', text: '(пустой результат)' }]
}

/** JSON Schema аргументов как `inputSchema` MCP: всегда объект. */
export function inputSchema(parameters: Record<string, unknown>): Record<string, unknown> & { type: 'object' } {
  return { ...parameters, type: 'object' }
}

/**
 * Создать in-process MCP-сервер с инструментами агента.
 * @param tools - схемы инструментов текущего шага цикла DSH.
 * @param execute - исполнитель инструментов DSH.
 * @param signal - отмена хода: вызовы после неё не начинаются.
 * @param observe - наблюдатель вызовов (строки активности).
 */
export function createBridge(tools: readonly ToolSchema[], execute: ExecuteTool, signal: AbortSignal, observe?: ToolObserver): McpServer {
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  const mcp = new McpServer({ name: SERVER_NAME, version: '0.1.0' }, { capabilities: { tools: {} } })
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: inputSchema(tool.parameters) })),
  }))
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    const args = (request.params.arguments ?? {}) as Record<string, unknown>
    if (!byName.has(name)) {
      return { isError: true, content: [{ type: 'text' as const, text: `Инструмента «${name}» нет у этого агента.` }] }
    }
    if (signal.aborted) {
      return { isError: true, content: [{ type: 'text' as const, text: 'Ход отменён.' }] }
    }
    observe?.({ phase: 'start', name, args })
    try {
      const result = await execute(name, args, signal)
      observe?.({ phase: 'end', name, isError: result.isError })
      return { isError: result.isError, content: toMcpContent(result.content) }
    } catch (error) {
      observe?.({ phase: 'end', name, isError: true })
      return { isError: true, content: [{ type: 'text' as const, text: `Инструмент «${name}» упал: ${String(error)}` }] }
    }
  })
  return mcp
}
