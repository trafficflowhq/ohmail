import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Copy } from "../src/copy";
import { junkFolderSaid } from "../src/state/folders";
import { readMailboxes } from "../src/net/mailboxes";
import type { ConnectedSession } from "../src/net/pairing";

/**
 * ═══ JUNK-INVISIBLE ON THE PHONE — the same sentence, in the same place ═════════════════════
 *
 * ohmail never mirrors the mail server's own Junk folder, so mail the provider filed there is
 * in no list on this phone either. The More screen's folders group is where somebody looks for
 * a folder they cannot find, so it carries one sentence at its foot naming the folder the
 * roster resolved — and says nothing at all where none was, because a sentence about a folder
 * that may not exist is worse than silence.
 *
 * NO POINTER HERE, deliberately: this app has no Junk window, so the phone states and stops.
 * The webapp's line offers the Screener's Junk segment; offering it on a surface that cannot
 * open it would be the product telling somebody to go somewhere it does not have.
 *
 * The derivation is mirrored from `apps/webapp/app/shell/folders.ts` and driven directly here;
 * the strings' equality with the webapp catalogue lives in `folders-parity.test.ts`.
 *
 * Mutation-checked, each watched red and restored:
 *  · `leaves.size === 1` → always "unnamed"   → the named case;
 *  · drop the `status === "disabled"` skip    → the stood-down case;
 *  · `folderLeafOf(path)` → `path`            → the nested-path case;
 *  · drop the `junkSaid !== null` render gate → the renders-nothing case (source-level).
 */

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const read = (p: string) => readFileSync(at(p), "utf8");

describe("junkFolderSaid — which sentence the phone's folders group is owed", () => {
  it("names the folder the roster resolved, by its LEAF", () => {
    expect(junkFolderSaid([{ status: "connected", junkFolder: "Junk" }])).toEqual({ named: "Junk" });
    expect(junkFolderSaid([{ status: "connected", junkFolder: "INBOX/Spamverdacht" }]))
      .toEqual({ named: "Spamverdacht" });
  });

  it("drops the name when the account's mailboxes call it different things", () => {
    expect(junkFolderSaid([
      { status: "connected", junkFolder: "Junk" },
      { status: "connected", junkFolder: "INBOX/Spam" },
    ])).toBe("unnamed");
  });

  it("says nothing for no Junk folder, nothing attached yet, or a server that cannot say", () => {
    expect(junkFolderSaid([{ status: "connected", junkFolder: null }])).toBeNull();
    expect(junkFolderSaid([{ status: null, junkFolder: "" }])).toBeNull();
    expect(junkFolderSaid([])).toBeNull();
  });

  it("does not speak for a stood-down mailbox — another install's", () => {
    expect(junkFolderSaid([{ status: "disabled", junkFolder: "Junk" }])).toBeNull();
    expect(junkFolderSaid([
      { status: "disabled", junkFolder: "Spam" },
      { status: "connected", junkFolder: "Junk" },
    ])).toEqual({ named: "Junk" });
  });

  it("a mailbox the wire gave no status is not disabled", () => {
    // `null` here is "the wire named none", which the roster reader writes for an older server.
    // Reading it as a stand-down would silence the sentence on every such deployment.
    expect(junkFolderSaid([{ status: null, junkFolder: "Junk" }])).toEqual({ named: "Junk" });
  });
});

/* ───────────────────────────────────────────────────────── the roster read carries it */

function sessionAnswering(body: unknown): ConnectedSession {
  return {
    profile: { origin: "https://server.test" },
    fetch: () =>
      Promise.resolve(new Response(JSON.stringify(body), {
        status: 200, headers: { "content-type": "application/json" },
      })),
  } as unknown as ConnectedSession;
}

describe("the phone's roster read carries the folder name off the wire", () => {
  it("keeps the path and the status", async () => {
    const rows = await readMailboxes(sessionAnswering({
      items: [{ id: "mb1", address: "a@x.test", status: "connected", junkFolder: "INBOX/Junk" }],
    }));
    expect(rows).toEqual([{
      id: "mb1", address: "a@x.test",
      // The organizer pair the paired-state fix carries: a wire that names no role lands
      // as `null` — "this server said nothing" — and the install comparison as `false`.
      organizerRole: null, organizedBy: null, organizedByThisInstall: false, organizerState: null,
      // Nobody consented on this wire either, and nothing paused it (mail 0135).
      organizeConsentedAt: null, organizerParkedAt: null,
      status: "connected", junkFolder: "INBOX/Junk",
      // Mail 0132's recorded Sent folder; absent on the wire, so `null` here.
      sentFolder: null,
      // The composer's cap input rides the same read; absent on the wire, so `null` here.
      smtpMaxSizeBytes: null,
      // Mail 0115's field rides the same read; absent on the wire, so `null` here.
      firstSyncStopFolder: null,
    }]);
  });

  it("an empty string is not a folder name, and an older server sends neither", async () => {
    // Both land as `null`, which is the one instruction the group needs: say nothing.
    const rows = await readMailboxes(sessionAnswering({
      items: [
        { id: "mb1", address: "a@x.test", junkFolder: "" },
        { id: "mb2", address: "b@x.test" },
      ],
    }));
    expect(rows?.map((r) => r.junkFolder)).toEqual([null, null]);
    expect(rows?.map((r) => r.status)).toEqual([null, null]);
    expect(junkFolderSaid(rows ?? [])).toBeNull();
  });
});

/* ──────────────────────────────────────────────────── the surface, at its own source */

describe("the folders group renders it at the foot, and only when there is something to say", () => {
  const group = read("../src/ui/FoldersGroup.tsx");
  const more = read("../app/(tabs)/more.tsx") +
    /* The rows moved into the shared MoreNav (the big-screen drawer mounts the same list, so
       the two cannot drift) — the More screen's properties live in the pair. */
    read("../src/ui/MoreNav.tsx");

  it("the group is gated on a resolved folder — not on the flag, not unconditionally", () => {
    expect(group).toMatch(/\{junkSaid !== null \?/);
    expect(group).toContain("Copy.junkNote(junkSaid.named)");
    expect(group).toContain("Copy.junkNoteUnnamed");
  });

  it("the More screen feeds it from the world's own derivation", () => {
    expect(more).toMatch(/junkSaid=\{w\.folders\.junkSaid\}/);
  });

  it("the phone offers no way in, because it has no Junk window to offer", () => {
    // The webapp's pointer key. Present here it would send somebody to a screen this app
    // does not have — a false claim in the one sentence that exists to stop one.
    expect(group).not.toContain("junkElsewhere");
    expect(Copy).not.toHaveProperty("junkElsewhere");
  });
});
