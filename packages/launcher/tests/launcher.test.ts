import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyLauncherHeader } from '../../control-plane/src/launcher-seam.ts'
import { checkLauncherHeader, Jwks, launcherHeader, seal, unseal, verifyIamToken } from '../src/crypto.ts'
import { defaultWindowUrl, loadConfig, resolveSecretsBase } from '../src/config.ts'
import { checkCreate, checkCreateBody, createBody, DockerClient, LABEL_SPEC, SPEC_VERSION, type ContainerInfo, type CreateContainer, type CreatePolicy, type DockerApi } from '../src/docker.ts'
import { containerName, Fleet, StateFile, volumeName } from '../src/fleet.ts'
import { LauncherServer, PKCE_COOKIE, SESSION_COOKIE } from '../src/server.ts'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const STRANGER = '33333333-3333-4333-8333-333333333333'
const SECRET = Buffer.from('cookie-secret-for-tests')
const quiet = () => undefined
const servers: Server[] = []
const sockets: { destroy(): void }[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  await Promise.all(servers.splice(0).map(s => { s.closeAllConnections(); return new Promise(r => s.close(r)) }))
})

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** Харнесс-двойник: отвечает, кто он, что пришло, и умеет WebSocket-эхо. */
async function fakeHarness(name: string, opts: { status?: number } = {}) {
  const seen: { path: string, headers: IncomingHttpHeaders }[] = []
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', headers: req.headers })
    res.writeHead(opts.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify({ harness: name, path: req.url }))
  })
  server.on('upgrade', (req, socket) => {
    sockets.push(socket)
    seen.push({ path: req.url ?? '', headers: req.headers })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (d: Buffer) => socket.write(`${name}:${d.toString()}`))
  })
  return { url: await listen(server), seen }
}

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
const jwks = new Jwks('http://iam/.well-known/jwks.json', (async () => new Response(JSON.stringify({ keys: [jwk] }))) as typeof fetch)
function iamToken(claims: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const head = `${enc({ alg: 'RS256', kid: 'k1', typ: 'at+jwt' })}.${enc({
    iss: 'https://iam.example', aud: 'human-harness', tenant_id: 'tenant-1', sub: 'svc', scope: ['harness:inbound'],
    exp: Math.floor(Date.now() / 1000) + 300, ...claims,
  })}`
  return `${head}.${sign('RSA-SHA256', Buffer.from(head), rsa.privateKey).toString('base64url')}`
}

async function launcher(upstreams: Record<string, string>, over: Partial<{ federate: (...a: unknown[]) => Promise<{ principalId: string }>, inbound: ReturnType<typeof vi.fn>, touch: ReturnType<typeof vi.fn>, surface: { responseTimeoutMs?: number, streamRetryMs?: number }, journal: (event: string, fields?: Record<string, unknown>) => void, jwks: Jwks, fleet: Record<string, unknown> }> = {}) {
  const secrets: Record<string, string> = { [A]: 'secret-a', [B]: 'secret-b' }
  const inbound = over.inbound ?? vi.fn(async () => undefined)
  const fleet = {
    person: (id: string) => (upstreams[id] ? { secretsDir: `/secrets/${id}` } : null),
    ensure: async (id: string) => ({ url: upstreams[id]!, secret: secrets[id]! }),
    upstream: (id: string) => ({ url: upstreams[id]!, secret: secrets[id]! }),
    touch: over.touch ?? (() => undefined),
    awake: async () => true,
    onStop: () => () => undefined,
    onWake: () => () => undefined,
    inbound,
    ...over.fleet,
  } as unknown as Fleet
  const server = new LauncherServer({
    config: {
      mount: '/harness', publicUrl: 'https://cp.example/harness', secureCookies: true, cookieSecret: SECRET, startTimeoutMs: 30_000,
      iam: { url: 'http://iam', issuer: 'https://iam.example', tenantId: 'tenant-1', identityProvider: 'keycloak', audience: 'human-harness', scopes: ['harness:use'], bootstrapToken: null },
    },
    fleet,
    oidc: {
      start: async (redirect: string) => ({ url: `https://kc.example/auth?redirect_uri=${encodeURIComponent(redirect)}`, state: 'st', verifier: 've' }),
      exchange: async () => 'idp-token',
    },
    iam: { federate: (over.federate ?? (async () => ({ principalId: A }))) as never },
    jwks: over.jwks ?? jwks,
    journal: over.journal ?? quiet,
    ...(over.surface !== undefined ? { surface: over.surface } : {}),
  })
  return { base: await listen(server.server), inbound, secrets, server }
}

const sessionFor = (id: string, secret = SECRET) => `${SESSION_COOKIE}=${encodeURIComponent(seal(secret, { principalId: id }, Date.now() + 60_000))}`

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number, headers: IncomingHttpHeaders, body: string }> {
  return new Promise((resolve, reject) => {
    request(url, { headers }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => { body += c.toString() })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    }).on('error', reject).end()
  })
}

describe('подписи launcher', () => {
  it('cookie: подделка и истёкший срок отвергаются', () => {
    const token = seal(SECRET, { principalId: A }, Date.now() + 1000)
    expect(unseal(SECRET, token)).toMatchObject({ principalId: A })
    expect(unseal(Buffer.from('other'), token)).toBeNull()
    expect(unseal(SECRET, `${token.slice(0, -2)}xx`)).toBeNull()
    expect(unseal(SECRET, seal(SECRET, { principalId: A }, Date.now() - 1))).toBeNull()
  })

  it('заголовок launcher: проверка контейнером совпадает, чужой principal и старое время — нет', () => {
    const header = launcherHeader('s', A)
    expect(verifyLauncherHeader('s', A, header)).toBe(true)
    expect(checkLauncherHeader('s', A, header)).toBe(true)
    expect(verifyLauncherHeader('s', B, header)).toBe(false)
    expect(verifyLauncherHeader('other', A, header)).toBe(false)
    expect(verifyLauncherHeader('s', A, launcherHeader('s', A, Date.now() - 5 * 60_000))).toBe(false)
    expect(verifyLauncherHeader('s', A, undefined)).toBe(false)
  })

  it('токен IAM: подпись, audience, tenant и scope', async () => {
    const expect_ = { issuer: 'https://iam.example', audience: 'human-harness', tenantId: 'tenant-1', scope: 'harness:inbound' }
    expect(await verifyIamToken(iamToken({}), jwks, expect_)).toMatchObject({ sub: 'svc' })
    expect(await verifyIamToken(iamToken({ scope: ['harness:use'] }), jwks, expect_)).toBeNull()
    expect(await verifyIamToken(iamToken({ aud: 'control-plane' }), jwks, expect_)).toBeNull()
    expect(await verifyIamToken(iamToken({ tenant_id: 'tenant-2' }), jwks, expect_)).toBeNull()
    expect(await verifyIamToken(iamToken({ exp: 1 }), jwks, expect_)).toBeNull()
    const forged = iamToken({}).split('.')
    forged[1] = Buffer.from(JSON.stringify({ iss: 'https://iam.example', aud: 'human-harness', tenant_id: 'tenant-1', sub: 'x', scope: ['harness:inbound'], exp: 9e9 })).toString('base64url')
    expect(await verifyIamToken(forged.join('.'), jwks, expect_)).toBeNull()
  })
})

