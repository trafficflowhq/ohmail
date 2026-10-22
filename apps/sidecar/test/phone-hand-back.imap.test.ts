/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE HAND-BACK, AGAINST A REAL SERVER — the claim goes, the row stays, and the gate takes it back
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * An iPhone leaving the foreground is suspended, and a claim held by a suspended app is the
 * double-organizer hazard: somebody's desktop stands itself down against a phone in a pocket. The
 * fourth door promises the honest thing — *"When you leave the app, it hands the mailbox back."*
 *
 * Neither of the engine's two existing acts does that. `stop()` closes the login and leaves the
 * claim to age out, which is twelve minutes in which the other machine refuses a mailbox it was
 * just told to take. The release ROUTE removes the claim and writes the row to `reader`, and a
 * reader never re-enters the gate without a human press (`engine.ts`: `rowRole === "reader" &&
 * !takeoverAuthorized` returns before the lease is read) — which is right for "stop organizing
 * here" and would make the resume need a button.
 *
 * So `handBack()` removes the CLAIM and writes no row, and everything below is that sentence being
 * true on a server:
 *
 *  1. consent writes a claim; the hand-back removes it, and the ROW still says organizer;
 *  2. the POLL does not undo it — the hand-back holds across a whole interval until a resume asks.
 *     This was the defect: releasing alone left the timer armed and the row permissive, so the next
 *     tick claimed the mailbox again for an install that was about to be suspended;
 *  3. a resume after the hand-back claims it again — no press anywhere;
 *  4. with a STRANGER holding the mailbox, the same resume stands this install down and leaves the
 *     stranger's claim exactly where it was. The automatic resume never displaces.
 *
 * Case 4 is what makes 1–3 evidence: "it claimed" and "it did not" are only readable apart because
 * a genuine foreign holder produces the other answer through the same code.
 *
 * ── THE OBSERVABLE IS THE FOLDER, NEVER `organizer.organizing` ────────────────────────────
 *
 * `organizing: true` is the state a runtime is CONSTRUCTED in, so a waiter on that flag is settled
 * by its own setup. `phone-claim-own.imap.test.ts` measured exactly that: the flag read true moments
 * after consent on a mailbox holding no claim at all. Every verdict here is read from
 * `ohmail/_meta` by an IMAP client this engine knows nothing about.
 *
 * ── IT RUNS UNDER THE SQLITE PROJECT, AND NAMES A CLOSED PORT ─────────────────────────────
 *
 * `phone-engine-boot.test.ts`'s reason: this composes the whole engine over the DEVICE store, so
 * it needs `vitest.sqlite.config.ts`'s schema substitution. Under the default project it asserts
 * the premise rather than skipping in silence, and a server that is not answering is a named
 * refusal rather than a green run measuring nothing.
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";
import { META_FOLDER, formatClaim } from "@trafficflow/core/adapters/organizer-lease";
import { DEFAULT_POLL_INTERVAL_MS } from "../src/engine.js";
import {
  startPhoneEngine,
  type PhoneEngine,
  type PhoneSqlExecutor,
  type PhoneSqlRows,
} from "../src/mobile.js";
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

/** `phone-claim-own.imap.test.ts`'s rule verbatim: the repo's own defaults, overridable per lane. */
const HOST = process.env.OHMAIL_PHONE_IMAP_HOST ?? process.env.IMAP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.OHMAIL_PHONE_IMAP_PORT ?? process.env.IMAP_PORT ?? 3143);
const SMTP_PORT = Number(process.env.OHMAIL_PHONE_SMTP_PORT ?? process.env.SMTP_PORT ?? 3025);

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
      return serial(async () => { await yielded(); raw.prepare(sql).run(...params); });
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
 * THE DIALECT SEAM — `phone-claim-own.imap.test.ts`'s, verbatim in substance and for its reason:
 * the ingest path still carries raw Postgres in this stack, and a drain that dies mid-cycle stops
 * the poll that re-reads the lease. The lease path itself is not rewritten, so no verdict below
 * rests on it.
 */
function dialectSeam(exec: PhoneSqlExecutor): PhoneSqlExecutor {
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
      out = out.replace(re, to as (substring: string, ...args: unknown[]) => string);
    }
    return out;
  };
  return {
    all: (sql, params) => exec.all(rewrite(sql), params),
    run: (sql, params) => exec.run(rewrite(sql), params),
    batch: (st) => exec.batch(st.map((q) => ({ sql: rewrite(q.sql), params: q.params }))),
    close: () => exec.close(),
  };
}

