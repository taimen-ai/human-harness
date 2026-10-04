#!/usr/bin/env node
/**
 * Точка входа launcher'а: конфигурация из окружения, сервер, минутные циклы
 * сна/пробуждения и удаления бесед отключённых principal.
 */
import { loadConfig } from './config.ts'
import { Jwks } from './crypto.ts'
import { DockerClient } from './docker.ts'
import { Fleet, StateFile } from './fleet.ts'
import { Iam, Oidc } from './identity.ts'
import { stdoutJournal } from './journal.ts'
import { LauncherServer } from './server.ts'

export { LauncherServer } from './server.ts'
export { Fleet, StateFile } from './fleet.ts'

async function main(): Promise<void> {
  const config = loadConfig()
  const journal = stdoutJournal()
  const iam = new Iam(config.iam.url, config.iam.tenantId, config.iam.bootstrapToken)
  const fleet = new Fleet({
    config,
    docker: new DockerClient(config.docker.url, { image: config.docker.image, network: config.docker.network, secretsBase: config.docker.secretsBase }),
    iam,
    state: new StateFile(config.stateFile),
    journal,
  })
  const launcher = new LauncherServer({
    config,
    fleet,
    oidc: new Oidc(config.oidc.issuer, config.oidc.clientId, config.oidc.scopes),
    iam,
    jwks: new Jwks(`${config.iam.url}/.well-known/jwks.json`),
    journal,
  })
  if (config.iam.bootstrapToken === null) journal('sweep.disabled', { reason: 'нет LAUNCHER_IAM_BOOTSTRAP_TOKEN_FILE — беседы отключённых principal не удаляются' })
  let running = false
  const minute = setInterval(() => {
    if (running) return
    running = true
    void (async () => {
      try { await fleet.sweep() } catch (error) { journal('sweep.error', { error: String(error) }) }
      try { await fleet.tick() } catch (error) { journal('tick.error', { error: String(error) }) }
    })().finally(() => { running = false })
  }, 60_000)
  launcher.server.listen(config.port, () => journal('started', { port: config.port, mount: config.mount, image: config.docker.image, network: config.docker.network, secretsBase: config.docker.secretsBase, people: Object.keys(config.people).length }))
  const stop = (): void => {
    clearInterval(minute)
    launcher.server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

if (process.argv[1] !== undefined && /main\.(js|ts)$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`launcher: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
