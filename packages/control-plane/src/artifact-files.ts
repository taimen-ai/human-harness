/**
 * Документ ядра — файлом в рабочем каталоге беседы (H015): содержимое артефакта
 * (`GET /artifacts/{id}/content`, CP-ADR-0072) скачивается в `.artifacts/`, и ассистент
 * даёт на него ссылку — её открывает тот же просмотр документов DSH, что и любой файл.
 * Активное содержимое (HTML, SVG, XML, JS) сохраняется с суффиксом `.txt`: в окне оно
 * показывается текстом и не исполняется.
 */
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ControlPlaneClient } from './client.ts'
import type { ArtifactOut } from './shared/index.ts'

export const ARTIFACTS_DIR = '.artifacts'
const MAX_BYTES = 100 * 1024 * 1024

export function isActiveContent(mediaType: string): boolean {
  const base = mediaType.split(';', 1)[0]!.trim().toLowerCase()
  return ['text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/javascript', 'application/javascript', 'text/xml', 'application/xml'].includes(base)
    || base.endsWith('+xml')
}

/** Имя из Content-Disposition (filename* или filename) либо id. */
export function fileNameOf(disposition: string | null, fallback: string): string {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? '')?.[1]
  const plain = /filename="?([^";]+)"?/i.exec(disposition ?? '')?.[1]
  let name = fallback
  try {
    name = star ? decodeURIComponent(star) : plain ?? fallback
  } catch {
    name = fallback
  }
  // Только имя файла: без каталогов и управляющих символов.
  const safe = name.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f]/g, '').replace(/^\.+/, '').trim().slice(0, 150)
  return safe === '' ? fallback : safe
}

export interface FetchedArtifact {
  /** Путь относительно рабочего каталога беседы — для ссылки в ответе. */
  path: string
  mediaType: string
  bytes: number
  shownAsText: boolean
  /** У артефакта нет файла в хранилище: это его запись (JSON) или ссылка. */
  record?: { content: Record<string, unknown> | null, uri: string | null }
}

/** Артефакт в ответах инструментов: id нужен, чтобы открыть его cp_fetch_artifact. */
export interface ArtifactRef {
  id: string
  type: string
  name: string
  uri: string | null
  /** stored — есть файл в хранилище; none — только запись (JSON или ссылка); purged — файл удалён. */
  contentState: string
  mediaType: string | null
  sizeBytes: number | null
  createdAt: string
}

export function artifactRef(a: ArtifactOut): ArtifactRef {
  return {
    id: a.id,
    type: a.type,
    name: a.name,
    uri: a.uri ?? null,
    contentState: a.contentState ?? 'none',
    mediaType: a.mediaType ?? null,
    sizeBytes: a.sizeBytes ?? null,
    createdAt: a.createdAt,
  }
}

const INLINE_JSON_CHARS = 20_000

export async function fetchArtifact(client: ControlPlaneClient, workspacePath: string, artifactId: string, signal?: AbortSignal): Promise<FetchedArtifact> {
  if (!/^[0-9a-f-]{36}$/i.test(artifactId)) throw new Error('artifactId — uuid артефакта')
  const artifact = await client.getArtifact(artifactId, signal)
  if (artifact.contentState !== 'stored') return saveRecord(workspacePath, artifact)
  const response = await client.artifactContent(artifactId, signal)
  const mediaType = response.headers.get('content-type') ?? 'application/octet-stream'
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_BYTES) throw new Error(`артефакт больше ${MAX_BYTES / 1024 / 1024} МБ`)
  const data = new Uint8Array(await response.arrayBuffer())
  if (data.byteLength > MAX_BYTES) throw new Error(`артефакт больше ${MAX_BYTES / 1024 / 1024} МБ`)
  const active = isActiveContent(mediaType)
  const name = fileNameOf(response.headers.get('content-disposition'), artifactId) + (active ? '.txt' : '')
  const dir = join(ARTIFACTS_DIR, artifactId.slice(0, 8))
  mkdirSync(join(workspacePath, dir), { recursive: true, mode: 0o700 })
  const path = join(dir, name)
  writeFileSync(join(workspacePath, path), data, { mode: 0o600 })
  return { path, mediaType, bytes: data.byteLength, shownAsText: active }
}

/**
 * Артефакт без файла (сводка раннера, результат скилла, ссылка): его запись — JSON
 * `content` — сохраняется файлом `.json`, чтобы открыть её в окне, и отдаётся
 * ассистенту в ответе. Ссылку `uri` ассистент показывает как есть.
 */
function saveRecord(workspacePath: string, artifact: ArtifactOut): FetchedArtifact {
  const record = { content: (artifact.content as Record<string, unknown> | null) ?? null, uri: artifact.uri ?? null }
  if (record.content === null) {
    if (record.uri === null) throw new Error(artifact.contentState === 'purged' ? 'содержимое артефакта удалено администратором' : 'у артефакта нет ни файла, ни записи')
    return { path: '', mediaType: 'text/uri-list', bytes: 0, shownAsText: false, record }
  }
  const text = JSON.stringify(record.content, null, 2)
  const dir = join(ARTIFACTS_DIR, artifact.id.slice(0, 8))
  mkdirSync(join(workspacePath, dir), { recursive: true, mode: 0o700 })
  const path = join(dir, `${fileNameOf(null, artifact.type).replace(/\.json$/i, '')}.json`)
  writeFileSync(join(workspacePath, path), text, { mode: 0o600 })
  const inline = text.length > INLINE_JSON_CHARS ? null : record.content
  return { path, mediaType: 'application/json', bytes: Buffer.byteLength(text), shownAsText: false, record: { content: inline, uri: record.uri } }
}

/** Тип содержимого по расширению: ядро хранит его и отдаёт при чтении. */
const MEDIA_TYPES: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
}

export function mediaTypeOf(path: string): string {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export interface WorkspaceFile {
  name: string
  mediaType: string
  data: Uint8Array
}

/**
 * Прочитать файл для сдачи: только внутри рабочего каталога беседы (после разрешения
 * ссылок), только обычный файл и не больше предела хранилища ядра.
 */
export function readWorkspaceFile(workspacePath: string, path: string): WorkspaceFile {
  const root = realpathSync(workspacePath)
  const target = realpathSync(isAbsolute(path) ? path : resolve(root, path))
  const inside = relative(root, target)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`файл ${path} вне рабочего каталога беседы — сдавать можно только файлы из него`)
  }
  const stat = statSync(target)
  if (!stat.isFile()) throw new Error(`${path} — не файл`)
  if (stat.size > MAX_BYTES) throw new Error(`файл больше ${MAX_BYTES / 1024 / 1024} МБ`)
  return { name: inside.split(/[\\/]/).pop() ?? inside, mediaType: mediaTypeOf(target), data: new Uint8Array(readFileSync(target)) }
}