interface Line { event: string; detail: Record<string, unknown> }
interface Phone { engine: PhoneEngine; lines: Line[]; exec: PhoneSqlExecutor }

const open: PhoneEngine[] = [];
const dirs: string[] = [];

async function bootPhone(o: { user: string; installId: string; file: string }): Promise<Phone> {
  const lines: Line[] = [];
  const exec = dialectSeam(nodeExecutor(o.file));
  const engine = await startPhoneEngine({
    exec,
    imap: {
      host: HOST, port: PORT, secure: false,
      auth: { user: o.user, pass: "test" },
      smtp: { host: HOST, port: SMTP_PORT, secure: false },
      sentDomain: "trafficflow.test",
    },
    machineName: "the measured phone",
    installId: o.installId,
    keks: { 1: "b".repeat(64) },
    log: (event, detail) => { lines.push({ event, detail }); },
  });
  open.push(engine);
  return { engine, lines, exec };
}

function seedMailboxId(p: Phone): string {
  const ids = Object.keys(p.engine.runtimes().organizer);
  expect(ids, "the composition seeds exactly one mailbox from its config").toHaveLength(1);
  return ids[0]!;
}

/** A press on the phone's door. A CONSENT press here is the person's Start, so it carries
 *  `consent: "person"` exactly as `apps/mobile/src/net/mailboxes.ts#organizeHere` sends it. */
async function post(p: Phone, path: string): Promise<number> {
  const person = path.endsWith("/organize");
  const res = await p.engine.handle(new Request(`http://sidecar${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${p.engine.sessionToken}`,
      ...(person ? { "content-type": "application/json" } : {}),
    },
    ...(person ? { body: JSON.stringify({ consent: "person" }) } : {}),
  }));
  return res.status;
}

interface Claim { installId: string; kind: string; nonce: string; displayName: string }

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
        /* A row with no headers is a message being expunged under us — see the sibling file. */
        if (msg.headers === undefined) continue;
        const h = msg.headers.toString("utf8");
        const pick = (n: string): string =>
          (new RegExp(`^${n}:\\s*(.*)$`, "im").exec(h)?.[1] ?? "").trim();
        if (pick("X-Ohmail-Lease") !== "1") continue;
        out.push({
          installId: pick("X-Ohmail-Install-Id"),
          kind: pick("X-Ohmail-Organizer-Kind"),
          nonce: pick("X-Ohmail-Nonce"),
          displayName: pick("X-Ohmail-Display-Name"),
        });
      }
      return out;
    } finally { lock.release(); }
  } finally { await c.logout().catch(() => undefined); }
}

/**
 * A STRANGER'S CLAIM, APPENDED BY A CLIENT OF ITS OWN — the contention cell's other machine.
 *
 * `formatClaim` and not a hand-rolled header block: the claim this install has to stand down
 * against must be the one the product writes, or the cell measures a parser's tolerance rather
 * than an election. `kind: "local"` is a desktop, which is the machine the door's sentence names.
 */
async function appendForeignClaim(user: string, installId: string): Promise<string> {
  const nonce = randomUUID();
  const now = new Date();
  const raw = formatClaim({
    protocol: 1,
    installId,
    kind: "local",
    nonce,
    displayName: "Studio Mac",
    heartbeat: now,
    claimedAt: now,
    /* NOT a press. A desktop that took a FREE mailbox writes `null` here — arm 4's "nobody has
       ever organized this mailbox" — and that is the honest shape for the machine that picked the
       mailbox up while the phone was asleep. A pressed claim would make the cell easier and would
       measure the press's rank rather than the resume's restraint. */
    authorizedAt: null,
    capabilities: [],
  });
  const c = new ImapFlow({
    host: HOST, port: PORT, secure: false, auth: { user, pass: "test" }, logger: false,
  });
  await c.connect();
  try {
    const paths = (await c.list()).map((b) => b.path);
    const meta = paths.find((p) => p.replace(/[./]/g, "/") === META_FOLDER.replace(/[./]/g, "/"));
    expect(meta, "the engine has created ohmail/_meta by now").toBeDefined();
    await c.append(meta!, Buffer.from(raw, "utf8"));
  } finally { await c.logout().catch(() => undefined); }
  return nonce;
}

/** `organizer_role` as the row holds it — the half a hand-back must NOT touch. */
async function organizerRole(p: Phone, mailboxId: string): Promise<string | null> {
  const rows = await p.exec.all(
    "select organizer_role from mailboxes where id = ?", [mailboxId],
  );
  const first = rows.rows[0];
  return first === undefined ? null : String(first[0]);
}

