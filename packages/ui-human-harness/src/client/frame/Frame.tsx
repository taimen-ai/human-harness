/**
 * Корневой каркас Human Harness — одно окно (spec human-harness, FR-001, FR-002):
 * беседа с ассистентом (DSH, `main` key `conversation`) и рядом — «Важное».
 * Экранов, списка бесед и горячих клавиш навигации нет: на узком экране «Важное»
 * открывается вкладкой, подробности элемента — листом поверх.
 * Панель настроек DSH доступна через seat `sidebar.settings` в подвале rail.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { useResource, type WhoAmI, useChangeSignal } from '../api.ts'
import { ImportantList } from '../ImportantColumn.tsx'
import { IconArrowLeft, IconMessage, IconTarget, IconWifiOff } from '../Icons.tsx'
import { shell, useShell } from '../state.ts'
import { TEXT, time } from '../text.ts'
import css from './frame.module.css'
import { ActionDialog } from './Dialog.tsx'
import { RightColumn, ContextSections } from './RightColumn.tsx'
import { WorkspacePicker } from './WorkspacePicker.tsx'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RightbarState } from './layout.ts'
import { useLayout } from './useViewport.ts'

export interface FrameInjected {
  selectPanel(id: string | null): void
  openAssistant(): void
  /** Показана ли правая панель DSH — просмотр документа. */
  rightbar: HostObservable<RightbarState>
  hideRightbar(): void
}

export type FrameProps = PropsRuntime<'root'> & PropsRenderSlots<'main' | 'sidebar.settings' | 'shell.overlay' | 'rightbar'> & FrameInjected

/** Ширина панели документа на широком экране. */
const DOC_PANE_WIDTH = 560

type Tab = 'conversation' | 'important'

