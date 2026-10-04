/**
 * HTTP-клиент Control Plane: bearer от `ctx.harnessIdentity` (audience
 * `control-plane`), `Idempotency-Key` на записях, `If-Match` на PATCH,
 * ошибки → `ControlPlaneError` с кодом сервера. Один повтор при 401 после
 * сброса кэша токена (токен отозван раньше срока).
 */
import { randomUUID } from 'node:crypto'
import type {
  AgentOut, ApprovalOut, ArtifactOut, AttentionFeedback, ClaimOut, AttentionList, CheckpointOut, EventPageOut, PrincipalOut, RunActionOut, HarnessContext, PageOut, ProcessDefinitionOut, ProcessInstanceOut, ProcessJournalEntry, RunOut, SessionOut, TaskCommentOut, TaskOut, TaskTypeExecutorsOut, TaskTypeOut, WorkspaceMemberOut, WorkspaceNode, WorkspaceParticipantOut,
} from './shared/types.ts'

export const AUDIENCE = 'control-plane'

export class ControlPlaneError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown>
  readonly requestId: string | undefined

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}, requestId?: string) {
    super(message)
    this.name = 'ControlPlaneError'
    this.status = status
    this.code = code
    this.details = details
    this.requestId = requestId
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>
  body?: unknown
  /** Каждая запись идёт с Idempotency-Key; передайте свой, чтобы повторить тот же запрос. */
  idempotencyKey?: string | undefined
  ifMatch?: string | number | undefined
  signal?: AbortSignal | undefined
}

/**
 * Источник bearer для audience `control-plane`. Клиент не зависит от DSH: в
 * харнессе это `ctx.harnessIdentity`, в тестах и других оболочках — что угодно с
 * той же парой методов.
 */
export interface TokenSource {
  /** Значение заголовка Authorization (`Bearer …`) для audience. */
  authorization(audience: string, signal?: AbortSignal): Promise<string>
  /** Сбросить кэш токена audience (сервер ответил 401). */
  invalidate(audience: string): void
}

export interface ControlPlaneClientOptions {
  serverUrl: string
  identity: TokenSource
  fetch?: typeof fetch
  timeoutMs?: number
  userAgent?: string
}

