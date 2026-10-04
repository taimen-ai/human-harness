/**
 * Рендереры документов для штатного просмотра DSH (H015): DOCX, XLSX, CSV/TSV.
 * PDF, Markdown, код, картинки и HTML показывает сам `dsh-client-ui-sidebar-documentpreview`;
 * здесь — недостающие офисные форматы, в том же просмотре и той же правой панели.
 *
 * Документ — недоверенный ввод: DOCX превращается в HTML только внутри iframe без
 * скриптов (`sandbox="allow-same-origin"` нужен лишь для записи в contentDocument),
 * таблицы — текст в ячейках, формулы не вычисляются.
 */
import { useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { DocumentPreviewProps } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { renderAsync } from 'docx-preview'
import readXlsxFile from 'read-excel-file/browser'

const MAX_ROWS = 1000
const MAX_COLS = 60

const box: React.CSSProperties = { padding: 12, font: '13px/1.45 var(--hh-sans, system-ui, sans-serif)', color: 'var(--hh-ink-900, #1d2a2e)' }
const note: React.CSSProperties = { font: '12px var(--hh-mono, monospace)', color: 'var(--hh-ink-400, #66737a)', padding: '4px 0 8px' }

function bytesOf(props: DocumentPreviewProps): Uint8Array<ArrayBuffer> | null {
  return props.content.kind === 'bytes' ? props.content.data : null
}

export function DocxBody(props: DocumentPreviewProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [state, setState] = useState<{ status: 'rendering' | 'done' | 'error', error?: string, height: number }>({ status: 'rendering', height: 600 })
  const data = bytesOf(props)
  useEffect(() => {
    let cancelled = false
    const doc = frame.current?.contentDocument
    if (!doc || data === null) return
    doc.open()
    doc.write('<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#eef0f1;font-family:system-ui,sans-serif}</style></head><body></body></html>')
    doc.close()
    renderAsync(new Blob([data.slice().buffer]), doc.body, doc.head, {
      inWrapper: true, ignoreFonts: false, breakPages: true, renderHeaders: true, renderFooters: true, experimental: false, debug: false,
    }).then(() => {
      if (cancelled) return
      // Страница DOCX шире панели: масштаб по ширине, чтобы документ читался без прокрутки вбок.
      const available = (frame.current?.clientWidth ?? 0) - 8
      const scale = available > 0 ? Math.min(1, available / Math.max(1, doc.body.scrollWidth)) : 1
      doc.body.style.zoom = String(scale)
      setState({ status: 'done', height: Math.min(40_000, Math.max(300, Math.ceil(doc.body.scrollHeight * scale) + 24)) })
    }, (error: unknown) => {
      if (!cancelled) setState({ status: 'error', error: error instanceof Error ? error.message : String(error), height: 300 })
    })
    return () => { cancelled = true }
  }, [data])
  return (
    <div ref={props.scrollportRef} style={{ ...box, overflow: 'auto', height: '100%' }}>
      {state.status !== 'done' && <div style={note}>{state.status === 'rendering' ? 'Отрисовка документа…' : `Не удалось показать документ: ${state.error ?? ''}`}</div>}
      <iframe ref={frame} title="docx" sandbox="allow-same-origin" style={{ width: '100%', height: state.height, border: 0, background: '#eef0f1' }} />
    </div>
  )
}

interface Sheet { name: string, rows: string[][], totalRows: number, totalCols: number }

function cell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().replace('T00:00:00.000Z', '')
  return String(value)
}

function clip(name: string, rows: unknown[][]): Sheet {
  const totalCols = rows.reduce((max, row) => Math.max(max, row.length), 0)
  return {
    name,
    rows: rows.slice(0, MAX_ROWS).map(row => Array.from({ length: Math.min(totalCols, MAX_COLS) }, (_, i) => cell(row[i]))),
    totalRows: rows.length,
    totalCols,
  }
}

