/**
 * Node-половина браузерного плагина: строка Loader для `dsh.client`, раздача
 * шрифтов IBM Plex маршрутами `/api/harness/fonts/*` под cookie сессии DSH и
 * PWA-манифест харнесса вместо манифеста DeepSeek (имя приложения — конфиг установки, (браузер запрашивает манифест и
 * иконку без cookie, поэтому это именованные маршруты веб-сервера хоста).
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'harness-ui'

const FONTS = [
  'IBMPlexSans-Variable.ttf',
  'IBMPlexSans-Italic-Variable.ttf',
  'IBMPlexMono-Regular.ttf',
  'IBMPlexMono-Medium.ttf',
  'IBMPlexMono-SemiBold.ttf',
] as const


export interface Config {
  /** Имя приложения для человека (white-label): манифест, заголовок окна. */
  appName: string
}

export const Config: Schema<Config> = Schema.object({
  appName: Schema.string().default('Human Harness').description('Имя приложения, которое видит человек'),
})

/** PWA-манифест окна харнесса (spec human-harness, H006); имя — из конфигурации установки. */
export function manifest(appName: string) {
  return {
    name: appName,
    short_name: appName,
    description: 'Личный ассистент-исполнитель: беседа и «Важное» в одном окне',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#f5f3ee',
    theme_color: '#0f5b5f',
    lang: 'ru',
    icons: [{ src: 'app-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  } as const
}

/** Знак hh_ — нейтральный текстовый логотип харнесса. */
export const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#0f5b5f"/><text x="256" y="318" text-anchor="middle" font-family="IBM Plex Mono, ui-monospace, monospace" font-size="188" font-weight="600" fill="#f5f3ee">hh_</text></svg>`

export function apply(ctx: Context, config: Config): void {
  ctx.inject(['webServer'], (scoped) => {
    const serve = (path: string, type: string, body: string) => scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path,
      handler: (req, res) => {
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'content-length': String(Buffer.byteLength(body)) })
        res.end(req.method === 'HEAD' ? undefined : body)
      },
    }), `harness-ui: ${path}`)
    serve('/manifest.webmanifest', 'application/manifest+json; charset=utf-8', JSON.stringify(manifest(config.appName)))
    serve('/app-icon.svg', 'image/svg+xml; charset=utf-8', ICON)
  })

  const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts')
  ctx.inject(['connection'], (scoped) => {
    for (const file of FONTS) {
      scoped.effect(() => scoped.connection.fetch.register({
        path: `/api/harness/fonts/${file}`,
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const body = await readFile(join(assets, file))
            const headers = { 'content-type': 'font/ttf', 'cache-control': 'public, max-age=31536000, immutable', 'content-length': String(body.byteLength) }
            return request.method === 'HEAD' ? new Response(null, { headers }) : new Response(body, { headers })
          } catch {
            return new Response('not found', { status: 404 })
          }
        },
      }), `harness-ui: font ${file}`)
    }
  })
}
