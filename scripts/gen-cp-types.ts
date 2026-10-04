/**
 * Типы клиента Control Plane из снимка его OpenAPI.
 *
 *   pnpm gen:cp-types                  — перегенерировать типы из снимка
 *   pnpm gen:cp-types --fetch <url>    — сначала обновить снимок с живого ядра
 *
 * Снимок (`packages/control-plane/openapi/control-plane.json`) — контракт, против
 * которого написан клиент; contract-тест пакета проверяет, что типы совпадают со
 * снимком, а каждый вызов клиента есть в нём с тем же методом.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import openapiTS, { astToString } from 'openapi-typescript'

const root = fileURLToPath(new URL('../packages/control-plane/', import.meta.url))
export const SNAPSHOT = `${root}openapi/control-plane.json`
export const GENERATED = `${root}src/generated/control-plane-api.ts`

const HEADER = `/* eslint-disable */
// Сгенерировано scripts/gen-cp-types.ts из openapi/control-plane.json — не править руками.
`

export async function render(snapshot: string): Promise<string> {
  const ast = await openapiTS(JSON.parse(snapshot), { alphabetize: true })
  return HEADER + astToString(ast)
}

async function main(): Promise<void> {
  const i = process.argv.indexOf('--fetch')
  if (i !== -1) {
    const base = (process.argv[i + 1] ?? '').replace(/\/+$/, '')
    if (base === '') throw new Error('--fetch: нужен адрес Control Plane, например https://cp.example.com')
    const response = await fetch(`${base}/openapi.json`)
    if (!response.ok) throw new Error(`openapi.json: HTTP ${response.status}`)
    const spec = await response.json() as Record<string, unknown>
    await writeFile(SNAPSHOT, `${JSON.stringify(spec, null, 2)}\n`)
  }
  await writeFile(GENERATED, await render(await readFile(SNAPSHOT, 'utf8')))
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) await main()
