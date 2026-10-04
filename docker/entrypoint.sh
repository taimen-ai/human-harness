#!/bin/sh
# Старт персонального харнесса в контейнере. Секреты — файлы из HARNESS_SECRETS_DIR
# (монтирует launcher, только чтение): credentials.json (PAT IAM человека),
# claude-oauth-token (подписка Claude), forge-token (личный токен forge). В окружение
# процесса попадают пути, не значения: токен подписки читает провайдер модели на каждый
# ход, PAT — identity-плагин, токен forge — git credential helper.
set -eu
: "${HARNESS_SECRETS_DIR:=/run/secrets/harness}"
export DSH_HOME=/data/dsh HOME=/data/home
mkdir -p "$DSH_HOME" "$HOME"
if [ ! -L "$DSH_HOME/profiles" ]; then rm -rf "$DSH_HOME/profiles"; ln -s /opt/dsh/profiles "$DSH_HOME/profiles"; fi

[ -f "$HARNESS_SECRETS_DIR/credentials.json" ] && export HARNESS_IAM_CREDENTIALS_FILE="$HARNESS_SECRETS_DIR/credentials.json"
[ -f "$HARNESS_SECRETS_DIR/claude-oauth-token" ] && export HARNESS_CLAUDE_TOKEN_FILE="$HARNESS_SECRETS_DIR/claude-oauth-token"
export HARNESS_FORGE_TOKEN_FILE="$HARNESS_SECRETS_DIR/forge-token"
export GIT_CONFIG_GLOBAL=/opt/harness/docker/gitconfig
unset CLAUDE_CODE_OAUTH_TOKEN IAM_PLATFORM_ACCESS_TOKEN

# Адрес привязки задаёт строка webserver бандла (HARNESS_CONTAINER=1): CLI флаг
# --host 0.0.0.0 не принимает, а в контейнере слушать надо сеть compose.
set -- node /opt/harness/scripts/dsh.mjs --profile human-harness --no-open --port "${HARNESS_PORT:-3080}"
for host in $(echo "${HARNESS_TRUSTED_HOSTS:-}" | tr ',' ' '); do set -- "$@" --trusted-host "$host"; done
exec "$@"
