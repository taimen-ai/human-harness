/** Правая колонка окна: «Важное» и подробности выбранного элемента. */
import clsx from 'clsx'
import { ImportantList } from '../ImportantColumn.tsx'
import { shell, useShell, type SelectedItem } from '../state.ts'
import { TEXT } from '../text.ts'
import css from './frame.module.css'

export function ContextSections({ item, onOpenAssistant }: { item: SelectedItem, onOpenAssistant: () => void }) {
  return (
    <>
      <div className={css.section}>
        <div className={css.eyebrow} style={{ padding: 0, border: 0 }}><span style={{ color: 'var(--hh-ink-300)' }}>01</span>{TEXT.context.state}</div>
        {item.rows.map(r => (
          <div key={r.k} className={clsx(css.kv, r.tone === 'warn' && css.kvWarn, r.tone === 'error' && css.kvError, r.tone === 'ok' && css.kvOk)}>
            <span>{r.k}</span><span>{r.v}</span>
          </div>
        ))}
      </div>
      <div className={css.section}>
        <div className={css.eyebrow} style={{ padding: 0, border: 0 }}><span style={{ color: 'var(--hh-ink-300)' }}>02</span>{TEXT.context.policy}</div>
        <div className={css.muted}>{TEXT.context.policyText}</div>
      </div>
      <div className={css.section}>
        <div className={css.eyebrow} style={{ padding: 0, border: 0 }}><span style={{ color: 'var(--hh-ink-300)' }}>03</span>{TEXT.context.evidence}</div>
        <div className={css.muted}>{TEXT.context.evidenceText}</div>
      </div>
      <div className={css.actions}>
        {item.primaryLabel && (
          <button type="button" className={css.btn} disabled={item.onPrimary === undefined} title={item.onPrimary ? undefined : TEXT.context.viaAssistant} onClick={item.onPrimary}>{item.primaryLabel}</button>
        )}
        {item.secondaryLabel && (
          <button type="button" className={css.btnSecondary} disabled={item.onSecondary === undefined} title={item.onSecondary ? undefined : TEXT.context.viaAssistant} onClick={item.onSecondary}>{item.secondaryLabel}</button>
        )}
        <button type="button" className={css.btnSecondary} onClick={onOpenAssistant}>{TEXT.context.askAssistant(item.ref)}</button>
        {item.mechanics && <div className={css.mechanics}>{item.mechanics}</div>}
      </div>
    </>
  )
}

/** Правая колонка окна: «Важное», а поверх него — подробности выбранного элемента. */
export function RightColumn({ onOpenAssistant }: { onOpenAssistant: () => void }) {
  const selected = useShell(s => s.selected)
  if (selected) {
    return (
      <aside className={css.right} aria-label="Подробности">
        <div className={css.eyebrow}>
          {TEXT.nav.important} <span className={css.mono}>{selected.ref}</span>
          <button type="button" className={css.close} onClick={() => shell.closeInspector()}>{TEXT.context.close}</button>
        </div>
        <div className={css.selTitle}>{selected.title}</div>
        <ContextSections item={selected} onOpenAssistant={onOpenAssistant} />
      </aside>
    )
  }
  return (
    <aside className={css.right} aria-label={TEXT.nav.important}>
      <div className={css.eyebrow}>{TEXT.nav.important}</div>
      <div className={css.importantPad}><ImportantList /></div>
    </aside>
  )
}
