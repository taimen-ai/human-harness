# Human Harness

*Русская версия. English: [README.md](README.md)*

Персональный рабочий ассистент сотрудника — Human Work Surface (HWS, ADR-0024)
платформы. Собирается как bundle плагинов для
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) без форка:
upstream даёт agent loop, Web Client и PWA-оболочку, этот репозиторий — нативную
связь с сервисами платформы. Решения — ADR-0033 и ADR-0051 umbrella-репозитория
платформы.

Харнесс white-label: имени продукта в именах кода нет. Имя компании человек видит из
tenant Control Plane, имя приложения задаёт установка (`HARNESS_APP_NAME`, по умолчанию
«Human Harness»); страж — `packages/control-plane/tests/white-label.test.ts`.

```text
человек ──► DSH Web UI (PWA) ──► DSH host (Node, на машине человека)
                                  ├─ @human-harness/dsh-identity        PAT IAM → access token (audience control-plane)
                                  ├─ @human-harness/dsh-control-plane   Session харнесса, инструменты cp_*, /api/harness/*
                                  ├─ @human-harness/dsh-client-ui-…     одно окно: беседа и «Важное» (браузер)
                                  └─ @human-harness/dsh-human-harness   bundle: cordis.patch.yml + persona ассистента
                                                 │
                                                 ▼  HTTPS, bearer IAM
                                    Control Plane (задачи, approvals, события, Context Gateway → память)
```

## Принципы

- **Нативно, не через MCP-мост.** Инструменты модели и панели говорят с Control Plane
  напрямую типизированным клиентом; identity — обмен PAT в IAM (`platform-auth` контракт).
- **Память — только через Control Plane по PAT** (`POST /api/v1/context`,
  `POST /api/v1/observations`). Прямого клиента к memory-service у харнесса нет.
- **Ничего не остаётся только в переписке.** Мутации — типизированные `Task`,
  `Approval`, комментарии, Observation; каждая проходит подтверждение человека
  через seam `user-approval` DSH и без него отказывает (fail closed).
- **«Важное» считает ядро** (CP-ADR-0071): `GET /api/v1/me/attention` — детерминированные
  правила с причиной, правилом и действиями. Харнесс ничего не пересчитывает; если ядро
  старше CP-ADR-0071, «Важное» пустое с пометкой `endpoint_missing`, окно работает.
- **Проактивный ассистент в одной беседе** (TAI-ADR-0051 п.6). Хост читает журнал событий ядра
  по контракту CP-ADR-0069: `GET /api/v1/events` от курсора в `$DSH_HOME/harness/event-cursor.json`,
  сокет `WS /api/v1/events/ws` только будит чтение, страховочный опрос 30 с, дедуп по `event.id`.
  Значимость — данные, `attention-rules.json` (см. ниже). Значимое свежее событие становится
  ходом ассистента в единственной беседе человека (источник `platform-event`); лавина копится
  20 с и уходит одним ходом; правила `digest` и всё, что случилось, пока контейнер спал, — одна
  сводка «пока тебя не было», когда человек снова открывает окно. Напоминания («напомни в
  пятницу») — `dsh-schedule` в той же беседе.
- **Вне дерева upstream.** Пакеты импортируют из `@deepseek-ai/*` только типы; рантайм
  (`Service`, `defineTool`) не дублируется — в профиле dsh живёт одна копия cordis.

## Пакеты

