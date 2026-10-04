/**
 * `@human-harness/dsh-control-plane` — нативная связь Human Harness с Control Plane.
 * Публикует `ctx.controlPlane`, открывает Session харнесса, регистрирует
 * инструменты `cp_*` и маршруты `/api/harness/*` для панелей; проактивность —
 * события ядра по правилам значимости становятся ходами ассистента в беседе.
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@human-harness/dsh-identity'
import { ControlPlaneClient } from './client.ts'
import { mountRoutes } from './routes.ts'
import { ControlPlaneService, type ControlPlane } from './service.ts'
import { defaultStatePath, ReadStateStore } from './state.ts'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DshConversation } from './conversation.ts'
import { ChannelBridge, channelWindowUrl, NotifyClient } from './channel.ts'
import { mountLauncherSeam } from './launcher-seam.ts'
import { ApprovalHub, type ApprovalOutcome } from './approvals.ts'
import { SurfaceBridge } from './surface.ts'
import { applyScreenContext } from './screen-context.ts'
import { mountProactivity, nextWakeAt } from './proactivity.ts'
import { ChangeSignal } from './signal.ts'
import { registerTools } from './tools.ts'
import { WorkState, WorkTracker } from './work.ts'

export { ControlPlaneClient, ControlPlaneError, AUDIENCE } from './client.ts'
export { ControlPlaneService, type ControlPlane, CLIENT_NAME, HARNESS_TYPE } from './service.ts'
export { registerTools } from './tools.ts'
export { ROUTE_PREFIX } from './routes.ts'
export { parseRules, evaluate, type AttentionRule, type RuleSet } from './attention-rules.ts'
export { EventConsumer, CursorFile, type JournalEvent } from './events.ts'
export { Proactive, PLATFORM_EVENT_SOURCE } from './proactive.ts'
export { SurfaceBridge, SURFACE_VERSION } from './surface.ts'
export { renderScreenContext, screenContextMessage } from './screen-context.ts'
export { ApprovalHub } from './approvals.ts'
export * from './shared/index.ts'

export const name = 'harness-control-plane'
export const inject = ['tools', 'harnessIdentity']

export interface Config {
  /** Базовый URL Control Plane, например `http://localhost`. */
  serverUrl: string
  /** TTL Session харнесса в секундах; heartbeat — треть TTL. */
  sessionTtlSeconds: number
  /** Требовать подтверждения человека на каждую мутацию (user-approval seam). */
  confirmMutations: boolean
  /** Открывать Session при старте плагина (иначе — при первом обращении). */
  openSessionOnStart: boolean
  /** Файл per-principal read-state (acknowledged cursor Updates). */
  statePath?: string
  /** Версия клиента, объявляемая в Session. */
  clientVersion: string
  /** Имя приложения для человека (white-label): заголовок окна. */
  appName: string
  /** Каталог workspace для беседы ассистента (по умолчанию рядом с read-state: $DSH_HOME/harness/workspace). */
  assistantWorkspacePath?: string
  /** Проактивность: ассистент сам приходит с событиями ядра, которые касаются человека. */
  proactive: boolean
  /** Файл правил значимости (по умолчанию `attention-rules.json` пакета). */
  attentionRulesPath?: string
  /** Страховочный опрос журнала событий, секунды. */
  eventPollSeconds: number
  /** Окно группировки лавины событий, секунды. */
  burstSeconds: number
  /** Секрет контейнера от launcher'а: вход `/_harness/enter` и служебные `/internal/harness/*`. */
  launcherSecret?: string
  /** notification-service: ответы и подтверждения в канал (Telegram) от имени человека. */
  notifyUrl?: string
  /** Внешний адрес веб-хоста харнесса; без `windowUrl` ссылка «Открыть окно» ведёт сюда. */
  publicUrl?: string
  /** Куда ведёт ссылка «Открыть окно» в канале; за launcher'ом — консоль с открытым ассистентом. */
  windowUrl?: string
}

