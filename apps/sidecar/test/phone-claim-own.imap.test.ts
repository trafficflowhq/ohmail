/**
 * A STANDALONE PHONE'S OWN CLAIM, AGAINST A REAL IMAP SERVER — consent, claim, restart, renew.
 *
 * ── WHAT THIS FILE MEASURED, AND WHAT IT SETTLED ──────────────────────────────────────────
 *
 * The phone stack reported `organizer_stand_down organized_elsewhere:unknown` seconds after
 * consent, with the holder's display name its OWN, and two candidates were open: a composition
 * carrying two install identities, or a lease defect inherited from the stack's base. Driven here
 * against a real server, neither holds. The install writes ONE claim under ONE id, keeps it for a
 * poll interval, and then stands down against THAT claim — `ownClaimTerm: our_last_nonce`, its own
 * display name as the holder — and releases it, leaving the mailbox with no organizer at all. Every cycle.
 *
 * The mechanism is the kind, not the identity: a renew appends before it expunges, so the folder
 * briefly holds two of ours; the lease's rule 1/2 scans the RAW list for a live claim it cannot
 * rank and excludes only `rawOurs` (install id AND the armed nonce), so the older copy is not
 * "ours" there — and a phone's kind reads as `unknown`, which makes it unrankable. A desktop's
 * residue is rankable and its election settles it. The phone is the one install whose own kind it
 * cannot rank. The pair control, as pure logic, is
 * `packages/core/test/adapters/organizer-kind-mobile-own-residue.test.ts`.
 *
 * ── SO TWO CASES HERE ASSERT AN OPEN DEFECT, AND SAY WHERE THEY FLIP ──────────────────────
 *
 * The fix is the protocol slice that teaches the read set `mobile` (the database's
 * `ORGANIZER_KINDS`, the `mailboxes_organized_by_kind_closed` CHECK and its migration, together),
 * and it belongs to the lease's own lane: a comparison loosened from the phone side is a second
 * organizer on the desktop and on the hosted worker. Until it lands, "the phone stands down" is
 * what this file asserts, with the desktop pair beside it so the sentence cannot be read as
 * "everybody does". Each such case names the expectation that flips.
 *
 * ── WHAT IT PROVES AND WHAT IT CANNOT ─────────────────────────────────────────────────────
 *
 * It drives `startPhoneEngine` — the phone's `main.ts` — over `node:sqlite` and the platform's own
 * sockets, with NO adapter double: the claim in `ohmail/_meta` is read back by an independent IMAP
 * client, so what is asserted is what is on the server. It is not a device run: Hermes, the
 * expo-sqlite binding and the phone's own network stack are the device criteria and are measured
 * on a build.
 *
 * The LAST case is what makes the others evidence. "It stood down" and "it did not" are both
 * readable here only because a genuine stranger produces `ownClaimTerm: install_id` — the positive
 * control over the instrument every other case reads its verdict from.
 *
 * ── IT RUNS UNDER THE SQLITE PROJECT ──────────────────────────────────────────────────────
 *
 * `phone-engine-boot.test.ts`'s reason verbatim: this composes the whole engine over the DEVICE
 * store, so it needs `vitest.sqlite.config.ts`'s schema substitution. Under the default project it
 * states the premise rather than skipping silently, and it names the closed port rather than
 * skipping in silence when the private server is down.
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";
import { createSidecarLog } from "../src/log.js";
import {
  CLAIM_PROTOCOL,
  DEFAULT_STALE_AFTER_MS,
  META_FOLDER,
  formatClaim,
  type OrganizerKind,
} from "@trafficflow/core/adapters/organizer-lease";
import {
  startPhoneEngine,
  type ClaimHereOutcome,
  type PhoneEngine,
  type PhoneSqlExecutor,
  type PhoneSqlRows,
} from "../src/mobile.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  IDLE_POLL_CEILING_MS,
  nextIdlePollMs,
} from "../src/engine.js";
import { serviceUp } from "@trafficflow/db/testing";

const sqlite = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): {
      all(...p: unknown[]): unknown[];
      run(...p: unknown[]): unknown;
      columns?(): { column?: string | null; name?: string }[];
    };
  };
};

/**
 * THE COMPOSE FIXTURE BY DEFAULT — which is what makes this file run at all.
 *
 * It first defaulted to the phone stack's own private container on 3343, on the reasoning that the
 * shared GreenMail is written to by every other suite. That reason is FALSE here: every case below
 * takes a fresh random user, so its mailbox is its own and no other suite's claims can appear in
 * it. And the cost was the whole file: CI serves GreenMail on 3143, nothing there answers on 3343,
 * so all four product cases skipped and the suite stayed green measuring none of them.
 *
 * `IMAP_HOST`/`IMAP_PORT` with the repo's own defaults, then — the same variables `_imapenv.ts`
 * reads — with an override for a lane driving a private container. This file therefore takes the
 * GreenMail box, which is the honest classification: `box-files.mjs` reads the port.
 */
const HOST = process.env.OHMAIL_PHONE_IMAP_HOST ?? process.env.IMAP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.OHMAIL_PHONE_IMAP_PORT ?? process.env.IMAP_PORT ?? 3143);
const SMTP_PORT = Number(process.env.OHMAIL_PHONE_SMTP_PORT ?? process.env.SMTP_PORT ?? 3025);

/** Which store this run is about, declared by the project. Both projects set it. */
const EXPECTED_DIALECT = process.env.OHMAIL_EXPECT_DIALECT;
const ON_DEVICE_STORE = EXPECTED_DIALECT === "sqlite";

const SERVER_UP = ON_DEVICE_STORE ? serviceUp("greenmail", `${HOST}:${PORT}`).up : false;

/** `node:sqlite` behind the phone's statement-runner contract, with a real yield in every call. */
function nodeExecutor(file: string): PhoneSqlExecutor {
  const raw = new sqlite.DatabaseSync(file);
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T> | T): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  };
  const yielded = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return {
    async all(sql: string, params: readonly unknown[]): Promise<PhoneSqlRows> {
      return serial(async () => {
        await yielded();
        const st = raw.prepare(sql);
        const columns = (st.columns ? st.columns() : []).map((c) => c.name ?? c.column ?? "");
        const objects = st.all(...params) as Record<string, unknown>[];
        const rows = columns.length > 0
          ? objects.map((o) => columns.map((c) => o[c]))
          : objects.map((o) => Object.values(o));
        return { columns, rows };
      });
    },
    async run(sql: string, params: readonly unknown[]): Promise<void> {
      return serial(async () => {
        await yielded();
        raw.prepare(sql).run(...params);
      });
    },
    async batch(statements: readonly { sql: string; params?: readonly unknown[] }[]): Promise<void> {
      return serial(async () => {
        await yielded();
        raw.exec("BEGIN IMMEDIATE");
        try {
          for (const { sql, params = [] } of statements) raw.prepare(sql).run(...params);
          raw.exec("COMMIT");
        } catch (err) {
          try { raw.exec("ROLLBACK"); } catch { /* keep the first error */ }
          throw err;
        }
      });
    },
    async close(): Promise<void> { try { raw.close(); } catch { /* already closed */ } },
  };
}

