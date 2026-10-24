import type { promises as dnsPromises } from "node:dns";
import { domainToASCII } from "node:url";
import { MAIL_DIAL_PORTS, clearMailDial, type HostResolver } from "@trafficflow/core/net";

/**
 * WHERE A DOMAIN'S MAIL IS HOSTED, FROM DNS ALONE — the lookup behind `POST /mailboxes/discover`.
 *
 * Two questions about the domain and nothing else: its MX records (Google Workspace, Microsoft 365
 * and a few hosts that serve other people's domains publish recognisable exchangers) and its RFC
 * 6186 SRV records (a server that says where its own IMAP and submission are). No HTTP fetch, no
 * autoconfig, ISPDB or Autodiscover: each is a third party or a URL somebody else picks. Nothing is
 * stored and nothing is logged here; a fault is an empty answer. The answer only ever pre-fills a
 * form the person can see and change — the probe's own guard decides what is dialled.
 */

/** The DNS this lookup asks: MX, SRV, and the A/AAAA records of one SRV target. */
export interface MailDnsResolver extends HostResolver {
  resolveMx(domain: string, signal?: AbortSignal): Promise<ReadonlyArray<{ exchange: string; priority: number }>>;
  resolveSrv(
    name: string, signal?: AbortSignal,
  ): Promise<ReadonlyArray<{ name: string; port: number; priority: number; weight: number }>>;
  resolve(hostname: string, signal?: AbortSignal): Promise<string[]>;
}

export interface DiscoveredServer {
  readonly host: string;
  readonly port: number;
  /** Implicit TLS (`_imaps`, `_submissions`), as `ProviderPreset` spells it; `false` is STARTTLS. */
  readonly secure: boolean;
}

/** The one shape the route answers: every key, every time. */
export interface MailboxDiscovery {
  /** The preset id of the provider that hosts this domain's mail, or `null`. */
  readonly preset: string | null;
  /** Proton hosts it — not a preset: Proton reaches other mail apps only through Proton Bridge. */
  readonly proton: boolean;
  readonly imap: DiscoveredServer | null;
  readonly smtp: DiscoveredServer | null;
}

export const NOTHING_DISCOVERED: MailboxDiscovery = { preset: null, proton: false, imap: null, smtp: null };

/**
 * The exchangers each preset's provider publishes for the domains it hosts, matched as the name or
 * a suffix of it. The ids are `packages/client-engine/src/providers.ts`'s, held there by
 * `test/provider-presets-parity.test.ts`. Consumer domains the client already knows need no row.
 */
export const DISCOVER_MX_PRESETS: ReadonlyArray<{ readonly preset: string; readonly suffixes: readonly string[] }> = [
  { preset: "gmail", suffixes: ["google.com", "googlemail.com"] },
  { preset: "microsoft", suffixes: ["protection.outlook.com", "mx.microsoft"] },
  { preset: "icloud", suffixes: ["mail.icloud.com"] },
  { preset: "fastmail", suffixes: ["messagingengine.com"] },
  { preset: "infomaniak", suffixes: ["infomaniak.ch"] },
];

/** Proton's exchangers, for `domain.proton`. */
export const DISCOVER_PROTON_MX: readonly string[] = ["protonmail.ch"];

/**
 * Names never looked up: RFC 6761/6762/7686/8375 special-use names and the private suffixes that
 * only an internal resolver answers. A name equal to one, or under one, is refused.
 */
export const DISCOVER_REFUSED_SUFFIXES: readonly string[] = [
  "home.arpa", "localhost", "test", "invalid", "example", "onion", "lan", "corp", "intranet",
  "local", "internal", "localdomain", "home", "arpa",
];

/** The longest domain the route reads, before IDNA; a DNS name is at most 253 octets after. */
export const DISCOVER_DOMAIN_MAX_CHARS = 253;

/** Records read from one answer, which somebody else controls. */
export const DISCOVER_RECORDS_MAX = 16;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const canonical = (name: string): string => name.trim().toLowerCase().replace(/\.$/, "");