| Пакет | Половина | Что делает |
|---|---|---|
| `@human-harness/dsh-identity` | host | `ctx.harnessIdentity`: PAT из `~/.config/iam/credentials.json` (ключ `issuer\|tenant[\|principal]`) или `IAM_PLATFORM_ACCESS_TOKEN` + `IAM_CREDENTIAL_MODE=environment`; обмен `platform-access-tokens:exchange`, кэш до порога |
| `@human-harness/dsh-llm-claude-code` | host | провайдер модели DSH `claude-code`: ход ассистента исполняет Claude Code (Claude Agent SDK) по подписке владельца с `resume` сессии Claude; инструменты агента DSH — через in-process MCP-мост в `ctx.tools.execute` (политики, подтверждения, песочница DSH), встроенные инструменты Claude отключены; связь сессий — `$DSH_HOME/harness/claude-sessions.json` |
| `@human-harness/dsh-control-plane` | host | `ctx.controlPlane`: Session (`clientName human-harness`, `harness.type deepseek-harness`) с heartbeat; «Важное» (`me/attention`); инструменты `cp_whoami/attention/agents/task_types/task_type_executors/propose_task/delegate/run_progress/review/take_task/active_work/checkpoint/register_artifact/complete_task/release_task/invoke_skill/get_task/find_tasks/create_task/update_task/comment_task/decide_approval/recall/remember`; маршруты `/api/harness/{whoami,conversation,attention,changes,attention.discuss,attention.feedback,wake,workspaces,approvals.decide,…}`; потребитель событий и правила значимости (проактивность) |
| `@human-harness/launcher` | процесс | диспетчер персональных харнессов (TAI-ADR-0051 п.2): вход человека (OIDC PKCE → IAM `federation:exchange`), прокси HTTP/WebSocket в его контейнер, жизненный цикл контейнеров через docker-socket-proxy, удаление бесед отключённых principal, вход каналов. Без зависимостей, кроме встроенных модулей Node |
| `@human-harness/dsh-client-ui-human-harness` | web + host | каркас по макету вместо AppFrame DSH (строка `ui-layout` отключена в bundle; служба `ctx.layout`, hook `panelInfo` и презентер темы — здесь), тема `harness` на alias-токенах, одно окно: беседа DSH по центру и «Важное» справа (на узком экране — вкладки «Ассистент | Важное»), без экранов и горячих клавиш навигации; host-половина раздаёт шрифты IBM Plex `/api/harness/fonts/*` и PWA-манифест (`/manifest.webmanifest`, имя — `HARNESS_APP_NAME`). Данные — `/api/harness/*` под cookie сессии DSH, PAT в браузер не попадает |
| `@human-harness/dsh-human-harness` | bundle | `cordis.patch.yml`: вставка плагинов, persona ассистента вместо coding-persona web-app |

## Правила значимости (`attention-rules.json`)

Правила по умолчанию лежат в `@human-harness/dsh-control-plane` (`attention-rules.json`, схема
`attention-rules.schema.json`); установка заменяет их своим файлом (`HARNESS_ATTENTION_RULES`).
Правила проверяются по порядку файла, срабатывает первое подходящее.

| Поле | Смысл |
|---|---|
| `key`, `version` | Идентичность правила `key@version`; видна у каждого проактивного пункта |
| `on` | Точные типы событий ядра; вместе они — фильтр `types` подписки |
| `concerns` | Отношение к человеку: `approval-mine` (назначено ему или его роли), `task-assignee`, `task-creator` (поручение), `task-involves` (исполнитель, автор или владелец), `any` |
| `when` | Условия по полям события через точку; `"$me"` — principal человека |
| `skipOwnActions` | Пропускать действия самого человека (по умолчанию `true`) |
| `significance` | `now` — ассистент приходит сам; `digest` — только в сводку |
| `message`, `action` | Шаблоны с `{{путь}}` (поля события, `payload.*`, `task.publicId`, `task.title`): что произошло и какое действие предложить |

Окно получает long-poll сигнал (`/api/harness/changes`) и перечитывает «Важное», как только
событие коснулось человека. `/internal/harness/status` сообщает launcher'у, идёт ли ход и когда
ближайшее напоминание.

Известное ограничение: чат DSH подписывает сообщение с незнакомым источником «Execution
requested» (закрытый switch в `dsh-client-ui-chat`); в развороте карточки — текст события.

## Launcher

Контейнер на человека создаёт launcher из закреплённого образа; войти можно только через него.
Пути — относительно монтирования (`LAUNCHER_MOUNT`, по умолчанию путь из `LAUNCHER_PUBLIC_URL`):

