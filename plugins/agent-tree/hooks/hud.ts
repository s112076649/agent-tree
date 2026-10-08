// Display data only: no descriptions, commands, prompts, paths or session log.
import { nodeActivity } from './activity'
import { agentLine, moreText } from './render/boxes/agents-row'
import { clamp01, flagColor, healthRow, labelOf } from './render/boxes/jev-box'
import { STATUS_GAP, statusForms } from './render/boxes/status-row'
import type { StatusView } from './render/boxes/status-row'
import type { BoxRow } from './render/layout'
import { probabilityBar } from './render/sections/jev'
import { widthOf } from './render/text'
import { COLORS } from './render/theme'

type Style = { fg?: string; b?: boolean; d?: boolean; i?: boolean }
export type HudRun = Style & ({ t: string; w: number } | { since: number })
export type HudPack = { items: HudRun[][]; sep: HudRun[]; more: HudRun[][]; maxLines: number }
export type HudLine = { forms: HudRun[][] } | { pack: HudPack }
export type HudSnapshot = { v: 1; sessionId: string; updatedAt: number; lines: HudLine[] }

/** Compact flag bars in the bottom HUD, independent of the pane's available room. */
export const HUD_FLAG_BAR = 5

const textRun = (t: string, style: Style = {}): HudRun => ({ t, w: widthOf(t), ...style })

function partRun(part: BoxRow): HudRun {
  return textRun(part.text, {
    ...(part.color === undefined ? {} : { fg: part.color }),
    ...(part.bold ? { b: true } : {}),
    ...(part.dim ? { d: true } : {}),
    ...(part.inverse ? { i: true } : {}),
  })
}

function spaced(parts: HudRun[]): HudRun[] {
  return parts.flatMap((part, index) => index === 0 ? [part] : [textRun(' '.repeat(STATUS_GAP)), part])
}

/** Display vocabulary stays in the plugin; agent packing and elapsed time are deferred to print. */
export function hudSnapshot(view: StatusView, sessionId: string, now: number): HudSnapshot {
  const forms = statusForms({ ...view, now }).map(form => form.flatMap((part, index) =>
    index === 0 ? [partRun(part)] : [textRun(' '.repeat(STATUS_GAP)), partRun(part)],
  ))
  const label = textRun('agent-tree', { d: true })
  const gap = textRun(' '.repeat(STATUS_GAP))
  const short = forms[2] ?? []
  const lines: HudLine[] = [{ forms: [...forms.map(form => [label, gap, ...form]), short] }]
  const running = view.tree.agents.filter(node => node.status === 'running')
  const segments = running.map(node => {
    const row = agentLine(node, 0, now, Number.MAX_SAFE_INTEGER, nodeActivity(view.activity, node))
    // agentLine's final word is formatAge: keep its exact narrow vocabulary,
    // but print that word from startedAt when the status command runs.
    const words = row.text.slice(0, row.text.lastIndexOf(' ') + 1)
    const style = { fg: COLORS.sub }
    return [textRun(words, style), node.startedAt === undefined || !Number.isFinite(node.startedAt)
      ? textRun('--', style) : { since: node.startedAt, ...style }] as HudRun[]
  })

  if (segments.length > 0) {
    lines.push({ pack: {
      items: segments,
      sep: [textRun(' │ ', { d: true })],
      more: segments.map((_, index) => [textRun(moreText(index + 1), { fg: COLORS.sub, d: true })]),
      maxLines: 2,
    } })
  }

  const jev = view.jev
  const score = jev.health
  const hasHealth = typeof score === 'number' && Number.isFinite(score)

  if (jev.enabled && (jev.flags.length > 0 || hasHealth)) {
    const health = hasHealth ? [partRun(healthRow(score, jev.healthLowConfidence === true, Number.MAX_SAFE_INTEGER))] : []
    const flagRuns = (bar: boolean): HudRun[] => jev.flags.map(flag => {
      const p = clamp01(flag.p)
      const cells = bar ? `${probabilityBar(p, HUD_FLAG_BAR)} ` : ''

      return textRun(`${labelOf(flag)} ${cells}${p.toFixed(2)}`, { fg: flagColor(flag) })
    })
    const form = (flags: HudRun[]): HudRun[] => spaced([textRun('jev', { fg: COLORS.jev }), ...flags, ...health])
    const flags = flagRuns(false)
    const jevForms = jev.flags.length > 0 ? [form(flagRuns(true)), form(flags)] : []

    for (let keep = flags.length - 1; keep >= 1; keep -= 1) {
      jevForms.push(form(flags.slice(0, keep)))
    }
    jevForms.push(form([]))
    lines.push({ forms: jevForms })
  }

  return { v: 1, sessionId, updatedAt: now, lines }
}
