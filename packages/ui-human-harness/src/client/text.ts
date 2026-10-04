/**
 * Тексты интерфейса. Продукт RU-first; переключатель языка DSH сейчас знает
 * только zh/en, поэтому словарь один и живёт здесь, а не в `ctx.locale`.
 */
export const TEXT = {
  nav: { assistant: 'Ассистент', important: 'Важное' },
  doc: { title: 'Документ', backToImportant: '← Важное', close: 'Закрыть' },
  important: {
    title: 'Важное',
    hint: 'что ждёт вас · правила ядра',
    empty: 'Сейчас от вас ничего не ждут. Новое появится здесь само, а ассистент скажет о важном в беседе.',
    degraded: (rules: readonly string[]) => `Часть правил сейчас недоступна: ${rules.join(', ')}. Список может быть неполным.`,
    kinds: { decision: 'решение', review: 'проверка', deadline: 'срок', blocked: 'блок', delegated_failure: 'поручение' } as Record<string, string>,
    reasons: {
      decision_assigned: 'Решение назначено вам',
      decision_role: 'Решение по вашей роли',
      review_assigned: 'Результат ждёт вашей проверки',
      review_role: 'Результат ждёт проверки по вашей роли',
      due_soon: 'Срок близко, работа не начата',
      overdue: 'Срок прошёл',
      task_blocked: 'Работа заблокирована',
      runs_failed: 'Поручение раз за разом проваливается',
    } as Record<string, string>,
    approve: 'Согласовать',
    reject: 'Отклонить',
    accept: 'Принять',
    returnBack: 'Вернуть',
    open: 'Подробнее',
    discuss: 'Обсудить',
    notNeeded: 'Не нужно было показывать',
    notNeededDone: 'Записали: это не нужно было показывать.',
    acceptEffect: 'Результат принят: проверка задачи пройдёт, задача завершится.',
    returnEffect: 'Результат вернётся исполнителю с вашим замечанием — следующей итерацией.',
    since: 'с',
    due: 'срок',
    rule: 'правило',
    reason: 'причина',
    counter: (n: number) => (n === 0 ? 'ничего не ждёт' : `ждёт вас: ${n}`),
  },
  chat: {
    meta: (session: string | null, sees: string | null) => `ассистент${session ? ` · сессия ${session.slice(0, 8)}` : ''} · видит: ${sees ?? 'все workspace'} · действует только через ваши подтверждения`,
    composerHint: 'Написать ассистенту…',
  },
  context: {
    back: 'Назад',
    close: 'закрыть · esc',
    state: 'Текущее состояние',
    policy: 'Policy',
    policyText: 'Авторизация проверяется сервером в момент действия, не при показе карточки. Мутации Control Plane идут через ассистента с явным подтверждением.',
    evidence: 'Evidence',
    evidenceText: 'Источники и память компании — через Context Gateway ядра (cp_recall). Спросите ассистента по объекту, чтобы получить ответ с provenance.',
    askAssistant: (ref: string) => `Спросить ассистента о ${ref}`,
    viaAssistant: 'это действие выполняется через ассистента с подтверждением',
  },
  dialog: {
    title: (kind: string) => kind === 'approval.approve' ? 'Согласовать' : kind === 'approval.reject' ? 'Отклонить' : 'Изменить статус',
    scope: 'Объект',
    effect: 'Эффект',
    mechanics: 'Механика',
    reversible: 'обратимо',
    irreversible: 'необратимо · записывается в журнал',
    comment: 'Комментарий',
    commentRequired: 'комментарий обязателен',
    confirm: 'Подтвердить',
    cancel: 'Отмена',
    busy: 'выполняется…',
    done: (kind: string) => kind === 'approval.approve' ? 'Согласовано. Сервер повторно проверил авторизацию и записал журнал.' : kind === 'approval.reject' ? 'Отклонено. Записано в журнал.' : 'Статус изменён. Состояние перечитано с сервера.',
    approveEffect: 'Approval перейдёт в approved; связанный run, ждущий гейта, возобновится следующим захватом.',
    rejectEffect: 'Approval перейдёт в rejected; инициатор увидит комментарий.',
  },
  workspace: {
    title: 'Workspace · scope поверхности',
    hint: '«Важное» и умолчания ассистента — в выбранном workspace с потомками',
    all: 'все workspace',
  },
  common: {
    refresh: 'Обновить',
    loading: 'загрузка…',
    error: 'Ошибка',
    synced: (iso: string) => `синхр. ${time(iso)}`,
    offline: 'Нет соединения с Control Plane: данные могут устареть. Согласования и необратимые действия недоступны до переподключения.',
    me: 'вы',
    unassigned: '—',
  },
} as const

export function short(cursor: string): string {
  return cursor.length > 14 ? `${cursor.slice(0, 6)}…${cursor.slice(-6)}` : cursor
}

export function time(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

export function due(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const hours = (d.getTime() - Date.now()) / 3_600_000
  const date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
  if (hours < 0) return `просрочено · ${date}`
  if (hours < 24) return `сегодня ${time(iso)}`
  if (hours < 48) return `завтра ${time(iso)}`
  return date
}

export function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) : id
}