| Путь | Что |
|---|---|
| `/_launcher/login`, `/_launcher/callback`, `/_launcher/logout` | Вход человека: Keycloak Authorization Code + PKCE, затем IAM `federation:exchange` → IAM principal; подписанная cookie launcher'а (12 ч) |
| `POST /_launcher/internal/principals/{id}/inbound` | Текст канала в беседу человека; access token IAM, audience `human-harness`, scope `harness:inbound` |
| `/_launcher/internal/principals/{id}/surface/{message,stream,history,approval}` | Поверхность беседы (консоль, контракт `surface/1`) → контейнер `/internal/harness/surface/*`; access token IAM человека, audience `human-harness`, scope `harness:use`, `sub` = `{id}`. `message`/`approval`/`history` будят контейнер, простой сбрасывают только `message`/`approval`; `stream` не будит: к спящему — `sleeping`, соединение открыто до пробуждения кем-то другим (`waking`, затем события контейнера). Лимиты: тело ≤64 КБ, ≤8 потоков на человека, курсор ≤200 символов, 30 с на ответ контейнера |
| `/_launcher/health` | Жив ли launcher |
| всё остальное | Прокси (HTTP и WebSocket) в контейнер principal из cookie |

Изоляция: контейнер выбирается только по подписанной cookie, cookie launcher'а в контейнер не
уходит, каждый проксированный запрос несёт `X-Harness-Launcher: v1.<ts>.<hmac>` — HMAC над
`ts.principal` секретом контейнера (`HARNESS_LAUNCHER_SECRET`). В контейнере плагин харнесса
отдаёт:

| Путь в контейнере | Что |
|---|---|
| `/_harness/health` | Готовность (холодный старт меряется до первого 200). За launcher'ом — 503, пока беседа не привязана к службам сессий DSH; launcher зовёт его перед каждым проксируемым запросом, поэтому проверка дешёвая |
| `/_harness/enter` | Верный заголовок launcher'а для principal этого контейнера → redirect на `authenticatedUrl()` DSH (штатная cookie DSH); иначе 401 |
| `/internal/harness/status` | `{busy, nextWakeAt}`; bearer — секрет контейнера |
| `POST /internal/harness/inbound` | `{text, channel}` → сообщение `channel` в единственную беседу; bearer — секрет контейнера |
| `/internal/harness/surface/{message,stream,history,approval}` | API поверхности беседы (контракт `surface/1`): консоль пишет в ту же беседу, читает её потоком SSE и историей, отвечает на подтверждения (побеждает первый ответ среди окна, Telegram и консоли); `screenContext` реплики входит только в её ход секцией `screen-context` (по образцу `dsh-time-context`) и в историю человека не попадает; bearer — секрет контейнера |

Секция `screen-context` (плагин `packages/control-plane/src/screen-context.ts`):

- закрыта с обеих сторон: `<screen-context>…</screen-context>`, свободный текст (подпись,
  проекция) — JSON, где `<` и `>` закодированы как `\u003c`/`\u003e`, так что закрывающий
  маркер, вписанный кем-то в подпись или итог прогона, из секции не выходит; граница —
  часть самого сообщения и одинакова для любого драйвера модели;
- драйвер `claude-code` в транскрипте холодного старта подписывает её «Контекст экрана»,
  а не словами человека;
- известное поведение: форма источника — `snapshot` («следующий снимок заменяет
  прежний»), а ход без контекста экрана нового снимка не пишет, поэтому прежняя секция из
  истории модели не очищается. Это закрыто правилом персоны «Консоль»: секция относится
  только к реплике своего хода, в следующей реплике без неё объект берётся из беседы, а
  если неясен — уточняется;
- оба слушателя (`agent/pre-step`, `agent/inbox/discarded`) регистрируются `global`; место
  секции среди других снимков шага (например `dsh-time-context`) зависит от порядка загрузки
  плагинов и ничего не значит.

Веб-клиент DSH на относительных путях (`<base href="./">`), поэтому харнесс работает под
префиксом; клиент харнесса тоже (`api/harness/*`).

