import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ControlPlaneClient } from '../src/client.ts'
import { fetchArtifact, fileNameOf, isActiveContent } from '../src/artifact-files.ts'

const ID = '0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5'

function client(body: string, headers: Record<string, string>, record: Record<string, unknown> = { contentState: 'stored' }) {
  return {
    getArtifact: async () => ({ id: ID, type: 'document', name: 'x', uri: null, content: null, createdAt: 'a', ...record }),
    artifactContent: async () => new Response(body, { headers }),
  } as unknown as ControlPlaneClient
}

describe('документ ядра в рабочий каталог беседы', () => {
  it('имя из Content-Disposition без каталогов и управляющих символов', () => {
    expect(fileNameOf("inline; filename*=UTF-8''%D0%90%D0%BA%D1%82.docx", ID)).toBe('Акт.docx')
    expect(fileNameOf('attachment; filename="../../etc/passwd"', ID)).toBe('_.._etc_passwd')
    expect(fileNameOf(null, ID)).toBe(ID)
  })

  it('активное содержимое распознаётся', () => {
    expect(isActiveContent('text/html; charset=utf-8')).toBe(true)
    expect(isActiveContent('image/svg+xml')).toBe(true)
    expect(isActiveContent('application/pdf')).toBe(false)
    expect(isActiveContent('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(false)
  })

  it('файл ложится в .artifacts/<id8>/, HTML — как текст', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-'))
    const docx = await fetchArtifact(client('PK..', { 'content-type': 'application/pdf', 'content-disposition': "inline; filename*=UTF-8''report.pdf" }), dir, ID)
    expect(docx).toMatchObject({ path: `.artifacts/${ID.slice(0, 8)}/report.pdf`, shownAsText: false, bytes: 4 })
    expect(readFileSync(join(dir, docx.path), 'utf8')).toBe('PK..')
    const html = await fetchArtifact(client('<script>x</script>', { 'content-type': 'text/html', 'content-disposition': 'attachment; filename="page.html"' }), dir, ID)
    expect(html.path.endsWith('page.html.txt')).toBe(true)
    expect(html.shownAsText).toBe(true)
  })

  it('у артефакта без файла — его запись JSON файлом и в ответе; ссылка — как есть', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-'))
    const summary = await fetchArtifact(client('', {}, { contentState: 'none', type: 'report', content: { summary: 'Готово' } }), dir, ID)
    expect(summary).toMatchObject({ path: `.artifacts/${ID.slice(0, 8)}/report.json`, mediaType: 'application/json', record: { content: { summary: 'Готово' }, uri: null } })
    expect(JSON.parse(readFileSync(join(dir, summary.path), 'utf8'))).toEqual({ summary: 'Готово' })
    const link = await fetchArtifact(client('', {}, { contentState: 'none', uri: 'https://git.example/pr/1' }), dir, ID)
    expect(link).toMatchObject({ path: '', record: { content: null, uri: 'https://git.example/pr/1' } })
    await expect(fetchArtifact(client('', {}, { contentState: 'purged' }), dir, ID)).rejects.toThrow(/удалено/)
  })

  it('не uuid — отказ без запроса в ядро', async () => {
    await expect(fetchArtifact(client('', {}), '/tmp', '../x')).rejects.toThrow(/uuid/)
  })
})

describe('сдача файла результатом работы (H008b)', () => {
  it('читается только файл внутри рабочего каталога, тип — по расширению', async () => {
    const { mkdirSync, symlinkSync, writeFileSync } = await import('node:fs')
    const { readWorkspaceFile } = await import('../src/artifact-files.ts')
    const root = mkdtempSync(join(tmpdir(), 'ws-'))
    mkdirSync(join(root, 'reports'))
    writeFileSync(join(root, 'reports', 'akt.docx'), 'PK')
    const outside = mkdtempSync(join(tmpdir(), 'out-'))
    writeFileSync(join(outside, 'secret.txt'), 'x')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
    const file = readWorkspaceFile(root, 'reports/akt.docx')
    expect(file).toMatchObject({ name: 'akt.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    expect(() => readWorkspaceFile(root, '../' + outside.split('/').pop() + '/secret.txt')).toThrow(/вне рабочего каталога/)
    expect(() => readWorkspaceFile(root, join(outside, 'secret.txt'))).toThrow(/вне рабочего каталога/)
    expect(() => readWorkspaceFile(root, 'link.txt')).toThrow(/вне рабочего каталога/)
    expect(() => readWorkspaceFile(root, 'reports')).toThrow(/не файл/)
  })
})
