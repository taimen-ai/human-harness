/**
 * Минимальный клиент Docker Engine API. В проде ходит в docker-socket-proxy с
 * белым списком (`CONTAINERS=1`, `VOLUMES=1`, `POST=1`), локально — в сокет.
 * Каждая операция над существующим объектом сначала проверяет метку
 * `harness.managed` и закреплённый образ: чужой контейнер launcher не тронет
 * (plan human-harness, отступление VI).
 *
 * Прокси тела запроса не разбирает: `POST /containers/create` с `Privileged` и
 * `Binds: ["/:/host"]` он пропустил бы. Поэтому всё, что уходит в create,
 * launcher собирает сам и сверяет `checkCreate` до запроса: закреплённый образ,
 * имена контейнера и volume из principal, каталог секретов ровно
 * `<база>/<principal>`, ровно разрешённая сеть (allowlist из одной сети, а не
 * denylist), без привилегий, с лимитами памяти (своп сверх неё запрещён), CPU и
 * процессов не ниже нижних границ.
 */
import { posix } from 'node:path'
import { request } from 'node:http'

export const LABEL_MANAGED = 'harness.managed'
export const LABEL_PRINCIPAL = 'harness.principal'
/**
 * Версия спецификации контейнера (сеть, лимиты, привилегии). Остановленный контейнер
 * со старой версией или в чужой сети launcher при пробуждении пересоздаёт — volume
 * с беседой остаётся. 2 — отдельная сеть людей и лимиты CPU и процессов; 3 — `MemorySwap`
 * равен `Memory` (контейнеры версии 2 создавались без него, со свопом сверх лимита).
 */
export const LABEL_SPEC = 'harness.spec'
export const SPEC_VERSION = '3'

export interface ContainerInfo {
  id: string
  name: string
  image: string
  running: boolean
  labels: Record<string, string>
  /** Окружение контейнера (только из inspect). */
  env?: Record<string, string>
  /** Сети, к которым подключён контейнер (только из inspect). */
  networks?: string[]
}

export interface CreateContainer {
  name: string
  image: string
  principalId: string
  env: Record<string, string>
  volume: string
  volumeTarget: string
  secretsDir: string | null
  secretsTarget: string
  network: string
  memoryBytes: number
  /** Лимит CPU в ядрах. */
  cpus: number
  pidsLimit: number
}

export class DockerError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'DockerError'
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NETWORK = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
/**
 * Сети Docker, в которые контейнер человека не ставится, даже если `LAUNCHER_NETWORK`
 * назвал одну из них: хост, общий bridge, без сети. `container:<id>` отсекает сам
 * формат имени (двоеточие).
 */
export const FORBIDDEN_NETWORKS: ReadonlySet<string> = new Set(['host', 'bridge', 'none', 'default'])

/**
 * Похоже на ID сети Docker (12–64 hex-символа). Docker находит сеть и по ID, поэтому
 * запрет выше, который сверяет имена, ID сети `host` или `bridge` пропустил бы.
 */
export const NETWORK_ID = /^[0-9a-f]{12,64}$/i

/** Похоже на ID сети, а не на имя. */
export function looksLikeNetworkId(name: string): boolean {
  return NETWORK_ID.test(name)
}

/** Имя сети, в которую можно поставить контейнер человека: простое имя, не из запрещённых и не ID. */
export function networkAllowed(name: string): boolean {
  return NETWORK.test(name) && !FORBIDDEN_NETWORKS.has(name) && !looksLikeNetworkId(name)
}

/** Нижние границы лимитов: 0 в Docker — «без лимита», а малое значение округляется до нуля. */
export const MIN_NANO_CPUS = 10_000_000 // 0,01 CPU
/** Меньше Docker не принимает (`Minimum memory limit allowed is 6MB`). */
export const MIN_MEMORY_BYTES = 6 * 1024 * 1024
export const MIN_PIDS = 1

/**
 * Верхние границы лимитов при старте. Ресурсов хоста launcher не знает, поэтому
 * потолок фиксированный: значение выше почти наверняка опечатка (лишние нули), а не замысел.
 */
export const MAX_NANO_CPUS = 64_000_000_000 // 64 CPU
export const MAX_MEMORY_BYTES = 64 * 1024 * 1024 * 1024 // 64 ГБ
export const MAX_PIDS = 65_536

