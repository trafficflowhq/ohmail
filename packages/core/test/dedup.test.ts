import { describe, it, expect } from "vitest";
import { classifyDedup } from "../src/dedup.js";
import { permitsAdoption } from "../src/ports.js";
import type { Change, MoveEvidence, StoredMessage } from "../src/ports.js";

const RAW = Buffer.from("Message-ID: <x@y>\r\n\r\nhi");
const KEY = "fp1:" + "0".repeat(64);

const CORRELATED: MoveEvidence = { kind: "correlated_move" };
const ABSENT: MoveEvidence = { kind: "verified_absence" };
const APPEARANCE: MoveEvidence = { kind: "appearance_only" };

function change(folder: string, ownAuthored = false): Change {
  return { type: "create", locator: { folder, ref: "1:7" }, raw: RAW, ...(ownAuthored ? { ownAuthored } : {}) };
}
function stored(folder: string): StoredMessage {
  return {
    id: "msg-1", dedupKey: KEY, nativeLocator: { folder, ref: "1:3" }, threadId: null,
    messageIdHeader: "x@y", bodyHash: "h", subject: "s", fromAddress: "a@b.example",
  };
}

describe("permitsAdoption", () => {
  it("is true for a correlated move and a verified absence, false for an appearance", () => {
    // The whole consent boundary in three rows. `appearance_only` returning true is the
    // vulnerability; either of the other two returning false is the opposite bug — a real user move
    // that the reconciler then drags back.
    expect(permitsAdoption(CORRELATED)).toBe(true);
    expect(permitsAdoption(ABSENT)).toBe(true);
    expect(permitsAdoption(APPEARANCE)).toBe(false);
  });
});

