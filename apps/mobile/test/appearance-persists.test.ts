/**
 * THE APPEARANCE THIS PHONE KEEPS — both axes or neither, and the ordering that decides what a
 * relaunch shows.
 *
 * Before this the scheme returned to Auto and the face pin was dropped on every launch, which
 * made the phone the one ohmail surface where a choice did not survive closing the app. The
 * store's own header says persisting the scheme without the face is the incoherence somebody
 * would report, so this file's first claim is that ONE record carries both.
 *
 * There is no React Native renderer in this workspace, so the ordering lives in a plain module
 * and is driven here directly rather than through a mounted provider.
 *
 * MUTATIONS RUN AND RESTORED (each named at its test):
 *  · `boot` publishing without the `chosen` guard → the press-beats-the-read test goes red;
 *  · `setTheme` persisting `{themePref}` alone instead of the live record → the pair test reds;
 *  · `publish` ignoring `dropped` → the disposed test goes red;
 *  · `decodeAppearance` returning the parsed object unchecked → the junk-halves test reds.
 */
import { describe, expect, it } from "vitest";
import {
  APPEARANCE_KEY,
  appearanceStore,
  decodeAppearance,
  encodeAppearance,
  type StoredAppearance,
} from "../src/state/appearance-store";
import type { SecureKV } from "../src/state/servers";

/** A keystore that answers when told to, so a boot read can be held open across a press. */
function heldKV(): { kv: SecureKV; answer: (raw: string | null) => void; written: string[] } {
  const written: string[] = [];
  let release: (v: string | null) => void = () => {};
  const pending = new Promise<string | null>((resolve) => {
    release = resolve;
  });
  return {
    written,
    answer: (raw) => release(raw),
    kv: {
      get: () => pending,
      set: async (_key, value) => {
        written.push(value);
      },
      remove: async () => {},
    },
  };
}

function memoryKV(seed: string | null = null): { kv: SecureKV; rows: Map<string, string> } {
  const rows = new Map<string, string>();
  if (seed !== null) rows.set(APPEARANCE_KEY, seed);
  return {
    rows,
    kv: {
      get: async (key) => rows.get(key) ?? null,
      set: async (key, value) => {
        rows.set(key, value);
      },
      remove: async (key) => {
        rows.delete(key);
      },
    },
  };
}

const last = <T,>(xs: T[]): T => xs[xs.length - 1]!;

describe("the record", () => {
  it("round-trips both axes together", () => {
    const row: StoredAppearance = { themePref: "dark", facePin: "ohmarchy" };
    expect(decodeAppearance(encodeAppearance(row))).toEqual(row);
  });

  it("junk is no row; junk HALVES fall back to what the phone would have shown", () => {
    expect(decodeAppearance(null)).toBeNull();
    expect(decodeAppearance("not json")).toBeNull();
    expect(decodeAppearance("42")).toBeNull();
    expect(decodeAppearance('{"themePref":"chartreuse","facePin":"lace"}')).toEqual({
      themePref: "system",
      facePin: null,
    });
  });
});

describe("what a relaunch shows", () => {
  it("keeps an intentionally pinned device look with its scope across a relaunch", async () => {
    const { kv } = memoryKV();
    const store = appearanceStore(kv, () => {});
    store.setFacePin("ohmarchy", true);
    store.setTheme("dark");
    const read: StoredAppearance[] = [];
    await appearanceStore(kv, (next) => read.push(next)).boot();
    expect(last(read)).toEqual({ themePref: "dark", facePin: "ohmarchy", faceOnlyHere: true });
  });

  it("a stored appearance comes back — the scheme AND the pin", async () => {
    const seen: StoredAppearance[] = [];
    const { kv } = memoryKV(encodeAppearance({ themePref: "dark", facePin: "ohmarchy" }));
    const store = appearanceStore(kv, (next) => seen.push(next));
    await store.boot();
    expect(last(seen)).toEqual({ themePref: "dark", facePin: "ohmarchy" });
  });

  it("every write carries BOTH axes, so they cannot drift apart", async () => {
    const { kv, rows } = memoryKV();
    const store = appearanceStore(kv, () => {});
    await store.boot();

    store.setTheme("light");
    expect(decodeAppearance(rows.get(APPEARANCE_KEY) ?? null)).toEqual({
      themePref: "light",
      facePin: null,
    });

    /* The face press must not overwrite the scheme with a stale copy of it. */
    store.setFacePin("ohmarchy");
    expect(decodeAppearance(rows.get(APPEARANCE_KEY) ?? null)).toEqual({
      themePref: "light",
      facePin: "ohmarchy",
    });
  });

  it("a press that beats the boot read wins — the stored value is not published over it", async () => {
    const seen: StoredAppearance[] = [];
    const { kv, answer } = heldKV();
    const store = appearanceStore(kv, (next) => seen.push(next));
    const booting = store.boot();

    store.setTheme("light");
    /* The keystore answers a moment later with the PREVIOUS launch's choice. */
    answer(encodeAppearance({ themePref: "dark", facePin: "ohmarchy" }));
    await booting;

    expect(last(seen)).toEqual({ themePref: "light", facePin: null });
  });

  it("a store handed back publishes nothing more", async () => {
    const seen: StoredAppearance[] = [];
    const { kv, answer } = heldKV();
    const store = appearanceStore(kv, (next) => seen.push(next));
    const booting = store.boot();
    store.dispose();
    answer(encodeAppearance({ themePref: "dark", facePin: null }));
    await booting;
    expect(seen).toEqual([]);
  });

  it("no keystore: the choice holds for the session and nothing is written", async () => {
    const seen: StoredAppearance[] = [];
    const store = appearanceStore(undefined, (next) => seen.push(next));
    await store.boot();
    expect(seen).toEqual([]);
    store.setTheme("dark");
    expect(last(seen)).toEqual({ themePref: "dark", facePin: null });
  });

  it("an unreadable keystore is 'no stored appearance', not a crash at launch", async () => {
    const seen: StoredAppearance[] = [];
    const store = appearanceStore(
      {
        get: async () => {
          throw new Error("keystore refused");
        },
        set: async () => {},
        remove: async () => {},
      },
      (next) => seen.push(next),
    );
    await expect(store.boot()).resolves.toBeUndefined();
    expect(seen).toEqual([]);
  });
});
