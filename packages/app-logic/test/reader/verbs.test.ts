import { describe, expect, it } from "vitest";
import type { EngineMutation } from "@ohmail/client-engine";
import { isOwnVerb, runOwnVerb, type VerbWords } from "../../src/reader/verbs.js";
import { markSeenOver } from "../../src/reader/mark-seen.js";
import { blankOf } from "../../src/reader/blank-model.js";
import { pressWords, placeLabelOver } from "../../src/reader/press-words.js";
import { faultOf, fileLookOf, thumbnailOf } from "../../src/reader/files-model.js";

/** THE READER'S OWN RUNNERS: each act leaves through the press seam with its sentence; nothing goes to the engine. */

const WORDS: VerbWords = {
  queued: "queued",
  aside: "parked",
  unqueued: "unqueued",
  unparked: "unparked",
  resurfaces: (when) => `back ${when}`,
  resurfaceNow: "now",
};

function press(removes = true) {
  const sent: Array<[EngineMutation, string | null]> = [];
  const deleted: unknown[] = [];
  return {
    sent,
    deleted,
    mutateAndReport: async (m: EngineMutation, said: string | null) => {
      sent.push([m, said]);
      return true;
    },
    deleting: {
      remove: (t: unknown) => {
        deleted.push(t);
        return removes;
      },
    } as never,
  };
}
const letter = { id: "m1", mailboxId: "mb1", unread: true, triage: null };

describe("the reader's own runners", () => {
  it("later and aside file the letter, and a second press takes it out again", () => {
    const p = press();
    runOwnVerb(p, WORDS, "later", letter, String);
    runOwnVerb(p, WORDS, "aside", { ...letter, triage: { state: "set_aside" } as never }, String);
    expect(p.sent).toEqual([
      [{ kind: "triage_set", messageId: "m1", state: "reply_later" }, "queued"],
      [{ kind: "triage_set", messageId: "m1", state: "none" }, "unparked"],
    ]);
  });

  it("the read switch flips the letter's own flag, a read naming its row", () => {
    const p = press();
    runOwnVerb(p, WORDS, "unread", letter, String);
    runOwnVerb(p, WORDS, "unread", { ...letter, unread: false }, String);
    expect(p.sent.map(([m]) => m)).toEqual([
      { kind: "mark_seen", messageIds: ["m1"], unread: false, readRow: "m1" },
      { kind: "mark_seen", messageIds: ["m1"], unread: true },
    ]);
  });

  it("resurface at a day says the day; now pins it", () => {
    const p = press();
    runOwnVerb(p, WORDS, "resurface:2026-11-20T08:00:00.000Z", letter, () => "Friday");
    runOwnVerb(p, WORDS, "resurface_now", letter, String);
    expect(p.sent).toEqual([
      [
        { kind: "triage_set", messageId: "m1", state: "bubbled_up", bubbleUpAt: "2026-11-20T08:00:00.000Z" },
        "back Friday",
      ],
      [{ kind: "triage_set", messageId: "m1", state: "resurfaced" }, "now"],
    ]);
  });

  it("delete opens the seam's window and answers whether it acted", () => {
    const p = press(false);
    expect(runOwnVerb(p, WORDS, "delete", letter, String)).toBe(false);
    expect(p.deleted).toEqual([{ id: "m1", mailboxId: "mb1" }]);
    expect(p.sent).toEqual([]);
  });

  it("only these verbs are the reader's own", () => {
    expect(
      ["later", "aside", "unread", "resurface_now", "resurface:x", "delete"].every((a) =>
        isOwnVerb(a as never),
      ),
    ).toBe(true);
    expect(
      ["reply", "forward", "move:spam", "resurface", "resurface_done", "restore"].some((a) =>
        isOwnVerb(a as never),
      ),
    ).toBe(false);
  });

  it("a mark of nothing sends nothing", async () => {
    const p = press();
    expect(await markSeenOver(p)([], false)).toBe(false);
    expect(p.sent).toEqual([]);
  });
});

describe("the column's word with nothing open", () => {
  it("no list above: its own word; the list's word where one stands; nothing where the list says nothing", () => {
    expect(blankOf(undefined, "Nothing open")).toEqual({ label: "Nothing open", hot: false });
    expect(blankOf({ label: "5 unread", hot: true }, "Nothing open")).toEqual({
      label: "5 unread",
      hot: true,
    });
    expect(blankOf(null, "Nothing open")).toBeNull();
  });
});

describe("the seam's words", () => {
  it("a key goes to its namespace's reader; an unknown namespace answers nothing", () => {
    const t = pressWords({
      ohbox: (k, v) => `ohbox:${k}:${String(v?.count ?? "")}`,
      screener: (k) => `screener:${k}`,
      trash: (k) => k,
      screening: (k) => k,
      session: (k) => k,
      shortcuts: (k) => k,
    });
    expect(t("ohbox.toastBulkLater", { count: 3 })).toBe("ohbox:toastBulkLater:3");
    expect(t("screener.undo")).toBe("screener:undo");
    expect(t("billing.price")).toBe("");
    expect(t("nodot")).toBe("");
  });

  it("a folder is said as its place, else its last part", () => {
    const label = placeLabelOver((view) => (view === "ohbox" ? "Ohbox" : ""));
    expect(label("INBOX")).toBe("Ohbox");
    expect(label("Archive/2024/Q1")).toBe("Q1");
  });
});

describe("a file's tile", () => {
  it("its look is its declared type's, never its name's", () => {
    expect(fileLookOf("image/png")).toBe("image");
    expect(fileLookOf("application/pdf; name=x")).toBe("pdf");
    expect(fileLookOf("text/plain; charset=utf-8")).toBe("text");
    expect(fileLookOf("image/svg+xml")).toBe("other");
  });

  it("a thumbnail only from bytes held here, for a ready raster picture", () => {
    const ready = { mimeType: "image/png", state: "ready" as const };
    expect(thumbnailOf({ ...ready, objectUrl: "blob:here/1" })).toBe("blob:here/1");
    expect(thumbnailOf({ ...ready, objectUrl: "https://pictures.example/a.png" })).toBeNull();
    expect(thumbnailOf({ ...ready, mimeType: "image/svg+xml", objectUrl: "blob:here/2" })).toBeNull();
    expect(thumbnailOf({ ...ready, state: "idle", objectUrl: "blob:here/3" })).toBeNull();
  });

  it("a file that did not arrive: what helps is said by its fault's class", () => {
    expect(faultOf({ mimeType: "a/b", state: "failed", code: "network" })).toEqual({
      key: "faultOffline",
      way: "retry",
    });
    expect(faultOf({ mimeType: "a/b", state: "failed", code: "unauthorized" })).toEqual({
      key: "faultSignedOut",
      way: "signIn",
    });
    expect(faultOf({ mimeType: "a/b", state: "failed", code: "not_found" })).toEqual({
      key: "faultGone",
      way: null,
    });
    expect(faultOf({ mimeType: "a/b", state: "failed", code: "mailbox_busy", retryable: false })).toEqual({
      key: "faultBusy",
      way: null,
    });
  });
});
