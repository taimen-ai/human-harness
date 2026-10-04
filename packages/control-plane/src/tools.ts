/**
 * Инструменты модели `cp_*` — нативные, регистрируются на `ctx.tools` без
 * defineTool (в профиле dsh не должно быть второй копии @deepseek-ai/dsh-tools).
 * Чтение — свободно; каждая мутация Control Plane проходит через `ctx.approval`
 * (seam user-approval DSH) и без него отказывает (fail closed). Ничего не
 * остаётся только в переписке: результат — Task, Approval, комментарий или
 * Observation в памяти через ядро.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-user-approval'
import { ControlPlaneError } from './client.ts'
import { delegationBody, review, runProgress } from './delegation.ts'
import type { WorkTracker } from './work.ts'
import { artifactRef, fetchArtifact, readWorkspaceFile } from './artifact-files.ts'
import type { ControlPlane } from './service.ts'
import { consoleUrl, label, participants, PrincipalNames } from './names.ts'
import { processInstance } from './processes.ts'
import type { ParticipantRoleOut, WorkspaceMemberOut, WorkspaceParticipantOut } from './shared/types.ts'

type Json = Record<string, unknown>

const text = (value: unknown): ContentBlock[] => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

const ANY_OBJECT = { type: 'object', additionalProperties: true } as const

/** Роли участника без повторов: ядро отдаёт роль столько раз, на скольких уровнях она назначена. */
function uniqueRoles(roles: ParticipantRoleOut[]): ParticipantRoleOut[] {
  const seen = new Map<string, ParticipantRoleOut>()
  for (const role of roles) if (!seen.has(role.roleId)) seen.set(role.roleId, role)
  return [...seen.values()]
}

function tool(spec: {
  name: string
  description: string
  parameters: Record<string, unknown>
  required?: string[]
  outputSchema?: Record<string, unknown>
  concurrencySafe?: boolean
  execute(args: Json, exec: ToolRunContext): Promise<unknown>
}): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: {
      type: 'object',
      properties: spec.parameters,
      ...(spec.required && spec.required.length > 0 ? { required: spec.required } : {}),
      additionalProperties: false,
    },
    output: {
      schema: spec.outputSchema ?? ANY_OBJECT,
      render: (_args, value) => text(value),
    },
    isConcurrencySafe: () => spec.concurrencySafe === true,
    async execute(args, exec) {
      try {
        return await spec.execute((args ?? {}) as Json, exec)
      } catch (error) {
        if (error instanceof ControlPlaneError) {
          const required = Array.isArray(error.details.required) && error.details.required.length > 0 ? ` (нужно право: ${(error.details.required as unknown[]).join(' или ')})` : ''
          throw new Error(`control-plane ${error.status} ${error.code}: ${error.message}${required}${error.requestId ? ` (request ${error.requestId})` : ''}`)
        }
        throw error
      }
    },
  }
}

export interface ToolsOptions {
  confirmMutations: boolean
  /** Рабочий каталог беседы: сюда cp_fetch_artifact кладёт документы ядра для просмотра. */
  workspacePath?: string
  /** Исполнение работы человеком (H008); без него инструменты исполнителя не регистрируются. */
  work?: WorkTracker
}

/**
 * Запросить у человека подтверждение мутации через seam DSH. Без агента или
 * без сервиса approval мутация отказывается — периметр не ослабляется.
 */
