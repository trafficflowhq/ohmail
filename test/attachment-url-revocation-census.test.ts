import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { withoutComments } from "../scripts/lib/source-scan.mjs";
import { presentRoots } from "./support/public-root.mjs";

/**
 * EVERY READER THAT MATERIALISES AN ATTACHMENT URL, AND WHAT REVOKES IT.
 *
 * A `blob:` URL pins its whole file until it is revoked or the document dies, so a surface that
 * mints one and does not release it is the defect. This pins the set: who mints, who asks the
 * engine to mint, who releases — so a new reader that mints without a release is refused here
 * rather than measured in somebody's tab.
 */

const READER_ROOTS = presentRoots(["apps/webapp/app", "apps/mobile/src", "apps/desktop/src", "apps/admin/app"]);
const SKIP = new Set(["node_modules", "dist", "build", ".next", "test", "__tests__"]);

/** Every `.ts`/`.tsx` source under `root`, tests and build outputs excluded. */
function sourcesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

type Role = { mints: boolean; asks: boolean; releases: boolean };

/** What one source DOES about object URLs, read from calls and never from a mention. */
function roleOf(src: string): Role {
  const code = withoutComments(src);
  return {
    mints: /(?<![A-Za-z0-9_$])createObjectURL\s*\(/.test(code),
    asks: /\.openAttachment\s*\(/.test(code),
    releases: /\.release(?:All)?Attachments\s*\(/.test(code),
  };
}

/**
 * The pinned set. Every other reader source does none of the three: it renders `item.objectUrl`
 * and holds no lifetime of its own.
 */
const PINNED: Record<string, Role> = {
  // The ONE seam. Mounted once in `AppShell`, keyed on the open message: it asks the engine to
  // fetch, and its cleanup releases the whole selection — the focused message and its
  // conversation's siblings. Its own `createObjectURL` is a separate thing: a short-lived save
  // handle for `<a download>`, revoked on its own timer and never an engine URL.
  "apps/webapp/app/shell/attachments.ts": { mints: true, asks: true, releases: true },
  // The phone's reader ASKS and never mints: React Native has no `URL.createObjectURL`, so no
  // `blob:` URL exists to pin a file. It still RELEASES, and that half is the load-bearing one —
  // the engine holds the list, the inline pictures and every fetched Blob until somebody drops
  // them, so a reader that only asked would grow the session by every rich message it showed.
  // `MessageReader`'s open effect owns the cleanup, keyed on the id it opened.
  "apps/mobile/src/state/live.ts": { mints: false, asks: true, releases: true },
  // The phone's world facade, which forwards that release and nothing else: it asks for no bytes
  // of its own (`openAttachmentBytes` is a different verb from the engine's `openAttachment`) and
  // mints nothing. It is here because a forwarding line is still a call, and a census that could
  // not see one would be blind to the door the cleanup travels through.
  "apps/mobile/src/state/world.tsx": { mints: false, asks: false, releases: true },
};

describe("every reader that materialises an attachment URL is accounted for", () => {
  /**
   * Mutation: add `asks: true` to a second file's pin, or drop the `attachments.ts` row. Real
   * failure text:
   *   AssertionError: a reader mints or asks for attachment bytes and this census does not know
   *   it: expected [ 'apps/…' ] to deeply equal []
   */
  it("only the pinned seams mint, ask or release", () => {
    const measured: Record<string, Role> = {};
    for (const root of READER_ROOTS) {
      for (const file of sourcesUnder(root)) {
        const role = roleOf(readFileSync(file, "utf8"));
        if (role.mints || role.asks || role.releases) measured[file] = role;
      }
    }
    const surprises = Object.keys(measured).filter((f) => !(f in PINNED));
    expect(
      surprises,
      "a reader mints or asks for attachment bytes and this census does not know it",
    ).toEqual([]);
    expect(measured).toEqual(PINNED);
  });

  /**
   * Mutation: give the pinned seam `releases: false`. Real failure text:
   *   AssertionError: a reader materialises attachment bytes and never releases them: expected
   *   [ 'apps/webapp/app/shell/attachments.ts' ] to deeply equal []
   */
  it("nothing mints or asks without also releasing", () => {
    const owing = Object.entries(PINNED)
      .filter(([, r]) => (r.mints || r.asks) && !r.releases)
      .map(([f]) => f);
    expect(owing, "a reader materialises attachment bytes and never releases them").toEqual([]);
  });

  /**
   * The seam is mounted ONCE and keyed on the open message. A second mount would hold a second
   * release set, and an unmount from one would revoke URLs the other is showing.
   * Mutation: add a second `useMessageAttachments(` call. Real failure text:
   *   AssertionError: the attachments seam is mounted more than once: expected 2 to be 1
   */
  it("the seam is mounted exactly once", () => {
    let mounts = 0;
    for (const root of READER_ROOTS) {
      for (const file of sourcesUnder(root)) {
        const code = withoutComments(readFileSync(file, "utf8"));
        // The declaration is not a mount.
        mounts += (code.match(/(?<!function )(?<![A-Za-z0-9_$])useMessageAttachments\s*\(/g) ?? []).length;
      }
    }
    expect(mounts, "the attachments seam is mounted more than once").toBe(1);
  });

  /**
   * Inside the engine, one module calls `createObjectURL` — the ledger that owns the revocation.
   * A second caller would be a URL minted outside it, which nothing can be made to revoke.
   * Mutation: call `URL.createObjectURL` from `engine.ts`. Real failure text:
   *   AssertionError: an object URL is minted outside the ledger that owes its revocation:
   *   expected [ 'packages/client-engine/src/engine.ts', … ] to deeply equal
   *   [ 'packages/client-engine/src/object-urls.ts' ]
   */
  it("the engine mints object URLs in one module only", () => {
    const minters = sourcesUnder("packages/client-engine/src").filter(
      (f) => roleOf(readFileSync(f, "utf8")).mints,
    );
    expect(
      minters,
      "an object URL is minted outside the ledger that owes its revocation",
    ).toEqual(["packages/client-engine/src/object-urls.ts"]);
  });

  /** The refusal is reachable: a reader that asks and never releases is seen for what it is. */
  it("the classifier names an asking, non-releasing reader", () => {
    const role = roleOf("await engine.openAttachment(id, a); // engine.releaseAttachments(id)");
    expect(role).toEqual({ mints: false, asks: true, releases: false });
    expect(roleOf("const u = URL.createObjectURL(b);").mints).toBe(true);
    // A mention is not a call.
    expect(roleOf("// createObjectURL and releaseAttachments are the pair").mints).toBe(false);
  });
});
