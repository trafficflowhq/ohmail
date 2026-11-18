import type { EngineMessage } from "@ohmail/wire";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { awayResponders, contacts, folderState, messages, notifyRules, rules, tags } from "@trafficflow/db";
import { META_FOLDER, parseClaim } from "@trafficflow/core/adapters/organizer-lease";
import {
  formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage,
} from "@trafficflow/core/adapters/organizer-profile";
import {
  HttpAdapter, MemoryMirrorStore, OhmailEngine, consentPartition, presentationReader, screenerSegments,
} from "@ohmail/client-engine";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";

/**
 * THE PROFILE-IMPORT DOOR ON THE DESKTOP TIER — the three confirm-flow routes, served by the
 * LOCAL engine against its own PGlite store and a real IMAP server.
 *
 * `packages/services` proves the merge and `packages/api` proves the wire, both against the
 * hosted composition; the webapp suite proves the card. What only THIS level can prove is that
 * the standalone desktop's engine — `createApp(localRoutes)` over on-disk PGlite, the sealed
 * credential row, `openMailboxImap`'s second dial — answers the same three verbs end to end:
 *
 *  1. CANDIDATE: a mailbox that arrives carrying another install's document gets a held marker
 *     from P.1's seed, and `GET /mailboxes/:id/profile-import` answers `found` with the counts
 *     of the document as it sits on the server — read over a REAL second IMAP connection opened
 *     from the stored credential, not from the sync loop's socket.
 *  2. APPLY writes the local store BY NATURAL KEY, on PGlite: the same `pg_advisory_xact_lock`
 *     transaction the hosted service runs (PGlite supports the lock — proven here by running
 *     it, not by reading about it), and concurrent applies leave ONE row per key because the
 *     store's driver additionally serializes whole transactions.
 *  3. DECLINE is durable: recorded in `audit_log` (the mail half, so the desktop HAS the
 *     table), it survives a relaunch of the same data directory and the identical document
 *     never asks again — and it KEEPS the document in the mailbox: this engine writes over it
 *     only after the Settings row's replace.
 *
 * Every mailbox read below is by an INDEPENDENT client, this suite's own convention: the folder
 * on the user's mailbox is the fact, and asking the code under test where it put something
 * proves nothing.
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
/** GreenMail's delimiter is `.`, so the canonical `ohmail/_meta` is `ohmail._meta`. */
const META_PATH = META_FOLDER.split("/").join(".");

function greenmail(): { host: string; port: number; secure: false; auth: { user: string; pass: string } } {
  return {
    host: IMAP_HOST, port: IMAP_PORT, secure: false,
    auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: "test" },
  };
}

/**
 * Remove the ORGANIZER CLAIM from `ohmail/_meta`, leaving the profile document standing — the
 * released-mailbox shape. This is what the folder looks like after "leave Cloud": the departing
 * organizer withdraws its claim and the settings document deliberately stays, which is the whole
 * product story the desktop door completes. Done by an independent client, so nothing about how
 * the folder got into this state involves the engine under test.
 */
