import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Браузерный бандл загружает __ModuleLoader__ DSH: require() разрешён только для модулей
// таблицы shell. Встроенный модуль Node (stream, buffer, module…) ломает загрузку окна.
const bundle = join(__dirname, '..', 'lib', 'client.js')
const SHELL = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit'])

describe.skipIf(!existsSync(bundle))('браузерный бандл окна', () => {
  it('require только модулей shell', () => {
    const required = [...readFileSync(bundle, 'utf8').matchAll(/\brequire\("([^"]+)"\)/g)].map(m => m[1]!)
    expect(required.filter(name => !SHELL.has(name))).toEqual([])
  })
})
