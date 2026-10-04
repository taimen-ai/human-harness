/**
 * Правила значимости событий для проактивного ассистента (TAI-ADR-0051 п.6,
 * spec human-harness FR-003/FR-004). Правила — данные (`attention-rules.json`,
 * схема `attention-rules.schema.json`), код знает только закрытый набор
 * отношений «касается меня» и подстановку шаблонов.
 *
 * Событие проверяется правилами по порядку файла, срабатывает первое подходящее.
 * `significance: now` — ассистент приходит сам (через группировку лавины),
 * `digest` — только в сводку «пока тебя не было».
 */
import type { JournalEvent } from './events.ts'

/** Отношение события к человеку. Набор закрыт: новое отношение — правка кода и схемы. */
export type Concern =
  | 'any'
  /** Согласование назначено человеку или его роли. */
  | 'approval-mine'
  /** Задача события назначена человеку. */
  | 'task-assignee'
  /** Задачу события поставил человек (поручение). */
  | 'task-creator'
  /** Человек — исполнитель, автор или владелец задачи. */
  | 'task-involves'

export const CONCERNS: readonly Concern[] = ['any', 'approval-mine', 'task-assignee', 'task-creator', 'task-involves']

export interface AttentionRule {
  key: string
  version: number
  /** Точные типы событий. */
  on: string[]
  concerns: Concern
  /** Условия по полям события: путь через точку → значение или список значений; `$me` — principal человека. */
  when?: Record<string, unknown>
  /** Пропускать действия самого человека (по умолчанию да). */
  skipOwnActions?: boolean
  significance: 'now' | 'digest'
  /** Что произошло — шаблон с `{{путь}}`. */
  message: string
  /** Какое действие предложить человеку — шаблон. */
  action: string
}

export interface RuleSet {
  version: 1
  rules: AttentionRule[]
}

export interface Me {
  principalId: string
  roleIds: string[]
}

export interface TaskFacts {
  id: string
  publicId: string
  title: string
  assigneeId: string | null
  createdBy: string | null
  ownerId: string | null
}

export interface AttentionMatch {
  /** `ruleKey@version`. */
  rule: string
  significance: 'now' | 'digest'
  message: string
  action: string
  eventId: string
  eventType: string
  occurredAt: string
  /** Публичный id задачи, если событие о задаче. */
  ref: string | null
  entityType: string
  entityId: string
}

export class RuleError extends Error {}

const KEY = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/
const TYPE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/

/** Разобрать и проверить файл правил; ошибка называет правило и поле. */
export function parseRules(input: unknown): RuleSet {
  const doc = input as { version?: unknown, rules?: unknown }
  if (doc === null || typeof doc !== 'object' || doc.version !== 1 || !Array.isArray(doc.rules)) {
    throw new RuleError('attention-rules: ожидается {"version": 1, "rules": [...]}')
  }
  const seen = new Set<string>()
  const rules = doc.rules.map((raw, index): AttentionRule => {
    const r = raw as Record<string, unknown>
    const where = `attention-rules: правило #${index + 1}${typeof r.key === 'string' ? ` (${r.key})` : ''}`
    if (typeof r.key !== 'string' || !KEY.test(r.key)) throw new RuleError(`${where}: key — точечное имя в нижнем регистре`)
    if (!Number.isInteger(r.version) || (r.version as number) < 1) throw new RuleError(`${where}: version — целое ≥ 1`)
    const ref = `${r.key}@${String(r.version)}`
    if (seen.has(ref)) throw new RuleError(`${where}: ${ref} повторяется`)
    seen.add(ref)
    if (!Array.isArray(r.on) || r.on.length === 0 || !r.on.every(t => typeof t === 'string' && TYPE.test(t))) {
      throw new RuleError(`${where}: on — непустой список типов событий`)
    }
    if (!CONCERNS.includes(r.concerns as Concern)) throw new RuleError(`${where}: concerns — одно из ${CONCERNS.join(', ')}`)
    if (r.when !== undefined && (r.when === null || typeof r.when !== 'object' || Array.isArray(r.when))) throw new RuleError(`${where}: when — объект условий`)
    if (r.skipOwnActions !== undefined && typeof r.skipOwnActions !== 'boolean') throw new RuleError(`${where}: skipOwnActions — boolean`)
    if (r.significance !== 'now' && r.significance !== 'digest') throw new RuleError(`${where}: significance — now или digest`)
    for (const field of ['message', 'action'] as const) {
      if (typeof r[field] !== 'string' || (r[field] as string).trim() === '') throw new RuleError(`${where}: ${field} — непустая строка`)
    }
    const allowed = new Set(['key', 'version', 'on', 'concerns', 'when', 'skipOwnActions', 'significance', 'message', 'action', 'description'])
    for (const name of Object.keys(r)) if (!allowed.has(name)) throw new RuleError(`${where}: неизвестное поле ${name}`)
    return {
      key: r.key, version: r.version as number, on: r.on as string[], concerns: r.concerns as Concern,
      ...(r.when === undefined ? {} : { when: r.when as Record<string, unknown> }),
      ...(r.skipOwnActions === undefined ? {} : { skipOwnActions: r.skipOwnActions }),
      significance: r.significance, message: r.message as string, action: r.action as string,
    }
  })
  return { version: 1, rules }
}

