/**
 * «Важное» — то, что сейчас ждёт человека, рядом с беседой (spec human-harness,
 * сценарий 2). Состав считает ядро (`GET /me/attention`, CP-ADR-0071): у каждого
 * элемента правило и причина. Элемент уходит, когда дело сделано в ядре, — список
 * перечитывается, а не патчится.
 */
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import type { AttentionItem, AttentionList } from '@human-harness/dsh-control-plane/shared'
import { postJson, useResource } from './api.ts'
import { IconClock } from './Icons.tsx'
import { shell, useShell, type PendingAction } from './state.ts'
import { due, time, TEXT } from './text.ts'
import css from './panels.module.css'

const T = TEXT.important

function isApproval(item: AttentionItem): boolean {
  return item.entity.type === 'approval'
}

function ref(item: AttentionItem): string {
  return item.taskPublicId ?? item.entity.id.slice(0, 8)
}

function reasonText(item: AttentionItem): string {
  return T.reasons[item.reasonCode] ?? item.reasonCode
}

/** Решение по approval — через диалог подтверждения (объект, эффект, механика, комментарий). */
export function decision(item: AttentionItem, approve: boolean): PendingAction {
  const review = item.kind === 'review'
  return {
    kind: approve ? 'approval.approve' : 'approval.reject',
    title: item.title,
    ref: ref(item),
    effect: review ? (approve ? T.acceptEffect : T.returnEffect) : (approve ? TEXT.dialog.approveEffect : TEXT.dialog.rejectEffect),
    mechanics: `POST /api/v1/approvals/${item.entity.id}:${approve ? 'approve' : 'reject'}`,
    reversible: false,
    commentRequired: !approve,
    payload: { approvalId: item.entity.id, decision: approve ? 'approve' : 'reject' },
  }
}

function openDetails(item: AttentionItem): void {
  const approval = isApproval(item)
  shell.select({
    kind: approval ? 'approval' : 'task',
    ref: ref(item),
    id: item.entity.id,
    title: item.title,
    rows: [
      { k: T.reason, v: reasonText(item), tone: item.reasonCode === 'overdue' || item.reasonCode === 'runs_failed' ? 'error' : 'warn' },
      ...(item.dueDate ? [{ k: T.due, v: due(item.dueDate), tone: (Date.parse(item.dueDate) < Date.now() ? 'error' : undefined) as 'error' | undefined }] : []),
      ...(item.since ? [{ k: T.since, v: `${due(item.since)} · ${time(item.since)}` }] : []),
      { k: T.rule, v: `${item.rule} · score ${item.score.toFixed(2)}` },
    ],
    mechanics: item.actions.filter(a => a.action !== 'feedback').map(a => `${a.method} ${a.href}`).join('\n'),
    primaryLabel: approval ? (item.kind === 'review' ? T.accept : T.approve) : undefined,
    secondaryLabel: approval ? (item.kind === 'review' ? T.returnBack : T.reject) : undefined,
    onPrimary: approval ? () => shell.ask(decision(item, true)) : undefined,
    onSecondary: approval ? () => shell.ask(decision(item, false)) : undefined,
  })
}

/** «Обсудить»: элемент становится репликой человека в единственной беседе, окно показывает её. */
async function discuss(item: AttentionItem): Promise<void> {
  try {
    await postJson('attention.discuss', { title: `${T.kinds[item.kind] ?? item.kind}: ${item.title} — ${reasonText(item)}`, ref: ref(item) })
    shell.closeInspector()
    shell.showConversation()
  } catch (error) {
    const e = error as { code?: string, message?: string }
    shell.toast(`${TEXT.common.error}: ${e.code ?? ''} ${e.message ?? String(error)}`)
  }
}