Жизненный цикл: создание и старт по первому запросу (volume `harness-data-<principal>` в `/data`,
каталог секретов человека только на чтение в `LAUNCHER_SECRETS_TARGET`, метка
`harness.managed=true`); остановка после `LAUNCHER_IDLE_MINUTES` (30) без запросов и без
идущего хода с запоминанием ближайшего напоминания; старт к этому времени. Раз в минуту sweep
спрашивает IAM о статусе каждого principal с контейнером или volume: `disabled` или удалён из
tenant'а — контейнер и volume удаляются (`conversation.deleted` в журнале); `paused` — остановка.
Каждая мутация Docker сначала проверяет метку `harness.managed` и закреплённый образ. Журнал —
JSON-строки в stdout. Переменные окружения — в английском README (раздел Launcher).

Изоляция. У модели в контейнере человека есть shell, поэтому контейнер — недоверенный.
docker-socket-proxy тело запроса не разбирает, поэтому `POST /containers/create` launcher
собирает сам и отвергает (`checkCreate`) всё, кроме закреплённого образа, имён контейнера и
volume из principal, каталога секретов этого же principal (ровно
`<LAUNCHER_SECRETS_BASE>/<principalId>`; без переменной база выводится из people.json как общий
родитель всех `secretsDir`, несогласованные записи — отказ при старте), ровно сети
`LAUNCHER_NETWORK` (allowlist из одной сети: `NetworkMode` равен ей, в
`NetworkingConfig.EndpointsConfig` других сетей нет; `host`, `bridge`, `none`, `default`,
`container:*` отвергаются, даже если их назвали, как и всё, что похоже на ID сети — 12–64
hex-символа: этот запрет сверяет имена), без привилегий (`Privileged: false`,
`CapDrop: ALL`, `no-new-privileges`; uid 10001 задаёт образ) и с лимитами в том виде, в каком их
увидит Docker (`LAUNCHER_HARNESS_MEMORY_MB`, `LAUNCHER_HARNESS_CPUS`, `LAUNCHER_HARNESS_PIDS`):
память не меньше 6 МБ и `MemorySwap` равен `Memory` (своп сверх лимита запрещён), CPU не меньше
0,01 (`NanoCpus` ≥ 10⁷ — иначе округление дало бы 0, то есть «без лимита»), процессов не меньше 1.
Те же границы и сеть проверяются при старте вместе с фиксированным потолком (не больше 64 CPU,
64 ГБ памяти, 65 536 процессов). Базу секретов и всех её родителей может писать только root
(см. SECURITY.md). Существующий volume `harness-data-<principal>`
используется, только если у него метки `harness.managed=true` и `harness.principal=<principal>`. Прокси видит
только launcher: внутренняя сеть на двоих. `LAUNCHER_NETWORK` — отдельная сеть людей, где есть
только нужное ассистенту (ядро, уведомления, внешний прокси для IAM, launcher). Остановленный
контейнер старой спецификации (метка `harness.spec`, сейчас `3`; у контейнеров версии 2 нет
`MemorySwap`) или в другой сети пересоздаётся при следующем пробуждении; volume остаётся.

## Документы в окне

Документы открываются в штатном просмотре DSH (`dsh-client-ui-sidebar-documentpreview`) в правой
колонке окна вместо «Важного», на узком экране — поверх беседы. Каркас объявляет слот `rightbar`
DSH и показывает его только для вкладки документа (страница «Start», файлы и терминал правой
панели DSH не показываются; вкладка, которую DSH восстанавливает при загрузке, беседу не
закрывает). Markdown, код, картинки, PDF и HTML показывает DSH; харнесс добавляет DOCX
(`docx-preview` в iframe без скриптов, по ширине панели), XLSX (`read-excel-file`, значения
текстом, формулы не вычисляются) и CSV/TSV. Ссылки на файлы в ответах ассистента открывают
просмотр. Артефакт ядра (`GET /artifacts/{id}/content`) инструмент `cp_fetch_artifact` скачивает
в `.artifacts/<id>/` рабочего каталога беседы, и ассистент даёт на него ссылку; активное
содержимое (HTML, SVG, XML) сохраняется как `.txt` и показывается текстом. Обратный путь —
документ, который человек сделал с ассистентом (Word, Excel, PowerPoint через `python-docx`/
`openpyxl`/`python-pptx` в образе), сдаётся результатом его работы: `cp_register_artifact` с
`file` читает файл только из рабочего каталога беседы (ссылки разрешаются), загружает его
`PUT /artifact-contents` и заводит артефакт с полученным `contentRef` (CP-ADR-0072). Браузерный бандл не
должен тянуть встроенные модули Node — это сторожит `tests/bundle.test.ts` (jszip и fflate
подменены браузерными сборками в `packages/ui-human-harness/tsdown.config.ts`).

