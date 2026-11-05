/** @vitest-environment jsdom */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  EMPTY_COMPOSE,
  clearComposeDraft,
  composeDraftKey,
  readComposeDraft,
  writeComposeDraft,
} from "../app/shell/compose";
import { dropLocalStorageKeys } from "../app/shell/boot-cache";
import {
  COMPOSE_SEND_KEY, clearLaneScratch, clearReplyLane, readReplyDraft, readReplyMeta, replyDraftKey, replyMetaKey,
  writeReplyDraft, writeReplyMeta,
} from "../app/shell/mail-send";
import { searchSortKey } from "../app/shell/persisted-ui";
import {
  armScreenerIntent,
  screenerIntentsKey,
  takeScreenerIntents,
  type ScreenerIntent,
} from "../app/shell/screener-intents";
import { claimSendLock, readSendLock, releaseSendLock, sendLocksKey } from "../app/shell/send-lock";
import { resetStorageOwnerForTest, setStorageOwner, storageOwner } from "../app/shell/storage-owner";
/** No send is owed an ending in these jar-only cases — the shape every deletion had before keys could be owed. */
const NONE_OWED = (): boolean => false;
/** The claims below are sends still in flight: owed, the one state a record resumes in. */
const IN_FLIGHT = (k: string): boolean => k === "idem-a" || k === "idem-b";

/**
 * ═══ THE ACCOUNT SCOPING THREE FIXES REST ON DID NOT EXIST ON TWO OF THE THREE DOORS ═══════════
 *
 * `composeDraftKey`, `sendLocksKey`, `screenerIntentsKey` and `searchSortKey` are all built as
 * `` `<prefix>${owner ?? "local"}` ``, and each of the four files says in its own words why: one
 * account's unfinished message, pending Screener decision or send key must never be handed to the
 * next account on the same browser.
 *
 * The storage owner came from the `tf_owner` cookie alone. **Two shipped doors have no cookie**, and
 * `owner-cookie.ts` drew the wrong conclusion from that in writing — *"On the desktop there is no
 * such cookie, `readOwner` answers null, and nothing here changes anything."* The first clause is
 * true; the second is the defect. `null` is not "no scoping needed", it is EVERY MAILBOX SHARING
 * ONE KEY:
 *
 *  · the **desktop window**, which mounts a different engine per mailbox its shell serves, so
 *    switching mailboxes restored the previous mailbox's unfinished message into the next
 *    mailbox's composer — where autosave could persist it as that mailbox's draft and Send could
 *    deliver it under that identity. That is the exact leak `composeDraftKey` was created to stop,
 *    open on the one door that has no sign-out between the two accounts;
 *  · the **host door's client**, bearer-only by construction, where every pairing the origin has
 *    ever held shared one key — and a tailnet or LAN address is reusable.
 *
 * These cases drive the real store functions, not a key-shape assertion: what is written is read
 * back, or is not, through `writeComposeDraft`/`readComposeDraft`, `armScreenerIntent`/
 * `takeScreenerIntents` and `claimSendLock`/`readSendLock`.
 *
 * ── THE MUTATIONS EVERY CASE HERE WAS WATCHED AGAINST ─────────────────────────────────────────
 *
 *  · put `readOwner()` back as the default of any of the four key builders → that store's
 *    "does not cross" case goes red, because both mailboxes resolve to `…local` again;
 *  · make `storageOwner()` return `hostOwner ?? readOwner()` → "the cookie outranks the host"
 *    goes red;
 *  · drop the `isOwnerShaped` guard from `setStorageOwner` → "a malformed id is absent, not
 *    repaired" goes red with a key built from the junk;
 *  · move `setStorageOwner` in either gate from render into a `useEffect` → "the storage owner is set
 *    before the shell's own effect reads it" goes red, which is the ordering the whole seam
 *    depends on;
 *  · delete the `setStorageOwner` call from either gate → the census goes red and names the file.
 */

