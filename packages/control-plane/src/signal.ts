/**
 * Сигнал «Важное могло измениться» для окна: счётчик и long-poll. Окно держит
 * запрос `changes?after=<n>` и перечитывает `me/attention`, как только событие
 * ядра касается человека, — не дожидаясь своего периодического опроса.
 */
export class ChangeSignal {
  private seq = 0
  private waiters = new Set<(seq: number) => void>()

  get current(): number {
    return this.seq
  }

  bump(): void {
    this.seq += 1
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const wake of waiters) wake(this.seq)
  }

  /** Вернуть номер, как только он больше `after`, или текущий по таймауту. */
  wait(after: number, timeoutMs: number, signal?: AbortSignal): Promise<number> {
    if (this.seq > after || this.seq < after) return Promise.resolve(this.seq)
    return new Promise((resolve) => {
      const done = (seq: number): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.waiters.delete(done)
        resolve(seq)
      }
      const onAbort = (): void => done(this.seq)
      const timer = setTimeout(() => done(this.seq), timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.add(done)
    })
  }
}
