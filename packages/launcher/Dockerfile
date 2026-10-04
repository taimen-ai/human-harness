# Образ launcher'а: один файл lib/main.js, только встроенные модули Node.
# Контекст сборки — корень репозитория.
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json tsconfig.base.json tsconfig.base.client.json tsdown.client.ts ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile \
 && pnpm exec tsc -b packages/launcher \
 && pnpm --filter @human-harness/launcher run bundle

FROM node:24-alpine
COPY --from=build /src/packages/launcher/lib/main.js /app/main.js
RUN mkdir -p /var/lib/harness-launcher && chown 10001:10001 /var/lib/harness-launcher
USER 10001
EXPOSE 8080
CMD ["node", "/app/main.js"]
