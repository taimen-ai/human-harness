/**
 * Состояние оболочки, общее для каркаса и панелей (один бандл — одна
 * идентичность модуля): выбранный объект для Context, свежесть последней
 * синхронизации, тост. Только presentation-state; authoritative состояние
 * всегда перечитывается с хоста.
 */
import { useSyncExternalStore } from 'react'

export interface SelectedItem {
  kind: 'task' | 'approval' | 'run' | 'event'
  ref: string
  id: string
  title: string
  rows: { k: string, v: string, tone?: 'warn' | 'error' | 'ok' | 'muted' | undefined }[]
  mechanics?: string | undefined
  primaryLabel?: string | undefined
  secondaryLabel?: string | undefined
  risk?: boolean | undefined
  onPrimary?: (() => void) | undefined
  onSecondary?: (() => void) | undefined
}

/** Диалог подтверждения действия с риском: scope, эффект, механика, комментарий. */
export interface PendingAction {
  kind: 'approval.approve' | 'approval.reject' | 'task.transition'
  title: string
  ref: string
  effect: string
  mechanics: string
  reversible: boolean
  commentRequired: boolean
  payload: Record<string, unknown>
}

export interface ShellState {
  selected: SelectedItem | null
  /** Ожидающее подтверждения действие (review dialog). */
  pending: PendingAction | null
  /** Счётчик перечитывания authoritative-состояния после мутации. */
  revision: number
  /** Показывать ли Context поверх (планшет/мобайл). */
  inspectorOpen: boolean
  syncedAt: string | null
  offline: boolean
  toast: string | null
  /** Счётчики для бейджей rail. */
  badges: { important: number }
  /** Счётчик просьб показать беседу (например, после «Обсудить» у элемента «Важного»). */
  conversationRequests: number
}

let state: ShellState = { selected: null, pending: null, revision: 0, inspectorOpen: false, syncedAt: null, offline: false, toast: null, badges: { important: 0 }, conversationRequests: 0 }
const listeners = new Set<() => void>()
let toastTimer: number | undefined

function publish(next: Partial<ShellState>): void {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

export const shell = {
  get: () => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  select(item: SelectedItem | null, open = true): void { publish({ selected: item, inspectorOpen: item !== null && open }) },
  closeInspector(): void { publish({ selected: null, inspectorOpen: false }) },
  ask(action: PendingAction | null): void { publish({ pending: action }) },
  /** После мутации: перечитать проекции, а не патчить состояние. */
  bump(): void { publish({ revision: state.revision + 1 }) },
  /** Показать беседу: каркас переключает вкладку и открывает сессию ассистента. */
  showConversation(): void { publish({ conversationRequests: state.conversationRequests + 1 }) },
  synced(at: string, offline = false): void { publish({ syncedAt: at, offline }) },
  setOffline(offline: boolean): void { if (state.offline !== offline) publish({ offline }) },
  setBadges(badges: Partial<ShellState['badges']>): void { publish({ badges: { ...state.badges, ...badges } }) },
  toast(text: string, holdMs = 3200): void {
    publish({ toast: text })
    if (toastTimer !== undefined) window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => publish({ toast: null }), holdMs)
  },
}

export function useShell<T>(selector: (s: ShellState) => T): T {
  return useSyncExternalStore(shell.subscribe, () => selector(state), () => selector(state))
}
