/**
 * Экземпляр процесса глазами ассистента: состояние, текущий шаг, шаг и ошибка
 * падения из журнала решений, работа, которую экземпляр завёл, и задача-исправление.
 *
 * Эндпоинты — те же, что у операторских `cp_process_get` / `cp_process_explain`:
 * `GET /process-instances/{id}`, `GET /process-instances/{id}/journal` (страницами,
 * старые записи первыми), `GET /process-definitions/{key}@{version}`. Все — право
 * `processes.read`. Задачи — `GET /tasks/{id}` и текстовый поиск `GET /tasks?q=`
 * (право `tasks.read`). Только чтение.
 *
 * Задача-исправление в ядре не связана с экземпляром отдельной ссылкой: это задача,
 * в которой упомянут id экземпляра (так её заводят человек, агент или правило по
 * `process.failed`). Поэтому её ищет текстовый поиск по id — полный UUID, без
 * ложных совпадений по ключу экземпляра.
 *
 * Журнал ядро отдаёт только от начала. Поэтому два прохода: весь журнал со
 * скользящим окном последних записей (хвост) и отдельно записи вида `error`
 * (`?kind=error`) — из них причина падения. Так решение `failed` в конце длинного
 * журнала не теряется, а старая пойманная ошибка не выдаётся за причину.
 */
import { ControlPlaneError, type ControlPlaneClient } from './client.ts'
import { consoleUrl, label, type PrincipalNames } from './names.ts'
import type { ProcessInstanceOut, ProcessJournalEntry, TaskOut } from './shared/types.ts'

/** Страниц (по 200 записей) одного прохода по журналу: предохранитель от бесконечного журнала. */
export const JOURNAL_MAX_PAGES = 100
const JOURNAL_PAGE = 200
/** Сколько последних записей журнала отдаётся модели целиком. */
const JOURNAL_TAIL = 25
/** Сколько последних записей-ошибок отдаётся модели. */
const ERRORS_TAIL = 10
/** Сколько задач экземпляра разворачивается в карточки. */
const TASKS_MAX = 10

export interface TaskRef {
  publicId: string
  title: string
  status: string
  systemStatusCategory: string
  assignee: string | null
  url: string
}

export interface ProcessInstanceView {
  instance: {
    id: string
    process: { key: string, version: number, displayName: string | null }
    instanceKey: string
    status: string
    outcome: string | null
    workspaceId: string | null
    startedAt: string
    updatedAt: string
    completedAt: string | null
    stages: unknown
    timers: unknown
    data: string
  }
  /** Ссылка на экран экземпляра в консоли. */
  url: string
  /** Шаги, на которых экземпляр стоит сейчас (у завершённого или упавшего — пусто). */
  currentSteps: { element: string, kind: string, since: string, task: TaskRef | null, approvalIds: string[] }[]
  /** Почему упал: шаг и ошибка (RFC 7807 type/status/detail) из журнала. */
  failure: { element: string | null, error: unknown, at: string, seq: number, reason: string } | null
  /** Записи журнала вида error (поднятые, пойманные, провал намерений, повторы), последние. */
  errors: { seq: number, at: string, element: string | null, reason: string, data: string }[]
  /** Хвост журнала решений; actor — имя principal'а, который подал вход. */
  journal: { seq: number, at: string, kind: string, element: string | null, reason: string, actor: string | null, data: string }[]
  journalTotal: number
  /** Журнал длиннее предохранителя: хвост и ошибки — по прочитанной части. */
  journalTruncated: boolean
  /** Работа, которую завёл экземпляр (из открытых шагов и журнала). */
  tasks: TaskRef[]
  /** Задачи, в которых упомянут id экземпляра, — кандидаты в задачу-исправление. */
  fixTasks: TaskRef[]
  degraded: string[]
}

