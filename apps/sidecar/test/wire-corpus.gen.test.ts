import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { messages } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { connectOverStdio, type StdioClient } from "../src/client.js";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { serveOverStdio, type StdioHost } from "../src/host.js";
import { canonical, settleBookkeeping, substitute, substitutionsFor, type Substitutions } from "./_wire-substitutions.js";

/**
 * THE WIRE CORPUS — the exact bytes the desktop app reads off the local engine, RECORDED FROM A
 * LIVE ENGINE rather than written by hand.
 *
 * The app speaks the same REST routes `HttpAdapter` speaks, over a stdio bridge instead of a
 * socket. A corpus of those bytes is worth having and a HAND-WRITTEN one is worth nothing: it
 * would be two documents agreeing with each other and not with the thing they describe — the same
 * failure a shared contract has.
 *
 * So this test stands up the whole thing — GreenMail over a real socket, on-disk PGlite, the
 * worker's own sync loop, `createApp(apiRoutes)` behind the frame codec — walks one journey, and
 * records what came back.
 *
 * ── WHERE THE CORPUS LIVES, AND WHY IT MOVED ─────────────────────────────────────────────────
 *
 * It used to be written into the macOS client's Swift test fixtures, because that client's decoder
 * was tested against it. That client is retired and the corpus came with the guard rather than
 * going with the client: what it proves is a fact about THE ENGINE — that a documented response
 * shape is still the shape served — and that fact outlived the one decoder that read it. It now
 * sits beside this test, in the suite that produces it.
 *
 * ── IT IS ALSO THE DRIFT GUARD, WHICH IS THE HALF THAT EARNS ITS KEEP ─────────────────────────
 *
 * Recording alone would leave a corpus that silently ages: the engine changes a field, the fixture
 * does not, and a decoder stays green against a shape nothing serves any more. So the committed
 * corpus is COMPARED against what the engine emits now, and a difference fails this test. Writing
 * is behind {@link WRITE_ENV} — a deliberate act, reviewable as a diff.
 *
 * ── WHY THE BYTES ARE NORMALIZED, AND WHERE THE LINE IS ──────────────────────────────────────
 *
 * Account ids, message ids, timestamps, sequence numbers and the per-launch bearer are different on
 * every run, so a raw byte comparison would fail every time and the guard would be turned off
 * within a day. {@link normalize} canonicalises exactly those, BY KEY-PATH ALLOWLIST — never by a
 * global regex over the document. That distinction is the whole design: a global scrub would
 * silently absorb a NEW random field the day the engine grows one, whereas an allowlist lets it
 * land raw in the corpus and fail the next run, which is precisely the drift this exists to catch.
 *
 * Placeholders are valid-typed and identity-preserving — the same raw uuid becomes the same
 * placeholder everywhere, so cross-references between records are still COMPARED rather than
 * erased, and `PATCH /messages` still requires ids its own validator accepts. Dates and seqs are
 * renumbered in sort order, because their ORDER is semantic and the client sorts by it.
 *
 * Everything else is compared exactly: key names, nesting, folder strings, flags, `null` versus
 * absent, and the seeded content this test itself put on the wire.
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);

/** Set to `1` to rewrite the corpus. Never set in CI: the diff is the review. */
const WRITE_ENV = "OHMAIL_WIRE_CORPUS_WRITE";

/** `apps/sidecar/test/fixtures/wire` — assembled from components, never a literal. */
const CORPUS_REL = "apps/sidecar/test/fixtures/wire";
const CORPUS_DIR = ["fixtures", "wire"].reduce(
  (p, part) => join(p, part),
  dirname(fileURLToPath(import.meta.url)),
);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function greenmail(): { host: string; port: number; secure: false; auth: { user: string; pass: string } } {
  return {
    host: IMAP_HOST, port: IMAP_PORT, secure: false,
    auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: "test" },
  };
}