const A = "mailbox-aaaa1111";
const B = "mailbox-bbbb2222";

function jar(value: string | null): void {
  // jsdom's cookie jar: set, or expire.
  document.cookie = value === null
    ? "tf_owner=; Path=/; Max-Age=0"
    : `tf_owner=${value}; Path=/`;
}

beforeEach(() => {
  window.localStorage.clear();
  jar(null);
  resetStorageOwnerForTest();
});

afterEach(() => {
  window.localStorage.clear();
  jar(null);
  resetStorageOwnerForTest();
});

const intent = (id: string): ScreenerIntent => ({
  v: 1,
  id,
  dest: "ohbox",
  read: false,
  scope: "sender",
  quiet: false,
  at: Date.now(),
  derived: false,
  heldIds: [],
  from: { name: null, address: "stranger@example.com" },
});

describe("a host-supplied owner partitions the shell's durable stores", () => {
  it("the compose scratch does not cross mailboxes on a door with no cookie", () => {
    setStorageOwner(A);
    writeComposeDraft({ ...EMPTY_COMPOSE, to: "someone@example.com", subject: "confidential", body: "text" });
    expect(readComposeDraft().subject, "the mailbox that wrote it still has it").toBe("confidential");

    setStorageOwner(B);
    expect(
      readComposeDraft(),
      "the next mailbox on this install must not be handed the previous one's unfinished message",
    ).toEqual(EMPTY_COMPOSE);

    setStorageOwner(A);
    expect(readComposeDraft().subject, "and going back finds it where it was left").toBe("confidential");
  });

  it("a Screener decision armed under one mailbox is not offered to another's replay", () => {
    setStorageOwner(A);
    armScreenerIntent(intent("msg-1"));
    expect(takeScreenerIntents(Date.now()).live.map((r) => r.id)).toEqual(["msg-1"]);

    setStorageOwner(B);
    expect(
      takeScreenerIntents(Date.now()).live,
      "a decision made about one mailbox must never be committed against another",
    ).toEqual([]);
  });

  it("a send lane does not outlive the mailbox whose key it holds", () => {
    const fp = "fingerprint-1";
    setStorageOwner(A);
    claimSendLock({ v: 1, lane: "compose", key: "idem-a", fp, at: Date.now(), draftId: null, subject: "compose:sess-a", session: "sess-a" }, NONE_OWED);
    expect(readSendLock("compose", fp, Date.now(), IN_FLIGHT)).toBe("idem-a");

    setStorageOwner(B);
    expect(
      readSendLock("compose", fp, Date.now(), NONE_OWED),
      "another mailbox's idempotency key is not this mailbox's to resume",
    ).toBeNull();
  });

  it("a send that settles AFTER a mailbox switch clears its own partition, not the new one", () => {
    /**
     * `engine.mutate`'s promise outlives the surface that started it. The shell is keyed by the
     * storage owner, so a mailbox switch remounts it — but a promise created by the OLD shell still
     * resolves, and its settlement used to resolve its keys through the module global, which by
     * then names the NEW mailbox. It deleted mailbox B's unfinished message and B's durable
     * idempotency claim; losing that claim is the worse half, because it is what makes a press
     * survive a crash without delivering twice.
     *
     * The hook captures its owner at mount, so a late settlement writes where it was started.
     */
    const fp = "fp-a";
    setStorageOwner(A);
    claimSendLock({ v: 1, lane: "compose", key: "idem-a", fp, at: Date.now(), draftId: null, subject: "compose:sess-a", session: "sess-a" }, NONE_OWED);
    writeComposeDraft({ ...EMPTY_COMPOSE, to: "a@x.example", subject: "A's draft", body: "a" });

    // The window moves to mailbox B, which has its own draft and its own in-flight claim.
    setStorageOwner(B);
    writeComposeDraft({ ...EMPTY_COMPOSE, to: "b@x.example", subject: "B's draft", body: "b" });
    claimSendLock({ v: 1, lane: "compose", key: "idem-b", fp: "fp-b", at: Date.now(), draftId: null, subject: "compose:sess-b", session: "sess-b" }, NONE_OWED);

    // …and NOW mailbox A's send settles, carrying the storage owner it was started under.
    // Named by message now, not by lane: a lane can hold an unresolved record beside a live
    // claim, so "release the lane" is no longer a statement anybody can make.
    releaseSendLock("compose", fp, NONE_OWED, A);
    clearComposeDraft(A);

    expect(readComposeDraft().subject, "the new mailbox's draft was deleted by the old one").toBe("B's draft");
    expect(
      readSendLock("compose", "fp-b", Date.now(), IN_FLIGHT),
      "the new mailbox's durable send claim was deleted — the duplicate-send guard is gone",
    ).toBe("idem-b");
    setStorageOwner(A);
    expect(readSendLock("compose", fp, Date.now(), NONE_OWED), "and its own lane was released").toBeNull();
    expect(readComposeDraft()).toEqual(EMPTY_COMPOSE);
  });

  it("all four owner-keyed builders differ between two mailboxes, and none is the shared literal", () => {
    setStorageOwner(A);
    const first = [composeDraftKey(), sendLocksKey(), screenerIntentsKey(), searchSortKey(storageOwner())];
    setStorageOwner(B);
    const second = [composeDraftKey(), sendLocksKey(), screenerIntentsKey(), searchSortKey(storageOwner())];

    expect(new Set([...first, ...second]).size, "eight distinct keys, not four").toBe(8);
    for (const key of [...first, ...second]) {
      expect(key.endsWith("local"), `${key} still collapses onto the shared partition`).toBe(false);
    }
  });
});

