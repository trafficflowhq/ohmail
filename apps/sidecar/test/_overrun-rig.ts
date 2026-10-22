import { rmSync } from "node:fs";
import { vi } from "vitest";
import { isNull } from "drizzle-orm";
import {
  ImapAdapter, ImapBoundExceeded, isImapBoundExceeded,
  type FetchedPart, type MailboxAdapter, type NativeLocator, type SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, LeasePeekIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { mailboxes, messages } from "@trafficflow/db";
import { createLogger } from "@trafficflow/core/mail";
import { createSidecar, type AdapterDialContext, type Sidecar } from "../src/engine.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE OVERRUN RIG for the desktop engine: the real ImapAdapter
 * over a scripted server that streams ascending, where a liar sends 2 MiB against a declared 10
 * bytes and a move takes the message out of its folder. `boot` starts a sidecar on it with a
 * skewable clock. Shared by the hold and the ladder files, which run in separate processes.
 */
export class MemoryMeta implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
  }
  uidValidity(): number | bigint | null { return 4_200; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(installId)).map((c) => ({ ...c }));
  }
}

export const FOLDERS = ["INBOX", "ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"];
export const eml = (id: string): Buffer => Buffer.from([
  "From: Anna <anna@sender.test>", "To: owner@trafficflow.test", `Subject: ${id}`,
  "Date: Wed, 30 Sep 2026 12:00:00 +0000", `Message-ID: <${id}@lane.test>`, "", `Body of ${id}.`, "",
].join("\r\n"));

export type Msg = { id: string; raw: Buffer; declared: number };
export const ordinary = (id: string): Msg => ({ id, raw: eml(id), declared: eml(id).length });
export const liar = (id: string): Msg => ({ id: `the-liar-${id}`, raw: Buffer.alloc(2 * 1024 * 1024, 0x61), declared: 10 });

export function server(inbox: Array<[number, Msg]>) {
  const folders = new Map<string, { uidValidity: bigint; msgs: Map<number, Msg> }>([
    ["INBOX", { uidValidity: 100n, msgs: new Map(inbox) }],
  ]);
  /** `bodies`: every body fetch, by message id. */
  const state = { overrunBodies: 0, perLiar: {} as Record<string, number>, bodies: {} as Record<string, number>, folders };
  const client = () => {
    let path = "INBOX";
    const msgsOf = (p: string) => folders.get(p)?.msgs ?? new Map<number, Msg>();
    const parseSet = (range: unknown): number[] => {
      const all = [...msgsOf(path).keys()].sort((a, b) => a - b);
      if (Array.isArray(range)) return range.map(Number).filter((u) => msgsOf(path).has(u)).sort((a, b) => a - b);
      if (typeof range !== "string") return all;
      const out = new Set<number>();
      for (const part of range.split(",")) {
        const [lo, hi] = part.split(":");
        const a = lo === "*" ? Number.MAX_SAFE_INTEGER : Number(lo);
        const b = hi === undefined ? a : hi === "*" ? Number.MAX_SAFE_INTEGER : Number(hi);
        for (const u of all) if (u >= Math.min(a, b) && u <= Math.max(a, b)) out.add(u);
      }
      return [...out].sort((x, y) => x - y);
    };
    const c = {
      usable: true,
      capabilities: new Map<string, boolean>([["MOVE", true], ["UIDPLUS", true], ["IDLE", true]]),
      mailbox: undefined as unknown,
      // Every folder the script holds is listed too (a test adds Sent), beside the six and Archive.
      async list() { return [...new Set([...FOLDERS, "Archive", ...folders.keys()])].map((p) => ({ path: p, name: p.split("/").pop()!, delimiter: "/", flags: new Set<string>() })); },
      async mailboxCreate(p: string) { return { path: p }; },
      async getMailboxLock(p: string) {
        path = p;
        const f = folders.get(p);
        const keys = f ? [...f.msgs.keys()] : [];
        c.mailbox = { path: p, uidValidity: f?.uidValidity ?? 7n, uidNext: Math.max(0, ...keys) + 1, highestModseq: 0n, exists: keys.length };
        return { path: p, release() { /* nothing */ } };
      },
      async search() { return []; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async *fetch(range: any, query: any) {
        for (const uid of parseSet(range)) {
          const m = msgsOf(path).get(uid)!;
          if (query?.source) {
            state.bodies[m.id] = (state.bodies[m.id] ?? 0) + 1;
            if (m.id.startsWith("the-liar")) { state.overrunBodies++; state.perLiar[m.id] = (state.perLiar[m.id] ?? 0) + 1; }
            yield { uid, flags: new Set<string>(), envelope: { messageId: `<${m.id}@lane.test>` }, source: m.raw, internalDate: new Date(Date.UTC(2026, 8, 30) + uid * 1000) };
          } else if (query?.size) yield { uid, size: m.declared };
          else if (query?.headers) yield { uid, headers: Buffer.from(`Message-ID: <${m.id}@lane.test>\r\n`) };
          else if (query?.internalDate) yield { uid, internalDate: new Date(Date.UTC(2026, 8, 30) + uid * 1000), envelope: {} };
          else if (query?.flags) yield { uid, flags: new Set<string>() };
          else yield { uid };
        }
      },
      async messageMove() { return { uidValidity: 100n, uidMap: new Map<number, number>() }; },
      async messageCopy() { return { uidValidity: 100n, uidMap: new Map<number, number>() }; },
      async messageDelete() { return true; },
      async logout() { /* nothing */ },
      close() { /* nothing */ },
      on() { /* no events */ },
    };
    return c;
  };
  return { state, client };
}

export function rig(s: ReturnType<typeof server>) {
  const meta = new MemoryMeta();
  const counts = { logins: 0, staleCalls: 0, moves: 0 };
  /** The next dial's connect throws this once, before anything reaches the server. */
  const control: { failNextConnect: Error | null } = { failNextConnect: null };
  const factory = (_cfg: unknown, ctx: AdapterDialContext): MailboxAdapter & { leaseIo(): LeaseIo; leasePeekIo(): LeasePeekIo } => {
    let retired: ImapBoundExceeded | null = null;
    const real = new ImapAdapter({ host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } }, {
      client: s.client() as never,
      onConnectionError: (e) => { if (isImapBoundExceeded(e)) retired = e; ctx.onConnectionError(e); },
    });
    const usable = (): void => { if (retired !== null) { counts.staleCalls++; throw retired; } };
    const io: LeaseIo = {
      ensureMetaFolder: async () => { usable(); },
      listClaims: async () => { usable(); return meta.listClaims(); },
      appendClaim: async (raw) => { usable(); await meta.appendClaim(raw); },
      removeClaims: async (refs) => { usable(); await meta.removeClaims(refs); },
      uidValidity: () => meta.uidValidity(),
      findOwnRecords: async (id) => { usable(); return meta.findOwnRecords(id); },
    };
    return {
      leaseIo: () => io,
      leasePeekIo: () => ({ listClaims: async () => { usable(); return meta.listClaims(); } }),
      async connect(): Promise<void> {
        const fail = control.failNextConnect;
        if (fail !== null) { control.failNextConnect = null; throw fail; }
        counts.logins++; await real.connect();
      },
      async close(): Promise<void> { await real.close(); },
      forceClose: () => real.forceClose(),
      capabilities: () => real.capabilities(),
      async ensureFolders(): Promise<void> { usable(); },
      changesSince: (c) => real.changesSince(c),
      fetchByUid: (f, u, o) => real.fetchByUid(f, u, o),
      async move(l: NativeLocator, toFolder: string): Promise<NativeLocator> {
        usable(); counts.moves++;
        // A move takes the message out of its folder on the server, as a real one does.
        s.state.folders.get(l.folder)?.msgs.delete(Number(l.ref.split(":")[1]));
        return { folder: toFolder, ref: `200:${1000 + counts.moves}` };
      },
      async setFlags(): Promise<void> { usable(); },
      async scanSentRecipients(): Promise<string[]> { usable(); return []; },
      async watch(): Promise<() => Promise<void>> { usable(); return async () => {}; },
      async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart in this rig"); },
      async send(): Promise<SendResult> { throw new Error("no send in this rig"); },
    } as MailboxAdapter & { leaseIo(): LeaseIo; leasePeekIo(): LeasePeekIo };
  };
  return { factory, counts, control };
}

