import type { RenderElement } from 'claude-code'

import { boxRow, fitParts, partsWidth } from '../layout'
import type { BoxRow } from '../layout'
import { COLORS } from '../theme'
import type { Kit } from '../theme'

/** The legend's title (PRD section 12). */
export const LEGEND_TITLE = 'AGENT TREE'

/** A legend entry's swatch: a block element of PRD M-L9, in the entry's color. */
export const SWATCH = '▮'

/** Columns between the legend's parts, and with less room. */
const WIDE_GAP = 3

const NARROW_GAP = 2

/** The legend's parts: the title in bold, then one entry per color of the pane. */
function parts(): BoxRow[] {
  return [
    boxRow(LEGEND_TITLE, COLORS.main, { bold: true }),
    boxRow(`${SWATCH} main`, COLORS.main),
    boxRow(`${SWATCH} subagents`, COLORS.sub),
    boxRow(`${SWATCH} fable · advisor`, COLORS.advisor),
    boxRow(`${SWATCH} jev · flags`, COLORS.jev),
  ]
}

/** The legend fitted to `width`: three columns between the parts, two with less room, then the last entries left out. */
export function legendParts(width: number): { parts: BoxRow[]; gap: number } {
  const all = parts()

  if (partsWidth(all, WIDE_GAP) <= width) {
    return { parts: all, gap: WIDE_GAP }
  }

  return { parts: fitParts(all, width, NARROW_GAP), gap: NARROW_GAP }
}

/** The legend row above the boxes (wide). */
export function renderLegend(els: Kit, width: number): RenderElement {
  const { Box, Text } = els
  const legend = legendParts(width)

  return (
    <Box flexDirection="row" gap={legend.gap}>
      {legend.parts.map(part => (
        <Text color={part.color} bold={part.bold} wrap="truncate-end">
          {part.text}
        </Text>
      ))}
    </Box>
  )
}
