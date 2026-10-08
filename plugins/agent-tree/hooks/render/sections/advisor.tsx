/** What stands for the advice: the API returns it encrypted (`advisor_redacted_result`), so it is never shown (PRD M-A2). */
export const ADVICE_NOTE = 'advice: encrypted by API'

/** The advisor line before the first call. */
export const NO_CALLS = 'advisor: no calls yet'

/** `14:03:27`: a time of day, local. */
export function clockTime(ms: number): string {
  const at = new Date(ms)
  const two = (value: number): string => String(value).padStart(2, '0')

  return `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`
}