describe('прокси и изоляция', () => {
  it('без входа: страница ведёт на вход, API получает 401', async () => {
    const a = await fakeHarness('A')
    const { base } = await launcher({ [A]: a.url })
    const html = await get(`${base}/harness/`, { accept: 'text/html' })
    expect(html.status).toBe(302)
    expect(html.headers.location).toBe('/harness/_launcher/login?next=%2F')
    expect((await get(`${base}/harness/api/x`)).status).toBe(401)
    expect(a.seen).toHaveLength(0)
  })

  it('cookie A ведёт только в харнесс A; cookie launcher не уходит в контейнер, чужой заголовок заменён', async () => {
    const a = await fakeHarness('A')
    const b = await fakeHarness('B')
    const { base } = await launcher({ [A]: a.url, [B]: b.url })
    const res = await get(`${base}/harness/api/sessions?x=1`, { cookie: `${sessionFor(A)}; dsh=abc`, 'x-harness-launcher': 'v1.1.forged' })
    expect(JSON.parse(res.body)).toEqual({ harness: 'A', path: '/api/sessions?x=1' })
    expect(b.seen).toHaveLength(0)
    const headers = a.seen[0]!.headers
    expect(headers.cookie).toBe('dsh=abc')
    expect(verifyLauncherHeader('secret-a', A, headers['x-harness-launcher'] as string)).toBe(true)
    expect(verifyLauncherHeader('secret-b', A, headers['x-harness-launcher'] as string)).toBe(false)
    expect(headers['x-forwarded-prefix']).toBe('/harness')
  })

  it('cookie, подписанная чужим ключом, — 401; человек без рабочего места — 403', async () => {
    const a = await fakeHarness('A')
    const { base } = await launcher({ [A]: a.url })
    expect((await get(`${base}/harness/api/x`, { cookie: sessionFor(A, Buffer.from('attacker')) })).status).toBe(401)
    expect((await get(`${base}/harness/`, { cookie: sessionFor(STRANGER), accept: 'text/html' })).status).toBe(403)
    expect(a.seen).toHaveLength(0)
  })

  it('истёкшая cookie DSH — снова через вход launcher, а не голый 401', async () => {
    const a = await fakeHarness('A', { status: 401 })
    const { base } = await launcher({ [A]: a.url })
    const res = await get(`${base}/harness/`, { cookie: sessionFor(A), accept: 'text/html' })
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('/harness/_harness/enter?next=%2F')
  })

  it('WebSocket проксируется в контейнер своего principal', async () => {
    const a = await fakeHarness('A')
    const b = await fakeHarness('B')
    const { base } = await launcher({ [A]: a.url, [B]: b.url })
    const port = Number(new URL(base).port)
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(`GET /harness/api/ws HTTP/1.1\r\nHost: cp.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: ${sessionFor(B)}\r\n\r\n`)
      })
      let data = ''
      socket.on('data', (d: Buffer) => {
        data += d.toString()
        if (data.includes('101') && !data.includes('ping')) socket.write('ping')
        if (data.includes('B:ping')) { socket.destroy(); resolve(data) }
      })
      socket.on('error', reject)
    })
    expect(reply).toContain('101 Switching Protocols')
    expect(b.seen[0]!.path).toBe('/api/ws')
    expect(a.seen).toHaveLength(0)
  })

  it('WebSocket без входа отклоняется', async () => {
    const a = await fakeHarness('A')
    const { base } = await launcher({ [A]: a.url })
    const reply = await new Promise<string>((resolve) => {
      const socket = connect(Number(new URL(base).port), '127.0.0.1', () => socket.write('GET /harness/api/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'))
      socket.on('data', (d: Buffer) => { resolve(d.toString()); socket.destroy() })
    })
    expect(reply).toMatch(/^HTTP\/1.1 401/)
  })
})

describe('вход человека', () => {
  it('login → PKCE cookie и IdP; callback → cookie сессии и вход в DSH через launcher', async () => {
    const a = await fakeHarness('A')
    const { base } = await launcher({ [A]: a.url })
    const login = await get(`${base}/harness/_launcher/login?next=/`)
    expect(login.status).toBe(302)
    expect(login.headers.location).toContain(encodeURIComponent('https://cp.example/harness/_launcher/callback'))
    const pkce = String(login.headers['set-cookie']![0]).split(';')[0]!
    expect(pkce.startsWith(`${PKCE_COOKIE}=`)).toBe(true)
    const bad = await get(`${base}/harness/_launcher/callback?code=c&state=other`, { cookie: pkce })
    expect(bad.status).toBe(400)
    const cb = await get(`${base}/harness/_launcher/callback?code=c&state=st`, { cookie: pkce })
    expect(cb.status).toBe(302)
    expect(cb.headers.location).toBe('/harness/_harness/enter?next=%2F')
    const session = String(cb.headers['set-cookie']![0]).split(';')[0]!.split('=')[1]!
    expect(unseal(SECRET, decodeURIComponent(session))).toMatchObject({ principalId: A })
  })

  it('IAM отказал (principal отключён) — входа нет', async () => {
    const { base } = await launcher({ [A]: (await fakeHarness('A')).url }, { federate: async () => { throw new Error('403 principal_disabled') } })
    const login = await get(`${base}/harness/_launcher/login`)
    const pkce = String(login.headers['set-cookie']![0]).split(';')[0]!
    const cb = await get(`${base}/harness/_launcher/callback?code=c&state=st`, { cookie: pkce })
    expect(cb.status).toBe(403)
    expect(cb.headers['set-cookie']).toBeUndefined()
  })
})

describe('вход канала', () => {
  function post(url: string, body: unknown, headers: Record<string, string> = {}) {
    return new Promise<number>((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', reject)
      req.end(JSON.stringify(body))
    })
  }

  it('только токен IAM со scope harness:inbound; сообщение уходит в харнесс principal', async () => {
    const { base, inbound } = await launcher({ [A]: (await fakeHarness('A')).url })
    const url = `${base}/harness/_launcher/internal/principals/${A}/inbound`
    expect(await post(url, { text: 'привет', channel: 'telegram' })).toBe(401)
    expect(await post(url, { text: 'привет', channel: 'telegram' }, { authorization: `Bearer ${iamToken({ scope: ['harness:use'] })}` })).toBe(401)
    expect(await post(url, { text: 'привет', channel: 'telegram', messageId: 'm1' }, { authorization: `Bearer ${iamToken({})}` })).toBe(202)
    expect(inbound).toHaveBeenCalledWith(A, { text: 'привет', channel: 'telegram', messageId: 'm1' })
    expect(await post(`${base}/harness/_launcher/internal/principals/${STRANGER}/inbound`, { text: 'x', channel: 'telegram' }, { authorization: `Bearer ${iamToken({})}` })).toBe(404)
  })

  it('нажатие подтверждения харнесса уходит в харнесс; кривое — 400', async () => {
    const { base, inbound } = await launcher({ [A]: (await fakeHarness('A')).url })
    const url = `${base}/harness/_launcher/internal/principals/${A}/inbound`
    const bearer = { authorization: `Bearer ${iamToken({})}` }
    expect(await post(url, { channel: 'telegram', messageId: 'cb-1', approval: { id: 'req-1', decision: 'approve' } }, bearer)).toBe(202)
    expect(inbound).toHaveBeenCalledWith(A, { channel: 'telegram', messageId: 'cb-1', approval: { id: 'req-1', decision: 'approve' } })
    expect(await post(url, { channel: 'telegram', approval: { id: 'req-1', decision: 'maybe' } }, bearer)).toBe(400)
    expect(await post(url, { channel: 'telegram' }, bearer)).toBe(400)
  })
})

class FakeDocker implements DockerApi {
  containers = new Map<string, ContainerInfo>()
  volumes = new Map<string, string>()
  calls: string[] = []
  async inspect(name: string) { return this.containers.get(name) ?? null }
  async create(spec: CreateContainer) {
    this.calls.push(`create ${spec.name}`)
    this.containers.set(spec.name, { id: randomUUID(), name: spec.name, image: spec.image, running: false, labels: { 'harness.managed': 'true', 'harness.principal': spec.principalId, [LABEL_SPEC]: SPEC_VERSION }, env: { ...spec.env }, networks: [spec.network] })
    return 'id'
  }
  async start(name: string) { this.calls.push(`start ${name}`); this.containers.get(name)!.running = true }
  async stop(name: string) { this.calls.push(`stop ${name}`); const c = this.containers.get(name); if (c) c.running = false }
  async remove(name: string) { this.calls.push(`remove ${name}`); this.containers.delete(name) }
  async createVolume(name: string, principalId: string) { this.volumes.set(name, principalId) }
  async removeVolume(name: string) { this.calls.push(`removeVolume ${name}`); this.volumes.delete(name) }
  async managed() { return { containers: [...this.containers.values()], volumes: [...this.volumes].map(([name, principalId]) => ({ name, principalId })) } }
}

