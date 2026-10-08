import { expect, test } from 'claude-code/testing'
import { formatDuration, renderLines } from '../statusline/hud-print.mjs'
import { formatAge, widthOf } from './render/text'
import type { HudPack } from './hud'

test('HUD duration parity from 0 ms through 10 h', () => {
  for (let ms = 0; ms <= 36_000_000; ms += 1000) {
    expect(formatDuration(ms)).toBe(formatAge(ms))
    expect(formatDuration(ms - 1)).toBe(formatAge(ms - 1))
  }
  expect(renderLines({ v: 1, sessionId: 's', updatedAt: 0, lines: [] }, 's', 120, 0)).toEqual([])
})

const snapshot = (forms: unknown[]) => ({ v: 1, sessionId: 's', updatedAt: 1000, lines: [{ forms }] })
const text = (t: string) => ({ t, w: widthOf(t) })

test('HUD stale boundary, version and session isolation', () => {
  const value = snapshot([[text('hud')]])
  expect(renderLines(value, 's', 120, 121000)).toEqual(['hud'])
  expect(renderLines(value, 's', 120, 121001)).toEqual([])
  expect(renderLines(value, 'other', 120, 1000)).toEqual([])
  expect(renderLines({ ...value, v: 2 }, 's', 120, 1000)).toEqual([])
})

test('HUD first fitting form, default columns and minimum room', () => {
  const value = snapshot([[text('wide text')], [text('short')]])
  expect(renderLines(value, 's', '13', 1000)).toEqual(['wide text'])
  expect(renderLines(value, 's', '9', 1000)).toEqual(['short'])
  for (const columns of [undefined, '', 'x', '12x', 0, -1, 1.5, Infinity]) {
    expect(renderLines(value, 's', columns, 1000)).toEqual(['wide text'])
  }
  expect(renderLines(value, 's', 1, 1000)).toEqual(['~'])
})

test('HUD whole leading runs, cut marker, CJK first-run clip and gap removal', () => {
  expect(renderLines(snapshot([[text('abc'), text('  '), text('def')]]), 's', 10, 1000)).toEqual(['abc~'])
  expect(renderLines(snapshot([[text('界界a')]]), 's', 8, 1000)).toEqual(['界~'])
  expect(renderLines(snapshot([[text('abc'), text('def')]]), 's', 10, 1000)).toEqual(['abcdef'])
})

test('HUD since run recalculates its width when the minute changes', () => {
  const value = snapshot([[text('run '), { since: 0 }], [text('r '), { since: 0 }]])
  expect(renderLines(value, 's', 11, 59000)).toEqual(['run 59s'])
  expect(renderLines(value, 's', 11, 60000)).toEqual(['r 1m00s'])
})

test('HUD truecolor, bold, dim, inverse and a reset after every styled run', () => {
  const value = snapshot([[{ t: 'one', w: 3, fg: '#58a6ff', b: true, d: true, i: true }, text('two')]])
  expect(renderLines(value, 's', 120, 1000)).toEqual(['\u001b[38;2;88;166;255;1;2;7mone\u001b[0mtwo'])
  expect(renderLines(snapshot([[{ t: 'x', w: 1, fg: 'bogus' }]]), 's', 120, 1000)).toEqual(['x'])
})

test('HUD malformed data is silent and text cannot inject terminal escapes', () => {
  for (const value of [null, {}, { ...snapshot([]), updatedAt: NaN }, snapshot([null]), snapshot([[{ t: 'x', w: -1 }]]), snapshot([[{ since: Infinity }]])]) {
    expect(renderLines(value, 's', 120, 1000)).toEqual([])
  }
  expect(renderLines(snapshot([[{ t: '\u001b[2J\nX', w: 7 }]]), 's', 120, 1000)).toEqual([' [2J X'])
})

const packed = (words: string[], maxLines = 2, sep = ' │ ', markers = words.map((_, index) => `+${index + 1} more`)) => {
  const pack: HudPack = { items: words.map(word => [text(word)]), sep: [text(sep)], more: markers.map(marker => [text(marker)]), maxLines }
  return { v: 1, sessionId: 's', updatedAt: 1000, lines: [{ pack }] }
}

test('HUD pack fills lines in segment order and counts the separator width', () => {
  expect(renderLines(packed(['aaa', 'bbb', 'ccc', 'ddd']), 's', 13, 1000)).toEqual(['aaa │ bbb', 'ccc │ ddd'])
  expect(renderLines(packed(['aaa', 'bbb']), 's', 12, 1000)).toEqual(['aaa', 'bbb'])
  expect(renderLines(packed(['aaa', 'bbb']), 's', 13, 1000)).toEqual(['aaa │ bbb'])
})

test('HUD pack marker appears on the last line only, using the exact hidden count', () => {
  expect(renderLines(packed(['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE'], 2, '|'), 's', 16, 1000)).toEqual(['AAAA|BBBB', 'CCCC|+2 more'])
})

test('HUD pack hidden count grows when trailing segments are dropped to fit the marker', () => {
  expect(renderLines(packed(['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE'], 2, '|'), 's', 13, 1000)).toEqual(['AAAA|BBBB', '+3 more'])
  expect(renderLines(packed(['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE', 'FFFF', 'GGGG'], 2, '|'), 's', 18, 1000)).toEqual(['AAAA|BBBB|CCCC', 'DDDD|+3 more'])
})

