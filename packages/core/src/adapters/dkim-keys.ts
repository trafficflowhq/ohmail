import { Resolver } from "node:dns/promises";
import type { DkimKeyAnswer, DkimKeyLookup } from "./dkim.js";

/**
 * THE DKIM KEY LOOKUP, over the system's own resolver: a TXT query for `<selector>._domainkey.<domain>`,
 * no DNS-over-HTTPS and no server of ours. Node only — the worker's (Cloud and self-host) and the
 * desktop's compositions import it; the phone's never does (its DNS shim refuses a TXT query).
 *
 * One cache per process, of public DNS answers and nothing about an account: a found key is kept an
 * hour, a miss or a failure five minutes, at most 4096 names. A query that fails or does not answer
 * in time marks its signing domain for those five minutes too, and no other selector there is asked
 * until then: the selector is the sender's to vary, the domain's name servers are what failed. A
 * name is checked before it is asked; at most eight queries are in flight, and each, queue
 * included, has two seconds.
 */

/** The one method this lookup asks of a resolver; `node:dns/promises`' `Resolver` in production. */
export interface TxtResolver {
  resolveTxt(name: string): Promise<string[][]>;
}

const FOUND_MS = 60 * 60 * 1000;
const MISS_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 4096;
const MAX_IN_FLIGHT = 8;
const TIMEOUT_MS = 2_000;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** The DNS codes that mean "no such record", as opposed to "could not ask". */
const NO_RECORD = new Set(["ENOTFOUND", "ENODATA"]);
const DOMAINKEY = "._domainkey.";

/** An answer, and whether it says the signing domain's name servers failed (not this process's queue). */
interface Asked { answer: DkimKeyAnswer; failed: boolean }

/** A DKIM key name: LDH labels, `_domainkey` between a selector and a domain of two labels or more. */
export function isDkimKeyName(name: string): boolean {
  if (name.length > 253) return false;
  const labels = name.split(".");
  const at = labels.indexOf("_domainkey");
  if (at < 1 || labels.length - at - 1 < 2) return false;
  return labels.every((l, i) => i === at || LABEL.test(l));
}

export function makeDnsDkimKeys(opts: {
  /** Test seam; production makes one `Resolver` at the first lookup. */
  resolver?: () => TxtResolver;
  now?: () => number;
  timeoutMs?: number;
} = {}): DkimKeyLookup {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const make = opts.resolver ?? (() => new Resolver({ timeout: timeoutMs, tries: 1 }));
  let resolver: TxtResolver | null = null;
  const cache = new Map<string, { until: number; answer: DkimKeyAnswer }>();
  /** Signing domains whose last query failed, and until when none of their names is asked. */
  const failedUntil = new Map<string, number>();
  const pending = new Map<string, Promise<DkimKeyAnswer>>();
  let inFlight = 0;
  const waiting: (() => void)[] = [];

  const bounded = <V>(map: Map<string, V>, key: string, value: V): void => {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_ENTRIES) map.delete(map.keys().next().value!);
  };
  const remember = (name: string, answer: DkimKeyAnswer): void =>
    bounded(cache, name, { until: now() + (answer.kind === "records" ? FOUND_MS : MISS_MS), answer });

  /** A slot now, or the next one freed before `late`; `false` when the deadline came first. */
  async function acquire(late: Promise<"late">): Promise<boolean> {
    if (inFlight < MAX_IN_FLIGHT) {
      inFlight++;
      return true;
    }
    let wake!: () => void;
    const turn = new Promise<"turn">((res) => { wake = () => res("turn"); });
    waiting.push(wake);
    if ((await Promise.race([turn, late])) === "turn") return true;
    const i = waiting.indexOf(wake);
    if (i >= 0) waiting.splice(i, 1);
    else release();
    return false;
  }

  /** A freed slot passes straight to the next in line, so nothing can slip in between. */
  function release(): void {
    const next = waiting.shift();
    if (next) next();
    else inFlight--;
  }

  async function ask(name: string): Promise<Asked> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((res) => { timer = setTimeout(() => res("late"), timeoutMs); });
    try {
      // A deadline spent waiting for a slot is this process's queue, not the domain's failure.
      if (!(await acquire(late))) return { answer: { kind: "error" }, failed: false };
      let query: Promise<Asked>;
      try {
        resolver ??= make();
        query = resolver.resolveTxt(name).then(
          (records): Asked => ({
            answer: records.length === 0
              ? { kind: "none" } : { kind: "records", records: records.map((chunks) => chunks.join("")) },
            failed: false,
          }),
          (err: unknown): Asked => NO_RECORD.has(String((err as { code?: unknown } | null)?.code))
            ? { answer: { kind: "none" }, failed: false } : { answer: { kind: "error" }, failed: true },
        );
      } catch {
        release();
        return { answer: { kind: "error" }, failed: false };
      }
      // The slot is held until the query itself settles, so the cap counts what is really open.
      void query.finally(release);
      const asked = await Promise.race([query, late]);
      return asked === "late" ? { answer: { kind: "error" }, failed: true } : asked;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async lookup(raw: string): Promise<DkimKeyAnswer> {
      const name = raw.toLowerCase();
      if (!isDkimKeyName(name)) return { kind: "error" };
      const hit = cache.get(name);
      if (hit !== undefined && hit.until > now()) return hit.answer;
      const open = pending.get(name);
      if (open !== undefined) return open;
      const domain = name.slice(name.indexOf(DOMAINKEY) + DOMAINKEY.length);
      if ((failedUntil.get(domain) ?? 0) > now()) return { kind: "error" };
      const p = ask(name).then(({ answer, failed }) => {
        remember(name, answer);
        if (failed) bounded(failedUntil, domain, now() + MISS_MS);
        return answer;
      }).finally(() => pending.delete(name));
      pending.set(name, p);
      return p;
    },
  };
}
