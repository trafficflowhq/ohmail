import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";
import { readEngineAsOneText } from "../../../test/support/engine-unit.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  EVERY WRITER THAT SEALS A MAILBOX PASSWORD READS THE SIGN-OUT STAMP
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A sign-out stamps `mailboxes.signed_out_at` in the same transaction as the credential delete,
 * and a write that began before that stamp refuses (`packages/services/src/signed-out-fence.ts`).
 * The rule is only as good as its coverage: one writer that seals a secret without reading the
 * stamp is a door a sign-out does not close, and nothing else in the tree would say so — the
 * engine's own epoch is per-process, so an ungated writer simply works.
 *
 * ── WHAT IS COUNTED, AND WHAT IS NOT ──────────────────────────────────────────────────────
 *
 * A CALL, found by parse rather than by filename: every `insert(mailboxCredentials)` and
 * `update(mailboxCredentials)` in the two roots a standalone install runs, classified by whether
 * the object it writes names `secretEnc`. A write that carries no secret cannot put a password
 * back, so it is recorded META-ONLY and left alone — the seed's server backfill is one, and this
 * file is where that classification is stated rather than assumed. A DELETE is not a write.
 *
 * The gate must sit in the SAME BLOCK as the write, one level up and no further: a fence in an
 * outer block is a fence a branch can step around.
 *
 * ── THE POSITIVE CONTROL ──────────────────────────────────────────────────────────────────
 *
 * The fixture below holds all three shapes — gated, ungated, meta-only — so a green here is a
 * detector that discriminates rather than one that found nothing. Measured: with the fence call
 * deleted from `upsertCredOn`, the services root reads one UNGATED site and this file is red.
 */

/**
 * AND THE ERASURE'S STAMP, on the same rule. A mailbox erasure leaves the row as its tombstone
 * and deletes the credentials, so a writer that does not read `mailboxes.erased_at` re-mints a
 * password for a mailbox somebody removed — a live way back into it. The sign-out's argument one
 * column over, measured the same way and in the same block: a door is closed when it reads BOTH.
 */
const ROOTS = [
  { name: "apps/sidecar/src/engine.ts", url: new URL("../src/engine.ts", import.meta.url) },
  {
    name: "packages/services/src/mailbox-service.ts",
    url: new URL("../../../packages/services/src/mailbox-service.ts", import.meta.url),
  },
] as const;

/** A root's text; the engine's is its whole unit, read as one. */
const textOf = (root: (typeof ROOTS)[number]): string =>
  root.name === "apps/sidecar/src/engine.ts" ? readEngineAsOneText() : readFileSync(fileURLToPath(root.url), "utf8");

type Site = { at: number; secret: boolean; gated: boolean; erasureGated: boolean };

/**
 * The block that CONTAINS `at` — from the `{` it opens with. Brace depth over a source with its
 * comments and string literals already removed, so a brace inside a message or a template cannot
 * be read as structure.
 */
function blockAround(code: string, at: number): string {
  let depth = 0;
  for (let i = at; i >= 0; i -= 1) {
    const ch = code[i];
    if (ch === "}") depth += 1;
    else if (ch === "{") {
      if (depth === 0) return code.slice(i, at);
      depth -= 1;
    }
  }
  return code.slice(0, at);
}

/** Every credential write in one source, classified. */
function sites(source: string): Site[] {
  const code = withoutCommentsAndLiterals(source);
  const found: Site[] = [];
  const call = /\.(?:insert|update)\(mailboxCredentials\)/g;
  for (let m = call.exec(code); m !== null; m = call.exec(code)) {
    const at = m.index;
    /* The written object, as far as the next write or the end of the statement chain. A window
       rather than a matched pair: `.values({…}).onConflictDoUpdate({…})` is one write with two
       objects and both of them can carry the secret. */
    const next = code.slice(at + 1).search(/\.(?:insert|update|delete)\(mailboxCredentials\)/);
    const written = code.slice(at, next === -1 ? code.length : at + 1 + next);
    const secret = /\bsecretEnc\b/.test(written.slice(0, 1200));
    const block = blockAround(code, at);
    found.push({
      at, secret,
      gated: block.includes("fenceSignedOutMailbox("),
      /* The erasure arm, in either of its two spellings: the db seam's own and the services
         edge's, which is the same call with the 410 put on. Same block rule as the sign-out's —
         a gate one level out is a gate a branch steps around. */
      erasureGated: block.includes("fenceErasedMailbox(") || block.includes("fenceErasedMailboxOnly("),
    });
  }
  return found;
}

