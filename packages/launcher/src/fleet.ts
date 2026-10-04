/**
 * Контейнеры людей (TAI-ADR-0051 п.2): один на principal, из закреплённого
 * образа, volume с беседой и рабочими копиями. Старт по запросу с ожиданием
 * готовности (бюджет холодного старта 30 с), сон после простоя без активного
 * хода, пробуждение по ближайшему напоминанию харнесса, удаление контейнера и
 * volume отключённого principal — не дольше минуты.
 *
 * Состояние launcher'а — файл (секрет контейнера, последний запрос, время
 * пробуждения); модели данных у launcher'а нет.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomToken } from './crypto.ts'
import { LABEL_SPEC, SPEC_VERSION, type ContainerInfo, type DockerApi } from './docker.ts'
import type { Iam } from './identity.ts'
import type { Journal } from './journal.ts'
import type { LauncherConfig, Person } from './config.ts'

export interface Upstream {
  /** `http://harness-<principal>:3080` — адрес контейнера в сети compose. */
  url: string
  /** Общий секрет launcher ↔ контейнер (HMAC входа, bearer служебных маршрутов). */
  secret: string
}

interface Record_ {
  secret: string
  lastSeenAt: number
  wakeAt: number | null
}

interface State {
  principals: Record<string, Record_>
}

export class StateFile {
  private cache: State | undefined

  constructor(private readonly path: string) {}

  load(): State {
    if (this.cache !== undefined) return this.cache
    try {
      this.cache = JSON.parse(readFileSync(this.path, 'utf8')) as State
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.cache = { principals: {} }
    }
    return this.cache
  }

  save(state: State): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    renameSync(tmp, this.path)
    this.cache = state
  }
}

export const containerName = (principalId: string): string => `harness-${principalId}`
export const volumeName = (principalId: string): string => `harness-data-${principalId}`

