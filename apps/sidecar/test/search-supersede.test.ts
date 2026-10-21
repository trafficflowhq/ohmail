import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { searchIndexBackfillPass } from "@trafficflow/core/mail";
import type { Tx } from "@trafficflow/db";
import { HttpAdapter, OhmailEngine, StoreSearchWalker } from "@ohmail/client-engine";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { createWriteThroughProxy } from "../src/cloud-proxy.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import type { CloudMirror } from "../src/cloud-mirror.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 2 });

/**
 * A CHANGED SEARCH DOES NOT WAIT FOR THE LAST ONE'S COUNT. The real engine on PGlite, the real
 * walker over the real `OhmailEngine` and `HttpAdapter`, `fetch` pointed at the local door. When
 * A's estimate leaves, a transaction is parked on a promise (it holds PGlite's mutex while the
 * loop stays free) and the estimate queues behind it; B is typed, then the store is released: A's
 * estimate answers `409 search_superseded`, B's page and count answer with B's rows. Gates, no
 * timing thresholds. Watched red: the first-line turn removed, the header not set.
 */
const ADDRESS = "owner@trafficflow.test";
const LANE_HEADER = "x-ohmail-search-lane";
/** More than the arms keep (4 pages of 50), so each word's estimate is cut and a summary follows. */
const HARBOUR = 300;
const LANTERN = 260;

const dirs: string[] = [];
const sidecars: Sidecar[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function standUp(): Promise<Sidecar> {
  const dir = await freshDataDir("ohmail-search-supersede-");
  dirs.push(dir);
  const s = await createSidecar({
    dataDir: dir,
    address: ADDRESS,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: ADDRESS, pass: "not-dialled-password-password" } },
    pollIntervalMs: 60 * 60 * 1000,
    vitalsIntervalMs: 60 * 60 * 1000,
    profileFlushIntervalMs: 60 * 60 * 1000,
    adapterFactory: () => ({ close: async () => undefined }) as unknown as MailboxAdapter,
    searchBackfillTiming: { waitMs: 3_600_000 },
  });
  sidecars.push(s);
  const { accountId, mailboxId } = s.world;
  for (const [word, n, domain] of [["harbour", HARBOUR, "harbour.example"], ["lantern", LANTERN, "lantern.example"]] as const) {
    await s.db.execute(sql`
      insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, native_locator, to_addresses, cc_addresses)
      select ${accountId}::uuid, ${mailboxId}::uuid, 'h', ${word} || ':' || g, ${word} || ' note ' || g, 'sender' || (g % 5) || '@' || ${domain},
        timestamptz '2026-09-01T00:00:00Z' - make_interval(mins => g), jsonb_build_object('folder', 'INBOX', 'ref', '1:' || ${word} || g),
        '[]'::jsonb, '[]'::jsonb
      from generate_series(1, ${n}) g`);
  }
  await s.db.execute(sql`insert into message_bodies (message_id, text) select m.id, 'a letter' from messages m where m.account_id = ${accountId}::uuid`);
  await s.db.execute(sql`insert into folder_state (message_id, desired_folder, observed_folder, last_set_by)
    select m.id, 'INBOX', 'INBOX', 'us' from messages m where m.account_id = ${accountId}::uuid`);
  const built = await searchIndexBackfillPass({ db: s.db as unknown as Tx, accountId, rounds: 100, batch: 1_000 });
  expect(built.marked).toBe(true);
  return s;
}

/** Hold PGlite's one transaction mutex until the returned call; the loop stays free meanwhile. */
async function park(s: Sidecar): Promise<() => Promise<void>> {
  let held!: () => void;
  let release!: () => void;
  const holding = new Promise<void>((r) => { held = r; });
  const gate = new Promise<void>((r) => { release = r; });
  const done = s.db.transaction(async () => { held(); await gate; });
  await holding;
  return async () => { release(); await done; };
}

