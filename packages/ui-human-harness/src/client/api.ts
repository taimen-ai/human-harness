/**
 * Данные панелей: `/api/harness/*` host-плагина (cookie браузерной сессии DSH,
 * PAT остаётся на хосте). Клиентское состояние — только presentation:
 * authoritative state перечитывается, а не патчится.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AttentionItem, AttentionList, WhoAmI } from '@human-harness/dsh-control-plane/shared'
import { shell, useShell } from './state.ts'

export type { AttentionItem, AttentionList, WhoAmI }

// Относительно <base href="./"> DSH: окно работает и под префиксом launcher'а.
const BASE = 'api/harness'

export interface ApiError {
  code: string
  message: string
  status: number
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${BASE}/${path}`, { credentials: 'same-origin', headers: { accept: 'application/json' }, signal: signal ?? null })
  const body = await response.json().catch(() => null) as { error?: { code?: string, message?: string } } | null
  if (!response.ok) {
    const error: ApiError = { code: body?.error?.code ?? `http_${response.status}`, message: body?.error?.message ?? response.statusText, status: response.status }
    throw error
  }
  return body as T
}

export async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${BASE}/${path}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
  const body = await response.json().catch(() => null) as { error?: { code?: string, message?: string } } | null
  if (!response.ok) {
    const error: ApiError = { code: body?.error?.code ?? `http_${response.status}`, message: body?.error?.message ?? response.statusText, status: response.status }
    throw error
  }
  return body as T
}

export interface Resource<T> {
  data: T | null
  error: ApiError | null
  loading: boolean
  fetchedAt: string | null
  refresh: () => void
}

/** Загрузка с опросом; событие realtime было бы только сигналом к перечитыванию. */
export function useResource<T>(path: string, pollMs = 30_000): Resource<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const revision = useShell(s => s.revision)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    setLoading(true)
    getJson<T>(path, controller.signal).then(
      (value) => {
        if (!alive.current) return
        const at = new Date().toISOString()
        setData(value); setError(null); setFetchedAt(at); setLoading(false)
        shell.synced(at, false)
      },
      (reason: unknown) => {
        if (!alive.current || controller.signal.aborted) return
        const apiError = isApiError(reason) ? reason : { code: 'network', message: String(reason), status: 0 }
        setError(apiError)
        setLoading(false)
        if (apiError.status === 0 || apiError.status === 503) shell.setOffline(true)
      },
    )
    const timer = pollMs > 0 ? window.setInterval(() => setTick(t => t + 1), pollMs) : undefined
    return () => { alive.current = false; controller.abort(); if (timer !== undefined) window.clearInterval(timer) }
  }, [path, tick, pollMs, revision])

  const refresh = useCallback(() => setTick(t => t + 1), [])
  return { data, error, loading, fetchedAt, refresh }
}

function isApiError(value: unknown): value is ApiError {
  return typeof value === 'object' && value !== null && 'code' in value && 'status' in value
}

/**
 * Сигнал хоста «Важное могло измениться» (long-poll `changes`): событие ядра,
 * касающееся человека, перечитывает панели сразу, не дожидаясь опроса.
 */
export function useChangeSignal(): void {
  useEffect(() => {
    const controller = new AbortController()
    let seq = -1
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const next = await getJson<{ seq: number }>(`changes?after=${Math.max(seq, 0)}`, controller.signal)
          if (seq >= 0 && next.seq !== seq) shell.bump()
          seq = next.seq
        } catch {
          if (controller.signal.aborted) return
          await new Promise(resolve => window.setTimeout(resolve, 5_000))
        }
      }
    })()
    return () => controller.abort()
  }, [])
}
