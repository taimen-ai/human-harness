import { describe, expect, it } from 'vitest'
import { parseDelimited } from '../src/client/documents.tsx'

describe('CSV без библиотек', () => {
  it('кавычки, экранированные кавычки и переводы строк внутри поля', () => {
    expect(parseDelimited('a,b\n"x, y","say ""hi"""\n"multi\nline",3\r\n', ',')).toEqual([
      ['a', 'b'], ['x, y', 'say "hi"'], ['multi\nline', '3'],
    ])
  })
  it('TSV и последняя строка без перевода', () => {
    expect(parseDelimited('a\tb\n1\t2', '\t')).toEqual([['a', 'b'], ['1', '2']])
  })
})