/** id задачи, к которой относится событие: сама задача или `payload.taskId`. */
export function taskIdOf(event: JournalEvent): string | null {
  if (event.entityType === 'task') return event.entityId
  const id = event.payload.taskId
  return typeof id === 'string' ? id : null
}

function lookup(view: Record<string, unknown>, path: string): unknown {
  let value: unknown = view
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

/** Подстановка `{{путь}}`; отсутствующее значение — пусто, длинное — обрезается. */
export function render(template: string, view: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const value = lookup(view, path)
    if (value === undefined || value === null) return ''
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text.length > 300 ? `${text.slice(0, 299)}…` : text
  }).replace(/\s+/g, ' ').trim()
}

function whenHolds(when: Record<string, unknown> | undefined, view: Record<string, unknown>, me: Me): boolean {
  if (when === undefined) return true
  return Object.entries(when).every(([path, expected]) => {
    const actual = lookup(view, path)
    const options = (Array.isArray(expected) ? expected : [expected]).map(v => (v === '$me' ? me.principalId : v))
    return options.some(v => v === actual)
  })
}

function concerns(concern: Concern, event: JournalEvent, me: Me, task: TaskFacts | null): boolean {
  switch (concern) {
    case 'any': return true
    case 'approval-mine': {
      const assigned = event.payload.assignedPrincipalId
      const role = event.payload.requiredRoleId
      return assigned === me.principalId || (typeof role === 'string' && me.roleIds.includes(role))
    }
    case 'task-assignee': return task !== null && task.assigneeId === me.principalId
    case 'task-creator': return task !== null && task.createdBy === me.principalId
    case 'task-involves': return task !== null && [task.assigneeId, task.createdBy, task.ownerId].includes(me.principalId)
  }
}

export interface EvaluateDeps {
  me: Me
  /** Факты задачи по id; null — задачи нет или она не видна. */
  task: (id: string) => Promise<TaskFacts | null>
}

/** Первое сработавшее правило для события или null (событие человека не касается). */
export async function evaluate(rules: RuleSet, event: JournalEvent, deps: EvaluateDeps): Promise<AttentionMatch | null> {
  const candidates = rules.rules.filter(r => r.on.includes(event.type))
  if (candidates.length === 0) return null
  const taskId = taskIdOf(event)
  let task: TaskFacts | null | undefined
  const loadTask = async (): Promise<TaskFacts | null> => {
    if (task === undefined) task = taskId === null ? null : await deps.task(taskId)
    return task
  }
  for (const rule of candidates) {
    if ((rule.skipOwnActions ?? true) && event.actorId !== null && event.actorId === deps.me.principalId) continue
    const needsTask = rule.concerns.startsWith('task-') || /\{\{\s*task\./.test(rule.message + rule.action)
      || Object.keys(rule.when ?? {}).some(p => p.startsWith('task.'))
    const facts = needsTask ? await loadTask() : null
    const view: Record<string, unknown> = { ...event, payload: event.payload, task: facts ?? {} }
    if (!whenHolds(rule.when, view, deps.me)) continue
    if (!concerns(rule.concerns, event, deps.me, facts)) continue
    const ref = facts?.publicId ?? (typeof event.payload.taskPublicId === 'string' ? event.payload.taskPublicId
      : typeof event.payload.publicId === 'string' ? event.payload.publicId : null)
    return {
      rule: `${rule.key}@${rule.version}`,
      significance: rule.significance,
      message: render(rule.message, view),
      action: render(rule.action, view),
      eventId: event.id,
      eventType: event.type,
      occurredAt: event.occurredAt,
      ref,
      entityType: event.entityType,
      entityId: event.entityId,
    }
  }
  return null
}

/** Префиксы типов для фильтра `GET /events`: все типы из правил. */
export function eventTypesOf(rules: RuleSet): string[] {
  return [...new Set(rules.rules.flatMap(r => r.on))].sort()
}
