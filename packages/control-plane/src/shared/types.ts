/**
 * Типы контракта Control Plane и проекций Human Work Surface (ADR-0024). DTO ядра —
 * из сгенерированных по снимку OpenAPI типов (`generated/control-plane-api.ts`,
 * `pnpm gen:cp-types`), руками описаны только ответы без схемы в OpenAPI и
 * проекции. Файл — общий для host-плагина и браузерного клиента: без импортов из Node.
 */
import type { components } from '../generated/control-plane-api.ts'

type Schemas = components['schemas']

export type TaskOut = Schemas['TaskOut']
export type ApprovalOut = Schemas['ApprovalOut']
export type EventPageOut = Omit<Schemas['EventPageOut'], 'items'> & { items: EventOut[] }
export type TaskTypeOut = Omit<Schemas['TaskTypeOut'], 'lifecycleSchema'> & { lifecycleSchema: LifecycleSchema }
export type TaskTypeExecutorsOut = Schemas['TaskTypeExecutorsOut']
export type SessionOut = Schemas['SessionOut']
export type TaskCommentOut = Schemas['TaskCommentOut']
export type RunOut = Schemas['RunOut']
export type PrincipalOut = Schemas['PrincipalOut']
export type RunActionOut = Schemas['RunActionOut']
export type CheckpointOut = Schemas['CheckpointOut']
export type ArtifactOut = Schemas['ArtifactOut']
export type ClaimOut = Schemas['ClaimOut']
export type AgentOut = Schemas['AgentOut']
export type WorkspaceMemberOut = Schemas['WorkspaceMemberOut']
export type ProcessInstanceOut = Schemas['ProcessInstanceOut']
export type ProcessDefinitionOut = Schemas['ProcessDefinitionOut']

/** Запись журнала решений экземпляра процесса: в OpenAPI страница журнала без схемы элементов (`ProcessJournalEntryOut` ядра). */
export interface ProcessJournalEntry {
  seq: number
  at: string
  /** input, transition, stage, milestone, timer, intent, vote, recall, compensation, migration, error */
  kind: string
  element: string | null
  reason: string
  actorId: string | null
  eventId: string | null
  data: Record<string, unknown>
}

/** Роль, по которой principal участвует в workspace (`ParticipantRoleOut` ядра). */
export interface ParticipantRoleOut {
  roleId: string
  slug: string
  name: string
  /** Workspace, которому принадлежит роль; null — роль tenant. */
  roleWorkspaceId: string | null
  /** Где выдано назначение: этот workspace, его предок или null — tenant. */
  assignmentWorkspaceId: string | null
}

/**
 * Участник workspace (`GET /workspaces/{id}/participants`, CP-ADR-0010, амендмент
 * TASK-001194): явный член, держатель роли workspace или то и другое. В OpenAPI
 * страница без схемы элементов (`WorkspaceParticipantOut` ядра).
 */
export interface WorkspaceParticipantOut {
  principalId: string
  kind: string
  displayName: string
  status: string
  /** Явное членство (`/members`); false — участник только по роли. */
  member: boolean
  /** Назначения ролей, действующие в workspace; одна роль может прийти дважды (назначена на разных уровнях). */
  roles: ParticipantRoleOut[]
}

/** Конверт события ядра: в OpenAPI элементы `EventPageOut.items` без схемы — поля по каталогу событий. */
export interface EventOut {
  sequence: number
  id: string
  tenantId: string
  type: string
  entityType: string
  entityId: string
  actorId: string | null
  sessionId: string | null
  correlationId: string
  causationId: string | null
  requestId: string
  traceRunId: string | null
  payload: Record<string, unknown>
  occurredAt: string
  workspaceId?: string | null
  schemaVersion?: number
  cursor?: string
}

/** Страница списка ядра (`PageOut` в OpenAPI не типизирует элементы). */
export interface PageOut<T> {
  items: T[]
  nextCursor: string | null
}

/** Маркеры lifecycle_schema (ADR-0015 + `reviewStatus` из ADR-0024). */
export interface LifecycleSchema {
  claimStatus?: string
  releaseStatus?: string
  completionStatus?: string
  reviewStatus?: string
  [key: string]: unknown
}

/** Ответ `GET /api/v1/harness/context` (без схемы в openapi — поля по факту). */
export interface HarnessContext {
  tenant: { id: string, slug: string, name: string }
  principal: { id: string, kind: string, displayName: string, status: string }
  permissions: string[]
  roles?: { id: string, slug: string, name: string, workspaceId: string | null }[]
  session?: SessionOut
  eventCursor?: string
  [key: string]: unknown
}

// ---------------------------------------------------------------- «Важное»

/** Вид элемента «Важного» (CP-ADR-0071): правило ядра, по которому он попал в список. */
export type AttentionKind = 'decision' | 'review' | 'deadline' | 'blocked' | 'delegated_failure'

/** Действие над элементом — вызов API ядра. */
export interface AttentionAction {
  action: string
  method: string
  href: string
}

export interface AttentionFeedback {
  itemKey: string
  rule: string
  verdict: 'useful' | 'not_needed'
  comment: string | null
  recordedAt: string | null
}

/** Элемент `GET /api/v1/me/attention` (в OpenAPI ответ без схемы — поля по CP-ADR-0071). */
export interface AttentionItem {
  itemKey: string
  kind: AttentionKind | string
  reasonCode: string
  rule: string
  score: number
  entity: { type: string, id: string }
  title: string
  workspaceId: string | null
  taskId: string | null
  taskPublicId: string | null
  dueDate: string | null
  since: string | null
  details: Record<string, unknown>
  actions: AttentionAction[]
  feedback: AttentionFeedback | null
}

export interface AttentionList {
  items: AttentionItem[]
  degraded: { rule: string, reasonCode: string, message: string }[]
  generatedAt: string
  /** Scope поверхности, с которым посчитан список (добавляет харнесс). */
  scope?: Scope
}

export interface WhoAmI {
  tenant: HarnessContext['tenant']
  principal: HarnessContext['principal']
  permissions: string[]
  roles: NonNullable<HarnessContext['roles']>
  session: { id: string, expiresAt: string } | null
  identity: { issuer: string, tenantId: string, principalId: string | undefined }
  server: string
  /** Каталог на хосте харнесса, в котором открывается беседа ассистента (workspace DSH). */
  assistantWorkspacePath: string | null
  /** Имя приложения для человека (white-label, конфиг установки). */
  appName: string
  /** Выбранный workspace Control Plane как scope поверхности. */
  scope: Scope
}

/** Узел дерева workspace Control Plane (`GET /api/v1/workspaces/tree`). */
export interface WorkspaceNode {
  id: string
  parentId: string | null
  depth: number
  slug: string
  name: string
  status: string
  typeKey?: string
  project?: { id: string, statusKey: string, systemStatusCategory: string, status: string, templateKey?: string } | null
  children?: WorkspaceNode[]
}

/** Плоский список workspace для выбора scope + текущий выбор principal'а. */
export interface WorkspacesProjection {
  principalId: string
  computedAt: string
  items: { id: string, parentId: string | null, depth: number, slug: string, name: string, status: string, hasProject: boolean }[]
  selectedId: string | null
  degraded: string[]
}

/** Текущий scope проекций: выбранный workspace (с потомками) или весь tenant. */
export interface Scope {
  workspaceId: string | null
  slug: string | null
  name: string | null
  /** id выбранного workspace и всех потомков; пусто — весь tenant. */
  workspaceIds: string[]
}
