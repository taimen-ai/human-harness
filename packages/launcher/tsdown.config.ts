import { defineConfig } from 'tsdown'

// Отдельный процесс Node без зависимостей: только встроенные модули.
export default defineConfig({
  entry: ['lib/types/main.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
