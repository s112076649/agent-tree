import type { RenderElement } from 'claude-code'

import type { ActivitySnapshot, MainActivity, TreeSnapshot } from '../../../types'
import { elapsed, spinner } from '../../activity'
import { SEP } from '../../stats'
import { BORDER_STYLE, FRAME_COLUMNS } from '../layout'
import { clip, oneLine, shortModel, widthOf } from '../text'
import { COLORS } from '../theme'
import type { Kit } from '../theme'

/** The main box's title (PRD section 12). */
export const MAIN_TITLE = 'main session'

/** Columns between the title and the facts on the first line. */
const TITLE_GAP = 2

/** `opus-5-5 · medium · turn 3`: the main loop's model, effort and turn; the model `--` before the first reading. */
export function mainFacts(tree: TreeSnapshot): string {
  return [shortModel(tree.main.model) || '--', oneLine(tree.main.effort), `turn ${tree.main.turns}`]
    .filter(fact => fact !== '')
    .join(SEP)
}

/**
 * What the main loop is doing (PRD M-L3, C7b): `idle`; else behind the
 * spinner glyph of `frame`, `thinking` or `tooling <tool>`, and the time
 * since the phase began: `◐ tooling Read 2s`.
 */
export function mainStatus(main: MainActivity, frame: number, now: number): string {
  if (main.phase === 'idle') {
    return 'idle'
  }

  const tool = main.phase === 'tooling' ? oneLine(main.tool) : ''

  return [spinner(frame), main.phase, tool, elapsed(now, main.since)].filter(part => part !== '').join(' ')
}

/** What the main box draws from: the tree's main row, the activity, the frame, the time it is drawn at. */
export type MainView = {
  tree: TreeSnapshot
  activity: ActivitySnapshot
  frame: number
  now: number
}

/** Whether the main loop is active: its box is lit, its title bold (PRD M-L3). */
export function isMainActive(activity: ActivitySnapshot): boolean {
  return activity.main.phase !== 'idle'
}

/** The main box's two lines (layout.ts MAIN_LINES), fitted to the box's text room. */
export type MainLines = {
  /** First line: the title, in bold while the main loop is active. */
  title: string
  /** First line, beside the title: the facts; empty when the title leaves no room. */
  facts: string
  /** Second line. */
  status: string
}

export function mainLines(view: MainView, inner: number): MainLines {
  const title = clip(MAIN_TITLE, inner)
  const room = inner - widthOf(title) - TITLE_GAP

  return {
    title,
    facts: room >= 1 ? clip(mainFacts(view.tree), room) : '',
    status: clip(mainStatus(view.activity.main, view.frame, view.now), inner),
  }
}

/**
 * The main box (orange): `main session` with the model, effort and turn
 * beside it, then the status. Active (PRD M-L3): the border in its color and
 * the title bold; idle: the border dim, the title plain.
 */
export function renderMainBox(els: Kit, view: MainView, width: number): RenderElement {
  const { Box, Text } = els
  const lines = mainLines(view, width - FRAME_COLUMNS)
  const isActive = isMainActive(view.activity)

  return (
    <Box
      flexDirection="column"
      borderStyle={BORDER_STYLE}
      borderColor={COLORS.main}
      borderDimColor={!isActive}
      paddingX={1}
      width={width}
    >
      <Box flexDirection="row" gap={TITLE_GAP}>
        <Text color={COLORS.main} bold={isActive} wrap="truncate-end">
          {lines.title}
        </Text>
        {lines.facts === '' ? null : (
          <Text color={COLORS.main} wrap="truncate-end">
            {lines.facts}
          </Text>
        )}
      </Box>
      <Text color={COLORS.main} wrap="truncate-end">
        {lines.status}
      </Text>
    </Box>
  )
}