const realNow = Date.now.bind(Date);

export async function boot(
  r: ReturnType<typeof rig>, clock: { skewMs: number }, cleanups: Array<() => Promise<void> | void>,
  opts: { pollIntervalMs?: number; monotonic?: () => number; reader?: boolean } = {},
) {
  /* THE CLOCK NEVER RUNS BACKWARDS across the cases of one file. The first-page gate's arm instant is
     process-wide (`first-page-gate.ts`), and a case starting minutes behind the last one waited that
     long in every drain: measured, 7 of 7 runs, and filed as FIRST-PAGE-GATE-WAITS-OUT-A-CLOCK-STEP. */
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + clock.skewMs);
  const dataDir = await freshDataDir("ohmail-overrun-ladder-");
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const events: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const s: Sidecar = await createSidecar({
    dataDir,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "pw" } },
    address: "owner@trafficflow.test", machineName: "the machine under test",
    pollIntervalMs: opts.pollIntervalMs ?? 60 * 60 * 60_000, leaseStaleAfterMs: 60_000, keks: { 1: Buffer.alloc(32, 7) },
    adapterFactory: r.factory,
    ...(opts.monotonic === undefined ? {} : { monotonic: opts.monotonic }),
    log: (event, detail) => { events.push({ event, detail: (detail ?? {}) as Record<string, unknown> }); },
    logger: createLogger({ service: "sidecar", sink: (line) => {
      const l = JSON.parse(line) as { event: string };
      events.push({ event: l.event, detail: l as unknown as Record<string, unknown> });
    } }),
  });
  cleanups.push(async () => { await s.stop().catch(() => undefined); });
  // `reader`: no organize consent, so nothing is filed out of INBOX (this rig's move cannot follow a letter).
  if (opts.reader !== true) {
    await s.db.update(mailboxes).set({ organizeConsentedAt: new Date(), organizerRole: "organizer" }).where(isNull(mailboxes.organizeConsentedAt));
  }
  await s.start().catch(() => undefined);
  const cycle = async (): Promise<void> => { await s.syncMailbox(s.world.mailboxId).catch(() => undefined); };
  const connection = async (): Promise<{ reachable: boolean; setAside: number }> => {
    const res = await s.handle(new Request("http://local/local/mailboxes/connections", { method: "GET", headers: { authorization: `Bearer ${s.sessionToken}` } }));
    return ((await res.json()) as { items: Array<{ reachable: boolean; setAside: number }> }).items[0]!;
  };
  const errorCode = async (): Promise<string | null> => {
    const res = await s.handle(new Request("http://local/mailboxes", { method: "GET", headers: { authorization: `Bearer ${s.sessionToken}` } }));
    return ((await res.json()) as { items?: Array<{ errorCode?: string | null }> }).items?.[0]?.errorCode ?? null;
  };
  const subjects = async (): Promise<string[]> => (await s.db.select({ subject: messages.subject }).from(messages)).map((x) => x.subject ?? "").sort();
  return { cycle, connection, errorCode, subjects, events, sidecar: s };
}
