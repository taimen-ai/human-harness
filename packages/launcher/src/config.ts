/**
 * Конфигурация launcher'а — только переменные окружения и файлы секретов
 * (TAI-ADR-0051 п.2). Секреты читаются из файлов, в окружении — пути к ним.
 */
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { cleanPath, looksLikeNetworkId, MAX_MEMORY_BYTES, MAX_NANO_CPUS, MAX_PIDS, MIN_MEMORY_BYTES, MIN_NANO_CPUS, MIN_PIDS, networkAllowed, trimSlashes } from './docker.ts'

export interface Person {
  /** Каталог секретов человека на хосте (PAT, токен подписки, токен forge); монтируется только для чтения. */
  secretsDir: string
  /** Автор коммитов человека в его рабочих копиях. */
  name?: string
  email?: string
}

export interface LauncherConfig {
  port: number
  /** Внешний адрес без завершающего `/`, например `https://cp.example.com/harness`. */
  publicUrl: string
  /** Префикс пути, под которым launcher смонтирован прокси (`/harness`) или пусто. */
  mount: string
  /**
   * Куда ведёт ссылка «Открыть окно» в ответах канала: окно беседы у человека в
   * браузере. По умолчанию — консоль с открытой панелью ассистента на том же хосте,
   * что `publicUrl` (TAI-ADR-0058, ред. 2): собственного веб-окна у харнесса нет.
   */
  windowUrl: string
  secureCookies: boolean
  /** Ключ подписи cookie launcher'а. */
  cookieSecret: Buffer
  oidc: { issuer: string, clientId: string, scopes: string }
  iam: {
    /** Внутренний адрес API IAM. */
    url: string
    /** `iss` токенов IAM (публичный адрес; по умолчанию — `url`). */
    issuer: string
    tenantId: string
    identityProvider: string
    /** Audience и scope, которые запрашивает federation при входе (нужен только principal). */
    audience: string
    scopes: string[]
    /** Bootstrap-токен IAM — единственный способ читать статус principal (sweep). */
    bootstrapToken: string | null
  }
  docker: {
    /** `http://harness-docker-proxy:2375` или `unix:///var/run/docker.sock`. */
    url: string
    image: string
    network: string
    /** Порт веб-хоста DSH внутри контейнера. */
    port: number
    memoryBytes: number
    /** Лимит CPU контейнера человека в ядрах (`NanoCpus`). */
    cpus: number
    /** Лимит процессов контейнера человека (`PidsLimit`): fork-бомба модели не кладёт хост. */
    pidsLimit: number
    /** Окружение контейнера помимо того, что задаёт launcher. */
    env: Record<string, string>
    /** Куда монтируются секреты человека в контейнере. */
    secretsTarget: string
    /**
     * Базовый каталог секретов людей на хосте: каталог человека — ровно `<база>/<principal>`.
     * `LAUNCHER_SECRETS_BASE` или общий родитель `secretsDir` из people.json; `null` — людей нет.
     */
    secretsBase: string | null
  }
  people: Record<string, Person>
  idleMs: number
  startTimeoutMs: number
  stateFile: string
  /** Разработка: все principal ведут на один уже запущенный харнесс, без Docker. */
  devUpstream: { url: string, secret: string } | null
}

function env(name: string, fallback?: string): string {
  const value = process.env[name]
  if (value !== undefined && value !== '') return value
  if (fallback !== undefined) return fallback
  throw new Error(`launcher: переменная ${name} обязательна`)
}

function positive(name: string, fallback: string): number {
  const value = Number(env(name, fallback))
  if (!Number.isFinite(value) || value <= 0) throw new Error(`launcher: ${name} должна быть положительным числом`)
  return value
}

function secretFile(name: string, required: boolean): string | null {
  const path = process.env[name]
  if (path === undefined || path === '') {
    if (required) throw new Error(`launcher: переменная ${name} (путь к файлу секрета) обязательна`)
    return null
  }
  return readFileSync(path, 'utf8').trim()
}