/** Every statement PGlite runs, by its text: a simple query's, or an extended query's Parse. */
function statements(s: Sidecar, before?: (text: string) => void): string[] {
  const client = (s.db as unknown as { session: { client: { execProtocol(m: Uint8Array, o?: unknown): Promise<unknown> } } }).session.client;
  const log: string[] = [];
  const real = client.execProtocol.bind(client);
  client.execProtocol = (m, o) => {
    const b = Buffer.from(m);
    const at = b[0] === 0x51 ? 5 : b[0] === 0x50 ? b.indexOf(0, 5) + 1 : -1;
    if (at > 0) {
      const text = b.toString("utf8", at, b.indexOf(0, at)).trim();
      log.push(text);
      before?.(text);
    }
    return real(m, o);
  };
  return log;
}

interface Sent { q: string; parts: string; lane: string | null; atDoor: boolean; status: number | null }

/** The window's `fetch`, pointed at the local door, every request recorded with its answer's status. */
function door(s: Sidecar, hooks: { send?: (e: Sent) => Promise<void> | void; answer?: (e: Sent) => Promise<void> | void } = {}) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${s.sessionToken}`);
    const e: Sent = { q: u.searchParams.get("q") ?? "", parts: u.searchParams.get("parts") ?? "", lane: headers.get(LANE_HEADER), atDoor: false, status: null };
    sent.push(e);
    await hooks.send?.(e);
    e.atDoor = true;
    const res = await s.handle(new Request(url, { ...init, headers }));
    e.status = res.status;
    await hooks.answer?.(e);
    return res;
  };
  return { fetch, sent };
}

async function until(what: string, cond: () => boolean): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > 20_000) throw new Error(`never: ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const of = (sent: Sent[], q: string, parts: string): Sent[] => sent.filter((e) => e.q === q && e.parts === parts);
const statuses = (sent: Sent[], q: string, parts: string): Array<number | null> => of(sent, q, parts).map((e) => e.status);
const engineOn = (fetch: (url: string, init?: RequestInit) => Promise<Response>, searchSupersede = true): OhmailEngine =>
  new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "http://local", fetch }), ...(searchSupersede ? { searchSupersede: true } : {}) });

/**
 * A's estimate queued at its own transaction: once the door has checked its bearer (the one
 * statement it runs ahead of the service), the store is parked, and the estimate's transaction
 * queues behind the park. `release` is set once the park holds the store.
 */
function parkingOn(s: Sidecar, q: string): { ran: string[]; hook: (e: Sent) => void; release: () => (() => Promise<void>) | null } {
  let armed: boolean | null = false;
  let release: (() => Promise<void>) | null = null;
  const ran = statements(s, (text) => {
    if (armed !== true || !/^select "sessions"\./.test(text)) return;
    armed = null;
    void park(s).then((r) => { release = r; });
  });
  return {
    ran,
    hook: (e) => { if (armed === false && e.q === q && e.parts === "estimate") armed = true; },
    release: () => release,
  };
}

