/**
 * Truth format v2 — timestamps (stenographer spec/truth-format, "Lines").
 *
 * A line's `ts`, and a quorum member's, is an RFC 3339 date-time naming a
 * real time. Shared by the line codec (format.ts) and the agent quorum
 * rules (quorum.ts).
 */

const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;

function daysIn(year: number, month: number): number {
  return [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * RFC 3339 date-time naming a real time (no February 30, no 24:00, no
 * offset past 23:59), as the schema's pattern and `format: date-time`
 * require, and as stenographer's codec reads it: `T` and `Z` upper case,
 * and no leap second (`:60`), which the spec lets a codec refuse.
 */
export function isRfc3339(ts: string): boolean {
  const m = RFC3339_RE.exec(ts);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59 || s > 59) return false;
  return m[9] === undefined || (Number(m[9]) <= 23 && Number(m[10]) <= 59);
}

/** An RFC 3339-shaped timestamp whose seconds are `60`: JSON Schema's date-time takes 23:59:60 UTC, and stenographer's codec refuses every leap second. */
export function isLeapSecond(ts: string): boolean {
  return RFC3339_RE.exec(ts)?.[6] === '60';
}
