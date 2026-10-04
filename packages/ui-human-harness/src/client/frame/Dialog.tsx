/** Review dialog для действий с риском (макет): объект, эффект, механика, комментарий, подтверждение. */
import { useState } from 'react'
import clsx from 'clsx'
import { postJson } from '../api.ts'
import { shell, useShell } from '../state.ts'
import { TEXT } from '../text.ts'
import css from './frame.module.css'

export function ActionDialog() {
  const pending = useShell(s => s.pending)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!pending) return null
  const needComment = pending.commentRequired && comment.trim() === ''
  const close = () => { shell.ask(null); setComment(''); setError(null) }
  const confirm = async () => {
    setBusy(true); setError(null)
    try {
      const route = pending.kind === 'task.transition' ? 'tasks.transition' : 'approvals.decide'
      await postJson(route, { ...pending.payload, comment: comment.trim() || undefined })
      shell.toast(TEXT.dialog.done(pending.kind))
      shell.bump()
      shell.closeInspector()
      close()
    } catch (e) {
      const err = e as { code?: string, message?: string }
      setError(`${err.code ?? 'error'} · ${err.message ?? String(e)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={css.dialogMask} onClick={close}>
      <div className={css.dialog} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className={css.dialogHead}>
          <span className={clsx(css.tagMono, pending.kind.startsWith('approval') ? css.tagWarn : css.tagTeal)}>{pending.kind}</span>
          <span className={css.mono} style={{ color: 'var(--hh-ink-400)', fontSize: 11 }}>{pending.ref}</span>
        </div>
        <div className={css.dialogTitle}>{TEXT.dialog.title(pending.kind)}: {pending.title}</div>
        <div className={css.kv}><span>{TEXT.dialog.scope}</span><span>{pending.ref}</span></div>
        <div className={css.kv}><span>{TEXT.dialog.effect}</span><span>{pending.effect}</span></div>
        <div className={css.kv}><span>{TEXT.dialog.mechanics}</span><span>{pending.mechanics}</span></div>
        <div className={css.kv}><span>reversibility</span><span>{pending.reversible ? TEXT.dialog.reversible : TEXT.dialog.irreversible}</span></div>
        <label className={css.dialogField}>
          <span className={css.mono} style={{ fontSize: 11, color: 'var(--hh-ink-500)' }}>{TEXT.dialog.comment}{pending.commentRequired ? ` · ${TEXT.dialog.commentRequired}` : ''}</span>
          <textarea className={css.dialogInput} rows={3} value={comment} onChange={(e) => setComment(e.target.value)} autoFocus />
        </label>
        {error && <div className={css.dialogError}>{error}</div>}
        <div className={css.actions} style={{ flexDirection: 'row', padding: 0 }}>
          <button type="button" className={css.btn} disabled={busy || needComment} onClick={() => { void confirm() }}>{busy ? TEXT.dialog.busy : TEXT.dialog.confirm}</button>
          <button type="button" className={css.btnSecondary} disabled={busy} onClick={close}>{TEXT.dialog.cancel}</button>
        </div>
      </div>
    </div>
  )
}
