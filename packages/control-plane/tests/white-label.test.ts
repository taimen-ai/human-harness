/**
 * White-label guard (как control-plane tests/unit/test_branding.py): имя продукта
 * не появляется в коде, конфигурации и документации харнесса. Исключения —
 * документы проекта о себе (лицензия, товарный знак, правила участия), снимок
 * OpenAPI ядра и дословная копия схем контракта поверхности
 * `tests/contract/harness-surface/` (данные чужого контракта, не код харнесса;
 * `$id` схем указывает на их источник). Исключение — ровно этот каталог: другой
 * код в `tests/contract/` страж проверяет как обычно.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
// Имя продукта собирается из частей, чтобы страж не находил сам себя.
const CODENAME = new RegExp(['tai', 'men'].join(''), 'i')

const ALLOWED = new Set([
  'NOTICE',
  'TRADEMARK.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'pnpm-lock.yaml',
])
const ALLOWED_PREFIXES = ['packages/control-plane/openapi/', 'packages/control-plane/src/generated/', 'packages/control-plane/tests/contract/harness-surface/']

describe('white-label', () => {
  it('имени продукта нет вне списка исключений', () => {
    const files = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean)
    const offenders: string[] = []
    for (const file of files) {
      if (ALLOWED.has(file) || ALLOWED_PREFIXES.some(prefix => file.startsWith(prefix))) continue
      if (/\.(ttf|woff2?|png|jpe?g|ico)$/i.test(file) || !existsSync(`${REPO}${file}`)) continue
      readFileSync(`${REPO}${file}`, 'utf8').split('\n').forEach((line, i) => {
        if (CODENAME.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('исключения существуют', () => {
    for (const file of ALLOWED) expect(existsSync(`${REPO}${file}`), file).toBe(true)
    for (const prefix of ALLOWED_PREFIXES) expect(existsSync(`${REPO}${prefix}`), prefix).toBe(true)
  })
})