const under = (name: string, suffix: string): boolean => name === suffix || name.endsWith(`.${suffix}`);

/** An LDH name of two labels or more whose last label is not a number (an IPv4 literal is not a name). */
export function isLookupName(name: string): boolean {
  if (name === "" || name.length > 253) return false;
  const labels = name.split(".");
  return labels.length >= 2 && labels.every((l) => LABEL.test(l)) && !/^\d+$/.test(labels[labels.length - 1]!);
}

export function isRefusedName(name: string): boolean {
  return DISCOVER_REFUSED_SUFFIXES.some((s) => under(name, s));
}

export type DomainVerdict = { ok: true; domain: string } | { ok: false; why: string };

/**
 * The typed domain as the lookup asks it: trimmed, IDNA-normalised (UTS #46, then STD 3 rules,
 * which Node's `domainToASCII` does not apply), one root dot dropped. The `why` never quotes it.
 */
export function discoverDomain(raw: unknown): DomainVerdict {
  if (typeof raw !== "string") return { ok: false, why: "domain must be a string" };
  const typed = raw.trim();
  if (typed === "" || typed.length > DISCOVER_DOMAIN_MAX_CHARS) {
    return { ok: false, why: `domain must be 1–${DISCOVER_DOMAIN_MAX_CHARS} characters` };
  }
  // The part before the @ never leaves the browser for this lookup, so an address is refused whole.
  if (typed.includes("@")) return { ok: false, why: "the lookup takes the domain only, not the address" };
  const ascii = domainToASCII(typed.replace(/\.$/, ""));
  if (!isLookupName(ascii)) return { ok: false, why: "that is not a domain name" };
  if (isRefusedName(ascii)) return { ok: false, why: "that domain is not on the public internet" };
  return { ok: true, domain: ascii };
}

/** The preset (or Proton) every most-preferred exchanger names; `null` when they disagree or none does. */
function hostingOf(records: ReadonlyArray<{ exchange: string; priority: number }> | null): {
  preset: string | null; proton: boolean;
} {
  const rows = (records ?? []).slice(0, DISCOVER_RECORDS_MAX)
    .filter((r) => typeof r?.exchange === "string" && Number.isInteger(r.priority));
  if (rows.length === 0) return { preset: null, proton: false };
  const top = Math.min(...rows.map((r) => r.priority));
  const kinds = new Set(rows.filter((r) => r.priority === top).map((r) => {
    const name = canonical(r.exchange);
    if (DISCOVER_PROTON_MX.some((s) => under(name, s))) return "proton";
    return DISCOVER_MX_PRESETS.find((row) => row.suffixes.some((s) => under(name, s)))?.preset ?? "";
  }));
  if (kinds.size !== 1) return { preset: null, proton: false };
  const kind = [...kinds][0]!;
  if (kind === "proton") return { preset: null, proton: true };
  return { preset: kind === "" ? null : kind, proton: false };
}

/** The lowest-priority, then heaviest, record that names a server; `.` means "no service" (RFC 2782). */
function bestRecord(
  records: ReadonlyArray<{ name: string; port: number; priority: number; weight: number }> | null,
): { host: string; port: number } | null {
  let best: { host: string; port: number; priority: number; weight: number } | null = null;
  for (const r of (records ?? []).slice(0, DISCOVER_RECORDS_MAX)) {
    if (typeof r?.name !== "string" || !Number.isInteger(r.port)) continue;
    const host = canonical(r.name);
    if (host === "") continue;
    const priority = Number.isFinite(r.priority) ? r.priority : Infinity;
    const weight = Number.isFinite(r.weight) ? r.weight : 0;
    if (!best || priority < best.priority || (priority === best.priority && weight > best.weight)) {
      best = { host, port: r.port, priority, weight };
    }
  }
  return best && { host: best.host, port: best.port };
}