/**
 * THE DIALECT SEAM, and it is a MEASUREMENT rather than a fix — the node twin's `dialectShim`,
 * verbatim in substance.
 *
 * Files inside the phone bundle's closure still carry raw Postgres `now()` and `::` casts; the
 * ported ones are a 0.18 build lane's. Those statements are on the
 * INGEST path, not the lease path, so this file's verdict does not rest on them — but a drain that
 * dies mid-cycle would stop the poll that re-reads the lease, and then "no stand-down" would be a
 * cycle that never ran. Rewritten here so the gate keeps being reached, counted so the report
 * names what it patched rather than claiming a clean run.
 */
function dialectSeam(exec: PhoneSqlExecutor): { exec: PhoneSqlExecutor; rewrites: () => number } {
  let rewrites = 0;
  const rules: [RegExp, (...a: string[]) => string][] = [
    [/(^|[^A-Za-z0-9_.])now\(\)/gi, (_m, pre) => `${pre}CAST(unixepoch('subsec')*1000 AS INTEGER)`],
    [/::\s*(timestamptz|timestamp|uuid|text|jsonb|json|int|integer|bigint|numeric|boolean|date)\b/gi, () => ""],
    [/\bgreatest\s*\(/gi, () => "max("],
    [/\bleast\s*\(/gi, () => "min("],
    [/\s+for\s+update(\s+skip\s+locked)?/gi, () => ""],
  ];
  const rewrite = (sql: string): string => {
    let out = String(sql);
    for (const [re, to] of rules) {
      re.lastIndex = 0;
      if (!re.test(out)) { re.lastIndex = 0; continue; }
      re.lastIndex = 0;
      out = out.replace(re, to as (substring: string, ...args: unknown[]) => string);
      rewrites += 1;
    }
    return out;
  };
  return {
    rewrites: () => rewrites,
    exec: {
      all: (sql, params) => exec.all(rewrite(sql), params),
      run: (sql, params) => exec.run(rewrite(sql), params),
      batch: (statements) => exec.batch(statements.map((q) => ({ sql: rewrite(q.sql), params: q.params }))),
      close: () => exec.close(),
    },
  };
}

interface Line { event: string; detail: Record<string, unknown> }

/**
 * ══ A RECORDED LINE, AS THE DEVICE WOULD HAVE WRITTEN IT ══════════════════════════════════════
 *
 * The `log` seam below stores `detail` raw, which is right — it is what the engine handed over.
 * Rendering it with `JSON.stringify` was not: an `Error` has no enumerable fields, so every
 * failure in a refusal message here read `err: {}`, and the one this file refused on twice —
 * `organizer_stand_down_write_failed` — therefore named no class, no code and no cause. The
 * production logger reduces a thrown value to `errorClass` + `errorCode`, and to `errorText`
 * where the throw was a string; a message built any other way is a double that fails differently
 * from production, and `err: {}` was read for a day as a fact about the engine.
 *
 * So the bytes in a refusal here are the bytes a phone writes: one line through the real
 * `createSidecarLog`, sink captured. Bounded by the caller, as before.
 */
function asDeviceWrote(l: Line): string {
  let out = "";
  createSidecarLog({ sink: (line) => { out = line; } })(l.event, l.detail);
  /* The logger never throws and a dropped line is its documented outcome, so an empty answer is
     reported as itself rather than left as a blank in a refusal sentence. */
  return out === "" ? "[the logger wrote nothing]" : out;
}

/** One phone, as the app composes it: its own store file, its own durable install id. */
interface Phone {
  engine: PhoneEngine;
  lines: Line[];
  exec: PhoneSqlExecutor;
}

const open: PhoneEngine[] = [];
const dirs: string[] = [];

async function bootPhone(o: {
  user: string;
  installId: string;
  file: string;
  machineName?: string;
  lines?: Line[];
}): Promise<Phone> {
  const lines = o.lines ?? [];
  const seam = dialectSeam(nodeExecutor(o.file));
  const engine = await startPhoneEngine({
    exec: seam.exec,
    imap: {
      host: HOST, port: PORT, secure: false,
      auth: { user: o.user, pass: "test" },
      smtp: { host: HOST, port: SMTP_PORT, secure: false },
      sentDomain: "trafficflow.test",
    },
    machineName: o.machineName ?? "a phone",
    installId: o.installId,
    keks: { 1: "b".repeat(64) },
    log: (event, detail) => { lines.push({ event, detail }); },
  });
  open.push(engine);
  return { engine, lines, exec: seam.exec };
}

/** The one mailbox `startPhoneEngine` seeded from the config. */
function seedMailboxId(p: Phone): string {
  const ids = Object.keys(p.engine.runtimes().organizer);
  expect(ids, "the composition seeds exactly one mailbox from its config").toHaveLength(1);
  return ids[0]!;
}

/** The person's Connect, with their marker as `mailboxes.ts#organizeHere` sends it. */
const personPress = (p: Phone): RequestInit => ({
  method: "POST",
  headers: { authorization: `Bearer ${p.engine.sessionToken}`, "content-type": "application/json" },
  body: JSON.stringify({ consent: "person" }),
});

async function consent(p: Phone, mailboxId: string): Promise<number> {
  const res = await p.engine.handle(new Request(
    `http://sidecar/local/mailboxes/${mailboxId}/organize`,
    personPress(p),
  ));
  return res.status;
}

/** The same press as {@link consent}, with the BODY — the refusal names the holder in it. */
async function rivalPress(p: Phone, mailboxId: string): Promise<{
  status: number;
  body: { error?: { code?: string }; holder?: { name?: string; kind?: string } };
}> {
  const res = await p.engine.handle(new Request(
    `http://sidecar/local/mailboxes/${mailboxId}/organize`,
    personPress(p),
  ));
  const body = await res.json().then((b) => b as never, () => ({} as never));
  return { status: res.status, body };
}

interface Claim {
  installId: string; kind: string; nonce: string; displayName: string; heartbeat: string;
}

/**
 * WHAT THE GATE DID, and the observable is the FOLDER — never `organizer.organizing`.
 *
 * `organizing: true` is the state a runtime is CONSTRUCTED in (`engine.ts`: a row with no
 * stand-down reason starts organizing and the first gate confirms or replaces it). A waiter on
 * that flag is settled by its own setup and returns before a single lease read: measured here, it
 * answered `organizing: true` moments after consent on a mailbox holding NO claim at all, and both
 * arms of this file passed for nothing. So the wait is for a CLAIM THIS INSTALL WROTE to appear on
 * the server, or for a stand-down line, whichever comes first.
 */
interface GateSeen {
  /** Every claim in the folder, as an independent client sees it. */
  claims: Claim[];
  /** This install's own, by id. */
  ours: Claim[];
  /** …and every one of ours the folder held at ANY moment of the wait. */
  everOurs: Claim[];
  /** When each of ours was first observed, ascending — the renewal gaps are the differences. */
  oursSeenAt: number[];
  /** Every claim it held at any such moment, ours or a stranger's — the union, not the end state. */
  everAll: Claim[];
  stood: Line[];
  /** Distinct event names the engine emitted — what a timeout has to say for itself. */
  events: string[];
  /**
   * THE DECISION LINES, WHOLE, AND THEY RIDE EVERY FAILURE MESSAGE.
   *
   * A red here is read once, by somebody who cannot re-run it with the same folder: the gate's
   * own verdict and the stand-down's `ownClaimTerm` are the two facts that separate "a stranger
   * holds it", "a clone holds it", "we do" and "the write was lost", and a message without them
   * sends the reader to instrument what has already been measured.
   */
  why: string;
  organizing: boolean;
  reason: string | null;
  /**
   * THE HOLDER'S DISPLAY NAME OFF THE RUNTIME — the third member the phone's Settings panel reads.
   *
   * `organizing`, `reason` and `heldBy` are exactly what `standaloneHere()` in `apps/mobile` turns
   * into the sentence under "This phone", and `reason` is the one that DECIDES: a claim that named
   * nothing and every relaunch off this install's own row both leave `heldBy` null with the reason
   * standing, so a panel branching on the name calls them free mailboxes.
   */
  heldBy: string | null;
}

/**
 * THE FIRST GATE IS NOT THE MEASUREMENT — TWO RENEW CYCLES ARE.
 *
 * Measured in this file: the install writes its claim 1.8 s after consent and stands down against
 * it at 19 s, on the cycle after. A waiter that returned at the first claim was GREEN for the
 * whole defect, which is the same vacuity as waiting on `organizing` — one poll interval later the
 * answer reverses. So after the claim appears this keeps watching for `observeMs`, which is two
 * `DEFAULT_POLL_INTERVAL_MS` plus a margin, and returns EARLY the moment a stand-down is logged.
 */
const POLL_MS = DEFAULT_POLL_INTERVAL_MS;
const TWO_CYCLES_MS = 2 * POLL_MS + 10_000;
/**
 * THREE RENEWALS IS THE CELL'S INTENT; THE WINDOW THAT HOLDS THEM IS DERIVED.
 *
 * The count says what "it keeps the mailbox" has to mean — a gate that ran repeatedly, not an idle
 * one — so it stays at three. The hidden pin was the WINDOW: `3 * POLL_MS + 10 s` assumed one
 * renewal per base interval, untrue once an idle mailbox rests on the ladder (15/45/105 s). It is
 * walked out of `nextIdlePollMs` instead, and CLAMPED at `n * IDLE_POLL_CEILING_MS` — the gap arm
 * restated, since no renewal may exceed the ceiling. Without that clamp a ladder mutated never to
 * come back pushes the window past any clock and the cell hangs instead of failing.
 */
const TARGET_RENEWALS = 3;
function windowForRenewals(n: number): number {
  let delay = DEFAULT_POLL_INTERVAL_MS;
  let at = 0;
  for (let i = 0; i < n; i += 1) {
    at += delay;
    delay = nextIdlePollMs(delay, DEFAULT_POLL_INTERVAL_MS, IDLE_POLL_CEILING_MS);
  }
  return Math.min(at, n * IDLE_POLL_CEILING_MS);
}
const THREE_CYCLES_MS = windowForRenewals(TARGET_RENEWALS) + 10_000;

/**
 * THE CELL'S CLOCK, DERIVED FROM THE SAME BOUND AS ITS WINDOW.
 *
 * A hard-coded 300 s here was smaller than the window's own clamped worst case, so a ladder that
 * stopped renewing timed the cell OUT instead of failing its assertion — the clock decided, and a
 * control that reddens on a timeout has not watched the guard catch anything. This is the observe
 * window plus the phase-1 deadline the cells pass plus slack for boot and teardown.
 */
const CELL_TIMEOUT_MS = THREE_CYCLES_MS + 120_000 + 60_000;

async function afterFirstGate(
  p: Phone, user: string, mailboxId: string, installId: string,
  o: { deadlineMs?: number; observeMs?: number } = {},
): Promise<GateSeen> {
  const deadlineMs = o.deadlineMs ?? 90_000;
  const observeMs = o.observeMs ?? TWO_CYCLES_MS;
  const until = Date.now() + deadlineMs;
  /**
   * EVERY CLAIM THE FOLDER EVER HELD during the wait, keyed by nonce — the union, not the last
   * snapshot. A gate that appends, refuses and then RELEASES leaves an empty folder behind, so a
   * poll that only reads the end state cannot tell "nothing was ever written" from "two were
   * written and both were taken back", and those are opposite defects.
   */
  const everSeen = new Map<string, Claim>();
  /* WHEN each nonce first appeared to an independent reader. The gaps between consecutive ones are
     what the ladder is allowed to stretch, so they have to be observed rather than inferred; a poll
     interval of 300 ms/1 s makes each reading an upper bound on the true gap, which is the safe
     direction for a ceiling assertion. */
  const firstSeenAt = new Map<string, number>();
  const read = async (): Promise<GateSeen> => {
    const claims = await claimsOnServer(user);
    for (const c of claims) {
      if (!everSeen.has(c.nonce)) firstSeenAt.set(c.nonce, Date.now());
      everSeen.set(c.nonce, c);
    }
    const state = p.engine.runtimes().organizer[mailboxId]!;
    const decisions = p.lines.filter((l) => l.event === "lease_lost_race"
      || l.event === "organizer_stand_down"
      || l.event.endsWith("_failed"));
    const folder = [...everSeen.values()]
      .map((c) => `${c.installId === installId ? "ours" : "foreign"}/${c.kind}/nonce:${c.nonce.slice(0, 6)}`)
      .join(" + ");
    return {
      claims,
      ours: claims.filter((c) => c.installId === installId),
      everOurs: [...everSeen.values()].filter((c) => c.installId === installId),
      oursSeenAt: [...everSeen.values()]
        .filter((c) => c.installId === installId)
        .map((c) => firstSeenAt.get(c.nonce) ?? 0)
        .sort((a, b) => a - b),
      everAll: [...everSeen.values()],
      stood: standDowns(p.lines),
      events: [...new Set(p.lines.map((l) => l.event))],
      why: `folder ever held [${folder || "nothing"}], now ${claims.length}; `
        + (decisions.length === 0
          ? `no decision line; the engine emitted ${[...new Set(p.lines.map((l) => l.event))].join(", ")}`
          : decisions.map((l) => asDeviceWrote(l).slice(0, 300)).join(" | ")),
      organizing: state.organizing,
      reason: state.reason,
      heldBy: state.heldBy,
    };
  };
  // PHASE 1 — until this install's claim is on the server, or it stands down trying. 300 ms, not
  // two seconds: the gate appends, verifies, refuses and releases inside one cycle, and a claim
  // that existed for a moment is a fact about the folder.
  for (;;) {
    const seen = await read();
    if (seen.ours.length > 0 || seen.stood.length > 0) break;
    if (Date.now() >= until) return seen;
    await new Promise((r) => setTimeout(r, 300));
  }
  // PHASE 2 — two renew cycles of watching it keep the mailbox.
  const observeUntil = Date.now() + observeMs;
  for (;;) {
    const seen = await read();
    if (seen.stood.length > 0) return seen;
    if (Date.now() >= observeUntil) return seen;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Every claim in `ohmail/_meta`, read by a client this engine knows nothing about. */
async function claimsOnServer(user: string): Promise<Claim[]> {
  const c = new ImapFlow({
    host: HOST, port: PORT, secure: false, auth: { user, pass: "test" }, logger: false,
  });
  await c.connect();
  try {
    const paths = (await c.list()).map((b) => b.path);
    const meta = paths.find((p) => p.replace(/[./]/g, "/") === META_FOLDER.replace(/[./]/g, "/"));
    if (meta === undefined) return [];
    const lock = await c.getMailboxLock(meta);
    try {
      if ((c.mailbox === false ? 0 : c.mailbox.exists) === 0) return [];
      const out: Claim[] = [];
      for await (const msg of c.fetch("1:*", { uid: true, headers: true })) {
        /* A ROW WITH NO HEADERS IS A MESSAGE BEING EXPUNGED UNDER US, not a claim with none. The
           gate appends and expunges inside one cycle and this reads the folder every 300 ms, so
           the race is ordinary; `msg.headers` came back undefined and the reader threw. Skipped,
           because the claim it would have described is on its way out of the folder anyway. */
        if (msg.headers === undefined) continue;
        const h = msg.headers.toString("utf8");
        const pick = (n: string): string =>
          (new RegExp(`^${n}:\\s*(.*)$`, "im").exec(h)?.[1] ?? "").trim();
        // `X-Ohmail-Lease: 1` is the claim discriminator (`formatClaim`), and the value matters:
        // a reader that matched the word `claim` here found nothing and reported an empty folder
        // on a mailbox holding one — measured, in this file, on its first run.
        if (pick("X-Ohmail-Lease") !== "1") continue;
        out.push({
          installId: pick("X-Ohmail-Install-Id"),
          kind: pick("X-Ohmail-Organizer-Kind"),
          nonce: pick("X-Ohmail-Nonce"),
          displayName: pick("X-Ohmail-Display-Name"),
          heartbeat: pick("X-Ohmail-Heartbeat"),
        });
      }
      return out;
    } finally { lock.release(); }
  } finally { await c.logout().catch(() => undefined); }
}

const standDowns = (lines: Line[]): Line[] =>
  lines.filter((l) => l.event === "organizer_stand_down");

afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop().catch(() => undefined);
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function storeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-phone-claim-"));
  dirs.push(dir);
  return dir;
}

/**
 * ══ AND THE REFUSAL MESSAGE ITSELF, which is the thing that was read wrong ════════════════════
 *
 * No server and no store: {@link asDeviceWrote} is a pure function of a recorded line, so it runs
 * in BOTH projects and on a host with nothing up. That is deliberate — this is the half that was
 * lying, and a control that only runs where the rest of the file runs would have been skipped in
 * exactly the runs that produced `err: {}`.
 */
describe("a failing case reports what a phone would have written", () => {
  it("names the class of a thrown Error, which `JSON.stringify` reduced to `{}`", () => {
    const detail = { mailboxId: "mb-1", err: new TypeError("tx.execute is not a function") };
    /* THE DEFECT, measured rather than described: an Error has no enumerable fields. */
    expect(JSON.stringify({ err: detail.err }), "an Error stringifies to something readable")
      .toBe('{"err":{}}');
    const said = asDeviceWrote({ event: "organizer_stand_down_write_failed", detail });
    expect(said, "the refusal message names no class").toContain('"errorClass":"TypeError"');
    expect(said, "the line is not the event it is about").toContain("organizer_stand_down_write_failed");
    /* AND THE DRIVER'S MESSAGE IS STILL NOT IN IT — the logger's rule, unchanged by this file. */
    expect(said, "a driver's prose reached a log line").not.toContain("tx.execute");
  });

  it("carries a thrown STRING's own text, which class and code cannot say", () => {
    const said = asDeviceWrote({
      event: "organizer_stand_down_write_failed",
      detail: { mailboxId: "mb-1", err: "upsert refused: no row for this install" },
    });
    expect(said).toContain('"errorClass":"String"');
    expect(said, "the one thrown value whose whole diagnosis is its text lost it")
      .toContain("upsert refused: no row for this install");
  });

  it("says so rather than printing a blank when the logger drops the line", () => {
    /* The logger never throws and a lost line is its documented outcome, so the absence has to be
       readable: a blank inside a refusal sentence reads as "the engine emitted nothing". */
    const cyclic: Record<string, unknown> = { mailboxId: "mb-1" };
    cyclic.self = cyclic;
    expect(asDeviceWrote({ event: "not_an_event_name_at_all!", detail: cyclic }).length)
      .toBeGreaterThan(0);
  });
});

describe.skipIf(ON_DEVICE_STORE)("the default project does not substitute the device schema", () => {
  it("states the premise, so this file cannot pass here by contributing nothing", () => {
    expect(EXPECTED_DIALECT).toBe("pg");
  });
});

describe.runIf(ON_DEVICE_STORE && !SERVER_UP)("the private mail server this file measures against", () => {
  it(`is NOT answering on ${HOST}:${PORT} — the four cases below measured nothing in this run`, () => {
    /* Named rather than silent: a skip nobody can act on is how a suite stops measuring, and this
       one says which port was closed. Start it with
       `sg docker -c "docker compose up -d greenmail"`, or point OHMAIL_PHONE_IMAP_PORT at a private
       container. It asserts the premise it is named for rather than the absence it was written
       around — a case that can only pass is not a case. */
    expect(SERVER_UP, "the probe says the server answers, so these cases should have RUN").toBe(false);
  });
});

describe.runIf(ON_DEVICE_STORE && SERVER_UP)("a phone's own claim, on a real server", () => {
  it("CONSENT → CLAIM: the install writes its own claim, with the kind a phone stamps", async () => {
    const user = `pre2-first-${randomUUID()}@trafficflow.test`;
    const installId = `install-marker-${randomUUID()}`;
    const phone = await bootPhone({
      user, installId, file: join(storeDir(), "engine.db"), machineName: "the measured phone",
    });
    const mailboxId = seedMailboxId(phone);

    expect(await consent(phone, mailboxId)).toBe(200);
    const seen = await afterFirstGate(phone, user, mailboxId, installId, { observeMs: 0 });

    // Read by a client this engine knows nothing about: exactly one claim, this install's id, the
    // phone's kind. This is the evidence the gate ran — `organizer.organizing` is not, see
    // {@link afterFirstGate}.
    expect(seen.claims, `no claim was written — ${seen.why}`).toHaveLength(1);
    expect(seen.ours).toHaveLength(1);
    expect(seen.ours[0]!.kind).toBe("mobile");
    expect(seen.ours[0]!.displayName).toBe("the measured phone");
    expect(seen.stood.map((l) => l.detail), "it stood down inside its first gate").toEqual([]);
  }, 180_000);

  it("THE ID SURVIVES A RESTART — the relaunch claims under the id it wrote, not a second one", async () => {
    const user = `pre2-restart-${randomUUID()}@trafficflow.test`;
    const installId = `install-marker-${randomUUID()}`;
    const file = join(storeDir(), "engine.db");

    const first = await bootPhone({ user, installId, file, machineName: "the measured phone" });
    const mailboxId = seedMailboxId(first);
    expect(await consent(first, mailboxId)).toBe(200);
    const before = await afterFirstGate(first, user, mailboxId, installId, { observeMs: 0 });
    expect(before.ours, `the first launch wrote no claim — ${before.why}`).toHaveLength(1);
    /* THE NONCE THE FIRST LAUNCH WROTE — the value the relaunch's own write is read against. */
    const beforeNonce = before.ours[0]!.nonce;

    /* THE RESTART. The store file and the install id are the app's two durable things; the nonce
       is not, and that is the point — `lastNonce` is memory-only, so a fresh process trusts its
       own id exactly once, which is what own-role resumption rests on. A composition with a second
       identity source fails HERE, as a stand-down whose `ownClaimTerm` reads `install_id`. */
    await open.pop()!.stop();
    /* AND THE STOP GAVE THE CLAIM BACK — read off the SERVER, not off a local row. A stop used to
       leave the record standing, so the relaunch below verified against its own residue with no
       armed nonce to compare it to; the mailbox meanwhile had an organizer that had gone, and the
       person's other machine was refused it for the staleness window. */
    expect(
      await claimsOnServer(user),
      "the stop left its claim in the folder, so no other install may take this mailbox until it "
        + "goes stale",
    ).toEqual([]);
    const second = await bootPhone({ user, installId, file, machineName: "the measured phone" });
    expect(seedMailboxId(second)).toBe(mailboxId);
    const after = await afterFirstGate(second, user, mailboxId, installId, { observeMs: 4_000 });

    /* THE IDENTITY IS WHAT THIS CASE IS ABOUT, and it is durable: the relaunch's own claim carries
       the id the first launch wrote, and NO claim bearing any other id ever appears. A second
       identity source in the composition — the store's account row standing in for the app's
       install marker — shows up here and nowhere else, as a folder holding two ids.

       THE RELAUNCH'S OWN WRITE IS READ FROM THE NONCE. This asked for TWO of our nonces in the
       folder, which held while the door handed the engine back BEFORE its gate ran. The door now
       AWAITS its launch — it refuses one the mail server answered with a no — so by the first read
       the gate has appended and expunged and the write is invisible: measured here as `folder ever
       held [ours/mobile/nonce:…], now 1`, no decision line. The value that survives the restart is
       the nonce: the claim standing is NOT the one the first launch wrote, and `lastNonce` is
       memory-only, so a fresh process cannot reproduce the old one. A relaunch that adopted the
       standing claim without renewing, or never ran its gate at all, keeps it and fails here. */
    expect(after.ours, `the relaunch left no claim standing — ${after.why}`).toHaveLength(1);
    expect(
      after.ours[0]!.nonce,
      "the relaunch wrote no claim of its own — the claim standing still carries the nonce the "
        + `first launch wrote (${beforeNonce.slice(0, 6)}) — ${after.why}`,
    ).not.toBe(beforeNonce);
    /* EVERY MOMENT OF THE WAIT, not the end state: a second id that appeared and was expunged
       again inside one renew is exactly the shape this case is named for. An EMPTY union would
       pass that filter for nothing, so it is asserted non-empty first. */
    expect(after.everAll.length, `the identity check read an empty folder — ${after.why}`)
      .toBeGreaterThan(0);
    expect(
      after.everAll.filter((c) => c.installId !== installId),
      "a claim under a second identity appeared after the restart",
    ).toEqual([]);

    /* AND THE RELAUNCH TAKES THE MAILBOX BACK. `stop()` hands the claim back, so the second launch
       meets an EMPTY folder and writes a claim of its own — there is no residue to verify against
       and no `no_armed_nonce` reading to make. What identifies this install's claim is the pair it
       is read by: its own install id AND its own nonce. Measured on this server: one claim
       standing under a nonce the first launch never wrote, and no decision line of any kind. */
    expect(after.stood.map((l) => l.detail), `the relaunch stood down — ${after.why}`).toEqual([]);
    expect(after.ours[0]!.kind).toBe("mobile");
    expect(after.ours[0]!.installId).toBe(installId);
  }, 240_000);

  /**
   * THE CASE THE STOP USED TO BE — a phone keeping its mailbox across three renews, on a real
   * server.
   *
   * Before mail 0103 this install held its claim for one poll interval and then stood down against
   * its own renew residue (`ownClaimTerm: our_last_nonce`, its own display name as the holder,
   * `organized_elsewhere:unknown`), released its own claim, and started over — so the mailbox
   * ended with no organizer and nothing was filed. A renew APPENDS before it expunges, and the
   * older copy parsed as a kind no reader could rank. The mechanism and its desktop pair control
   * are in `packages/core/test/adapters/organizer-kind-mobile-own-residue.test.ts`.
   *
   * THREE CYCLES, not two, and that is the whole measurement: the stop fired at the SECOND renew,
   * so a two-cycle window is exactly as long as the defect needed and no longer. Measured at
   * 0103: the folder collected three nonces, one claim stood at the end, and the engine emitted no
   * decision line at all.
   */
  it("IT KEEPS THE MAILBOX: three renews, one claim standing, no stand-down", async () => {
    const user = `pre2-residue-${randomUUID()}@trafficflow.test`;
    const installId = `install-marker-${randomUUID()}`;
    const phone = await bootPhone({
      user, installId, file: join(storeDir(), "engine.db"), machineName: "the measured phone",
    });
    const mailboxId = seedMailboxId(phone);
    expect(await consent(phone, mailboxId)).toBe(200);

    const seen = await afterFirstGate(phone, user, mailboxId, installId,
      { observeMs: THREE_CYCLES_MS, deadlineMs: 120_000 });

    // IT RENEWED, rather than sitting on one claim, so "no stand-down" is a statement about a gate
    // that ran repeatedly and not about an idle one. The COUNT is derived from the shipped ladder
    // (an idle mailbox rests, so renewals fall at 15/45/105 s and this window holds fewer than one
    // per base interval); the vacuity floor below it is absolute and does not move with any
    // schedule. A hard-coded 3 here was a reading of the OLD fixed cadence and went stale the day
    // the ladder landed.
    // The floor is 2 — the initial claim plus AT LEAST ONE renewal — and it is absolute. Deriving
    // the expectation from the schedule means a mutation that stops the ladder renewing also drags
    // the derived number down with it, so the derivation alone could be satisfied by an engine that
    // never renewed at all. This floor is what makes the control below able to fail.
    const wantRenewals = Math.max(2, TARGET_RENEWALS);
    expect(seen.everOurs.length, `it renewed fewer than ${wantRenewals} times — ${seen.why}`)
      .toBeGreaterThanOrEqual(wantRenewals);

    // THE PROPERTY THE COUNT STOOD IN FOR, now asserted directly: the ladder may stretch a renewal
    // gap, but never past the ceiling it rests at, and that ceiling has to leave real room under
    // the bound that decides when somebody else may take this mailbox.
    const gaps = seen.oursSeenAt.slice(1).map((t, i) => t - seen.oursSeenAt[i]!);
    const slack = 5_000; // one reading interval plus a drain, not a budget
    expect(gaps.filter((g) => g > IDLE_POLL_CEILING_MS + slack),
      `a renewal gap ran past the idle ceiling — gaps ${JSON.stringify(gaps)}; ${seen.why}`)
      .toEqual([]);
    expect(IDLE_POLL_CEILING_MS * 2,
      "the idle ceiling must stay at or under half the stale bound, or a resting mailbox can be taken")
      .toBeLessThanOrEqual(DEFAULT_STALE_AFTER_MS);
    // ZERO STAND-DOWNS. The length is asserted through the DETAILS so a red names what it found.
    expect(seen.stood.map((l) => l.detail), `it stood down — ${seen.why}`).toEqual([]);
    // …and EXACTLY ONE claim standing, which is the invariant the widening had to not break: a
    // phone that organizes its own mailbox, and one organizer per mailbox.
    expect(seen.claims, `the mailbox does not end with exactly one claim — ${seen.why}`)
      .toHaveLength(1);
    expect(seen.ours[0]!.installId).toBe(installId);
    expect(seen.ours[0]!.kind).toBe("mobile");
    expect(seen.organizing, `the runtime stopped organizing — ${seen.why}`).toBe(true);
  }, CELL_TIMEOUT_MS);

  /**
   * TWO PHONES, ONE MAILBOX — and this is the TOCTOU sequence itself, end to end.
   *
   * The answer has moved twice. While `mobile` was unrankable the second install was refused by
   * rules 1/2. With the kind ranked, consenting IS a press and the later press won rule 6, so the
   * rival took a mailbox another install was actively organizing — and the phone's own product
   * rule ("no takeover verb exists here") was enforced only at a PRECHECK over a row up to one
   * poll old. This case walks straight through that window: the rival's row says nothing is held,
   * so the 409 does not fire, and the press reaches the fence with a live foreign claim in the
   * folder.
   *
   * It now yields there, because the press carries the verb the door wrote. The invariants: the
   * rival writes NO claim at any moment, the HOLDER keeps the mailbox, exactly one claim stands,
   * and the rival is told which machine has it.
   */
  it("TWO PHONES: the second READS the mailbox — a join never takes a live holder's", async () => {
    const user = `pre2-second-${randomUUID()}@trafficflow.test`;
    const holderId = `install-marker-${randomUUID()}`;
    const holder = await bootPhone({
      user, installId: holderId, file: join(storeDir(), "holder.db"), machineName: "the holder",
    });
    const mailboxId = seedMailboxId(holder);
    expect(await consent(holder, mailboxId)).toBe(200);
    const held = await afterFirstGate(holder, user, mailboxId, holderId, { observeMs: 0 });
    expect(held.ours, `the holder wrote no claim — ${held.why}`).toHaveLength(1);

    // A DIFFERENT INSTALL on the SAME mailbox — a second phone, or a restored copy that rotated
    // its marker. Its first gate reads the holder's live claim and stands it down.
    const rivalId = `install-marker-${randomUUID()}`;
    const rival = await bootPhone({
      user, installId: rivalId, file: join(storeDir(), "rival.db"), machineName: "the rival",
    });
    const rivalMailboxId = seedMailboxId(rival);

    /* THE DOOR ANSWERS FIRST, and on a real server it is the answer the rival gets: its own boot
       gate has already read the folder, stood the install down and written the holder columns, so
       the consent press meets the 409 before anything is stamped. This line USED TO READ 200 —
       `consent()` presses `/local/mailboxes/:id/organize`, the second consent path on this handle,
       and the door's refusal knew only about the shared spelling. So the rival's press reached the
       stamp writer with a live foreign claim in the folder, every time, and the only thing between
       it and the mailbox was rule 6 ranking presses by instant. */
    expect(await consent(rival, rivalMailboxId),
      "the local consent path is not guarded by the phone's door").toBe(409);

    /* AND THE FENCE IS WHAT THE NEXT LINES MEASURE — the window the door cannot close. The row is
       up to one poll old, so a press made between the holder's claim appearing and this install's
       next read passes the 409 honestly. Reproduced by putting the row back the way that poll left
       it: nothing held, no stand-down remembered. Nothing else is touched — the folder still holds
       the holder's live claim, which is the whole point. The CONSENT goes too: the refused press
       above recorded it, and this models a FIRST press that passed the 409, which carries none. */
    await rival.exec.run(
      `update mailboxes set organizer_role = 'organizer', organizer_state = null,
         organized_by_kind = null, organized_by_name = null, organized_by_install_id = null,
         disabled_reason = null, organize_consented_at = null, status = 'connected' where id = ?`,
      [rivalMailboxId],
    );
    expect(await consent(rival, rivalMailboxId),
      "the press did not reach the stamp writer, so nothing measured the fence").toBe(200);
    const seen = await afterFirstGate(rival, user, rivalMailboxId, rivalId, { observeMs: 0 });

    // THE RIVAL YIELDS, and it yields WITHOUT WRITING: `decideLease` refuses before the gate
    // appends, so the folder never holds two claims even for a moment. `everOurs` is the union
    // over the whole wait, so a claim that existed and was taken back fails here too.
    expect(seen.stood.length, `the rival took the mailbox — ${seen.why}`).toBeGreaterThan(0);
    expect(seen.ours, `the rival claimed a mailbox another phone is organizing — ${seen.why}`)
      .toHaveLength(0);
    expect(seen.everOurs, `the rival's claim was written and taken back — ${seen.why}`)
      .toHaveLength(0);
    expect(seen.claims, `the mailbox does not end with exactly one claim — ${seen.why}`)
      .toHaveLength(1);
    expect(seen.claims[0]!.installId, `the holder lost the mailbox — ${seen.why}`).toBe(holderId);

    /* AND THE RIVAL IS TOLD A TRUE SENTENCE, which is `reasonFor`'s phone arm measured on a real
       server rather than in a unit: `organized_elsewhere:mobile`, the reason
       `standDown_organized_elsewhere_mobile` renders. `:unknown` here would be the old fold, and
       the mailbox pane would say "another ohmail organizer" about a holder it can name. */
    expect([...new Set(seen.stood.map((l) => l.detail.disabledReason))])
      .toEqual(["organized_elsewhere:mobile"]);
    // `install_id` — a STRANGER holds it, not this install's own residue. The term that separates a
    // contested mailbox from the case above, and the positive control over the instrument.
    expect([...new Set(seen.stood.map((l) => l.detail.ownClaimTerm))]).toEqual(["install_id"]);

    /* AND THE HOLDER IS UNDISTURBED — the other half, and the one a displacement would break: it
       keeps renewing across two more cycles with no stand-down of its own. */
    const kept = await afterFirstGate(holder, user, mailboxId, holderId,
      { observeMs: TWO_CYCLES_MS, deadlineMs: 120_000 });
    expect(kept.stood.map((l) => l.detail), `the holder lost its mailbox — ${kept.why}`).toEqual([]);
    expect(kept.ours, `the holder stopped renewing — ${kept.why}`).toHaveLength(1);
    expect(kept.organizing, `the holder stopped organizing — ${kept.why}`).toBe(true);

    /**
     * ══ AND THE PHONE'S SETTINGS PANEL HAS THE FACT, LIVE ══════════════════════════════════
     *
     * PHONE-STAND-DOWN-IS-NOT-SAID. The panel read `Nothing organizes this mailbox` in exactly
     * this situation — the same sentence a FREE mailbox gets — and the fact was in the process the
     * whole time. `standaloneHere()` in `apps/mobile/src/engine/organizer-session.ts` reads these
     * three members off `runtimes().organizer` and nothing else, and `claimNoteLine` turns them
     * into the sentence, so this is the whole input to that sentence measured against a real
     * server rather than composed in a fixture.
     *
     * `reason` is asserted because it is the discriminator, and `:mobile` because the phone's
     * sentence forks on it: a mailbox another PHONE organizes is organized only while ohmail is
     * open on that phone, which is the one holder fact that changes what somebody should expect of
     * their mail. `heldBy` is the holder's own `machineName` — a display name, never an address.
     * It is read off the RIVAL now: the rival is the install that has something to be told.
     */
    const state = rival.engine.runtimes().organizer[rivalMailboxId]!;
    expect(state.organizing, "the rival still reports itself the organizer").toBe(false);
    expect(state.reason, "the panel has nothing to tell a free mailbox apart by")
      .toBe("organized_elsewhere:mobile");
    expect(state.heldBy, "the engine cannot name the machine that has the mailbox")
      .toBe("the holder");
    expect(state.heldBy, "the holder is named by an address").not.toContain("@");
  }, 420_000);
});

/**
 * ══ THE SAME PHONE, CONSENTED THROUGH ITS DOOR — which term of `rawOurs` fails ═════════════
 *
 * The block above presses the route. `claimHere` is what the APP presses, and it is not the same
 * act: it runs the door's own 409 pre-check, presses the route, and then AWAITS a forced gate
 * cycle (`apps/sidecar/src/mobile.ts`), so the first gate runs AT the press instead of a poll
 * interval later. That difference is the whole reason this block exists — the one prior reading of
 * `ownClaimTerm: other_nonce` came off a rig that pressed the route, and a press that forces a
 * cycle is the shape most likely to leave two of ours in the folder at one read.
 *
 * `rawOurs(c) = c.installId === self.installId && (self.lastNonce === null || c.nonce === lastNonce)`
 * has exactly two terms, so the experiment is to make each one false ALONE and read what the gate
 * does. The nonce case is the one the row is about: a claim under OUR id carrying a nonce this
 * process never armed is what a renew's append-then-expunge residue IS, and it is planted here
 * rather than raced for, so the reading does not depend on catching a window.
 */
describe.runIf(ON_DEVICE_STORE && SERVER_UP)("a phone's own claim, consented through the door", () => {
  /**
   * A claim in `ohmail/_meta` this engine did not write — a residue of ours, or a rival's.
   * Written with the product's OWN `formatClaim`, so what is planted is byte-for-byte what an
   * install writes; a hand-rolled header block would measure the parser's tolerance instead.
   */
  const plantClaim = async (user: string, c: {
    installId: string; kind: OrganizerKind; displayName: string; nonce: string;
    ageMs?: number; pressedAt?: Date;
  }): Promise<void> => {
    const at = new Date(Date.now() - (c.ageMs ?? 0));
    const raw = formatClaim({
      installId: c.installId, kind: c.kind, displayName: c.displayName,
      heartbeat: at, claimedAt: at, nonce: c.nonce,
      protocol: CLAIM_PROTOCOL, authorizedAt: c.pressedAt ?? null, capabilities: [],
    });
    const client = new ImapFlow({
      host: HOST, port: PORT, secure: false, auth: { user, pass: "test" }, logger: false,
    });
    await client.connect();
    try {
      const paths = (await client.list()).map((b) => b.path);
      const meta = paths.find((p) => p.replace(/[./]/g, "/") === META_FOLDER.replace(/[./]/g, "/"));
      expect(meta, `${META_FOLDER} is absent, so nothing was planted`).toBeDefined();
      await client.append(meta!, Buffer.from(raw, "utf8"));
    } finally { await client.logout().catch(() => undefined); }
  };

  /** The door's own consent — the verb `settings.tsx` presses, never a request composed here. */
  const pressDoor = async (p: Phone): Promise<ClaimHereOutcome> => await p.engine.claimHere({ by: "press" });

  it("DOOR CONSENT, THREE RENEWS: it keeps the mailbox and stands down against nothing", async () => {
    const user = `p018-door-${randomUUID()}@trafficflow.test`;
    const installId = `install-marker-${randomUUID()}`;
    const phone = await bootPhone({
      user, installId, file: join(storeDir(), "engine.db"), machineName: "the measured phone",
    });
    const mailboxId = seedMailboxId(phone);

    /* `claimed` is the door's word for "the consent is recorded and the gate has run". `held` here
       would mean the door refused its own install the mailbox, which is the defect one layer up. */
    expect(await pressDoor(phone), "the door refused this install its own free mailbox").toBe("claimed");

    const seen = await afterFirstGate(phone, user, mailboxId, installId,
      { observeMs: THREE_CYCLES_MS, deadlineMs: 120_000 });

    expect(seen.everOurs.length, `it renewed fewer than three times — ${seen.why}`)
      .toBeGreaterThanOrEqual(3);
    expect(seen.stood.map((l) => l.detail), `it stood down — ${seen.why}`).toEqual([]);
    expect(seen.claims, `the mailbox does not end with exactly one claim — ${seen.why}`)
      .toHaveLength(1);
    expect(seen.ours[0]!.installId).toBe(installId);
    expect(seen.ours[0]!.kind).toBe("mobile");
    expect(seen.organizing, `the runtime stopped organizing — ${seen.why}`).toBe(true);
  }, CELL_TIMEOUT_MS);

  /**
   * ══ THE NONCE TERM, FALSE ALONE — and the AGE of the copy is what it decides ═══════════════
   *
   * `rawOurs`'s second term is false for any claim under our id carrying a nonce this process did
   * not arm. That is true of two very different records, and the row is about only one of them:
   *
   *   · an OLDER copy — the renew's append-then-expunge residue, which is what a phone meets on
   *     every cycle of its own life. This case.
   *   · a NEWER one — which is a restored image of this install writing under our id, and standing
   *     down for it is the CLONE DEFENCE doing its job (`isOurs`, and the reason `lastNonce` is
   *     memory-only). The case below.
   *
   * They are separated here by heartbeat age and by nothing else, because `coalesce` keeps one
   * record per install id and the NEWER of the two becomes the coalesced candidate. Measured: an
   * older plant is carried through three renews untouched; a newer one stands the install down at
   * once. A single "a nonce we never armed" case would have reported whichever it happened to
   * write, and the row would have been answered by the order of two appends.
   *
   * What flips THIS case: a stand-down at all. It would read `ownClaimTerm: other_nonce` and the
   * row would be REPRODUCED, with the nonce named as the failing term.
   */
  it("A RENEW'S RESIDUE — our id, a nonce we never armed, OLDER: it is not a stranger", async () => {
    const user = `p018-residue-${randomUUID()}@trafficflow.test`;
    const installId = `install-marker-${randomUUID()}`;
    const phone = await bootPhone({
      user, installId, file: join(storeDir(), "engine.db"), machineName: "the measured phone",
    });
    const mailboxId = seedMailboxId(phone);
    expect(await pressDoor(phone)).toBe("claimed");
    const first = await afterFirstGate(phone, user, mailboxId, installId, { observeMs: 0 });
    expect(first.ours, `the door's own cycle wrote no claim — ${first.why}`).toHaveLength(1);

    /* OUR ID, A NONCE WE NEVER ARMED, LIVE, THE KIND A PHONE STAMPS — and OLDER than the claim
       the door's cycle just wrote, which is what makes it residue rather than a clone. Every
       other term is held equal to our own claim's, so a stand-down here has one possible cause. */
    const plantedNonce = `never-armed-${randomUUID()}`;
    await plantClaim(user, {
      installId, kind: "mobile", displayName: "the measured phone", nonce: plantedNonce,
      ageMs: 60_000,
    });

    const seen = await afterFirstGate(phone, user, mailboxId, installId,
      { observeMs: THREE_CYCLES_MS, deadlineMs: 120_000 });

    /* THE PLANT LANDED — asserted before the verdict, or a folder that never held it would pass
       this case for nothing (the vacuity the whole file is written against). */
    expect(
      seen.everAll.map((c) => c.nonce),
      `the planted residue never appeared in the folder — ${seen.why}`,
    ).toContain(plantedNonce);

    expect(seen.stood.map((l) => l.detail),
      `it stood down against its own renew residue — ${seen.why}`).toEqual([]);
    expect(seen.organizing, `the runtime stopped organizing — ${seen.why}`).toBe(true);
    expect(seen.ours[0]!.installId).toBe(installId);
  }, CELL_TIMEOUT_MS);

  /**
   * ══ THE SAME TERM, THE OTHER AGE — the clone defence, and the instrument's nonce arm ═══════
   *
   * The identical plant, NEWER than the standing claim. `coalesce` makes it the candidate,
   * `isOurs` refuses it as a restored copy of us, and the install stands down — `ownClaimTerm:
   * other_nonce`, `organized_elsewhere:mobile`, and the holder's display name its OWN.
   *
   * That is the gap row's reading, reproduced exactly — and it is the defence working, not the
   * defect. It earns its place twice over: it is the positive control for the nonce arm of the
   * instrument the case above reads its verdict from (an empty `stood` proves nothing where
   * `other_nonce` is unreachable), and it is the shape any rig that plants or races a second
   * write will see, which is worth having written down beside the case that does not.
   */
  it("A NEWER CLAIM UNDER OUR ID: the clone defence stands it down, and the term is the nonce", async () => {
    const user = `p018-clone-${randomUUID()}@trafficflow.test`;
    const installId = `install-marker-${randomUUID()}`;
    const phone = await bootPhone({
      user, installId, file: join(storeDir(), "engine.db"), machineName: "the measured phone",
    });
    const mailboxId = seedMailboxId(phone);
    expect(await pressDoor(phone)).toBe("claimed");
    expect((await afterFirstGate(phone, user, mailboxId, installId, { observeMs: 0 })).ours)
      .toHaveLength(1);

    await plantClaim(user, {
      installId, kind: "mobile", displayName: "the measured phone",
      nonce: `restored-copy-${randomUUID()}`,
    });

    const seen = await afterFirstGate(phone, user, mailboxId, installId,
      { observeMs: THREE_CYCLES_MS, deadlineMs: 120_000 });

    expect(seen.stood.length, `the clone defence did not fire — ${seen.why}`).toBeGreaterThan(0);
    /* THE NONCE ARM OF THE INSTRUMENT. `install_id` here would mean the id term failed instead,
       which is the composition defect the row's other candidate named. */
    expect([...new Set(seen.stood.map((l) => l.detail.ownClaimTerm))]).toEqual(["other_nonce"]);
    expect([...new Set(seen.stood.map((l) => l.detail.disabledReason))])
      .toEqual(["organized_elsewhere:mobile"]);
  }, CELL_TIMEOUT_MS);

  /**
   * ══ THE ID TERM, FALSE — the positive control over the instrument ══════════════════════════
   *
   * A live `local` claim under a DIFFERENT id is a paired desktop holding the mailbox. The phone
   * must stand down, and `ownClaimTerm` must read `install_id`. Without this case the one above
   * is a test that passes when the instrument is broken: a `stood` array that is empty because
   * nothing can ever fill it proves nothing about a claim being recognised.
   */
  it("A PAIRED DESKTOP HOLDS IT: the phone stands down, and the term is the install id", async () => {
    const user = `p018-desktop-${randomUUID()}@trafficflow.test`;
    const installId = `install-marker-${randomUUID()}`;
    const phone = await bootPhone({
      user, installId, file: join(storeDir(), "engine.db"), machineName: "the measured phone",
    });
    const mailboxId = seedMailboxId(phone);
    expect(await pressDoor(phone)).toBe("claimed");
    expect((await afterFirstGate(phone, user, mailboxId, installId, { observeMs: 0 })).ours)
      .toHaveLength(1);

    await plantClaim(user, {
      installId: `desktop-marker-${randomUUID()}`, kind: "local",
      displayName: "the paired laptop", nonce: `desktop-${randomUUID()}`,
      /* A PRESS, LATER THAN OURS — rule 6 is decided by the newest LIVE press, and a renewal
         writes `authorizedAt: null`, so a rival carrying none is ranked against our claim by the
         rest of `compareStrength` and this control turns on which of two writes landed first.
         Measured without it: the phone kept organizing and the inert plant simply sat there until
         it went stale, so the case asserted nothing about being told. The fact being modelled is
         a person walking to their laptop and pressing Start. */
      pressedAt: new Date(),
    });

    const seen = await afterFirstGate(phone, user, mailboxId, installId,
      { observeMs: THREE_CYCLES_MS, deadlineMs: 120_000 });

    expect(seen.stood.length, `the phone never noticed the desktop — ${seen.why}`)
      .toBeGreaterThan(0);
    /* THE TERM. `install_id` is the whole point of this case: it is the instrument answering about
       a genuine stranger, which is what licenses reading an empty `stood` above as a fact. */
    expect([...new Set(seen.stood.map((l) => l.detail.ownClaimTerm))]).toEqual(["install_id"]);
    expect(seen.heldBy, "the engine cannot name the machine holding the mailbox")
      .toBe("the paired laptop");
    expect(seen.heldBy, "the holder is named by an address").not.toContain("@");
  }, CELL_TIMEOUT_MS);

  /**
   * ══ AND A STALE ONE OF OURS IS NOT A HOLDER EITHER ═════════════════════════════════════════
   *
   * The same planted residue, one heartbeat older than `DEFAULT_STALE_AFTER_MS`. `rawIsLive` is
   * the other half of rule 1/2, so this separates "the nonce term did not matter" from "the nonce
   * term did not matter because nothing in the folder was live" — the second would make the case
   * above pass for a reason that has nothing to do with the question.
   */
  it("A STALE CLAIM OF OURS IN _meta: the phone keeps the mailbox", async () => {
    const user = `p018-stale-${randomUUID()}@trafficflow.test`;
    const installId = `install-marker-${randomUUID()}`;
    const phone = await bootPhone({
      user, installId, file: join(storeDir(), "engine.db"), machineName: "the measured phone",
    });
    const mailboxId = seedMailboxId(phone);
    expect(await pressDoor(phone)).toBe("claimed");
    expect((await afterFirstGate(phone, user, mailboxId, installId, { observeMs: 0 })).ours)
      .toHaveLength(1);

    const staleNonce = `stale-${randomUUID()}`;
    await plantClaim(user, {
      installId, kind: "mobile", displayName: "the measured phone", nonce: staleNonce,
      ageMs: DEFAULT_STALE_AFTER_MS + 60_000,
    });

    const seen = await afterFirstGate(phone, user, mailboxId, installId,
      { observeMs: TWO_CYCLES_MS, deadlineMs: 120_000 });

    expect(seen.everAll.map((c) => c.nonce),
      `the stale residue never appeared — ${seen.why}`).toContain(staleNonce);
    expect(seen.stood.map((l) => l.detail), `it stood down — ${seen.why}`).toEqual([]);
    expect(seen.organizing).toBe(true);
  }, 300_000);
});