async function notNeeded(item: AttentionItem): Promise<void> {
  try {
    await postJson('attention.feedback', { itemKey: item.itemKey, verdict: 'not_needed' })
    shell.toast(T.notNeededDone)
    shell.bump()
  } catch (error) {
    const e = error as { code?: string, message?: string }
    shell.toast(`${TEXT.common.error}: ${e.code ?? ''} ${e.message ?? String(error)}`)
  }
}

export function ImportantCard({ item, selected }: { item: AttentionItem, selected: boolean }) {
  const approval = isApproval(item)
  const late = item.reasonCode === 'overdue' || item.reasonCode === 'runs_failed'
  const dismissed = item.feedback?.verdict === 'not_needed'
  return (
    <article className={clsx(css.card, selected && css.cardSelected)} tabIndex={0} onClick={() => openDetails(item)}
      onKeyDown={(e) => { if (e.key === 'Enter') openDetails(item) }} data-attention-kind={item.kind}>
      <div className={css.cardMeta}>
        <span className={clsx(css.tag, approval ? css.tagApproval : item.kind === 'review' ? css.tagReview : css.tagTask)}>{T.kinds[item.kind] ?? item.kind}</span>
        <span className={css.ref}>{ref(item)}</span>
        <span className={clsx(css.due, late && css.dueError, approval && css.dueWarn)}>
          <IconClock size={12} />{item.dueDate ? due(item.dueDate) : item.since ? due(item.since) : ''}
        </span>
      </div>
      <div className={css.cardTitle}>{item.title}</div>
      <div className={css.cardText}><b>{reasonText(item)}.</b></div>
      <div className={css.cardActions}>
        {approval && (
          <>
            <button type="button" className={css.btn} onClick={(e) => { e.stopPropagation(); shell.ask(decision(item, true)) }}>{item.kind === 'review' ? T.accept : T.approve}</button>
            <button type="button" className={css.btnSecondary} onClick={(e) => { e.stopPropagation(); shell.ask(decision(item, false)) }}>{item.kind === 'review' ? T.returnBack : T.reject}</button>
          </>
        )}
        <button type="button" className={css.btnLink} onClick={(e) => { e.stopPropagation(); openDetails(item) }}>{T.open}</button>
        <button type="button" className={css.btnLink} onClick={(e) => { e.stopPropagation(); void discuss(item) }}>{T.discuss}</button>
        {!dismissed && (
          <button type="button" className={css.linkFaint} onClick={(e) => { e.stopPropagation(); void notNeeded(item) }}>{T.notNeeded}</button>
        )}
      </div>
    </article>
  )
}

/** Список «Важного»; счётчик уходит в бейдж вкладки на узком экране. */
export function ImportantList() {
  const resource = useResource<AttentionList>('attention', 15_000)
  const selectedId = useShell(s => s.selected?.id ?? null)
  const [shown, setShown] = useState<AttentionItem[]>([])
  const data = resource.data
  useEffect(() => {
    if (!data) return
    // «Не нужно было показывать» убирает элемент из вида, но не из ядра.
    const visible = data.items.filter(i => i.feedback?.verdict !== 'not_needed')
    setShown(visible)
    shell.setBadges({ important: visible.length })
  }, [data])
  return (
    <div className={clsx(css.screen, css.screenTight)} data-important-list>
      <div className={css.summaryRow}>
        <span className={css.summary}>{data ? T.counter(shown.length) : TEXT.common.loading}</span>
        <span className={css.hintRight}>{T.hint}</span>
      </div>
      {resource.error && resource.error.status !== 0 && resource.error.status !== 503 && (
        <div className={css.error}>{TEXT.common.error}: {resource.error.code} · {resource.error.message}</div>
      )}
      {data && data.degraded.length > 0 && <div className={css.notice}>{T.degraded(data.degraded.map(d => d.rule))}</div>}
      {shown.map(item => <ImportantCard key={item.itemKey} item={item} selected={selectedId === item.entity.id} />)}
      {data && shown.length === 0 && <div className={css.emptyBox}>{T.empty}</div>}
    </div>
  )
}
