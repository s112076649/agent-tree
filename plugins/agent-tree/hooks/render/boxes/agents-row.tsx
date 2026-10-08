import type { RenderElement } from 'claude-code'

import type { ActivitySnapshot, AgentNode, AgentRole, TreeSnapshot } from '../../../types'
import { nodeActivity } from '../../activity'
import type { NodeActivity } from '../../activity'
import { roleOf } from '../../role'
import { SEP } from '../../stats'
import { flatten } from '../../tree'
import { BORDER_STYLE, FRAME_COLUMNS, GAP, boxRow, spinnerGlyph } from '../layout'
import type { BoxRow, Geometry } from '../layout'
import { clip, durationOf, formatAge, limitRows, oneLine, shortModel, toneOf, widthOf } from '../text'
import type { Tone } from '../text'
import { COLORS } from '../theme'
import type { Kit } from '../theme'

/** What the subagents row says before the first subagent. */
export const NO_SUBAGENTS = 'no subagents yet'

const DONE_GLYPH = '✓'

const FAIL_GLYPH = '✗'

/**
 * A node's role (PRD M-L1a): as the tree recorded it, or, for a node kept in
 * the state from before C7a (it has none), roleOf's reading of its type and
 * description.
 */
export function roleWord(node: AgentNode): AgentRole {
  return node.role === 'worker' || node.role === 'researcher'
    ? node.role
    : roleOf({ type: node.type, description: node.description })
}

/** Running: the spinner glyph of `frame`; done `✓`; failed or killed `✗`. */
function glyphOf(node: AgentNode, frame: number): string {
  const tone = toneOf(node.status)

  return tone === 'run' ? spinnerGlyph(frame) : tone === 'done' ? DONE_GLYPH : FAIL_GLYPH
}

/** Whether a node is drawn running (the spinner): its box is lit and its title bold (PRD M-L3, C7b). */
export function isDrawnRunning(node: AgentNode): boolean {
  return toneOf(node.status) === 'run'
}

/** The type as the tree table drew it: `Explore`, `Explore bg`. */
function typeOf(node: AgentNode): string {
  const type = oneLine(node.type) || 'agent'

  return node.background === true ? `${type} bg` : type
}

/**
 * `Glob/3`: the tool and the calls; the tool is the one in flight (`live`,
 * C7b), else the last one. Nothing before the first call, nor for an
 * external worker (PRD M-L1b: its tools are not seen).
 */
function toolOf(node: AgentNode, live?: NodeActivity): string {
  return node.kind !== 'external' && node.toolCalls > 0 ? `${oneLine(live?.tool ?? node.lastTool) || '?'}/${node.toolCalls}` : ''
}

const joined = (parts: readonly string[]): string => parts.filter(part => part !== '').join(' ')

/** A subagent's row as the tree drew it: running blue, finished dim, failed (or killed) red. */
function toneRow(text: string, tone: Tone, bold: boolean = false): BoxRow {
  return boxRow(text, tone === 'fail' ? COLORS.fail : COLORS.sub, { dim: tone === 'done', bold })
}

/** Type characters worth keeping when `<model> · <type>` is cut: fewer, and the model is drawn alone. */
const MIN_TYPE_SHOWN = 3

/**
 * `<model> · <type>` fitted to `inner` (PRD M-L1a, M-L1b): whole when it
 * fits; else the model whole, ` · ` and the type cut with `clip`, when that
 * keeps three characters of the type at least (`sonnet-5-5 · Exp~`); else the
 * model alone, cut only when it alone is wider than `inner`. The type alone
 * while no model is known. An external worker's type is its engine:
 * `chatgpt-6.1sol · codex`.
 */
export function kindText(node: AgentNode, inner: number): string {
  const type = typeOf(node)
  const model = shortModel(node.model)

  if (model === '') {
    return clip(type, inner)
  }

  const both = `${model}${SEP}${type}`

  if (widthOf(both) <= inner) {
    return both
  }

  return inner - 1 - widthOf(`${model}${SEP}`) >= MIN_TYPE_SHOWN ? clip(both, inner) : clip(model, inner)
}

/**
 * A wide subagent box's rows (PRD M-L1a, section 12): the role as the title,
 * in bold while it runs (C7b); `<model> · <type>` (kindText); the
 * description; the status glyph, the tool (the one in flight, `live`, else
 * the last) and its calls, the running time. An external worker's box (PRD
 * M-L1b) is the same in the same blue: `<model> · <engine>`, its task, no
 * tool calls.
 */
export function agentBoxRows(node: AgentNode, frame: number, now: number, inner: number, live?: NodeActivity): BoxRow[] {
  const tone = toneOf(node.status)

  return [
    toneRow(clip(roleWord(node), inner), tone, tone === 'run'),
    toneRow(kindText(node, inner), tone),
    toneRow(clip(oneLine(node.description) || '--', inner), tone),
    toneRow(clip(joined([glyphOf(node, frame), toolOf(node, live), formatAge(durationOf(node, now))]), inner), tone),
  ]
}

/**
 * A narrow subagent line: `◐ researcher sonnet-5-5 Explore Grep/3 48s`, the
 * glyph, role, model (left out while unknown), type, tool (as in the box) and
 * running time. An external worker's names its model first, as a subagent's
 * does, and has no tool: `◐ worker kimi-code/k3 kimi 2m10s`.
 */
