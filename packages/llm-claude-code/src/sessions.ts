/**
 * Соответствие сессии DSH и сессии Claude Code: одна беседа DSH продолжается
 * одной сессией Claude (`resume`), контекст модели держит Claude Code, а журнал
 * DSH — отображение (TAI-ADR-0051, отступление ст. III). Файл в `$DSH_HOME/harness`
 * переживает перезапуск контейнера вместе с транскриптами Claude.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface SessionLink {
  /** Идентификатор сессии Claude Code для `resume`. */
  claudeSessionId: string
  updatedAt: string
}

export function defaultStateDir(environ: NodeJS.ProcessEnv = process.env): string {
  const home = environ.DSH_HOME && environ.DSH_HOME.trim() !== '' ? environ.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'harness')
}

/** Хранилище связей; запись атомарна (временный файл и rename). */
export class SessionLinks {
  private cache: Record<string, SessionLink> | undefined
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async get(dshSessionId: string): Promise<SessionLink | undefined> {
    return (await this.load())[dshSessionId]
  }

  async set(dshSessionId: string, claudeSessionId: string): Promise<void> {
    const all = await this.load()
    if (all[dshSessionId]?.claudeSessionId === claudeSessionId) return
    all[dshSessionId] = { claudeSessionId, updatedAt: new Date().toISOString() }
    await this.persist(all)
  }

  async forget(dshSessionId: string): Promise<void> {
    const all = await this.load()
    if (!(dshSessionId in all)) return
    delete all[dshSessionId]
    await this.persist(all)
  }

  private async load(): Promise<Record<string, SessionLink>> {
    if (this.cache === undefined) {
      try {
        this.cache = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, SessionLink>
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        this.cache = {}
      }
    }
    return this.cache
  }

  private persist(all: Record<string, SessionLink>): Promise<void> {
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const tmp = `${this.path}.${process.pid}.tmp`
      await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
      await rename(tmp, this.path)
    })
    return this.writing
  }
}
