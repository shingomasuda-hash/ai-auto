/**
 * 保存はUTC、表示はJST(+09:00, DSTなし)。
 * DBには timestamptz を使い、アプリ内では常に Date(=UTC瞬間) で扱う。
 */

export const JST_OFFSET_MINUTES = 9 * 60;

/** JSTの壁時計表現。 */
export type JstParts = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
};

export function toJstParts(instant: Date): JstParts {
  const shifted = new Date(instant.getTime() + JST_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** JSTの壁時計をUTCの瞬間に変換する。 */
export function fromJstParts(parts: JstParts): Date {
  const utcMillis = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  return new Date(utcMillis - JST_OFFSET_MINUTES * 60_000);
}

/** `2026-04-01T09:30` 形式(datetime-local, JST前提)をUTCのDateへ。 */
export function parseJstLocalInput(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) throw new RangeError(`invalid JST datetime-local value: ${value}`);
  const parts: JstParts = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
  };
  if (parts.month < 1 || parts.month > 12) throw new RangeError('month out of range');
  if (parts.day < 1 || parts.day > 31) throw new RangeError('day out of range');
  if (parts.hour > 23 || parts.minute > 59) throw new RangeError('time out of range');
  const instant = fromJstParts(parts);
  // 2月30日のような不正な日付は正規化されてしまうので往復で検証する。
  const round = toJstParts(instant);
  if (round.year !== parts.year || round.month !== parts.month || round.day !== parts.day) {
    throw new RangeError(`invalid calendar date: ${value}`);
  }
  return instant;
}

/** UTCのDateを datetime-local 入力用のJST文字列へ。 */
export function toJstLocalInput(instant: Date): string {
  const p = toJstParts(instant);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

export function formatJst(instant: Date | null): string {
  if (instant === null) return '—';
  const p = toJstParts(instant);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}/${pad(p.month)}/${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} JST`;
}

/** JSTの暦日キー(YYYY-MM-DD)。1日あたりの上限判定に使う。 */
export function jstDateKey(instant: Date): string {
  const p = toJstParts(instant);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** JSTの月キー(YYYY-MM)。月次予算・月次集計に使う。 */
export function jstMonthKey(instant: Date): string {
  const p = toJstParts(instant);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

/** JST月の開始/終了(UTC瞬間, 終了は排他)。 */
export function jstMonthRange(monthKey: string): { startUtc: Date; endUtcExclusive: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) throw new RangeError(`invalid month key: ${monthKey}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new RangeError(`invalid month key: ${monthKey}`);
  const startUtc = fromJstParts({ year, month, day: 1, hour: 0, minute: 0 });
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const endUtcExclusive = fromJstParts({ year: nextYear, month: nextMonth, day: 1, hour: 0, minute: 0 });
  return { startUtc, endUtcExclusive };
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
