/**
 * The calendar test accounts, read for a LIVE bench run on the workstation and nowhere else.
 *
 * The file's path comes from `env.OHCAL_TEST_ACCOUNTS_FILE` only: there is no default, so a run that was
 * not handed the file fails instead of finding one. One parse rule, the rig's own (`calaccounts.py`): a
 * trimmed line matching `^([A-Z][A-Z0-9_]*)=(.*)$`. No quotes, no `export`.
 *
 * Every value is a `Secret`. It prints as `[secret]` in a string, in JSON and in `util.inspect`, so an
 * assertion diff or a stray log line shows the redaction. `reveal()` is for the two clients' request
 * builders; everything else asks a yes-or-no question (`is`, `test`) or has the value taken OUT of a text
 * (`redactIn`).
 */
import { readFileSync } from "node:fs";
import { inspect } from "node:util";

const REDACTED = "[secret]";

export class Secret {
  readonly #v: string;
  constructor(value: string) {
    this.#v = value;
  }
  /** The value itself. Call it only where a request is built. */
  reveal(): string {
    return this.#v;
  }
  get filled(): boolean {
    return this.#v !== "";
  }
  /** Is this value that text? Letter case aside, as addresses compare. */
  is(other: string | Secret): boolean {
    const text = typeof other === "string" ? other : other.#v;
    return this.#v !== "" && this.#v.toLowerCase() === text.toLowerCase();
  }
  test(pattern: RegExp): boolean {
    return pattern.test(this.#v);
  }
  /**
   * `text` with every written form of the value replaced: raw, lower-cased, percent-encoded, JSON-escaped,
   * and each of those inside base64 (a provider's link tokens carry an address that way). A base64 hit takes
   * the whole run of base64 letters around it: the letters at its edges still hold bits of the value.
   */
  redactIn(text: string, replacement: string): string {
    if (this.#v.length < 6) return text;
    const forms = [
      ...new Set([
        this.#v,
        this.#v.toLowerCase(),
        encodeURIComponent(this.#v),
        encodeURIComponent(this.#v.toLowerCase()),
        this.#v.replaceAll("@", "%40"),
        JSON.stringify(this.#v).slice(1, -1),
        this.#v.replace(/[\s-]/g, ""),
      ]),
    ].filter((form) => form.length >= 6);
    let out = text;
    for (const form of forms.sort((a, b) => b.length - a.length)) out = out.replaceAll(form, replacement);
    for (const inner of new Set(forms.flatMap(base64Inners))) {
      out = out.replace(new RegExp(`[A-Za-z0-9+/_-]*${inner.replace(/[+/]/g, "\\$&")}[A-Za-z0-9+/_=-]*`, "g"), replacement);
    }
    return out;
  }
  toString(): string {
    return REDACTED;
  }
  toJSON(): string {
    return REDACTED;
  }
  [inspect.custom](): string {
    return REDACTED;
  }
}

/**
 * The letters a text becomes inside base64, for each of the three places its first byte can fall in a
 * group of three, in both alphabets. The letters it shares with its neighbours are left out, so what is
 * returned is there whatever stands before and after. Shorter than eight letters is not a finding.
 */
export function base64Inners(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const out: string[] = [];
  for (const off of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(off), bytes]).toString("base64").replace(/=+$/, "");
    const inner = encoded.slice([0, 2, 3][off], encoded.length - ((off + bytes.length) % 3 === 0 ? 0 : 1));
    if (inner.length >= 8) out.push(inner, inner.replaceAll("+", "-").replaceAll("/", "_"));
  }
  return out;
}

export const CALENDAR_TEST_ACCOUNT_KEYS = [
  "ICLOUD_APPLE_ID",
  "ICLOUD_APP_PASSWORD",
  "GOOGLE_TEST_ACCOUNT",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_TEST_REFRESH_TOKEN",
] as const;

export type CalendarTestAccountKey = (typeof CALENDAR_TEST_ACCOUNT_KEYS)[number];
export type CalendarTestAccounts = Readonly<Record<CalendarTestAccountKey, Secret>>;

const LINE = /^([A-Z][A-Z0-9_]*)=(.*)$/;

export function parseCalendarTestAccounts(text: string): CalendarTestAccounts {
  const found = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const m = LINE.exec(raw.trim());
    if (m) found.set(m[1]!, m[2]!);
  }
  const out = {} as Record<CalendarTestAccountKey, Secret>;
  for (const key of CALENDAR_TEST_ACCOUNT_KEYS) out[key] = new Secret(found.get(key) ?? "");
  return Object.freeze(out);
}

/** Reads the file `env.OHCAL_TEST_ACCOUNTS_FILE` names. Throws when none is named or a key is empty. */
export function readCalendarTestAccounts(env: Record<string, string | undefined>): CalendarTestAccounts {
  const path = env.OHCAL_TEST_ACCOUNTS_FILE;
  if (!path) throw new Error("no accounts file named");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`the accounts file cannot be read (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  const accounts = parseCalendarTestAccounts(text);
  const empty = CALENDAR_TEST_ACCOUNT_KEYS.filter((k) => !accounts[k].filled);
  if (empty.length > 0) throw new Error(`the accounts file leaves empty: ${empty.join(", ")}`);
  return accounts;
}

/** The two addresses an invitation may ever name: the test accounts' own. */
export function isTestAccountAddress(accounts: CalendarTestAccounts, address: Secret | string): boolean {
  return accounts.ICLOUD_APPLE_ID.is(address) || accounts.GOOGLE_TEST_ACCOUNT.is(address);
}

/** Where the bench's own services put what they made at their start (`.cal-bench.env`, mode 600). */
export function readCalBenchEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  const path = env.OHCAL_CAL_BENCH_ENV_FILE;
  if (!path) return out;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const m = LINE.exec(raw.trim());
    if (m && out[m[1]!] === undefined) out[m[1]!] = m[2]!;
  }
  return out;
}

/** True for this machine's own addresses (the rule of `test/support/services.ts`; import that one when landed). */
export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
