/**
 * Имена участников для ассистента: principal id → отображаемое имя. Человек читает
 * «coder» или «Анна Петрова», а не «агент 396a9d83…».
 *
 * Два источника ядра, оба только чтение:
 * - реестр агентов `GET /agents` (право `agents.read`) — ключ и отображаемое имя
 *   агента по его principal;
 * - `GET /principals` (право `principals.read`) — отображаемое имя любого principal
 *   (люди, сервисы, агенты вне реестра).
 *
 * Нет права на источник — имена из него не приходят, id остаётся как есть, а в
 * `degraded` видно, какого права не хватило: ассистент говорит об этом, не обходя
 * (правило персоны 4). Справочник кэшируется на пять минут: имена меняются редко,
 * а один ответ ассистента может называть десятки участников.
 *
 * Загрузка одна на всех, кто ждёт справочник, поэтому идёт не под сигналом первого
 * вызова, а под своим таймаутом: прерванный вызов перестаёт ждать сам и не роняет
 * соседей. Неудача (5xx, таймаут) кэшируется на 30 с — цикл по участникам журнала
 * не повторяет загрузку на каждое имя.
 */
import { ControlPlaneError, type ControlPlaneClient } from './client.ts'
import type { AgentOut, PageOut, PrincipalOut } from './shared/types.ts'

/** Путь консоли: ссылки ассистента ведут на её экраны (как адрес в screen-context). */
export const CONSOLE_BASE = '/console/'

export const consoleUrl = {
  task: (publicId: string): string => `${CONSOLE_BASE}work/${encodeURIComponent(publicId)}`,
  process: (instanceId: string): string => `${CONSOLE_BASE}processes/${encodeURIComponent(instanceId)}`,
  agent: (key: string): string => `${CONSOLE_BASE}agents/${encodeURIComponent(key)}`,
  run: (runId: string): string => `${CONSOLE_BASE}runs/${encodeURIComponent(runId)}`,
  proposal: (proposal: WorkProposal, limits?: Partial<Record<keyof WorkProposal, number>>): string =>
    `${CONSOLE_BASE}work/new?${proposalQuery(proposal, { ...PROPOSAL_LIMITS, ...limits })}`,
}

/**
 * Предложение работы ссылкой: консоль рисует по ней карточку «Будет заведена работа —
 * нужна ваша подпись», и работу заводит человек (контракт консоли — экран work,
 * «Словами: предложение ссылкой»). Ключи — параметры ссылки.
 */
export interface WorkProposal {
  /** Что сделать; обязателен. */
  title: string
  /** Ключ типа работы. */
  type?: string | null | undefined
  /** principal id исполнителя. */
  exec?: string | null | undefined
  /** principal id владельца; по умолчанию владелец — сам человек. */
  owner?: string | null | undefined
  /** Срок: `ГГГГ-ММ-ДД` (18:00 по часам браузера) или ISO date-time. */
  due?: string | null | undefined
  /** id workspace. */
  ws?: string | null | undefined
  /** Ожидаемый результат. */
  result?: string | null | undefined
  /** Основание. */
  basis?: string | null | undefined
}

const PROPOSAL_KEYS = ['title', 'type', 'exec', 'owner', 'due', 'ws', 'result', 'basis'] as const
/** Пределы консоли: длиннее она не примет. */
export const PROPOSAL_LIMITS: Partial<Record<keyof WorkProposal, number>> = { title: 500, result: 2000, basis: 2000 }
const DUE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/

/** Не длиннее `max` единиц UTF-16 и без половины суррогатной пары на краю. */
function cut(value: string, max: number): string {
  if (value.length <= max) return value
  const head = value.slice(0, max)
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head
}

/**
 * encodeURIComponent и ещё `!'()*.`: консоль ищет ссылку в тексте до первой скобки и
 * срезает хвостовую пунктуацию, а «)» закрывает markdown-ссылку — иначе поля теряются.
 */
function encodeParam(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*.]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

function proposalQuery(proposal: WorkProposal, limits: Partial<Record<keyof WorkProposal, number>>): string {
  const parts: string[] = []
  for (const key of PROPOSAL_KEYS) {
    const raw = proposal[key]
    let value = typeof raw === 'string' ? raw.trim() : ''
    if (value === '') {
      if (key === 'title') throw new Error('предложение работы: title обязателен')
      continue
    }
    if (key === 'due' && (!DUE.test(value) || Number.isNaN(Date.parse(value)))) {
      throw new Error(`предложение работы: due «${value}» — нужен ГГГГ-ММ-ДД или ISO date-time`)
    }
    const max = limits[key]
    if (max !== undefined) value = cut(value, max)
    if (value === '') continue
    parts.push(`${key}=${encodeParam(value)}`)
  }
  return parts.join('&')
}

export interface Named {
  id: string
  /** Отображаемое имя; `null` — имени нет в доступных источниках, называть по id. */
  name: string | null
  kind: string | null
  /** Ключ агента в реестре (coder, coder-2) — у агентов реестра. */
  agentKey?: string
}

export interface Directory {
  byId: Map<string, Named>
  /** Агенты реестра целиком — для cp_agents. `null` — реестр недоступен. */
  agents: AgentOut[] | null
  /** Все principals tenant'а. `null` — нет права `principals.read`. */
  principals: PrincipalOut[] | null
  /** Чего не хватило: `agents: 403 forbidden (agents.read)`. */
  degraded: string[]
}

