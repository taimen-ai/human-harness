/**
 * Локальное хранилище Platform Access Token — read-only зеркало контракта IAM
 * (ADR-0012 control-plane): файл `~/.config/iam/credentials.json` (0600),
 * ключ записи — `issuer|tenant` либо `issuer|tenant|principal`.
 * Переменная окружения `IAM_PLATFORM_ACCESS_TOKEN` принимается только вместе с
 * `IAM_CREDENTIAL_MODE=environment` — унаследованная переменная не должна молча
 * подменять учётку.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { IdentityError } from './errors.ts'

export const ENV_PAT = 'IAM_PLATFORM_ACCESS_TOKEN'
export const ENV_MODE = 'IAM_CREDENTIAL_MODE'
export const ENV_PRINCIPAL = 'IAM_PRINCIPAL'

export interface PatStoreOptions {
  readonly issuer: string
  readonly tenantId: string
  /** IAM principal, если процесс объявляет, кем он является. */
  readonly principalId?: string | undefined
  /** Явный путь к файлу; иначе `$XDG_CONFIG_HOME/iam/credentials.json`. */
  readonly credentialsFile?: string | undefined
  readonly environ?: NodeJS.ProcessEnv
  readonly readFile?: (path: string) => string
}

/** Путь файла с учётными данными по умолчанию. */
export function defaultCredentialsPath(environ: NodeJS.ProcessEnv = process.env): string {
  const base = environ.XDG_CONFIG_HOME && environ.XDG_CONFIG_HOME.trim() !== ''
    ? environ.XDG_CONFIG_HOME
    : join(homedir(), '.config')
  return join(base, 'iam', 'credentials.json')
}

interface CredentialRecord {
  readonly token?: unknown
  readonly principalId?: unknown
}

/**
 * Разрешить PAT для пары issuer|tenant (и principal, если задан).
 * @returns непустой Platform Access Token.
 * @throws {IdentityError} когда токена нет, он неоднозначен или задан не по правилам.
 */
export function resolvePlatformAccessToken(options: PatStoreOptions): string {
  const environ = options.environ ?? process.env
  const fromEnv = (environ[ENV_PAT] ?? '').trim()
  if (fromEnv !== '') {
    if ((environ[ENV_MODE] ?? '').trim() !== 'environment') {
      throw new IdentityError(
        'iam_environment_mode_required',
        `${ENV_PAT} задан, но ${ENV_MODE}=environment — нет; переменная не подменяет учётку без явного режима`,
      )
    }
    return fromEnv
  }

  const path = options.credentialsFile ?? defaultCredentialsPath(environ)
  const read = options.readFile ?? ((p: string) => readFileSync(p, 'utf8'))
  let document: Record<string, CredentialRecord>
  try {
    document = JSON.parse(read(path)) as Record<string, CredentialRecord>
  } catch (error) {
    throw new IdentityError(
      'iam_not_authenticated',
      `нет файла учётных данных IAM ${path}: выполните \`iam auth login\` или положите PAT`,
      { cause: error },
    )
  }
  if (document === null || typeof document !== 'object') {
    throw new IdentityError('iam_not_authenticated', `файл ${path} не является объектом JSON`)
  }

  const issuer = options.issuer.replace(/\/+$/, '')
  const prefix = `${issuer}|${options.tenantId}`
  const principal = (options.principalId ?? environ[ENV_PRINCIPAL] ?? '').trim()

  if (principal !== '') {
    const exact = document[`${prefix}|${principal}`]
    const token = tokenOf(exact)
    if (token !== undefined) return token
    // Запись без principal — допустима, если она единственная для tenant'а.
  }

  const candidates = Object.entries(document)
    .filter(([key]) => key === prefix || key.startsWith(`${prefix}|`))
    .map(([key, record]) => ({ key, token: tokenOf(record), principalId: principalOf(key, record) }))
    .filter((c): c is { key: string, token: string, principalId: string } => c.token !== undefined)

  if (candidates.length === 0) {
    throw new IdentityError(
      'iam_not_authenticated',
      `в ${path} нет записи для ${prefix}${principal ? ` (principal ${principal})` : ''}`,
    )
  }
  if (candidates.length > 1) {
    if (principal === '') {
      throw new IdentityError(
        'iam_credential_ambiguous',
        `в ${path} несколько записей для ${prefix} — объявите ${ENV_PRINCIPAL} или principalId в конфигурации`,
      )
    }
    throw new IdentityError(
      'iam_credential_ambiguous',
      `в ${path} несколько записей для ${prefix}, и ни одна не принадлежит principal ${principal}`,
    )
  }
  return candidates[0]!.token
}

function tokenOf(record: CredentialRecord | undefined): string | undefined {
  if (record === undefined || record === null || typeof record !== 'object') return undefined
  const token = typeof record.token === 'string' ? record.token.trim() : ''
  return token === '' ? undefined : token
}

function principalOf(key: string, record: CredentialRecord): string {
  const fromRecord = typeof record.principalId === 'string' ? record.principalId : ''
  if (fromRecord !== '') return fromRecord
  const parts = key.split('|')
  return parts.length >= 3 ? parts.slice(2).join('|') : ''
}