export function normalizeMount(mount: string): string {
  const trimmed = mount.trim().replace(/\/+$/, '')
  if (trimmed === '') return ''
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/** Ссылка «Открыть окно» по умолчанию: консоль с открытым ассистентом на хосте launcher'а. */
export function defaultWindowUrl(publicUrl: string): string {
  return new URL('/console/?assistant=open', publicUrl).href
}

/**
 * База каталогов секретов людей. Задана `LAUNCHER_SECRETS_BASE` — берётся она; нет —
 * выводится из people.json как общий родитель всех `secretsDir`. В обоих случаях каждая
 * запись people.json обязана быть `<база>/<principal>`, иначе launcher не стартует.
 * `null` — переменной нет и людей нет: монтировать нечего.
 */
export function resolveSecretsBase(people: Record<string, Person>, explicit: string | undefined): string | null {
  const entries = Object.entries(people).map(([principal, person]) => [principal, trimSlashes(String(person?.secretsDir ?? ''))] as const)
  let base: string
  if (explicit !== undefined && explicit !== '') {
    base = trimSlashes(explicit)
    if (!cleanPath(base)) throw new Error(`launcher: LAUNCHER_SECRETS_BASE=${explicit} — нужен абсолютный нормализованный путь, не корень`)
  } else {
    if (entries.length === 0) return null
    const parents = [...new Set(entries.map(([, dir]) => posix.dirname(dir)))]
    if (parents.length !== 1 || !cleanPath(parents[0]!)) {
      throw new Error(`launcher: каталоги секретов в LAUNCHER_PEOPLE_FILE не лежат в одном базовом каталоге (${parents.join(', ')}) — задайте LAUNCHER_SECRETS_BASE и разложите их как <база>/<principal>`)
    }
    base = parents[0]!
  }
  for (const [principal, dir] of entries) {
    if (!cleanPath(dir) || posix.dirname(dir) !== base || posix.basename(dir) !== principal) {
      throw new Error(`launcher: каталог секретов ${principal} в LAUNCHER_PEOPLE_FILE должен быть ${base}/${principal}, а не «${dir}»`)
    }
  }
  return base
}

/**
 * Лимиты контейнера человека: не ниже границ, которые Docker прочитал бы как «без лимита»,
 * и не выше фиксированного потолка.
 */
function checkLimits(memoryBytes: number, cpus: number, pidsLimit: number): void {
  const MB = 1024 * 1024
  if (!Number.isFinite(memoryBytes) || Math.floor(memoryBytes) < MIN_MEMORY_BYTES) throw new Error(`launcher: LAUNCHER_HARNESS_MEMORY_MB — не меньше ${MIN_MEMORY_BYTES / MB}`)
  if (Math.floor(memoryBytes) > MAX_MEMORY_BYTES) throw new Error(`launcher: LAUNCHER_HARNESS_MEMORY_MB — не больше ${MAX_MEMORY_BYTES / MB} (64 ГБ)`)
  if (Math.round(cpus * 1e9) < MIN_NANO_CPUS) throw new Error(`launcher: LAUNCHER_HARNESS_CPUS — не меньше ${MIN_NANO_CPUS / 1e9}`)
  if (Math.round(cpus * 1e9) > MAX_NANO_CPUS) throw new Error(`launcher: LAUNCHER_HARNESS_CPUS — не больше ${MAX_NANO_CPUS / 1e9}`)
  if (pidsLimit < MIN_PIDS) throw new Error(`launcher: LAUNCHER_HARNESS_PIDS — не меньше ${MIN_PIDS}`)
  if (pidsLimit > MAX_PIDS) throw new Error(`launcher: LAUNCHER_HARNESS_PIDS — не больше ${MAX_PIDS}`)
}

export function loadConfig(): LauncherConfig {
  const publicUrl = env('LAUNCHER_PUBLIC_URL').replace(/\/+$/, '')
  const mount = normalizeMount(process.env.LAUNCHER_MOUNT ?? new URL(publicUrl).pathname)
  const people = JSON.parse(readFileSync(env('LAUNCHER_PEOPLE_FILE'), 'utf8')) as Record<string, Person>
  const devUrl = process.env.LAUNCHER_DEV_UPSTREAM
  const network = env('LAUNCHER_NETWORK')
  if (looksLikeNetworkId(network)) throw new Error(`launcher: LAUNCHER_NETWORK=${network} похоже на ID сети — укажите имя сети: запрет host, bridge, none, default сверяет имена`)
  if (!networkAllowed(network)) throw new Error(`launcher: LAUNCHER_NETWORK=${network} — контейнеры людей в эту сеть не ставятся`)
  const memoryBytes = Number(env('LAUNCHER_HARNESS_MEMORY_MB', '1536')) * 1024 * 1024
  const cpus = positive('LAUNCHER_HARNESS_CPUS', '1')
  const pidsLimit = Math.floor(positive('LAUNCHER_HARNESS_PIDS', '512'))
  checkLimits(memoryBytes, cpus, pidsLimit)
  return {
    port: Number(env('LAUNCHER_PORT', '8080')),
    publicUrl,
    mount,
    windowUrl: env('LAUNCHER_WINDOW_URL', defaultWindowUrl(publicUrl)),
    secureCookies: publicUrl.startsWith('https://'),
    cookieSecret: Buffer.from(secretFile('LAUNCHER_COOKIE_SECRET_FILE', true)!, 'utf8'),
    oidc: {
      issuer: env('LAUNCHER_OIDC_ISSUER').replace(/\/+$/, ''),
      clientId: env('LAUNCHER_OIDC_CLIENT_ID', 'human-harness'),
      scopes: env('LAUNCHER_OIDC_SCOPES', 'openid'),
    },
    iam: {
      url: env('LAUNCHER_IAM_URL').replace(/\/+$/, ''),
      issuer: env('LAUNCHER_IAM_ISSUER', env('LAUNCHER_IAM_URL')).replace(/\/+$/, ''),
      tenantId: env('LAUNCHER_IAM_TENANT'),
      identityProvider: env('LAUNCHER_IAM_IDENTITY_PROVIDER', 'keycloak'),
      audience: env('LAUNCHER_IAM_AUDIENCE', 'human-harness'),
      scopes: env('LAUNCHER_IAM_SCOPES', 'harness:use').split(/[\s,]+/).filter(Boolean),
      bootstrapToken: secretFile('LAUNCHER_IAM_BOOTSTRAP_TOKEN_FILE', false),
    },
    docker: {
      url: env('LAUNCHER_DOCKER_URL', 'unix:///var/run/docker.sock'),
      image: env('LAUNCHER_IMAGE'),
      network,
      port: Number(env('LAUNCHER_HARNESS_PORT', '3080')),
      memoryBytes,
      cpus,
      pidsLimit,
      env: JSON.parse(env('LAUNCHER_HARNESS_ENV', '{}')) as Record<string, string>,
      secretsTarget: env('LAUNCHER_SECRETS_TARGET', '/run/secrets/harness'),
      secretsBase: resolveSecretsBase(people, process.env.LAUNCHER_SECRETS_BASE),
    },
    people,
    idleMs: Number(env('LAUNCHER_IDLE_MINUTES', '30')) * 60_000,
    startTimeoutMs: Number(env('LAUNCHER_START_TIMEOUT_SECONDS', '30')) * 1000,
    stateFile: env('LAUNCHER_STATE_FILE', '/var/lib/harness-launcher/state.json'),
    devUpstream: devUrl ? { url: devUrl.replace(/\/+$/, ''), secret: secretFile('LAUNCHER_DEV_SECRET_FILE', true)! } : null,
  }
}
