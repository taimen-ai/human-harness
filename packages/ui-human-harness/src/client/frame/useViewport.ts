import { useEffect, useState } from 'react'

export type Layout = 'mobile' | 'tablet' | 'desktop'

/** Точки макета: <768 mobile, <1180 tablet (rail без подписей, Context как sheet), иначе desktop. */
export function useLayout(): Layout {
  const compute = (): Layout => {
    const w = typeof window === 'undefined' ? 1440 : window.innerWidth
    return w < 768 ? 'mobile' : w < 1180 ? 'tablet' : 'desktop'
  }
  const [layout, setLayout] = useState<Layout>(compute)
  useEffect(() => {
    const onResize = () => setLayout(compute())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return layout
}