## Канал — та же беседа

Telegram — вторая поверхность единственной беседы (TAI-ADR-0051 п.7). Сервис уведомлений передаёт
текст привязанного человека launcher'у, и он приходит ходом с источником `channel`. Ответ
ассистента на этот ход уходит человеку уведомлением (`POST /api/v1/notifications` сервиса
уведомлений его собственным токеном, audience `notification-service`, scope `notifications:send`;
`HARNESS_NOTIFY_URL`); длинный — обрезается со ссылкой в окно (`HARNESS_PUBLIC_URL`).
Подтверждение инструмента в таком ходе приходит кнопками (`data.kind = "harness_approval"`);
нажатие возвращается тем же inbound (`{approval: {id, decision}}`) и отвечает на
`ctx.approval.request`. Окно тоже может ответить — побеждает первый ответ; если канал недоступен,
решает только окно.

Относительные ссылки ассистента на экраны консоли (`/console/…`) в ответе канала достраиваются
до полных от адреса окна (`HARNESS_WINDOW_URL`) — например, ссылка-предложение работы открывает
форму в консоли из мессенджера. Если ответ длиннее предела канала, поля `result` и `basis`
в ссылках-предложениях ужимаются (500, 200, 50 символов, затем отбрасываются), чтобы ссылка не
обрезалась посередине.

## Предложение работы ссылкой

Ассистент не заводит работу сам (решение Human Control: работа заводится подписью человека).
На «поручи…», «заведи работу…» он подбирает тип из разрешённых в workspace (`cp_task_types` →
`GET /api/v1/task-types?workspaceId=`) и исполнителя этого типа (`cp_task_type_executors` →
`GET /api/v1/task-types/{id}/executors?workspaceId=`) и отвечает ссылкой `cp_propose_task`:
`/console/work/new?title=…&type=…&exec=…&owner=…&due=…&ws=…&result=…&basis=…` (контракт консоли —
экран work, «Словами: предложение ссылкой»; ссылку собирает `consoleUrl.proposal`: значения
URL-кодированы вместе с `!'()*.` — иначе скобка оборвала бы ссылку в markdown и в разборе
консоли, — пустые отброшены, `title` ≤ 500, `result` и `basis` ≤ 2000). Консоль рисует по ней
карточку «Будет заведена работа — нужна ваша подпись», и работу заводит кнопка «Завести работу».
Исполнителя нет — ссылка без `exec`. Задача TASK-001349.

## Образ контейнера

`Dockerfile` собирает образ персонального харнесса: DSH-профиль `human-harness` с пакетами
репозитория, Claude Code (linux-сборка Claude Agent SDK из lockfile), git и
`python-docx`/`openpyxl`/`python-pptx`; пользователь uid 10001. `packages/launcher/Dockerfile` —
образ launcher'а (один файл, только встроенные модули Node). Точка входа (`docker/entrypoint.sh`):

- состояние человека — volume `/data` (`DSH_HOME=/data/dsh`, `HOME=/data/home`), профиль из образа
  подключается ссылкой;