/**
 * THE REPLY BUFFERS NAME THEIR OWNER TOO: `<prefix><owner>:<lane>`, so a one-account wipe can take one account's
 * reply text and leave another's. A key written before (or with no owner) moves into the reader's partition on
 * read: message and draft ids are random, so only the account that holds a lane can name it.
 */
describe("the reply buffers are partitioned by the storage owner", () => {
  const words = (text: string) => ({ text, html: "" });
  /** The jar refuses every write while `run` runs, as a full quota does. */
  function refusingWrites<T>(run: () => T): T {
    const real = window.localStorage;
    const held = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        get length() { return real.length; },
        key: (i: number) => real.key(i),
        getItem: (k: string) => real.getItem(k),
        setItem: () => { throw new DOMException("quota exceeded", "QuotaExceededError"); },
        removeItem: (k: string) => real.removeItem(k),
        clear: () => real.clear(),
      } as Storage,
    });
    try {
      return run();
    } finally {
      if (held) Object.defineProperty(window, "localStorage", held);
    }
  }

  it("the keys differ by owner, no owner keeps the old key, and one mailbox never reads another's reply", () => {
    expect(new Set([replyDraftKey("m-1", A), replyDraftKey("m-1", B), replyDraftKey("m-1", null)]).size).toBe(3);
    expect(new Set([replyMetaKey("m-1", A), replyMetaKey("m-1", B), replyMetaKey("m-1", null)]).size).toBe(3);
    expect([replyDraftKey("m-1", null), replyMetaKey("m-1", null)]).toEqual(["ohmail.ui.reply:m-1", "ohmail.ui.replymeta:m-1"]);
    setStorageOwner(A);
    writeReplyDraft("m-1", words("A's reply"));
    setStorageOwner(B);
    expect(readReplyDraft("m-1").text, "the next mailbox was handed the previous one's reply").toBe("");
    setStorageOwner(A);
    expect(readReplyDraft("m-1").text).toBe("A's reply");
  });

  it("an old lane read under A moves to A's key; a refused copy keeps the old one and is still read", () => {
    const old = { body: "typed before its account was named", meta: { subject: "a title" } };
    window.localStorage.setItem(replyDraftKey("m-1", null), old.body);
    window.localStorage.setItem(replyMetaKey("m-1", null), JSON.stringify(old.meta));
    setStorageOwner(A);
    expect(refusingWrites(() => [readReplyDraft("m-1").text, readReplyMeta("m-1")]), "a refused copy hid the words")
      .toEqual([old.body, old.meta]);
    expect(window.localStorage.getItem(replyDraftKey("m-1", null)), "the old copy went before the new one stood").toBe(old.body);
    expect([readReplyDraft("m-1").text, readReplyMeta("m-1")]).toEqual([old.body, old.meta]);
    expect([replyDraftKey("m-1", null), replyMetaKey("m-1", null)].map((k) => window.localStorage.getItem(k))).toEqual([null, null]);
    expect(window.localStorage.getItem(replyDraftKey("m-1", A))).toBe(old.body);
    expect(JSON.parse(window.localStorage.getItem(replyMetaKey("m-1", A))!)).toEqual(old.meta);
  });

  it("emptying or clearing a reply never brings its old copy back", () => {
    window.localStorage.setItem(replyDraftKey("m-1", null), "an old copy");
    setStorageOwner(A);
    expect(refusingWrites(() => readReplyDraft("m-1")).text).toBe("an old copy");
    writeReplyDraft("m-1", words(""));
    expect(readReplyDraft("m-1").text, "the emptied reply came back from its old copy").toBe("");
    window.localStorage.setItem(replyMetaKey("m-1", null), JSON.stringify({ subject: "an old title" }));
    clearReplyLane("m-1");
    expect(readReplyMeta("m-1"), "a cleared lane came back from its old copy").toEqual({});
  });

  it("a send that settles after a mailbox switch clears its own partition only, on every lane", () => {
    const lanes = ["m-1", "fwd:m-1", "draft:d-1"];
    for (const owner of [A, B]) {
      setStorageOwner(owner);
      for (const lane of lanes) writeReplyMeta(lane, { subject: `${owner}'s` });
      for (const lane of lanes.slice(0, 2)) writeReplyDraft(lane, words(`${owner}'s`));
    }
    // The window serves B when A's reply, forward and compose sends settle.
    const settled = (m: object) => m as Parameters<typeof clearLaneScratch>[1];
    clearLaneScratch("m-1", settled({ inReplyTo: "m-1", draftId: null }), A, true);
    clearLaneScratch("fwd:m-1", settled({ inReplyTo: null, forwardOf: "m-1", draftId: null }), A, true);
    clearLaneScratch(COMPOSE_SEND_KEY, settled({ inReplyTo: null, draftId: "d-1" }), A, false);
    const held = (): Array<string | undefined> => [
      ...lanes.map((lane) => readReplyMeta(lane).subject), ...lanes.slice(0, 2).map((lane) => readReplyDraft(lane).text),
    ];
    expect(held(), "the new mailbox's reply scratch went with the old one's sends").toEqual(Array(5).fill(`${B}'s`));
    setStorageOwner(A);
    expect(held(), "the sends left their own scratch").toEqual([undefined, undefined, undefined, "", ""]);
  });

  it("the host door's sweep takes the reply text a pairing named", async () => {
    const { HOST_SCRATCH_PREFIXES } = await import("../../desktop/src/host-client/HostGate");
    setStorageOwner("pairing-scope-1");
    writeReplyDraft("m-1", words("typed on a phone"));
    writeReplyMeta("m-1", { subject: "a title" });
    expect(Object.keys(window.localStorage)).toHaveLength(2);
    dropLocalStorageKeys(HOST_SCRATCH_PREFIXES);
    expect(Object.keys(window.localStorage), "an ended pairing left its reply text").toEqual([]);
  });
});

