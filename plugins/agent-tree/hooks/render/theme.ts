// Colors of the pane (PRD section 12): text colors only, no backgrounds, so a
// light theme stays readable. A finished row is drawn dim rather than in a
// color of its own.

import type { Elements } from 'claude-code'

export const COLORS = {
  main: '#f0883e',
  sub: '#58a6ff',
  advisor: '#bc8cff',
  jev: '#56d364',
  fail: '#f85149',
} as const

/**
 * The elements a section draws with: the table register.tsx got from
 * `$.ui.resolve(e)` for the surface being drawn (terminal and desktop both
 * carry Box and Text).
 */
export type Kit = Pick<Elements['terminal'], 'Box' | 'Text'>