function fleet(over: { status?: Record<string, string>, harness?: (url: string) => Response, now?: () => number, publicUrl?: string, windowUrl?: string } = {}) {
  const docker = new FakeDocker()
  const journal: { event: string, fields: Record<string, unknown> }[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    return over.harness?.(url) ?? new Response(JSON.stringify(url.endsWith('/status') ? { busy: false, nextWakeAt: null } : { ok: true }))
  })
  const f = new Fleet({
    config: {
      docker: { url: 'x', image: 'harness:1', network: 'net', port: 3080, memoryBytes: 1, cpus: 1, pidsLimit: 512, env: { HARNESS_APP_NAME: 'Рабочее место' }, secretsTarget: '/run/secrets/harness', secretsBase: '/srv' },
      people: { [A]: { secretsDir: '/srv/a' }, [B]: { secretsDir: '/srv/b' } },
      idleMs: 30 * 60_000, startTimeoutMs: 30_000, devUpstream: null,
      ...(over.publicUrl ? { publicUrl: over.publicUrl } : {}),
      ...(over.windowUrl ? { windowUrl: over.windowUrl } : {}),
    },
    docker,
    iam: { status: async (id: string) => (over.status?.[id] ?? 'active') as never },
    state: new StateFile(join(mkdtempSync(join(tmpdir(), 'launcher-')), 'state.json')),
    journal: (event, fields = {}) => journal.push({ event, fields }),
    fetch: fetchImpl as typeof fetch,
    now: over.now ?? Date.now,
    sleep: async () => undefined,
  })
  return { f, docker, journal, fetchImpl }
}

describe('жизненный цикл контейнеров', () => {
  it('первый запрос создаёт volume и контейнер из закреплённого образа, параллельные — один старт', async () => {
    const { f, docker } = fleet()
    const [u1, u2] = await Promise.all([f.ensure(A), f.ensure(A)])
    expect(u1).toEqual(u2)
    expect(u1.url).toBe(`http://${containerName(A)}:3080`)
    expect(docker.calls).toEqual([`create ${containerName(A)}`, `start ${containerName(A)}`])
    expect(docker.volumes.get(volumeName(A))).toBe(A)
    await f.ensure(A)
    expect(docker.calls).toHaveLength(2)
  })

  it('контейнер получает адрес окна беседы для ссылки «Открыть окно» в канале', async () => {
    const { f, docker } = fleet({ publicUrl: 'https://cp.example/harness', windowUrl: 'https://cp.example/console/?assistant=open' })
    await f.ensure(A)
    expect(docker.containers.get(containerName(A))!.env).toMatchObject({
      HARNESS_PUBLIC_URL: 'https://cp.example/harness',
      HARNESS_WINDOW_URL: 'https://cp.example/console/?assistant=open',
    })
  })

  it('окно беседы по умолчанию — консоль с открытым ассистентом на хосте launcher\'а', () => {
    expect(defaultWindowUrl('https://cp.example/harness')).toBe('https://cp.example/console/?assistant=open')
    expect(defaultWindowUrl('http://app.localhost:8080/harness')).toBe('http://app.localhost:8080/console/?assistant=open')
  })

  it('состояние launcher потеряно — секрет берётся из живого контейнера, а не выдумывается', async () => {
    const { docker, f } = fleet()
    docker.containers.set(containerName(A), { id: 'x', name: containerName(A), image: 'harness:1', running: true, labels: { 'harness.managed': 'true', 'harness.principal': A }, env: { HARNESS_LAUNCHER_SECRET: 'old-secret' } })
    const upstream = await f.ensure(A)
    expect(upstream.secret).toBe('old-secret')
    expect(docker.calls).toEqual([])
  })

  it('харнесс не поднялся за бюджет — 504', async () => {
    let t = 0
    const { f } = fleet({ harness: url => (url.endsWith('/health') ? new Response('', { status: 503 }) : new Response('{}')), now: () => (t += 5000) })
    await expect(f.ensure(A)).rejects.toMatchObject({ status: 504 })
  })

  it('простой без хода — сон с запомненным напоминанием, затем пробуждение по нему', async () => {
    let now = Date.parse('2026-09-26T10:00:00Z')
    const wake = '2026-09-26T12:00:00Z'
    const { f, docker, journal } = fleet({ now: () => now, harness: url => new Response(JSON.stringify(url.endsWith('/status') ? { busy: false, nextWakeAt: wake } : { ok: true })) })
    await f.ensure(A)
    now += 31 * 60_000
    await f.tick()
    expect(docker.containers.get(containerName(A))!.running).toBe(false)
    expect(journal.map(j => j.event)).toContain('container.slept')
    now = Date.parse(wake) + 1000
    await f.tick()
    expect(docker.containers.get(containerName(A))!.running).toBe(true)
    expect(journal.map(j => j.event)).toContain('container.woken')
  })

  it('идёт ход — не усыплять', async () => {
    let now = Date.now()
    const { f, docker } = fleet({ now: () => now, harness: url => new Response(JSON.stringify(url.endsWith('/status') ? { busy: true, nextWakeAt: null } : { ok: true })) })
    await f.ensure(A)
    now += 60 * 60_000
    await f.tick()
    expect(docker.containers.get(containerName(A))!.running).toBe(true)
  })

  it('sweep: отключённый principal — контейнер и volume удалены, активный и приостановленный — нет', async () => {
    const { f, docker, journal } = fleet({ status: { [A]: 'disabled', [B]: 'paused' } })
    await f.ensure(A)
    await f.ensure(B)
    await f.sweep()
    expect(docker.containers.has(containerName(A))).toBe(false)
    expect(docker.volumes.has(volumeName(A))).toBe(false)
    expect(docker.containers.get(containerName(B))!.running).toBe(false)
    expect(docker.volumes.has(volumeName(B))).toBe(true)
    expect(journal.find(j => j.event === 'conversation.deleted')!.fields).toMatchObject({ principalId: A, reason: 'principal_disabled' })
  })

  it('sweep без ответа IAM ничего не удаляет', async () => {
    const { f, docker } = fleet({ status: { [A]: null as never } })
    await f.ensure(A)
    await f.sweep()
    expect(docker.containers.has(containerName(A))).toBe(true)
  })
})

describe('пересоздание контейнера старой спецификации (изоляция сетей харнесса)', () => {
  const legacy = (running: boolean): ContainerInfo => ({
    id: 'old', name: containerName(A), image: 'harness:1', running,
    labels: { 'harness.managed': 'true', 'harness.principal': A }, env: {}, networks: ['stack_default'],
  })

  it('спящий контейнер из общей сети пересоздаётся при пробуждении, volume остаётся', async () => {
    const { f, docker, journal } = fleet()
    docker.containers.set(containerName(A), legacy(false))
    docker.volumes.set(volumeName(A), A)
    await f.ensure(A)
    expect(docker.calls).toEqual([`remove ${containerName(A)}`, `create ${containerName(A)}`, `start ${containerName(A)}`])
    expect(docker.containers.get(containerName(A))!.networks).toEqual(['net'])
    expect(docker.volumes.get(volumeName(A))).toBe(A)
    expect(journal.find(j => j.event === 'container.recreated')?.fields).toMatchObject({ principalId: A })
  })

  it('спящий контейнер текущей спецификации, но в другой сети — тоже пересоздаётся', async () => {
    const { f, docker } = fleet()
    docker.containers.set(containerName(A), { ...legacy(false), labels: { ...legacy(false).labels, [LABEL_SPEC]: SPEC_VERSION } })
    await f.ensure(A)
    expect(docker.calls[0]).toBe(`remove ${containerName(A)}`)
  })

  it('спящий контейнер спецификации 2 (без MemorySwap) в своей сети — пересоздаётся, volume остаётся', async () => {
    expect(SPEC_VERSION).toBe('3')
    const { f, docker } = fleet()
    docker.containers.set(containerName(A), { ...legacy(false), labels: { ...legacy(false).labels, [LABEL_SPEC]: '2' }, networks: ['net'] })
    docker.volumes.set(volumeName(A), A)
    await f.ensure(A)
    expect(docker.calls).toEqual([`remove ${containerName(A)}`, `create ${containerName(A)}`, `start ${containerName(A)}`])
    expect(docker.containers.get(containerName(A))!.labels[LABEL_SPEC]).toBe('3')
    expect(docker.volumes.get(volumeName(A))).toBe(A)
  })

  it('спящий контейнер текущей спецификации в своей сети не пересоздаётся', async () => {
    const { f, docker } = fleet()
    docker.containers.set(containerName(A), { ...legacy(false), labels: { ...legacy(false).labels, [LABEL_SPEC]: SPEC_VERSION }, networks: ['net'] })
    await f.ensure(A)
    expect(docker.calls).toEqual([`start ${containerName(A)}`])
  })

  it('бодрый контейнер старой спецификации не трогаем: идёт работа', async () => {
    const { f, docker } = fleet()
    docker.containers.set(containerName(A), legacy(true))
    await f.ensure(A)
    expect(docker.calls).toEqual([])
  })
})