export function agentLine(node: AgentNode, frame: number, now: number, inner: number, live?: NodeActivity): BoxRow {
  const text = joined([
    glyphOf(node, frame),
    roleWord(node),
    shortModel(node.model),
    typeOf(node),
    toolOf(node, live),
    formatAge(durationOf(node, now)),
  ])

  return toneRow(clip(text, inner), toneOf(node.status))
}

/** `+7 more`: the subagents left out. */
export function moreText(hidden: number): string {
  return `+${hidden} more`
}

/**
 * The subagents drawn in `room` places: all of them when they fit, else the
 * latest in tree order and a `+k more` in the last place (limitRows).
 */
export function shownAgents(tree: TreeSnapshot, room: number): { shown: AgentNode[]; hidden: number } {
  return limitRows(flatten(tree).map(flat => flat.node), Math.max(1, Math.floor(room)))
}

/** The empty-state box: just wide enough for NO_SUBAGENTS, and no wider than `room`. */
export function emptyBoxWidth(room: number): number {
  return Math.min(room, widthOf(NO_SUBAGENTS) + FRAME_COLUMNS)
}

/**
 * The centre column of each box on the wide row's first line, `lines` lines
 * being allowed: the fan's arrows point at them (connectors.tsx). Before the
 * first subagent, the empty-state box's centre alone.
 */
export function boxCentres(tree: TreeSnapshot, geo: Geometry, lines: number): number[] {
  if (tree.agents.length === 0) {
    return [Math.floor(emptyBoxWidth(geo.column) / 2)]
  }

  const { shown, hidden } = shownAgents(tree, lines * geo.perLine)
  const boxes = Math.max(1, Math.min(geo.perLine, shown.length + (hidden > 0 ? 1 : 0)))

  return Array.from({ length: boxes }, (_, index) => index * (geo.agentBox + GAP) + Math.floor(geo.agentBox / 2))
}

/** What the subagent boxes draw from. */
export type AgentsView = {
  tree: TreeSnapshot
  /** The tools in flight (C7b): a running subagent's current tool. */
  activity: ActivitySnapshot
  frame: number
  now: number
}

/** Whether one of the `hidden` nodes that `+k more` stands for runs: then its box is lit too. */
function isHiddenRunning(tree: TreeSnapshot, hidden: number): boolean {
  return flatten(tree)
    .slice(0, Math.max(0, hidden))
    .some(flat => isDrawnRunning(flat.node))
}

/** A box of the subagents' blue; `isDim`: nothing in it runs, its border is dim (PRD M-L3). */
function framed(els: Kit, width: number, rows: readonly BoxRow[], isDim: boolean): RenderElement {
  const { Box, Text } = els

  return (
    <Box
      flexDirection="column"
      borderStyle={BORDER_STYLE}
      borderColor={COLORS.sub}
      borderDimColor={isDim}
      paddingX={1}
      width={width}
    >
      {rows.map(row => (
        <Text color={row.color} dimColor={row.dim} bold={row.bold} wrap="truncate-end">
          {row.text}
        </Text>
      ))}
    </Box>
  )
}

/**
 * The wide subagents row (blue): a box per subagent, `geo.perLine` to a
 * line, wrapping onto at most `lines` lines; past them the latest keep their
 * boxes and a `+k more` box takes the last place. A running subagent's box
 * is lit, a finished one's dim (C7b); the `+k more` box is lit while one it
 * stands for runs. Before the first subagent, one small dim box.
 */
export function renderAgentsRow(els: Kit, view: AgentsView, geo: Geometry, lines: number): RenderElement {
  const { Box } = els

  if (view.tree.agents.length === 0) {
    const width = emptyBoxWidth(geo.column)

    return framed(els, width, [boxRow(clip(NO_SUBAGENTS, width - FRAME_COLUMNS), COLORS.sub, { dim: true })], true)
  }

  const { shown, hidden } = shownAgents(view.tree, lines * geo.perLine)
  const boxes = shown.map(node =>
    framed(
      els,
      geo.agentBox,
      agentBoxRows(node, view.frame, view.now, geo.agentInner, nodeActivity(view.activity, node)),
      !isDrawnRunning(node),
    ),
  )

  if (hidden > 0) {
    const more = [boxRow(clip(moreText(hidden), geo.agentInner), COLORS.sub, { dim: true })]

    boxes.push(framed(els, geo.agentBox, more, !isHiddenRunning(view.tree, hidden)))
  }

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={GAP} width={geo.column}>
      {boxes}
    </Box>
  )
}

/**
 * The narrow subagents box (blue): a line per subagent (agentLine), at most
 * `lines`: past them the latest keep their lines and `+k more` takes the
 * last. Lit while a subagent runs, dim otherwise (C7b). Before the first
 * subagent, one dim line.
 */
export function renderAgentsBox(els: Kit, view: AgentsView, geo: Geometry, lines: number): RenderElement {
  if (view.tree.agents.length === 0) {
    return framed(els, geo.agentBox, [boxRow(clip(NO_SUBAGENTS, geo.agentInner), COLORS.sub, { dim: true })], true)
  }

  const { shown, hidden } = shownAgents(view.tree, lines)
  const rows = shown.map(node => agentLine(node, view.frame, view.now, geo.agentInner, nodeActivity(view.activity, node)))

  if (hidden > 0) {
    rows.push(boxRow(clip(moreText(hidden), geo.agentInner), COLORS.sub, { dim: true }))
  }

  return framed(els, geo.agentBox, rows, !view.tree.agents.some(isDrawnRunning))
}