describe("a changed search on the desktop's own store", () => {
  it("B's page and count answer at once; A's queued estimate is refused and its summary never sent", async () => {
    const s = await standUp();
    const parking = parkingOn(s, "harbour");
    const ran = parking.ran;
    const { fetch, sent } = door(s, { send: parking.hook });
    const walker = new StoreSearchWalker(engineOn(fetch));
    walker.start({ query: "harbour" }, () => [], 0);
    await until("A's estimate queued", () => parking.release() !== null && of(sent, "harbour", "estimate")[0]?.atDoor === true);
    walker.start({ query: "lantern" }, () => [], 0);
    await until("B's page at the door", () => of(sent, "lantern", "page")[0]?.atDoor === true);
    await parking.release()!();
    await until("B's exact count", () => walker.info()?.totalExact === true);

    expect(statuses(sent, "harbour", "page")).toEqual([200]);
    expect(statuses(sent, "harbour", "estimate"), "A's queued estimate").toEqual([409]);
    // The refused estimate's transaction is the one rolled back, and it ran nothing.
    const rolledBack = ran.flatMap((t, i) => (/^rollback$/i.test(t) ? [i] : []));
    expect(rolledBack).toHaveLength(1);
    expect(ran[rolledBack[0]! - 1], "A's estimate ran a statement in its transaction").toMatch(/^begin$/i);
    expect(of(sent, "harbour", "summary"), "A's summary is never sent").toEqual([]);
    expect(statuses(sent, "lantern", "page")).toEqual([200]);
    expect(statuses(sent, "lantern", "estimate")).toEqual([200]);
    expect(statuses(sent, "lantern", "summary")).toEqual([200]);
    const info = walker.info()!;
    expect(info.total).toBe(LANTERN);
    expect(info.facets!.sender.every((x) => x.address.endsWith("@lantern.example")), "only B's facets").toBe(true);
    expect(walker.state()).toBe("ready");
    expect(walker.failureCause()).toBeNull();
  });

  it("CONTROL: the option off, A's queued estimate answers 200 and no lane is on the wire", async () => {
    const s = await standUp();
    const parking = parkingOn(s, "harbour");
    const { fetch, sent } = door(s, { send: parking.hook });
    const walker = new StoreSearchWalker(engineOn(fetch, false));
    walker.start({ query: "harbour" }, () => [], 0);
    await until("A's estimate queued", () => parking.release() !== null && of(sent, "harbour", "estimate")[0]?.atDoor === true);
    walker.start({ query: "lantern" }, () => [], 0);
    await until("B's page at the door", () => of(sent, "lantern", "page")[0]?.atDoor === true);
    await parking.release()!();
    await until("B's exact count", () => walker.info()?.totalExact === true);
    expect(statuses(sent, "harbour", "estimate")).toEqual([200]);
    expect(sent.every((e) => e.lane === null)).toBe(true);
    expect(walker.info()!.total).toBe(LANTERN);
  });

  it("CONTROL: one question alone answers page, estimate and summary, the exact total, under one lane", async () => {
    const s = await standUp();
    const { fetch, sent } = door(s);
    const walker = new StoreSearchWalker(engineOn(fetch));
    walker.start({ query: "harbour" }, () => [], 0);
    await until("the exact count", () => walker.info()?.totalExact === true);
    expect(sent.map((e) => [e.parts, e.status])).toEqual([["page", 200], ["estimate", 200], ["summary", 200]]);
    expect(walker.info()!.total).toBe(HARBOUR);
    expect(new Set(sent.map((e) => e.lane)).size, "one lane and one generation for the question").toBe(1);
    expect(sent[0]!.lane).toMatch(/^[a-z0-9]{1,32}\.\d{1,15}$/);
  });

  it("CONTROL: a second window's lane is untouched", async () => {
    const s = await standUp();
    const parking = parkingOn(s, "harbour");
    const { fetch, sent } = door(s, { send: parking.hook });
    const engine = engineOn(fetch);
    const first = new StoreSearchWalker(engine);
    const second = new StoreSearchWalker(engine);
    first.start({ query: "harbour" }, () => [], 0);
    await until("A's estimate queued", () => parking.release() !== null && of(sent, "harbour", "estimate")[0]?.atDoor === true);
    second.start({ query: "lantern" }, () => [], 0);
    await until("B's page at the door", () => of(sent, "lantern", "page")[0]?.atDoor === true);
    await parking.release()!();
    await until("both exact", () => first.info()?.totalExact === true && second.info()?.totalExact === true);
    expect(statuses(sent, "harbour", "estimate")).toEqual([200]);
    expect(first.info()!.total).toBe(HARBOUR);
    expect(second.info()!.total).toBe(LANTERN);
    expect(of(sent, "harbour", "page")[0]!.lane!.split(".")[0]).not.toBe(of(sent, "lantern", "page")[0]!.lane!.split(".")[0]);
  });

  it("CONTROL: no header, or a malformed one, is never refused", async () => {
    const s = await standUp();
    const ask = (parts: string, lane?: string): Promise<Response> => s.handle(new Request(`http://local/search?q=harbour&parts=${parts}&limit=50`, {
      headers: { authorization: `Bearer ${s.sessionToken}`, ...(lane === undefined ? {} : { [LANE_HEADER]: lane }) },
    }));
    const release = await park(s);
    const queued = [
      ask("estimate"), ask("estimate", "Upper.1"), ask("estimate", "abc.x"), ask("estimate", "abc.1234567890123456"),
      ask("estimate", "abc"), ask("estimate", "abc.1"),
    ];
    const newer = ask("page", "abc.2");
    await release();
    const got = await Promise.all([...queued, newer].map(async (p) => (await p).status));
    expect(got).toEqual([200, 200, 200, 200, 200, 409, 200]);
  });

  it("A, then B, then A retyped: the third question asks again and answers A's exact total", async () => {
    const s = await standUp();
    const parking = parkingOn(s, "harbour");
    let walker: StoreSearchWalker | null = null;
    const { fetch, sent } = door(s, {
      send: parking.hook,
      // A's first estimate answers only once the retyped A has had its page and asked its own.
      answer: async (e) => {
        if (e !== of(sent, "harbour", "estimate")[0]) return;
        await until("the retyped A's page answered", () => of(sent, "harbour", "page")[1]?.status === 200);
        for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
      },
    });
    walker = new StoreSearchWalker(engineOn(fetch));
    walker.start({ query: "harbour" }, () => [], 0);
    await until("A's estimate queued", () => parking.release() !== null && of(sent, "harbour", "estimate")[0]?.atDoor === true);
    walker.start({ query: "lantern" }, () => [], 0);
    await until("B's page at the door", () => of(sent, "lantern", "page")[0]?.atDoor === true);
    walker.start({ query: "harbour" }, () => [], 0);
    await until("A's retyped page at the door", () => of(sent, "harbour", "page")[1]?.atDoor === true);
    await parking.release()!();
    await until("the exact count", () => walker!.info()?.totalExact === true);
    expect(statuses(sent, "harbour", "estimate"), "the retyped A asks its own estimate").toEqual([409, 200]);
    expect(walker.info()!.total).toBe(HARBOUR);
    expect(walker.info()!.facets!.sender.every((x) => x.address.endsWith("@harbour.example"))).toBe(true);
  });

  it("the box cleared while A is queued: idle, nothing shown, and the next question supersedes A's leftover", async () => {
    const s = await standUp();
    const parking = parkingOn(s, "harbour");
    const { fetch, sent } = door(s, { send: parking.hook });
    const walker = new StoreSearchWalker(engineOn(fetch));
    walker.start({ query: "harbour" }, () => [], 0);
    await until("A's estimate queued", () => parking.release() !== null && of(sent, "harbour", "estimate")[0]?.atDoor === true);
    walker.clear();
    expect(walker.state()).toBe("idle");
    expect(walker.failureCause()).toBeNull();
    expect(walker.info()).toBeNull();
    walker.start({ query: "lantern" }, () => [], 0);
    await until("B's page at the door", () => of(sent, "lantern", "page")[0]?.atDoor === true);
    await parking.release()!();
    await until("B's exact count", () => walker.info()?.totalExact === true);
    expect(statuses(sent, "harbour", "estimate")).toEqual([409]);
    expect(of(sent, "harbour", "summary")).toEqual([]);
    expect(walker.info()!.total).toBe(LANTERN);
  });
});

describe("a relayed search", () => {
  it("reaches Cloud without the lane header", async () => {
    const seen: Headers[] = [];
    const auth = {
      authedFetch: async (_path: string, init?: RequestInit) => {
        seen.push(new Headers(init?.headers));
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    } as unknown as CloudAuth;
    const mirror = {
      online: () => true, markConnectivity: () => {}, awaitCloudSeq: async () => true, awaitFreshPull: async () => true,
    } as unknown as CloudMirror;
    const proxy = createWriteThroughProxy({ auth, mirror, handoffForeign: true });
    const res = await proxy.forward(new Request("http://engine/search?q=harbour&parts=page", {
      headers: { [LANE_HEADER]: "abc.1", "x-control": "kept" },
    }));
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.get("x-control"), "CONTROL: another header is relayed").toBe("kept");
    expect(seen[0]!.has(LANE_HEADER)).toBe(false);
  });
});