/**
 * THE ROW, WAITED FOR — because the folder and the row are written by two statements.
 *
 * `untilOurClaim` returns the instant the CLAIM is readable in `ohmail/_meta`, and the gate writes
 * the row after the lease confirms that claim. Measured on this case before the promotion was moved
 * ahead of `acquireLeasePermit`: the row followed the claim by 188-214 ms over ten runs, all of it
 * two IMAP round trips, and a bare read here saw `reader` in nine of them. The engine's half is
 * fixed; this is the observer's half — the two writes are not one instant to a client watching the
 * server, so the read is bounded rather than immediate. It is a CEILING, not a sleep: it returns on
 * the first poll that answers, and the case asserts what it found.
 */
async function untilRole(
  p: Phone, mailboxId: string, want: string, deadlineMs = 5_000,
): Promise<{ role: string | null; waitedMs: number }> {
  const started = performance.now();
  for (;;) {
    const role = await organizerRole(p, mailboxId);
    if (role === want || performance.now() - started >= deadlineMs) {
      return { role, waitedMs: performance.now() - started };
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Wait until this install's claim is on the server, or say what the engine did instead. */
async function untilOurClaim(p: Phone, user: string, installId: string, deadlineMs = 90_000): Promise<{
  ours: Claim[]; all: Claim[]; why: string;
}> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const all = await claimsOnServer(user);
    const ours = all.filter((c) => c.installId === installId);
    if (ours.length > 0 || Date.now() >= until) {
      const decisions = p.lines.filter(
        (l) => l.event === "organizer_stand_down" || l.event.endsWith("_failed"),
      );
      return {
        ours, all,
        why: `folder holds ${all.length} claim(s); `
          + (decisions.length === 0
            ? `no decision line; events: ${[...new Set(p.lines.map((l) => l.event))].join(", ")}`
            : decisions.map((l) => `${l.event} ${JSON.stringify(l.detail).slice(0, 300)}`).join(" | ")),
      };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop().catch(() => undefined);
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function storeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-phone-handback-"));
  dirs.push(dir);
  return dir;
}

describe.skipIf(ON_DEVICE_STORE)("the default project does not substitute the device schema", () => {
  it("states the premise, so this file cannot pass here by contributing nothing", () => {
    expect(EXPECTED_DIALECT).toBe("pg");
  });
});

describe.runIf(ON_DEVICE_STORE && !SERVER_UP)("the mail server this file measures against", () => {
  it(`is NOT answering on ${HOST}:${PORT} — the cases below measured nothing in this run`, () => {
    /* Named rather than silent. Start it with `sg docker -c "docker compose up -d greenmail"`, or
       point OHMAIL_PHONE_IMAP_PORT at a private container. */
    expect(SERVER_UP, "the probe says the server answers, so these cases should have RUN").toBe(false);
  });
});

describe.runIf(ON_DEVICE_STORE && SERVER_UP)("handing the mailbox back, and taking it again", () => {
  it("HAND BACK: the claim leaves the mailbox and the ROW still says organizer", async () => {
    /**
     * Both halves, because either alone is a different act. A claim removed WITH the row demoted is
     * the release route, and its resume needs a press. A row left alone with the claim still
     * standing is `stop()`, and the other machine waits out the lapse.
     */
    const user = `handback-${randomUUID()}@trafficflow.test`;
    const installId = `install-marker-${randomUUID()}`;
    const phone = await bootPhone({ user, installId, file: join(storeDir(), "engine.db") });
    const mailboxId = seedMailboxId(phone);
    expect(await post(phone, `/local/mailboxes/${mailboxId}/organize`)).toBe(200);

    const claimed = await untilOurClaim(phone, user, installId);
    expect(claimed.ours, `no claim was written — ${claimed.why}`).toHaveLength(1);
    expect(claimed.ours[0]!.kind).toBe("mobile");
    /* BOUNDED, and the bound is the assertion: a claim in the folder with the row still saying
       `reader` is admissible only for as long as the gate takes to write the row behind it. See
       {@link untilRole} for what that was measured at. */
    const promoted = await untilRole(phone, mailboxId, "organizer");
    expect(promoted.role, `the row did not follow the claim within 5 s (${promoted.waitedMs | 0} ms)`)
      .toBe("organizer");

    const outcome = await phone.engine.handBack();
    expect(outcome).toHaveLength(1);
    expect(outcome[0]!.mailboxId).toBe(mailboxId);
    /* A COUNT, not a boolean: `null` would mean the search was refused and the claim may still
       stand, which is the state nothing may report as a hand-back. */
    expect(outcome[0]!.released, "the release could not enumerate this install's claims").not.toBeNull();
    expect(outcome[0]!.released!).toBeGreaterThan(0);

    const after = await claimsOnServer(user);
    expect(after.filter((c) => c.installId === installId),
      "our claim is still in the mailbox after the hand-back").toEqual([]);
    /* THE ROW DID NOT MOVE. This is what makes the resume automatic. */
    expect(await organizerRole(phone, mailboxId), "the hand-back demoted the row").toBe("organizer");
    expect(phone.engine.runtimes().organizer[mailboxId]!.organizing,
      "a handed-back install must not report itself organizing").toBe(false);
  }, 180_000);

  it("THE POLL DOES NOT UNDO IT — a hand-back holds until a resume asks", async () => {
    /**
     * THE DEFECT THIS CELL IS FOR. The hand-back released the claim and left the poll timer armed,
     * the row still saying organizer. So the very next tick ran the gate, found the mailbox free,
     * and claimed it again — for an install that was about to be suspended, which is a live claim
     * belonging to a phone doing no work and the one state the hand-back exists to prevent.
     *
     * Watched across a whole poll interval, and against the FOLDER: an assertion on
     * `organizer.organizing` would be settled by the field the hand-back itself writes.
     */
    const user = `handback-holds-${randomUUID()}@trafficflow.test`;
    const installId = `install-marker-${randomUUID()}`;
    const phone = await bootPhone({ user, installId, file: join(storeDir(), "engine.db") });
    const mailboxId = seedMailboxId(phone);
    expect(await post(phone, `/local/mailboxes/${mailboxId}/organize`)).toBe(200);
    const claimed = await untilOurClaim(phone, user, installId);
    expect(claimed.ours, `no claim was written — ${claimed.why}`).toHaveLength(1);

    await phone.engine.handBack();
    expect((await claimsOnServer(user)).filter((c) => c.installId === installId)).toEqual([]);

    /* A POLL INTERVAL AND A MARGIN. The desktop's own interval is 15 s, and `mayOrganize()` runs
       on EVERY drain pass (not only on a re-dial), so one tick is all the defect needed. */
    const drainsBefore = phone.lines.filter((l) => l.event === "sync_drain").length;
    const until = Date.now() + 25_000;
    while (Date.now() < until) {
      const all = await claimsOnServer(user);
      expect(all.filter((c) => c.installId === installId),
        "a poll re-claimed the mailbox this install had handed back").toEqual([]);
      await new Promise((r) => setTimeout(r, 1000));
    }
    /**
     * AND NO CYCLE RAN AT ALL, which is the timer's own half of the pair.
     *
     * The hand-back arms a refusal in the gate AND clears the poll timer, and each covers the
     * other: with the timer cleared no pass reaches the gate, and with the refusal armed a pass
     * that did reach it claims nothing. So removing either one alone is green — the honest reading
     * of a pair — and this assertion is what makes the TIMER half observable on its own: a tick
     * that ran would have emitted `sync_drain`.
     */
    expect(phone.lines.filter((l) => l.event === "sync_drain").length,
      "a poll cycle ran after the hand-back — the timer was not cleared").toBe(drainsBefore);
    expect(phone.engine.runtimes().organizer[mailboxId]!.organizing).toBe(false);
    /* AND THE ROW IS STILL UNTOUCHED, which is what lets the resume promote with no press. */
    expect(await organizerRole(phone, mailboxId)).toBe("organizer");
  }, 180_000);

  it("A RESUME RE-ARMS THE POLL — the phone keeps organizing without a second press", async () => {
    /**
     * THE OTHER HALF OF THE TIMER PAIR, and the one nothing watched. `handBack()` clears the poll
     * timer; `resume()` ran ONE forced cycle and returned without arming it again, so a phone
     * backgrounded and brought forward drained once and then went quiet — holding the row as
     * organizer with nothing polling, which reads as healthy on every surface.
     *
     * `syncUntilQuiet` deliberately does not arm (its own tail says the CALLER does), and every
     * other caller of it calls `schedule()`. The mutation that reddens this: remove the
     * `schedule()` from `resume()` in `apps/sidecar/src/engine.ts`.
     *
     * Watched as a SECOND drain after a whole poll interval, not as a field: `organizing` is set by
     * the resume itself and would be settled by the thing under test.
     */
    const user = `handback-rearm-${randomUUID()}@trafficflow.test`;
    const installId = `install-marker-${randomUUID()}`;
    const phone = await bootPhone({ user, installId, file: join(storeDir(), "engine.db") });
    const mailboxId = seedMailboxId(phone);
    expect(await post(phone, `/local/mailboxes/${mailboxId}/organize`)).toBe(200);
    const claimed = await untilOurClaim(phone, user, installId);
    expect(claimed.ours, `no claim was written — ${claimed.why}`).toHaveLength(1);

    await phone.engine.handBack();
    await phone.engine.resume();
    /* The resume's OWN forced cycle has run by here; everything after this is the timer. */
    const afterResume = phone.lines.filter((l) => l.event === "sync_drain").length;

    const until = Date.now() + 25_000;
    let later = afterResume;
    while (Date.now() < until && later === afterResume) {
      await new Promise((r) => setTimeout(r, 1000));
      later = phone.lines.filter((l) => l.event === "sync_drain").length;
    }
    expect(later,
      "no cycle ran in a whole poll interval after the resume — the timer handBack cleared was never re-armed",
    ).toBeGreaterThan(afterResume);
  }, 180_000);

  it("A PRESS-PATH RESUME ARMS NO SECOND LOOP — one poll timer, however often it is asked", async () => {
    /**
     * THE PRESS, not the hand-back. `claimHere` and `stopOrganizing` in `mobile.ts` call
     * `resume()` with NO hand-back before it, so the runtime's timer from `start()` is still
     * armed. Every armed timer re-arms itself in `schedule`'s `.finally`, so a resume that arms
     * a second one does not move the next poll — it starts a second LOOP that outlives the press,
     * and two gated cycles then race on the lease.
     *
     * Counted as DRAINS OVER A WINDOW, because the defect is a rate, not a state: one loop can
     * only drain about once per interval, two drain about twice. The window is derived from the
     * engine's own `DEFAULT_POLL_INTERVAL_MS` — the rig sets no interval — so the arithmetic
     * moves with the product rather than with a literal typed here.
     *
     * The mutation that reddens it: remove `if (timer) clearTimeout(timer);` from `schedule()`.
     */
    const user = `press-one-loop-${randomUUID()}@trafficflow.test`;
    const installId = `install-marker-${randomUUID()}`;
    const phone = await bootPhone({ user, installId, file: join(storeDir(), "engine.db") });
    const mailboxId = seedMailboxId(phone);
    expect(await post(phone, `/local/mailboxes/${mailboxId}/organize`)).toBe(200);
    const claimed = await untilOurClaim(phone, user, installId);
    expect(claimed.ours, `no claim was written — ${claimed.why}`).toHaveLength(1);

    /* THE DOOR'S OWN SHAPE: resume with nothing cleared, twice, as two presses would. */
    await phone.engine.resume();
    await phone.engine.resume();
    const base = phone.lines.filter((l) => l.event === "sync_drain").length;

    const intervals = 2;
    await new Promise((r) => setTimeout(r, DEFAULT_POLL_INTERVAL_MS * intervals + 2_000));
    const drained = phone.lines.filter((l) => l.event === "sync_drain").length - base;

    /* ONE loop over two intervals is at most three drains (the boundary tick can fall either
       side); TWO loops would be at least four. The bound is stated from the interval so a change
       to the product's cadence changes this arithmetic with it. */
    expect(drained,
      `${drained} drains in ${intervals} poll intervals after two presses — a second poll loop is running`,
    ).toBeLessThanOrEqual(intervals + 1);
  }, 180_000);

  it("THE GATE ITSELF REFUSES — a forced cycle claims nothing until a resume asks", async () => {
    /**
     * THE PAIR'S OTHER HALF, driven rather than inferred. The cell above shows no pass reaches the
     * gate; this one forces a pass THROUGH the gate and shows it claims nothing — the same
     * `syncUntilQuiet(force)` the resume runs, without the resume's clearing of the hand-back.
     *
     * That makes the two calls a decisive pair: one claims, one does not, and the only difference
     * between them is the flag. A cell that only watched an idle timer could not tell "the gate
     * refuses" from "nothing asked it".
     */
    const user = `handback-gate-${randomUUID()}@trafficflow.test`;
    const installId = `install-marker-${randomUUID()}`;
    const phone = await bootPhone({ user, installId, file: join(storeDir(), "engine.db") });
    const mailboxId = seedMailboxId(phone);
    expect(await post(phone, `/local/mailboxes/${mailboxId}/organize`)).toBe(200);
    const claimed = await untilOurClaim(phone, user, installId);
    expect(claimed.ours, `no claim was written — ${claimed.why}`).toHaveLength(1);

    await phone.engine.handBack();
    /* A FORCED CYCLE, through the route — `resume()` would clear the hand-back, which is the one
       thing this cell must not do. */
    expect(await post(phone, `/mailboxes/${mailboxId}/resync`)).toBe(202);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      expect((await claimsOnServer(user)).filter((c) => c.installId === installId),
        "a forced cycle claimed a mailbox this install had handed back").toEqual([]);
      await new Promise((r) => setTimeout(r, 1000));
    }

    /* AND THE SAME CALL CLAIMS once the resume has cleared it — the positive control, without
       which "it claimed nothing" is satisfied by a cycle that never ran. */
    await phone.engine.resume();
    const again = await untilOurClaim(phone, user, installId, 60_000);
    expect(again.ours, `the resume did not claim the mailbox back — ${again.why}`).toHaveLength(1);
  }, 180_000);

  it("RESUME: a forced cycle claims it again, with no press anywhere", async () => {
    const user = `handback-resume-${randomUUID()}@trafficflow.test`;
    const installId = `install-marker-${randomUUID()}`;
    const phone = await bootPhone({ user, installId, file: join(storeDir(), "engine.db") });
    const mailboxId = seedMailboxId(phone);
    expect(await post(phone, `/local/mailboxes/${mailboxId}/organize`)).toBe(200);
    const claimed = await untilOurClaim(phone, user, installId);
    expect(claimed.ours, `no claim was written — ${claimed.why}`).toHaveLength(1);

    await phone.engine.handBack();
    expect((await claimsOnServer(user)).filter((c) => c.installId === installId)).toEqual([]);

    /* THE APP'S RESUME, through the member it actually calls. It clears the hand-back and forces
       one gated cycle rather than waiting out a poll interval; nothing here writes
       `takeover_authorized_at`, because the whole point is that no press is needed. */
    await phone.engine.resume();
    const again = await untilOurClaim(phone, user, installId, 60_000);
    expect(again.ours, `the resume did not claim the mailbox back — ${again.why}`).toHaveLength(1);
    expect(again.ours[0]!.nonce,
      "the resume re-used the nonce it released, which is not a fresh claim")
      .not.toBe(claimed.ours[0]!.nonce);
  }, 180_000);

  it("REFUSED: with a desktop holding it, the same resume stands down and touches nothing", async () => {
    /**
     * The positive control over the instrument the two cases above read their verdict from, and
     * the property the design turns on: the automatic resume claims a FREE mailbox and never
     * displaces a holder. A press is what takes a mailbox from another machine, and no press
     * happens here.
     */
    const user = `handback-contended-${randomUUID()}@trafficflow.test`;
    const installId = `install-marker-${randomUUID()}`;
    const phone = await bootPhone({ user, installId, file: join(storeDir(), "engine.db") });
    const mailboxId = seedMailboxId(phone);
    expect(await post(phone, `/local/mailboxes/${mailboxId}/organize`)).toBe(200);
    const claimed = await untilOurClaim(phone, user, installId);
    expect(claimed.ours, `no claim was written — ${claimed.why}`).toHaveLength(1);

    await phone.engine.handBack();
    /* The desktop takes it while the phone is asleep. */
    const foreignInstall = `desktop-${randomUUID()}`;
    const foreignNonce = await appendForeignClaim(user, foreignInstall);

    await phone.engine.resume();
    /* Watched for a whole cycle: the phone must not claim, and the desktop's claim must survive. */
    const deadline = Date.now() + 45_000;
    let stood = false;
    for (;;) {
      const all = await claimsOnServer(user);
      expect(all.filter((c) => c.installId === installId),
        "the phone claimed a mailbox a desktop was holding").toEqual([]);
      stood = phone.lines.some((l) => l.event === "organizer_stand_down");
      if (stood || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const end = await claimsOnServer(user);
    expect(end.filter((c) => c.installId === installId),
      "the phone claimed a mailbox a desktop was holding").toEqual([]);
    expect(end.filter((c) => c.nonce === foreignNonce),
      "the phone removed the desktop's claim").toHaveLength(1);
    expect(stood, `the phone never stood down; folder: ${JSON.stringify(end)}`).toBe(true);
    expect(phone.engine.runtimes().organizer[mailboxId]!.organizing).toBe(false);
  }, 180_000);
});
