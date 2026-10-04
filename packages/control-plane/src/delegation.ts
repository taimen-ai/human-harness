/**
 * Делегирование работы и приёмка результата (spec human-harness, сценарий 6;
 * FR-010). Поручение — обычная задача ядра с исполнителем и происхождением
 * `harness`; приёмка — gate-approval стадии проверки (CP-ADR-0067), который ядро
 * заводит на поручившего по критерию `human`. Харнесс ничего не хранит: ход и
 * итог читаются из ядра.
 */
import { ControlPlaneError, type ControlPlaneClient } from './client.ts'
import { artifactRef, type ArtifactRef } from './artifact-files.ts'
import type { ApprovalOut, TaskOut } from './shared/types.ts'

export interface DelegateInput {
  title: string
  description?: string | undefined
  assigneeId: string
  workspaceId?: string | undefined
  typeKey?: string | undefined
  priority?: string | undefined
  dueDate?: string | undefined
  parentTask?: string | undefined
  customFields?: Record<string, unknown> | undefined
  /** Результат возвращается поручившему на проверку (критерий `human`). По умолчанию — да. */
  review?: boolean | undefined
}

/** Тело `POST /tasks` поручения: происхождение `harness`, приёмка поручившим. */
export function delegationBody(input: DelegateInput, me: string, sessionId: string | null): Record<string, unknown> {
  const review = input.review !== false
  return {
    title: input.title,
    description: input.description ?? '',
    assigneeId: input.assigneeId,
    ownerId: me,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.typeKey ? { typeKey: input.typeKey } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.dueDate ? { dueDate: input.dueDate } : {}),
    ...(input.parentTask ? { parentTask: input.parentTask } : {}),
    ...(input.customFields ? { customFields: input.customFields } : {}),
    origin: { kind: 'harness', ...(sessionId ? { ref: `session:${sessionId}` } : {}) },
    ...(review
      ? {
          acceptance: [{
            key: 'delegator-review',
            kind: 'human',
            description: 'Результат принимает поручивший: принять или вернуть с замечанием.',
            spec: { approver: me },
          }],
        }
      : {}),
  }
}

export interface RunProgress {
  task: { publicId: string, title: string, status: string, systemStatusCategory: string, assigneeId: string | null }
  run: { id: string, status: string, startedAt: string, finishedAt: string | null, failureReason: string | null } | null
  /** Последние действия прогона — вызовы инструментов агента (ADR-0051), новые в конце. */
  actions: { at: string, action: string, status: string, summary: string | null }[]
  checkpoints: { at: string, kind: string, data: string }[]
  /** id — для cp_fetch_artifact; contentState stored — файл, none — запись JSON или ссылка. */
  artifacts: ArtifactRef[]
  verification: unknown
  pendingReview: { approvalId: string, requestedAt: string } | null
}

function clip(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Ход поручения: последний прогон, его действия, checkpoints, артефакты задачи, итог проверки. */
export async function runProgress(client: ControlPlaneClient, ref: string, signal?: AbortSignal): Promise<RunProgress> {
  const task = await client.getTask(ref, signal)
  const runs = (await client.listRuns({ taskId: task.id, limit: 50 }, signal)).items
  const run = [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0] ?? null
  const [actions, checkpoints, artifacts, review] = await Promise.all([
    run ? client.listRunActions(run.id, { limit: 200 }, signal).then(p => p.items) : Promise.resolve([]),
    run ? client.listCheckpoints(run.id, { limit: 100 }, signal).then(p => p.items) : Promise.resolve([]),
    client.listArtifacts({ taskId: task.id, limit: 50 }, signal).then(p => p.items),
    pendingReview(client, task, signal),
  ])
  const raw = run as (typeof run & { failureReason?: string | null, finishedAt?: string | null }) | null
  return {
    task: { publicId: task.publicId, title: task.title, status: task.status, systemStatusCategory: task.systemStatusCategory, assigneeId: task.assigneeId },
    run: raw ? { id: raw.id, status: raw.status, startedAt: raw.startedAt, finishedAt: raw.finishedAt ?? null, failureReason: raw.failureReason ?? null } : null,
    actions: actions.slice(-15).map(a => ({
      at: a.startedAt ?? a.createdAt,
      action: a.action,
      status: a.status,
      summary: typeof (a.metadata as Record<string, unknown> | null)?.summary === 'string' ? (a.metadata as Record<string, string>).summary! : null,
    })),
    checkpoints: checkpoints.slice(-3).map(c => ({ at: c.createdAt, kind: c.kind, data: clip(c.data, 400) })),
    artifacts: artifacts.map(artifactRef),
    verification: (task as TaskOut & { verification?: unknown }).verification ?? null,
    pendingReview: review ? { approvalId: review.id, requestedAt: review.createdAt } : null,
  }
}

/** Ожидающий gate-approval приёмки по задаче (стадия проверки). */
export async function pendingReview(client: ControlPlaneClient, task: TaskOut, signal?: AbortSignal): Promise<ApprovalOut | null> {
  const page = await client.listApprovals({ taskId: task.id, status: 'pending', limit: 20 }, signal)
  return page.items.find(a => a.gate) ?? null
}

/** Приёмка: accept — принять результат, return — вернуть исполнителю с замечанием. */
export async function review(
  client: ControlPlaneClient,
  ref: string,
  decision: 'accept' | 'return',
  comment: string | null,
  signal?: AbortSignal,
): Promise<{ task: string, approvalId: string, decision: 'accept' | 'return', approval: ApprovalOut }> {
  if (decision === 'return' && (comment === null || comment.trim() === '')) {
    throw new ControlPlaneError(400, 'comment_required', 'Вернуть результат можно только с замечанием: оно станет заданием следующей итерации.')
  }
  const task = await client.getTask(ref, signal)
  const gate = await pendingReview(client, task, signal)
  if (gate === null) {
    throw new ControlPlaneError(409, 'no_pending_review', `У ${task.publicId} нет результата, ждущего приёмки (gate-approval стадии проверки).`)
  }
  const approval = await client.decideApproval(gate.id, decision === 'accept' ? 'approve' : 'reject', comment, undefined, signal)
  return { task: task.publicId, approvalId: gate.id, decision, approval }
}