describe('Docker: спецификация контейнера человека', () => {
  const MB = 1024 * 1024
  const policy: CreatePolicy = { image: 'harness:1', network: 'stack_harness-people', secretsBase: '/srv/secrets/harness' }
  const spec = (over: Partial<CreateContainer> = {}): CreateContainer => ({
    name: containerName(A), image: 'harness:1', principalId: A, env: {},
    volume: volumeName(A), volumeTarget: '/data', secretsDir: `/srv/secrets/harness/${A}`, secretsTarget: '/run/secrets/harness',
    network: 'stack_harness-people', memoryBytes: 64 * MB, cpus: 1, pidsLimit: 512, ...over,
  })

  it('годная спецификация проходит', () => {
    expect(() => checkCreate(spec(), policy)).not.toThrow()
    expect(() => checkCreate(spec({ secretsDir: `/srv/secrets/harness/${A}/` }), policy)).not.toThrow()
    expect(() => checkCreate(spec({ secretsDir: null }), policy)).not.toThrow()
    expect(() => checkCreate(spec({ secretsDir: null }), { ...policy, secretsBase: null })).not.toThrow()
    // нижние границы — включительно
    expect(() => checkCreate(spec({ cpus: 0.01, pidsLimit: 1, memoryBytes: 6 * MB }), policy)).not.toThrow()
  })

  it.each<[string, Partial<CreateContainer>]>([
    ['чужой образ', { image: 'docker:cli' }],
    ['principal не UUID', { principalId: '../x', name: 'harness-../x', volume: 'harness-data-../x' }],
    ['имя не из principal', { name: containerName(B) }],
    ['volume другого человека', { volume: volumeName(B) }],
    ['корень хоста в секретах', { secretsDir: '/' }],
    ['сокет Docker в секретах', { secretsDir: '/var/run/docker.sock' }],
    ['секреты другого человека', { secretsDir: `/srv/secrets/harness/${B}` }],
    ['обход каталога', { secretsDir: `/srv/secrets/harness/../../../${A}` }],
    ['относительный путь', { secretsDir: `secrets/${A}` }],
    ['разделитель Binds в пути', { secretsDir: `/srv:/etc/${A}` }],
    ['каталог principal вне базы секретов', { secretsDir: `/etc/${A}` }],
    ['каталог principal глубже базы', { secretsDir: `/srv/secrets/harness/nested/${A}` }],
    ['каталог principal — родитель базы', { secretsDir: `/srv/secrets/${A}` }],
    ['цель монтирования не абсолютна', { volumeTarget: 'data' }],
    ['сеть хоста', { network: 'host' }],
    ['общий bridge', { network: 'bridge' }],
    ['namespace чужого контейнера', { network: 'container:harness-docker-proxy' }],
    ['сеть ядра compose', { network: 'stack_default' }],
    ['похожая на разрешённую сеть', { network: 'stack_harness-people2' }],
    ['короткий ID сети', { network: '0123456789ab' }],
    ['полный ID сети', { network: 'a'.repeat(64) }],
    ['без лимита процессов', { pidsLimit: 0 }],
    ['дробный лимит процессов', { pidsLimit: 0.5 }],
    ['без лимита CPU', { cpus: Number.NaN }],
    ['CPU округляется до нуля', { cpus: 1e-10 }],
    ['CPU ниже 0,01', { cpus: 0.009 }],
    ['без лимита памяти', { memoryBytes: 0 }],
    ['память ниже минимума Docker', { memoryBytes: 1024 }],
    ['память округляется до нуля', { memoryBytes: 0.5 }],
  ])('отказ: %s', (_why, over) => {
    expect(() => checkCreate(spec(over), policy)).toThrow(expect.objectContaining({ status: 403 }))
  })

  it.each<[string, Partial<CreatePolicy>, Partial<CreateContainer>]>([
    ['базы секретов нет', { secretsBase: null }, {}],
    // каталог /<principal> лежит ровно в базе «/» — отказ только из-за самой базы
    ['база секретов — корень', { secretsBase: '/' }, { secretsDir: `/${A}` }],
    ['база секретов не нормализована', { secretsBase: '/srv/secrets/../secrets/harness' }, {}],
    ['разрешена другая сеть', { network: 'other' }, {}],
    ['разрешённой назвали сеть хоста', { network: 'host' }, { network: 'host' }],
    ['разрешённой назвали ID сети', { network: '0123456789ab' }, { network: '0123456789ab' }],
  ])('отказ по политике: %s', (_why, over, specOver) => {
    expect(() => checkCreate(spec(specOver), { ...policy, ...over })).toThrow(expect.objectContaining({ status: 403 }))
  })

  it('тело create: ровно одна разрешённая сеть, своп равен памяти, лимиты не ниже границ', () => {
    const body = checkCreate(spec(), policy)
    expect(body.HostConfig).toMatchObject({ NetworkMode: 'stack_harness-people', Memory: 64 * MB, MemorySwap: 64 * MB, NanoCpus: 1e9, PidsLimit: 512 })
    expect(() => checkCreateBody({ ...body, NetworkingConfig: { EndpointsConfig: { 'stack_harness-people': {} } } }, policy)).not.toThrow()
    const refused: [string, ReturnType<typeof createBody>][] = [
      ['вторая сеть в EndpointsConfig', { ...body, NetworkingConfig: { EndpointsConfig: { 'stack_harness-people': {}, stack_default: {} } } }],
      ['чужая сеть в EndpointsConfig', { ...body, NetworkingConfig: { EndpointsConfig: { stack_default: {} } } }],
      ['другой NetworkMode', { ...body, HostConfig: { ...body.HostConfig, NetworkMode: 'container:x' } }],
      ['чужой образ', { ...body, Image: 'docker:cli' }],
      ['привилегии', { ...body, HostConfig: { ...body.HostConfig, Privileged: true } }],
      ['своп сверх памяти', { ...body, HostConfig: { ...body.HostConfig, MemorySwap: -1 } }],
      ['NanoCpus = 0', { ...body, HostConfig: { ...body.HostConfig, NanoCpus: 0 } }],
      ['PidsLimit = -1', { ...body, HostConfig: { ...body.HostConfig, PidsLimit: -1 } }],
      ['Memory = 0', { ...body, HostConfig: { ...body.HostConfig, Memory: 0, MemorySwap: 0 } }],
    ]
    for (const [why, bad] of refused) expect(() => checkCreateBody(bad, policy), why).toThrow(expect.objectContaining({ status: 403 }))
  })

  it('create уходит в Docker без привилегий, с лимитами и только своими монтированиями', async () => {
    const seen: { url: string, body: Record<string, any> }[] = []
    const url = await listen(createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => { body += c.toString() })
      req.on('end', () => {
        seen.push({ url: req.url ?? '', body: body ? JSON.parse(body) : {} })
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ Id: 'new' }))
      })
    }))
    const docker = new DockerClient(url, policy)
    expect(await docker.create(spec({ cpus: 1.5 }))).toBe('new')
    await expect(docker.create(spec({ network: 'host' }))).rejects.toMatchObject({ status: 403 })
    await expect(docker.create(spec({ network: 'stack_default' }))).rejects.toMatchObject({ status: 403 })
    await expect(docker.create(spec({ secretsDir: `/etc/${A}` }))).rejects.toMatchObject({ status: 403 })
    await expect(docker.create(spec({ cpus: 1e-10 }))).rejects.toMatchObject({ status: 403 })
    expect(seen).toHaveLength(1)
    const host = seen[0]!.body.HostConfig
    expect(host).toMatchObject({
      Binds: [`${volumeName(A)}:/data`, `/srv/secrets/harness/${A}:/run/secrets/harness:ro`],
      NetworkMode: 'stack_harness-people', Memory: 64 * MB, MemorySwap: 64 * MB, NanoCpus: 1_500_000_000, PidsLimit: 512,
      Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
    })
    for (const key of ['CapAdd', 'Devices', 'PidMode', 'IpcMode', 'UsernsMode', 'Mounts', 'VolumesFrom']) expect(host).not.toHaveProperty(key)
    expect(seen[0]!.body).not.toHaveProperty('NetworkingConfig')
    expect(seen[0]!.body.Labels).toMatchObject({ 'harness.managed': 'true', 'harness.principal': A, [LABEL_SPEC]: SPEC_VERSION })
  })

  it('существующий volume принимается только со своими метками', async () => {
    const volumes: Record<string, Record<string, string> | null> = {
      [volumeName(A)]: { 'harness.managed': 'true', 'harness.principal': A },
      'harness-data-foreign': null,
      'harness-data-other': { 'harness.managed': 'true', 'harness.principal': B },
      'harness-data-half': { 'harness.principal': A },
    }
    const posts: string[] = []
    const url = await listen(createServer((req, res) => {
      let raw = ''
      req.on('data', (c: Buffer) => { raw += c.toString() })
      req.on('end', () => {
        const m = /\/volumes\/([^/?]+)$/.exec(req.url ?? '')
        if (req.method === 'GET' && m && m[1] !== 'create') {
          const name = decodeURIComponent(m[1]!)
          if (!(name in volumes)) return res.writeHead(404).end('{}')
          return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ Name: name, Labels: volumes[name] }))
        }
        const body = JSON.parse(raw) as { Name: string, Labels: Record<string, string> }
        posts.push(body.Name)
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ Name: body.Name, Labels: body.Labels }))
      })
    }))
    const docker = new DockerClient(url, policy)
    await docker.createVolume(volumeName(A), A)
    await docker.createVolume(volumeName(B), B)
    await expect(docker.createVolume('harness-data-foreign', A)).rejects.toMatchObject({ status: 403 })
    await expect(docker.createVolume('harness-data-other', A)).rejects.toMatchObject({ status: 403 })
    await expect(docker.createVolume('harness-data-half', A)).rejects.toMatchObject({ status: 403 })
    expect(posts).toEqual([volumeName(B)])
  })

  it('volume, который Docker отдал при create без наших меток (гонка), — отказ', async () => {
    const url = await listen(createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        if (req.method === 'GET') return res.writeHead(404).end('{}')
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ Name: 'v', Labels: {} }))
      })
    }))
    await expect(new DockerClient(url, policy).createVolume(volumeName(A), A)).rejects.toMatchObject({ status: 403 })
  })

  it('GET тома ответил не 200 и не 404 — отказ, том не создаётся', async () => {
    const posts: string[] = []
    const url = await listen(createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        if (req.method === 'GET') return res.writeHead(500, { 'content-type': 'application/json' }).end('{"message":"boom"}')
        posts.push(req.url ?? '')
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ Name: volumeName(A), Labels: { 'harness.managed': 'true', 'harness.principal': A } }))
      })
    }))
    await expect(new DockerClient(url, policy).createVolume(volumeName(A), A)).rejects.toMatchObject({ status: 500 })
    expect(posts).toEqual([])
  })
})

