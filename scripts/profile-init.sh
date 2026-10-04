#!/usr/bin/env bash
# Создать профиль dsh `human-harness` из шипнутого шаблона web и подключить
# локальные пакеты этого репозитория (link: — реальные пути, код резолвится
# из рабочей копии; после `pnpm build` перезапуск не нужен для host-половины
# только при live patch reload, для кода — нужен).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${DSH_PROFILE:-human-harness}"
DSH="node $ROOT/scripts/dsh.mjs"
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

if [ ! -d "$DSH_HOME/profiles/$PROFILE" ]; then
  echo "→ создаю профиль $PROFILE из шаблона web"
  $DSH --profile "$PROFILE" --from-default-profile web --dump-default-config >/dev/null
fi

# Профиль — отдельный pnpm-проект; без packageManager corepack берёт свою
# «последнюю известную» версию pnpm, которая может не совпасть с установленным
# corepack. Закрепляем ту же версию, что у репозитория.
PM="$(node -e "console.log(require('$ROOT/package.json').packageManager)")"
node -e "
const fs = require('fs'); const p = '$DSH_HOME/profiles/$PROFILE/package.json'
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'))
if (pkg.packageManager !== '$PM') { pkg.packageManager = '$PM'; fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\\n') }
"

echo "→ подключаю пакеты харнесса в профиль $PROFILE"
$DSH plugin --profile "$PROFILE" add \
  "link:$ROOT/packages/identity" \
  "link:$ROOT/packages/control-plane" \
  "link:$ROOT/packages/llm-claude-code" \
  "link:$ROOT/packages/ui-human-harness" \
  "link:$ROOT/packages/bundle"

echo "→ профиль готов: $DSH_HOME/profiles/$PROFILE"
echo "   запуск: pnpm dev   (или: $DSH --profile $PROFILE --no-open)"
