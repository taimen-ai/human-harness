/**
 * Layout-служба Human Harness — замена `ui-layout` DSH (строка отключена в
 * bundle): тот же контракт `ctx.layout` (selectPanel / beginNavigation /
 * toggleSidebar / openRightbar / closeRightbar), тот же root-hook `panelInfo`
 * (`usePanelInfo`) и презентер темы, проецирующий снимок `ctx.theme` на
 * документ. Геометрии колонок DSH здесь нет: rail фиксирован макетом, toggleSidebar —
 * учтённый no-op. Правая панель DSH (просмотр документов, `rightbar`) показывается в
 * правой колонке вместо «Важного», когда её открывает sidebar-right.
 */
import type { ILayout, MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'

export class PanelInfoSource implements HostObservable<PanelInfo> {
  private snapshot: PanelInfo = { activePanelId: null }
  private readonly listeners = new Set<() => void>()

  getSnapshot(): PanelInfo { return this.snapshot }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(activePanelId: MainPanelId | null): void {
    if (this.snapshot.activePanelId === activePanelId) return
    this.snapshot = { activePanelId }
    for (const listener of this.listeners) listener()
  }
}

export interface RightbarState {
  shown: boolean
  fullscreen: boolean
}

/** Показана ли правая панель DSH (просмотр документа); её открывает и закрывает sidebar-right. */
export class RightbarSource implements HostObservable<RightbarState> {
  private snapshot: RightbarState = { shown: false, fullscreen: false }
  private readonly listeners = new Set<() => void>()

  getSnapshot(): RightbarState { return this.snapshot }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(next: RightbarState): void {
    if (this.snapshot.shown === next.shown && this.snapshot.fullscreen === next.fullscreen) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

/** Сколько после загрузки окна вызовы openRightbar считаются восстановлением вкладок DSH. */
export const RESTORE_WINDOW_MS = 3000

export class HarnessLayout implements ILayout {
  private navigation = new AbortController()
  private readonly createdAt = Date.now()
  private touched = false

  /** Выбранная центральная панель — тот же источник, что root-hook `panelInfo` (ILayout DSH 0.1.7). */
  readonly panelInfo: HostObservable<PanelInfo>

  /** Никто ещё не выбирал панель — можно поставить стартовый экран. */
  isInitial(): boolean { return !this.touched }

  constructor(
    private readonly panels: PanelInfoSource,
    private readonly hasMainPanel: (id: MainPanelId) => boolean,
    /** Активна ли вкладка документа в правой панели DSH (а не «Start», терминал, файлы). */
    private readonly documentActive: () => boolean = () => true,
    /** Свернуть правую панель DSH: следующее открытие документа снова вызовет openRightbar. */
    private readonly collapseRightbar: () => void = () => undefined,
  ) {
    this.panelInfo = panels
  }

  selectPanel(panelId: MainPanelId | null): void {
    if (panelId !== null && !this.hasMainPanel(panelId)) {
      throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
    }
    this.navigation.abort()
    this.touched = true
    this.panels.set(panelId)
  }

  beginNavigation(): AbortSignal {
    this.navigation.abort()
    this.navigation = new AbortController()
    return this.navigation.signal
  }

  /** У каркаса Human Harness нет сворачиваемого sidebar — rail фиксирован макетом. */
  toggleSidebar(): void {}

  /** Правая панель DSH (просмотр документа) — в правой колонке каркаса вместо «Важного». */
  readonly rightbar = new RightbarSource()

  openRightbar(_track: boolean, fullscreen: boolean): void {
    // sidebar-right восстанавливает свою вкладку при загрузке и открывает панель сам;
    // каркас показывает её только для документа. Вкладка переключается раньше вызова
    // не всегда — проверяем после текущего кадра.
    // Сразу после загрузки DSH восстанавливает прошлую вкладку — это не просьба человека
    // открыть документ, и на телефоне она закрыла бы беседу.
    const restoring = Date.now() - this.createdAt < RESTORE_WINDOW_MS
    setTimeout(() => {
      if (!restoring && this.documentActive()) this.rightbar.set({ shown: true, fullscreen })
      else this.collapseRightbar()
    }, 0)
  }

  closeRightbar(): void {
    this.rightbar.set({ shown: false, fullscreen: false })
  }

  /** Кнопка каркаса «скрыть документ»: спрятать и свернуть, чтобы следующий файл открылся снова. */
  hideDocument(): void {
    this.closeRightbar()
    this.collapseRightbar()
  }

  /** Снять активную панель, если её регистрация исчезла. */
  retain(panelIds: readonly string[]): void {
    const active = this.panels.getSnapshot().activePanelId
    if (active !== null && !panelIds.includes(active)) this.panels.set(null)
  }

  dispose(): void { this.navigation.abort() }
}

/** Презентер темы (порт `ui-layout/theme-presenter`): чистые записи в DOM из снимка темы. */
export class ThemePresenter {
  private appliedTokens: string[] = []
  private readonly meta: HTMLMetaElement

  constructor() {
    this.meta = document.createElement('meta')
    this.meta.name = 'theme-color'
  }

  apply(snapshot: ThemeSnapshot): void {
    const scheme = snapshot.active.colorScheme
    document.documentElement.style.colorScheme = scheme
    const body = document.body
    if (scheme === 'dark') body.setAttribute('data-ds-dark-theme', '')
    else body.removeAttribute('data-ds-dark-theme')
    body.style.setProperty('--dsh-content-font-size', `${snapshot.fontSize}px`)
    for (const name of this.appliedTokens) body.style.removeProperty(name)
    this.appliedTokens = []
    for (const [name, value] of Object.entries(snapshot.active.tokens)) {
      body.style.setProperty(name, value)
      this.appliedTokens.push(name)
    }
    this.meta.content = getComputedStyle(body).backgroundColor
    if (!this.meta.isConnected) document.head.append(this.meta)
  }

  dispose(): void {
    document.documentElement.style.removeProperty('color-scheme')
    document.body.removeAttribute('data-ds-dark-theme')
    document.body.style.removeProperty('--dsh-content-font-size')
    for (const name of this.appliedTokens) document.body.style.removeProperty(name)
    this.appliedTokens = []
    this.meta.remove()
  }
}
