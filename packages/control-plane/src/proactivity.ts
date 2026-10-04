/**
 * Сборка проактивности в плагине харнесса: правила → потребитель событий ядра →
 * ход в единственную беседу; сигнал окну; время ближайшего напоминания для
 * launcher'а (пробуждение спящего контейнера, TAI-ADR-0051 п.2).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ControlPlaneError, type ControlPlaneClient } from './client.ts'
import type { DshConversation } from './conversation.ts'
import { eventTypesOf, parseRules, type EvaluateDeps, type RuleSet, type TaskFacts } from './attention-rules.ts'
import { CursorFile, EventConsumer } from './events.ts'
import { Proactive, ProactiveStateFile } from './proactive.ts'
import type { ControlPlane } from './service.ts'
import type { ChangeSignal } from './signal.ts'

/** Правила по умолчанию — данные пакета (`attention-rules.json` в корне пакета). */
export function loadRules(path?: string): RuleSet {
  const source = path ?? new URL('../attention-rules.json', import.meta.url)
  return parseRules(JSON.parse(readFileSync(source, 'utf8')))
}

export interface ProactivityOptions {
  client: ControlPlaneClient
  service: ControlPlane
  stateDir: string
  conversation: DshConversation
  rulesPath?: string | undefined
  pollIntervalMs: number
  burstMs: number
  signal: ChangeSignal
}

export interface Proactivity {
  proactive: Proactive
  consumer: EventConsumer
  conversation: DshConversation
}

/** Ближайшее время напоминания `dsh-schedule` (ISO) или null. */
export async function nextWakeAt(ctx: Context): Promise<string | null> {
  const schedule = ctx.get('schedule' as never) as { catalog(): Promise<{ status: string, scheduledAt: string }[]> } | undefined
  if (schedule === undefined) return null
  const active = (await schedule.catalog()).filter(entry => entry.status === 'active')
  return active[0]?.scheduledAt ?? null
}

export function mountProactivity(ctx: Context, options: ProactivityOptions): Proactivity | null {
  const logger = ctx.logger
  let rules: RuleSet
  try {
    rules = loadRules(options.rulesPath)
  } catch (error) {
    logger.error(`proactive: правила не загружены — ассистент не будет приходить сам: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  const conversation = options.conversation
  let cached: { value: EvaluateDeps, at: number } | null = null
  const deps = async (): Promise<EvaluateDeps> => {
    if (cached !== null && Date.now() - cached.at < 60_000) return cached.value
    const who = await options.service.whoami()
    const value: EvaluateDeps = {
      me: { principalId: who.principal.id, roleIds: who.roles.map(r => r.id) },
      task: async (id: string): Promise<TaskFacts | null> => {
        try {
          const t = await options.client.getTask(id)
          return { id: t.id, publicId: t.publicId, title: t.title, assigneeId: t.assigneeId ?? null, createdBy: t.createdBy ?? null, ownerId: t.ownerId ?? null }
        } catch (error) {
          if (error instanceof ControlPlaneError && (error.status === 404 || error.status === 403)) return null
          throw error
        }
      },
    }
    cached = { value, at: Date.now() }
    return value
  }
  const proactive = new Proactive({
    rules,
    deps,
    conversation,
    state: new ProactiveStateFile(join(options.stateDir, 'proactive-state.json')),
    burstMs: options.burstMs,
    onSignal: () => options.signal.bump(),
    log: logger,
  })
  const consumer = new EventConsumer({
    client: options.client,
    types: eventTypesOf(rules),
    store: new CursorFile(join(options.stateDir, 'event-cursor.json')),
    handler: event => proactive.handle(event),
    pollIntervalMs: options.pollIntervalMs,
    log: logger,
  })
  // Потребитель и беседа нужны только на хосте с веб-сессиями (в headless их нет).
  ctx.inject(['sessionController', 'sessions'], (scoped) => {
    scoped.effect(() => {
      consumer.start()
      proactive.resume()
      logger.info(`proactive: ${rules.rules.length} правил, события ${eventTypesOf(rules).join(', ')}`)
      return () => { proactive.dispose(); void consumer.stop() }
    }, 'harness: proactive')
  })

  return { proactive, consumer, conversation }
}
