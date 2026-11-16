import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";
import { eq } from "drizzle-orm";
import { mailboxes, messages, type Tx } from "@trafficflow/db";
import { makeTestDb, serviceUp } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { NO_TRUSTED_AUTHSERV_IDS, UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { runSyncCycle, reconcileMailbox } from "../src/sync.js";
import { FIXTURE_DOOR, FIXTURE_LEASE } from "./_door.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  TWO WORLDS: A READER'S MIRROR GROWS WHILE THE SERVER IS UNTOUCHED
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Mail 0083, the "Organize-in-place" invariant — the only reader IMAP write is `setFlags`.
 *
 * ── WHY THIS CANNOT BE DONE WITH A FAKE ADAPTER ─────────────────────────────────────────────
 *
 * `reader-mode.e2e.test.ts` beside this proves the DECISIONS: no classify, no debit, no routing
 * row, `last_set_by: 'external'`. What it cannot prove is what reached the SERVER, because the
 * fake adapter's `move` returns the locator it was handed and its `ensureFolders` is a no-op —
 * a build that called both would look identical there.
 *
 * The claim a person actually cares about is about their own mail server: after a reader has
 * cycled over their unruled INBOX, `ohmail/*` DOES NOT EXIST on it and every message is still in
 * INBOX. That is observed here through a SECOND, INDEPENDENT client — the same discipline
 * `organizer-peek.imap.test.ts` uses, and for its reason: asserting "the adapter returned the
 * right thing" cannot catch a write the adapter also performed.
 *
 * ── THE NEGATIVE CONTROL IS THE POINT OF THE FILE ───────────────────────────────────────────
 *
 * "Nothing changed" against a mailbox nothing could have changed proves nothing. The same seed
 * run as an ORGANIZER creates the tree and moves the mail, observed the same way. Without it a
 * green above would be satisfied by a cycle that did nothing at all.
 *
 * ── SKIPPED, LOUDLY, WITH NO SERVER ─────────────────────────────────────────────────────────
 *
 * The suite is gated on the port answering rather than left to fail with ECONNREFUSED, because a
 * connection refusal is indistinguishable from a product defect in a CI summary. `docker compose
 * up greenmail` is what makes it run.
 *
 * ── AND WHAT THIS FILE DOES *NOT* PROVE, WHICH IS WORTH SAYING (0.14.1) ──────────────────────
 *
 * The cases below drive `runSyncCycle` DIRECTLY. They therefore say nothing about the GATE — about
 * whether a reader is allowed to reach `runLeaseGate` at all — and the empty-folder hazard is
 * entirely a gate question: `decideLease`'s arm 4 answers `organize` on a folder holding no
 * readable claim, and the gate APPENDS on that answer. A reader whose organizer released cleanly
 * is looking at exactly that folder.
 *
 * That property is pinned on the real code path of both doors instead, over MANY cycles each:
 * `apps/worker/test/organizer-lease-worker.test.ts` ("a CONSENTED READER over an EMPTY folder
 * never claims") boots `startWorker` against a fake fleet whose `_meta` is a real in-memory
 * `LeaseIo`, and `apps/sidecar/test/reader-no-auto-resume.test.ts` ("N CYCLES over an empty
 * folder") does the same on the standalone engine. Both assert the claim count AND the folder
 * tree, because a gate that returned `false` while something downstream still called
 * `ensureFolders` would leave six folders in a stranger's mailbox with no claim to explain them.
 *
 * What THIS file adds that neither of those can is the SERVER's own answer, observed through an
 * independent client — which is why the reader case below names `ohmail/_meta` explicitly rather
 * than leaving it to the `^ohmail` filter it happens to satisfy.
 */

const HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.IMAP_PORT ?? 3143);

/* The run's one probe (test/setup/services.global.ts), at the address this file dials. */
const GM_UP = serviceUp("greenmail", `${HOST}:${PORT}`).up;

const USER = (): string => `rw-${randomUUID()}@trafficflow.test`;

/** Deliver N messages into a fresh GreenMail user's INBOX, by APPEND from an independent client. */
async function seedInbox(user: string, n: number): Promise<void> {
  const c = new ImapFlow({ host: HOST, port: PORT, secure: false, auth: { user, pass: "test" }, logger: false });
  await c.connect();
  try {
    for (let i = 0; i < n; i++) {
      const raw = [
        `Message-ID: <tw-${i}-${randomUUID()}@stranger.test>`,
        `From: stranger${i}@example.com`,
        `To: ${user}`,
        `Subject: two worlds ${i}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        "hello",
      ].join("\r\n");
      await c.append("INBOX", raw);
    }
  } finally {
    await c.logout().catch(() => { /* the socket is going anyway */ });
  }
}

/** What an INDEPENDENT client sees: the folder list, and how many messages INBOX holds. */
async function observe(user: string): Promise<{ folders: string[]; inbox: number }> {
  const c = new ImapFlow({ host: HOST, port: PORT, secure: false, auth: { user, pass: "test" }, logger: false });
  await c.connect();
  try {
    const list = await c.list();
    const box = await c.mailboxOpen("INBOX");
    return { folders: list.map((f) => f.path).sort(), inbox: box.exists };
  } finally {
    await c.logout().catch(() => { /* ignore */ });
  }
}

async function cycles(
  user: string, role: "organizer" | "reader", n: number,
): Promise<{ mirrored: number }> {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = "00000000-0000-4000-8000-0000000tw000".replace("tw", "11");
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: user, organizerRole: role })
    .returning();
  const adapter = new ImapAdapter(
    { host: HOST, port: PORT, secure: false, auth: { user, pass: "test" }, sentDomain: "trafficflow.test" },
    { accountId, mailboxId: mb!.id },
  );
  await adapter.connect();
  try {
    // THE ORGANIZER'S OWN ATTACH ENSURES THE TREE; a reader's does not, and that asymmetry is
    // reproduced here rather than assumed, because it is half of what is under test.
    if (role === "organizer") await adapter.ensureFolders(FIXTURE_DOOR);
    const deps = {
      repo: makeDrizzleRepo(db), adapter, accountId, mailboxId: mb!.id,
      role,
      trustedAuthservIds: NO_TRUSTED_AUTHSERV_IDS,
      storageCap: UNMETERED_STORAGE_CAP,
      // A READER names itself; an organizer fixture here holds no real permit. See
      // `reader-mode.e2e.test.ts` for the same two lines and why the field is not omitted.
      writeAuthority: role === "reader" ? { noLease: "reader" as const } : FIXTURE_LEASE,
    } as const;
    for (let i = 0; i < n; i++) {
      await runSyncCycle(deps);
      await reconcileMailbox(deps);
    }
  } finally {
    await adapter.close().catch(() => { /* ignore */ });
  }
  const rows = await db.select().from(messages).where(eq(messages.mailboxId, mb!.id));
  return { mirrored: rows.length };
}

describe.skipIf(!GM_UP)("two worlds — a reader mirrors a mailbox it never touches", () => {
  it("READER: the mirror GROWS, `ohmail/*` never appears, and every message stays in INBOX", async () => {
    const user = USER();
    await seedInbox(user, 4);
    const before = await observe(user);
    expect(before.inbox).toBe(4);

    const { mirrored } = await cycles(user, "reader", 3);

    // THE MIRROR IS THE PRODUCT. Asserted first: every other assertion here is about an absence,
    // and an absence beside an empty mirror is a cycle that did nothing.
    expect(mirrored, "a reader's mirror must GROW — that is the whole reason it keeps syncing").toBe(4);

    const after = await observe(user);
    // NOT `toEqual(before.folders)`: the claim is specifically that OHMAIL created nothing, and a
    // folder list that happened to match for another reason would satisfy the weaker form.
    expect(
      after.folders.filter((f) => /^ohmail/i.test(f)),
      "a reader created ohmail folders on somebody else's mailbox",
    ).toEqual([]);
    /* `ohmail/_meta` BY NAME, and not left to the filter above that already covers it.
     *
     * The two absences mean different things and only one of them is about mail. The tree is
     * "this install did not organize"; `_meta` is "this install did not CLAIM" — and the claim is
     * the thing another machine reads and stands itself down behind. `makeLeasePeekIo` cannot
     * create the folder (an absent folder is reported as zero claims, which is the truth);
     * `runLeaseGate` creates it before it appends. So the folder's absence is the server's own
     * answer to "was the write gate entered", which no assertion about our own row can give. */
    expect(
      after.folders.filter((f) => /_meta$/i.test(f)),
      "a reader created the lease folder — the write gate was entered on a mailbox it only reads",
    ).toEqual([]);
    expect(after.inbox, "a reader moved mail out of INBOX").toBe(4);
  }, 60_000);

  it("NEGATIVE CONTROL — the same seed as an ORGANIZER creates the tree and files the mail", async () => {
    const user = USER();
    await seedInbox(user, 4);
    const { mirrored } = await cycles(user, "organizer", 3);
    expect(mirrored).toBe(4);

    const after = await observe(user);
    expect(
      after.folders.filter((f) => /^ohmail/i.test(f)).length,
      "the organizer arm created no folders — the reader assertion above is then vacuous",
    ).toBeGreaterThan(0);
    // The unruled strangers are held at the gate, so INBOX empties. If this ever stops moving,
    // the reader test above has stopped meaning anything.
    expect(after.inbox, "the organizer arm moved nothing — the reader assertion is vacuous")
      .toBeLessThan(4);
  }, 60_000);
});