describe("what the host may and may not decide", () => {
  it("the server-confirmed cookie outranks a host-supplied id", () => {
    jar("account-from-server");
    setStorageOwner(A);
    expect(storageOwner()).toBe("account-from-server");
    expect(composeDraftKey()).toContain("account-from-server");
  });

  it("a malformed id is treated as absent rather than repaired", () => {
    setStorageOwner("has spaces and /slashes");
    expect(storageOwner(), "a value that cannot name a key is not guessed at").toBeNull();
    expect(composeDraftKey()).toBe(composeDraftKey(null));
  });

  it("null is still a real answer, and still spells its own suffix", () => {
    setStorageOwner(A);
    setStorageOwner(null);
    expect(storageOwner()).toBeNull();
    expect(composeDraftKey()).toBe(composeDraftKey(null));
  });
});

/**
 * THE ORDERING THE WHOLE SEAM RESTS ON, driven through React rather than asserted in prose.
 *
 * `AppShell` reads the compose scratch in its OWN `useEffect`, and React runs a child's effects
 * before its parent's. A gate that established the storage owner from an effect would therefore set it
 * one commit after the shell had already read the previous mailbox's key. This is why both gates
 * call `setStorageOwner` during render, and this case is what makes that a checked fact.
 */
describe("a parent that sets the storage owner in render is early enough for a child's effect", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    const act = (React as unknown as { act: (cb: () => void) => void }).act;
    act(() => root.unmount());
    host.remove();
  });

  it("an UNKEYED child keeps its state across an owner change; a keyed one does not", async () => {
    /**
     * The mechanism behind the census above, driven rather than asserted. `Editor` stands in for
     * the compose form: text held in state, loaded once on mount. Unkeyed, React preserves it
     * across the storage-owner change and the text written under A is still there under B — which is what
     * an autosave would then persist into B's partition.
     */
    function Editor({ onSeen }: { onSeen: (v: string) => void }) {
      const [text, setText] = React.useState("");
      React.useEffect(() => {
        setText(readComposeDraft().subject);
      }, []);
      React.useEffect(() => {
        if (text) onSeen(text);
      }, [text, onSeen]);
      return null;
    }

    const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

    setStorageOwner(A);
    writeComposeDraft({ ...EMPTY_COMPOSE, to: "a@example.com", subject: "A's draft", body: "x" });
    setStorageOwner(B);
    writeComposeDraft({ ...EMPTY_COMPOSE, to: "b@example.com", subject: "B's draft", body: "y" });

    for (const keyed of [false, true]) {
      const seen: string[] = [];
      const onSeen = (v: string): void => void seen.push(v);
      const host2 = document.createElement("div");
      document.body.appendChild(host2);
      const root2 = createRoot(host2);
      const Gate = ({ owner }: { owner: string }) => {
        setStorageOwner(owner);
        return React.createElement(Editor, keyed ? { onSeen, key: owner } : { onSeen });
      };
      await act(() => { root2.render(React.createElement(Gate, { owner: A })); });
      await act(() => { root2.render(React.createElement(Gate, { owner: B })); });
      await act(() => root2.unmount());
      host2.remove();

      if (keyed) {
        expect(seen, "a keyed shell re-reads the mailbox it was remounted for").toEqual([
          "A's draft",
          "B's draft",
        ]);
      } else {
        expect(
          seen,
          "an unkeyed shell carried mailbox A's text into mailbox B — this is the case the key exists for",
        ).toEqual(["A's draft"]);
      }
    }
  });

  it("the child reads the mailbox the gate mounted, not the one before it", async () => {
    const seen: string[] = [];

    /** Stands in for `AppShell`: reads the scratch buffer in its own effect, exactly as it does. */
    function Shell({ mailbox }: { mailbox: string }) {
      React.useEffect(() => {
        seen.push(readComposeDraft().subject);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [mailbox]);
      return null;
    }

    /** Stands in for `DesktopGate`/`HostGate`: establishes the storage owner in render, above the shell. */
    function Gate({ mailbox }: { mailbox: string }) {
      setStorageOwner(mailbox);
      return React.createElement(Shell, { mailbox, key: mailbox });
    }

    setStorageOwner(A);
    writeComposeDraft({ ...EMPTY_COMPOSE, to: "a@example.com", subject: "A's draft", body: "x" });
    setStorageOwner(B);
    writeComposeDraft({ ...EMPTY_COMPOSE, to: "b@example.com", subject: "B's draft", body: "y" });
    resetStorageOwnerForTest();

    const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
    await act(() => {
      root.render(React.createElement(Gate, { mailbox: A }));
    });
    await act(() => {
      root.render(React.createElement(Gate, { mailbox: B }));
    });

    expect(seen, "each mount read its own mailbox's buffer").toEqual(["A's draft", "B's draft"]);
  });
});