test('HUD pack can print a lone marker with no leading separator, or cut the marker alone', () => {
  expect(renderLines(packed(['AAAA', 'BBBB', 'CCCC'], 1, '|'), 's', 12, 1000)).toEqual(['+3 more'])
  expect(renderLines(packed(['AAAA', 'BBBB', 'CCCC'], 1, '|'), 's', 8, 1000)).toEqual(['+3 ~'])
})

test('HUD pack cuts one oversize segment through fitRuns and keeps its style', () => {
  const value = packed(['界界abcdef'])
  value.lines[0].pack.items[0][0] = { ...text('界界abcdef'), fg: '#58a6ff' }
  expect(renderLines(value, 's', 10, 1000)).toEqual(['\u001b[38;2;88;166;255m界界a\u001b[0m~'])
})

test('HUD pack honors maxLines one and formats since runs at print time', () => {
  expect(renderLines(packed(['aaa', 'bbb', 'ccc', 'ddd'], 1, '|'), 's', 16, 1000)).toEqual(['aaa|+3 more'])
  const value = packed(['x', 'y'])
  value.lines[0].pack.items[0] = [text('a '), { since: 0 }]
  value.lines[0].pack.items[1] = [text('b '), { since: 0 }]
  expect(renderLines(value, 's', 17, 59000)).toEqual(['a 59s │ b 59s'])
  expect(renderLines(value, 's', 17, 60000)).toEqual(['a 1m00s', 'b 1m00s'])
})

test('HUD pack counts all runs and preserves styled separators and markers', () => {
  const value = packed(['AAA', 'BBB', 'CCC'], 1, ' │ ', ['+1', '+2', '+3'])
  value.lines[0].pack.items[0] = [text('A'), text('AA')]
  value.lines[0].pack.sep = [{ ...text(' │ '), d: true }]
  value.lines[0].pack.more[1] = [{ ...text('+2'), fg: '#58a6ff', d: true }]
  expect(renderLines(value, 's', 12, 1000)).toEqual(['AAA\u001b[2m │ \u001b[0m\u001b[38;2;88;166;255;2m+2\u001b[0m'])
})

test('HUD output is capped at four lines across forms and multiple packs', () => {
  const value = packed(['AAAA', 'BBBB', 'CCCC', 'DDDD'], 4)
  const forms = { forms: [[text('status')]] }
  expect(renderLines({ ...value, lines: [forms, ...value.lines, forms] }, 's', 12, 1000)).toEqual(['status', 'AAAA', 'BBBB', 'CCCC'])
  expect(renderLines({ ...value, lines: Array.from({ length: 6 }, () => forms) }, 's', 120, 1000)).toEqual(['status', 'status', 'status', 'status'])
  expect(renderLines({ ...value, lines: [...value.lines, ...value.lines] }, 's', 12, 1000)).toEqual(['AAAA', 'BBBB', 'CCCC', 'DDDD'])
})

for (const [name, change] of [
  ['missing pack', () => undefined],
  ['null pack', () => null],
  ['empty items', pack => ({ ...pack, items: [] })],
  ['nonarray items', pack => ({ ...pack, items: {} })],
  ['nonarray item', pack => ({ ...pack, items: [null] })],
  ['nonarray sep', pack => ({ ...pack, sep: null })],
  ['nonarray more', pack => ({ ...pack, more: null })],
  ['short more', pack => ({ ...pack, more: [[]] })],
  ['nonarray marker', pack => ({ ...pack, more: [[], null] })],
  ['nonarray extra marker', pack => ({ ...pack, more: [[], [], null] })],
  ['missing maxLines', pack => ({ ...pack, maxLines: undefined })],
  ['zero maxLines', pack => ({ ...pack, maxLines: 0 })],
  ['five maxLines', pack => ({ ...pack, maxLines: 5 })],
  ['fractional maxLines', pack => ({ ...pack, maxLines: 1.5 })],
  ['string maxLines', pack => ({ ...pack, maxLines: '2' })],
  ['invalid item run', pack => ({ ...pack, items: [[{ t: 'bad', w: -1 }], []] })],
  ['invalid separator run', pack => ({ ...pack, sep: [{ since: Infinity }] })],
  ['invalid hidden marker run', pack => ({ ...pack, more: [[], [null]] })],
] as [string, (pack: ReturnType<typeof packed>['lines'][number]['pack']) => unknown][]) {
  test(`HUD invalid pack is silent: ${name}`, () => {
    const value = packed(['a', 'b'])
    expect(renderLines({ ...value, lines: [{ forms: [[text('valid')]] }, { pack: change(value.lines[0].pack) }] }, 's', 120, 1000)).toEqual([])
  })
}

test('HUD invalid line after the four-line cap still makes the whole snapshot silent', () => {
  const value = snapshot([[text('valid')]])
  expect(renderLines({ ...value, lines: [...Array.from({ length: 4 }, () => value.lines[0]), {}] }, 's', 120, 1000)).toEqual([])
})

test('HUD a line with both forms and pack is invalid', () => {
  const value = packed(['a'])
  expect(renderLines({ ...value, lines: [{ ...value.lines[0], forms: [[text('ambiguous')]] }] }, 's', 120, 1000)).toEqual([])
})
