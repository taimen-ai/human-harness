/**
 * Contract-тест API поверхности беседы против схем контракта `surface/1`.
 *
 * Схемы в `contract/harness-surface/` — дословная копия контракта платформы
 * `surface/1` (`$id` схем указывает на источник). Репозиторий харнесса отдельный,
 * поэтому копия; при правке контракта обновить её тем же движением.
 *
 * Проверяется: каждое событие потока соответствует event.schema.json; тела,
 * которые схемы message/approval принимают, принимает и контейнер, а те, что
 * схема отвергает, контейнер тоже отвергает (кроме размера контекста — 413).
 *
 * Валидатор — минимальный, ровно под подмножество JSON Schema этих схем
 * (ajv не зависимость пакета, lockfile не трогаем).
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { surfaceHandlers, SurfaceBridge } from '../src/surface.ts'
import { harness, SECRET, SseReader, type Harness } from './surface-harness.ts'

type Schema = Record<string, unknown>
const dir = new URL('./contract/harness-surface/', import.meta.url)
const load = (name: string): Schema => JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as Schema
const files: Record<string, Schema> = Object.fromEntries(['screen-context', 'message', 'event', 'approval'].map(n => [`${n}.schema.json`, load(`${n}.schema.json`)]))

const FORMATS: Record<string, RegExp> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

/** Ошибки значения относительно схемы; пустой список — значение валидно. */
function validate(value: unknown, schema: Schema, root: Schema, path = '$'): string[] {
  const errors: string[] = []
  if (typeof schema.$ref === 'string') {
    const [file, pointer] = schema.$ref.split('#') as [string, string | undefined]
    const base = file === '' ? root : files[file]!
    let target: unknown = base
    for (const part of (pointer ?? '').split('/').filter(Boolean)) target = (target as Schema)[part]
    return validate(value, target as Schema, base, path)
  }
  if (schema.type !== undefined) {
    const t = typeOf(value)
    const ok = schema.type === t || (schema.type === 'number' && t === 'integer')
    if (!ok) return [`${path}: ожидался ${String(schema.type)}, пришёл ${t}`]
  }
  if (schema.enum !== undefined && !(schema.enum as unknown[]).includes(value)) errors.push(`${path}: ${JSON.stringify(value)} не из enum`)
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: не равно const`)
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${path}: короче ${schema.minLength}`)
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${path}: длиннее ${schema.maxLength}`)
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: не по pattern`)
    if (typeof schema.format === 'string' && FORMATS[schema.format] && !FORMATS[schema.format]!.test(value)) errors.push(`${path}: не ${schema.format}`)
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>
    const props = (schema.properties ?? {}) as Record<string, Schema>
    for (const key of (schema.required ?? []) as string[]) if (!(key in obj)) errors.push(`${path}.${key}: обязательно`)
    for (const [key, v] of Object.entries(obj)) {
      if (props[key] !== undefined) errors.push(...validate(v, props[key]!, root, `${path}.${key}`))
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: лишнее поле`)
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const passing = (schema.oneOf as Schema[]).filter(s => validate(value, s, root, path).length === 0).length
    if (passing !== 1) errors.push(`${path}: oneOf совпало ${passing}`)
  }
  for (const sub of (schema.allOf ?? []) as Schema[]) errors.push(...validate(value, sub, root, path))
  if (schema.if !== undefined && validate(value, schema.if as Schema, root, path).length === 0 && schema.then !== undefined) {
    errors.push(...validate(value, schema.then as Schema, root, path))
  }
  return errors
}

const schemaOf = (name: string) => files[`${name}.schema.json`]!
const check = (name: string, value: unknown) => validate(value, schemaOf(name), schemaOf(name))

describe('валидатор схем', () => {
  it('ловит нарушения контракта', () => {
    expect(check('event', { type: 'message', cursor: 'c', at: '2026-09-29T10:00:00.000Z' })).not.toEqual([])
    expect(check('event', { type: 'tool.summary', cursor: 'c', at: '2026-09-29T10:00:00.000Z', turnId: 't', tool: 'x', title: 'y', status: 'started' })).toEqual([])
    expect(check('message', { requestId: 'not-uuid', text: 'x' })).not.toEqual([])
  })
})

const R = (n: number) => `0b6c1f2e-5d3a-4c1b-9e8f-7a6b5c4d3e${String(n).padStart(2, '0')}`
const screen = { kind: 'run', id: 'run-1', label: 'Прогон', url: '/console/runs/run-1', workspaceId: '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', projection: { outcome: 'succeeded' }, capturedAt: '2026-09-29T10:00:00Z' }

let h: Harness
afterEach(async () => { await h?.close() })

describe('события потока — по event.schema.json', () => {
  it('все события сценария (ход консоли, Telegram, инструменты, подтверждения) проходят схему', async () => {
    h = await harness({ timeoutMs: 30 })
    const sse = new SseReader(`${h.base}/internal/harness/surface/stream`, { authorization: `Bearer ${SECRET}` })
    await sse.waitFor(e => e.some(x => x.type === 'ready'))
    h.emit('turn/start', { turn: 1 })
    h.emit('user/message', { id: 'u1', source: { kind: 'surface', surface: 'console', requestId: R(1), screenContext: { kind: 'run', id: 'run-1', url: '/console/runs/run-1' } }, content: [{ type: 'text', text: 'итог?' }] })
    h.surface.onAssistantStream('s1', { type: 'chunk', attemptId: 'att', chunk: { type: 'text-delta', text: 'Ит' } })
    h.emit('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'mcp__dsh__cp_get_run', arguments: '{}' })
    h.emit('tool/result', { turn: 1, step: 1, message: { toolCallId: 'c1', isError: true, content: [] } })
    const approval = h.ask('cp_create_task')
    await h.surface.settled()
    await h.post('/internal/harness/surface/approval', { approvalRequestId: h.hub.pendingIds()[0], decision: 'allow' })
    await approval
    const expiring = h.ask('cp_update_task')
    await expiring
    h.emit('assistant/message', { turn: 1, step: 2, message: { id: 'a1', content: [{ type: 'text', text: 'Итог: успех.' }] } })
    h.emit('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'сбой', code: 'X' } } })
    h.emit('turn/start', { turn: 2 })
    h.emit('user/message', { id: 'u2', source: { kind: 'channel', channel: 'telegram' }, content: [{ type: 'text', text: '[Из Telegram] ок' }] })
    h.emit('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    await sse.waitFor(e => e.filter(x => x.type === 'turn.ended').length === 2)
    sse.close()
    const seen = new Set(sse.events.map(e => e.type))
    for (const type of ['ready', 'message', 'delta', 'turn.started', 'tool.summary', 'approval.requested', 'approval.resolved', 'turn.ended']) expect(seen).toContain(type)
    for (const event of sse.events) {
      const { sseId: _id, sseEvent: _ev, ...data } = event
      expect(check('event', data), JSON.stringify(data)).toEqual([])
    }
    expect(sse.events.filter(e => e.type === 'turn.ended').map(e => e.status)).toEqual(['failed', 'cancelled'])
  })

  it('heartbeat — комментарий потока', async () => {
    const bridge = new SurfaceBridge({ conversation: { sessionId: async () => 's1', deliver: async () => { throw new Error('нет') }, page: async () => ({ events: [], hasMore: false }) }, log: { info: () => undefined, warn: () => undefined } })
    const handlers = surfaceHandlers({ bridge, authorized: () => true, readJson: async () => ({}), heartbeatMs: 20 })
    const server = createServer((req, res) => { void handlers['/internal/harness/surface/stream']!(req, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const sse = new SseReader(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, {})
    await sse.waitFor(() => sse.comments >= 2)
    sse.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
})

describe('тела запросов — по message.schema.json и approval.schema.json', () => {
  const messages: { body: unknown, valid: boolean }[] = [
    { body: { requestId: R(10), text: 'вопрос' }, valid: true },
    { body: { requestId: R(11), text: 'вопрос', screenContext: null }, valid: true },
    { body: { requestId: R(12), text: 'вопрос', screenContext: screen }, valid: true },
    { body: { requestId: R(13), text: 'вопрос', screenContext: { kind: 'pulse', url: '/console' } }, valid: true },
    { body: { requestId: 'r-1', text: 'вопрос' }, valid: false },
    { body: { requestId: R(14), text: '' }, valid: false },
    { body: { requestId: R(15) }, valid: false },
    { body: { requestId: R(16), text: 'x', extra: 1 }, valid: false },
    { body: { requestId: R(17), text: 'x', screenContext: { kind: 'unknown', url: '/x' } }, valid: false },
    { body: { requestId: R(18), text: 'x', screenContext: { kind: 'run', url: 'https://evil/' } }, valid: false },
    { body: { requestId: R(19), text: 'x', screenContext: { kind: 'run', url: '/x', secret: 't' } }, valid: false },
  ]

  it('контейнер принимает ровно то, что принимает схема', async () => {
    h = await harness()
    for (const { body, valid } of messages) {
      expect(check('message', body).length === 0, JSON.stringify(body)).toBe(valid)
      const res = await h.post('/internal/harness/surface/message', body)
      expect(res.status, JSON.stringify(body)).toBe(valid ? 202 : 400)
    }
  })

  it('решение по подтверждению', async () => {
    h = await harness()
    const cases: { body: unknown, valid: boolean }[] = [
      { body: { approvalRequestId: 'a', decision: 'allow' }, valid: true },
      { body: { approvalRequestId: 'a', decision: 'reject', comment: 'нет' }, valid: true },
      { body: { approvalRequestId: 'a', decision: 'approve' }, valid: false },
      { body: { decision: 'allow' }, valid: false },
      { body: { approvalRequestId: 'a', decision: 'allow', surface: 'console' }, valid: false },
    ]
    for (const { body, valid } of cases) {
      expect(check('approval', body).length === 0, JSON.stringify(body)).toBe(valid)
      const res = await h.post('/internal/harness/surface/approval', body)
      // Валидное тело по неизвестному id — 404, невалидное — 400 до поиска.
      expect(res.status, JSON.stringify(body)).toBe(valid ? 404 : 400)
    }
  })
})