/**
 * ═══ THE CENSUS — "did we get every door?", answered mechanically ══════════════════════════════
 *
 * The reported defect was one door. The shape is not: any surface that renders the shared
 * `AppShell` has to say whose storage partition it is using, and the failure mode is silence —
 * a new door that simply never calls `setStorageOwner` inherits `null` and collapses, with
 * nothing failing. So the doors are enumerated from the source rather than remembered.
 */
const ROOT = existsSync(resolve("apps/webapp/app")) ? resolve(".") : resolve("../..");

/**
 * Every module that mounts the shared shell, how it establishes its storage owner, and — where
 * the storage owner can CHANGE under a live window — the expression its shell is keyed by.
 *
 * `how` and `key` are matched as EXPRESSIONS, not as mentions. The first version of this census
 * asserted `src.includes("setStorageOwner")`, which the import line satisfies on its own, so
 * deleting the call left it green; the second asserted `/\bkey=\{/`, which `key={"fixed"}`
 * satisfies while the cross-mailbox leak is fully back. Both were caught by mutating the gates and
 * watching nothing happen, which is the only way that class of guard is ever caught.
 */
interface Door {
  file: string;
  /** The expression that establishes the storage owner. */
  call: RegExp;
  /**
   * The expression the shell is keyed by — REQUIRED where one window can serve more than one
   * owner, `null` where it structurally cannot. Keying is what makes the shell's own state (the
   * compose form) move with the partition; without it the storage is per-owner and the TEXT is
   * not.
   */
  key: RegExp | null;
}