export const Config: Schema<Config> = Schema.object({
  serverUrl: Schema.string().required().description('Базовый URL Control Plane'),
  sessionTtlSeconds: Schema.number().default(300),
  confirmMutations: Schema.boolean().default(true),
  openSessionOnStart: Schema.boolean().default(true),
  statePath: Schema.string().description('Файл read-state (по умолчанию $DSH_HOME/harness/read-state.json)'),
  clientVersion: Schema.string().default('0.1.0'),
  assistantWorkspacePath: Schema.string().description('Каталог workspace ассистента на хосте'),
  appName: Schema.string().default('Human Harness').description('Имя приложения, которое видит человек'),
  proactive: Schema.boolean().default(true).description('Ассистент сам приходит с событиями ядра'),
  attentionRulesPath: Schema.string().description('Файл правил значимости attention-rules.json'),
  eventPollSeconds: Schema.number().default(30),
  burstSeconds: Schema.number().default(20),
  launcherSecret: Schema.string().description('Секрет контейнера от launcher (HARNESS_LAUNCHER_SECRET)'),
  notifyUrl: Schema.string().description('notification-service для канала (HARNESS_NOTIFY_URL)'),
  publicUrl: Schema.string().description('Внешний адрес веб-хоста харнесса (HARNESS_PUBLIC_URL)'),
  windowUrl: Schema.string().description('Ссылка «Открыть окно» в канале (HARNESS_WINDOW_URL)'),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    controlPlane: ControlPlane
  }
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger
  const client = new ControlPlaneClient({
    serverUrl: config.serverUrl,
    identity: ctx.harnessIdentity,
    userAgent: `human-harness/${config.clientVersion}`,
  })
  const statePath = config.statePath ?? defaultStatePath()
  const workspacePath = config.assistantWorkspacePath ?? join(dirname(statePath), 'workspace')
  try {
    mkdirSync(workspacePath, { recursive: true })
  } catch (error) {
    logger.warn(`control-plane: не удалось создать workspace ассистента ${workspacePath}: ${String(error)}`)
  }
  const service = new ControlPlaneService({
    client,
    identity: ctx.harnessIdentity,
    state: new ReadStateStore(statePath),
    assistantWorkspacePath: workspacePath,
    appName: config.appName,
    clientVersion: config.clientVersion,
    sessionTtlSeconds: config.sessionTtlSeconds,
    log: logger,
  })
  ctx.provide('controlPlane', service)
  // Работа, которую человек взял в харнессе (H008): ссылки на свои claim и run, heartbeat claims.
  const work = new WorkTracker(client, new WorkState(join(dirname(statePath), 'work-state.json')), () => service.ensureSession())
  ctx.effect(() => {
    const timer = setInterval(() => {
      void work.heartbeat().catch((error: unknown) => logger.warn(`control-plane: heartbeat claims: ${String(error)}`))
    }, 10 * 60_000)
    return () => clearInterval(timer)
  }, 'harness: claims heartbeat')
  ctx.effect(() => registerTools(ctx, service, { confirmMutations: config.confirmMutations, work, workspacePath }), 'harness: tools')
  ctx.effect(() => () => { void service.dispose() }, 'harness: session')
  const signal = new ChangeSignal()
  // Единственная беседа человека; службы сессий DSH есть только на веб-хосте.
  const conversation = new DshConversation(workspacePath)
  ctx.inject(['sessionController', 'sessions', 'workspaceController'], (scoped) => {
    scoped.effect(() => conversation.bind(scoped), 'harness: conversation')
  })
  const proactivity = config.proactive
    ? mountProactivity(ctx, {
        client, service, signal,
        stateDir: dirname(statePath),
        conversation,
        rulesPath: config.attentionRulesPath,
        pollIntervalMs: config.eventPollSeconds * 1000,
        burstMs: config.burstSeconds * 1000,
      })
    : null
  mountRoutes(ctx, service, { signal, proactivity, conversation })
  // Канал — вторая поверхность беседы: ответы и подтверждения уходят человеку уведомлением.
  const channel = config.notifyUrl
    ? new ChannelBridge({
        notify: new NotifyClient(config.notifyUrl, ctx.harnessIdentity),
        me: async () => (await service.whoami()).principal.id,
        windowUrl: channelWindowUrl(config),
        log: logger,
      })
    : null
  if (channel !== null) {
    ctx.on('session/event', (session, event) => { channel.onSessionEvent(String(session.id), event as { type: string, data?: unknown }) }, { global: true })
  }
  // Консоль — третья поверхность беседы (контракт surface/1): API есть только за launcher'ом.
  const launcherSecret = config.launcherSecret ?? null
  const surface = launcherSecret !== null && launcherSecret !== ''
    ? new SurfaceBridge({ conversation, log: logger, presence: () => { void proactivity?.proactive.presence() } })
    : null
  if (surface !== null) {
    ctx.on('session/event', (session, event) => { surface.onSessionEvent(String(session.id), event) }, { global: true })
    ctx.on('agent/assistant-stream', ({ agent, frame }) => { surface.onAssistantStream(String(agent.session.id), frame as { type: string }) }, { global: true })
    // Контекст экрана входит в ход секцией `screen-context` (как dsh-time-context) и живёт один ход.
    applyScreenContext(ctx, surface)
  }
  // Подтверждения: окно, консоль и канал наперегонки, побеждает первый ответ.
  const approvals = new ApprovalHub({
    publish: surface !== null ? event => surface.publishApproval(event) : null,
    channel,
    turnOf: sessionId => surface?.turnOf(sessionId),
    consoleListening: sessionId => surface?.consoleListening(sessionId) ?? false,
    log: logger,
  })
  surface?.attachApprovals(approvals)
  ctx.on('approval/request', (req, next) => approvals.request(req, next as () => Promise<ApprovalOutcome>))
  mountLauncherSeam(ctx, {
    approvals: channel !== null || surface !== null ? approvals : null,
    surface,
    secret: launcherSecret,
    principalId: () => ctx.harnessIdentity.describe().principalId ?? null,
    conversation,
    nextWakeAt: () => nextWakeAt(ctx),
    log: logger,
  })
  if (config.openSessionOnStart) {
    void service.ensureSession().catch((error: unknown) => {
      logger.error(`control-plane: не удалось открыть Session в ${config.serverUrl}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  logger.info(`control-plane: ${config.serverUrl}, подтверждение мутаций: ${config.confirmMutations ? 'да' : 'нет'}`)
}
