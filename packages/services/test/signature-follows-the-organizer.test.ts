import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { mailboxes, mailboxProfileMirror } from "@trafficflow/db";
import { effectiveMailboxSignatures } from "../src/index.js";
import { makeCtx } from "./helpers.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE SIGNATURE FOLLOWS THE ACCOUNT, NOT THE INSTALL
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Compose reads one map — `GET /consent`'s `signatures` — and on a mailbox this install only
 * READS, that map used to be built from `mailboxes.signature`, which is a dead local copy. The
 * live sign-off is in the organizer's published document, already cached in
 * `mailbox_profile_mirror` by the reader's own cycle. Measured on the rig against the 0.18.0 rc3
 * build: a desktop attached by IMAP to a Cloud-organized mailbox served that document over
 * `GET /mailboxes/:id/profile` carrying the signature byte for byte, and answered `GET /consent`
 * with an EMPTY map — so every message it composed went out with no sign-off while the text sat
 * one table away. That is a false state, not a delay: the composer showed no block and the person
 * had no way to tell it from having no signature.
 *
 * The property is one sentence — the organizer's document wins wherever there is one, and the
 * local row wins everywhere else — and every case below is one arm of it.
 */

type World = Awaited<ReturnType<typeof makeCtx>>;

/** Make this install a READER of its mailbox: the Cloud organizes it, we watch. */
async function readsOnly(w: World): Promise<void> {
  await w.db.update(mailboxes).set({
    organizerRole: "reader", organizerState: "held",
    organizedByKind: "cloud", organizedByName: "ohmail Cloud",
  }).where(eq(mailboxes.id, w.mailboxId));
}

/** Cache an organizer's published document against this mailbox, as the reader's cycle does. */
async function mirrorDoc(w: World, doc: Record<string, unknown>): Promise<void> {
  await w.db.insert(mailboxProfileMirror).values({
    mailboxId: w.mailboxId, accountId: w.accountId, doc,
    readAt: new Date("2026-09-13T19:00:00Z"),
  });
}

const DOC = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1, updatedAt: "2026-09-13T19:00:00Z", producer: { kind: "cloud", version: "dev" },
  screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [],
  signature: "-- \nfrom the organizer", ...over,
});