describe('config: база каталогов секретов', () => {
  const people = { [A]: { secretsDir: `/srv/secrets/harness/${A}` }, [B]: { secretsDir: `/srv/secrets/harness/${B}/` } }

  it('задана LAUNCHER_SECRETS_BASE — она и проверяется по people.json', () => {
    expect(resolveSecretsBase(people, '/srv/secrets/harness/')).toBe('/srv/secrets/harness')
    expect(resolveSecretsBase({}, '/srv/secrets/harness')).toBe('/srv/secrets/harness')
  })

  it('не задана — общий родитель secretsDir; людей нет — базы нет', () => {
    expect(resolveSecretsBase(people, undefined)).toBe('/srv/secrets/harness')
    expect(resolveSecretsBase(people, '')).toBe('/srv/secrets/harness')
    expect(resolveSecretsBase({}, undefined)).toBeNull()
  })

  it.each<[string, Record<string, { secretsDir: string }>, string | undefined]>([
    ['разные родители', { [A]: { secretsDir: `/srv/a/${A}` }, [B]: { secretsDir: `/srv/b/${B}` } }, undefined],
    ['родитель — корень', { [A]: { secretsDir: `/${A}` } }, undefined],
    ['каталог не назван по principal', { [A]: { secretsDir: '/srv/secrets/harness/a' } }, undefined],
    ['каталог вне заданной базы', { [A]: { secretsDir: `/etc/${A}` } }, '/srv/secrets/harness'],
    ['относительный каталог', { [A]: { secretsDir: `secrets/${A}` } }, undefined],
    ['база — корень', {}, '/'],
    ['база относительная', {}, 'secrets/harness'],
    ['база не нормализована', {}, '/srv/../srv/secrets'],
  ])('отказ при старте: %s', (_why, ppl, explicit) => {
    expect(() => resolveSecretsBase(ppl, explicit)).toThrow(/launcher: /)
  })
})

describe('config: старт launcher\'а', () => {
  afterEach(() => { vi.unstubAllEnvs() })
  function stub(over: Record<string, string> = {}, people: Record<string, { secretsDir: string }> = { [A]: { secretsDir: `/srv/secrets/harness/${A}` } }) {
    const dir = mkdtempSync(join(tmpdir(), 'launcher-config-'))
    writeFileSync(join(dir, 'people.json'), JSON.stringify(people))
    writeFileSync(join(dir, 'cookie'), 'cookie-secret')
    const vars: Record<string, string> = {
      LAUNCHER_PUBLIC_URL: 'https://cp.example/harness', LAUNCHER_PEOPLE_FILE: join(dir, 'people.json'),
      LAUNCHER_COOKIE_SECRET_FILE: join(dir, 'cookie'), LAUNCHER_OIDC_ISSUER: 'https://cp.example/auth/realms/x',
      LAUNCHER_IAM_URL: 'http://iam', LAUNCHER_IAM_TENANT: 'tenant-1', LAUNCHER_IMAGE: 'harness:1', LAUNCHER_NETWORK: 'stack_harness-people',
      LAUNCHER_SECRETS_BASE: '', LAUNCHER_HARNESS_CPUS: '', LAUNCHER_HARNESS_PIDS: '', LAUNCHER_HARNESS_MEMORY_MB: '', ...over,
    }
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v)
  }

  it('годная конфигурация: база выведена, сеть и лимиты по умолчанию', () => {
    stub()
    expect(loadConfig().docker).toMatchObject({ network: 'stack_harness-people', secretsBase: '/srv/secrets/harness', cpus: 1, pidsLimit: 512, memoryBytes: 1536 * 1024 * 1024 })
    stub({ LAUNCHER_SECRETS_BASE: '/srv/secrets/harness/', LAUNCHER_HARNESS_CPUS: '0.01', LAUNCHER_HARNESS_PIDS: '1', LAUNCHER_HARNESS_MEMORY_MB: '6' })
    expect(loadConfig().docker.secretsBase).toBe('/srv/secrets/harness')
    // верхние границы — включительно
    stub({ LAUNCHER_HARNESS_CPUS: '64', LAUNCHER_HARNESS_PIDS: '65536', LAUNCHER_HARNESS_MEMORY_MB: '65536' })
    expect(loadConfig().docker).toMatchObject({ cpus: 64, pidsLimit: 65536, memoryBytes: 64 * 1024 * 1024 * 1024 })
  })

  it.each<[string, Record<string, string>]>([
    ['сеть хоста', { LAUNCHER_NETWORK: 'host' }],
    ['namespace чужого контейнера', { LAUNCHER_NETWORK: 'container:x' }],
    ['ID сети вместо имени (12 hex)', { LAUNCHER_NETWORK: '0123456789ab' }],
    ['ID сети вместо имени (64 hex)', { LAUNCHER_NETWORK: 'f'.repeat(64) }],
    ['CPU больше 64', { LAUNCHER_HARNESS_CPUS: '64.5' }],
    ['процессов больше 65536', { LAUNCHER_HARNESS_PIDS: '65537' }],
    ['память больше 64 ГБ', { LAUNCHER_HARNESS_MEMORY_MB: '65537' }],
    ['CPU округляется до нуля', { LAUNCHER_HARNESS_CPUS: '0.000000001' }],
    ['CPU ниже 0,01', { LAUNCHER_HARNESS_CPUS: '0.005' }],
    ['процессы округляются до нуля', { LAUNCHER_HARNESS_PIDS: '0.5' }],
    ['память ниже 6 МБ', { LAUNCHER_HARNESS_MEMORY_MB: '1' }],
    ['память не число', { LAUNCHER_HARNESS_MEMORY_MB: 'много' }],
    ['каталог вне заданной базы', { LAUNCHER_SECRETS_BASE: '/etc' }],
  ])('отказ при старте: %s', (_why, over) => {
    stub(over)
    expect(() => loadConfig()).toThrow(/launcher: /)
  })
})