const TTL_MS = 5 * 60_000
/** Сколько помнится неудачная загрузка: повтор не чаще. */
export const FAILURE_TTL_MS = 30_000
/** Таймаут загрузки справочника (свой, не сигнал вызывающего). */
const LOAD_TIMEOUT_MS = 15_000
/** Потолок страниц одного источника: справочник, а не выгрузка tenant'а. */
const MAX_PAGES = 5

async function all<T>(load: (cursor: string | null) => Promise<PageOut<T>>): Promise<T[]> {
  const out: T[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const result: PageOut<T> = await load(cursor)
    out.push(...result.items)
    cursor = result.nextCursor
    if (cursor === null) break
  }
  return out
}

function refusal(source: string, error: unknown): string {
  if (error instanceof ControlPlaneError) {
    const required = Array.isArray(error.details.required) ? ` (${(error.details.required as unknown[]).join(', ')})` : ''
    return `${source}: ${error.status} ${error.code}${required}`
  }
  return `${source}: ${error instanceof Error ? error.message : String(error)}`
}

/** Отказ по праву или отсутствию маршрута — деградация; остальное — ошибка вызова. */
function degradable(error: unknown): boolean {
  return error instanceof ControlPlaneError && (error.status === 403 || error.status === 404)
}

/** Ждать общий промис, пока не прерван свой сигнал; сам промис от этого не отменяется. */
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

export class PrincipalNames {
  private cache: { value: Directory, at: number } | null = null
  private failure: { error: unknown, at: number } | null = null
  private loading: Promise<Directory> | null = null

  constructor(
    private readonly client: ControlPlaneClient,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs: number = LOAD_TIMEOUT_MS,
  ) {}

  async directory(signal?: AbortSignal): Promise<Directory> {
    if (this.cache !== null && this.now() - this.cache.at < TTL_MS) return this.cache.value
    if (this.failure !== null && this.now() - this.failure.at < FAILURE_TTL_MS) throw this.failure.error
    if (this.loading === null) {
      this.loading = this.load(AbortSignal.timeout(this.timeoutMs)).then(
        (value) => {
          this.cache = { value, at: this.now() }
          this.failure = null
          return value
        },
        (error: unknown) => {
          this.failure = { error, at: this.now() }
          throw error
        },
      ).finally(() => { this.loading = null })
      // Ждущий мог уже уйти по своему сигналу: отказ загрузки не должен остаться необработанным.
      this.loading.catch(() => {})
    }
    return waitFor(this.loading, signal)
  }

  private async load(signal?: AbortSignal): Promise<Directory> {
    const degraded: string[] = []
    const [agents, principals] = await Promise.all([
      all(cursor => this.client.listAgents({ limit: 200, cursor }, signal)).catch((error: unknown) => {
        if (!degradable(error)) throw error
        degraded.push(refusal('agents', error))
        return null
      }),
      all(cursor => this.client.listPrincipals({ limit: 200, cursor }, signal)).catch((error: unknown) => {
        if (!degradable(error)) throw error
        degraded.push(refusal('principals', error))
        return null
      }),
    ])
    const byId = new Map<string, Named>()
    for (const p of principals ?? []) byId.set(p.id, { id: p.id, name: p.displayName, kind: p.kind })
    // Реестр агентов главнее: его имя — то, что человек видит в консоли на экране агента.
    for (const a of agents ?? []) {
      if (!a.principalId) continue
      byId.set(a.principalId, { id: a.principalId, name: a.displayName, kind: 'agent', agentKey: a.key })
    }
    return { byId, agents, principals, degraded }
  }

  /** Имя одного principal; неизвестный — с `name: null`. */
  async name(id: string | null | undefined, signal?: AbortSignal): Promise<Named | null> {
    if (!id) return null
    const { byId } = await this.directory(signal)
    return byId.get(id) ?? { id, name: null, kind: null }
  }
}

/** Как назвать principal в тексте: имя, иначе id. */
export function label(named: Named | null): string | null {
  if (named === null) return null
  return named.name ?? named.id
}

export interface Participant {
  /** principal id — для cp_delegate; у агента реестра без связанной учётки — `null`. */
  id: string | null
  displayName: string
  kind: string
  /** Ключ агента в реестре (coder, coder-2). */
  key: string | null
  status: string
  state: string | null
  url: string | null
}

/**
 * Кому можно поручить работу: агенты реестра (имя и ключ — как в консоли), без
 * реестра — активные principals нужного вида. Люди и сервисы — только из principals.
 */
export function participants(directory: Directory, kind: string): Participant[] | null {
  if (kind === 'agent' && directory.agents !== null) {
    return directory.agents.filter(a => a.status === 'active').map(a => ({
      id: a.principalId ?? null, displayName: a.displayName, kind: 'agent', key: a.key, status: a.status, state: a.state ?? null, url: consoleUrl.agent(a.key),
    }))
  }
  if (directory.principals === null) return null
  return directory.principals.filter(p => p.kind === kind && p.status === 'active').map(p => {
    const agentKey = directory.byId.get(p.id)?.agentKey
    return { id: p.id, displayName: p.displayName, kind: p.kind, key: agentKey ?? null, status: p.status, state: null, url: agentKey ? consoleUrl.agent(agentKey) : null }
  })
}
