/**
 * Contract-тест клиента Control Plane против снимка OpenAPI ядра
 * (`openapi/control-plane.json`, обновление — `pnpm gen:cp-types --fetch <url>`).
 *
 * 1. Сгенерированные типы совпадают со снимком (никто не правил их руками и не
 *    забыл перегенерировать после обновления снимка).
 * 2. Каждый вызов клиента — метод и путь — есть в снимке: клиент не пишет в
 *    выдуманный маршрут (гоча BO-04: агент выдумал контракт ядра и тесты под него).
 * 3. Переносимая часть пакета — клиент и `shared/` — не зависит от DSH
 *    (TAI-ADR-0038 п.5: оболочка заменяема).
 */
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GENERATED, render, SNAPSHOT } from '../../../scripts/gen-cp-types.ts'

const src = fileURLToPath(new URL('../src/', import.meta.url))

interface Spec { paths: Record<string, Record<string, unknown>> }

async function snapshot(): Promise<Spec> {
  return JSON.parse(await readFile(SNAPSHOT, 'utf8')) as Spec
}

/** Вызовы `this.request<…>('METHOD', '/api/…' | `/api/…${x}…`)` из исходника клиента. */
async function clientCalls(): Promise<{ method: string, path: string }[]> {
  const code = await readFile(`${src}client.ts`, 'utf8')
  const calls: { method: string, path: string }[] = []
  const re = /this\.request<[^(]*?>\(\s*'([A-Z]+)',\s*(['`])(\/api\/[^'`]+)\2/g
  for (const m of code.matchAll(re)) calls.push({ method: m[1]!, path: m[3]! })
  return calls
}

/** Путь клиента как шаблон: `${…}` — один непустой сегмент без `/`. */
function pattern(path: string): RegExp {
  const parts = path.split(/\$\{[^}]+\}/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${parts.join('[^/]+')}$`)
}

/** Путь OpenAPI с подставленными параметрами: `{task_ref}` → `X`. */
function sample(path: string): string {
  return path.replace(/\{[^}]+\}/g, 'X')
}

describe('контракт клиента Control Plane', () => {
  it('сгенерированные типы совпадают со снимком OpenAPI', async () => {
    const expected = await render(await readFile(SNAPSHOT, 'utf8'))
    expect(await readFile(GENERATED, 'utf8')).toBe(expected)
  })

  it('каждый вызов клиента есть в снимке с тем же методом', async () => {
    const spec = await snapshot()
    const calls = await clientCalls()
    expect(calls.length).toBeGreaterThan(10)
    const missing = calls.filter(({ method, path }) => {
      const re = pattern(path)
      return !Object.entries(spec.paths).some(([route, ops]) =>
        re.test(sample(route)) && method.toLowerCase() in ops)
    })
    expect(missing).toEqual([])
  })

  it('клиент и shared/ не импортируют DSH', async () => {
    const files = [`${src}client.ts`, ...(await readdir(`${src}shared`)).map(name => `${src}shared/${name}`)]
    for (const file of files) {
      const code = await readFile(file, 'utf8')
      expect(code, file).not.toMatch(/from '@deepseek-ai\//)
      expect(code, file).not.toMatch(/from '@human-harness\/dsh-/)
    }
  })
})
