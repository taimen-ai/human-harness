/**
 * `ctx.controlPlane` — сервис Human Harness над Control Plane: identity сессии,
 * scope поверхности, «Важное» (проекция ядра `me/attention`) и доменные команды.
 * Не хранит организационное состояние: всё перечитывается с сервера.
 */
import { hostname } from 'node:os'
import type { HarnessIdentity } from '@human-harness/dsh-identity'
import { ControlPlaneClient, ControlPlaneError } from './client.ts'
import type {
  AttentionFeedback, AttentionList, HarnessContext, Scope, WhoAmI, WorkspaceNode, WorkspacesProjection,
} from './shared/types.ts'
import type { ReadStateStore } from './state.ts'

export const CLIENT_NAME = 'human-harness'
export const HARNESS_TYPE = 'deepseek-harness'
export const PROTOCOL_VERSION = '2'
export const HARNESS_CAPABILITIES = ['tasks.interactive', 'approvals.interactive', 'artifacts.publish', 'resume']

export interface ControlPlaneServiceOptions {
  client: ControlPlaneClient
  identity: HarnessIdentity
  state: ReadStateStore
  clientVersion: string
  sessionTtlSeconds: number
  /** Каталог workspace ассистента (создаётся при старте). */
  assistantWorkspacePath?: string | null
  /** Имя приложения для человека (white-label). */
  appName?: string
  log: { info(msg: string): void, warn(msg: string): void, error(msg: string): void }
  now?: () => Date
}

export interface ControlPlane {
  readonly client: ControlPlaneClient
  whoami(signal?: AbortSignal): Promise<WhoAmI>
  /** «Важное» — проекция ядра `GET /me/attention` в scope поверхности (CP-ADR-0071). */
  attention(signal?: AbortSignal): Promise<AttentionList>
  /** Обратная связь по элементу «Важного»: нужно или не нужно было показывать. */
  attentionFeedback(itemKey: string, verdict: 'useful' | 'not_needed', comment?: string | null): Promise<AttentionFeedback>
  workspaces(signal?: AbortSignal): Promise<WorkspacesProjection>
  selectWorkspace(workspaceId: string | null, signal?: AbortSignal): Promise<Scope>
  scope(signal?: AbortSignal): Promise<Scope>
  sessionId(): string | null
  /** Открыть Session харнесса в Control Plane (идемпотентно), вернуть id. */
  ensureSession(signal?: AbortSignal): Promise<string>
  dispose(): Promise<void>
}

export class ControlPlaneService implements ControlPlane {
  readonly client: ControlPlaneClient
  private session: { id: string, expiresAt: string } | null = null
  private sessionPromise: Promise<string> | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private context: { value: HarnessContext, at: number } | null = null
  private tree: { value: { flat: WorkspacesProjection['items'], degraded: string | null }, at: number } | null = null
  private readonly now: () => Date

  constructor(private readonly options: ControlPlaneServiceOptions) {
    this.client = options.client
    this.now = options.now ?? (() => new Date())
  }

  sessionId(): string | null {
    return this.session?.id ?? null
  }