function clip(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Id задач в данных журнала: `taskId`, `createdTaskId`, `taskIds` на глубине до трёх (как экран консоли). */
export function taskIdsIn(value: unknown, depth = 0, out = new Set<string>()): Set<string> {
  if (depth > 3 || value === null || typeof value !== 'object') return out
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'taskId' || key === 'createdTaskId') && typeof v === 'string' && v !== '') out.add(v)
    else if (key === 'taskIds' && Array.isArray(v)) v.forEach((x) => { if (typeof x === 'string' && x !== '') out.add(x) })
    else taskIdsIn(v, depth + 1, out)
  }
  return out
}

function note(source: string, error: unknown): string {
  if (error instanceof ControlPlaneError) {
    const required = Array.isArray(error.details.required) ? ` (${(error.details.required as unknown[]).join(', ')})` : ''
    return `${source}: ${error.status} ${error.code}${required}`
  }
  return `${source}: ${error instanceof Error ? error.message : String(error)}`
}

export interface JournalScan {
  /** Последние `keep` записей прохода — скользящее окно. */
  last: ProcessJournalEntry[]
  total: number
  truncated: boolean
}

/**
 * Пройти журнал страницами от начала, держа только последние `keep` записей;
 * `visit` видит каждую запись. `kind` — фильтр ядра (`?kind=error`).
 */
export async function scanJournal(
  client: ControlPlaneClient,
  instanceId: string,
  options: { kind?: string, keep: number, visit?: (entry: ProcessJournalEntry) => void },
  signal?: AbortSignal,
): Promise<JournalScan> {
  const last: ProcessJournalEntry[] = []
  let total = 0
  let cursor: string | null = null
  for (let page = 0; page < JOURNAL_MAX_PAGES; page++) {
    const result = await client.processJournal(instanceId, { ...(options.kind ? { kind: options.kind } : {}), limit: JOURNAL_PAGE, cursor }, signal)
    for (const entry of result.items) {
      options.visit?.(entry)
      last.push(entry)
      if (last.length > options.keep) last.shift()
    }
    total += result.items.length
    cursor = result.nextCursor
    if (cursor === null) return { last, total, truncated: false }
  }
  return { last, total, truncated: true }
}

/** Что нужно знать о записях-ошибках, чтобы назвать причину падения. */
export interface FailureTrace {
  /** Последнее решение `failed`. */
  failed?: ProcessJournalEntry
  /** Последняя поднятая ошибка (`error_raised`, `intent_failed`). */
  raised?: ProcessJournalEntry
  /** Последняя запись вида error любого решения. */
  last?: ProcessJournalEntry
}

export function traceError(trace: FailureTrace, entry: ProcessJournalEntry): void {
  if (entry.kind !== 'error') return
  const decision = entry.data.decision
  if (decision === 'failed') trace.failed = entry
  else if (decision === 'error_raised' || decision === 'intent_failed') trace.raised = entry
  trace.last = entry
}

/** Почему экземпляр упал: решение `failed`, иначе (у упавшего) последняя поднятая ошибка. */
export function failureFrom(status: string, trace: FailureTrace): ProcessInstanceView['failure'] {
  const entry = trace.failed ?? (status === 'failed' ? trace.raised ?? trace.last : undefined)
  if (entry === undefined) return null
  // У решения `failed` шаг бывает пустым (ошибка вне шага): берём шаг поднятой ошибки.
  const element = entry.element ?? trace.raised?.element ?? null
  return { element, error: entry.data.error ?? null, at: entry.at, seq: entry.seq, reason: entry.reason }
}

/** Причина падения по записям журнала (порядок — как в журнале). */
export function failureOf(instance: Pick<ProcessInstanceOut, 'status'>, entries: ProcessJournalEntry[]): ProcessInstanceView['failure'] {
  const trace: FailureTrace = {}
  for (const entry of entries) traceError(trace, entry)
  return failureFrom(instance.status, trace)
}

async function taskRefs(names: PrincipalNames, tasks: TaskOut[], signal?: AbortSignal): Promise<TaskRef[]> {
  return Promise.all(tasks.map(async t => ({
    publicId: t.publicId,
    title: t.title,
    status: t.status,
    systemStatusCategory: t.systemStatusCategory,
    assignee: label(await names.name(t.assigneeId, signal).catch(() => null)),
    url: consoleUrl.task(t.publicId),
  })))
}