function eml(o: { from: string; to: string; subject: string; messageId: string; date: string; body: string }): string {
  return [
    `Message-ID: <${o.messageId}>`,
    `From: ${o.from}`,
    `To: ${o.to}`,
    `Subject: ${o.subject}`,
    // A real `Date`, because the client sorts and groups by it and `null` is a different code
    // path — one the corpus would have pinned as the only one if these were left off.
    `Date: ${o.date}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    o.body,
  ].join("\r\n");
}

/** GreenMail exposes the tree with a `.` delimiter, so `ohmail/Screener` is `ohmail.Screener`. */
async function uidsIn(c: ImapFlow, serverPath: string, messageId: string): Promise<number[]> {
  const lock = await c.getMailboxLock(serverPath);
  try {
    const r = await c.search({ header: { "message-id": messageId } }, { uid: true });
    return Array.isArray(r) ? r : [];
  } finally {
    lock.release();
  }
}

/** The flags a SECOND, independent client sees on the message — the only `\Seen` that counts. */
async function flagsIn(c: ImapFlow, serverPath: string, uid: number): Promise<string[]> {
  const lock = await c.getMailboxLock(serverPath);
  try {
    const msg = await c.fetchOne(String(uid), { flags: true }, { uid: true });
    if (!msg || typeof msg === "boolean") return [];
    return [...(msg.flags ?? new Set<string>())];
  } finally {
    lock.release();
  }
}

interface World {
  sidecar: Sidecar;
  host: StdioHost;
  client: StdioClient;
  dataDir: string;
  raw: ImapFlow;
  cfg: ReturnType<typeof greenmail>;
}

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) {
    w.client.close();
    w.host.stop();
    await w.raw.logout().catch(() => undefined);
    await w.sidecar.stop().catch(() => undefined);
    rmSync(w.dataDir, { recursive: true, force: true });
  }
});

/** The same assembly `sidecar.e2e.test.ts` stands up: nothing mocked below the transport. */
async function standUp(): Promise<World> {
  const cfg = greenmail();
  const dataDir = await freshDataDir("ohmail-wire-corpus-");
  const sidecar = await createSidecar({
    dataDir,
    imap: cfg,
    address: cfg.auth.user,
    displayName: "This Mac",
    // Long enough that the poll never fires during the test: every cycle here is one this test
    // asked for, so a passing assertion is never a coincidence of timing.
    pollIntervalMs: 60 * 60 * 1000,
  });
  await grantOrganizeConsent(sidecar);

  const toHost = new PassThrough({ highWaterMark: 1024 });
  const toClient = new PassThrough({ highWaterMark: 1024 });
  const host = serveOverStdio({ handle: (req) => sidecar.handle(req), input: toHost, output: toClient });
  const client = connectOverStdio({ input: toClient, output: toHost, baseUrl: "http://sidecar" });
  await host.ready({
    baseUrl: "http://sidecar",
    sessionToken: sidecar.sessionToken,
    accountId: sidecar.world.accountId,
    userId: sidecar.world.userId,
    mailboxId: sidecar.world.mailboxId,
    credentialState: await sidecar.credentialState(),
  });

  const raw = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await raw.connect();

  const w: World = { sidecar, host, client, dataDir, raw, cfg };
  worlds.push(w);
  return w;
}

// ── normalization ────────────────────────────────────────────────────────────

/**
 * Field names whose VALUES are minted per run. Matched by name at any depth, because the DTOs use
 * these names consistently — and enumerated rather than pattern-matched, so a new random field is
 * a failing diff instead of an invisible absorption.
 */
const ID_KEYS = new Set([
  "id", "accountId", "mailboxId", "userId", "threadId", "messageId", "entityId",
  "matchedRuleId", "routingDecisionId", "ruleId", "draftId", "attachmentId", "tagId",
]);
const DATE_KEYS = new Set([
  "date", "updatedAt", "createdAt", "setAt", "bubbleUpAt", "serverTime", "receivedAt",
  "lastHitAt", "screenedOn", "sentAt", "deletedAt", "lastMessageAt", "lastSyncAt", "failedAt",
  "syncBlockedSince", "standDownAt",
  // `lastReadAt` arrived with the ordering of Earlier by when mail was read. It is minted per run
  // like every other stamp here, so until it was listed the recorded corpus disagreed with the
  // engine on every run — which is this allowlist working as its own comment describes: a new
  // date field is a failing diff a person resolves, not something quietly absorbed.
  "lastReadAt",
  // `initialImportCompletedAt` arrived when the standalone engine started writing the two stamps
  // the client's sync line reads — before that nothing on this tier ever wrote it and it was
  // always null. Minted per run like every stamp above it, so listing it is what keeps the corpus
  // comparable; leaving it out made this file disagree with the engine on every run.
  "initialImportCompletedAt",
  // `organizeConsentedAt` is the newest arrival and it is minted per run like every stamp above
  // it: a standalone install is a consent-less READER until somebody agrees, so a
  // corpus recorded by an install that organizes carries the instant of that agreement. Listing
  // it is what keeps the recording comparable; without it the file disagreed with the engine on
  // every run, by a wall-clock millisecond.
  "organizeConsentedAt",
  // `sortAt` arrived with the Ohbox sorting by arrival rather than by the date a sender wrote.
  // Minted per run, so listing it is what the comment above prescribes — a re-record that did not
  // list it wrote a wall-clock value into the corpus and the very next comparison failed on it.
  // It resolves to `arrivedAt`, the IMAP INTERNALDATE, which GreenMail keeps to the second: three
  // appends left to the server's clock usually shared a second and, 1 run in 6, straddled one,
  // which split the field's slots (10:00 read 10:01 in four rows). The journey now names each
  // append's INTERNALDATE, so the field's order and its slots are fixed.
  "sortAt",
  // `asOf` arrived with the filing strip's split counts: every `GET /mailboxes` row carries THE
  // READ'S OWN INSTANT (`mailbox-service.ts`), unconditionally, so a client can say when it last
  // looked instead of running a clock over a figure it has not re-fetched. Minted per run like
  // every stamp above it — and it is the one that proved this allowlist's own argument: a
  // re-record that did not list it wrote a wall-clock value into the corpus, and the very next
  // comparison failed on that value and nothing else.
  "asOf",
  // `arrivedAt` arrived with the cutline reading mail by when it LANDED rather than by the Date
  // header it may not carry: every message row now states its own arrival instant, minted per run
  // like every stamp above it. Listing it is what keeps the recording comparable — a re-record
  // without it wrote four wall-clock values into the corpus and the next comparison failed.
  "arrivedAt",
  // `openReadAt` arrived with a message read while open taking the top of Earlier. Null on every
  // row this journey reads; listed so a journey that opens and reads one records a slot, not a clock.
  "openReadAt",
]);
/** Keys whose value is an ARRAY of ids — the same numbering, one level down. */
const ID_ARRAY_KEYS = new Set(["messageIds", "itemIds", "ids"]);
const SEQ_KEYS = new Set(["seq"]);
const CURSOR_KEYS = new Set(["cursor", "nextCursor"]);
/** Free-form strings that embed a per-run value and cannot be renumbered: mapped whole. */
const OPAQUE_KEYS = new Set(["messageIdHeader"]);

/** The one bundle of allowlists the extracted mechanics take — the lists above are the contract. */
const KEYS = {
  idKeys: ID_KEYS, dateKeys: DATE_KEYS, idArrayKeys: ID_ARRAY_KEYS,
  seqKeys: SEQ_KEYS, cursorKeys: CURSOR_KEYS, opaqueKeys: OPAQUE_KEYS,
};

// ── the journey ──────────────────────────────────────────────────────────────

interface Recorded {
  name: string;
  method: string;
  path: string;
  status: number;
  body: Json;
}

describe("the wire corpus the desktop app decodes", () => {
  it(
    "records one live journey — first contact, its body, mark-seen, and mark-seen again — and fails on drift",
    async () => {
      const w = await standUp();
      const bearer = { authorization: `Bearer ${w.sidecar.sessionToken}` };
      const recorded: Recorded[] = [];

      const record = async (name: string, method: string, path: string, init: RequestInit = {}): Promise<Json> => {
        const res = await w.client.fetch(path, { method, ...init });
        const text = await res.text();
        const body = settleBookkeeping((text === "" ? null : JSON.parse(text)) as Json);
        recorded.push({ name, method, path, status: res.status, body });
        return body;
      };

      // ── 1. Strangers write, appended by an INDEPENDENT client — nothing about how the messages
      //       got onto the server involves the code under test.
      //
      // THREE messages from TWO senders, on purpose. The client groups the Screener by sender and
      // orders rows newest-first with each sender's held mail oldest-first; a corpus with one
      // message in it cannot tell a correct implementation of that from any other.
      const ids = {
        firstContact: `first-contact-${randomUUID()}@stranger.test`,
        followUp: `follow-up-${randomUUID()}@stranger.test`,
        otherSender: `kiln-${randomUUID()}@pottery.test`,
      };
      // Each append names its INTERNALDATE, a minute apart in the Date headers' order, from one
      // clock read floored to the second (the server's precision): arrival order is not timing.
      const base = Math.floor(Date.now() / 1000) * 1000;
      const arrival = (minutesAgo: number): Date => new Date(base - minutesAgo * 60_000);
      await w.raw.append("INBOX", eml({
        from: "stranger@nowhere.test", to: w.cfg.auth.user, subject: "Can we talk?",
        messageId: ids.firstContact, date: "Mon, 03 Aug 2026 08:14:00 +0000",
        body: "Hello — we have not met before. I am writing about the pottery studio.",
      }), [], arrival(3));
      await w.raw.append("INBOX", eml({
        from: "stranger@nowhere.test", to: w.cfg.auth.user, subject: "Following up",
        messageId: ids.followUp, date: "Mon, 03 Aug 2026 09:41:00 +0000",
        body: "Following up on the studio question — no rush.",
      }), [], arrival(2));
      await w.raw.append("INBOX", eml({
        from: "studio@pottery.test", to: w.cfg.auth.user, subject: "Kiln schedule for August",
        messageId: ids.otherSender, date: "Mon, 03 Aug 2026 10:02:00 +0000",
        body: "The kiln is booked Tuesdays and Thursdays through the end of the month.",
      }), [], arrival(1));

      // ── 2. The engine starts: connect, ensure the ohmail/* tree, drain the mailbox.
      await w.sidecar.start();

      // ── 3. THE SERVER IS THE PROOF. The messages have physically MOVED on the user's own
      //       mailbox, out of INBOX and into a real folder any other mail client can see.
      const screenerUIDs = await uidsIn(w.raw, "ohmail.Screener", ids.firstContact);
      expect(screenerUIDs, "first contact is not in ohmail/Screener on the server").toHaveLength(1);
      expect(await uidsIn(w.raw, "INBOX", ids.firstContact), "first contact is still in INBOX").toHaveLength(0);
      const followUpUIDs = await uidsIn(w.raw, "ohmail.Screener", ids.followUp);
      expect(followUpUIDs, "the follow-up is not in ohmail/Screener on the server").toHaveLength(1);
      expect(await uidsIn(w.raw, "ohmail.Screener", ids.otherSender),
        "the second sender's mail is not in ohmail/Screener on the server").toHaveLength(1);

      const [row] = await w.sidecar.db.select().from(messages)
        .where(eq(messages.messageIdHeader, ids.firstContact));
      expect(row, "first contact was never ingested").toBeDefined();
      expect(row!.arrivedAt?.getTime(), "arrival is not the INTERNALDATE the append named")
        .toBe(arrival(3).getTime());

      // ── 4. The routes the app speaks, in the order it speaks them.
      //
      // No bearer FIRST, because the shape of a refusal is part of the contract: the same
      // `withSession` that guards Cloud guards the local engine, and a client that cannot read a
      // 401 envelope reports "no mail" for "not signed in".
      await record("unauthorized", "GET", "/sync?since=0");

      // Identity, read once at start rather than every cycle: which address this app is signed in
      // as, and what to call the mailbox. It is not mail truth, so it does not belong in the
      // per-cycle read — and the alternative, letting the shell tell the source who it is, would
      // put the account's own name somewhere other than the account.
      await record("mailboxes", "GET", "/mailboxes", { headers: bearer });

      await record("sync-first-contact", "GET", "/sync?since=0", { headers: bearer });
      await record("message-body", "GET", `/messages/${row!.id}/body`, { headers: bearer });

      await record("mark-seen", "PATCH", "/messages", {
        headers: { ...bearer, "content-type": "application/json" },
        body: JSON.stringify({ ids: [row!.id], unread: false }),
      });

      // The SAME write again. `PATCH /messages` sets an end state rather than toggling one, so the
      // second call answers about a message that is already seen — which is how the client learns
      // that nothing moved, and the reason it must not announce that anything did.
      await record("mark-seen-again", "PATCH", "/messages", {
        headers: { ...bearer, "content-type": "application/json" },
        body: JSON.stringify({ ids: [row!.id], unread: false }),
      });

      await record("sync-after-mark-seen", "GET", "/sync?since=0", { headers: bearer });

      // ── 5. `\Seen` ON THE SERVER. The API writes desired state only; the worker's cycle is what
      //       puts the flag on the real mailbox, so the journey is not finished until a cycle runs.
      //
      // Asserted with the SECOND, independent IMAP client, and asserted on BOTH messages: the one
      // the batch named carries the flag, and the one it did not still does not. Checking only the
      // first would pass for an implementation that flagged the whole folder.
      await w.sidecar.syncUntilQuiet();
      const flags = await flagsIn(w.raw, "ohmail.Screener", screenerUIDs[0]!);
      expect(flags, `the second IMAP client does not see \\Seen on the server: ${flags.join(", ")}`)
        .toContain("\\Seen");
      const untouched = await flagsIn(w.raw, "ohmail.Screener", followUpUIDs[0]!);
      expect(untouched, "a message the batch never named came back \\Seen").not.toContain("\\Seen");

      // ── 6. Normalize, and refuse to write a corpus with a live credential in it.
      const owner = w.cfg.auth.user;
      const subs = substitutionsFor(recorded.map((r) => r.body), owner, KEYS);
      const files = new Map<string, string>();
      files.set(
        "manifest.json",
        canonical(recorded.map((r) => ({ name: r.name, method: r.method, path: pathFor(r, subs), status: r.status })) as Json),
      );
      for (const r of recorded) files.set(`${r.name}.json`, canonical(substitute(r.body, subs, KEYS)));

      for (const [name, text] of files) {
        expect(text, `${name} carries the per-launch bearer token`).not.toContain(w.sidecar.sessionToken);
        expect(text, `${name} carries the per-run mailbox address`).not.toContain(owner);
        expect(text, `${name} carries the temporary data directory`).not.toContain(w.dataDir);
      }

      // ── 7. Compare, or write.
      if (process.env[WRITE_ENV] === "1") {
        mkdirSync(CORPUS_DIR, { recursive: true });
        for (const stale of readdirSync(CORPUS_DIR, { withFileTypes: true })) {
          if (stale.isFile() && !files.has(stale.name)) rmSync(join(CORPUS_DIR, stale.name));
        }
        for (const [name, text] of files) writeFileSync(join(CORPUS_DIR, name), text);
        return;
      }

      for (const [name, text] of files) {
        let committed: string;
        try {
          committed = readFileSync(join(CORPUS_DIR, name), "utf8");
        } catch {
          throw new Error(
            `${CORPUS_REL}/${name} is missing. The engine emits it now; re-run with `
              + `${WRITE_ENV}=1 and review the diff.`,
          );
        }
        expect(
          text,
          `${CORPUS_REL}/${name} no longer matches what the engine emits. This file is the recorded `
            + `shape of a response the desktop app reads, so a difference here is documentation that `
            + `is green against a shape nothing serves. Re-run with ${WRITE_ENV}=1 and review the diff.`,
        ).toBe(committed);
      }
    },
    180_000,
  );
});

/** The recorded path, with the message id in it normalized the same way its body was. */
function pathFor(r: Recorded, s: Substitutions): string {
  return r.path.replace(UUID_RE_GLOBAL, (m) => s.ids.get(m) ?? m);
}
const UUID_RE_GLOBAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