async function confirm(ctx: Context, exec: ToolRunContext, reason: string, options: ToolsOptions): Promise<void> {
  if (!options.confirmMutations) return
  const approval = ctx.get('approval')
  if (approval === undefined) {
    throw new Error('мутация Control Plane отклонена: сервис подтверждений (user-approval) не смонтирован — fail closed')
  }
  if (exec.agent === undefined) {
    throw new Error('мутация Control Plane отклонена: вызов без агента не может быть подтверждён человеком')
  }
  const outcome = await approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, reason, signal: exec.signal })
  if (outcome !== 'allowed-once') {
    throw new Error(`мутация Control Plane не выполнена: подтверждение — ${String(outcome)}`)
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Зарегистрировать все инструменты; возвращает disposer. */
export function registerTools(ctx: Context, cp: ControlPlane, options: ToolsOptions): () => void {
  const disposers: (() => void)[] = []
  const add = (definition: ToolDefinition) => disposers.push(ctx.tools.register(definition))
  const names = new PrincipalNames(cp.client)
  /** Имя principal'а для ответа; справочник недоступен — `null`, id остаётся в данных. */
  const nameOf = async (id: string | null | undefined, signal?: AbortSignal): Promise<string | null> =>
    id ? label(await names.name(id, signal).catch(() => null)) : null

  add(tool({
    name: 'cp_whoami',
    description: 'Кто я в Control Plane: tenant, principal, права, роли, сессия харнесса и текущий scope (выбранный workspace). Вызывай первым, когда нужен контекст пользователя.',
    parameters: {},
    concurrencySafe: true,
    execute: (_a, exec) => cp.whoami(exec.signal),
  }))

  add(tool({
    name: 'cp_workspaces',
    description: 'Дерево workspace Control Plane и текущий scope поверхности (выбранный workspace). «Важное» и умолчания инструментов ограничены выбранным workspace с потомками.',
    parameters: {},
    concurrencySafe: true,
    execute: (_a, exec) => cp.workspaces(exec.signal),
  }))

  add(tool({
    name: 'cp_select_workspace',
    description: 'Выбрать workspace как scope поверхности пользователя (или снять выбор: workspaceId пустой). Меняет только личный read-state — не Control Plane.',
    parameters: { workspaceId: { type: 'string', description: 'UUID workspace; пусто — весь tenant' } },
    execute: (a, exec) => cp.selectWorkspace(str(a.workspaceId) ?? null, exec.signal),
  }))

  add(tool({
    name: 'cp_attention',
    description: 'Экран «Важное» пользователя: что требует его действия сейчас — решения (approvals), результаты на проверке, работа с близким сроком, блокировки, проваленные поручения. Проекция ядра (CP-ADR-0071) с reasonCode, правилом и действиями; используй её, чтобы проактивно предлагать человеку следующий шаг.',
    parameters: {},
    concurrencySafe: true,
    execute: (_a, exec) => cp.attention(exec.signal),
  }))

  add(tool({
    name: 'cp_get_task',
    description: 'Полная карточка задачи Control Plane по publicId (TASK-000123) или UUID, с допустимыми переходами статуса и артефактами задачи (id — для cp_fetch_artifact). assignee и owner — имена исполнителя и владельца (называй их так, а не id), url — ссылка на задачу в консоли.',
    parameters: { ref: { type: 'string' } },
    required: ['ref'],
    concurrencySafe: true,
    execute: async (a, exec) => {
      const ref = str(a.ref) ?? ''
      const [task, transitions] = await Promise.all([cp.client.getTask(ref, exec.signal), cp.client.getTaskTransitions(ref, exec.signal).catch(() => null)])
      const artifacts = await cp.client.listArtifacts({ taskId: task.id, limit: 50 }, exec.signal).then(p => p.items.map(artifactRef)).catch(() => null)
      const [assignee, owner] = await Promise.all([nameOf(task.assigneeId, exec.signal), nameOf(task.ownerId, exec.signal)])
      return { task, assignee, owner, url: consoleUrl.task(task.publicId), transitions, artifacts }
    },
  }))

  add(tool({
    name: 'cp_find_tasks',
    description: 'Найти задачи по фильтрам Control Plane: статус, категория статуса, тип, исполнитель, workspace, проект, сроки. Текстовый поиск по названию — на стороне харнесса по загруженной странице.',
    parameters: {
      query: { type: 'string', description: 'Подстрока в названии (регистр не важен)' },
      status: { type: 'string' },
      systemStatusCategory: { type: 'string' },
      typeKey: { type: 'string' },
      assigneeId: { type: 'string' },
      ownerId: { type: 'string' },
      workspaceId: { type: 'string' },
      projectId: { type: 'string' },
      dueTo: { type: 'string', description: 'ISO дата — задачи со сроком не позже' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    concurrencySafe: true,
    execute: async (a, exec) => {
      const limit = num(a.limit) ?? 50
      const scope = await cp.scope(exec.signal)
      const workspaceId = str(a.workspaceId) ?? scope.workspaceId ?? undefined
      const page = await cp.client.listTasks({
        status: str(a.status), systemStatusCategory: str(a.systemStatusCategory), typeKey: str(a.typeKey),
        assigneeId: str(a.assigneeId), ownerId: str(a.ownerId), workspaceId, includeDescendants: workspaceId !== undefined ? true : undefined, projectId: str(a.projectId),
        dueTo: str(a.dueTo), limit: Math.min(200, Math.max(limit, 20)),
      }, exec.signal)
      const q = str(a.query)?.toLowerCase()
      const items = q ? page.items.filter(t => t.title.toLowerCase().includes(q) || t.publicId.toLowerCase().includes(q)) : page.items
      const shown = await Promise.all(items.slice(0, limit).map(async t => ({ ...t, assigneeName: await nameOf(t.assigneeId, exec.signal) })))
      return { items: shown, nextCursor: page.nextCursor }
    },
  }))

  add(tool({
    name: 'cp_create_task',
    description: 'Создать типизированную задачу в Control Plane. Требует подтверждения человека. Не для просьбы человека поручить или завести работу — на неё отвечай ссылкой cp_propose_task, работу заведёт сам человек. Сначала покажи пользователю черновик (название, workspace, тип, исполнитель, срок) и вызывай инструмент только после его согласия.',
    parameters: {
      title: { type: 'string' },
      description: { type: 'string' },
      workspaceId: { type: 'string' },
      typeKey: { type: 'string' },
      priority: { type: 'string' },
      assigneeId: { type: 'string' },
      ownerId: { type: 'string' },
      dueDate: { type: 'string', description: 'ISO дата или дата-время' },
      parentTask: { type: 'string', description: 'publicId родительской задачи' },
      customFields: ANY_OBJECT,
    },
    required: ['title'],
    execute: async (a, exec) => {
      const title = str(a.title) ?? ''
      const workspaceId = str(a.workspaceId) ?? (await cp.scope(exec.signal)).workspaceId ?? undefined
      await confirm(ctx, exec, `Создать задачу «${title}»${str(a.assigneeId) ? ` для ${str(a.assigneeId)}` : ''}${workspaceId ? ` в workspace ${workspaceId}` : ''}`, options)
      return cp.client.createTask({
        title, description: str(a.description) ?? '', workspaceId, typeKey: str(a.typeKey),
        priority: str(a.priority), assigneeId: str(a.assigneeId), ownerId: str(a.ownerId), dueDate: str(a.dueDate),
        parentTask: str(a.parentTask), customFields: (a.customFields as Json | undefined) ?? undefined,
      }, undefined, exec.signal)
    },
  }))

  add(tool({
    name: 'cp_update_task',
    description: 'Изменить задачу (статус, исполнитель, срок, название, поля). Требует подтверждения человека и текущей версии задачи (If-Match): сначала прочитай её через cp_get_task и проверь допустимые переходы.',
    parameters: {
      ref: { type: 'string' },
      version: { type: 'integer', description: 'Текущая version задачи для If-Match' },
      status: { type: 'string' },
      assigneeId: { type: 'string' },
      ownerId: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      priority: { type: 'string' },
      dueDate: { type: 'string' },
      customFields: ANY_OBJECT,
    },
    required: ['ref', 'version'],
    execute: async (a, exec) => {
      const ref = str(a.ref) ?? ''
      const patch: Json = {}
      for (const key of ['status', 'assigneeId', 'ownerId', 'title', 'description', 'priority', 'dueDate'] as const) {
        const v = str(a[key]); if (v !== undefined) patch[key] = v
      }
      if (a.customFields && typeof a.customFields === 'object') patch.customFields = a.customFields
      await confirm(ctx, exec, `Изменить задачу ${ref}: ${Object.keys(patch).join(', ') || 'без полей'}`, options)
      return cp.client.updateTask(ref, patch, num(a.version) ?? 0, exec.signal)
    },
  }))

  add(tool({
    name: 'cp_comment_task',
    description: 'Оставить комментарий к задаче (append-only история). Требует подтверждения человека.',
    parameters: { ref: { type: 'string' }, body: { type: 'string' } },
    required: ['ref', 'body'],
    execute: async (a, exec) => {
      const ref = str(a.ref) ?? ''
      await confirm(ctx, exec, `Комментарий к задаче ${ref}`, options)
      return cp.client.commentTask(ref, { body: str(a.body) ?? '' }, undefined, exec.signal)
    },
  }))

  add(tool({
    name: 'cp_decide_approval',
    description: 'Согласовать или отклонить Approval. Внешнее и необратимое действие: требует подтверждения человека; сервер повторно проверяет авторизацию. Перед вызовом покажи пользователю рекомендацию, расхождения и источники.',
    parameters: {
      approvalId: { type: 'string' },
      decision: { type: 'string', enum: ['approve', 'reject'] },
      comment: { type: 'string' },
    },
    required: ['approvalId', 'decision'],
    execute: async (a, exec) => {
      const id = str(a.approvalId) ?? ''
      const decision = a.decision === 'reject' ? 'reject' : 'approve'
      await confirm(ctx, exec, `${decision === 'approve' ? 'Согласовать' : 'Отклонить'} approval ${id}`, options)
      return cp.client.decideApproval(id, decision, str(a.comment) ?? null, undefined, exec.signal)
    },
  }))

  add(tool({
    name: 'cp_agents',
    description: 'Кому можно поручить работу: агенты реестра — principal id (для cp_delegate), ключ (coder, coder-2), отображаемое имя, состояние и ссылка на экран агента; kind human или service — активные principals этого вида. Называй исполнителей по имени, а не по id. Участники конкретного workspace, включая держателей ролей, — cp_workspace_members.',
    parameters: { kind: { type: 'string', enum: ['agent', 'service', 'human'], description: 'Вид principal; по умолчанию agent' } },
    concurrencySafe: true,
    execute: async (a, exec) => {
      const kind = str(a.kind) ?? 'agent'
      const directory = await names.directory(exec.signal)
      const items = participants(directory, kind)
      if (items === null) {
        throw new Error(`список ${kind === 'agent' ? 'агентов' : 'участников'} недоступен: ${directory.degraded.join('; ')} — у учётки человека нет права на чтение (${kind === 'agent' ? 'agents.read или principals.read' : 'principals.read'})`)
      }
      return { items, degraded: directory.degraded }
    },
  }))

  add(tool({
    name: 'cp_workspace_members',
    description: 'Участники workspace — те же, что на экране «Люди и роли»: явные члены и держатели ролей workspace (люди, агенты, сервисы). Для каждого — principal id, имя, вид, статус, ключ агента, признак member и роли. member: true — явное членство в workspace. member: false — участник только по роли: у него роль этого workspace (назначенная здесь, в предке или на весь tenant) либо любая роль, назначенная в самом этом workspace; это тоже участник, а не «никто». Роль tenant, назначенная выше этого workspace, участником не делает. roles — роли, по которым principal участвует (slug, name, где выдано назначение); roles: null — роли неизвестны (см. degraded). По умолчанию — выбранный workspace (scope). Называй участников по имени. Полный список требует прав workspaces.read и org.read или principals.read; без второго — только явные члены и пометка в degraded.',
    parameters: { workspaceId: { type: 'string', description: 'UUID workspace; пусто — выбранный workspace' } },
    concurrencySafe: true,
    execute: async (a, exec) => {
      const workspaceId = str(a.workspaceId) ?? (await cp.scope(exec.signal)).workspaceId
      if (!workspaceId) throw new Error('workspace не выбран: укажи workspaceId (cp_workspaces)')
      const degraded: string[] = []
      let found: { principalId: string, kind: string | null, displayName: string | null, status: string | null, member: boolean, roles: ParticipantRoleOut[] | null }[]
      let cursor: string | null = null
      try {
        const participants: WorkspaceParticipantOut[] = []
        for (let page = 0; page < 5; page++) {
          const result = await cp.client.listWorkspaceParticipants(workspaceId, { limit: 200, cursor }, exec.signal)
          participants.push(...result.items)
          cursor = result.nextCursor
          if (cursor === null) break
        }
        found = participants.map(p => ({ ...p, roles: uniqueRoles(p.roles) }))
      } catch (error) {
        // Без org.read/principals.read (403) или на ядре без /participants (404) — явные
        // члены из /members с пометкой неполноты, а не отказ инструмента.
        if (!(error instanceof ControlPlaneError) || (error.status !== 403 && error.status !== 404)) throw error
        degraded.push(error.status === 403 ? 'participants: 403 (org.read, principals.read)' : 'participants: 404 (ядро без /participants)')
        const members: WorkspaceMemberOut[] = []
        cursor = null
        for (let page = 0; page < 5; page++) {
          const result = await cp.client.listWorkspaceMembers(workspaceId, { limit: 200, cursor }, exec.signal)
          members.push(...result.items)
          cursor = result.nextCursor
          if (cursor === null) break
        }
        found = members.map(m => ({ principalId: m.principalId, kind: null, displayName: null, status: null, member: true, roles: null }))
      }
      const directory = await names.directory(exec.signal)
      return {
        workspaceId,
        items: found.map((p) => {
          const named = directory.byId.get(p.principalId)
          return {
            principalId: p.principalId,
            name: named?.name ?? p.displayName,
            kind: p.kind ?? named?.kind ?? null,
            status: p.status,
            agentKey: named?.agentKey ?? null,
            url: named?.agentKey ? consoleUrl.agent(named.agentKey) : null,
            member: p.member,
            roles: p.roles,
          }
        }),
        truncated: cursor !== null,
        degraded: [...degraded, ...directory.degraded],
      }
    },
  }))

  add(tool({
    name: 'cp_task_types',
    description: 'Типы работ, разрешённые в workspace (с наследованием от предков): id версии типа (для cp_task_type_executors), ключ (type в cp_propose_task), имя и описание. По умолчанию — выбранный workspace (scope). Только чтение.',
    parameters: { workspaceId: { type: 'string', description: 'UUID workspace; пусто — выбранный workspace' } },
    concurrencySafe: true,
    execute: async (a, exec) => {
      const workspaceId = str(a.workspaceId) ?? (await cp.scope(exec.signal)).workspaceId
      if (!workspaceId) throw new Error('workspace не выбран: укажи workspaceId (cp_workspaces)')
      const page = await cp.client.listTaskTypes({ workspaceId, status: 'active' }, exec.signal)
      return {
        workspaceId,
        items: page.items.map(t => ({ id: t.id, key: t.key, version: t.version, displayName: t.displayName, description: t.description })),
        truncated: page.nextCursor !== null,
      }
    },
  }))

  add(tool({
    name: 'cp_task_type_executors',
    description: 'Кто может взять тип работы в workspace: principal id (exec в cp_propose_task), имя, вид (human, agent, service), роли и причина (reason). typeId — id версии типа из cp_task_types. Пустой список — исполнителя нет, предложение без exec. Только чтение.',
    parameters: {
      typeId: { type: 'string', description: 'id версии типа (cp_task_types)' },
      workspaceId: { type: 'string', description: 'UUID workspace; пусто — выбранный workspace' },
    },
    required: ['typeId'],
    concurrencySafe: true,
    execute: async (a, exec) => {
      const workspaceId = str(a.workspaceId) ?? (await cp.scope(exec.signal)).workspaceId
      if (!workspaceId) throw new Error('workspace не выбран: укажи workspaceId (cp_workspaces)')
      const { items } = await cp.client.listTaskTypeExecutors(str(a.typeId) ?? '', workspaceId, exec.signal)
      return { workspaceId, items }
    },
  }))

  add(tool({
    name: 'cp_propose_task',
    description: 'Ссылка-предложение работы для консоли: на «поручи…», «заведи работу…» отвечай ею, а не cp_create_task или cp_delegate. Ничего не создаёт: консоль покажет карточку «Будет заведена работа — нужна ваша подпись», и работу заведёт сам человек кнопкой «Завести работу». Пустые поля отбрасываются, длинные режутся по пределам консоли (title — 500, result и basis — 2000). Дай ссылку человеку как есть: [Завести работу: что сделать](url).',
    parameters: {
      title: { type: 'string', description: 'Что сделать' },
      type: { type: 'string', description: 'Ключ типа работы (cp_task_types)' },
      exec: { type: 'string', description: 'principal id исполнителя (cp_task_type_executors); не нашёл — не передавай' },
      owner: { type: 'string', description: 'principal id владельца; по умолчанию — сам человек' },
      due: { type: 'string', description: 'Срок: ГГГГ-ММ-ДД (18:00 по часам человека) или ISO date-time' },
      ws: { type: 'string', description: 'UUID workspace; пусто — выбранный workspace' },
      result: { type: 'string', description: 'Ожидаемый результат' },
      basis: { type: 'string', description: 'Основание: откуда взялась работа' },
    },
    required: ['title'],
    concurrencySafe: true,
    execute: async (a, exec) => {
      const ws = str(a.ws) ?? (await cp.scope(exec.signal)).workspaceId
      return {
        url: consoleUrl.proposal({
          title: str(a.title) ?? '', type: str(a.type), exec: str(a.exec), owner: str(a.owner), due: str(a.due), ws, result: str(a.result), basis: str(a.basis),
        }),
      }
    },
  }))

  add(tool({
    name: 'cp_delegate',
    description: 'Поручить работу исполнителю (агенту или человеку): задача Control Plane с исполнителем, вами как владельцем и происхождением harness. Не для просьбы человека поручить или завести работу — на неё отвечай ссылкой cp_propose_task, работу заведёт сам человек. По умолчанию результат вернётся вам на приёмку (стадия проверки ядра, критерий human) и появится в «Важном». Требует подтверждения человека: сначала покажи черновик — что поручаем, кому, критерии готовности, срок.',
    parameters: {
      title: { type: 'string' },
      description: { type: 'string', description: 'Что сделать и как понять, что готово' },
      assigneeId: { type: 'string', description: 'principal id исполнителя (cp_agents)' },
      workspaceId: { type: 'string' },
      typeKey: { type: 'string', description: 'Тип задачи; пусто — тип по умолчанию' },
      priority: { type: 'string' },
      dueDate: { type: 'string', description: 'ISO дата или дата-время' },
      parentTask: { type: 'string', description: 'publicId родительской задачи' },
      customFields: ANY_OBJECT,
      review: { type: 'boolean', description: 'Вернуть результат вам на приёмку (по умолчанию да)' },
    },
    required: ['title', 'assigneeId'],
    execute: async (a, exec) => {
      const who = await cp.whoami(exec.signal)
      const workspaceId = str(a.workspaceId) ?? who.scope.workspaceId ?? undefined
      const input = {
        title: str(a.title) ?? '', description: str(a.description), assigneeId: str(a.assigneeId) ?? '', workspaceId,
        typeKey: str(a.typeKey), priority: str(a.priority), dueDate: str(a.dueDate), parentTask: str(a.parentTask),
        customFields: (a.customFields as Json | undefined) ?? undefined, review: a.review === false ? false : true,
      }
      await confirm(ctx, exec, `Поручить «${input.title}» исполнителю ${input.assigneeId}${input.review ? ', результат — вам на приёмку' : ''}`, options)
      return cp.client.createTask(delegationBody(input, who.principal.id, cp.sessionId()), undefined, exec.signal)
    },
  }))

  add(tool({
    name: 'cp_run_progress',
    description: 'Ход поручения по задаче: последний прогон исполнителя, его последние действия (вызовы инструментов), checkpoints, артефакты, итог проверки и ждёт ли результат вашей приёмки. Только чтение.',
    parameters: { ref: { type: 'string', description: 'publicId задачи (TASK-000123) или id' } },
    required: ['ref'],
    concurrencySafe: true,
    execute: async (a, exec) => {
      const progress = await runProgress(cp.client, str(a.ref) ?? '', exec.signal)
      return {
        ...progress,
        task: { ...progress.task, assignee: await nameOf(progress.task.assigneeId, exec.signal), url: consoleUrl.task(progress.task.publicId) },
        ...(progress.run ? { runUrl: consoleUrl.run(progress.run.id) } : {}),
      }
    },
  }))

  add(tool({
    name: 'cp_process_instance',
    description: 'Экземпляр процесса по id (экран /console/processes/<id>): статус, текущие шаги с их задачами, шаг и ошибка падения из журнала решений (failure), записи ошибок, хвост журнала с именами участников, работа, которую завёл экземпляр (tasks), и задачи, где упомянут экземпляр, — кандидаты в задачу-исправление (fixTasks). Отвечая, назови шаг и ошибку и дай ссылки: на экземпляр (url) и на задачи ([TASK-…](url)). Только чтение.',
    parameters: { instanceId: { type: 'string', description: 'UUID экземпляра (id экрана process_instance)' } },
    required: ['instanceId'],
    concurrencySafe: true,
    execute: (a, exec) => processInstance(cp.client, names, str(a.instanceId) ?? '', exec.signal),
  }))

  add(tool({
    name: 'cp_find_process_instances',
    description: 'Найти экземпляры процессов: по ключу процесса (bill-payment), ключу экземпляра, статусу (running, suspended, completed, failed, cancelled), workspace (по умолчанию выбранный). Возвращает id, статус, итог, открытые шаги и ссылку; подробности и журнал — cp_process_instance.',
    parameters: {
      definitionKey: { type: 'string' },
      instanceKey: { type: 'string' },
      status: { type: 'string', enum: ['running', 'suspended', 'completed', 'failed', 'cancelled'] },
      workspaceId: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    concurrencySafe: true,
    execute: async (a, exec) => {
      const workspaceId = str(a.workspaceId) ?? (await cp.scope(exec.signal)).workspaceId ?? undefined
      const page = await cp.client.listProcessInstances({
        definitionKey: str(a.definitionKey), instanceKey: str(a.instanceKey), status: str(a.status), workspaceId, limit: num(a.limit) ?? 20,
      }, exec.signal)
      return {
        items: page.items.map(i => ({
          id: i.id, process: `${i.definitionKey}@${i.definitionVersion}`, instanceKey: i.instanceKey, status: i.status, outcome: i.outcome ?? null,
          currentSteps: i.openElements.map(e => e.id), startedAt: i.startedAt, updatedAt: i.updatedAt, url: consoleUrl.process(i.id),
        })),
        nextCursor: page.nextCursor,
      }
    },
  }))

  const workspacePath = options.workspacePath
  if (workspacePath !== undefined) {
    add(tool({
      name: 'cp_fetch_artifact',
      description: 'Скачать содержимое артефакта ядра (документ, таблицу, PDF) в рабочий каталог беседы, чтобы показать его человеку: верни ссылку на файл в формате [имя](путь) — она открывает просмотр в окне (DOCX, XLSX, CSV, PDF, Markdown, картинки). Активное содержимое (HTML, SVG) сохраняется как текст. У артефакта без файла (сводка раннера, результат скилла) приходит его запись: record.content (JSON, её же файл .json) или record.uri. Только чтение ядра.',
      parameters: { artifactId: { type: 'string', description: 'id артефакта (uuid) из cp_run_progress или карточки задачи' } },
      required: ['artifactId'],
      concurrencySafe: true,
      execute: (a, exec) => fetchArtifact(cp.client, workspacePath, str(a.artifactId) ?? '', exec.signal),
    }))
  }

  add(tool({
    name: 'cp_review',
    description: 'Приёмка результата поручения на стадии проверки: accept — принять (задача завершится), return — вернуть исполнителю с замечанием (оно станет заданием следующей итерации; замечание обязательно). Перед вызовом покажи человеку evidence из cp_run_progress: что сделано, артефакты, критерии. Требует подтверждения.',
    parameters: {
      ref: { type: 'string', description: 'publicId задачи' },
      decision: { type: 'string', enum: ['accept', 'return'] },
      comment: { type: 'string', description: 'Замечание (обязательно при return)' },
    },
    required: ['ref', 'decision'],
    execute: async (a, exec) => {
      const ref = str(a.ref) ?? ''
      const decision = a.decision === 'return' ? 'return' : 'accept'
      const comment = str(a.comment) ?? null
      if (decision === 'return' && comment === null) throw new Error('вернуть результат можно только с замечанием')
      await confirm(ctx, exec, decision === 'accept' ? `Принять результат ${ref}` : `Вернуть ${ref} исполнителю: «${comment}»`, options)
      return review(cp.client, ref, decision, comment, exec.signal)
    },
  }))

  const work = options.work
  if (work !== undefined) {
    add(tool({
      name: 'cp_take_task',
      description: 'Взять назначенную человеку задачу в работу: claim и run в Control Plane под сессией харнесса — та же дисциплина, что у агента. Возвращает контекст прогона (инструкции, входы) и checkpoints прошлого прогона, если работа продолжается. Требует подтверждения. Повторный вызов для уже взятой задачи ничего не создаёт.',
      parameters: { ref: { type: 'string', description: 'publicId задачи' }, intent: { type: 'string', description: 'Что человек собирается сделать' } },
      required: ['ref'],
      execute: async (a, exec) => {
        const ref = str(a.ref) ?? ''
        const already = (await work.active()).some(w => w.taskRef === ref || w.taskId === ref)
        if (!already) await confirm(ctx, exec, `Взять ${ref} в работу (claim и run от вашего имени)`, options)
        return work.take(ref, str(a.intent) ?? null, exec.signal)
      },
    }))

    add(tool({
      name: 'cp_active_work',
      description: 'Какая работа сейчас взята человеком в этом харнессе: задача, run, с какого времени.',
      parameters: {},
      concurrencySafe: true,
      execute: () => work.active(),
    }))

    add(tool({
      name: 'cp_checkpoint',
      description: 'Записать checkpoint во взятой работе: что сделано, что дальше, решения — чтобы работу можно было продолжить после перерыва или сбоя. Без секретов и черновиков мыслей. Подтверждение не требуется: это журнал уже взятой работы.',
      parameters: { ref: { type: 'string' }, kind: { type: 'string', description: 'progress | decision | handoff' }, data: ANY_OBJECT },
      required: ['ref', 'data'],
      execute: (a, exec) => work.checkpoint(str(a.ref) ?? '', str(a.kind) ?? 'progress', (a.data as Json | undefined) ?? {}, exec.signal),
    }))

    add(tool({
      name: 'cp_register_artifact',
      description: 'Зарегистрировать результат взятой работы: файл из рабочего каталога беседы (file — документ Word/Excel/PowerPoint, PDF, таблица; загружается в хранилище ядра), ссылка на внешнюю систему (uri — документ в СЭД, коммит, ветка) или небольшой JSON (content) — что-то одно. Требует подтверждения.',
      parameters: {
        ref: { type: 'string' }, type: { type: 'string', description: 'Тип артефакта (document, report, commit…)' }, name: { type: 'string' },
        file: { type: 'string', description: 'Путь к файлу в рабочем каталоге беседы (например reports/akt.docx)' },
        uri: { type: 'string' }, content: ANY_OBJECT, metadata: ANY_OBJECT,
      },
      required: ['ref', 'type', 'name'],
      execute: async (a, exec) => {
        const ref = str(a.ref) ?? ''
        const path = str(a.file)
        // Файл читается до подтверждения: человек видит, что именно уйдёт в ядро.
        const file = path !== undefined && workspacePath !== undefined ? readWorkspaceFile(workspacePath, path) : undefined
        if (path !== undefined && file === undefined) throw new Error('сдача файла недоступна: у харнесса нет рабочего каталога беседы')
        await confirm(ctx, exec, `Сдать артефакт «${str(a.name) ?? ''}» (${str(a.type) ?? ''}) по ${ref}${file ? ` — файл ${file.name}, ${Math.ceil(file.data.byteLength / 1024)} КБ` : ''}`, options)
        return work.artifact(ref, { type: str(a.type) ?? '', name: str(a.name) ?? '', uri: str(a.uri), content: a.content as Json | undefined, file, metadata: a.metadata as Json | undefined }, exec.signal)
      },
    }))

    add(tool({
      name: 'cp_complete_task',
      description: 'Сдать взятую работу: run завершается успешно, задача переходит к стадии проверки ядра (критерии приёмки). Перед вызовом покажи человеку итог и артефакты. Требует подтверждения.',
      parameters: { ref: { type: 'string' }, summary: { type: 'string', description: 'Что сделано — коротко, для проверяющего' }, output: ANY_OBJECT },
      required: ['ref', 'summary'],
      execute: async (a, exec) => {
        const ref = str(a.ref) ?? ''
        await confirm(ctx, exec, `Сдать ${ref}: «${str(a.summary) ?? ''}»`, options)
        return work.complete(ref, str(a.summary) ?? '', (a.output as Json | undefined) ?? {}, exec.signal)
      },
    }))

    add(tool({
      name: 'cp_release_task',
      description: 'Вернуть взятую работу без результата: run завершается с причиной, claim освобождается, задача снова доступна. Требует подтверждения.',
      parameters: { ref: { type: 'string' }, reason: { type: 'string' } },
      required: ['ref', 'reason'],
      execute: async (a, exec) => {
        const ref = str(a.ref) ?? ''
        await confirm(ctx, exec, `Вернуть ${ref} без результата: «${str(a.reason) ?? ''}»`, options)
        return work.release(ref, str(a.reason) ?? '', exec.signal)
      },
    }))
  }

  add(tool({
    name: 'cp_invoke_skill',
    description: 'Вызвать скилл из реестра Control Plane (name@version) с входами. Скилл с внешним эффектом (external_write) ядро выполнит только при основании — одобренном approval задачи или execution её типа. Перед вызовом покажи человеку, что изменится снаружи. Требует подтверждения; ждёт результат до 60 с.',
    parameters: {
      skill: { type: 'string', description: 'name@version' }, inputs: ANY_OBJECT,
      task: { type: 'string', description: 'publicId задачи, в рамках которой вызов' }, approvalId: { type: 'string' },
    },
    required: ['skill', 'inputs'],
    execute: async (a, exec) => {
      const skill = str(a.skill) ?? ''
      await confirm(ctx, exec, `Вызвать скилл ${skill}${str(a.task) ? ` по ${str(a.task)}` : ''}`, options)
      const taken = work ? (await work.active()).find(w => w.taskRef === str(a.task)) : undefined
      const taskId = taken?.taskId ?? (str(a.task) ? (await cp.client.getTask(str(a.task)!, exec.signal)).id : undefined)
      const approvalId = str(a.approvalId)
      const invocation = await cp.client.invokeSkill(skill, {
        inputs: (a.inputs as Json | undefined) ?? {},
        ...(taskId ? { taskId } : {}), ...(taken ? { runId: taken.runId } : {}), ...(approvalId ? { approvalId } : {}),
      }, undefined, exec.signal)
      const id = typeof invocation.id === 'string' ? invocation.id : undefined
      for (let i = 0; id !== undefined && i < 30; i++) {
        const state = await cp.client.skillInvocation(id, exec.signal)
        if (state.status === 'succeeded' || state.status === 'failed' || state.status === 'cancelled') return state
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
      return invocation
    },
  }))

  add(tool({
    name: 'cp_recall',
    description: 'Память компании и рабочий контекст через Context Gateway Control Plane: факты, решения, документы, история по задаче или workspace, с provenance. Единственный путь к памяти — прямого доступа к memory-service у харнесса нет.',
    parameters: {
      query: { type: 'string' },
      task: { type: 'string', description: 'publicId задачи для контекста' },
      workspaceId: { type: 'string' },
      projectId: { type: 'string' },
      maxTokens: { type: 'integer', minimum: 200, maximum: 8000 },
    },
    required: ['query'],
    concurrencySafe: true,
    execute: async (a, exec) => cp.client.context({
      query: str(a.query) ?? '', task: str(a.task) ?? null, workspaceId: str(a.workspaceId) ?? (await cp.scope(exec.signal)).workspaceId,
      projectId: str(a.projectId) ?? null, includeMemory: true, maxTokens: num(a.maxTokens) ?? null,
    }, exec.signal),
  }))

  add(tool({
    name: 'cp_remember',
    description: 'Записать наблюдение в память компании через Control Plane (Observation с provenance): решение, факт, договорённость. Требует подтверждения человека.',
    parameters: {
      kind: { type: 'string', description: 'Вид наблюдения: decision, fact, note, risk …' },
      content: { type: 'string' },
      task: { type: 'string' },
      workspaceId: { type: 'string' },
      data: ANY_OBJECT,
    },
    required: ['kind', 'content'],
    execute: async (a, exec) => {
      await confirm(ctx, exec, `Записать в память: ${str(a.kind)} — ${(str(a.content) ?? '').slice(0, 80)}`, options)
      return cp.client.observe({
        kind: str(a.kind) ?? 'note', content: str(a.content) ?? '', task: str(a.task) ?? null,
        workspaceId: str(a.workspaceId) ?? (await cp.scope(exec.signal)).workspaceId, sessionId: cp.sessionId(),
        data: (a.data as Json | undefined) ?? null,
      }, undefined, exec.signal)
    },
  }))

  return () => { for (const dispose of disposers.splice(0)) dispose() }
}
