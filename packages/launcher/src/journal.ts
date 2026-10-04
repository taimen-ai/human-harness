/** Журнал launcher'а — одна JSON-строка на событие в stdout (plan human-harness, ст. VII). */
export type Journal = (event: string, fields?: Record<string, unknown>) => void

export function stdoutJournal(write: (line: string) => void = line => process.stdout.write(line)): Journal {
  return (event, fields = {}) => {
    write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`)
  }
}
