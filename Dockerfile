# Образ персонального харнесса (TAI-ADR-0051 п.1): DSH-профиль human-harness с пакетами
# этого репозитория, Claude Code (Claude Agent SDK, linux-сборка из lockfile), git и
# Python-библиотеки офисных документов. Контейнеры по одному на человека создаёт launcher;
# состояние человека — volume в /data, секреты — каталог только на чтение
# (HARNESS_SECRETS_DIR). Пользователь — uid 10001.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git python3 python3-pip tini \
 && pip3 install --no-cache-dir --break-system-packages python-docx==1.1.2 openpyxl==3.1.5 python-pptx==1.0.2 \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable

WORKDIR /opt/harness
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json tsconfig.base.json tsconfig.base.client.json tsdown.client.ts ./
COPY packages ./packages
COPY scripts ./scripts
COPY docker ./docker
RUN pnpm install --frozen-lockfile && pnpm build

# Профиль DSH собирается в образе (link: на /opt/harness/packages); в DSH_HOME человека
# он подключается ссылкой при старте, остальное состояние — в volume.
ENV DSH_HOME=/opt/dsh
RUN bash scripts/profile-init.sh \
 && chmod 0755 packages/bundle/git/credential-helper.sh packages/bundle/git/pre-push docker/entrypoint.sh \
 && useradd --uid 10001 --home-dir /data/home --no-create-home --shell /usr/sbin/nologin harness \
 && mkdir -p /data && chown -R 10001:10001 /opt/dsh /data

ENV HARNESS_CONTAINER=1
USER 10001
VOLUME ["/data"]
EXPOSE 3080
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/harness/docker/entrypoint.sh"]