/** A file's three shapes, written out, so the detector is proved on all of them at once. */
const FIXTURE = `
const a = async () => {
  await db.transaction(async (tx) => {
    await fenceSignedOutMailbox(tx, d, id, origin);
    await tx.insert(mailboxCredentials).values({ secretEnc: sealed.ciphertext, keyVersion: 1 });
  });
};
const b = async () => {
  await db.insert(mailboxCredentials).values({ secretEnc: sealed.ciphertext, keyVersion: 1 });
};
const c = async () => {
  await db.update(mailboxCredentials).set({ meta: merged });
};
const d2 = async () => {
  await fenceSignedOutMailbox(tx, d, id, origin);
  if (cond) {
    await db.insert(mailboxCredentials).values({ secretEnc: "x{}", keyVersion: 1 });
  }
};
const e = async () => {
  await db.transaction(async (tx) => {
    await fenceSignedOutMailbox(tx, d, id, origin);
    await fenceErasedMailbox(tx, d, id);
    await tx.insert(mailboxCredentials).values({ secretEnc: sealed.ciphertext, keyVersion: 1 });
  });
};
`;

describe("every credential writer reads the sign-out stamp", () => {
  it("the detector tells the three shapes apart, including a fence one block too far out", () => {
    const s = sites(FIXTURE);
    expect(s.map((x) => `${x.secret ? "secret" : "meta"}/${x.gated ? "gated" : "ungated"}` +
      `/${x.erasureGated ? "erasure" : "no-erasure"}`))
      .toEqual([
        // The sign-out fence alone: gated for one stamp and not the other, which is the state
        // every one of these writers was in before the erasure arm existed. Both columns are
        // read, so a file that closed one door and not the other cannot pass for closed.
        "secret/gated/no-erasure",
        "secret/ungated/no-erasure",
        "meta/ungated/no-erasure",
        // The fence is in the enclosing function, not in the block the write sits in — a branch
        // reaches the write without it, so it does not count.
        "secret/ungated/no-erasure",
        // And both stamps, in the block that writes: the shape every real site now has.
        "secret/gated/erasure",
      ]);
  });

  for (const root of ROOTS) {
    it(`${root.name} seals no password without the fence`, () => {
      const found = sites(textOf(root));
      expect(found.length, "no credential write found — the detector stopped matching")
        .toBeGreaterThan(0);
      const ungated = found.filter((s) => s.secret && !s.gated);
      expect(
        ungated.length,
        `${ungated.length} credential write(s) here seal a password without reading ` +
          "`mailboxes.signed_out_at`; a sign-out cannot close a door that does not read it",
      ).toBe(0);
      const unerased = found.filter((s) => s.secret && !s.erasureGated);
      expect(
        unerased.length,
        `${unerased.length} credential write(s) here seal a password without reading ` +
          "`mailboxes.erased_at`; an erasure leaves the mailbox row standing, so nothing else " +
          "refuses a password re-minted for a mailbox that has been removed",
      ).toBe(0);
      expect(found.some((s) => s.secret), "no SECRET write here — the classifier found none")
        .toBe(true);
    });
  }

  it("the writers are the ones this slice ruled on, and a new one has to be ruled on too", () => {
    // A COUNT PIN, because a writer added without the fence is caught above while a writer added
    // WITH it is a new door into somebody's mailbox password that nobody looked at.
    const counts = ROOTS.map((r) => {
      const found = sites(textOf(r));
      return `${r.name}: ${found.filter((s) => s.secret).length} secret, ` +
        `${found.filter((s) => !s.secret).length} meta`;
    });
    expect(counts).toEqual([
      // The launch's own seal, and the seed's submission-credential copy. The third `update` here
      // backfills the server a credential was proved against and writes no secret.
      "apps/sidecar/src/engine.ts: 2 secret, 1 meta",
      // `upsertCredOn` — the service's one door into the table, for create, update, organize-here
      // and the OAuth connect alike.
      "packages/services/src/mailbox-service.ts: 1 secret, 0 meta",
    ]);
  });
});