export interface FleetOptions {
  config: Pick<LauncherConfig, 'docker' | 'people' | 'idleMs' | 'startTimeoutMs' | 'devUpstream'> & { publicUrl?: string, windowUrl?: string }
  docker: DockerApi
  iam: Pick<Iam, 'status'>
  state: StateFile
  journal: Journal
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Контейнер остановлен или удалён: `slept` — простой, `paused`/`deleted` — статус principal в IAM. */
export type StopListener = (principalId: string, reason: 'slept' | 'paused' | 'deleted') => void

/**
 * Пробуждение контейнера: `waking` — старт начат, `ready` — контейнер ответил на
 * health, `failed` — не поднялся. Бодрый контейнер событий не порождает.
 */
export type WakeListener = (principalId: string, phase: 'waking' | 'ready' | 'failed') => void

export class Fleet {
  private readonly starting = new Map<string, Promise<Upstream>>()
  /** Пробуждения в пути: `ensure`, который поднимает остановленный контейнер (не проверку бодрого). */
  private readonly waking = new Set<string>()
  private readonly stopListeners = new Set<StopListener>()
  private readonly wakeListeners = new Set<WakeListener>()
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: FleetOptions) {
    this.fetchImpl = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  person(principalId: string): Person | null {
    return this.options.config.people[principalId] ?? null
  }

  private record(principalId: string): Record_ {
    const state = this.options.state.load()
    const existing = state.principals[principalId]
    if (existing !== undefined) return existing
    const created: Record_ = { secret: randomToken(32), lastSeenAt: this.now(), wakeAt: null }
    this.options.state.save({ principals: { ...state.principals, [principalId]: created } })
    return created
  }

  private update(principalId: string, patch: Partial<Record_>): void {
    const state = this.options.state.load()
    const current = state.principals[principalId]
    if (current === undefined) return
    this.options.state.save({ principals: { ...state.principals, [principalId]: { ...current, ...patch } } })
  }

  private forget(principalId: string): void {
    const principals = { ...this.options.state.load().principals }
    delete principals[principalId]
    this.options.state.save({ principals })
  }

  upstream(principalId: string): Upstream {
    const dev = this.options.config.devUpstream
    if (dev !== null) return dev
    return { url: `http://${containerName(principalId)}:${this.options.config.docker.port}`, secret: this.record(principalId).secret }
  }

  /**
   * Подписка на остановку контейнера. Долгие соединения (поток поверхности
   * беседы) закрываются по ней сами и не держат контейнер бодрым.
   */
  onStop(listener: StopListener): () => void {
    this.stopListeners.add(listener)
    return () => { this.stopListeners.delete(listener) }
  }

  private stopped(principalId: string, reason: Parameters<StopListener>[1]): void {
    for (const listener of [...this.stopListeners]) {
      try { listener(principalId, reason) } catch (error) { this.options.journal('fleet.error', { principalId, op: 'onStop', error: String(error) }) }
    }
  }

  /**
   * Подписка на пробуждение контейнера кем угодно (запрос человека, канал,
   * напоминание). Поток поверхности контейнер не будит сам, а ждёт этого события.
   */
  onWake(listener: WakeListener): () => void {
    this.wakeListeners.add(listener)
    return () => { this.wakeListeners.delete(listener) }
  }

  private woke(principalId: string, phase: Parameters<WakeListener>[1]): void {
    for (const listener of [...this.wakeListeners]) {
      try { listener(principalId, phase) } catch (error) { this.options.journal('fleet.error', { principalId, op: 'onWake', error: String(error) }) }
    }
  }

  /**
   * Контейнер запущен и не просыпается прямо сейчас (иначе его придётся будить).
   *
   * `ensure` бодрого контейнера (история, сообщение) пробуждением не считается: он
   * событий `onWake` не порождает, и поток, решивший по нему «спит», ждал бы
   * пробуждения, которого не будет, — панель висела в «просыпается» до
   * переоткрытия.
   */
  async awake(principalId: string): Promise<boolean> {
    if (this.options.config.devUpstream !== null) return true
    if (this.waking.has(principalId)) return false
    const running = (await this.options.docker.inspect(containerName(principalId)))?.running === true
    // пока шёл inspect, контейнер мог начать просыпаться: запущен, но ещё не готов
    return running && !this.waking.has(principalId)
  }

  /** Отметить запрос человека (простой считается от последнего). */
  touch(principalId: string): void {
    const record = this.options.state.load().principals[principalId]
    // Файл не пишем на каждый запрос: достаточно точности в минуту.
    if (record !== undefined && this.now() - record.lastSeenAt < 60_000) return
    this.record(principalId)
    this.update(principalId, { lastSeenAt: this.now() })
  }

  /** Контейнер человека запущен и готов; создаётся и стартует при необходимости. */
  ensure(principalId: string): Promise<Upstream> {
    if (this.options.config.devUpstream !== null) return Promise.resolve(this.options.config.devUpstream)
    const inflight = this.starting.get(principalId)
    if (inflight !== undefined) return inflight
    const attempt = this.bringUp(principalId).finally(() => this.starting.delete(principalId))
    this.starting.set(principalId, attempt)
    return attempt
  }

  private async bringUp(principalId: string): Promise<Upstream> {
    const person = this.person(principalId)
    if (person === null) throw Object.assign(new Error(`у principal ${principalId} нет рабочего места`), { status: 403 })
    const docker = this.options.docker
    const name = containerName(principalId)
    const started = this.now()
    let info = await docker.inspect(name)
    // Состояние launcher'а потеряно, контейнер жив: секрет — тот, с которым контейнер создан.
    const adopted = info?.env?.HARNESS_LAUNCHER_SECRET
    if (info !== null && adopted && this.options.state.load().principals[principalId]?.secret !== adopted) {
      const state = this.options.state.load()
      this.options.state.save({ principals: { ...state.principals, [principalId]: { secret: adopted, lastSeenAt: this.now(), wakeAt: null } } })
      this.options.journal('container.adopted', { principalId, name })
    }
    const upstream = this.upstream(principalId)
    const woken = info === null || !info.running
    if (woken) {
      this.waking.add(principalId)
      this.woke(principalId, 'waking')
    }
    try {
      await this.start(principalId, person, info, upstream)
    } catch (error) {
      if (woken) {
        this.waking.delete(principalId)
        this.woke(principalId, 'failed')
      }
      throw error
    }
    if (woken) this.waking.delete(principalId)
    // Простой сбрасывает только пробуждение: `ensure` бодрого контейнера таймер не
    // трогает — иначе история поверхности (TAI-ADR-0051, амендмент 2026-09-29)
    // держала бы контейнер вечно. Запросы человека зовут `touch` сами.
    this.update(principalId, { ...(woken ? { lastSeenAt: this.now() } : {}), wakeAt: null })
    if (woken) {
      this.options.journal('container.ready', { principalId, ms: this.now() - started })
      this.woke(principalId, 'ready')
    }
    return upstream
  }

  /**
   * Контейнер создан по прежней спецификации (без лимитов или в другой сети — например,
   * в общей сети compose до разделения сетей харнесса).
   */
  private drifted(info: ContainerInfo): string | null {
    if (info.labels[LABEL_SPEC] !== SPEC_VERSION) return `spec ${info.labels[LABEL_SPEC] ?? 'none'} → ${SPEC_VERSION}`
    const network = this.options.config.docker.network
    if (info.networks !== undefined && (info.networks.length !== 1 || info.networks[0] !== network)) return `networks ${info.networks.join(',')} → ${network}`
    return null
  }

  private async start(principalId: string, person: Person, found: Awaited<ReturnType<DockerApi['inspect']>>, upstream: Upstream): Promise<void> {
    const { docker, config } = { docker: this.options.docker, config: this.options.config }
    const name = containerName(principalId)
    let info = found
    // Спящий контейнер старой спецификации пересоздаётся при пробуждении: состояние
    // человека — в volume, его remove не трогает. Бодрый не трогаем — идёт работа.
    const drift = info !== null && !info.running ? this.drifted(info) : null
    if (drift !== null) {
      await docker.remove(name)
      this.options.journal('container.recreated', { principalId, name, reason: drift })
      info = null
    }
    if (info === null) {
      await docker.createVolume(volumeName(principalId), principalId)
      await docker.create({
        name,
        image: config.docker.image,
        principalId,
        env: {
          ...config.docker.env,
          HARNESS_IAM_PRINCIPAL: principalId,
          HARNESS_LAUNCHER_SECRET: upstream.secret,
          HARNESS_SECRETS_DIR: config.docker.secretsTarget,
          ...(config.publicUrl ? { HARNESS_PUBLIC_URL: config.publicUrl } : {}),
          ...(config.windowUrl ? { HARNESS_WINDOW_URL: config.windowUrl } : {}),
          ...(person.name ? { GIT_AUTHOR_NAME: person.name, GIT_COMMITTER_NAME: person.name } : {}),
          ...(person.email ? { GIT_AUTHOR_EMAIL: person.email, GIT_COMMITTER_EMAIL: person.email } : {}),
        },
        volume: volumeName(principalId),
        volumeTarget: '/data',
        secretsDir: person.secretsDir,
        secretsTarget: config.docker.secretsTarget,
        network: config.docker.network,
        memoryBytes: config.docker.memoryBytes,
        cpus: config.docker.cpus,
        pidsLimit: config.docker.pidsLimit,
      })
      this.options.journal('container.created', { principalId, name })
      info = await docker.inspect(name)
    }
    if (info !== null && !info.running) {
      await docker.start(name)
      this.options.journal('container.started', { principalId, name })
    }
    await this.waitReady(upstream)
  }

  private async waitReady(upstream: Upstream): Promise<void> {
    const deadline = this.now() + this.options.config.startTimeoutMs
    for (;;) {
      const ok = await this.fetchImpl(`${upstream.url}/_harness/health`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false)
      if (ok) return
      if (this.now() >= deadline) throw Object.assign(new Error(`харнесс не поднялся за ${this.options.config.startTimeoutMs} мс`), { status: 504 })
      await this.sleep(500)
    }
  }

  /** Состояние харнесса: идёт ли ход и когда ближайшее напоминание. */
  async status(principalId: string): Promise<{ busy: boolean, nextWakeAt: string | null } | null> {
    const upstream = this.upstream(principalId)
    const response = await this.fetchImpl(`${upstream.url}/internal/harness/status`, {
      headers: { authorization: `Bearer ${upstream.secret}` }, signal: AbortSignal.timeout(5000),
    }).catch(() => null)
    if (response === null || !response.ok) return null
    return await response.json() as { busy: boolean, nextWakeAt: string | null }
  }

  /** Сообщение канала в беседу человека (контейнер будится при необходимости). */
  async inbound(principalId: string, body: { channel: string, messageId?: string, text?: string, approval?: { id: string, decision: 'approve' | 'reject' } }): Promise<void> {
    const upstream = await this.ensure(principalId)
    this.touch(principalId)
    const response = await this.fetchImpl(`${upstream.url}/internal/harness/inbound`, {
      method: 'POST',
      headers: { authorization: `Bearer ${upstream.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw Object.assign(new Error(`харнесс не принял сообщение: ${response.status}`), { status: 502 })
    this.options.journal('inbound.delivered', { principalId, channel: body.channel })
  }

  /** Раз в минуту: усыпить простаивающие, разбудить по напоминанию. */
  async tick(): Promise<void> {
    if (this.options.config.devUpstream !== null) return
    const now = this.now()
    const { containers } = await this.options.docker.managed()
    const running = new Set(containers.filter(c => c.running).map(c => c.labels['harness.principal'] ?? ''))
    for (const [principalId, record] of Object.entries(this.options.state.load().principals)) {
      try {
        if (running.has(principalId) && now - record.lastSeenAt > this.options.config.idleMs) {
          const status = await this.status(principalId)
          if (status?.busy) continue
          await this.options.docker.stop(containerName(principalId))
          const wakeAt = status?.nextWakeAt ? Date.parse(status.nextWakeAt) : null
          this.update(principalId, { wakeAt: Number.isFinite(wakeAt) ? wakeAt : null })
          this.options.journal('container.slept', { principalId, idleMs: now - record.lastSeenAt, wakeAt: status?.nextWakeAt ?? null })
          this.stopped(principalId, 'slept')
        } else if (!running.has(principalId) && record.wakeAt !== null && record.wakeAt <= now) {
          await this.ensure(principalId)
          this.options.journal('container.woken', { principalId, reason: 'reminder' })
        }
      } catch (error) {
        this.options.journal('fleet.error', { principalId, op: 'tick', error: String(error) })
      }
    }
  }

  /** Раз в минуту: principal отключён или удалён из tenant'а → контейнер и volume удаляются сразу. */
  async sweep(): Promise<void> {
    const { containers, volumes } = await this.options.docker.managed()
    const principals = new Set<string>([
      ...containers.map(c => c.labels['harness.principal'] ?? ''),
      ...volumes.map(v => v.principalId),
    ].filter(Boolean))
    for (const principalId of principals) {
      const status = await this.options.iam.status(principalId)
      if (status === 'paused') {
        const container = containers.find(c => c.labels['harness.principal'] === principalId)
        if (container?.running) {
          await this.options.docker.stop(container.name)
          this.options.journal('container.stopped', { principalId, reason: 'principal_paused' })
          this.stopped(principalId, 'paused')
        }
        continue
      }
      if (status !== 'disabled' && status !== 'gone') continue
      for (const c of containers.filter(c => c.labels['harness.principal'] === principalId)) await this.options.docker.remove(c.name)
      for (const v of volumes.filter(v => v.principalId === principalId)) await this.options.docker.removeVolume(v.name)
      this.forget(principalId)
      this.options.journal('conversation.deleted', { principalId, reason: `principal_${status}` })
      this.stopped(principalId, 'deleted')
    }
  }
}
