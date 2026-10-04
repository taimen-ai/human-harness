import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientBundle } from '../../tsdown.client.ts'

// docx-preview тянет jszip; сборщик не применяет его поле `browser` (подмена readable-stream),
// и в бандл попадали встроенные модули Node. Браузерная сборка jszip — готовый UMD без них.
// jszip лежит соседом docx-preview в хранилище pnpm.
// Тест `lib/client.js` на отсутствие встроенных модулей Node — tests/bundle.test.ts.
const here = dirname(fileURLToPath(import.meta.url))
const docxPreview = realpathSync(join(here, 'node_modules', 'docx-preview'))
const jszip = join(dirname(docxPreview), 'jszip', 'dist', 'jszip.min.js')
// read-excel-file тянет fflate; сборщик выбирал его node-условие (worker_threads, createRequire).
const readExcel = realpathSync(join(here, 'node_modules', 'read-excel-file'))
const fflate = join(dirname(readExcel), 'fflate', 'esm', 'browser.js')

export default clientBundle('@human-harness/dsh-client-ui-human-harness').map((config) => {
  if (!String(config.name ?? '').endsWith('/client')) return config
  const input = (config.inputOptions ?? {}) as { resolve?: Record<string, unknown> }
  return { ...config, inputOptions: { ...input, resolve: { ...(input.resolve ?? {}), alias: { jszip, fflate } } } }
})