/** Что launcher разрешает контейнеру человека; всё остальное — отказ. */
export interface CreatePolicy {
  /** Закреплённый образ (`LAUNCHER_IMAGE`). */
  image: string
  /** Единственная разрешённая сеть (`LAUNCHER_NETWORK`). */
  network: string
  /**
   * Базовый каталог секретов людей на хосте (`LAUNCHER_SECRETS_BASE` или общий родитель
   * `secretsDir` из people.json). `null` — базы нет: каталог секретов не монтируется.
   */
  secretsBase: string | null
}

/** Тело `POST /containers/create`, которое launcher отдаёт Docker. */
export interface CreateBody {
  Image: string
  Env: string[]
  Labels: Record<string, string>
  HostConfig: {
    Binds: string[]
    NetworkMode: string
    Memory: number
    MemorySwap: number
    NanoCpus: number
    PidsLimit: number
    RestartPolicy: { Name: string }
    Privileged: boolean
    ReadonlyRootfs: boolean
    CapDrop: string[]
    SecurityOpt: string[]
  }
  NetworkingConfig?: { EndpointsConfig?: Record<string, unknown> }
}

/** Абсолютный нормализованный путь без символов, которые Docker читает в `Binds` как разделители. */
export function cleanPath(path: string): boolean {
  return posix.isAbsolute(path) && posix.normalize(path) === path && path !== '/' && !/[:,\s]/.test(path)
}

/** Путь без завершающих `/`. */
export function trimSlashes(path: string): string {
  return path.replace(/\/+$/, '')
}

function refuse(why: string): never {
  throw new DockerError(403, `контейнер не создан: ${why}`)
}

/** Тело create из спецификации; лимиты — в тех единицах и с тем округлением, что увидит Docker. */
export function createBody(spec: CreateContainer): CreateBody {
  const binds = [`${spec.volume}:${spec.volumeTarget}`]
  if (spec.secretsDir !== null) binds.push(`${trimSlashes(spec.secretsDir)}:${spec.secretsTarget}:ro`)
  const memory = Math.floor(spec.memoryBytes)
  return {
    Image: spec.image,
    Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
    Labels: { [LABEL_MANAGED]: 'true', [LABEL_PRINCIPAL]: spec.principalId, [LABEL_SPEC]: SPEC_VERSION },
    HostConfig: {
      Binds: binds,
      NetworkMode: spec.network,
      Memory: memory,
      // MemorySwap — память плюс своп: равенство запрещает своп сверх лимита
      MemorySwap: memory,
      NanoCpus: Math.round(spec.cpus * 1e9),
      PidsLimit: spec.pidsLimit,
      RestartPolicy: { Name: 'no' },
      Privileged: false,
      ReadonlyRootfs: false,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
    },
  }
}

/**
 * Тело create перед отправкой: закреплённый образ, ровно одна разрешённая сеть
 * (`NetworkMode` и ключи `NetworkingConfig.EndpointsConfig`), без привилегий,
 * лимиты не ниже границ, `MemorySwap` равен `Memory`.
 */
export function checkCreateBody(body: CreateBody, policy: CreatePolicy): void {
  const host = body.HostConfig
  if (body.Image !== policy.image) refuse(`образ ${body.Image} не закреплён`)
  if (host.NetworkMode !== policy.network) refuse(`сеть ${host.NetworkMode} не разрешена`)
  const endpoints = Object.keys(body.NetworkingConfig?.EndpointsConfig ?? {})
  if (endpoints.some(name => name !== policy.network)) refuse(`сети ${endpoints.join(', ')} не разрешены`)
  if (host.Privileged !== false) refuse('привилегированный контейнер')
  if (!Number.isSafeInteger(host.Memory) || host.Memory < MIN_MEMORY_BYTES) refuse(`лимит памяти ${host.Memory} байт ниже ${MIN_MEMORY_BYTES}`)
  if (host.MemorySwap !== host.Memory) refuse('своп сверх лимита памяти')
  if (!Number.isSafeInteger(host.NanoCpus) || host.NanoCpus < MIN_NANO_CPUS) refuse(`лимит CPU ${host.NanoCpus} нс ниже ${MIN_NANO_CPUS}`)
  if (!Number.isSafeInteger(host.PidsLimit) || host.PidsLimit < MIN_PIDS) refuse(`лимит процессов ${host.PidsLimit} ниже ${MIN_PIDS}`)
}

/**
 * Спецификация контейнера человека, которую launcher готов отдать Docker; возвращает
 * проверенное тело create. Отказ — `DockerError(403)` до любого запроса.
 */
