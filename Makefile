# Цели, которые зовут CI (.github/workflows/ci.yml) и проверки исполнителя
# (.agents/runner.yaml). Обёртки над скриптами package.json: pnpm остаётся
# основным инструментом, make — общий язык проверок всех репозиториев.
.PHONY: install typecheck test build check

install:
	pnpm install --frozen-lockfile

typecheck:
	pnpm typecheck

test:
	pnpm test

build:
	pnpm build

check: typecheck test