const DOORS: readonly Door[] = [
  {
    // The hosted door. Its owner is the `tf_owner` cookie the API sets beside the session, read
    // by `storageOwner()` itself — the strongest identity available, and the one that outranks
    // any host-supplied value. No key: this window serves one account, and the cookie changes
    // only across a sign-in or sign-out, both of which are full navigations.
    file: "apps/webapp/app/(product)/mailbox/CloudShell.tsx",
    call: /resolveOwner|AppShell/,
    key: null,
  },
  {
    // The demo, and this row used to say "no account, so nothing per-account is stored". That was
    // the wrong reading: `demo` withholds every wire, and `storageOwner()` still answered the
    // VISITOR'S cookie — the landing embeds this page in an iframe on the same origin, so the
    // fixture composer read and overwrote their unsent message. Its partition is the demo's own now,
    // established in `EngineProvider` where the demo is resolved (both doors pass through it);
    // `demo-touches-nothing-the-product-owns.test.tsx` holds the partition.
    file: "apps/webapp/app/(product)/demo/page.tsx",
    call: /<AppShell demo/,
    key: null,
  },
  {
    file: "apps/desktop/src/DesktopGate.tsx",
    call: /setStorageOwner\(mount\.kind/,
    key: /key=\{shellKey\}/,
  },
  {
    file: "apps/desktop/src/host-client/HostGate.tsx",
    call: /setStorageOwner\(paired \? scope\b/,
    key: /key=\{scope\b/,
  },
];

/** Every file in the tree that mounts the shell — derived, never remembered. */
function mountsOfShell(): string[] {
  const roots = ["apps/webapp/app", "apps/desktop/src"];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(resolve(ROOT, dir)).sort()) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const rel = `${dir}/${name}`;
      const st = statSync(resolve(ROOT, rel));
      if (st.isDirectory()) walk(rel);
      else if (name.endsWith(".tsx") && readFileSync(resolve(ROOT, rel), "utf8").includes("<AppShell")) {
        found.push(rel);
      }
    }
  };
  for (const r of roots) walk(r);
  return found;
}