export function checkCreate(spec: CreateContainer, policy: CreatePolicy): CreateBody {
  if (spec.image !== policy.image) refuse(`образ ${spec.image} не закреплён`)
  if (!UUID.test(spec.principalId)) refuse('principal — не UUID')
  if (spec.name !== `harness-${spec.principalId}`) refuse(`имя ${spec.name} не из principal`)
  if (spec.volume !== `harness-data-${spec.principalId}`) refuse(`volume ${spec.volume} не из principal`)
  if (!cleanPath(spec.volumeTarget) || !cleanPath(spec.secretsTarget)) refuse('путь монтирования в контейнере')
  if (spec.secretsDir !== null) {
    const dir = trimSlashes(spec.secretsDir)
    const base = policy.secretsBase
    // каталог секретов — только этого человека и только в базе: <база>/<principal>
    if (base === null || !cleanPath(base)) refuse(`каталог секретов ${spec.secretsDir}: база каталогов секретов не задана`)
    if (!cleanPath(dir) || posix.dirname(dir) !== base || posix.basename(dir) !== spec.principalId) refuse(`каталог секретов ${spec.secretsDir} — не ${base}/${spec.principalId}`)
  }
  // allowlist из одной сети; запрещённые имена — отказ, даже если их назвали разрешённой
  if (!networkAllowed(spec.network)) refuse(`сеть ${spec.network} запрещена`)
  if (spec.network !== policy.network) refuse(`сеть ${spec.network} не разрешена (разрешена ${policy.network})`)
  for (const [name, value] of [['memory', spec.memoryBytes], ['cpus', spec.cpus], ['pids', spec.pidsLimit]] as const) {
    if (!Number.isFinite(value) || value <= 0) refuse(`лимит ${name} не задан`)
  }
  const body = createBody(spec)
  checkCreateBody(body, policy)
  return body
}

export interface DockerApi {
  inspect(name: string): Promise<ContainerInfo | null>
  create(spec: CreateContainer): Promise<string>
  start(name: string): Promise<void>
  stop(name: string): Promise<void>
  remove(name: string): Promise<void>
  createVolume(name: string, principalId: string): Promise<void>
  removeVolume(name: string): Promise<void>
  /** Контейнеры и volume launcher'а: principal → имена. */
  managed(): Promise<{ containers: ContainerInfo[], volumes: { name: string, principalId: string }[] }>
}

export class DockerClient implements DockerApi {
  private readonly socketPath: string | undefined
  private readonly base: URL | undefined

  private readonly image: string