describe("the signature a reader composes with is the organizer's", () => {
  it("a mirrored document beats an inert local row", async () => {
    const w = await makeCtx();
    // The local row: a signature this install stored and nothing applies — the state that made
    // the old behaviour LOOK right on an install that had once organized the mailbox.
    await w.db.update(mailboxes).set({ signature: "-- \nstale local copy" })
      .where(eq(mailboxes.id, w.mailboxId));
    await readsOnly(w);
    await mirrorDoc(w, DOC());

    const { signatures } = await effectiveMailboxSignatures(w.db, w.accountId);
    expect(signatures[w.mailboxId], "the reader composed with its own dead row")
      .toBe("-- \nfrom the organizer");
  });

  it("the markup travels with the text, and only with it", async () => {
    const w = await makeCtx();
    await readsOnly(w);
    await mirrorDoc(w, DOC({ signatureHtml: "<p>-- <br>from the organizer</p>" }));

    const { signatures, signaturesHtml } = await effectiveMailboxSignatures(w.db, w.accountId);
    expect(signatures[w.mailboxId]).toBe("-- \nfrom the organizer");
    expect(signaturesHtml[w.mailboxId]).toBe("<p>-- <br>from the organizer</p>");
  });

  it("a document's markup does NOT carry the local row's markup beside it", async () => {
    const w = await makeCtx();
    // The trap this arm exists for: the document says the sign-off is plain, the local row still
    // holds yesterday's markup. Resolving the two maps independently would send the organizer's
    // words to a plaintext reader and this install's old formatting to everybody else.
    await w.db.update(mailboxes).set({
      signature: "-- \nstale local copy", signatureHtml: "<p>-- <br>stale <b>local</b> copy</p>",
    }).where(eq(mailboxes.id, w.mailboxId));
    await readsOnly(w);
    await mirrorDoc(w, DOC());

    const { signatures, signaturesHtml } = await effectiveMailboxSignatures(w.db, w.accountId);
    expect(signatures[w.mailboxId]).toBe("-- \nfrom the organizer");
    expect(signaturesHtml[w.mailboxId], "the local markup rode out under the organizer's words")
      .toBeUndefined();
  });

  it("a reader with no document yet keeps its own row rather than losing the sign-off", async () => {
    const w = await makeCtx();
    await w.db.update(mailboxes).set({ signature: "-- \nmine" })
      .where(eq(mailboxes.id, w.mailboxId));
    await readsOnly(w);

    const { signatures } = await effectiveMailboxSignatures(w.db, w.accountId);
    expect(signatures[w.mailboxId]).toBe("-- \nmine");
  });

  it("a document that states NO signature is an answer, and it wins", async () => {
    const w = await makeCtx();
    await w.db.update(mailboxes).set({ signature: "-- \nstale local copy" })
      .where(eq(mailboxes.id, w.mailboxId));
    await readsOnly(w);
    await mirrorDoc(w, DOC({ signature: null }));

    const { signatures } = await effectiveMailboxSignatures(w.db, w.accountId);
    /* `?? local` on a document whose `signature` is null would put the dead row back — the state
       measured on the rig, reached from the other side. A published "no sign-off" is a decision
       somebody made and the reader honours it. */
    expect(signatures[w.mailboxId], "a published 'no signature' was overridden by a dead row")
      .toBeUndefined();
  });

  /* ── AND THE ROW SAYS WHOSE IT IS ────────────────────────────────────────────────────────
     The text alone cannot tell a reader's own sign-off from an organizer's: both arrive in the
     same map, in the same shape. `signatureSources` is the fact the editor needs to know whether
     it is a report or a control, and `"organizer"` is POSITIVE — a document exists. */

  it("a reader WITH a document is sourced to the organizer", async () => {
    const w = await makeCtx();
    await w.db.update(mailboxes).set({ signature: "-- \nstale local copy" })
      .where(eq(mailboxes.id, w.mailboxId));
    await readsOnly(w);
    await mirrorDoc(w, DOC());

    const { signatures, signatureSources } = await effectiveMailboxSignatures(w.db, w.accountId);
    expect(signatureSources[w.mailboxId]).toBe("organizer");
    expect(signatures[w.mailboxId]).toBe("-- \nfrom the organizer");
  });

  it("a reader with NO document is sourced LOCAL, and keeps its own text", async () => {
    const w = await makeCtx();
    await w.db.update(mailboxes).set({ signature: "-- \nmine" })
      .where(eq(mailboxes.id, w.mailboxId));
    await readsOnly(w);

    const { signatures, signatureSources } = await effectiveMailboxSignatures(w.db, w.accountId);
    /* The pair that decides the editor: the value is this install's own, so the row must not be
       reported as somebody else's and must keep its Save. */
    expect(signatureSources[w.mailboxId]).toBe("local");
    expect(signatures[w.mailboxId]).toBe("-- \nmine");
  });

  it("an ORGANIZER with a stale document is sourced LOCAL", async () => {
    const w = await makeCtx();
    await w.db.update(mailboxes).set({ signature: "-- \nmine" })
      .where(eq(mailboxes.id, w.mailboxId));
    await mirrorDoc(w, DOC({ signature: "-- \nwhoever held it last" }));

    const { signatureSources } = await effectiveMailboxSignatures(w.db, w.accountId);
    expect(signatureSources[w.mailboxId], "a stale document sourced an organizer's own row away")
      .toBe("local");
  });

  /* A DOCUMENT THAT STATES NO SIGNATURE IS STILL A DOCUMENT: the source is the organizer even
     though no text travels, which is what keeps the editor a report rather than handing the
     reader a control over a value the organizer has deliberately left empty. */
  it("a document with no signature still sources to the organizer", async () => {
    const w = await makeCtx();
    await readsOnly(w);
    await mirrorDoc(w, DOC({ signature: null }));

    const { signatures, signatureSources } = await effectiveMailboxSignatures(w.db, w.accountId);
    expect(signatureSources[w.mailboxId]).toBe("organizer");
    expect(signatures[w.mailboxId]).toBeUndefined();
  });

  /* ── THE ORGANIZER IS UNCHANGED — the half a merge is most likely to break ───────────────── */

  it("a mailbox this install ORGANIZES answers from its own row, mirror or no mirror", async () => {
    const w = await makeCtx();
    await w.db.update(mailboxes).set({
      signature: "-- \nmine", signatureHtml: "<p>-- <br>mine</p>",
    }).where(eq(mailboxes.id, w.mailboxId));
    /* A STALE ROW LEFT FROM BEFORE THIS INSTALL TOOK OVER, which is the case that decides whether
       the merge is keyed on the ROLE or merely on a row existing. `readMailboxProfile` refuses to
       read the mirror for an organizer for this exact reason, and the two must not disagree. */
    await mirrorDoc(w, DOC({ signature: "-- \nwhoever held it last" }));

    const { signatures, signaturesHtml } = await effectiveMailboxSignatures(w.db, w.accountId);
    expect(signatures[w.mailboxId]).toBe("-- \nmine");
    expect(signaturesHtml[w.mailboxId]).toBe("<p>-- <br>mine</p>");
  });

  it("one account, one reader and one organizer, each answering from its own source", async () => {
    const w = await makeCtx();
    await w.db.update(mailboxes).set({ signature: "-- \nmine" })
      .where(eq(mailboxes.id, w.mailboxId));
    const [other] = await w.db.insert(mailboxes).values({
      accountId: w.accountId, provider: "imap", address: "second@trafficflow.test",
      signature: "-- \nstale local copy",
      organizerRole: "reader", organizerState: "held",
      organizedByKind: "cloud", organizedByName: "ohmail Cloud",
    }).returning();
    await w.db.insert(mailboxProfileMirror).values({
      mailboxId: other!.id, accountId: w.accountId,
      doc: DOC({ signature: "-- \nthe other one's organizer" }),
      readAt: new Date("2026-09-13T19:00:00Z"),
    });

    const { signatures } = await effectiveMailboxSignatures(w.db, w.accountId);
    expect(signatures[w.mailboxId]).toBe("-- \nmine");
    expect(signatures[other!.id]).toBe("-- \nthe other one's organizer");
  });

  it("a mirror row belonging to ANOTHER account is not read", async () => {
    const w = await makeCtx();
    await w.db.update(mailboxes).set({ signature: "-- \nmine" })
      .where(eq(mailboxes.id, w.mailboxId));
    await readsOnly(w);
    /* The account column is in the JOIN predicate, not only in the key. Since mail 0118 keyed the
       mirror to `(mailbox_id, account_id)` the disagreeing row cannot be written at all, which is
       the stronger guarantee — asserted first. The predicate is then still driven, against a row
       planted with that ONE key dropped, so removing it from the join reddens here. */
    const stranger = {
      mailboxId: w.mailboxId, accountId: randomUUID(),
      doc: DOC({ signature: "-- \na stranger's sign-off" }),
      readAt: new Date("2026-09-13T19:00:00Z"),
    };
    const verdict = await w.db.insert(mailboxProfileMirror).values(stranger).then(
      () => "admitted",
      (e: unknown) => (/mailbox_profile_mirror_mailbox_id_account_fk/.test(String(e))
        ? "refused-by-the-key" : `refused-otherwise:${String(e)}`),
    );
    expect(verdict, "the disagreeing mirror row is representable again").toBe("refused-by-the-key");
    await w.db.execute(sql`alter table mailbox_profile_mirror
      drop constraint mailbox_profile_mirror_mailbox_id_account_fk`);
    await w.db.insert(mailboxProfileMirror).values(stranger);

    const { signatures } = await effectiveMailboxSignatures(w.db, w.accountId);
    expect(signatures[w.mailboxId], "a stranger's document reached this account's composer")
      .toBe("-- \nmine");
  });

  /* A REMOVED MAILBOX'S SIGNATURE IS INERT. Its tombstone keeps the text so a plain removal stays
     reversible, but nothing serves it: listed, it showed as the live address's sign-off beside
     the reconnected row, and every Save on it was refused. */
  for (const role of ["organizer", "reader"] as const) {
    it(`a removed ${role} row is in none of the maps, beside the live row of the same address`, async () => {
      const w = await makeCtx();
      await w.db.update(mailboxes).set({
        status: "disabled", organizerRole: role,
        signature: "-- \nbefore the removal", signatureHtml: "<p>-- <br>before the removal</p>",
      }).where(eq(mailboxes.id, w.mailboxId));
      await mirrorDoc(w, DOC({ signature: "-- \nthe old document" }));
      const [live] = await w.db.insert(mailboxes).values({
        accountId: w.accountId, provider: "imap", address: "mila@lichtgrat.example",
      }).returning();

      const maps = await effectiveMailboxSignatures(w.db, w.accountId);
      for (const map of [maps.signatures, maps.signaturesHtml, maps.signatureSources]) {
        expect(map[w.mailboxId], "a removed copy's signature was served").toBeUndefined();
      }
      expect(maps.signatureSources[live!.id]).toBe("local");
      expect(maps.signatures[live!.id], "the live row inherited the removed copy's text").toBeUndefined();
    });
  }

  it("no signature anywhere leaves the key absent, never an empty string", async () => {
    const w = await makeCtx();
    await readsOnly(w);
    const { signatures, signaturesHtml } = await effectiveMailboxSignatures(w.db, w.accountId);
    /* Absent is the resting state: `effectiveSignature` reads an empty string as no block, but an
       empty VALUE in the map would make the Settings pane render "Added to messages…" over
       nothing, and the pre-0075 interface is a map with no key. */
    expect(Object.keys(signatures)).toHaveLength(0);
    expect(Object.keys(signaturesHtml)).toHaveLength(0);
  });
});
