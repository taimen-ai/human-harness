/**
 * Runtime-плагин bundle Human Harness: сам слой конфигурации живёт в
 * `cordis.patch.yml`; здесь — только маркер загрузки для журнала.
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'human-harness'

export function apply(ctx: Context): void {
  ctx.logger.info('human-harness: bundle загружен (identity → control-plane → панели HWS)')
}
