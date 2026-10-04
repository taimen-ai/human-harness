#!/bin/sh
# Git credential helper харнесса: личный токен forge человека — только для github.com
# и только на чтение запроса `get`. Токен лежит файлом (секрет контейнера), в окружение
# Bash-инструмента ассистента не выставляется. Подключение (образ, H011):
#   git config --global credential.https://github.com.helper "/opt/harness/git/credential-helper.sh"
set -eu
[ "${1:-}" = "get" ] || exit 0
host=""
while IFS='=' read -r key value; do
  [ -z "$key" ] && break
  [ "$key" = "host" ] && host="$value"
done
[ "$host" = "github.com" ] || exit 0
token_file="${HARNESS_FORGE_TOKEN_FILE:-/run/secrets/forge-token}"
[ -s "$token_file" ] || exit 0
printf 'username=x-access-token\npassword=%s\n' "$(cat "$token_file")"