/** Экземпляр процесса для ассистента: состояние, шаг, ошибка из журнала, задачи и ссылки. */
export async function processInstance(client: ControlPlaneClient, names: PrincipalNames, instanceId: string, signal?: AbortSignal): Promise<ProcessInstanceView> {
  const degraded: string[] = []
  const instance = await client.getProcessInstance(instanceId, signal)
  // Задачи экземпляра: открытые шаги и всё, что упомянуто в журнале.
  const ids = new Set<string>()
  for (const element of instance.openElements) if (element.taskId) ids.add(element.taskId)
  const trace: FailureTrace = {}
  const [journal, errors, definition] = await Promise.all([
    scanJournal(client, instance.id, { keep: JOURNAL_TAIL, visit: (entry) => { taskIdsIn(entry.data, 0, ids) } }, signal),
    scanJournal(client, instance.id, { kind: 'error', keep: ERRORS_TAIL, visit: entry => traceError(trace, entry) }, signal),
    client.getProcessDefinition(`${instance.definitionKey}@${instance.definitionVersion}`, signal).catch((error: unknown) => {
      degraded.push(note('process-definition', error))
      return null
    }),
  ])
  await names.directory(signal).then(d => degraded.push(...d.degraded), (error: unknown) => degraded.push(note('names', error)))
  const tail = journal.last
  const loaded = await Promise.all([...ids].slice(0, TASKS_MAX).map(id => client.getTask(id, signal).catch((error: unknown) => {
    if (!(error instanceof ControlPlaneError && (error.status === 403 || error.status === 404))) throw error
    return null
  })))
  const own = loaded.filter((t): t is TaskOut => t !== null)
  const byId = new Map(own.map(t => [t.id, t]))

  const mentioning = await client.listTasks({ q: instance.id, limit: 20 }, signal).then(p => p.items, (error: unknown) => {
    degraded.push(note('tasks?q', error))
    return [] as TaskOut[]
  })
  const fixes = mentioning.filter(t => !byId.has(t.id))

  const actors = new Map<string, string | null>()
  for (const entry of tail) {
    if (entry.actorId && !actors.has(entry.actorId)) actors.set(entry.actorId, label(await names.name(entry.actorId, signal).catch(() => null)))
  }

  const [tasks, fixTasks] = await Promise.all([taskRefs(names, own, signal), taskRefs(names, fixes, signal)])
  const taskOf = new Map(own.map((t, i) => [t.id, tasks[i]!]))

  return {
    instance: {
      id: instance.id,
      process: { key: instance.definitionKey, version: instance.definitionVersion, displayName: definition?.displayName ?? null },
      instanceKey: instance.instanceKey,
      status: instance.status,
      outcome: instance.outcome ?? null,
      workspaceId: instance.workspaceId ?? null,
      startedAt: instance.startedAt,
      updatedAt: instance.updatedAt,
      completedAt: instance.completedAt ?? null,
      stages: instance.stages,
      timers: instance.timers,
      data: clip(instance.data, 1500),
    },
    url: consoleUrl.process(instance.id),
    currentSteps: instance.openElements.map(e => ({
      element: e.id, kind: e.kind, since: e.since, task: e.taskId ? taskOf.get(e.taskId) ?? null : null, approvalIds: e.approvalIds,
    })),
    failure: failureFrom(instance.status, trace),
    errors: errors.last.map(e => ({ seq: e.seq, at: e.at, element: e.element, reason: e.reason, data: clip(e.data, 600) })),
    journal: tail.map(e => ({
      seq: e.seq, at: e.at, kind: e.kind, element: e.element, reason: e.reason, actor: e.actorId ? actors.get(e.actorId) ?? e.actorId : null, data: clip(e.data, 300),
    })),
    journalTotal: journal.total,
    journalTruncated: journal.truncated || errors.truncated,
    tasks,
    fixTasks,
    degraded,
  }
}
