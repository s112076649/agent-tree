import type { StatsSnapshot, TreeSnapshot } from '../../../types'
import { statsSegments } from '../../stats'
import { packSegments } from '../text'

/** What the stats line draws from: the figures, the tree for the agent count, the time the clock runs to. */
export type StatsView = {
  tree: TreeSnapshot
  stats: StatsSnapshot
  now: number
}

/** `ctx 6% (61k/1M) · $1.34 · 5h 57% · 7d 53% · agents 1/3 · 00:12:34`, wrapped between segments. */
export function statsLines(view: StatsView, width: number): string[] {
  return packSegments(statsSegments(view.tree, view.stats, view.now), width)
}