- секреты — только файлы из `HARNESS_SECRETS_DIR` (launcher монтирует только на чтение):
  `credentials.json` (PAT IAM), `claude-oauth-token` (провайдер модели читает на каждый ход и
  передаёт только процессу Claude Code), `forge-token` (git credential helper, только github.com);
  в окружении процесса DSH их нет, но файлы читает shell модели (см. [SECURITY.md](SECURITY.md));
- глобальный git — `docker/gitconfig`: credential helper и hook `pre-push` (публикуются только
  ветки `task/*`);
- DSH слушает все интерфейсы только в образе (`HARNESS_CONTAINER=1` переключает строку
  `webserver` бандла): портов наружу нет, каждый `/api` требует cookie DSH, вход — HMAC
  launcher'а; `HARNESS_TRUSTED_HOSTS` — публичный хост.

Замер локально (Docker Desktop, arm64): холодный старт нового человека — volume, контейнер,
старт, готовность — 4,4 с; пробуждение после сна — 2,1 с (бюджет — 30 с).

В образе — Claude Agent SDK, проприетарное ПО Anthropic: собирать и распространять образ — на
условиях Anthropic. Готовых образов проект не публикует; см. [THIRD_PARTY.md](THIRD_PARTY.md).

## Запуск локально

Нужны Node ≥ 22.19, pnpm 11 (corepack), PAT IAM в `~/.config/iam/credentials.json`
и провайдер модели в DSH (Settings → Models; ключ хранит сам DSH).

```bash
pnpm install
pnpm build          # tsc -b + tsdown (host lib + браузерный lib/client.js)
pnpm test           # vitest: проекции, клиент, identity
pnpm smoke          # живой Control Plane: обмен PAT → whoami → focus/work/updates
pnpm gen:cp-types   # типы клиента из снимка OpenAPI ядра (--fetch <url> — обновить снимок)
pnpm profile:init   # профиль dsh `human-harness` = шаблон web + link: на пакеты
pnpm dev            # сборка и `dsh --profile human-harness web`
```

Гоча Node: лончер upstream (`lib/bin.js`) запускает `runCli()` только под
`import.meta.main`, которого нет в Node < 22.18 / < 24.2 — на Node 24.1 `dsh` молча
завершается с кодом 0. Скрипты используют обёртку `scripts/dsh.mjs` (`pnpm dsh …`),
вызывающую `runCli()` явно; `DSH_HOME` в скриптах по умолчанию — `~/.dsh`, для
изолированной проверки задайте свой (например `.dsh-home/` в репозитории).

Пути exact-маршрутов Connection допускают сегменты `[A-Za-z0-9_$.-]` — двоеточие
(`updates:acknowledge` в стиле ядра) недопустимо, поэтому маршрут называется
`updates.acknowledge`. Ошибка в имени роняет весь inject-колбэк маршрутов молча.

Переменные окружения bundle: `HARNESS_IAM_URL`, `HARNESS_IAM_TENANT`, `HARNESS_IAM_PRINCIPAL`,
`HARNESS_CONTROL_PLANE_URL`, `HARNESS_CONFIRM_MUTATIONS`, `HARNESS_CLAUDE_MODEL`; токен подписки Claude — `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`), его читает сам Claude Code (см. `packages/bundle/cordis.patch.yml`).
`DSH_HOME` переключает домашний каталог dsh (профили, settings.yaml, credentials).

## Каркас вместо AppFrame — как это устроено

Слоты DSH объявляет тот, кто их рендерит, и объявление живёт, пока жива регистрация:
затенить `root` своим компонентом недостаточно — `main` останется занят AppFrame.
Поэтому bundle отключает строку `ui-layout` (`disabled: true`), а наш плагин
предоставляет то, чего лишается композиция: `ctx.provide('layout', …)` с тем же
контрактом (`selectPanel`, `beginNavigation`, no-op для sidebar/rightbar),
`ctx.slots.provideRoot({ hooks: { panelInfo } })` для `usePanelInfo` и презентер темы
(порт `theme-presenter.ts`). Корень объявляет только `main`, `sidebar.settings`
и `shell.overlay`: `sidebar` и `rightbar` не объявляются, поэтому ui-sidebar и
ui-sidebar-right не монтируются, а seat настроек остаётся свободным для
ui-settings-general (шестерёнка в подвале rail). Тема `harness` — сторонний id, который
DSH не сохраняет в настройках; плагин переустанавливает её на каждом `theme/change`.