describe('Docker: чужие объекты не трогаем', () => {
  it('контейнер без метки или из другого образа — отказ до мутации', async () => {
    const mutations: string[] = []
    const containers: Record<string, { Image: string, Labels: Record<string, string> }> = {
      mine: { Image: 'harness:1', Labels: { 'harness.managed': 'true' } },
      foreign: { Image: 'postgres:16', Labels: {} },
      drift: { Image: 'harness:0', Labels: { 'harness.managed': 'true' } },
    }
    const url = await listen(createServer((req, res) => {
      const m = /\/containers\/([^/?]+)(\/json)?/.exec(req.url ?? '')
      if (req.method === 'GET' && m && m[2]) {
        const c = containers[m[1]!]
        if (!c) return res.writeHead(404).end('{}')
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ Id: m[1], Name: `/${m[1]}`, Config: c, State: { Running: true } }))
      }
      mutations.push(`${req.method} ${req.url}`)
      res.writeHead(204).end()
    }))
    const docker = new DockerClient(url, { image: 'harness:1', network: 'net', secretsBase: '/srv' })
    await docker.stop('mine')
    await expect(docker.remove('foreign')).rejects.toMatchObject({ status: 403 })
    await expect(docker.stop('drift')).rejects.toMatchObject({ status: 403 })
    await expect(docker.create({ name: 'x', image: 'postgres:16' } as CreateContainer)).rejects.toMatchObject({ status: 403 })
    expect(mutations).toEqual(['POST /v1.43/containers/mine/stop?t=10'])
  })
})

// Поверхность беседы (TAI-ADR-0051, амендмент 2026-09-29; контракт harness-surface, surface/1).
const humanToken = (claims: Record<string, unknown> = {}) => iamToken({ sub: A, scope: ['harness:use'], principal_type: 'human', ...claims })

function send(url: string, init: { method?: string, headers?: Record<string, string>, body?: unknown, raw?: string } = {}): Promise<{ status: number, headers: IncomingHttpHeaders, body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: init.method ?? 'GET', headers: { 'content-type': 'application/json', ...init.headers } }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => { body += c.toString() })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end(init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)))
  })
}

/** Открытый SSE-поток: копит текст; `ended` — launcher закрыл соединение. */
function openStream(url: string, headers: Record<string, string>) {
  const state = { data: '', status: 0, headers: {} as IncomingHttpHeaders, ended: false }
  const req = request(url, { headers }, (res) => {
    state.status = res.statusCode ?? 0
    state.headers = res.headers
    res.on('data', (c: Buffer) => { state.data += c.toString() })
    res.on('close', () => { state.ended = true })
  })
  req.on('error', () => { state.ended = true })
  req.end()
  sockets.push({ destroy: () => req.destroy() })
  return state
}

const at = '2026-09-29T10:00:00.000Z'
const sse = (type: string, cursor: string, extra: Record<string, unknown>) => `event: ${type}\nid: ${cursor}\ndata: ${JSON.stringify({ type, cursor, at, ...extra })}\n\n`
const count = (text: string, needle: string) => text.split(needle).length - 1

/** Контейнер-двойник с API поверхности: поток отдаёт `ready` и одно сообщение и остаётся открытым. */
async function surfaceHarness() {
  const seen: { method: string, path: string, headers: IncomingHttpHeaders, body: string }[] = []
  const state = { healthy: true, hang: false, streams: 0, streamStatus: [] as number[] }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString() })
    req.on('end', () => {
      const path = req.url ?? ''
      if (path.startsWith('/_harness/health')) return res.writeHead(state.healthy ? 200 : 503).end('{}')
      if (path.startsWith('/internal/harness/status')) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ busy: false, nextWakeAt: null }))
      seen.push({ method: req.method ?? '', path, headers: req.headers, body })
      if (state.hang) return
      if (path.startsWith('/internal/harness/surface/stream')) {
        state.streams += 1
        const status = state.streamStatus.shift()
        if (status !== undefined) return res.writeHead(status, { 'content-type': 'application/json' }).end('{}')
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-harness-surface-version': 'surface/1' })
        res.write(sse('ready', 'c0', { resumed: req.headers['last-event-id'] !== undefined }))
        res.write(sse('message', 'c1', { message: { id: 'm-1', role: 'assistant', text: 'привет', at } }))
        return
      }
      const reply = path.startsWith('/internal/harness/surface/message') ? [202, { requestId: 'r', messageId: 'm_1', queued: false }]
        : path.startsWith('/internal/harness/surface/history') ? [200, { items: [], nextBefore: null }]
          : path.startsWith('/internal/harness/surface/approval') ? [200, { status: 'resolved' }] : [404, {}]
      res.writeHead(reply[0] as number, { 'content-type': 'application/json', 'x-harness-surface-version': 'surface/1', 'x-internal-debug': 'container', 'set-cookie': 'dsh=1' }).end(JSON.stringify(reply[1]))
    })
  })
  return { url: await listen(server), seen, state }
}

