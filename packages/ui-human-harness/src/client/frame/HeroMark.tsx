import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './frame.module.css'

/** Текстовый знак Human Harness в hero беседы (логотипа-картинки в дизайн-система нет). */
export function HeroMark({ size }: HeroBrandMarkOwnerProps) {
  return <span className={css.heroMark} style={{ fontSize: Math.round(size * 0.55), height: size }}>hh_</span>
}