/** CSV/TSV без библиотек: кавычки, экранированные кавычки и переводы строк внутри поля. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1 } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === delimiter) { row.push(field); field = '' } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(field); rows.push(row); row = []; field = ''
    } else field += ch
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

function SheetTable({ sheets, scrollportRef }: { sheets: Sheet[], scrollportRef: DocumentPreviewProps['scrollportRef'] }) {
  const [active, setActive] = useState(0)
  const sheet = sheets[active] ?? sheets[0]
  if (!sheet) return <div style={box}><div style={note}>Пустая таблица</div></div>
  return (
    <div ref={scrollportRef} style={{ ...box, overflow: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', paddingBottom: 8 }}>
        {sheets.length > 1 && sheets.map((s, i) => (
          <button key={s.name} type="button" onClick={() => setActive(i)}
            style={{ font: 'inherit', fontSize: 12, padding: '2px 8px', borderRadius: 6, border: '1px solid var(--hh-border, #d5dade)', background: i === active ? 'var(--hh-ink-900, #1d2a2e)' : 'transparent', color: i === active ? '#fff' : 'inherit', cursor: 'pointer' }}>
            {s.name}
          </button>
        ))}
        <span style={{ ...note, padding: 0, marginLeft: 'auto' }}>
          {sheet.totalRows} × {sheet.totalCols}
          {sheet.totalRows > MAX_ROWS ? ` · показаны первые ${MAX_ROWS} строк` : ''}
          {sheet.totalCols > MAX_COLS ? ` · первые ${MAX_COLS} столбцов` : ''}
        </span>
      </div>
      <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
        <tbody>
          {sheet.rows.map((row, i) => (
            <tr key={i}>
              <th style={{ padding: '2px 6px', color: 'var(--hh-ink-400, #66737a)', fontWeight: 400, textAlign: 'right', borderRight: '1px solid var(--hh-border, #d5dade)' }}>{i + 1}</th>
              {row.map((value, j) => (
                <td key={j} style={{ padding: '2px 8px', border: '1px solid var(--hh-border, #e3e7ea)', whiteSpace: 'pre', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function XlsxBody(props: DocumentPreviewProps) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const data = bytesOf(props)
  useEffect(() => {
    let cancelled = false
    if (data === null) return
    readXlsxFile(data.slice().buffer).then(
      (all) => { if (!cancelled) setSheets(all.map(s => clip(s.sheet, s.data as unknown[][]))) },
      (e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) },
    )
    return () => { cancelled = true }
  }, [data])
  if (error) return <div style={box}><div style={note}>Не удалось прочитать таблицу: {error}</div></div>
  if (!sheets) return <div style={box}><div style={note}>Чтение таблицы…</div></div>
  return <SheetTable sheets={sheets} scrollportRef={props.scrollportRef} />
}

export function CsvBody(props: DocumentPreviewProps) {
  const data = bytesOf(props)
  const [sheets, setSheets] = useState<Sheet[] | null>(null)
  useEffect(() => {
    if (data === null) return
    const text = new TextDecoder('utf-8').decode(data)
    const tsv = props.resourceAddress.toLowerCase().endsWith('.tsv')
    setSheets([clip(tsv ? 'TSV' : 'CSV', parseDelimited(text, tsv ? '\t' : (text.split('\n', 1)[0]!.includes(';') && !text.split('\n', 1)[0]!.includes(',') ? ';' : ',')))])
  }, [data, props.resourceAddress])
  if (!sheets) return <div style={box}><div style={note}>Чтение таблицы…</div></div>
  return <SheetTable sheets={sheets} scrollportRef={props.scrollportRef} />
}

/** Зарегистрировать рендереры в реестре просмотра DSH и их тела в keyed-слоте документа. */
export function registerDocumentRenderers(ctx: Context): void {
  const renderers = [
    { id: 'harness.docx', extensions: ['docx'], title: () => 'Документ Word', body: DocxBody },
    { id: 'harness.xlsx', extensions: ['xlsx'], title: () => 'Таблица Excel', body: XlsxBody },
    { id: 'harness.csv', extensions: ['csv', 'tsv'], title: () => 'Таблица', body: CsvBody },
  ] as const
  ctx.inject(['documentPreviews'], (scoped) => {
    for (const r of renderers) {
      scoped.effect(() => scoped.documentPreviews.register({
        id: r.id,
        extensions: r.extensions,
        ...(r.id === 'harness.csv' ? {} : { binaryExtensions: r.extensions }),
        priority: 'extension',
        title: r.title,
        loading: 'bytes-complete',
      }), `harness: preview ${r.id}`)
    }
  })
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => {
    const disposers = renderers.map(r => ctx.slots.register({ name: 'sidebar.right.tab.document', key: r.id }, r.body))
    return () => { for (const dispose of disposers) dispose() }
  }), 'harness: preview bodies')
}