describe('поверхность беседы: проверка человека и лимиты', () => {
  const surfaceUrl = (base: string, id: string, op: string) => `${base}/harness/_launcher/internal/principals/${id}/surface/${op}`

  it('нет токена или чужой audience — 401; чужой sub, нет scope, агент — 403; нет в реестре — 404', async () => {
    const h = await surfaceHarness()
    const { base } = await launcher({ [A]: h.url, [B]: h.url })
    const body = { requestId: randomUUID(), text: 'привет' }
    const post = (id: string, token?: string) => send(surfaceUrl(base, id, 'message'), { method: 'POST', body, headers: token === undefined ? {} : { authorization: `Bearer ${token}` } })
    expect((await post(A)).status).toBe(401)
    expect((await post(A, humanToken({ aud: 'control-plane' }))).status).toBe(401)
    const wrongSub = await post(B, humanToken())
    expect(wrongSub.status).toBe(403)
    expect(JSON.parse(wrongSub.body).error.code).toBe('forbidden')
    expect((await post(A, humanToken({ scope: ['harness:inbound'] }))).status).toBe(403)
    expect((await post(A, humanToken({ principal_type: 'agent' }))).status).toBe(403)
    expect((await post(A, humanToken({ principal_type: undefined }))).status).toBe(403)
    const unknown = await post(STRANGER, humanToken({ sub: STRANGER }))
    expect(unknown.status).toBe(404)
    expect(JSON.parse(unknown.body).error.code).toBe('principal_unknown')
    expect(h.seen).toHaveLength(0)
  })

  it('сообщение и решение уходят в контейнер с секретом контейнера и сбрасывают простой, история — нет; наружу — только белый список заголовков', async () => {
    const h = await surfaceHarness()
    const touch = vi.fn()
    const { base } = await launcher({ [A]: h.url }, { touch })
    const auth = { authorization: `Bearer ${humanToken()}`, 'x-harness-surface-version': 'surface/1' }
    const requestId = randomUUID()
    const sent = await send(surfaceUrl(base, A, 'message'), { method: 'POST', headers: auth, body: { requestId, text: 'Почему стоит счёт?' } })
    expect(sent.status).toBe(202)
    expect(JSON.parse(sent.body)).toMatchObject({ messageId: 'm_1' })
    expect(sent.headers['x-harness-surface-version']).toBe('surface/1')
    expect(sent.headers['content-type']).toBe('application/json')
    expect(sent.headers['x-internal-debug']).toBeUndefined()
    expect(sent.headers['set-cookie']).toBeUndefined()
    expect(h.seen[0]).toMatchObject({ method: 'POST', path: '/internal/harness/surface/message' })
    expect(h.seen[0]!.headers.authorization).toBe('Bearer secret-a')
    expect(h.seen[0]!.headers['x-harness-surface']).toBe('console')
    expect(h.seen[0]!.headers['x-harness-surface-version']).toBe('surface/1')
    expect(JSON.parse(h.seen[0]!.body)).toEqual({ requestId, text: 'Почему стоит счёт?' })
    expect(touch).toHaveBeenCalledTimes(1)

    expect((await send(`${surfaceUrl(base, A, 'history')}?before=c9&limit=20`, { headers: auth })).status).toBe(200)
    expect(h.seen[1]!.path).toBe('/internal/harness/surface/history?before=c9&limit=20')
    expect(touch).toHaveBeenCalledTimes(1)

    expect((await send(surfaceUrl(base, A, 'approval'), { method: 'POST', headers: auth, body: { approvalRequestId: 'ap-1', decision: 'allow' } })).status).toBe(200)
    expect(touch).toHaveBeenCalledTimes(2)
    expect((await send(surfaceUrl(base, A, 'approval'), { headers: auth })).status).toBe(405)
  })

  it('тело больше 64 КБ — 413 body_too_large; курсор длиннее 200 или с пробелами — 400', async () => {
    const h = await surfaceHarness()
    const { base } = await launcher({ [A]: h.url })
    const auth = { authorization: `Bearer ${humanToken()}` }
    const big = await send(surfaceUrl(base, A, 'message'), { method: 'POST', headers: auth, body: { requestId: randomUUID(), text: 'я'.repeat(40_000) } })
    expect(big.status).toBe(413)
    expect(JSON.parse(big.body).error.code).toBe('body_too_large')
    expect((await send(`${surfaceUrl(base, A, 'stream')}?after=${'x'.repeat(201)}`, { headers: auth })).status).toBe(400)
    expect((await send(surfaceUrl(base, A, 'stream'), { headers: { ...auth, 'last-event-id': 'a b' } })).status).toBe(400)
    expect(h.seen).toHaveLength(0)
  })

  it('не больше 8 потоков на человека — девятый 429 too_many_streams; закрытый поток место освобождает', async () => {
    const h = await surfaceHarness()
    const { base } = await launcher({ [A]: h.url })
    const auth = { authorization: `Bearer ${humanToken()}` }
    const streams = Array.from({ length: 8 }, () => openStream(surfaceUrl(base, A, 'stream'), auth))
    await vi.waitFor(() => expect(h.state.streams).toBe(8))
    const ninth = await send(surfaceUrl(base, A, 'stream'), { headers: auth })
    expect(ninth.status).toBe(429)
    expect(JSON.parse(ninth.body).error.code).toBe('too_many_streams')
    expect(streams.every(s => s.status === 200)).toBe(true)
    sockets.pop()!.destroy()
    await vi.waitFor(async () => {
      const again = openStream(surfaceUrl(base, A, 'stream'), auth)
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(again.status).toBe(200)
    })
  })

  it('клиент ушёл во время медленной проверки токена — слот потока не занят, подписок и подключения к контейнеру нет', async () => {
    const h = await surfaceHarness()
    const lines: Record<string, unknown>[] = []
    const subscriptions = vi.fn(() => () => undefined)
    const slowJwks = new Jwks('http://iam/.well-known/jwks.json', (async () => {
      await new Promise(resolve => setTimeout(resolve, 150))
      return new Response(JSON.stringify({ keys: [jwk] }))
    }) as typeof fetch)
    const { base, server } = await launcher({ [A]: h.url }, { jwks: slowJwks, journal: (event, fields = {}) => lines.push({ event, ...fields }), fleet: { onStop: subscriptions, onWake: subscriptions } })
    const stream = openStream(surfaceUrl(base, A, 'stream'), { authorization: `Bearer ${humanToken()}` })
    await new Promise(resolve => setTimeout(resolve, 30))
    sockets.pop()!.destroy()
    await vi.waitFor(() => expect(lines.find(l => l.event === 'surface.access')).toMatchObject({ status: 499 }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect((server as unknown as { surface: { streams: Map<string, number> } }).surface.streams.size).toBe(0)
    expect(subscriptions).not.toHaveBeenCalled()
    expect(h.seen).toHaveLength(0)
    expect(stream.status).toBe(0)
  })

  it('контейнер ответил на поток 429 — клиента держим и переподключаемся позже; в журнал — статус контейнера', async () => {
    const h = await surfaceHarness()
    const lines: Record<string, unknown>[] = []
    h.state.streamStatus.push(429, 404)
    const { base } = await launcher({ [A]: h.url }, { surface: { streamRetryMs: 30 }, journal: (event, fields = {}) => lines.push({ event, ...fields }) })
    const auth = { authorization: `Bearer ${humanToken()}` }
    const first = openStream(surfaceUrl(base, A, 'stream'), auth)
    // Второй ответ контейнера — 404: такой поток закрывается, и журнал пишет 404.
    await vi.waitFor(() => expect(first.ended).toBe(true))
    expect(h.state.streams).toBe(2)
    expect(first.data).toContain(': harness 404')
    expect(lines.find(l => l.event === 'surface.access')).toMatchObject({ status: 404 })

    h.state.streamStatus.push(429)
    const second = openStream(surfaceUrl(base, A, 'stream'), auth)
    await vi.waitFor(() => expect(second.data).toContain('id: c1'))
    expect(second.ended).toBe(false)
    expect(h.state.streams).toBe(4)
  })

  it('контейнер не ответил за 30 с после готовности — 504 harness_timeout', async () => {
    const h = await surfaceHarness()
    const { base } = await launcher({ [A]: h.url }, { surface: { responseTimeoutMs: 100 } })
    h.state.hang = true
    const res = await send(surfaceUrl(base, A, 'history'), { headers: { authorization: `Bearer ${humanToken()}` } })
    expect(res.status).toBe(504)
    expect(JSON.parse(res.body).error.code).toBe('harness_timeout')
  })

  it('журнал доступа — без тел: метод, путь, статус, время, requestId', async () => {
    const h = await surfaceHarness()
    const lines: Record<string, unknown>[] = []
    const upstream = () => ({ url: h.url, secret: 's' })
    const fleet = { person: () => ({ secretsDir: '/s' }), ensure: async () => upstream(), upstream, touch: () => undefined, awake: async () => true, onStop: () => () => undefined, onWake: () => () => undefined } as unknown as Fleet
    const server = new LauncherServer({
      config: { mount: '/harness', publicUrl: 'https://cp.example/harness', secureCookies: true, cookieSecret: SECRET, startTimeoutMs: 1000, iam: { url: 'http://iam', issuer: 'https://iam.example', tenantId: 'tenant-1', identityProvider: 'keycloak', audience: 'human-harness', scopes: ['harness:use'], bootstrapToken: null } },
      fleet, oidc: { start: async () => ({ url: '', state: '', verifier: '' }), exchange: async () => '' }, iam: { federate: async () => ({ principalId: A }) }, jwks,
      journal: (event, fields = {}) => lines.push({ event, ...fields }),
    })
    const base = await listen(server.server)
    const requestId = randomUUID()
    await send(surfaceUrl(base, A, 'message'), { method: 'POST', headers: { authorization: `Bearer ${humanToken()}` }, body: { requestId, text: 'секретный текст' } })
    const access = lines.find(l => l.event === 'surface.access')!
    expect(Object.keys(access).sort()).toEqual(['event', 'method', 'ms', 'path', 'requestId', 'status'])
    expect(access).toMatchObject({ method: 'POST', path: `/harness/_launcher/internal/principals/${A}/surface/message`, status: 202, requestId })
    expect(JSON.stringify(lines)).not.toContain('секретный текст')
  })
})

describe('поверхность беседы: сон и пробуждение', () => {
  async function stand(opts: { startTimeoutMs?: number } = {}) {
    let now = Date.parse('2026-09-29T10:00:00Z')
    const h = await surfaceHarness()
    const docker = new FakeDocker()
    const journal: string[] = []
    class TestFleet extends Fleet {
      override upstream(id: string) { return { ...super.upstream(id), url: h.url } }
    }
    const f = new TestFleet({
      config: {
        docker: { url: 'x', image: 'harness:1', network: 'net', port: 3080, memoryBytes: 1, cpus: 1, pidsLimit: 512, env: {}, secretsTarget: '/run/secrets/harness', secretsBase: '/srv' },
        people: { [A]: { secretsDir: '/srv/a' } }, idleMs: 30 * 60_000, startTimeoutMs: 30_000, devUpstream: null,
      },
      docker,
      iam: { status: async () => 'active' as never },
      state: new StateFile(join(mkdtempSync(join(tmpdir(), 'launcher-')), 'state.json')),
      journal: event => journal.push(event),
      now: () => now,
      sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 10))),
    })
    const server = new LauncherServer({
      config: { mount: '/harness', publicUrl: 'https://cp.example/harness', secureCookies: true, cookieSecret: SECRET, startTimeoutMs: opts.startTimeoutMs ?? 5000, iam: { url: 'http://iam', issuer: 'https://iam.example', tenantId: 'tenant-1', identityProvider: 'keycloak', audience: 'human-harness', scopes: ['harness:use'], bootstrapToken: null } },
      fleet: f, oidc: { start: async () => ({ url: '', state: '', verifier: '' }), exchange: async () => '' }, iam: { federate: async () => ({ principalId: A }) }, jwks, journal: quiet,
    })
    const base = await listen(server.server)
    const url = (op: string) => `${base}/harness/_launcher/internal/principals/${A}/surface/${op}`
    const running = () => docker.containers.get(containerName(A))?.running === true
    const streamRequests = () => h.seen.filter(s => s.path.startsWith('/internal/harness/surface/stream'))
    return { f, h, docker, journal, url, running, streamRequests, advance: (ms: number) => { now += ms } }
  }
  const auth = () => ({ authorization: `Bearer ${humanToken()}` })
  const post = (url: string) => send(url, { method: 'POST', headers: auth(), body: { requestId: randomUUID(), text: 'ещё тут' } })

  it('подключение к спящему контейнеру его не будит: sleeping, соединение открыто', async () => {
    const { f, docker, url, streamRequests } = await stand()
    const ensure = vi.spyOn(f, 'ensure')
    const stream = openStream(url('stream'), { ...auth(), 'last-event-id': 'c7' })
    await vi.waitFor(() => expect(stream.data).toContain('event: sleeping'))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(stream.status).toBe(200)
    expect(stream.headers['x-harness-surface-version']).toBe('surface/1')
    expect(stream.ended).toBe(false)
    expect(ensure).not.toHaveBeenCalled()
    expect(docker.calls).toEqual([])
    expect(streamRequests()).toHaveLength(0)
    const sleeping = JSON.parse(/event: sleeping\ndata: (.+)\n/.exec(stream.data)![1]!)
    expect(sleeping).toMatchObject({ type: 'sleeping', cursor: 'c7' })
    expect(stream.data).not.toContain('id:')
  })

  it('разбудило сообщение — поток отдаёт waking, затем ready контейнера и события беседы; своего ready нет', async () => {
    const { url, running, streamRequests } = await stand()
    const stream = openStream(url('stream'), auth())
    await vi.waitFor(() => expect(stream.data).toContain('event: sleeping'))
    expect((await post(url('message'))).status).toBe(202)
    expect(running()).toBe(true)
    await vi.waitFor(() => expect(stream.data).toContain('id: c1'))
    const order = ['event: sleeping', 'event: waking', 'event: ready', 'event: message'].map(e => stream.data.indexOf(e))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(count(stream.data, 'event: ready')).toBe(1)
    expect(stream.data).toContain('"resumed":false')
    expect(streamRequests()).toHaveLength(1)
    expect(streamRequests()[0]!.headers['last-event-id']).toBeUndefined()
  })

  it('контейнер уснул при открытом потоке — sleeping, соединение открыто, цикла пробуждений нет; следующее пробуждение — продолжение с курсора', async () => {
    const { f, docker, url, running, journal, streamRequests, advance } = await stand()
    await f.ensure(A)
    const stream = openStream(url('stream'), auth())
    await vi.waitFor(() => expect(stream.data).toContain('id: c1'))
    expect(stream.data).not.toContain('event: sleeping')
    advance(31 * 60_000)
    await f.tick()
    expect(running()).toBe(false)
    expect(journal).toContain('container.slept')
    await vi.waitFor(() => expect(stream.data).toContain('event: sleeping'))
    const sleeping = JSON.parse(/event: sleeping\ndata: (.+)\n/.exec(stream.data)![1]!)
    expect(sleeping.cursor).toBe('c1')
    const starts = docker.calls.filter(c => c.startsWith('start')).length
    for (let i = 0; i < 3; i++) { advance(31 * 60_000); await f.tick() }
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(stream.ended).toBe(false)
    expect(running()).toBe(false)
    expect(docker.calls.filter(c => c.startsWith('start')).length).toBe(starts)
    expect(streamRequests()).toHaveLength(1)

    expect((await send(url('history'), { headers: auth() })).status).toBe(200)
    await vi.waitFor(() => expect(streamRequests()).toHaveLength(2))
    expect(streamRequests()[1]!.headers['last-event-id']).toBe('c1')
    await vi.waitFor(() => expect(count(stream.data, 'id: c1')).toBe(2))
    expect(stream.data.indexOf('event: waking')).toBeGreaterThan(stream.data.indexOf('event: sleeping'))
  })

  it('поток открыт, пока история проверяет бодрый контейнер, — сразу к потоку контейнера, без sleeping', async () => {
    const { f, docker, url, streamRequests } = await stand()
    await f.ensure(A)
    // Панель открывается: история (ensure бодрого контейнера) и поток уходят вместе.
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const inspect = docker.inspect.bind(docker)
    vi.spyOn(docker, 'inspect').mockImplementationOnce(async name => { await held; return inspect(name) })
    const history = f.ensure(A)
    const stream = openStream(url('stream'), auth())
    await vi.waitFor(() => expect(stream.data).toContain('id: c1'))
    release()
    await history
    expect(stream.data).not.toContain('event: sleeping')
    expect(stream.data).not.toContain('event: waking')
    expect(streamRequests()).toHaveLength(1)
  })

  it('курсор синтетического события в контейнер не уходит, настоящий — уходит', async () => {
    const { f, url, streamRequests } = await stand()
    await f.ensure(A)
    const synthetic = openStream(`${url('stream')}?after=launcher.waking.1`, auth())
    await vi.waitFor(() => expect(synthetic.data).toContain('id: c1'))
    expect(streamRequests()[0]!.path).toBe('/internal/harness/surface/stream')
    expect(streamRequests()[0]!.headers['last-event-id']).toBeUndefined()
    const real = openStream(url('stream'), { ...auth(), 'last-event-id': 'c0' })
    await vi.waitFor(() => expect(real.data).toContain('id: c1'))
    expect(streamRequests()[1]!.headers['last-event-id']).toBe('c0')
  })

  it('история будит, но простой не сбрасывает; сообщение — сбрасывает', async () => {
    const { f, url, running, advance } = await stand()
    await f.ensure(A)
    advance(20 * 60_000)
    expect((await send(url('history'), { headers: auth() })).status).toBe(200)
    advance(20 * 60_000)
    await f.tick()
    expect(running()).toBe(false)
    expect((await send(url('history'), { headers: auth() })).status).toBe(200)
    expect(running()).toBe(true)

    const other = await stand()
    await other.f.ensure(A)
    other.advance(20 * 60_000)
    expect((await post(other.url('message'))).status).toBe(202)
    other.advance(20 * 60_000)
    await other.f.tick()
    expect(other.running()).toBe(true)
    other.advance(15 * 60_000)
    await other.f.tick()
    expect(other.running()).toBe(false)
  })

  it('контейнер не проснулся за бюджет холодного старта — 504 waking_timeout', async () => {
    const { h, url } = await stand({ startTimeoutMs: 200 })
    h.state.healthy = false
    const res = await post(url('message'))
    expect(res.status).toBe(504)
    expect(JSON.parse(res.body).error.code).toBe('waking_timeout')
    h.state.healthy = true
  })
})
