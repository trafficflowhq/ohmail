/**
 * THE WORDS DOOR: every write of a kept family to the page's `localStorage` is written natively
 * first, in the same call and with nothing awaited before the page's own write, so a kill between
 * a keystroke and the page's storage loses nothing the native copy did not already have. A removal
 * goes the same way, so the native copy is never older than the page's.
 *
 * At start, before anything is mounted, the kept families in the page's storage are made exactly the
 * native set: a value that differs is replaced by native's, and a kept key native lacks is removed (a
 * letter discarded before a kill does not come back). Native's set is the live scope's, the scope
 * native's `config` names. A kept key that names another scope is that scope's: it is left to that
 * scope's own next start, which judges it against its own keeper.
 *
 * A word the keeper refused (a full disk, a bound) is said through the product's durability notice.
 * Native remembers it for the scope, with a digest of what it was asked to keep, and names it at the
 * next start: the page's copy stays only when it is that very copy, and is offered again. Every
 * page of the origin can write this storage, so nothing in it decides what is kept: a copy that is
 * not the one native refused gives way to native's, and the word is said lost.
 */
import type { WordDigest } from "../../src/shell/bridge-kinds";
import { isKept, scopeNamedBy } from "../../src/shell/kept-families";
import { lost } from "./engine-package";

/** What the keeper's door is to the page: post a word now, not awaited; the answer comes later. */
export type KeepPost = (key: string, value: string | null) => Promise<boolean>;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  key(index: number): string | null;
  readonly length: number;
}

/**
 * Wraps the storage's own methods for `target` alone. `refused` is told when native refused a word,
 * after the notice is raised; the caller tells native's count.
 */
export function installKeptStorage(target: StorageLike, post: KeepPost, refused: () => void): KeptStorage {
  const proto = Object.getPrototypeOf(target) as StorageLike;
  const set = proto.setItem;
  const remove = proto.removeItem;
  const clear = proto.clear;
  const told = (p: Promise<boolean>): void => {
    void p.catch(() => false).then((kept) => {
      if (kept) return;
      lost("keeper");
      refused();
    });
  };

  proto.setItem = function setItem(this: StorageLike, key: string, value: string) {
    if (this === target && isKept(String(key))) told(post(String(key), String(value)));
    return set.call(this, key, value);
  };
  proto.removeItem = function removeItem(this: StorageLike, key: string) {
    if (this === target && isKept(String(key))) told(post(String(key), null));
    return remove.call(this, key);
  };
  proto.clear = function clearAll(this: StorageLike) {
    if (this === target) {
      for (const key of keysOf(this)) if (isKept(key)) told(post(key, null));
    }
    return clear.call(this);
  };
  return {
    restore() {
      proto.setItem = set;
      proto.removeItem = remove;
      proto.clear = clear;
    },
    /*
     * Makes the page's kept families exactly the native set, but for a refused word whose copy here is the one
     * native was asked to keep, and for a key that names another scope: neither removed, written nor offered here,
     * whether the page's storage or native's reading holds it. Written with the storage's own methods; then each
     * refused word is settled with one word to native: that copy offered again, or native's own, and native lets
     * the name go once it keeps it.
     */
    async adopt(words, refusedWords, scope) {
      const judged = (key: string): boolean => isKept(key) && !namesAnotherScope(key, scope);
      const native = new Map(words.filter(([key]) => judged(key)));
      const names = new Map<string, WordDigest>();
      for (const pair of Array.isArray(refusedWords) ? refusedWords : []) {
        const [key, digest] = Array.isArray(pair) ? pair : [];
        if (typeof key === "string" && judged(key) && (typeof digest === "string" || digest === null)) names.set(key, digest);
      }
      const held = new Map<string, string | null>();
      for (const [key, digest] of names) {
        const here = target.getItem(key);
        if (await isTheCopyRefused(here, digest)) held.set(key, here);
      }
      let replaced = 0;
      let removed = 0;
      for (const key of keysOf(target)) {
        if (judged(key) && !native.has(key) && !held.has(key)) {
          remove.call(target, key);
          removed += 1;
        }
      }
      for (const [key, value] of native) {
        if (!held.has(key) && target.getItem(key) !== value) {
          try {
            set.call(target, key, value);
            replaced += 1;
          } catch {
            // A full storage: native keeps the word, the page shows no older copy of it, and says so.
            if (target.getItem(key) !== null) {
              remove.call(target, key);
              removed += 1;
            }
            lost("keeper");
          }
        }
      }
      for (const key of names.keys()) {
        if (held.has(key)) {
          told(post(key, held.get(key) ?? null));
        } else {
          lost("keeper");
          told(post(key, native.get(key) ?? null));
        }
      }
      return { replaced, removed, offered: held.size };
    },
  };
}

export interface KeptStorage {
  restore(): void;
  /**
   * At start, before anything reads storage, with native's reading for the live scope (`kept`) and that scope as
   * native's `config` names it. Without a scope no key is left to another scope's start: every kept key is judged.
   */
  adopt(
    words: readonly (readonly [string, string])[],
    refused: readonly (readonly [string, WordDigest])[],
    scope?: string,
  ): Promise<{ replaced: number; removed: number; offered: number }>;
}

/** Does `key` name a scope other than the live one? The two families that name no owner never do. */
function namesAnotherScope(key: string, scope: string | undefined): boolean {
  const named = scope === undefined ? null : scopeNamedBy(key);
  return named !== null && named !== scope;
}

/** Is `here` the copy native refused: the same removal, or a word with the same digest. */
async function isTheCopyRefused(here: string | null, digest: WordDigest): Promise<boolean> {
  if (digest === null || here === null) return digest === null && here === null;
  try {
    return (await wordDigest(here)) === digest;
  } catch {
    return false;
  }
}

/** The bridge's {@link WordDigest}: SHA-256 over the UTF-16 code units, low byte first, as lowercase hex. */
async function wordDigest(word: string): Promise<string> {
  const units = new Uint8Array(word.length * 2);
  for (let i = 0; i < word.length; i += 1) {
    const unit = word.charCodeAt(i);
    units[2 * i] = unit & 0xff;
    units[2 * i + 1] = unit >>> 8;
  }
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", units));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

function keysOf(storage: StorageLike): string[] {
  const out: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key !== null) out.push(key);
  }
  return out;
}
