/** Выбор workspace Control Plane в шапке: `tenant / workspace ▾` — scope Focus/Work/Updates/Search и умолчание ассистента. */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { WorkspacesProjection } from '@human-harness/dsh-control-plane/shared'
import { postJson, useResource } from '../api.ts'
import { IconCheck } from '../Icons.tsx'
import { shell } from '../state.ts'
import { TEXT } from '../text.ts'
import css from './frame.module.css'

export function WorkspacePicker({ tenant, selectedName }: { tenant: string, selectedName: string | null }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const workspaces = useResource<WorkspacesProjection>('workspaces', 120_000)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown); window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])
  const select = async (id: string | null) => {
    setBusy(true)
    try {
      await postJson('workspace.select', { workspaceId: id })
      shell.closeInspector()
      shell.bump()
      setOpen(false)
    } catch (e) {
      shell.toast(`${TEXT.common.error}: ${(e as { message?: string }).message ?? String(e)}`)
    } finally {
      setBusy(false)
    }
  }
  const items = workspaces.data?.items ?? []
  const selectedId = workspaces.data?.selectedId ?? null
  return (
    <div className={css.picker} ref={ref}>
      <button type="button" className={css.pickerBtn} onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open} title={TEXT.workspace.title}>
        <span className={css.crumb}>{tenant} /</span>
        <span className={css.pickerName}>{selectedName ?? TEXT.workspace.all}</span>
        <span className={css.pickerChevron} aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className={css.pickerMenu} role="listbox">
          <div className={css.pickerHead}>{TEXT.workspace.title}<span className={css.pickerHint}>{TEXT.workspace.hint}</span></div>
          <button type="button" role="option" aria-selected={selectedId === null} className={clsx(css.pickerItem, selectedId === null && css.pickerActive)} disabled={busy} onClick={() => { void select(null) }}>
            <span className={css.pickerItemName}>{TEXT.workspace.all}</span>
            <span className={css.pickerSlug}>tenant</span>
            {selectedId === null && <IconCheck size={12} />}
          </button>
          {items.map(w => (
            <button key={w.id} type="button" role="option" aria-selected={selectedId === w.id} className={clsx(css.pickerItem, selectedId === w.id && css.pickerActive)} style={{ paddingLeft: 12 + w.depth * 14 }} disabled={busy} onClick={() => { void select(w.id) }}>
              <span className={css.pickerItemName}>{w.name}</span>
              <span className={css.pickerSlug}>{w.slug}{w.hasProject ? ' · project' : ''}</span>
              {selectedId === w.id && <IconCheck size={12} />}
            </button>
          ))}
          {workspaces.data?.degraded.map(d => <div key={d} className={css.pickerHint} style={{ padding: '6px 12px' }}>degraded · {d}</div>)}
          {workspaces.error && <div className={css.pickerHint} style={{ padding: '6px 12px' }}>{TEXT.common.error}: {workspaces.error.code}</div>}
        </div>
      )}
    </div>
  )
}