describe("classifyDedup", () => {
  it("is 'new' when no existing message is found", () => {
    const out = classifyDedup({
      change: change("INBOX"), dedupKey: KEY, existing: null, pendingMoveFolders: new Set(),
      evidence: APPEARANCE,
    });
    expect(out).toEqual({ kind: "new" });
  });

  it("is 'duplicate' when observed in the same folder we already store", () => {
    const out = classifyDedup({
      change: change("INBOX"), dedupKey: KEY, existing: stored("INBOX"), pendingMoveFolders: new Set(),
      evidence: APPEARANCE,
    });
    expect(out).toEqual({ kind: "duplicate", existing: stored("INBOX") });
  });

  it("is 'own_move' when observed in a folder we have a pending move to", () => {
    const out = classifyDedup({
      change: change("ohmail/News"), dedupKey: KEY,
      existing: stored("INBOX"), pendingMoveFolders: new Set(["ohmail/News"]),
      evidence: APPEARANCE,
    });
    expect(out).toEqual({ kind: "own_move", existing: stored("INBOX") });
  });

  it("is 'external_move' when the user moved it — a CORRELATED move", () => {
    const out = classifyDedup({
      change: { type: "move", locator: { folder: "Archive", ref: "1:7" }, raw: RAW }, dedupKey: KEY,
      existing: stored("INBOX"), pendingMoveFolders: new Set(["ohmail/News"]),
      evidence: CORRELATED,
    });
    expect(out).toEqual({ kind: "external_move", existing: stored("INBOX") });
  });

  it("is 'external_move' on a VERIFIED ABSENCE too, so an unpairable user move still adopts", () => {
    // Risk 3 of the ruling: if adoption required `change.type === 'move'` alone, every real user
    // move `correlateMoves` cannot pair — no Message-ID (it pairs on that), or a delete and a
    // create in different batches — would become a no-op and `reconcileFolders` would move it
    // straight back. Delete the `verified_absence` arm of `permitsAdoption` and this reports
    // `external_copy`.
    const out = classifyDedup({
      change: change("Archive"), dedupKey: KEY,
      existing: stored("INBOX"), pendingMoveFolders: new Set(),
      evidence: ABSENT,
    });
    expect(out).toEqual({ kind: "external_move", existing: stored("INBOX") });
  });

  // ── the consent boundary ───────────────────────────────────────────────────────────────────

  it("is 'external_copy' — NOT 'external_move' — for a pure create with no disappearance", () => {
    // THE FINDING. A stranger sends the same message twice. The second delivery is an observation
    // of a known logical identity in a folder we did not record, which used to be `external_move`:
    // `commitChange` then flipped `desired_folder` to wherever the delivery landed, wrote an
    // `adopt_external` audit row, and told every client the message had moved. The stranger's mail
    // escaped the Screener on the strength of consent the user gave to a different message.
    //
    // Change the last branch of `classifyDedup` to return `external_move` unconditionally and this
    // reports `{ kind: 'external_move', ... }`, which IS the vulnerability.
    const out = classifyDedup({
      change: change("ohmail/News"), dedupKey: KEY,
      existing: stored("INBOX"), pendingMoveFolders: new Set(),
      evidence: APPEARANCE,
    });
    expect(out).toEqual({ kind: "external_copy", existing: stored("INBOX") });
  });

  it("an appearance is not adoptable REGARDLESS OF FOLDER — sieve rules deliver into ohmail/*", () => {
    // The caveat that makes "which folder" useless as a signal. A user's own provider-side sieve
    // rules can deliver straight into `ohmail/News`, so an appearance there is neither our move nor
    // evidence of the user's. Any rule of the form "an ohmail folder means we or the user put it
    // there" is false, and this pins it across folder shapes.
    for (const folder of ["ohmail/News", "ohmail/Screened", "ohmail/Receipts", "Archive", "Junk"]) {
      const out = classifyDedup({
        change: change(folder), dedupKey: KEY,
        existing: stored("INBOX"), pendingMoveFolders: new Set(),
        evidence: APPEARANCE,
      });
      expect(out.kind, folder).toBe("external_copy");
    }
  });

  it("the byte-identical forgery is also a copy, and that is the CORRECT answer", () => {
    // Identical bytes ARE the same logical message, so a second physical instance and no adoption
    // is right rather than a residue to be cleaned up. The EVIDENCE, not the content, is what
    // separates this from a user's move.
    const out = classifyDedup({
      change: change("ohmail/Receipts"), dedupKey: KEY,
      existing: stored("INBOX"), pendingMoveFolders: new Set(),
      evidence: APPEARANCE,
    });
    expect(out.kind).toBe("external_copy");
  });

  it("our own pending move still outranks the evidence test", () => {
    // Order matters: a landing we caused must never be classified as anything external, whatever
    // the evidence says about a disappearance at the source — and a crash between `adapter.move`
    // and `updateLocator` produces exactly that state.
    const out = classifyDedup({
      change: change("ohmail/News"), dedupKey: KEY,
      existing: stored("INBOX"), pendingMoveFolders: new Set(["ohmail/News"]),
      evidence: ABSENT,
    });
    expect(out).toEqual({ kind: "own_move", existing: stored("INBOX") });
  });

  // ── slice the Sent twin of mail we already hold ──────────────────────────────────────

  it("is 'own_copy' — NOT 'external_move' — for the Sent twin of a message stored in INBOX", () => {
    // The self-CC / mailing-list-echo shape: one logical identity, two folders. The evidence here is
    // REAL — a client that APPENDs to Sent and expunges from INBOX in one session produces a genuine
    // disappearance — so `own_copy` has to be checked BEFORE the evidence test. Delete the
    // `ownAuthored` branch and this reports `external_move`, `desired_folder` becomes "Sent", and
    // the user's own filing habit empties their Imbox.
    const out = classifyDedup({
      change: change("Sent", true), dedupKey: KEY,
      existing: stored("INBOX"), pendingMoveFolders: new Set(),
      evidence: ABSENT,
    });
    expect(out).toEqual({ kind: "own_copy", existing: stored("INBOX") });
  });

  it("own_copy outranks own_move: a pending move never turns a Sent twin into our own landing", () => {
    const out = classifyDedup({
      change: change("Sent", true), dedupKey: KEY,
      existing: stored("INBOX"), pendingMoveFolders: new Set(["Sent"]),
      evidence: APPEARANCE,
    });
    expect(out).toEqual({ kind: "own_copy", existing: stored("INBOX") });
  });

  it("is still 'duplicate' when the own-authored observation is the folder we already record", () => {
    // A replay of the row's own locator is not a second copy — the ordinary duplicate path
    // (which re-asserts the locator) is correct, so `own_copy` must be checked AFTER it.
    const out = classifyDedup({
      change: change("Sent", true), dedupKey: KEY,
      existing: stored("Sent"), pendingMoveFolders: new Set(),
      evidence: APPEARANCE,
    });
    expect(out).toEqual({ kind: "duplicate", existing: stored("Sent") });
  });

  it("an INBOUND observation in a Sent-shaped folder is untouched by the own-authored branch", () => {
    // Without `ownAuthored` the folder name means nothing: a user who hand-files mail into a
    // folder called "Sent" still gets user-wins adoption — WHEN the disappearance is evidenced.
    const out = classifyDedup({
      change: change("Sent"), dedupKey: KEY,
      existing: stored("INBOX"), pendingMoveFolders: new Set(),
      evidence: CORRELATED,
    });
    expect(out).toEqual({ kind: "external_move", existing: stored("INBOX") });
  });

  it("is 'received_copy' for the INBOX copy of a row that stands on its Sent copy", () => {
    // A letter to yourself met Sent-first: INBOX is received mail, so its copy takes the row.
    for (const sent of ["Sent", "INBOX/Sent", "[Gmail]/Sent Mail"]) {
      const out = classifyDedup({
        change: change("INBOX"), dedupKey: KEY, existing: stored(sent), pendingMoveFolders: new Set(),
        evidence: APPEARANCE,
      });
      expect(out, sent).toEqual({ kind: "received_copy", existing: stored(sent) });
    }
  });

  it("knows a Sent folder by the mailbox's record when its name is not Sent-shaped", () => {
    const lift = (known: string, sentFolder: string | null, arrival = "INBOX") => classifyDedup({
      change: change(arrival), dedupKey: KEY, existing: stored(known), pendingMoveFolders: new Set(),
      evidence: APPEARANCE, sentFolder,
    }).kind;
    expect(lift("Envoyés", "Envoyés")).toBe("received_copy");
    expect(lift("INBOX/Verzonden", "INBOX/Verzonden")).toBe("received_copy");
    expect(lift("Envoyés", null), "no record: the name alone decides").toBe("external_copy");
    expect(lift("Archive", "Envoyés"), "another folder is not Sent").toBe("external_copy");
    expect(lift("Envoyés", "Envoyés", "Work"), "only INBOX takes the row").toBe("external_copy");
  });

  it("lifts nothing else: an INBOX copy of held mail and a label copy of Sent mail stay copies", () => {
    // The Screener's row must not be lifted by a second delivery; a label is a customer folder.
    for (const [arrival, known] of [["INBOX", "ohmail/Screener"], ["INBOX", "Archive"], ["Work", "Sent"]]) {
      const out = classifyDedup({
        change: change(arrival!), dedupKey: KEY, existing: stored(known!), pendingMoveFolders: new Set(),
        evidence: APPEARANCE,
      });
      expect(out.kind, `${arrival} over ${known}`).toBe("external_copy");
    }
  });

  it("our own pending move into INBOX outranks the received-copy lift", () => {
    const out = classifyDedup({
      change: change("INBOX"), dedupKey: KEY, existing: stored("Sent"), pendingMoveFolders: new Set(["INBOX"]),
      evidence: APPEARANCE,
    });
    expect(out.kind).toBe("own_move");
  });

  it("a re-read in News of a letter the store still spells `ohmail/Reads` is the SAME letter, not a copy", () => {
    // One server folder under two names (the 0.22 rename): an external copy here recorded a second
    // instance and set `conflict` on every re-read, and never re-pointed the stale locator.
    const out = classifyDedup({
      change: change("ohmail/News"), dedupKey: KEY, existing: stored("ohmail/Reads"),
      pendingMoveFolders: new Set(["ohmail/Receipts"]), evidence: APPEARANCE,
    });
    expect(out).toEqual({ kind: "duplicate", existing: stored("ohmail/Reads") });
  });

  it("a pending move spelled the old way still names News for a News arrival", () => {
    const out = classifyDedup({
      change: change("ohmail/News"), dedupKey: KEY, existing: stored("INBOX"),
      pendingMoveFolders: new Set(["ohmail/Reads"]), evidence: APPEARANCE,
    });
    expect(out.kind).toBe("own_move");
  });
});