/** Settles with the value, or `null` on a fault or once the budget has run out. */
function settle<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    if (signal.aborted) { resolve(null); return; }
    const stop = (): void => resolve(null);
    signal.addEventListener("abort", stop, { once: true });
    let running: Promise<T>;
    try { running = work(); } catch { running = Promise.reject(new Error("refused")); }
    running.then(
      (value) => { signal.removeEventListener("abort", stop); resolve(value); },
      () => { signal.removeEventListener("abort", stop); resolve(null); },
    );
  });
}

/** The first service (implicit TLS first) whose best record is a mail port on a name that resolves only to public addresses. */
async function serverOf(
  services: ReadonlyArray<readonly [Awaited<ReturnType<MailDnsResolver["resolveSrv"]>> | null, boolean]>,
  transport: "imap" | "smtp", dns: MailDnsResolver, signal: AbortSignal,
): Promise<DiscoveredServer | null> {
  for (const [records, secure] of services) {
    const best = bestRecord(records);
    if (!best || !MAIL_DIAL_PORTS[transport].has(best.port)) continue;
    if (!isLookupName(best.host) || isRefusedName(best.host)) continue;
    const cleared = await settle(
      () => clearMailDial({ resolve: (h) => dns.resolve(h, signal) }, best.host, best.port, transport), signal,
    );
    if (cleared) return { host: best.host, port: best.port, secure };
  }
  return null;
}

/**
 * Look `domain` up — already through {@link discoverDomain} — within `budgetMs`. Whatever has not
 * answered by then counts as no record, and is cancelled.
 */
export async function discoverMailHosting(
  domain: string, dns: MailDnsResolver, budgetMs: number,
): Promise<MailboxDiscovery> {
  const deadline = new AbortController();
  const { signal } = deadline;
  const timer = setTimeout(() => deadline.abort(), budgetMs);
  try {
    const srv = (service: string) => settle(() => dns.resolveSrv(`_${service}._tcp.${domain}`, signal), signal);
    const [mx, imaps, imap, submissions, submission] = await Promise.all([
      settle(() => dns.resolveMx(domain, signal), signal),
      srv("imaps"), srv("imap"), srv("submissions"), srv("submission"),
    ]);
    const [imapServer, smtpServer] = await Promise.all([
      serverOf([[imaps, true], [imap, false]], "imap", dns, signal),
      serverOf([[submissions, true], [submission, false]], "smtp", dns, signal),
    ]);
    return { ...hostingOf(mx), imap: imapServer, smtp: smtpServer };
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
}

/** One query's own timeout, inside the lookup's budget. */
const DNS_QUERY_TIMEOUT_MS = 1_500;

async function query<T>(
  signal: AbortSignal | undefined, ask: (resolver: dnsPromises.Resolver) => Promise<T>,
): Promise<T> {
  const { promises: dns } = await import("node:dns");
  if (signal?.aborted) throw new Error("the lookup's budget ran out");
  const resolver = new dns.Resolver({ timeout: DNS_QUERY_TIMEOUT_MS, tries: 1 });
  const cancel = (): void => resolver.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    return await ask(resolver);
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

/**
 * The production resolver, named only by the hosted composition root — never a default, for
 * `HostResolver`'s reason: a suite that cannot reach DNS would only ever run the refusing branch.
 */
export const nodeMailDns: MailDnsResolver = {
  resolveMx: (domain, signal) => query(signal, (r) => r.resolveMx(domain)),
  resolveSrv: (name, signal) => query(signal, (r) => r.resolveSrv(name)),
  async resolve(hostname, signal) {
    const [v4, v6] = await Promise.allSettled([
      query(signal, (r) => r.resolve4(hostname)), query(signal, (r) => r.resolve6(hostname)),
    ]);
    const addresses = [
      ...(v4.status === "fulfilled" ? v4.value : []), ...(v6.status === "fulfilled" ? v6.value : []),
    ];
    if (addresses.length === 0) throw new Error("no address");
    return addresses;
  },
};
