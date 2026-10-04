/** Per-principal read-state Human Work Surface: acknowledged cursor Updates (ADR-0024 §7, файл в $DSH_HOME/harness). */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface ReadState {
  acknowledgedCursor: string | null
  acknowledgedAt: string | null
  /** Выбранный workspace Control Plane (scope поверхности); null — весь tenant. */
  workspaceId?: string | null
}

export function defaultStatePath(environ: NodeJS.ProcessEnv = process.env): string {
  const home = environ.DSH_HOME && environ.DSH_HOME.trim() !== '' ? environ.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'harness', 'read-state.json')
}

export class ReadStateStore {
  private cache: Record<string, ReadState> | undefined

  constructor(private readonly path: string) {}

  get(principalId: string): ReadState {
    return this.load()[principalId] ?? { acknowledgedCursor: null, acknowledgedAt: null }
  }

  set(principalId: string, state: ReadState): void {
    const all = this.load()
    all[principalId] = state
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(all, null, 2), { mode: 0o600 })
    this.cache = all
  }

  private load(): Record<string, ReadState> {
    if (this.cache !== undefined) return this.cache
    try {
      this.cache = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, ReadState>
    } catch {
      this.cache = {}
    }
    return this.cache
  }
}
