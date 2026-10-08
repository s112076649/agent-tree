/** What the Jev box says while Jev is off (PRD M-J1). */
export const JEV_OFF = 'Jev off — enable in /plugin configure agent-tree@agent-tree'

const two = (value: number): string => String(value).padStart(2, '0')

const clamp01 = (p: number): number => (Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0)

/** `09:05:07` in local time; `--:--:--` before the first call. */
export function clockTime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) {
    return '--:--:--'
  }

  const date = new Date(ms)

  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

/** `████░░░░`: `cells` wide, filled in proportion to `p`. */
export function probabilityBar(p: number, cells: number): string {
  const room = Math.max(0, Math.floor(cells))
  const filled = Math.round(clamp01(p) * room)

  return '█'.repeat(filled) + '░'.repeat(room - filled)
}