  constructor(url: string, private readonly policy: CreatePolicy) {
    this.image = policy.image
    if (url.startsWith('unix://')) this.socketPath = url.slice('unix://'.length)
    else this.base = new URL(url)
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<{ status: number, body: T }> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    return new Promise((resolve, reject) => {
      const req = request({
        method,
        path: `/v1.43${path}`,
        ...(this.socketPath !== undefined ? { socketPath: this.socketPath } : { host: this.base!.hostname, port: Number(this.base!.port || 2375) }),
        headers: { 'content-type': 'application/json', ...(payload ? { 'content-length': payload.length } : {}) },
        timeout: 30_000,
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown = text
          try { parsed = text === '' ? null : JSON.parse(text) } catch { /* текст */ }
          resolve({ status: res.statusCode ?? 0, body: parsed as T })
        })
      })
      req.on('timeout', () => req.destroy(new Error(`docker ${method} ${path}: timeout`)))
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  private async ok<T>(method: string, path: string, body?: unknown, allowed: number[] = []): Promise<T> {
    const res = await this.call<T>(method, path, body)
    if (res.status >= 400 && !allowed.includes(res.status)) {
      const message = (res.body as { message?: string } | null)?.message ?? String(res.body)
      throw new DockerError(res.status, `docker ${method} ${path}: ${res.status} ${message}`)
    }
    return res.body
  }

  async inspect(name: string): Promise<ContainerInfo | null> {
    const res = await this.call<{ Id: string, Name: string, Config: { Image: string, Labels: Record<string, string> | null, Env?: string[] | null }, State: { Running: boolean }, NetworkSettings?: { Networks?: Record<string, unknown> | null } }>('GET', `/containers/${encodeURIComponent(name)}/json`)
    if (res.status === 404) return null
    if (res.status >= 400) throw new DockerError(res.status, `docker inspect ${name}: ${res.status}`)
    return {
      id: res.body.Id,
      name: res.body.Name.replace(/^\//, ''),
      image: res.body.Config.Image,
      running: res.body.State.Running,
      labels: res.body.Config.Labels ?? {},
      env: Object.fromEntries((res.body.Config.Env ?? []).map((e) => { const i = e.indexOf('='); return [e.slice(0, i), e.slice(i + 1)] })),
      networks: Object.keys(res.body.NetworkSettings?.Networks ?? {}),
    }
  }

  /** Контейнер наш: метка и закреплённый образ. Иначе — отказ до любой мутации. */
  private async guard(name: string): Promise<ContainerInfo | null> {
    const info = await this.inspect(name)
    if (info === null) return null
    if (info.labels[LABEL_MANAGED] !== 'true') throw new DockerError(403, `контейнер ${name} не управляется launcher'ом (нет метки ${LABEL_MANAGED})`)
    if (info.image !== this.image) throw new DockerError(403, `контейнер ${name} создан не из закреплённого образа (${info.image})`)
    return info
  }

  async create(spec: CreateContainer): Promise<string> {
    const body = checkCreate(spec, this.policy)
    const created = await this.ok<{ Id: string }>('POST', `/containers/create?name=${encodeURIComponent(spec.name)}`, body)
    return created.Id
  }

  async start(name: string): Promise<void> {
    if (await this.guard(name) === null) throw new DockerError(404, `контейнера ${name} нет`)
    await this.ok('POST', `/containers/${encodeURIComponent(name)}/start`, undefined, [304])
  }

  async stop(name: string): Promise<void> {
    if (await this.guard(name) === null) return
    await this.ok('POST', `/containers/${encodeURIComponent(name)}/stop?t=10`, undefined, [304])
  }

  async remove(name: string): Promise<void> {
    if (await this.guard(name) === null) return
    await this.ok('DELETE', `/containers/${encodeURIComponent(name)}?force=true`, undefined, [404])
  }

  /**
   * Volume человека. Уже существующий том с этим именем принимается только с метками
   * `harness.managed=true` и `harness.principal` того же человека: чужой или безымянный
   * том в контейнер не попадёт.
   */
  async createVolume(name: string, principalId: string): Promise<void> {
    const ours = (labels: Record<string, string> | null | undefined): void => {
      const found = labels ?? {}
      if (found[LABEL_MANAGED] !== 'true' || found[LABEL_PRINCIPAL] !== principalId) {
        throw new DockerError(403, `volume ${name} уже есть, но не помечен launcher'ом для ${principalId}`)
      }
    }
    const existing = await this.call<{ Labels: Record<string, string> | null } | null>('GET', `/volumes/${encodeURIComponent(name)}`)
    if (existing.status === 200) return ours(existing.body?.Labels)
    if (existing.status !== 404) throw new DockerError(existing.status, `docker GET /volumes/${name}: ${existing.status}`)
    // Гонка с параллельным create: Docker отдаёт существующий том вместо ошибки — метки сверяются и в ответе.
    const created = await this.ok<{ Labels: Record<string, string> | null } | null>('POST', '/volumes/create', { Name: name, Labels: { [LABEL_MANAGED]: 'true', [LABEL_PRINCIPAL]: principalId } })
    ours(created?.Labels)
  }

  async removeVolume(name: string): Promise<void> {
    const res = await this.call<{ Labels: Record<string, string> | null }>('GET', `/volumes/${encodeURIComponent(name)}`)
    if (res.status === 404) return
    if ((res.body.Labels ?? {})[LABEL_MANAGED] !== 'true') throw new DockerError(403, `volume ${name} не управляется launcher'ом`)
    await this.ok('DELETE', `/volumes/${encodeURIComponent(name)}`, undefined, [404])
  }

  async managed(): Promise<{ containers: ContainerInfo[], volumes: { name: string, principalId: string }[] }> {
    const filter = encodeURIComponent(JSON.stringify({ label: [`${LABEL_MANAGED}=true`] }))
    const list = await this.ok<{ Id: string, Names: string[], Image: string, State: string, Labels: Record<string, string> }[]>('GET', `/containers/json?all=true&filters=${filter}`)
    const volumes = await this.ok<{ Volumes: { Name: string, Labels: Record<string, string> | null }[] | null }>('GET', `/volumes?filters=${filter}`)
    return {
      containers: list.map(c => ({ id: c.Id, name: (c.Names[0] ?? '').replace(/^\//, ''), image: c.Image, running: c.State === 'running', labels: c.Labels })),
      volumes: (volumes.Volumes ?? []).map(v => ({ name: v.Name, principalId: (v.Labels ?? {})[LABEL_PRINCIPAL] ?? '' })),
    }
  }
}
