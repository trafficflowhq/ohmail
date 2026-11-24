/**
 * THE KEEPER, ON THE PAGE'S SIDE: no unsent word and no queued send depends on the web view's storage.
 * The words door writes natively first, in the same call as the page's own write; at start the
 * native set wins and a kept key native lacks is dropped. The queue's rows reach the keeper before
 * the page's copy, a refusal fails the write, and a page whose storage the system emptied comes back
 * with its queue. Every `localStorage` name of the registry is classed, kept or device.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IDBFactory, IDBKeyRange as FakeKeyRange } from "fake-indexeddb";
import { STORED_KEYS } from "../../../packages/client-engine/src/stored-keys";
import { OUTBOX_TYPE } from "@ohmail/client-engine";
import { durabilityLost, resetDurabilityForTest } from "@ohmail/client-engine/durable";
import { isCarriedLocalType as enginesOwn } from "../../../packages/client-engine/src/types";
import type { KeptRow } from "../src/shell/bridge-kinds";
import { DEVICE_UNDER_KEPT, KEPT_FAMILIES, isKept } from "../src/shell/kept-families";

/** The registry's other `localStorage` names, each classed a device's: the look, the layout, the session's own state. */
const DEVICE_KEYS = [
  "ohmail.calendar.display.",
  "ohmail.theme", "ohmail.face", "ohmail.face.scope", "ohmail.face.account", "ohmail.face.account.owner",
  "ohmail.faceOffer", "ohmail.layout",
  "ohmail.textSize", "ohmail.locale", "ohmail.ui.columns", "ohmail.ui.rail.tagsOpen", "ohmail.ui.rail.foldersOpen",
  "ohmail.ui.search.sort.", "ohmail.ui.rail.foldersOpened.", "ohmail.ui.mail.original.", "ohmail.ui.rail.foldersOpened",
  "ohmail.ui.mail.original", "ohmail.ui.reader.afterVerb", "ohmail.ui.reader.subject:", "ohmail.ui.readingAlong.", "ohmail.ui.compose",
  "ohmail.screener.impersonationSeen.", "ohmail.screener.unsubscribeSeen.", "ohmail.junkSweepDismissedAt", "ohmail.ui.seed.notNow.", "ohmail.access.",
  // The dismissed News or Receipts prompt stores a count for this account on this device.
  "ohmail.ui.pileNote.notNow.",
  "ohmail.lifecycle.", "ohmail.boot.", "ohmail.erased", "ohmail.signed-out", "ohmail.signed-out-reason.shared",
  "ohmail.session-changed", "ohmail.session.pendingSignOut", "ohmail.session.scopeCleanup.",
  "ohmail.revoke.owed.", "ohmail.session.mintedAt", "ohmail.session.refreshAttempt", "ohmail.session.lastAnswer",
  "ohmail.desktopCtaDismissed", "ohmail.updateAsked", "ohmail.notifications.channels", "ohmail.notices.calendar",
  "ohmail.notices.devices.told.", "ohmail.notifications.subscription",
  "ohmail.mirror.", "ohmail.desktop.cloudScope", "ohmail.desktop.cloudDisclosureOwner", "ohmail.window.sent-folders.", "ohmail.desktopDefaultMailAsked",
  "ohmail.diagnostics.install", "ohmail.first-run.ai", "ohmail.omarchy.palette", "ohmail.host.refreshToken",
  "ohmail.host.pairScope", "ohmail.host.refreshAttempt", "ohmail.host.refreshAttemptOwed", "ohmail.host.signOutsOwed",
];
import { isCarriedLocalType } from "../web/src/engine-package";
import { KeeperRefused, KeptIdbStore, type QueueKeeper } from "../web/src/kept-store";
import { installKeptStorage } from "../web/src/kept-storage";
import { createBridge, type Bridge } from "../web/src/bridge";
import { createPhoneEngine } from "../web/src/engine";
import type { PagePort } from "../web/src/port";
import type { ShellConfig } from "../src/shell/bridge-kinds";
import { takeOldCopy } from "../web/src/old-copy";

class FakeStorage {
  readonly map = new Map<string, string>();
  readonly log: string[] = [];
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.log.push(`page set ${k}`); this.map.set(k, v); }
  removeItem(k: string) { this.log.push(`page remove ${k}`); this.map.delete(k); }
  clear() { this.log.push("page clear"); this.map.clear(); }
}

describe("the classing of the page's storage names", () => {
  it("classes every localStorage name of the registry, and keeps every one that holds a person's words", () => {
    const rows = STORED_KEYS.filter((r) => r.store === "localStorage");
    const kept = new Set<string>(KEPT_FAMILIES);
    const device = new Set<string>([...DEVICE_KEYS, ...DEVICE_UNDER_KEPT]);
    for (const r of rows) {
      expect(kept.has(r.key) || device.has(r.key), `${r.key} has no class`).toBe(true);
      expect(kept.has(r.key) && device.has(r.key), `${r.key} has two`).toBe(false);
      if (r.words) expect(kept.has(r.key), `${r.key} holds words and is not kept`).toBe(true);
    }
    expect(isKept("ohmail.ui.compose.imageQuality")).toBe(false);
    expect(isKept("ohmail.ui.compose.p0:draft-1")).toBe(true);
    expect(isKept("ohmail.theme")).toBe(false);
  });

  it("carries the engine's own carried rows, no more and no fewer", () => {
    for (const type of [OUTBOX_TYPE, "outbox_abandoned", "routing_journal", "compose_letter", "compose_file", "message", "folder"]) {
      expect(isCarriedLocalType(type), type).toBe(enginesOwn(type));
    }
  });
});