  async ensureSession(signal?: AbortSignal): Promise<string> {
    if (this.session !== null) return this.session.id
    if (this.sessionPromise !== null) return this.sessionPromise
    this.sessionPromise = (async () => {
      const opened = await this.client.openSession({
        clientName: CLIENT_NAME,
        clientVersion: this.options.clientVersion,
        ttlSeconds: this.options.sessionTtlSeconds,
        metadata: { surface: 'human-work-surface', product: 'human-harness' },
        harness: {
          type: HARNESS_TYPE,
          version: this.options.clientVersion,
          protocolVersion: PROTOCOL_VERSION,
          capabilities: HARNESS_CAPABILITIES,
          hostname: hostname(),
        },
      }, signal)
      this.session = { id: opened.id, expiresAt: opened.expiresAt }
      this.startHeartbeat()
      this.options.log.info(`control-plane: session ${opened.id} открыта (до ${opened.expiresAt})`)
      return opened.id
    })().finally(() => { this.sessionPromise = null })
    return this.sessionPromise
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== null) return
    const periodMs = Math.max(15_000, Math.floor(this.options.sessionTtlSeconds * 1000 / 3))
    this.heartbeat = setInterval(() => {
      const id = this.session?.id
      if (id === undefined) return
      this.client.heartbeatSession(id, this.options.sessionTtlSeconds).then(
        (s) => { this.session = { id: s.id, expiresAt: s.expiresAt } },
        (error: unknown) => {
          if (error instanceof ControlPlaneError && (error.status === 404 || error.status === 409 || error.status === 410)) {
            this.options.log.warn(`control-plane: session ${id} потеряна (${error.code}) — будет открыта заново`)
            this.session = null
            void this.ensureSession().catch((e: unknown) => this.options.log.error(`control-plane: не удалось переоткрыть session: ${String(e)}`))
            return
          }
          this.options.log.warn(`control-plane: heartbeat не прошёл: ${String(error)}`)
        },
      )
    }, periodMs)
    this.heartbeat.unref?.()
  }

  async dispose(): Promise<void> {
    if (this.heartbeat !== null) { clearInterval(this.heartbeat); this.heartbeat = null }
    const id = this.session?.id
    this.session = null
    if (id !== undefined) {
      try {
        await this.client.closeSession(id)
        this.options.log.info(`control-plane: session ${id} закрыта`)
      } catch (error) {
        this.options.log.warn(`control-plane: не удалось закрыть session ${id}: ${String(error)}`)
      }
    }
  }

  private async harnessContext(signal?: AbortSignal): Promise<HarnessContext> {
    const at = this.now().getTime()
    if (this.context !== null && at - this.context.at < 30_000) return this.context.value
    const sessionId = await this.ensureSession(signal)
    const value = await this.client.harnessContext(sessionId, signal)
    this.context = { value, at }
    return value
  }

  private async workspaceTree(signal?: AbortSignal): Promise<{ flat: WorkspacesProjection['items'], degraded: string | null }> {
    const at = this.now().getTime()
    if (this.tree !== null && at - this.tree.at < 120_000) return this.tree.value
    let value: { flat: WorkspacesProjection['items'], degraded: string | null }
    try {
      const { roots } = await this.client.workspaceTree(signal)
      const flat: WorkspacesProjection['items'] = []
      const walk = (nodes: WorkspaceNode[], depth: number): void => {
        for (const node of [...nodes].sort((a, b) => a.name.localeCompare(b.name, 'ru'))) {
          flat.push({ id: node.id, parentId: node.parentId, depth, slug: node.slug, name: node.name, status: node.status, hasProject: node.project != null })
          if (node.children && node.children.length > 0) walk(node.children, depth + 1)
        }
      }
      walk(roots, 0)
      value = { flat, degraded: null }
    } catch (error) {
      if (!(error instanceof ControlPlaneError && error.status === 403)) throw error
      value = { flat: [], degraded: `workspaces: ${error.code} (${JSON.stringify(error.details.required ?? [])})` }
    }
    this.tree = { value, at }
    return value
  }

  /** Текущий scope: выбранный workspace с потомками либо весь tenant. Выбор, исчезнувший из дерева, сбрасывается. */
  async scope(signal?: AbortSignal): Promise<Scope> {
    const context = await this.harnessContext(signal)
    const state = this.options.state.get(context.principal.id)
    const selected = state.workspaceId ?? null
    if (selected === null) return { workspaceId: null, slug: null, name: null, workspaceIds: [] }
    const { flat } = await this.workspaceTree(signal)
    const node = flat.find(w => w.id === selected)
    if (node === undefined) return { workspaceId: null, slug: null, name: null, workspaceIds: [] }
    const ids = new Set<string>([node.id])
    for (const w of flat) if (w.parentId !== null && ids.has(w.parentId)) ids.add(w.id)
    return { workspaceId: node.id, slug: node.slug, name: node.name, workspaceIds: [...ids] }
  }

  async workspaces(signal?: AbortSignal): Promise<WorkspacesProjection> {
    const context = await this.harnessContext(signal)
    const { flat, degraded } = await this.workspaceTree(signal)
    const scope = await this.scope(signal)
    return { principalId: context.principal.id, computedAt: this.now().toISOString(), items: flat, selectedId: scope.workspaceId, degraded: degraded ? [degraded] : [] }
  }

  async selectWorkspace(workspaceId: string | null, signal?: AbortSignal): Promise<Scope> {
    const context = await this.harnessContext(signal)
    if (workspaceId !== null) {
      const { flat } = await this.workspaceTree(signal)
      if (!flat.some(w => w.id === workspaceId)) throw new ControlPlaneError(404, 'workspace_not_found', `workspace ${workspaceId} нет в дереве tenant'а`)
    }
    const me = context.principal.id
    this.options.state.set(me, { ...this.options.state.get(me), workspaceId })
    this.options.log.info(`control-plane: scope → ${workspaceId ?? 'весь tenant'}`)
    return this.scope(signal)
  }

  async attention(signal?: AbortSignal): Promise<AttentionList> {
    const scope = await this.scope(signal)
    try {
      const list = await this.client.attention({ workspaceId: scope.workspaceId, includeDescendants: true }, signal)
      return { ...list, scope }
    } catch (error) {
      // Ядро старше CP-ADR-0071: маршрута нет. Окно работает, «Важное» честно пустое с пометкой.
      if (!(error instanceof ControlPlaneError && error.status === 404 && error.details.itemKey === undefined)) throw error
      return {
        items: [],
        degraded: [{ rule: 'me/attention', reasonCode: 'endpoint_missing', message: 'Control Plane без GET /me/attention (CP-ADR-0071)' }],
        generatedAt: this.now().toISOString(),
        scope,
      }
    }
  }

  attentionFeedback(itemKey: string, verdict: 'useful' | 'not_needed', comment?: string | null): Promise<AttentionFeedback> {
    return this.client.attentionFeedback(itemKey, { verdict, ...(comment ? { comment } : {}) })
  }

  async whoami(signal?: AbortSignal): Promise<WhoAmI> {
    const context = await this.harnessContext(signal)
    const identity = this.options.identity.describe()
    return {
      tenant: context.tenant,
      principal: context.principal,
      permissions: context.permissions,
      roles: context.roles ?? [],
      session: this.session,
      identity: { issuer: identity.issuer, tenantId: identity.tenantId, principalId: identity.principalId },
      server: this.client.serverUrl,
      assistantWorkspacePath: this.options.assistantWorkspacePath ?? null,
      appName: this.options.appName ?? 'Human Harness',
      scope: await this.scope(signal),
    }
  }

}