## Действия из «Важного»

Карточка approval в «Важном» (и её подробности) даёт «Согласовать» / «Отклонить»: открывается
review dialog (объект, эффект, механика, обратимость, комментарий — при отклонении
обязателен), подтверждение шлёт `POST /api/harness/approvals.decide`, host выполняет
`POST /api/v1/approvals/{id}:approve|reject` с `Idempotency-Key`; после успеха
проекции перечитываются (`shell.bump()`), а не патчатся. Переходы статуса задачи —
`POST /api/harness/tasks.transition` с `version` для `If-Match` (UI появится вместе с
`transitions`). Для результата на проверке те же действия называются «Принять» / «Вернуть» (возврат —
с замечанием, следующая итерация исполнителю). «Не нужно было показывать» —
`POST /api/harness/attention.feedback` → `POST /api/v1/me/attention/{itemKey}:feedback`.
Беседа DSH открывается сразу в workspace ассистента, диалог выбора директории не показывается.

Права principal в Control Plane (binding IAM↔CP), без которых панели неполны:
`approvals.read`, `approvals.decide`, `approvals.manage`, `task_types.read`,
`workspaces.read`, `observations.write`, `skills.invoke` — иначе часть «Важного» пуста (`degraded[]`).

## Scope: workspace Control Plane

Шапка `tenant / workspace ▾` выбирает workspace ядра (дерево `GET /api/v1/workspaces/tree`);
выбор хранится в per-principal read-state (`$DSH_HOME/harness/read-state.json`, поле
`workspaceId`) и действует как scope: задачи запрашиваются с `workspaceId` +
`includeDescendants`, approvals/runs/события фильтруются по workspace с потомками
(события без `workspaceId` в payload остаются), «Важное» считается в том же
workspace с потомками. Ассистент видит scope в `cp_whoami`/`cp_workspaces`, меняет его
`cp_select_workspace` и подставляет по умолчанию в `cp_find_tasks`,
`cp_create_task`, `cp_recall`, `cp_remember`. «все workspace» снимает scope.

## Границы v0

- Файловая правая панель DSH (`ui-sidebar-right`) и список сессий sidebar не смонтированы: беседа одна на workspace, переключение сессий — следующий срез.
- Смена статуса задачи с карточки ещё не выведена в UI (маршрут есть, нет чтения `transitions`); прочие мутации — через ассистента с подтверждением.
- Тексты интерфейса — русские в `text.ts`: переключатель языка DSH знает только `zh`/`en`.
- Правила «Важного», недоступные principal'у, приходят в `degraded[]`, колонка это показывает.
- «Обсудить элемент в беседе» с подтянутым контекстом и живое обновление по событиям
  ядра — вместе с проактивностью (H009); сейчас «Важное» перечитывается раз в 15 с и
  после каждого действия.

## Обновление upstream

Версия DSH закреплена: `0.1.7-rc.2` (npm tag `next`). Контракты, от которых зависит код:
слоты `main` (keyed) и `sidebar.panellist`, `ctx.connection.fetch.register`,
`ctx.tools.register(ToolDefinition)`, `ctx.approval.request`, формат клиентского
бандла `window.__ModuleLoader__.load` (пресет `tsdown.client.ts` — порт upstream).
При bump'е проверять их первыми.

## Безопасность и лицензия

Модель угроз (launcher и docker-socket-proxy, сети, что может модель в контейнере человека,
секреты, prompt injection) — в [SECURITY.md](SECURITY.md) (на английском). Код — под Apache
License 2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)); сторонние компоненты, в том числе DeepSeek
Harness (MIT) и проприетарный Claude Agent SDK, — в [THIRD_PARTY.md](THIRD_PARTY.md) (пересобирает
`pnpm third-party`).