describe("every door that mounts the shared shell names its storage owner", () => {
  it("the census covers every mount in the tree — derived, not remembered", () => {
    const listed = new Set(DOORS.map((d) => d.file));
    const actual = mountsOfShell();
    expect(actual.length, "no mount of the shared shell was found at all — the walk is broken").toBeGreaterThan(0);
    for (const file of actual) {
      expect(
        listed.has(file),
        `${file} mounts AppShell and is not in the door census — a new door inherits no owner ` +
          "and silently shares one partition with every other",
      ).toBe(true);
    }
  });

  it("the enumerated doors each establish one", () => {
    for (const door of DOORS) {
      const src = readFileSync(resolve(ROOT, door.file), "utf8");
      expect(door.call.test(src), `${door.file} no longer establishes a storage owner`).toBe(true);
    }
  });

  /**
   * THE ORDERING, AS A STRUCTURAL FACT ABOUT THE GATES.
   *
   * The React case above proves that a parent setting the storage owner in RENDER is early enough for a
   * child's effect. What it cannot prove is that the two real gates do it in render — moving
   * either call into a `useEffect` would leave every other case here green while making the seam
   * useless, because a child's effects run first and the shell would read the previous mailbox's
   * key. A top-level statement in a function component is indented by exactly two spaces; the
   * same statement inside a `useEffect` body is indented further.
   */
  it("each gate establishes it as a top-level render statement, not from an effect", () => {
    for (const door of DOORS) {
      const src = readFileSync(resolve(ROOT, door.file), "utf8");
      if (!src.includes("setStorageOwner")) continue;
      expect(
        /^ {2}setStorageOwner\(/m.test(src),
        `${door.file} does not set the storage owner at the component's top level — an effect ` +
          "here runs AFTER the shell's own effect has already read the wrong key",
      ).toBe(true);
    }
  });

  /**
   * PARTITIONING THE STORAGE IS HALF OF IT — THE STATE HAS TO MOVE TOO.
   *
   * `ShellInner` holds the compose form in React state and loads the scratch buffer in a mount
   * effect with an empty dependency list. A gate that changes the storage owner and the engine but
   * returns the same element position leaves React free to preserve that component: the storage owner
   * moves to mailbox B while mailbox A's recipients, subject and body are still in state.
   *
   * The key must be the OWNER'S expression, not merely present: `key={"fixed"}` is a key, and it
   * restores the defect completely.
   */
  it("each door that can change owner keys its shell by that owner's own expression", () => {
    for (const door of DOORS) {
      if (door.key === null) continue;
      const src = readFileSync(resolve(ROOT, door.file), "utf8");
      const mount = src.indexOf("<AppShell");
      expect(mount, `${door.file} no longer mounts AppShell`).toBeGreaterThan(-1);
      expect(
        door.key.test(src.slice(mount, mount + 1600)),
        `${door.file} does not key AppShell by its storage owner — a change of owner would keep ` +
          "the previous mailbox's compose in state while the partition beneath it moved",
      ).toBe(true);
    }
  });

  /**
   * ENDING A PAIRING AND STARTING A NEW ONE ARE THE SAME DEPARTURE, and only one of them used to
   * sweep. The host door's `/pair` landing opens while still paired — that is what a fresh QR
   * scan is — so a browser can be moved from one computer to another without ever signing out.
   * Retiring the scope makes the old records unreachable; it does not make them gone, and three
   * of the five hold mail text.
   */
  /**
   * THE ENGINE IS THE THIRD THING THAT HAS TO MOVE, and it was the last to.
   *
   * The host client builds one `OhmailEngine` per pairing in a `useMemo`. Its dependencies were
   * `[paired, bearer]` — a boolean and one long-lived object, NEITHER of which changes when a
   * `/pair` redeem swaps the credential while the tab is already paired, which is a gesture the
   * gate explicitly supports. So the storage partition moved, the shell remounted, and the engine
   * kept the previous account's in-memory mirror and served it under the new account's session.
   * Two accounts' mail in one mirror — the exact cross-account failure this door's own header
   * cites as its reason for having no persistent mirror at all.
   *
   * The partition, the shell and the engine must all name the same identity or none of them does.
   */
  it("the host door rebuilds its engine on the pairing it is keyed and partitioned by", () => {
    const src = readFileSync(resolve(ROOT, "apps/desktop/src/host-client/HostGate.tsx"), "utf8");
    const deps = /\n\s*\[paired, bearer([^\]]*)\],/.exec(src);
    expect(deps, "the engine memo's dependency list is no longer where this can see it").not.toBeNull();
    expect(
      /\bscope\b/.test(deps![1] ?? ""),
      "the engine memo does not depend on the pairing scope — a fresh re-pair would keep the " +
        "previous account's mirror while the partition and the shell moved to the new one",
    ).toBe(true);
  });

  it("the host door sweeps its at-rest scratch on BOTH departures, not only on a dead session", () => {
    const src = readFileSync(resolve(ROOT, "apps/desktop/src/host-client/HostGate.tsx"), "utf8");
    const sweeps = src.match(/dropLocalStorageKeys\(HOST_SCRATCH_PREFIXES\)/g) ?? [];
    expect(
      sweeps.length,
      "the sweep runs on one path only — a fresh re-pairing leaves the previous pairing's " +
        "unfinished mail on the device",
    ).toBe(2);
    expect(/onSessionDead\([\s\S]{0,600}?dropLocalStorageKeys/.test(src), "the death path sweeps").toBe(true);
    expect(/onPaired=\{\(\) => \{[\s\S]{0,600}?dropLocalStorageKeys/.test(src), "the re-pair path sweeps").toBe(true);
  });

  it("no owner-keyed key builder resolves through the cookie alone", () => {
    const builders = [
      "apps/webapp/app/shell/compose.ts",
      "apps/webapp/app/shell/send-lock.ts",
      "apps/webapp/app/shell/screener-intents.ts",
    ];
    /**
     * The three surfaces that pass the storage owner IN rather than defaulting it. They were missing from
     * this list, and the behavioural case above cannot see them because it supplies the storage owner to
     * `searchSortKey` itself instead of rendering `SearchView` — so all three could regress to
     * `readOwner()` and go back to one shared key on both cookie-less doors with nothing red.
     */
    for (const file of [
      "apps/webapp/app/views/SearchView.tsx",
      "apps/webapp/app/components/ComposeAttach.tsx",
      "apps/webapp/app/shell/ImageQualityRow.tsx",
    ]) {
      const src = readFileSync(resolve(ROOT, file), "utf8");
      expect(
        /\breadOwner\(\)/.test(src),
        `${file} resolves its owner from the cookie alone, which is null on both cookie-less doors`,
      ).toBe(false);
      expect(src.includes("storageOwner()"), `${file} does not resolve through the seam`).toBe(true);
    }
    for (const file of builders) {
      const src = readFileSync(resolve(ROOT, file), "utf8");
      expect(
        /= readOwner\(\)\): string/.test(src),
        `${file} defaults its key owner to the cookie, which is null on two of the three doors`,
      ).toBe(false);
      expect(src.includes("storageOwner()"), `${file} does not resolve through the seam`).toBe(true);
    }
  });
});