describe("the words door", () => {
  it("writes a kept word natively first, in the same call as the page's own write", () => {
    const storage = new FakeStorage();
    const posted: string[] = [];
    const door = installKeptStorage(storage, (key, value) => {
      posted.push(`${key}=${value}`);
      storage.log.push(`native ${key}`);
      return Promise.resolve(true);
    }, () => {});
    try {
      storage.setItem("ohmail.ui.reply:p0:m1", "half a reply");
      expect(storage.log).toEqual(["native ohmail.ui.reply:p0:m1", "page set ohmail.ui.reply:p0:m1"]);
      storage.removeItem("ohmail.ui.reply:p0:m1");
      storage.setItem("ohmail.theme", "dark");
      expect(posted).toEqual(["ohmail.ui.reply:p0:m1=half a reply", "ohmail.ui.reply:p0:m1=null"]);
    } finally {
      door.restore();
    }
  });

  it("makes the page's kept words exactly the native set at start, and posts nothing back", async () => {
    const storage = new FakeStorage();
    storage.map.set("ohmail.ui.compose.p0:a", "half-flushed old words");
    storage.map.set("ohmail.ui.compose.p0:discarded", "a letter discarded before the kill");
    storage.map.set("ohmail.theme", "dark");
    const posted: string[] = [];
    const door = installKeptStorage(storage, (key) => (posted.push(key), Promise.resolve(true)), () => {});
    try {
      const said = await door.adopt([["ohmail.ui.compose.p0:a", "the newer words"], ["ohmail.send.locks.p0", "{\"k\":1}"]], []);
      expect(Object.fromEntries(storage.map)).toEqual({
        "ohmail.ui.compose.p0:a": "the newer words", "ohmail.send.locks.p0": "{\"k\":1}", "ohmail.theme": "dark",
      });
      expect(said).toEqual({ replaced: 2, removed: 1, offered: 0 });
      expect(posted).toEqual([]);
    } finally {
      door.restore();
    }
  });

  it("starts when native keeps a word this storage cannot hold: no older copy of it stays, and that is said", async () => {
    resetDurabilityForTest();
    /** The page's storage, full: it takes no word longer than ten letters. */
    class FullStorage extends FakeStorage {
      override setItem(k: string, v: string) {
        if (v.length > 10) throw new DOMException("the storage is full", "QuotaExceededError");
        super.setItem(k, v);
      }
    }
    const storage = new FullStorage();
    storage.map.set("ohmail.ui.compose.p0:a", "older");
    const posted: string[] = [];
    const door = installKeptStorage(storage, (key) => (posted.push(key), Promise.resolve(true)), () => {});
    try {
      const said = await door.adopt([["ohmail.ui.compose.p0:a", "a letter longer than the storage takes"], ["ohmail.send.locks.p0", "{}"]], []);
      expect(said).toEqual({ replaced: 1, removed: 1, offered: 0 });
      expect(storage.getItem("ohmail.ui.compose.p0:a")).toBeNull();
      expect(storage.getItem("ohmail.send.locks.p0")).toBe("{}");
      expect(durabilityLost()).toBe(true);
      expect(posted).toEqual([]);
    } finally {
      door.restore();
      resetDurabilityForTest();
    }
  });

  /** Native's answers settle after the page's own write, as the bridge's do. */
  const settled = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

  /** What native remembers of a word it refused: SHA-256 over the word's UTF-16 code units, low byte first; null for a removal. */
  const digestOf = (word: string | null) => (word === null ? null : createHash("sha256").update(Buffer.from(word, "utf16le")).digest("hex"));

  /**
   * The keeper as each mailbox's page meets it, one per scope: the scope is native's, never the page's word. A word
   * it refuses is remembered by name with the digest of what was asked, until a keep of that word lands; its `kept`
   * reading names the live scope's words and refusals alone.
   */
  function keeper() {
    const scopes = new Map<string, { words: Map<string, string>; refused: Map<string, string | null>; posted: string[] }>();
    const of = (scope: string) => {
      if (!scopes.has(scope)) scopes.set(scope, { words: new Map(), refused: new Map(), posted: [] });
      return scopes.get(scope)!;
    };
    let refusing = false;
    return {
      refuse(on: boolean) { refusing = on; },
      words: (scope: string) => of(scope).words,
      refused: (scope: string) => of(scope).refused,
      postsTo: (scope: string) => of(scope).posted,
      reading: (scope: string) => [[...of(scope).words], [...of(scope).refused]] as [[string, string][], [string, string | null][]],
      /** The words door of the page native shows for `scope`. */
      door(storage: FakeStorage, scope: string) {
        return installKeptStorage(storage, (key, value) => {
          const s = of(scope);
          s.posted.push(`${key}=${value}`);
          if (refusing) {
            s.refused.set(key, digestOf(value));
            return Promise.resolve(false);
          }
          if (value === null) s.words.delete(key);
          else s.words.set(key, value);
          s.refused.delete(key);
          return Promise.resolve(true);
        }, () => {});
      },
    };
  }

  it("says a word the keeper refused through the product's notice and to native", async () => {
    resetDurabilityForTest();
    const storage = new FakeStorage();
    const said: string[] = [];
    const door = installKeptStorage(storage, () => Promise.resolve(false), () => said.push("keeperRefused"));
    try {
      await door.adopt([], []);
      storage.setItem("ohmail.send.notes.p0", "x");
      await settled();
      expect(durabilityLost()).toBe(true);
      expect(said).toEqual(["keeperRefused"]);
    } finally {
      door.restore();
      resetDurabilityForTest();
    }
  });

  it("keeps a refused word the page's at the next start, offers it to native again, and lets its name go once kept", async () => {
    const storage = new FakeStorage();
    const native = keeper();
    native.words("p0").set("ohmail.ui.compose.p0:a", "kept before").set("ohmail.ui.compose.p0:gone", "discarded");
    const first = native.door(storage, "p0");
    await first.adopt(...native.reading("p0"));
    native.refuse(true);
    storage.setItem("ohmail.ui.compose.p0:a", "three paragraphs the keeper refused — Grüße 📨");
    storage.setItem("ohmail.ui.compose.p0:b", "a letter native never had");
    storage.removeItem("ohmail.ui.compose.p0:gone");
    await settled();
    first.restore();

    // The next start: native still holds its older words and the discarded letter, lacks the new one, and names the
    // three it refused. It keeps now.
    native.refuse(false);
    const posted = native.postsTo("p0");
    posted.length = 0;
    const next = native.door(storage, "p0");
    try {
      const said = await next.adopt(...native.reading("p0"));
      expect(said).toMatchObject({ replaced: 0, removed: 0, offered: 3 });
      expect(storage.getItem("ohmail.ui.compose.p0:a")).toBe("three paragraphs the keeper refused — Grüße 📨");
      expect(storage.getItem("ohmail.ui.compose.p0:b")).toBe("a letter native never had");
      expect(storage.getItem("ohmail.ui.compose.p0:gone")).toBeNull();
      expect(posted.sort()).toEqual([
        "ohmail.ui.compose.p0:a=three paragraphs the keeper refused — Grüße 📨", "ohmail.ui.compose.p0:b=a letter native never had",
        "ohmail.ui.compose.p0:gone=null",
      ]);
      await settled();
      // Kept: native lets the names go, and the start after that is the native set again.
      expect(native.reading("p0")[1]).toEqual([]);
      posted.length = 0;
      expect(await next.adopt([["ohmail.ui.compose.p0:a", "three paragraphs the keeper refused — Grüße 📨"]], [])).toEqual({ replaced: 0, removed: 1, offered: 0 });
      expect(storage.getItem("ohmail.ui.compose.p0:b")).toBeNull();
      expect(posted).toEqual([]);
    } finally {
      next.restore();
    }
  });

  it("keeps nothing a list of refused names in the page's own storage names, and offers none of it to the keeper", async () => {
    resetDurabilityForTest();
    const storage = new FakeStorage();
    const native = keeper();
    // A script of the origin, in another mailbox's page: that mailbox's letter, and a delete this one never pressed,
    // listed as this mailbox's refused words where the page once kept that list.
    storage.map.set("ohmail.ui.compose.pa:x", "the first mailbox's words");
    storage.map.set("ohmail.delete.intents.pb", "[\"planted\"]");
    storage.map.set("ohmail.shell.keeperRefused", JSON.stringify({ pb: ["ohmail.ui.compose.pa:x", "ohmail.delete.intents.pb"] }));
    const door = native.door(storage, "pb");
    try {
      expect(await door.adopt(...native.reading("pb"))).toEqual({ replaced: 0, removed: 2, offered: 0 });
      expect(storage.getItem("ohmail.ui.compose.pa:x")).toBeNull();
      expect(storage.getItem("ohmail.delete.intents.pb")).toBeNull();
      await settled();
      expect(native.postsTo("pb")).toEqual([]);
      expect([...native.words("pb")]).toEqual([]);
      expect(durabilityLost()).toBe(false);
    } finally {
      door.restore();
      resetDurabilityForTest();
    }
  });

  it("gives a copy another page wrote under a refused word way to native's, offers it to no keeper, and says the word lost", async () => {
    resetDurabilityForTest();
    const storage = new FakeStorage();
    const native = keeper();
    native.words("pb").set("ohmail.ui.compose.pb:d", "the letter as native kept it");
    // This mailbox's keeper refused its newer letter and a delete it pressed; another page then wrote over both.
    native.refused("pb").set("ohmail.ui.compose.pb:d", digestOf("the newer letter")).set("ohmail.delete.intents.pb", digestOf("[\"pressed\"]"));
    storage.map.set("ohmail.ui.compose.pb:d", "a letter another page wrote");
    storage.map.set("ohmail.delete.intents.pb", "[\"planted\"]");
    const door = native.door(storage, "pb");
    try {
      expect(await door.adopt(...native.reading("pb"))).toEqual({ replaced: 1, removed: 1, offered: 0 });
      expect(storage.getItem("ohmail.ui.compose.pb:d")).toBe("the letter as native kept it");
      expect(storage.getItem("ohmail.delete.intents.pb")).toBeNull();
      expect(durabilityLost()).toBe(true);
      await settled();
      // Native is told its own words back, and lets the names go: what the other page wrote reaches no keeper.
      expect(native.postsTo("pb").sort()).toEqual(["ohmail.delete.intents.pb=null", "ohmail.ui.compose.pb:d=the letter as native kept it"]);
      expect(native.reading("pb")).toEqual([[["ohmail.ui.compose.pb:d", "the letter as native kept it"]], []]);
    } finally {
      door.restore();
      resetDurabilityForTest();
    }
  });

  it("never offers another mailbox's refused word to this mailbox's keeper, and its own next start says it lost when its copy went", async () => {
    resetDurabilityForTest();
    const storage = new FakeStorage();
    const native = keeper();
    const first = native.door(storage, "pa");
    await first.adopt(...native.reading("pa"));
    native.refuse(true);
    storage.setItem("ohmail.ui.compose.pa:x", "the first mailbox's words");
    await settled();
    first.restore();
    native.refuse(false);
    resetDurabilityForTest();

    // This mailbox's start keeps only what native names for it.
    const other = native.door(storage, "pb");
    try {
      expect(await other.adopt(...native.reading("pb"))).toEqual({ replaced: 0, removed: 1, offered: 0 });
      expect(storage.getItem("ohmail.ui.compose.pa:x")).toBeNull();
      await settled();
      expect(native.postsTo("pb")).toEqual([]);
      expect(durabilityLost()).toBe(false);
    } finally {
      other.restore();
    }

    // The first mailbox again: its copy is gone, so the word it could not keep is said lost and its name settled.
    const again = native.door(storage, "pa");
    try {
      expect(await again.adopt(...native.reading("pa"))).toEqual({ replaced: 0, removed: 0, offered: 0 });
      expect(durabilityLost()).toBe(true);
      await settled();
      expect(native.postsTo("pa").at(-1)).toBe("ohmail.ui.compose.pa:x=null");
      expect(native.reading("pa")).toEqual([[], []]);
    } finally {
      again.restore();
      resetDurabilityForTest();
    }
  });

  /** Two mailboxes' scopes as native mints them: `p` and 32 hex digits. */
  const PA = `p${"a".repeat(32)}`;
  const PB = `p${"b".repeat(32)}`;

  it("leaves another mailbox's refused words alone, and never offers them to this mailbox's keeper", async () => {
    const storage = new FakeStorage();
    const first = installKeptStorage(storage, () => Promise.resolve(false), () => {});
    await first.adopt([], [], PA);
    storage.setItem(`ohmail.ui.compose.${PA}:x`, "the first mailbox's words");
    await settled();
    first.restore();
    const posted: string[] = [];
    const other = installKeptStorage(storage, (key) => (posted.push(key), Promise.resolve(true)), () => {});
    try {
      await other.adopt([], [], PB);
      expect(storage.getItem(`ohmail.ui.compose.${PA}:x`)).toBe("the first mailbox's words");
      expect(posted).toEqual([]);
    } finally {
      other.restore();
      resetDurabilityForTest();
    }
  });

  /**
   * A kept key that names another scope (an owned family's prefix, that scope, then the key's end, a `.` or a `:`) is
   * that scope's: a start leaves it to that scope's own next start, which judges it against its own keeper. Every
   * other kept key is judged at every start, a key of the two families that name no owner always.
   */
  describe("a key that names another mailbox's scope", () => {
    it("keeps a mailbox's refused word through another mailbox's start, and its own next start keeps and offers it", async () => {
      resetDurabilityForTest();
      const storage = new FakeStorage();
      const native = keeper();
      const letter = `ohmail.ui.compose.${PA}.c1`;
      const first = native.door(storage, PA);
      await first.adopt(...native.reading(PA), PA);
      native.refuse(true);
      storage.setItem(letter, "three paragraphs the first mailbox's keeper refused");
      await settled();
      first.restore();
      native.refuse(false);
      resetDurabilityForTest();

      const other = native.door(storage, PB);
      try {
        expect(await other.adopt(...native.reading(PB), PB)).toEqual({ replaced: 0, removed: 0, offered: 0 });
        await settled();
        expect(storage.getItem(letter)).toBe("three paragraphs the first mailbox's keeper refused");
        expect(native.postsTo(PB)).toEqual([]);
        expect(durabilityLost()).toBe(false);
      } finally {
        other.restore();
      }

      const again = native.door(storage, PA);
      try {
        expect(await again.adopt(...native.reading(PA), PA)).toEqual({ replaced: 0, removed: 0, offered: 1 });
        await settled();
        expect(native.reading(PA)).toEqual([[[letter, "three paragraphs the first mailbox's keeper refused"]], []]);
        expect(durabilityLost()).toBe(false);
      } finally {
        again.restore();
        resetDurabilityForTest();
      }
    });

    it("leaves keys planted under another mailbox's name to that mailbox's start, which removes them all and tells its keeper nothing", async () => {
      resetDurabilityForTest();
      const storage = new FakeStorage();
      const native = keeper();
      // A script in the first mailbox's page names the second: in the storage alone, and through its own keeper, kept
      // and refused (the refusal's digest is of its choosing).
      const planted = [`ohmail.delete.intents.${PB}`, `ohmail.routing.intents.${PB}`, `ohmail.screener.intents.${PB}`];
      const first = native.door(storage, PA);
      await first.adopt(...native.reading(PA), PA);
      storage.map.set(planted[0], "[\"planted\"]");
      storage.setItem(planted[1], "[\"planted\"]");
      native.refuse(true);
      storage.setItem(planted[2], "[\"planted\"]");
      await settled();
      first.restore();
      native.refuse(false);
      expect([native.words(PA).has(planted[1]), native.refused(PA).has(planted[2])]).toEqual([true, true]);
      resetDurabilityForTest();
      native.postsTo(PA).length = 0;

      for (let start = 0; start < 2; start += 1) {
        const again = native.door(storage, PA);
        try {
          expect(await again.adopt(...native.reading(PA), PA)).toEqual({ replaced: 0, removed: 0, offered: 0 });
          await settled();
        } finally {
          again.restore();
        }
      }
      expect(planted.map((key) => storage.getItem(key))).toEqual(planted.map(() => "[\"planted\"]"));

      const owner = native.door(storage, PB);
      try {
        expect(await owner.adopt(...native.reading(PB), PB)).toEqual({ replaced: 0, removed: 3, offered: 0 });
        await settled();
        expect(planted.map((key) => storage.getItem(key))).toEqual([null, null, null]);
        expect(native.postsTo(PB)).toEqual([]);
        expect(native.reading(PB)).toEqual([[], []]);
      } finally {
        owner.restore();
      }

      // The first mailbox's next start writes none of them back, and tells its own keeper nothing of them.
      const last = native.door(storage, PA);
      try {
        expect(await last.adopt(...native.reading(PA), PA)).toEqual({ replaced: 0, removed: 0, offered: 0 });
        await settled();
        expect(planted.map((key) => storage.getItem(key))).toEqual([null, null, null]);
        expect(native.postsTo(PA)).toEqual([]);
        expect(durabilityLost()).toBe(false);
      } finally {
        last.restore();
        resetDurabilityForTest();
      }
    });

    it("gives copies another page wrote over a mailbox's refused and kept words way to native's at that mailbox's start, and says the loss", async () => {
      resetDurabilityForTest();
      const storage = new FakeStorage();
      const native = keeper();
      const letter = `ohmail.ui.compose.${PB}.c1`;
      const pressed = `ohmail.delete.intents.${PB}`;
      const owner = native.door(storage, PB);
      await owner.adopt(...native.reading(PB), PB);
      storage.setItem(letter, "the second mailbox's kept letter");
      native.refuse(true);
      storage.setItem(pressed, "[\"pressed, refused\"]");
      await settled();
      owner.restore();
      native.refuse(false);
      resetDurabilityForTest();

      // The first mailbox's start leaves both copies; a script in its page then writes over them.
      const first = native.door(storage, PA);
      await first.adopt(...native.reading(PA), PA);
      expect([storage.getItem(letter), storage.getItem(pressed)]).toEqual(["the second mailbox's kept letter", "[\"pressed, refused\"]"]);
      storage.map.set(letter, "written over");
      storage.map.set(pressed, "[\"planted\"]");
      first.restore();
      native.postsTo(PB).length = 0;

      const again = native.door(storage, PB);
      try {
        expect(await again.adopt(...native.reading(PB), PB)).toEqual({ replaced: 1, removed: 1, offered: 0 });
        expect([storage.getItem(letter), storage.getItem(pressed)]).toEqual(["the second mailbox's kept letter", null]);
        expect(durabilityLost()).toBe(true);
        await settled();
        expect(native.postsTo(PB)).toEqual([`${pressed}=null`]);
        expect(native.reading(PB)).toEqual([[[letter, "the second mailbox's kept letter"]], []]);
      } finally {
        again.restore();
        resetDurabilityForTest();
      }
    });

    it("never leaves a key of the two families that name no owner, nor one that names no scope", async () => {
      const storage = new FakeStorage();
      const native = keeper();
      const planted = [
        "ohmail.ui.reply:m1", "ohmail.ui.replymeta:m1", `ohmail.ui.reply:${PB}:m1`, `ohmail.ui.replymeta:${PB}:m1`,
        "ohmail.delete.intents.anon", "ohmail.send.locks.local", `ohmail.ui.compose.x.${PB}`, `ohmail.ui.compose.${PA}.c9`,
      ];
      for (const key of planted) storage.map.set(key, "planted");
      const door = native.door(storage, PA);
      try {
        expect(await door.adopt(...native.reading(PA), PA)).toEqual({ replaced: 0, removed: planted.length, offered: 0 });
        expect(storage.map.size).toBe(0);
        await settled();
        expect(native.postsTo(PA)).toEqual([]);
      } finally {
        door.restore();
      }
    });

    for (const [shape, key] of [
      ["ends there", `ohmail.delete.intents.${PB}`],
      ["goes on after a dot", `ohmail.ui.compose.${PB}.c1`],
      ["goes on after a colon", `ohmail.ui.reply.${PB}:m1`],
    ] as const) {
      it(`leaves a key that names another scope and ${shape} to that scope's start: neither removed, written nor offered here`, async () => {
        resetDurabilityForTest();
        const storage = new FakeStorage();
        const native = keeper();
        storage.map.set(key, "the second mailbox's copy");
        // This mailbox's keeper names the key as a word and as a refusal of that very copy: a script in its page asked.
        native.words(PA).set(key, "a word under the second mailbox's name");
        native.refused(PA).set(key, digestOf("the second mailbox's copy"));
        const here = native.door(storage, PA);
        try {
          expect(await here.adopt(...native.reading(PA), PA)).toEqual({ replaced: 0, removed: 0, offered: 0 });
          await settled();
          expect(storage.getItem(key)).toBe("the second mailbox's copy");
          expect(native.postsTo(PA)).toEqual([]);
          expect(durabilityLost()).toBe(false);
        } finally {
          here.restore();
        }
        const owner = native.door(storage, PB);
        try {
          expect(await owner.adopt(...native.reading(PB), PB)).toEqual({ replaced: 0, removed: 1, offered: 0 });
          expect(storage.getItem(key)).toBeNull();
          await settled();
          expect(native.postsTo(PB)).toEqual([]);
        } finally {
          owner.restore();
          resetDurabilityForTest();
        }
      });
    }

    for (const [shape, keys] of [
      ["31 hex digits", [`ohmail.delete.intents.p${"b".repeat(31)}`, `ohmail.ui.compose.p${"b".repeat(31)}.c1`]],
      ["a capital", [`ohmail.delete.intents.P${"b".repeat(32)}`, `ohmail.ui.compose.p${"B".repeat(32)}.c1`]],
      ["another prefix", [`ohmail.ui.reply:${PB}:m1`, `ohmail.ui.replymeta:${PB}`, `ohmail.ui.compose.x.${PB}`]],
    ] as const) {
      it(`judges a key that only looks like another scope's (${shape}) as every start does`, async () => {
        const storage = new FakeStorage();
        const native = keeper();
        for (const key of keys) storage.map.set(key, "planted");
        // This mailbox's keeper holds the first of them: its word wins. It lacks the rest, and they go.
        native.words(PA).set(keys[0], "this mailbox's word");
        const door = native.door(storage, PA);
        try {
          expect(await door.adopt(...native.reading(PA), PA)).toEqual({ replaced: 1, removed: keys.length - 1, offered: 0 });
          expect(keys.map((key) => storage.getItem(key))).toEqual(keys.map((_, i) => (i === 0 ? "this mailbox's word" : null)));
          await settled();
          expect(native.postsTo(PA)).toEqual([]);
        } finally {
          door.restore();
        }
      });
    }
  });
});

