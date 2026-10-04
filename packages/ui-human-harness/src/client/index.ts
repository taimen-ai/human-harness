/**
 * Браузерная половина Human Harness: тема харнесса поверх alias-токенов DSH,
 * собственный каркас в слоте `root` вместо AppFrame (строка `ui-layout`
 * отключена в bundle, служба `ctx.layout` и hook `panelInfo` предоставляются
 * здесь). Окно одно: беседа DSH (`main` key `conversation`) и «Важное» рядом
 * (spec human-harness, FR-001, FR-002).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { HeroMark } from './frame/HeroMark.tsx'
import type { WhoAmI } from './api.ts'
import './global.css'
import { registerDocumentRenderers } from './documents.tsx'
import { Frame } from './frame/Frame.tsx'
import { HarnessLayout, PanelInfoSource, ThemePresenter } from './frame/layout.ts'
import { HARNESS_THEME_ID, HARNESS_TOKENS } from './theme.ts'

/** `sessions` и `uiWorkspace` берутся лениво: ui-workspace сам ждёт `layout`, который предоставляем мы. */
export const inject = ['slots', 'theme']

export function apply(ctx: ClientContext): void {
  // Тема харнесса: alias-токены → paper / ink / river teal / salmon. Сторонний id не
  // сохраняется в настройках DSH, поэтому выбирается при каждой загрузке клиента.
  ctx.effect(() => ctx.theme.register({ id: HARNESS_THEME_ID, colorScheme: 'light', tokens: HARNESS_TOKENS }), 'human-harness: theme')
  // Сторонний id не сохраняется в настройках DSH: адаптация durable-настройки
  // (`adopt`) возвращает preference к light/dark/system. Держим выбор темы харнесса,
  // пока каркас смонтирован; макет — только светлый.
  const assertTheme = (): void => {
    if ((ctx.theme.getTheme().preference as string) === HARNESS_THEME_ID) return
    try { ctx.theme.setTheme(HARNESS_THEME_ID) } catch (error) { ctx.logger.warn(`human-harness: тема харнесса не выбрана: ${String(error)}`) }
  }
  assertTheme()
  ctx.on('theme/change', (snapshot) => { if ((snapshot.preference as string) !== HARNESS_THEME_ID) queueMicrotask(assertTheme) })
  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => { presenter.apply(snapshot) })
    return () => { off(); presenter.dispose() }
  }, 'human-harness: theme presenter')

  // DOCX/XLSX/CSV в штатном просмотре документов DSH (правая панель, H015).
  registerDocumentRenderers(ctx as unknown as Parameters<typeof registerDocumentRenderers>[0])

  const panelInfo = new PanelInfoSource()
  // Правая панель DSH показывается только для вкладки документа (kind `text` у
  // documentpreview); «Start», файлы и терминал каркас не показывает и сворачивает.
  type SidebarRightLike = { active(): { kind?: string } | undefined, isExpanded(): boolean, toggleExpanded(): void }
  const sidebarRight = (): SidebarRightLike | undefined => ctx.get('sidebarRight' as never) as SidebarRightLike | undefined
  const layout = new HarnessLayout(
    panelInfo,
    id => ctx.slots.entries('main').some(entry => entry.options.key === id),
    () => sidebarRight()?.active()?.kind === 'text',
    () => { const right = sidebarRight(); if (right?.isExpanded()) right.toggleExpanded() },
  )
  const selectPanel = (id: string | null): void => { layout.selectPanel(id as MainPanelId | null) }
  // Беседа ассистента живёт в одном workspace DSH — каталоге, который host-плагин
  // создаёт рядом с read-state. Без него DSH показывает выбор директории.
  let assistantWorkspacePath: string | null | undefined
  const assistantWorkspace = async (): Promise<string | null> => {
    if (assistantWorkspacePath === undefined) {
      const response = await fetch('api/harness/whoami', { credentials: 'same-origin' }).catch(() => null)
      const who = response && response.ok ? await response.json() as WhoAmI : null
      assistantWorkspacePath = who?.assistantWorkspacePath ?? null
    }
    return assistantWorkspacePath
  }
  let opening = false
  // Беседа одна (spec human-harness, FR-001): её id знает хост (`/api/harness/conversation` —
  // та сессия, куда харнесс вписывает события), окно открывает именно её. DSH 0.1.7 держит
  // выбор текущей сессии в навигации UI и наружу его не отдаёт, поэтому факт открытия
  // запоминаем сами.
  let assistantOpened = false
  const openAssistant = (): void => {
    layout.selectPanel(null)
    const uiWorkspace = ctx.get('uiWorkspace')
    const workspaces = ctx.get('workspaces')
    if (assistantOpened || opening) return
    if (uiWorkspace === undefined || workspaces === undefined) return
    opening = true
    void (async () => {
      const response = await fetch('api/harness/conversation', { credentials: 'same-origin' }).catch(() => null)
      const conversation = response && response.ok ? await response.json() as { sessionId?: string } : null
      const sessions = ctx.get('sessions')
      if (conversation?.sessionId && sessions !== undefined) {
        const id = conversation.sessionId as Parameters<typeof uiWorkspace.openSession>[0]
        // Открыть можно только сессию, которую клиент уже знает; начальное восстановление
        // выбора в DSH (черновик прошлого визита) может закончиться позже и перебить нас —
        // первые 15 с держим беседу хоста в главном виде.
        const info = sessions.retainInfo(id as Parameters<typeof sessions.retainInfo>[0])
        let timer: number | undefined
        const ensure = (): void => {
          if (sessions.list.getSnapshot().byId[id as keyof ReturnType<typeof sessions.list.getSnapshot>['byId']] === undefined) return
          if ((info.getSnapshot().retainedBy.mainView ?? 0) > 0) return
          try {
            uiWorkspace.openSession(id)
          } catch (error) {
            ctx.logger.warn(`human-harness: беседа ${String(id)} не открылась: ${String(error)}`)
          }
        }
        const later = (): void => { window.clearTimeout(timer); timer = window.setTimeout(ensure, 300) }
        const stopList = sessions.list.subscribe(later)
        const stopInfo = info.subscribe(later)
        window.setTimeout(() => { stopList(); stopInfo(); window.clearTimeout(timer) }, 15_000)
        ensure()
        assistantOpened = true
        return
      }
      // Хост без веб-сессий или старый хост: прежний путь через workspace ассистента.
      const path = await assistantWorkspace()
      if (path === null) { uiWorkspace.startSession(); return }
      const existing = workspaces.list.getSnapshot().items.find(item => item.path === path)
      const target = existing ?? await workspaces.create({ path })
      await uiWorkspace.openWorkspace(target.workspaceId, () => { assistantOpened = true })
    })().catch((error: unknown) => { ctx.logger.warn(`human-harness: не удалось открыть беседу: ${String(error)}`); uiWorkspace.startSession() })
      .finally(() => { opening = false })
  }

  ctx.effect(() => {
    const disposeRoot = ctx.slots.provideRoot({ hooks: { panelInfo } })
    const disposeService = ctx.provide('layout', layout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      // Каркас объявляет только то, что рендерит: main (экраны и беседа), seat
      // настроек и overlay. `sidebar`/`rightbar` не объявляются — их занимающие
      // (ui-sidebar, ui-sidebar-right) не монтируются, а seat `sidebar.settings`
      // остаётся свободным для ui-settings-general.
      children: {
        'main': { kind: 'keyed', scope: 'root' },
        'sidebar.settings': { kind: 'single', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
        // Правая панель DSH: просмотр документов (sidebar-right + documentpreview).
        'rightbar': { kind: 'single', scope: 'root' },
      },
      inject: () => ({ selectPanel, openAssistant, rightbar: layout.rightbar, hideRightbar: () => layout.hideDocument() }),
    }, Frame)
    const retain = (): void => layout.retain(ctx.slots.entries('main').flatMap(e => (e.options.key === undefined ? [] : [e.options.key])))
    const disposePanels = ctx.slots.subscribe('main', retain)
    return () => { layout.dispose(); disposePanels(); disposeRegistration(); disposeRoot(); void disposeService() }
  }, 'human-harness: layout + root')

  // Бренд hero беседы: текстовый знак hh_ вместо рыбы DeepSeek (дизайн-система: логотип текстовый).
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark', priority: -10 }, HeroMark))

}