export function Frame({ renderSlot, openAssistant, rightbar, hideRightbar }: FrameProps) {
  const layout = useLayout()
  const doc = useSyncExternalStore(rightbar.subscribe.bind(rightbar), () => rightbar.getSnapshot(), () => rightbar.getSnapshot())
  const important = useShell(s => s.badges.important)
  const syncedAt = useShell(s => s.syncedAt)
  const offline = useShell(s => s.offline)
  const selected = useShell(s => s.selected)
  const inspectorOpen = useShell(s => s.inspectorOpen)
  const toast = useShell(s => s.toast)
  const who = useResource<WhoAmI>('whoami', 120_000)
  const [tab, setTab] = useState<Tab>('conversation')
  const isMobile = layout === 'mobile'
  const showRight = layout === 'desktop'

  // Окно одно: беседа ассистента открывается сразу, без выбора экрана.
  useEffect(() => { openAssistant() }, [openAssistant])
  // Событие ядра, касающееся человека, перечитывает «Важное» сразу.
  useChangeSignal()
  const conversationRequests = useShell(s => s.conversationRequests)
  useEffect(() => {
    if (conversationRequests === 0) return
    setTab('conversation')
    openAssistant()
  }, [conversationRequests, openAssistant])

  const appName = who.data?.appName ?? 'Human Harness'
  useEffect(() => {
    document.title = important > 0 ? `(${important}) ${appName}` : appName
    document.body.dataset.harnessShell = 'true'
    return () => { delete document.body.dataset.harnessShell }
  }, [important, appName])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') shell.closeInspector() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const tenant = who.data?.tenant.slug ?? 'tenant'
  const scopeName = who.data?.scope.slug ?? null
  const initials = who.data ? who.data.principal.displayName.split(/\s+/).map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase() : '··'
  const freshness = offline ? `офлайн · ${syncedAt ? time(syncedAt) : '—'}` : syncedAt ? TEXT.common.synced(syncedAt) : TEXT.common.loading
  const showImportantTab = !showRight && tab === 'important'

  const tabs = !showRight && (
    <div className={css.tabsBar} role="tablist">
      <button type="button" role="tab" aria-selected={tab === 'conversation'} className={clsx(css.tabBtn, tab === 'conversation' && css.tabActive)} onClick={() => setTab('conversation')}>
        <IconMessage size={16} />{TEXT.nav.assistant}
      </button>
      <button type="button" role="tab" aria-selected={tab === 'important'} className={clsx(css.tabBtn, tab === 'important' && css.tabActive)} onClick={() => setTab('important')}>
        <IconTarget size={16} />{TEXT.nav.important}
        {important > 0 && <span className={css.tabBadge}>{important}</span>}
      </button>
    </div>
  )

  return (
    <div className={css.root} data-harness-frame>
      {!isMobile && (
        <nav className={clsx(css.rail, css.railNarrow)} aria-label="Human Harness">
          <div className={css.logo}>hh_</div>
          <div className={css.railSpacer} />
          <div className={css.railFoot}>
            <div className={css.settingsSeat}>{renderSlot('sidebar.settings', { wide: false })}</div>
            <span className={css.avatar} title={who.data ? `${who.data.principal.displayName} · ${who.data.principal.kind}` : ''}>{initials}</span>
          </div>
        </nav>
      )}

      <main className={css.main}>
        <header className={isMobile ? css.mobileHeader : css.header}>
          <div className={isMobile ? css.mobileHeaderRow : css.headerRow}>
            <WorkspacePicker tenant={tenant} selectedName={scopeName} />
            {!isMobile && <span className={css.title}>{TEXT.nav.assistant}</span>}
            <span className={css.fresh}><span className={clsx(css.dot, offline ? css.dotWarn : css.dotOk)} />{freshness}</span>
            {isMobile && <span className={css.avatar} style={{ marginLeft: 'auto' }}>{initials}</span>}
          </div>
          {tabs}
        </header>
        {offline && (
          <div className={css.offline}><IconWifiOff size={14} /><span>{TEXT.common.offline}</span></div>
        )}
        <div className={css.scroll}>
          {showImportantTab && <div className={css.content}><ImportantList /></div>}
          {/* Беседа остаётся смонтированной и на вкладке «Важное»: ход ассистента не прерывается. */}
          <div className={clsx(css.content, css.contentChat)} style={showImportantTab ? { display: 'none' } : undefined}>
            <div className={css.chatHost}>
              <div className={css.chatMeta}>
                <span className={clsx(css.dot, css.dotOk)} />
                {TEXT.chat.meta(who.data?.session?.id ?? null, scopeName)}
              </div>
              <div className={css.chatBody}>{renderSlot('main', {}, { entryKey: 'conversation' })}</div>
            </div>
          </div>
        </div>
      </main>

      {showRight && !doc.shown && <RightColumn onOpenAssistant={() => { shell.closeInspector(); openAssistant() }} />}

      {/* Правая панель DSH смонтирована всегда (без места sidebar-right не откроет документ),
          видна — когда открыт документ: на широком экране вместо «Важного», на узком — поверх. */}
      <aside
        className={clsx(css.docPane, !showRight && css.docPaneOverlay, doc.fullscreen && css.docPaneFull)}
        style={doc.shown ? (showRight && !doc.fullscreen ? { width: DOC_PANE_WIDTH } : undefined) : { display: 'none' }}
        aria-label={TEXT.doc.title}
        aria-hidden={!doc.shown}
      >
        <div className={css.eyebrow}>
          {TEXT.doc.title}
          <button type="button" className={css.close} onClick={hideRightbar}>{showRight ? TEXT.doc.backToImportant : TEXT.doc.close}</button>
        </div>
        <div className={css.docBody}>
          {renderSlot('rightbar', { width: DOC_PANE_WIDTH, viewportWidth: typeof window === 'undefined' ? 1280 : window.innerWidth, canShow: true })}
        </div>
      </aside>

      {!showRight && selected && inspectorOpen && (
        <div className={css.sheetMask} onClick={() => shell.closeInspector()}>
          <div className={clsx(css.sheet, isMobile && css.sheetMobile)} onClick={(e) => e.stopPropagation()}>
            <div className={css.sheetBar}>
              <button type="button" className={css.back} onClick={() => shell.closeInspector()}><IconArrowLeft size={18} />{TEXT.context.back}</button>
              <span className={clsx(css.mono, css.crumb)} style={{ marginLeft: 'auto' }}>{selected.ref}</span>
            </div>
            <div className={css.selTitle}>{selected.title}</div>
            <ContextSections item={selected} onOpenAssistant={() => { shell.closeInspector(); setTab('conversation'); openAssistant() }} />
          </div>
        </div>
      )}

      <ActionDialog />
      {toast && <div className={css.toast}>{toast}</div>}
      <div className={css.overlayLayer}>{renderSlot('shell.overlay', {})}</div>
    </div>
  )
}