describe("the queue, kept natively", () => {
  function keeperDouble(answer = true) {
    const rows = new Map<string, KeptRow>();
    const keeper: QueueKeeper & { rows(): Promise<KeptRow[]>; writes: number } = {
      writes: 0,
      rows: async () => [...rows.values()],
      write: async (puts, deletes) => {
        keeper.writes += 1;
        if (!answer) return false;
        for (const [type, id] of deletes) rows.delete(`${type}:${id}`);
        for (const r of puts) rows.set(`${r.type}:${r.id}`, r);
        return true;
      },
    };
    return { keeper, rows };
  }
  const send = { kind: "message_send", key: "send-1", draftId: "d1" };

  it("comes back with its queue when the web view's storage is gone and the keeper is not", async () => {
    const { keeper, rows } = keeperDouble();
    const before = new KeptIdbStore({ owner: "p0", factory: new IDBFactory() }, keeper);
    await before.load();
    await before.commitLocal([{ type: OUTBOX_TYPE, id: "send-1", entity: send }], []);
    expect([...rows.keys()]).toEqual(["outbox_entry:send-1"]);

    // The system emptied the web view's storage: a new, empty database under the same scope.
    const after = new KeptIdbStore({ owner: "p0", factory: new IDBFactory() }, keeper);
    await after.load();
    expect(after.entries(OUTBOX_TYPE).map((e) => e.id)).toEqual(["send-1"]);
    expect(after.entries(OUTBOX_TYPE)[0]?.entity).toEqual(send);
  });

  it("refuses a queue write the keeper refused, and the page's copy does not hold it", async () => {
    const factory = new IDBFactory();
    const { keeper } = keeperDouble(false);
    const store = new KeptIdbStore({ owner: "p0", factory }, keeper);
    await store.load();
    await expect(store.commitLocal([{ type: OUTBOX_TYPE, id: "send-1", entity: send }], [])).rejects.toBeInstanceOf(KeeperRefused);
    const reread = new KeptIdbStore({ owner: "p0", factory }, keeperDouble().keeper);
    await reread.load();
    expect(reread.entries(OUTBOX_TYPE)).toEqual([]);
  });

  it("drops a carried row the keeper no longer holds, and the native row wins where the two differ", async () => {
    const factory = new IDBFactory();
    const { keeper, rows } = keeperDouble();
    const store = new KeptIdbStore({ owner: "p0", factory }, keeper);
    await store.load();
    await store.commitLocal([
      { type: OUTBOX_TYPE, id: "send-1", entity: send }, { type: OUTBOX_TYPE, id: "send-2", entity: { ...send, key: "send-2" } },
    ], []);
    rows.delete("outbox_entry:send-2");
    const newer = { ...JSON.parse(rows.get("outbox_entry:send-1")!.json), entity: { ...send, draftId: "d9" } };
    rows.set("outbox_entry:send-1", { type: OUTBOX_TYPE, id: "send-1", json: JSON.stringify(newer) });
    const again = new KeptIdbStore({ owner: "p0", factory }, keeper);
    await again.load();
    expect(again.entries(OUTBOX_TYPE).map((e) => [e.id, (e.entity as { draftId: string }).draftId])).toEqual([["send-1", "d9"]]);
  });

  /**
   * The page's engine as the shell composes it, in a web view: it has Web Locks, which node lacks. A verb is
   * queued offline and kept natively; the page's process then ends, and the next page meets the keeper and a
   * copy of the page's own that may differ from it. Native wins, at the engine and not only in the store.
   */
  function webView() {
    (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange ??= FakeKeyRange;
    const held = new Set<string>();
    Object.defineProperty(globalThis.navigator, "locks", {
      configurable: true,
      value: {
        request: async (name: string, _o: unknown, cb: (lock: unknown) => Promise<unknown>) => (held.add(name), cb({ name })),
        query: async () => ({ held: [...held].map((name) => ({ name })) }),
      },
    });
    const net = { online: false };
    const delivered: string[] = [];
    const port = (): PagePort => {
      let take: ((t: string) => void) | null = null;
      return {
        post(text) {
          const m = JSON.parse(text) as { id: number; epoch: string; kind: string; method?: string; path?: string; headers?: [string, string][] };
          if (m.kind !== "http") return;
          const json = (text: string) => ({ ok: true, status: 200, headers: [["content-type", "application/json"]], body: { as: "text", text } });
          const answer = !net.online ? { ok: false, refused: "unreachable" }
            : m.method === "PATCH" && m.path === "/messages"
              ? (delivered.push(m.headers?.find(([k]) => k === "idempotency-key")?.[1] ?? "none"), json("{}"))
              : json(JSON.stringify({ changes: { creates: [], updates: [], deletes: [], moves: [] }, next: "1", hasMore: false }));
          queueMicrotask(() => take?.(JSON.stringify({ ...answer, id: m.id, epoch: m.epoch })));
        },
        listen(t) { take = t; return () => { take = null; }; },
      };
    };
    const config = { scope: "p0", accountId: "acct-1", setting: "standalone" } as ShellConfig;
    const { keeper, rows } = keeperDouble();
    const open = async (factory: IDBFactory) => {
      const store = new KeptIdbStore({ owner: "p0", factory }, keeper);
      const { engine } = createPhoneEngine(config, createBridge(port(), crypto.randomUUID()), store);
      await engine.start().catch(() => undefined);
      return { engine, store };
    };
    return {
      net, delivered, rows, open,
      /** The page's process ended: its locks go with it. */
      end(page: Awaited<ReturnType<typeof open>>) {
        page.engine.dispose();
        page.store.close();
        held.clear();
      },
      async settle(page: Awaited<ReturnType<typeof open>>) {
        for (let i = 0; i < 4; i += 1) {
          await page.engine.syncOnce().catch(() => undefined);
          await page.engine.flushPending().catch(() => undefined);
        }
      },
      restore: () => { delete (globalThis.navigator as { locks?: unknown }).locks; },
    };
  }

  it("delivers a queued verb once when only the keeper holds it, in a web view with Web Locks", async () => {
    const view = webView();
    try {
      const before = await view.open(new IDBFactory());
      expect((await before.engine.mutate({ kind: "mark_seen", messageIds: ["m-1"], unread: false })).status).toBe("queued");
      expect([...view.rows.keys()].filter((k) => k.startsWith(OUTBOX_TYPE))).toHaveLength(1);
      view.end(before);
      // The system emptied the web view's storage; the keeper's file stayed. The connection is back.
      view.net.online = true;
      const after = await view.open(new IDBFactory());
      await view.settle(after);
      expect(view.delivered).toHaveLength(1);
      view.end(after);
    } finally {
      view.restore();
    }
  });

  it("does not deliver a queued verb whose removal reached the keeper while the page's copy still holds it", async () => {
    const view = webView();
    try {
      const factory = new IDBFactory();
      const before = await view.open(factory);
      expect((await before.engine.mutate({ kind: "mark_seen", messageIds: ["m-1"], unread: false })).status).toBe("queued");
      view.end(before);
      view.rows.clear();
      view.net.online = true;
      const after = await view.open(factory);
      await view.settle(after);
      expect(view.delivered).toEqual([]);
      view.end(after);
    } finally {
      view.restore();
    }
  });
});

describe("the old copy, taken once by the page", () => {
  const SCOPE = "p0123456789abcdef0123456789abcdef";
  const rec = (type: string, id: string, entity: object = {}) => ({ type, id, json: JSON.stringify({ type, id, seq: 1, entity }) });
  const PAGES = [
    { entities: [rec("message", "m1"), rec("message", "m2")], meta: [["cursor", JSON.stringify("c-9")], ["lastDrainAt", JSON.stringify("t")]] as [string, string][], next: "message:m2" },
    { entities: [rec("message", "m3"), rec(OUTBOX_TYPE, "o1"), rec("routing_journal", "ohmail.delete.intents.local", { value: "[1]" })], meta: [], next: "outbox_entry:o1" },
    { entities: [rec("routing_journal", "ohmail.ui.theme.local", { value: "dark" }), rec("message", "m4")], meta: [], next: null },
  ] as const;

  /** The page's store as the copy sees it: what it holds survives a cut (it was persisted), the cursor too. */
  function pageStore(cursor = "0") {
    const held = new Map<string, unknown>();
    const adopted: { keys: string[]; cursor: string | null; meta: [string, unknown][] }[] = [];
    let at = cursor;
    return {
      held, adopted,
      store: {
        get: (type: string, id: string) => held.get(`${type}:${id}`),
        getCursor: () => at,
        adopt: async (records: { type: string; id: string }[], c: string | null, meta: [string, unknown][]) => {
          adopted.push({ keys: records.map((r) => `${r.type}:${r.id}`), cursor: c, meta });
          for (const r of records) held.set(`${r.type}:${r.id}`, r);
          if (c !== null) at = c;
        },
      } as unknown as Parameters<typeof takeOldCopy>[2],
    };
  }

  /** Native as the page meets it: the copy's pages, the keeper, the closing word; optionally cut at one page. */
  function native(cutAt: number | null = null) {
    const said: string[] = [];
    const bridge = {
      request: async (kind: string, ask: Record<string, unknown>) => {
        if (kind === "oldCopy.page") {
          const index = ask.after === null ? 0 : PAGES.findIndex((p, i) => i > 0 && PAGES[i - 1]!.next === ask.after);
          if (index === cutAt) throw new Error("the web view's process ended");
          said.push(`page ${index}`);
          return PAGES[index];
        }
        said.push(kind === "keep" ? `keep ${String(ask.key)}` : kind);
        return kind === "keep" ? { kept: true } : {};
      },
    } as unknown as Bridge;
    return { bridge, said };
  }

  it("fills only what the page's copy lacks, and takes the cursor and the meta last, on a first copy only", async () => {
    const page = pageStore();
    page.held.set("message:m2", { mine: true });
    const storage = new FakeStorage();
    const { bridge, said } = native();
    await takeOldCopy(bridge, SCOPE, page.store, storage);
    expect(page.adopted.flatMap((a) => a.keys)).toEqual(["message:m1", "message:m3", `${OUTBOX_TYPE}:o1`, "message:m4"]);
    expect(page.adopted.at(-1)).toEqual({ keys: [], cursor: "c-9", meta: [["lastDrainAt", "t"]] });
    expect(page.held.get("message:m2")).toEqual({ mine: true });
    // The held press is kept natively under the scope, then written to the page's own storage; the phone's other
    // `local` rows are not a person's words and are not taken. Native is told last.
    expect(storage.map.get(`ohmail.delete.intents.${SCOPE}`)).toBe("[1]");
    expect([...storage.map.keys()]).toEqual([`ohmail.delete.intents.${SCOPE}`]);
    expect(said.slice(-2)).toEqual([`keep ohmail.delete.intents.${SCOPE}`, "oldCopy.done"]);

    const later = pageStore("c-1");
    await takeOldCopy(native().bridge, SCOPE, later.store, new FakeStorage());
    expect(later.adopted.every((a) => a.cursor === null && a.meta.length === 0)).toBe(true);
  });

  it("lands in the page's own store: a store opened afterwards reads the rows, the cursor and the meta, the queue kept natively", async () => {
    const kept = new Map<string, KeptRow>();
    const keeper: QueueKeeper = {
      rows: async () => [...kept.values()],
      write: async (puts, deletes) => {
        for (const [type, id] of deletes) kept.delete(`${type}:${id}`);
        for (const r of puts) kept.set(`${r.type}:${r.id}`, r);
        return true;
      },
    };
    const factory = new IDBFactory();
    const first = new KeptIdbStore({ owner: SCOPE, factory }, keeper);
    await first.load();
    await takeOldCopy(native().bridge, SCOPE, first, new FakeStorage());
    first.close();
    const opened = new KeptIdbStore({ owner: SCOPE, factory }, keeper);
    await opened.load();
    expect(["m1", "m2", "m3", "m4"].map((id) => opened.get("message", id) !== undefined)).toEqual([true, true, true, true]);
    expect(opened.entries(OUTBOX_TYPE).map((e) => e.id)).toEqual(["o1"]);
    expect([...kept.keys()]).toEqual([`${OUTBOX_TYPE}:o1`]);
    expect(opened.getCursor()).toBe("c-9");
    expect(opened.getMeta("lastDrainAt")).toBe("t");
  });

  it("a copy cut off after two pages runs again without a row twice, and claims the cursor only when whole", async () => {
    const page = pageStore();
    const cut = native(2);
    await expect(takeOldCopy(cut.bridge, SCOPE, page.store, new FakeStorage())).rejects.toThrow(/process ended/);
    expect(page.store.getCursor()).toBe("0");
    expect(cut.said).not.toContain("oldCopy.done");
    await takeOldCopy(native().bridge, SCOPE, page.store, new FakeStorage());
    const keys = page.adopted.flatMap((a) => a.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(page.store.getCursor()).toBe("c-9");
  });
});
