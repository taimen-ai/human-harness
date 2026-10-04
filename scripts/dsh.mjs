#!/usr/bin/env node
/**
 * Лончер dsh для Node без `import.meta.main` (< 22.18 / < 24.2): `lib/bin.js`
 * upstream запускает `runCli()` только под этим флагом и на Node 24.1 молча
 * завершается. Здесь тот же `runCli()` вызывается явно.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const manifest = require.resolve('@deepseek-ai/dsh/package.json')
const { runCli } = await import(pathToFileURL(join(dirname(manifest), 'lib', 'bin.js')).href)
await runCli()
