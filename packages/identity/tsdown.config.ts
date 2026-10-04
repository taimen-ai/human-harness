import { defineConfig } from 'tsdown'

// Node-half: всё, кроме встроенных модулей, инлайнится — пакет не тянет в профиль
// dsh ни одной копии @deepseek-ai/* (импорты оттуда только типовые).
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
