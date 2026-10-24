/**
 * A mail date as an instant, read by hand where the runtime's `Date` parser differs. The phone runs
 * Hermes, which refuses common RFC 5322 Date headers (no weekday, no seconds, `UT`, `+02:00`, a
 * lower-case month; measured on a device) and reads a two-digit year as year 26. mailparser then
 * stores the time of the parse as the sent date, and imapflow leaves the ENVELOPE date a string.
 *
 * Reads RFC 5322 dates, their obsolete forms (two-digit years, comments) with the zone names below,
 * and the RFC 3501 date-time, the way Node reads them where Node reads them at all (the sent date is in
 * every stored `fp1` key). Anything else goes to the runtime's parser. A valid Date passes; null otherwise.
 */
const MONTHS = "january february march april may june july august september october november december".split(" ");
// Minutes east of UTC. RFC 5322's names, then common ones whose meaning is known out of band (§4.3).
// Ambiguous names (IST, AST) and the military letters are left to the runtime.
const ZONES: Record<string, number> = {
  ut: 0, utc: 0, gmt: 0, z: 0, edt: -240, est: -300, cdt: -300, cst: -360, mdt: -360, mst: -420, pdt: -420, pst: -480,
  wet: 0, west: 60, bst: 60, cet: 60, mez: 60, cest: 120, mesz: 120, eet: 120, eest: 180, msk: 180,
  hkt: 480, sgt: 480, awst: 480, jst: 540, kst: 540, acst: 570, acdt: 630, aest: 600, aedt: 660, nzst: 720, nzdt: 780,
  hst: -600, akst: -540, akdt: -480, adt: -180, nst: -210, ndt: -150, brt: -180, art: -180,
};
const FORM =
  /^(?:[a-z]+,?\s*)?(\d{1,2})[\s-]+([a-z]{3,9})\.?[\s-]+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?\s*(?:([a-z]{1,5})?\s*(?:([+-])(\d{2}):?(\d{2}))?)$/i;
/** No real Date header is longer; a longer one goes straight to the runtime. */
const MAX_READ = 300;

export function mailDate(v: unknown): Date | null {
  if (v instanceof Date) return twoDigitYear(v);
  if (typeof v !== "string") return null;
  const s = v.length > MAX_READ ? null : uncomment(v);
  const m = s === null ? null : FORM.exec(s.replace(/\s+/g, " ").trim());
  const read = m === null ? null : fromParts(m);
  if (read !== null) return read;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? twoDigitYear(new Date(t)) : null;
}

/** The string with its (nested) comments as spaces, in one pass; null when they do not balance. */
function uncomment(v: string): string | null {
  let out = "";
  let depth = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (depth > 0) {
      if (c === "\\") i++;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) out += " ";
    } else if (c === "(") depth = 1;
    else if (c === ")") return null;
    else out += c;
  }
  return depth === 0 ? out : null;
}

/** A Date in years 0-99 is a two-digit year the runtime read literally (Hermes: "24 Oct 26" is year 26). */
function twoDigitYear(d: Date): Date | null {
  if (!Number.isFinite(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 0 || y > 99) return d;
  const out = new Date(d.getTime());
  out.setUTCFullYear(y + (y < 50 ? 2000 : 1900));
  return out;
}

function fromParts(m: RegExpExecArray): Date | null {
  const name = m[2]!.toLowerCase();
  const month = MONTHS.findIndex((full) => full === name || full.slice(0, 3) === name);
  if (month < 0) return null;
  const word = m[8]?.toLowerCase();
  // No zone, a clock word or an unknown name: left to the runtime, as before.
  if (word === "am" || word === "pm" || (m[9] === undefined && (word === undefined || ZONES[word] === undefined))) return null;
  // Years 0-99 of any width are two-digit years, as Node reads them; a 3-digit one is 1900 + it (RFC 5322 §4.3).
  let year = Number(m[3]);
  if (year < 100) year += year < 50 ? 2000 : 1900;
  else if (m[3]!.length === 3) year += 1900;
  const [day, hh, mm, ss] = [m[1], m[4], m[5], m[6] ?? "0"].map(Number) as [number, number, number, number];
  if (day < 1 || hh > 23 || mm > 59 || ss > 60) return null;
  const ms = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, "0"));
  // An offset wins over a name.
  const zone = m[9] !== undefined ? (m[9] === "-" ? -1 : 1) * (Number(m[10]) * 60 + Number(m[11])) : ZONES[word!]!;
  if (Math.abs(zone) > 24 * 60 || Number(m[11] ?? 0) > 59) return null;
  const local = Date.UTC(year, month, day, hh, mm, Math.min(ss, 59), ms);
  if (new Date(local).getUTCDate() !== day) return null; // 31 Feb is no date
  return new Date(local - zone * 60_000);
}