async function withdrawClaim(cfg: ReturnType<typeof greenmail>): Promise<void> {
  const c = new ImapFlow({ ...cfg, logger: false });
  await c.connect();
  try {
    const lock = await c.getMailboxLock(META_PATH);
    try {
      const claimUids: number[] = [];
      for await (const m of c.fetch("1:*", { uid: true, source: true })) {
        if (m.source && parseClaim(m.source.toString("utf8")) !== null) claimUids.push(m.uid);
      }
      for (const uid of claimUids) {
        await c.messageDelete(String(uid), { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await c.logout();
  }
}

/** The settings documents in `ohmail/_meta`, read by an INDEPENDENT client. */
async function profileDocsOn(cfg: ReturnType<typeof greenmail>): Promise<Array<{ installId: string | null; tagNames: string[] }>> {
  const c = new ImapFlow({ ...cfg, logger: false });
  await c.connect();
  const out: Array<{ installId: string | null; tagNames: string[] }> = [];
  try {
    const lock = await c.getMailboxLock(META_PATH);
    try {
      for await (const m of c.fetch("1:*", { uid: true, source: true })) {
        const r = m.source ? parseProfileMessage(m.source.toString("utf8")) : null;
        if (r && !isMalformedProfile(r) && r.doc) out.push({ installId: r.installId, tagNames: r.doc.tagNames });
      }
    } finally {
      lock.release();
    }
  } finally {
    await c.logout();
  }
  return out;
}

/** Deliver one letter into the server's INBOX by an INDEPENDENT client. */
async function deliver(cfg: ReturnType<typeof greenmail>, from: string, subject: string): Promise<void> {
  const c = new ImapFlow({ ...cfg, logger: false });
  await c.connect();
  try {
    await c.append("INBOX", [
      `Message-ID: <${randomUUID()}@x.example>`, `From: ${from}`, `To: ${cfg.auth.user}`, `Subject: ${subject}`,
      "Content-Type: text/plain; charset=utf-8", "", "Hello.",
    ].join("\r\n"));
  } finally {
    await c.logout();
  }
}

/** The server folders (GreenMail paths, `.`-delimited) holding a subject, read by an independent client. */
async function serverFoldersHolding(
  cfg: ReturnType<typeof greenmail>, subject: string, among = ["INBOX", "ohmail.Screener"],
): Promise<string[]> {
  const c = new ImapFlow({ ...cfg, logger: false });
  await c.connect();
  const found: string[] = [];
  try {
    const listed = new Set((await c.list()).map((f) => f.path));
    for (const path of among.filter((p) => listed.has(p))) {
      const lock = await c.getMailboxLock(path);
      try {
        const hits = await c.search({ subject });
        if (hits && hits.length > 0) found.push(path);
      } finally {
        lock.release();
      }
    }
  } finally {
    await c.logout();
  }
  return found;
}

/** One request against the engine's own `handle`, carrying the per-launch bearer. */
async function call(
  s: Sidecar, method: string, path: string, body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await s.handle(new Request(`http://sidecar${path}`, {
    method,
    headers: {
      authorization: `Bearer ${s.sessionToken}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const dirs: string[] = [];
const running: Sidecar[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dataDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/**
 * A mailbox that travelled: install A configures the whole v1 payload, writes the document,
 * withdraws (stop + claim removed), and a FRESH install B attaches. Returns B with the held
 * marker already written by its own first drain's seed.
 */
async function travelledMailbox(o: { screenedOut?: string } = {}): Promise<{
  b: Sidecar; cfg: ReturnType<typeof greenmail>; bDir: string; kek: Buffer;
}> {
  const cfg = greenmail();

  const a = await createSidecar({
    dataDir: dataDir("ohmail-pfi-a-"), imap: cfg, machineName: "the previous Mac",
    pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000, profileFlushIntervalMs: 0,
  });

  await grantOrganizeConsent(a);
  running.push(a);
  await a.start();
  await a.syncUntilQuiet();
  const aId = a.world.accountId;
  await a.db.insert(contacts).values({ accountId: aId, address: "anna@x.example", name: "Anna" });
  await a.db.insert(rules).values({
    accountId: aId, kind: "sender", match: "anna@x.example", destination: "INBOX",
    provenance: "promoted", enabled: true,
  });
  if (o.screenedOut !== undefined) {
    await a.db.insert(rules).values({
      accountId: aId, kind: "sender", match: o.screenedOut, destination: "ohmail/Screened",
      provenance: "promoted", enabled: true,
    });
  }
  await a.db.insert(tags).values({ accountId: aId, name: "Invoices", hue: "moss" });
  await a.db.insert(notifyRules).values({ accountId: aId, kind: "sender", target: "boss@x.example" });
  await a.db.insert(awayResponders).values({
    accountId: aId, enabled: false, subject: "Away", body: "Back Monday.", audience: "screened_in",
  });
  await a.syncUntilQuiet();
  await a.stop();
  await withdrawClaim(cfg);

  /* Install B: a fresh data directory (a new install id), WITH a durable key and the password in
     the launch environment — the packaged app's shape — so the first run SEALS the credential.
     The sealed row is what the confirm routes dial the mailbox with: their read rides
     `openMailboxImap` over the stored credential, a second connection beside the sync loop's. */
  const bDir = dataDir("ohmail-pfi-b-");
  const kek = randomBytes(32);
  const b = await createSidecar({
    dataDir: bDir, imap: cfg, machineName: "this Mac",
    pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000, profileFlushIntervalMs: 0,
    keks: { 1: kek },
  });
  await grantOrganizeConsent(b);
  running.push(b);
  await b.start();
  // The first drain's seed meets the foreign document, records the held marker, and holds
  // write-behind — P.1's landed behaviour, which the routes below answer from.
  await b.syncUntilQuiet();
  return { b, cfg, bDir, kek };
}

describe("the desktop door: detect and confirm over the LOCAL engine", () => {
  it("candidate answers `found` with the travelling document's counts; concurrent applies leave one row per natural key; the question then rests", async () => {
    const { b } = await travelledMailbox();
    const mailboxId = b.world.mailboxId;

    // ── 1. THE QUESTION. The engine dials its own mailbox from the sealed credential and
    //       answers the counts of the document as it sits on the server right now.
    const candidate = await call(b, "GET", `/mailboxes/${mailboxId}/profile-import`);
    expect(candidate.status).toBe(200);
    expect(candidate.json).toMatchObject({
      state: "found",
      producer: { kind: "local" },
      counts: { screener: 1, rules: 1, notifyRules: 1, tags: 1, awayResponder: true },
    });
    const fingerprint = candidate.json.fingerprint as string;
    expect(fingerprint.length).toBeGreaterThan(0);

    // ── 2. THE ANSWER, RACED AGAINST ITSELF. Two applies of the same confirmation at once —
    //       two windows, one click each. The store must end with ONE row per natural key. On
    //       this tier the serialization is P.2's own pg_advisory_xact_lock transaction (PGlite
    //       supports it) PLUS the PGlite driver's exclusive-transaction mutex, which runs the
    //       two merge transactions strictly one after the other.
    const [first, second] = await Promise.all([
      call(b, "POST", `/mailboxes/${mailboxId}/profile-import`, { fingerprint }),
      call(b, "POST", `/mailboxes/${mailboxId}/profile-import`, { fingerprint }),
    ]);
    for (const r of [first, second]) {
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({
        imported: { screener: 1, rules: 1, notifyRules: 1, tags: 1, awayResponder: true },
        skippedRules: 0,
      });
    }

    // ── 3. THE LOCAL STORE, BY NATURAL KEY — and exactly one row per key, which is what the
    //       serialization exists to guarantee (two interleaved merges would each see the
    //       pre-state and each insert).
    const bId = b.world.accountId;
    const gotContacts = await b.db.select().from(contacts).where(eq(contacts.accountId, bId));
    expect(gotContacts).toHaveLength(1);
    expect(gotContacts[0]).toMatchObject({ address: "anna@x.example", name: "Anna" });

    const gotRules = await b.db.select().from(rules).where(eq(rules.accountId, bId));
    expect(gotRules).toHaveLength(1);
    expect(gotRules[0]).toMatchObject({
      kind: "sender", match: "anna@x.example", destination: "INBOX",
      provenance: "promoted", enabled: true,
    });
    // Deliberately NOT a retroactive re-filing: an import restores configuration.
    expect(gotRules[0]!.retroRequestedAt).toBeNull();

    const gotTags = await b.db.select().from(tags).where(eq(tags.accountId, bId));
    expect(gotTags.map((t) => t.name)).toEqual(["Invoices"]);

    const gotNotify = await b.db.select().from(notifyRules).where(eq(notifyRules.accountId, bId));
    expect(gotNotify).toHaveLength(1);
    expect(gotNotify[0]).toMatchObject({ kind: "sender", target: "boss@x.example" });

    const gotAway = await b.db.select().from(awayResponders).where(eq(awayResponders.accountId, bId));
    expect(gotAway).toHaveLength(1);
    /* `subject` ARRIVES NULL, AND THAT IS THE ASSERTION. The away responder became reply-only in
     * 0087: `organizer-profile.ts#canonicalize` stopped writing the field and `parseProfile`
     * stopped reading it (*"a document from an older ohmail carries a subject that has nowhere to
     * go"*), so nothing about a subject travels between installs any more. This line still
     * demanded `"Away"` because the file needed a mail server to say otherwise. Pinned to `null`
     * rather than dropped, so a re-added subject fails here instead of travelling silently. */
    expect(gotAway[0]).toMatchObject({ enabled: false, subject: null, body: "Back Monday." });

    // ── 4. ANSWERED IS ANSWERED. The same content never asks again — the resting answer is
    //       one indexed read of the resolution, no dial.
    const after = await call(b, "GET", `/mailboxes/${mailboxId}/profile-import`);
    expect(after.status).toBe(200);
    expect(after.json).toEqual({ state: "none" });

    // ── 5. A STALE RECEIPT IS REFUSED. The fingerprint is consent to exact content; content
    //       nobody was shown must never be applied.
    const stale = await call(b, "POST", `/mailboxes/${mailboxId}/profile-import`, {
      fingerprint: "0".repeat(64),
    });
    expect(stale.status).toBe(409);
  }, 180_000);

  it("while the question is unanswered, a sender the document does not know is filed to the Screener and the named sender's letter stays", async () => {
    const { b, cfg } = await travelledMailbox();
    const mailboxId = b.world.mailboxId;
    expect((await call(b, "GET", `/mailboxes/${mailboxId}/profile-import`)).json.state, "the question is open").toBe("found");

    // Two letters on one pass: from the sender the document screened in, and from nobody it knows.
    await deliver(cfg, "anna@x.example", "held-routing named");
    await deliver(cfg, "stranger@elsewhere.example", "held-routing stranger");
    await b.syncUntilQuiet();
    await b.syncUntilQuiet();

    expect(await serverFoldersHolding(cfg, "held-routing stranger"),
      "a stranger to the document stayed past the gate on the server").toEqual(["ohmail.Screener"]);
    expect(await serverFoldersHolding(cfg, "held-routing named"),
      "the named sender's letter must keep the folder the server put it in").toEqual(["INBOX"]);

    const setBy = async (from: string): Promise<string | undefined> => {
      const [m] = await b.db.select().from(messages)
        .where(and(eq(messages.mailboxId, mailboxId), eq(messages.fromAddress, from)));
      if (!m) return undefined;
      const [fs] = await b.db.select().from(folderState).where(eq(folderState.messageId, m.id));
      return fs?.lastSetBy;
    };
    expect(await setBy("stranger@elsewhere.example")).toBe("us");
    expect(await setBy("anna@x.example")).toBe("external");
    // Still unanswered: routing a stranger did not answer the import question.
    expect((await call(b, "GET", `/mailboxes/${mailboxId}/profile-import`)).json.state).toBe("found");
  }, 180_000);

  it("a sender the document screens out: at the gate while the card is open, in Screened out on the server and in the app after Import", async () => {
    const { b, cfg } = await travelledMailbox({ screenedOut: "spammer@x.example" });
    const mailboxId = b.world.mailboxId;
    await deliver(cfg, "spammer@x.example", "held-routing denied");
    await b.syncUntilQuiet();
    await b.syncUntilQuiet();
    expect(await serverFoldersHolding(cfg, "held-routing denied"), "not at the gate while the question is open")
      .toEqual(["ohmail.Screener"]);

    const candidate = await call(b, "GET", `/mailboxes/${mailboxId}/profile-import`);
    expect((await call(b, "POST", `/mailboxes/${mailboxId}/profile-import`, { fingerprint: candidate.json.fingerprint })).status).toBe(200);
    await b.syncUntilQuiet();
    await b.syncUntilQuiet();

    // The mailbox and the app say one thing. Measured before the fix: the server kept the letter
    // at the gate while the app listed the sender under Screened out.
    const onServer = await serverFoldersHolding(cfg, "held-routing denied", ["INBOX", "ohmail.Screener", "ohmail.Screened"]);
    expect(onServer, "the app says Screened out and the mailbox disagrees").toEqual(["ohmail.Screened"]);
    const ui = new OhmailEngine({
      adapter: new HttpAdapter({
        baseUrl: "http://sidecar",
        fetch: (input: RequestInfo | URL, init?: RequestInit) => b.handle(new Request(input, init)),
        headers: () => ({ authorization: `Bearer ${b.sessionToken}` }),
      }),
      store: new MemoryMirrorStore(),
    });
    await ui.start();
    const reader = ui.read();
    const m = reader.list<EngineMessage>("message").find((x) => x.subject === "held-routing denied");
    // The mail was delivered moments ago by a live server, so the instant of the read is its clock.
    const at = new Date();
    const part = consentPartition(reader, { now: at });
    expect(m ? part.placeOf.get(m.id) : undefined).toBe("ohmail/Screened");
    const segs = screenerSegments(presentationReader(reader, part), at);
    expect(segs.screenedOut.some((r) => r.from.address === "spammer@x.example")).toBe(true);
    expect(segs.waiting.some((r) => r.from.address === "spammer@x.example")).toBe(false);
  }, 240_000);

  it("a document found IN SYNC is this install's own: after a local decision a stranger is still filed to the gate", async () => {
    // Measured on 0.25.1: a fresh install met another install's document equal to its own empty
    // settings, no card was shown, and after its first decision arrivals stayed in INBOX until its
    // own write. A real flush interval keeps the folder verdict cached across the seed.
    const cfg = greenmail();
    const c = new ImapFlow({ ...cfg, logger: false });
    await c.connect();
    try {
      await c.mailboxCreate(META_PATH).catch(() => undefined);
      const empty = makeProfileDoc(
        { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null },
        { updatedAt: new Date(Date.now() - 60 * 60 * 1000), producer: { kind: "local", version: "0.25.1" } },
      );
      await c.append(META_PATH, Buffer.from(formatProfileMessage(empty, { installId: "another-install" }), "utf8"));
    } finally {
      await c.logout();
    }
    const b = await createSidecar({
      dataDir: dataDir("ohmail-pfi-sync-"), imap: cfg, machineName: "this Mac",
      pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000, profileFlushIntervalMs: 600_000,
    });
    await grantOrganizeConsent(b);
    running.push(b);
    await b.start();
    await b.syncUntilQuiet();
    expect((await call(b, "GET", `/mailboxes/${b.world.mailboxId}/profile-import`)).json.state, "no card for our own settings").toBe("none");

    await b.db.insert(tags).values({ accountId: b.world.accountId, name: "mine", hue: "moss" });
    await deliver(cfg, "stranger@elsewhere.example", "in-sync stranger");
    await b.syncUntilQuiet();
    await b.syncUntilQuiet();
    expect(await serverFoldersHolding(cfg, "in-sync stranger"), "an in-sync document held a stranger past the gate")
      .toEqual(["ohmail.Screener"]);
  }, 180_000);

  it("decline is durable on this machine and keeps the mailbox's document; replace is what lets this engine write", async () => {
    const { b, cfg, bDir, kek } = await travelledMailbox();
    const mailboxId = b.world.mailboxId;

    const candidate = await call(b, "GET", `/mailboxes/${mailboxId}/profile-import`);
    expect(candidate.status).toBe(200);
    expect(candidate.json.state).toBe("found");
    const fingerprint = candidate.json.fingerprint as string;

    const declined = await call(b, "POST", `/mailboxes/${mailboxId}/profile-import/decline`, { fingerprint });
    expect(declined.status).toBe(200);
    expect(declined.json).toEqual({ dismissed: true });

    // Nothing was applied — "keep what I have" keeps it.
    expect(await b.db.select().from(rules).where(eq(rules.accountId, b.world.accountId))).toHaveLength(0);
    expect(await b.db.select().from(tags).where(eq(tags.accountId, b.world.accountId))).toHaveLength(0);

    // The card rests; Settings answers `declined`, from the marker alone.
    const after = await call(b, "GET", `/mailboxes/${mailboxId}/profile-import`);
    expect(after.json).toMatchObject({
      state: "declined", fingerprint,
      counts: { screener: 1, rules: 1, notifyRules: 1, tags: 1, awayResponder: true },
    });

    // ── THE MAILBOX KEEPS ITS SETTINGS. B now has something of its own to say, and drains: the
    //    document the other install left stays exactly as it was, and B's own is
    //    written beside it rather than over it.
    const before = await profileDocsOn(cfg);
    expect(before).toHaveLength(1);
    const travelled = before[0]!.installId;
    await b.db.insert(tags).values({ accountId: b.world.accountId, name: "mine", hue: "moss" });
    await b.syncUntilQuiet();
    await b.syncUntilQuiet();
    const beside = await profileDocsOn(cfg);
    expect(beside.filter((d) => d.installId === travelled), "a decline let this engine overwrite the mailbox's settings")
      .toEqual(before);
    expect(beside.filter((d) => d.installId !== travelled).map((d) => d.tagNames), "B's own settings, beside")
      .toEqual([["mine"]]);
    // …and the question is still the one it declined: the server lists the older document by
    // header only, and a question read that missed it lapsed the card.
    expect((await call(b, "GET", `/mailboxes/${mailboxId}/profile-import`)).json.state, "the declined question lapsed")
      .toBe("declined");

    // ── REPLACE, and only then does this engine's own document supersede it.
    const replaced = await call(b, "POST", `/mailboxes/${mailboxId}/profile-import/replace`, { fingerprint });
    expect(replaced.status).toBe(200);
    expect(replaced.json).toEqual({ replaced: true });
    await b.syncUntilQuiet();
    await b.syncUntilQuiet();
    const now = await profileDocsOn(cfg);
    expect(now).toHaveLength(1);
    expect(now[0]!.installId).not.toBe(travelled);
    expect(now[0]!.tagNames).toEqual(["mine"]);

    // ── RELAUNCH, same data directory: the dismissal is a row in the local store, not process
    //    memory, so the identical document stays answered. (`handle` serves before `start()` —
    //    the resting candidate path reads the marker and the resolution, and dials nothing.)
    await b.stop();
    const b2 = await createSidecar({
      dataDir: bDir, imap: cfg, machineName: "this Mac",
      pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000, profileFlushIntervalMs: 0,
      keks: { 1: kek },
    });
    await grantOrganizeConsent(b2);
    running.push(b2);
    const relaunched = await call(b2, "GET", `/mailboxes/${b2.world.mailboxId}/profile-import`);
    expect(relaunched.status).toBe(200);
    expect(relaunched.json, "replaced is answered for good, across a relaunch").toEqual({ state: "none" });
  }, 180_000);
});
