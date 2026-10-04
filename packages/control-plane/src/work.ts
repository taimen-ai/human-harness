/**
 * Исполнение работы человеком вместе с ассистентом (spec human-harness, сценарий 7;
 * FR-011): человек берёт назначенную ему задачу, и она проходит те же claim → run →
 * артефакт → проверка, что у агента (ADR-0038 п.3, CP-ADR-0067).
 *
 * Харнесс хранит только ссылки на свои активные claim и run, чтобы продолжать heartbeat
 * и писать checkpoints; состояние работы — в ядре. После перезапуска прежние claim
 * принадлежат закрытой сессии и истекают: работа берётся заново, а контекст продолжения
 * приходит из checkpoints прошлого прогона.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ControlPlaneError, type ControlPlaneClient } from './client.ts'
import type { CheckpointOut } from './shared/types.ts'
import type { WorkspaceFile } from './artifact-files.ts'

export interface ActiveWork {
  taskRef: string
  taskId: string
  title: string
  claimId: string
  fencingToken: number
  runId: string
  sessionId: string
  startedAt: string
}

export interface TakeResult {
  work: ActiveWork
  /** Инструкции и входы исполнителю из контекста прогона. */
  context: Record<string, unknown>
  /** Последние checkpoints прошлого прогона — с чего продолжать. */
  previous: { runId: string, status: string, checkpoints: { kind: string, data: unknown, at: string }[] } | null
}

export const CLAIM_TTL_SECONDS = 1800

/** Файл активной работы principal'а; запись атомарна. */
export class WorkState {
  constructor(private readonly path: string) {}

  load(): ActiveWork[] {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as ActiveWork[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  save(items: ActiveWork[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(items, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.path)
  }
}

export class WorkTracker {
  constructor(
    private readonly client: ControlPlaneClient,
    private readonly state: WorkState,
    private readonly session: () => Promise<string>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Активная работа этой сессии; работа закрытых сессий отбрасывается. */
  async active(): Promise<ActiveWork[]> {
    const sessionId = await this.session()
    const items = this.state.load()
    const live = items.filter(w => w.sessionId === sessionId)
    if (live.length !== items.length) this.state.save(live)
    return live
  }

  private async find(ref: string): Promise<ActiveWork> {
    const work = (await this.active()).find(w => w.taskRef === ref || w.taskId === ref)
    if (work === undefined) {
      throw new ControlPlaneError(409, 'work_not_taken', `Задача ${ref} не взята в работу в этой сессии: сначала cp_take_task.`)
    }
    return work
  }

  /** Взять задачу: claim и run под сессией харнесса, контекст прогона и прошлые checkpoints. */
  async take(ref: string, intent: string | null, signal?: AbortSignal): Promise<TakeResult> {
    const existing = (await this.active()).find(w => w.taskRef === ref || w.taskId === ref)
    const task = await this.client.getTask(ref, signal)
    const previousRun = [...(await this.client.listRuns({ taskId: task.id, limit: 50 }, signal)).items]
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0]
    let work = existing
    if (work === undefined) {
      const sessionId = await this.session()
      const claim = await this.client.claimTask(task.publicId, { sessionId, ttlSeconds: CLAIM_TTL_SECONDS, ...(intent ? { intent } : {}) }, signal)
      const run = await this.client.startRun(task.publicId, { claimId: claim.id, fencingToken: claim.fencingToken }, signal)
      work = {
        taskRef: task.publicId, taskId: task.id, title: task.title, claimId: claim.id, fencingToken: claim.fencingToken,
        runId: run.id, sessionId, startedAt: this.now().toISOString(),
      }
      this.state.save([...(await this.active()), work])
    }
    const context = await this.client.runContext(work.runId, signal)
    let previous: TakeResult['previous'] = null
    if (previousRun && previousRun.id !== work.runId) {
      const checkpoints: CheckpointOut[] = (await this.client.listCheckpoints(previousRun.id, { limit: 100 }, signal)).items
      previous = {
        runId: previousRun.id,
        status: previousRun.status,
        checkpoints: checkpoints.slice(-5).map(c => ({ kind: c.kind, data: c.data, at: c.createdAt })),
      }
    }
    return { work, context, previous }
  }

  /** Продлить все свои claims (heartbeat сервиса). */
  async heartbeat(signal?: AbortSignal): Promise<void> {
    for (const work of await this.active()) {
      try {
        await this.client.heartbeatClaim(work.claimId, CLAIM_TTL_SECONDS, signal)
      } catch (error) {
        if (error instanceof ControlPlaneError && (error.status === 404 || error.status === 409)) {
          this.forget(work.claimId)
          continue
        }
        throw error
      }
    }
  }

  async checkpoint(ref: string, kind: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<CheckpointOut> {
    const work = await this.find(ref)
    return this.client.createCheckpoint(work.runId, { kind, data }, signal)
  }

  /**
   * Артефакт результата: ссылка на внешнюю систему, небольшой JSON или файл (H008b) —
   * файл из рабочего каталога беседы загружается в хранилище ядра (CP-ADR-0072) и
   * артефакт ссылается на загрузку (`contentRef`).
   */
  async artifact(ref: string, input: { type: string, name: string, uri?: string | undefined, content?: Record<string, unknown> | undefined, file?: WorkspaceFile | undefined, metadata?: Record<string, unknown> | undefined }, signal?: AbortSignal) {
    const work = await this.find(ref)
    const given = [input.uri, input.content, input.file].filter(v => v !== undefined).length
    if (given === 0) throw new ControlPlaneError(400, 'artifact_empty', 'Артефакт — это ссылка (uri), содержимое (content) или файл (file).')
    if (given > 1) throw new ControlPlaneError(400, 'artifact_ambiguous', 'Артефакт — что-то одно: uri, content или file.')
    let contentRef: string | undefined
    if (input.file !== undefined) {
      contentRef = (await this.client.uploadArtifactContent(input.file.data, input.file.mediaType, signal)).contentRef
    }
    return this.client.createArtifact({
      type: input.type, name: input.name, task: work.taskRef, runId: work.runId,
      ...(input.uri ? { uri: input.uri } : {}),
      ...(input.content ? { content: input.content } : {}),
      ...(contentRef ? { contentRef } : {}),
      metadata: input.metadata ?? {},
    }, signal)
  }

  /** Сдать работу: run succeeded, задача завершается и уходит на стадию проверки ядра. */
  async complete(ref: string, summary: string, output: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    const work = await this.find(ref)
    const result = await this.client.succeedRun(work.runId, { output: { summary, ...output }, completeTask: true }, signal)
    this.forget(work.claimId)
    return result
  }

  /** Вернуть работу в очередь: run failed с причиной, claim освобождён. */
  async release(ref: string, reason: string, signal?: AbortSignal): Promise<{ released: string }> {
    const work = await this.find(ref)
    await this.client.failRun(work.runId, { failureReason: reason }, signal)
    try {
      await this.client.releaseClaim(work.claimId, reason, signal)
    } catch (error) {
      if (!(error instanceof ControlPlaneError && (error.status === 404 || error.status === 409))) throw error
    }
    this.forget(work.claimId)
    return { released: work.taskRef }
  }

  private forget(claimId: string): void {
    this.state.save(this.state.load().filter(w => w.claimId !== claimId))
  }
}