export class ControlPlaneClient {
  private readonly base: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(private readonly options: ControlPlaneClientOptions) {
    this.base = options.serverUrl.replace(/\/+$/, '')
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  get serverUrl(): string {
    return this.base
  }

  // ------------------------------------------------------------ «Важное» (CP-ADR-0071)
  attention(query: { workspaceId?: string | null, includeDescendants?: boolean } = {}, signal?: AbortSignal): Promise<AttentionList> {
    return this.request<AttentionList>('GET', '/api/v1/me/attention', {
      query: { workspaceId: query.workspaceId ?? undefined, includeDescendants: query.workspaceId ? (query.includeDescendants ?? true) : undefined },
      signal,
    })
  }

  attentionFeedback(itemKey: string, body: { verdict: 'useful' | 'not_needed', comment?: string | null }, signal?: AbortSignal): Promise<AttentionFeedback> {
    return this.request<AttentionFeedback>('POST', `/api/v1/me/attention/${encodeURIComponent(itemKey)}:feedback`, { body, signal })
  }

  // ------------------------------------------------------------ identity / session
  harnessContext(sessionId?: string, signal?: AbortSignal): Promise<HarnessContext> {
    return this.request<HarnessContext>('GET', '/api/v1/harness/context', { query: { sessionId }, signal })
  }

  openSession(body: {
    clientName: string
    clientVersion?: string
    metadata?: Record<string, unknown>
    ttlSeconds?: number
    harness?: { type: string, version?: string, protocolVersion?: string, capabilities?: string[], hostname?: string, environment?: Record<string, unknown> }
  }, signal?: AbortSignal): Promise<SessionOut> {
    return this.request<SessionOut>('POST', '/api/v1/sessions', { body, signal })
  }

  heartbeatSession(sessionId: string, ttlSeconds?: number, signal?: AbortSignal): Promise<SessionOut> {
    return this.request<SessionOut>('POST', `/api/v1/sessions/${sessionId}:heartbeat`, { body: { ttlSeconds }, signal })
  }

  closeSession(sessionId: string, signal?: AbortSignal): Promise<SessionOut> {
    return this.request<SessionOut>('POST', `/api/v1/sessions/${sessionId}:close`, { body: {}, signal })
  }

  // ------------------------------------------------------------ tasks
  listTasks(query: Record<string, string | number | boolean | undefined | null>, signal?: AbortSignal): Promise<PageOut<TaskOut>> {
    return this.request<PageOut<TaskOut>>('GET', '/api/v1/tasks', { query, signal })
  }

  /** Собрать все страницы (с потолком). */
  async listAllTasks(query: Record<string, string | number | boolean | undefined | null>, limitTotal = 500, signal?: AbortSignal): Promise<TaskOut[]> {
    const out: TaskOut[] = []
    let cursor: string | null = null
    do {
      const page: PageOut<TaskOut> = await this.listTasks({ ...query, limit: 100, cursor }, signal)
      out.push(...page.items)
      cursor = page.nextCursor
    } while (cursor !== null && out.length < limitTotal)
    return out.slice(0, limitTotal)
  }

  getTask(ref: string, signal?: AbortSignal): Promise<TaskOut> {
    return this.request<TaskOut>('GET', `/api/v1/tasks/${encodeURIComponent(ref)}`, { signal })
  }

  getTaskTransitions(ref: string, signal?: AbortSignal): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v1/tasks/${encodeURIComponent(ref)}/transitions`, { signal })
  }

  createTask(body: Record<string, unknown>, idempotencyKey?: string, signal?: AbortSignal): Promise<TaskOut> {
    return this.request<TaskOut>('POST', '/api/v1/tasks', { body, idempotencyKey, signal })
  }

  updateTask(ref: string, body: Record<string, unknown>, ifMatch: number | string, signal?: AbortSignal): Promise<TaskOut> {
    return this.request<TaskOut>('PATCH', `/api/v1/tasks/${encodeURIComponent(ref)}`, { body, ifMatch, signal })
  }

  commentTask(ref: string, body: { body: string }, idempotencyKey?: string, signal?: AbortSignal): Promise<TaskCommentOut> {
    return this.request<TaskCommentOut>('POST', `/api/v1/tasks/${encodeURIComponent(ref)}/comments`, { body, idempotencyKey, signal })
  }

  /** Типы работ; с `workspaceId` — только разрешённые в этом workspace (с наследованием). */
  listTaskTypes(query: { workspaceId?: string | null, status?: string } = {}, signal?: AbortSignal): Promise<PageOut<TaskTypeOut>> {
    return this.request<PageOut<TaskTypeOut>>('GET', '/api/v1/task-types', { query: { limit: 200, workspaceId: query.workspaceId ?? undefined, status: query.status }, signal })
  }

  /** Кто может взять тип работы (версию `typeId`) в workspace. */
  listTaskTypeExecutors(typeId: string, workspaceId: string, signal?: AbortSignal): Promise<TaskTypeExecutorsOut> {
    return this.request<TaskTypeExecutorsOut>('GET', `/api/v1/task-types/${encodeURIComponent(typeId)}/executors`, { query: { workspaceId }, signal })
  }

  // ------------------------------------------------------------ approvals
  listApprovals(query: Record<string, string | number | boolean | undefined | null>, signal?: AbortSignal): Promise<PageOut<ApprovalOut>> {
    return this.request<PageOut<ApprovalOut>>('GET', '/api/v1/approvals', { query, signal })
  }

  getApproval(id: string, signal?: AbortSignal): Promise<ApprovalOut> {
    return this.request<ApprovalOut>('GET', `/api/v1/approvals/${encodeURIComponent(id)}`, { signal })
  }

  decideApproval(id: string, decision: 'approve' | 'reject', comment: string | null, idempotencyKey?: string, signal?: AbortSignal): Promise<ApprovalOut> {
    return this.request<ApprovalOut>('POST', `/api/v1/approvals/${encodeURIComponent(id)}:${decision}`, {
      body: comment === null ? null : { comment }, idempotencyKey, signal,
    })
  }

  listRuns(query: Record<string, string | number | boolean | undefined | null>, signal?: AbortSignal): Promise<PageOut<RunOut>> {
    return this.request<PageOut<RunOut>>('GET', '/api/v1/runs', { query, signal })
  }

  // ------------------------------------------------------------ исполнение работы человеком (H008)
  claimTask(ref: string, body: { sessionId: string, ttlSeconds?: number, intent?: string }, signal?: AbortSignal): Promise<ClaimOut> {
    return this.request<ClaimOut>('POST', `/api/v1/tasks/${encodeURIComponent(ref)}:claim`, { body, signal })
  }

  heartbeatClaim(claimId: string, ttlSeconds?: number, signal?: AbortSignal): Promise<ClaimOut> {
    return this.request<ClaimOut>('POST', `/api/v1/claims/${encodeURIComponent(claimId)}:heartbeat`, { body: { ttlSeconds }, signal })
  }

  releaseClaim(claimId: string, reason: string, signal?: AbortSignal): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v1/claims/${encodeURIComponent(claimId)}:release`, { body: { reason }, signal })
  }

  startRun(ref: string, body: { claimId: string, fencingToken: number, input?: Record<string, unknown>, maxDurationSeconds?: number }, signal?: AbortSignal): Promise<RunOut> {
    return this.request<RunOut>('POST', `/api/v1/tasks/${encodeURIComponent(ref)}:start-run`, { body, signal })
  }

  runContext(runId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', `/api/v1/runs/${encodeURIComponent(runId)}/context`, { signal })
  }

  succeedRun(runId: string, body: { output?: Record<string, unknown>, completeTask?: boolean }, signal?: AbortSignal): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v1/runs/${encodeURIComponent(runId)}:succeed`, { body, signal })
  }

  failRun(runId: string, body: { failureReason: string, output?: Record<string, unknown> }, signal?: AbortSignal): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v1/runs/${encodeURIComponent(runId)}:fail`, { body, signal })
  }

  createCheckpoint(runId: string, body: { kind: string, data: Record<string, unknown> }, signal?: AbortSignal): Promise<CheckpointOut> {
    return this.request<CheckpointOut>('POST', `/api/v1/runs/${encodeURIComponent(runId)}/checkpoints`, { body, signal })
  }

  /**
   * Загрузить байты артефакта в хранилище ядра (CP-ADR-0072 §2): сырое тело, тип — заголовком.
   * Возвращает `contentRef` для `POST /artifacts`; загрузка без ссылки из артефакта истекает.
   */
  async uploadArtifactContent(data: Uint8Array, mediaType: string, signal?: AbortSignal): Promise<{ contentRef: string, sizeBytes: number, mediaType: string, sha256: string }> {
    const url = `${this.base}/api/v1/artifact-contents`
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(url, {
        method: 'PUT',
        headers: {
          authorization: await this.options.identity.authorization(AUDIENCE, signal),
          'content-type': mediaType,
          ...(this.options.userAgent ? { 'user-agent': this.options.userAgent } : {}),
        },
        body: new Blob([data.slice().buffer as ArrayBuffer]),
        ...(signal ? { signal } : {}),
      })
      if (response.status === 401 && attempt === 0) {
        this.options.identity.invalidate(AUDIENCE)
        continue
      }
      if (!response.ok) throw await toError(response)
      return await response.json() as { contentRef: string, sizeBytes: number, mediaType: string, sha256: string }
    }
  }

  createArtifact(body: Record<string, unknown>, signal?: AbortSignal): Promise<ArtifactOut> {
    return this.request<ArtifactOut>('POST', '/api/v1/artifacts', { body, signal })
  }

  invokeSkill(skillRef: string, body: { inputs: Record<string, unknown>, taskId?: string, runId?: string, approvalId?: string }, idempotencyKey?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('POST', `/api/v1/skills/${encodeURIComponent(skillRef)}:invoke`, { body, idempotencyKey, signal })
  }

  skillInvocation(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', `/api/v1/skill-invocations/${encodeURIComponent(id)}`, { signal })
  }

  listRunActions(runId: string, query: { limit?: number, cursor?: string | null } = {}, signal?: AbortSignal): Promise<PageOut<RunActionOut>> {
    return this.request<PageOut<RunActionOut>>('GET', `/api/v1/runs/${encodeURIComponent(runId)}/actions`, { query, signal })
  }

  listCheckpoints(runId: string, query: { limit?: number, cursor?: string | null } = {}, signal?: AbortSignal): Promise<PageOut<CheckpointOut>> {
    return this.request<PageOut<CheckpointOut>>('GET', `/api/v1/runs/${encodeURIComponent(runId)}/checkpoints`, { query, signal })
  }

  getArtifact(artifactId: string, signal?: AbortSignal): Promise<ArtifactOut> {
    return this.request<ArtifactOut>('GET', `/api/v1/artifacts/${encodeURIComponent(artifactId)}`, { signal })
  }

  listArtifacts(query: { taskId?: string, runId?: string, type?: string, limit?: number }, signal?: AbortSignal): Promise<PageOut<ArtifactOut>> {
    return this.request<PageOut<ArtifactOut>>('GET', '/api/v1/artifacts', { query, signal })
  }

  listPrincipals(query: { kind?: string, limit?: number, cursor?: string | null } = {}, signal?: AbortSignal): Promise<PageOut<PrincipalOut>> {
    return this.request<PageOut<PrincipalOut>>('GET', '/api/v1/principals', { query, signal })
  }

  /** Реестр агентов (CP-ADR-0073): ключ, отображаемое имя, principal агента. Право `agents.read`. */
  listAgents(query: { status?: 'active' | 'retired', workspaceId?: string, limit?: number, cursor?: string | null } = {}, signal?: AbortSignal): Promise<PageOut<AgentOut>> {
    return this.request<PageOut<AgentOut>>('GET', '/api/v1/agents', { query, signal })
  }

  /** Явные члены workspace (principal id), без держателей ролей. Право `workspaces.read`. */
  listWorkspaceMembers(workspaceId: string, query: { limit?: number, cursor?: string | null } = {}, signal?: AbortSignal): Promise<PageOut<WorkspaceMemberOut>> {
    return this.request<PageOut<WorkspaceMemberOut>>('GET', `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members`, { query, signal })
  }

  /**
   * Участники workspace (TASK-001194): явные члены и держатели ролей workspace,
   * с именем, видом и ролями — то, что показывает экран «Люди и роли». Право
   * `workspaces.read` плюс `org.read` или `principals.read`.
   */
  listWorkspaceParticipants(workspaceId: string, query: { limit?: number, cursor?: string | null } = {}, signal?: AbortSignal): Promise<PageOut<WorkspaceParticipantOut>> {
    return this.request<PageOut<WorkspaceParticipantOut>>('GET', `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/participants`, { query, signal })
  }

  // ------------------------------------------------------------ процессы (TAI-ADR-0054), право `processes.read`
  getProcessInstance(instanceId: string, signal?: AbortSignal): Promise<ProcessInstanceOut> {
    return this.request<ProcessInstanceOut>('GET', `/api/v1/process-instances/${encodeURIComponent(instanceId)}`, { signal })
  }

  listProcessInstances(query: { definitionKey?: string | undefined, instanceKey?: string | undefined, status?: string | undefined, workspaceId?: string | undefined, limit?: number | undefined, cursor?: string | null | undefined } = {}, signal?: AbortSignal): Promise<PageOut<ProcessInstanceOut>> {
    return this.request<PageOut<ProcessInstanceOut>>('GET', '/api/v1/process-instances', { query, signal })
  }

  /** Страница журнала решений экземпляра, старые записи первыми. */
  processJournal(instanceId: string, query: { kind?: string, limit?: number, cursor?: string | null } = {}, signal?: AbortSignal): Promise<PageOut<ProcessJournalEntry>> {
    return this.request<PageOut<ProcessJournalEntry>>('GET', `/api/v1/process-instances/${encodeURIComponent(instanceId)}/journal`, { query, signal })
  }

  /** Опубликованный процесс по ключу (последняя версия) или `key@version`. */
  getProcessDefinition(ref: string, signal?: AbortSignal): Promise<ProcessDefinitionOut> {
    return this.request<ProcessDefinitionOut>('GET', `/api/v1/process-definitions/${encodeURIComponent(ref)}`, { signal })
  }

  workspaceTree(signal?: AbortSignal): Promise<{ roots: WorkspaceNode[] }> {
    return this.request<{ roots: WorkspaceNode[] }>('GET', '/api/v1/workspaces/tree', { query: { includeProjects: true }, signal })
  }

  // ------------------------------------------------------------ events / memory
  listEvents(query: { limit?: number | undefined, cursor?: string | null | undefined, after?: string | null | undefined, tail?: number | undefined, entityType?: string | undefined, entityId?: string | undefined, types?: string | undefined }, signal?: AbortSignal): Promise<EventPageOut> {
    return this.request<EventPageOut>('GET', '/api/v1/events', { query, signal })
  }

  /** URL будильника `WS /events/ws` с теми же фильтрами (CP-ADR-0069 п.5). */
  eventsSocketUrl(query: { after: string, types?: string | undefined }): string {
    const url = new URL(`${this.base}/api/v1/events/ws`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('after', query.after)
    if (query.types) url.searchParams.set('types', query.types)
    return url.toString()
  }

  /**
   * Содержимое артефакта из хранилища ядра (CP-ADR-0072) — сырой ответ для потоковой
   * отдачи: тип, размер, Content-Disposition и nosniff задаёт ядро.
   */
  async artifactContent(artifactId: string, signal?: AbortSignal): Promise<Response> {
    const url = `${this.base}/api/v1/artifacts/${encodeURIComponent(artifactId)}/content`
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(url, {
        headers: { authorization: await this.options.identity.authorization(AUDIENCE, signal), ...(this.options.userAgent ? { 'user-agent': this.options.userAgent } : {}) },
        ...(signal ? { signal } : {}),
      })
      if (response.status === 401 && attempt === 0) {
        this.options.identity.invalidate(AUDIENCE)
        continue
      }
      if (!response.ok) throw await toError(response)
      return response
    }
  }

  /** Заголовок Authorization для соединений, которые клиент не ведёт сам (WebSocket). */
  authorization(signal?: AbortSignal): Promise<string> {
    return this.options.identity.authorization(AUDIENCE, signal)
  }

  invalidateToken(): void {
    this.options.identity.invalidate(AUDIENCE)
  }

  /** Память компании — только через Context Gateway ядра (`POST /api/v1/context`). */
  context(body: { query: string, task?: string | null, workspaceId?: string | null, projectId?: string | null, includeMemory?: boolean, maxTokens?: number | null }, signal?: AbortSignal): Promise<unknown> {
    return this.request<unknown>('POST', '/api/v1/context', { body, signal })
  }

  observe(body: { kind: string, content: string, data?: Record<string, unknown> | null, task?: string | null, workspaceId?: string | null, sessionId?: string | null }, idempotencyKey?: string, signal?: AbortSignal): Promise<unknown> {
    return this.request<unknown>('POST', '/api/v1/observations', { body, idempotencyKey, signal })
  }

  // ------------------------------------------------------------ transport
  async request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.base + path)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
    const headers: Record<string, string> = { accept: 'application/json' }
    if (this.options.userAgent) headers['user-agent'] = this.options.userAgent
    const hasBody = options.body !== undefined && method !== 'GET'
    if (hasBody) headers['content-type'] = 'application/json'
    if (method === 'POST' || method === 'PATCH' || method === 'DELETE') {
      headers['idempotency-key'] = options.idempotencyKey ?? randomUUID().replaceAll('-', '')
    }
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`

    let retried = false
    for (;;) {
      headers.authorization = await this.options.identity.authorization(AUDIENCE, options.signal)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      const onAbort = () => controller.abort()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      let response: Response
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        })
      } catch (error) {
        if (options.signal?.aborted) throw error
        throw new ControlPlaneError(0, 'transport_error', `Control Plane недоступен: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }
      if (response.status === 401 && !retried) {
        retried = true
        this.options.identity.invalidate(AUDIENCE)
        continue
      }
      if (!response.ok) throw await toError(response)
      if (response.status === 204) return undefined as T
      return await response.json() as T
    }
  }
}

async function toError(response: Response): Promise<ControlPlaneError> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return new ControlPlaneError(response.status, `http_${response.status}`, `Control Plane ответил ${response.status}`)
  }
  const envelope = payload as { error?: { code?: unknown, message?: unknown, details?: unknown, request_id?: unknown, requestId?: unknown }, detail?: unknown }
  const error = envelope.error
  if (error && typeof error === 'object') {
    return new ControlPlaneError(
      response.status,
      typeof error.code === 'string' ? error.code : `http_${response.status}`,
      typeof error.message === 'string' ? error.message : `Control Plane ответил ${response.status}`,
      (error.details && typeof error.details === 'object' ? error.details : {}) as Record<string, unknown>,
      typeof error.requestId === 'string' ? error.requestId : typeof error.request_id === 'string' ? error.request_id : undefined,
    )
  }
  const detail = typeof envelope.detail === 'string' ? envelope.detail : JSON.stringify(envelope.detail ?? payload)
  return new ControlPlaneError(response.status, `http_${response.status}`, detail)
}
