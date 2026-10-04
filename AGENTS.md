# Соглашения для исполнителя: human-harness

Этот файл читают кодовые агенты и люди, которые меняют репозиторий. `CLAUDE.md`
ссылается сюда же; машиночитаемая часть (установка, проверки) —
[`.agents/runner.yaml`](.agents/runner.yaml). Что делает харнесс, его принципы
и пакеты — в [README.ru.md](README.ru.md).

## Раскладка

- pnpm workspace: пакеты `packages/*` (`@human-harness/*`) — identity, клиент
  Control Plane и инструменты `cp_*`, провайдер модели, launcher, веб-каркас,
  bundle для DSH. Тесты — `packages/*/tests/**/*.test.ts(x)` (vitest).
- `packages/control-plane/openapi/control-plane.json` — снимок контракта ядра;
  `src/generated/` — типы из него (`pnpm gen:cp-types`), руками не правятся.
- `scripts/` — локальный запуск и профиль DSH; `docker/` и `Dockerfile` — образ.
- Соседних репозиториев нет: зависимости — пакеты npm, DSH закреплён версией в
  `package.json`.

## Сборка и проверки

Node ≥ 22.19 и pnpm 11 (`corepack enable` берёт версию из `package.json`). Всё,
что зовёт CI, — цели `make` поверх скриптов `package.json`:

```bash
make install     # pnpm install --frozen-lockfile
make typecheck   # tsc -b по всем пакетам
make test        # vitest
make check       # typecheck + test
make build       # tsc -b + tsdown (host lib и браузерный lib/client.js)
```

Проверкам не нужны ни живой Control Plane, ни сеть, ни Docker. `pnpm smoke`
и `pnpm dev` ходят в живое ядро по PAT — в проверки перед сдачей они не входят.

## Перед сдачей

- `make check` зелёный. Тесты — последовательно, один прогон за раз.
- Меняешь поведение — тест vitest в том же коммите.
- Новый вызов ядра — только из снимка OpenAPI: сначала снимок и
  `pnpm gen:cp-types`, contract-тест сверяет типы и каждый вызов клиента со
  снимком. Контракт не выдумывается.
- Меняешь инструменты `cp_*`, маршруты `/api/harness/*`, патч bundle или
  переменные окружения — обнови README (обе версии) и сошлись на ADR или задачу.
- Меняешь зависимости — `pnpm-lock.yaml` и `THIRD_PARTY.md` (`pnpm third-party`) в том же
  коммите. Новый
  postinstall-скрипт разрешается явно в `allowBuilds` (`pnpm-workspace.yaml`).

## Правила

- Компонент нейтрален к продукту (white-label): имя продукта не появляется в
  коде, конфигурации, маршрутах, переменных, персоне и интерфейсе. Инструменты
  модели — `cp_*`, остальное — `harness` (`@human-harness/*`, `/api/harness/*`,
  `HARNESS_*`). Страж — `packages/control-plane/tests/white-label.test.ts`,
  он проверяет каждый файл репозитория, включая этот.
- DSH — без форка: из `@deepseek-ai/*` импортируются только типы, рантайм живёт
  в установке DSH. При смене версии DSH сначала сверь контракты из раздела
  «Обновление upstream» README.
- Мутации идут только через подтверждение человека и без него отказывают.
  Память — только через Control Plane, прямого клиента к хранилищу памяти нет.
- Документация — на русском, `README.md` — на английском; имена API и сущностей —
  на английском. Комментарии в коде — как в окружающем коде.
- Не коммить секреты, `.env`, `.dsh-home/`, содержимое `DSH_HOME` и файлы
  учётных данных, абсолютные локальные пути, внутренние адреса и артефакты
  сборки (`node_modules/`, `lib/`, `*.tsbuildinfo`).
- Не трогай `main` и чужие ветки.
- Не делай того, чего нет в задаче: найденное попутно — в отчёт, а не в код.
