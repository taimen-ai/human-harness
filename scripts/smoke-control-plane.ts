/**
 * Смоук против живого Control Plane: обмен PAT → whoami → «Важное» (me/attention).
 * Ничего не пишет (Session открывается и закрывается). Запуск: `pnpm smoke`.
 * Переменные: HARNESS_IAM_URL, HARNESS_IAM_TENANT, HARNESS_IAM_PRINCIPAL, HARNESS_CONTROL_PLANE_URL.
 */
import { IdentityProvider } from '../packages/identity/src/index.ts'
import { ControlPlaneClient } from '../packages/control-plane/src/client.ts'
import { ControlPlaneService } from '../packages/control-plane/src/service.ts'
import { ReadStateStore } from '../packages/control-plane/src/state.ts'

const iamUrl = process.env.HARNESS_IAM_URL ?? 'http://localhost/iam'
// HARNESS_IAM_TENANT обязателен: UUID tenant'а IAM (его выдаёт bootstrap платформы).
const tenantId = process.env.HARNESS_IAM_TENANT ?? ''
const serverUrl = process.env.HARNESS_CONTROL_PLANE_URL ?? 'http://localhost'

const identity = new IdentityProvider({
  iamUrl, tenantId, principalId: process.env.HARNESS_IAM_PRINCIPAL, refreshMarginSeconds: 60,
  audiences: { 'control-plane': ['control-plane:read', 'control-plane:write'] },
})
const client = new ControlPlaneClient({ serverUrl, identity, userAgent: 'human-harness-smoke/0.1.0' })
const log = { info: (m: string) => console.error(`[info] ${m}`), warn: (m: string) => console.error(`[warn] ${m}`), error: (m: string) => console.error(`[error] ${m}`) }
const service = new ControlPlaneService({ client, identity, state: new ReadStateStore('/dev/null'), clientVersion: '0.1.0-smoke', sessionTtlSeconds: 120, log })

const t0 = Date.now()
try {
  const who = await service.whoami()
  console.log(`whoami: ${who.principal.displayName} (${who.principal.kind}) @ ${who.tenant.slug}; permissions ${who.permissions.length}, roles ${who.roles.length}; session ${who.session?.id}`)
  const attention = await service.attention()
  console.log(`attention: ${attention.items.length} items · degraded ${attention.degraded.map(d => `${d.rule}:${d.reasonCode}`).join(', ') || '—'}`)
  for (const item of attention.items.slice(0, 8)) console.log(`  ${item.kind.padEnd(18)} ${item.reasonCode.padEnd(18)} ${item.taskPublicId ?? item.entity.id.slice(0, 8)} · ${item.title}`)
  console.log(`ok in ${Date.now() - t0} ms`)
} finally {
  await service.dispose()
}
