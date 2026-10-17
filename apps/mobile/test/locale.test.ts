import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LOCALE, LOCALES, activeLocale, deviceLocale, isAppLocale, normalizeLocale,
  resetLocaleRegisterForTests, resolveLocale, setActiveLocale, subscribeLocale,
  type AppLocale,
} from "../src/i18n/locale";
import { LOCALE_KEY, readStoredLocale, writeStoredLocale } from "../src/i18n/store";
import { keystoreDeps, localeSequencer } from "../src/i18n/sequencer";
import { Copy } from "../src/copy";
import type { SecureKV } from "../src/state/servers";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * ═══ HOW THE PHONE DECIDES WHICH LANGUAGE IT IS IN ══════════════════════════════════════════
 *
 * Three sources, one order, and the order is the whole feature: an explicit choice, then the
 * phone's own language, then English. Each of the three has a way of being absent that is
 * different from being English — a keystore that will not answer, a platform with no ICU data, a
 * language ohmail does not speak — and every one of those has been the cause of a locale bug in
 * some product: the app reads "nothing" as "English" and a German phone opens in English for ever.
 *
 * So `null` is load-bearing at every layer here and the tests are mostly about `null`.
 */

const memoryKV = (seed: Record<string, string> = {}): SecureKV & { store: Map<string, string> } => {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: (k) => Promise.resolve(store.get(k) ?? null),
    set: (k, v) => { store.set(k, v); return Promise.resolve(); },
    remove: (k) => { store.delete(k); return Promise.resolve(); },
  };
};

/** A keystore that refuses everything — a locked device, or a damaged item. */
const refusingKV = (): SecureKV => ({
  get: () => Promise.reject(new Error("keystore locked")),
  set: () => Promise.reject(new Error("keystore locked")),
  remove: () => Promise.reject(new Error("keystore locked")),
});

afterEach(() => {
  resetLocaleRegisterForTests();
  vi.restoreAllMocks();
});

describe("the closed set", () => {
  it("is exactly English and German, with English as the fallback", () => {
    expect([...LOCALES]).toEqual(["en", "de"]);
    expect(DEFAULT_LOCALE).toBe("en");
    expect(LOCALES).toContain(DEFAULT_LOCALE);
  });

  it("admits only its own members", () => {
    expect(isAppLocale("en")).toBe(true);
    expect(isAppLocale("de")).toBe(true);
    expect(isAppLocale("fr")).toBe(false);
    expect(isAppLocale("")).toBe(false);
    expect(isAppLocale(null)).toBe(false);
    expect(isAppLocale(2)).toBe(false);
  });
});

describe("normalizeLocale — reducing whatever a platform said", () => {
  it("takes the primary subtag, so a Swiss or Austrian phone gets German", () => {
    // The failure this prevents: `de-CH` matching no member and falling through to English on a
    // phone whose owner has never seen an English interface by choice.
    for (const tag of ["de", "de-DE", "de-CH", "de-AT", "de_DE", "DE-ch", "  de-CH  "]) {
      expect(normalizeLocale(tag), tag).toBe("de");
    }
    for (const tag of ["en", "en-GB", "en_US", "EN-gb"]) {
      expect(normalizeLocale(tag), tag).toBe("en");
    }
  });

  it("answers null — not English — for anything it does not speak", () => {
    // `null` and `"en"` must stay distinguishable: the first keeps looking at the next source,
    // the second stops. `resolveLocale` is where that difference is spent.
    for (const said of ["fr", "fr-FR", "", "   ", "xx", null, undefined]) {
      expect(normalizeLocale(said as string | null | undefined), String(said)).toBeNull();
    }
  });
});

describe("resolveLocale — the order of the three sources", () => {
  it("prefers an explicit choice over the phone's own language", () => {
    expect(resolveLocale("de", "en")).toBe("de");
    expect(resolveLocale("en", "de")).toBe("en");
  });

  it("follows the phone when nothing has been chosen", () => {
    expect(resolveLocale(null, "de")).toBe("de");
    expect(resolveLocale(null, "en")).toBe("en");
  });

  it("falls back to English only when both are silent", () => {
    expect(resolveLocale(null, null)).toBe("en");
  });

  it("keeps an explicit choice even where the phone says nothing", () => {
    // The case a naive `chosen ?? device ?? default` chain gets right and a `device || chosen`
    // one gets exactly backwards: somebody chose German on a device with no ICU data at all.
    expect(resolveLocale("de", null)).toBe("de");
  });
});

describe("deviceLocale — asking the platform without a new dependency", () => {
  it("reads the language off the same call this app already reads the zone from", () => {
    /*
     * `Intl.DateTimeFormat().resolvedOptions()` — `.timeZone` is `state/live.ts#readerZone`,
     * `.locale` is this. One call, two fields, and no localization dependency in a phone bundle.
     *
     * THIS USED TO BE `expect(spy).toHaveBeenCalled()`, which is true of a `deviceLocale` that
     * calls `Intl.DateTimeFormat` for one thing and reads the language from somewhere else
     * entirely — an added dependency, a native module, a cached value. It asserted that a
     * function ran, not that the ANSWER came from it. So the answer is traced instead: a locale
     * nothing else in this process could have produced comes back out.
     */
    const marker = "de-AT-u-ca-gregory";
    const resolvedOptions = vi.fn(() => ({ locale: marker, timeZone: "Europe/Zurich" }));
    const spy = vi.spyOn(Intl, "DateTimeFormat")
      .mockReturnValue({ resolvedOptions } as unknown as Intl.DateTimeFormat);

    expect(deviceLocale(), "the answer did not come from resolvedOptions().locale").toBe("de");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy, "the platform was asked with a locale of our own, which asks it nothing")
      .toHaveBeenCalledWith();
    expect(resolvedOptions, "the call was made and its answer not read").toHaveBeenCalledTimes(1);
  });

  it("needs no localization dependency, which is the reason it is written this way", () => {
    /* The other half of the claim above, and the one that rots: the cheap fix for any locale
       question is to add `expo-localization`, and a phone bundle is exactly where that cost
       lands. Asserted against the manifest rather than described in a comment. */
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
    };
    const named = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(named.filter((d) => /localization|\bi18n\b|intl-/i.test(d)),
      "a localization dependency was added; `deviceLocale` exists so the bundle needs none")
      .toEqual([]);
  });

  it("reduces whatever the platform reports to a deck this app has", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockReturnValue(
      { resolvedOptions: () => ({ locale: "de-CH" }) } as unknown as Intl.DateTimeFormat,
    );
    expect(deviceLocale()).toBe("de");
  });

  it("answers null for a language ohmail does not speak", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockReturnValue(
      { resolvedOptions: () => ({ locale: "fr-FR" }) } as unknown as Intl.DateTimeFormat,
    );
    expect(deviceLocale()).toBeNull();
  });

  it("answers null rather than throwing where there is no ICU data at all", () => {
    // A crash on boot over a display preference is the one outcome that is worse than English.
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => { throw new Error("no ICU"); });
    expect(deviceLocale()).toBeNull();
  });
});

describe("the stored override", () => {
  it("round-trips through the keystore under one namespaced key", async () => {
    const kv = memoryKV();
    await writeStoredLocale(kv, "de");
    expect(kv.store.get(LOCALE_KEY)).toBe("de");
    expect(await readStoredLocale(kv)).toBe("de");
  });

  it("is cleared by null — the segment that hands the app back to the phone", async () => {
    const kv = memoryKV({ [LOCALE_KEY]: "de" });
    await writeStoredLocale(kv, null);
    expect(kv.store.has(LOCALE_KEY)).toBe(false);
    expect(await readStoredLocale(kv)).toBeNull();
  });

  it("reads nothing as null, never as English", async () => {
    expect(await readStoredLocale(memoryKV())).toBeNull();
  });

  it("reads a value this build does not recognise as null", async () => {
    // A locale retired in a later version, or a corrupted item. Neither is worth a thrown launch,
    // and neither may be treated as a choice somebody made.
    expect(await readStoredLocale(memoryKV({ [LOCALE_KEY]: "fr" }))).toBeNull();
    expect(await readStoredLocale(memoryKV({ [LOCALE_KEY]: "{}" }))).toBeNull();
  });

  it("reads a locked keystore as null rather than throwing into the boot path", async () => {
    expect(await readStoredLocale(refusingKV())).toBeNull();
  });

  it("REJECTS a refused write, so the Settings row can say so", async () => {
    // The contract the webapp's language row keeps: resolve to what the store holds, never to what
    // the press hoped for. A preference that silently did not save is a failure nobody can report.
    await expect(writeStoredLocale(refusingKV(), "de")).rejects.toThrow(/keystore locked/);
  });

  it("refuses a value that is not a language this build speaks, before it reaches the store", async () => {
    const kv = memoryKV();
    await expect(writeStoredLocale(kv, "fr" as AppLocale)).rejects.toThrow(/not a language/);
    expect(kv.store.has(LOCALE_KEY)).toBe(false);
  });
});

describe("the orderings, driven on the real sequencer", () => {
  /*
   * ═══ NO MODEL. THIS IS THE CODE THE APP RUNS ═════════════════════════════════════════════
   *
   * These cases used to drive a little state machine written here and tied to `LocaleProvider` by
   * regexes over its source. Review's verdict was that moving the boot guard after publishing left
   * the model green and the tokens present — so the tests proved nothing about the provider. The
   * rules moved into `src/i18n/sequencer.ts`, which the provider wires, and these drive that.
   */
  /** One turn of the queue — the microtask a chained write waits for before it reaches a store. */
  const tick = () => new Promise<void>((r) => { setTimeout(r, 0); });

  const deferred = <T,>() => {
    let release!: (v: T) => void;
    return { promise: new Promise<T>((r) => { release = r; }), release };
  };

  /** A sequencer with every effect captured, and a device that says English unless told. */
  const rig = (device: AppLocale | null = "en") => {
    const published: AppLocale[] = [];
    const chosenSeen: (AppLocale | null)[] = [];
    const busySeen: boolean[] = [];
    const reads: { promise: Promise<AppLocale | null>; release: (v: AppLocale | null) => void }[] = [];
    const writes: { next: AppLocale | null; release: () => void }[] = [];
    const seq = localeSequencer({
      read: () => { const d = deferred<AppLocale | null>(); reads.push(d); return d.promise; },
      write: (next) => {
        const d = deferred<void>();
        writes.push({ next, release: () => { d.release(undefined); } });
        return d.promise;
      },
      device: () => device,
      publish: (l) => { published.push(l); },
      onChosen: (c) => { chosenSeen.push(c); },
      onBusy: (b) => { busySeen.push(b); },
    });
    return { seq, published, chosenSeen, busySeen, reads, writes };
  };

  it("a choice made while the boot read is in flight WINS over the stored value", async () => {
    /* Launch with the keystore slow; the reader picks German before it answers. The read used to
       publish its own answer over the choice, so the app reverted a moment after the press. */
    const r = rig();
    const booting = r.seq.boot();
    const setting = r.seq.set("de");
    await tick();                       // the press takes its turn at the keystore
    r.writes[0]!.release();
    await setting;
    expect(r.published).toEqual(["de"]);
    r.reads[0]!.release(null);          // …the keystore finally answers "nothing stored"
    await booting;
    expect(r.published, "the stored answer overwrote the newer choice").toEqual(["de"]);
    expect(r.seq.chosen()).toBe("de");
  });

  it("a boot read that resolves with no choice in flight still applies", async () => {
    const r = rig();
    const booting = r.seq.boot();
    r.reads[0]!.release("de");
    await booting;
    expect(r.published).toEqual(["de"]);
    expect(r.seq.chosen()).toBe("de");
  });

  it("two presses in one render leave ONE write, by the newer press", async () => {
    /* `busy` is React state and does not exist until React commits, so both presses saw it false.
       Both then reached the keystore, and whichever it finished last was what the device kept —
       see the store cases below for the bytes. The superseded press no longer writes at all. */
    const r = rig();
    const first = r.seq.set("de");
    const second = r.seq.set("en");
    await tick();
    expect(r.writes.map((w) => w.next), "a superseded press reached the keystore").toEqual(["en"]);
    r.writes[0]!.release();
    await Promise.all([first, second]);
    expect(r.published, "an older press published over a newer one").toEqual(["en"]);
    expect(r.seq.chosen()).toBe("en");
  });

  it("an older press finishing late does not unlock the control", async () => {
    const r = rig();
    const first = r.seq.set("de");
    const second = r.seq.set("en");
    await tick();
    await first;                        // the superseded press is done; it never wrote
    expect(r.busySeen, "the stale press cleared a flag it does not own").toEqual([true, true]);
    r.writes[0]!.release();
    await second;
    expect(r.busySeen, "the press that owns the flag did not clear it").toEqual([true, true, false]);
  });

  it("a refused write changes nothing, and says so by rejecting", async () => {
    const r = rig();
    const failing = localeSequencer({
      read: () => Promise.resolve(null),
      write: () => Promise.reject(new Error("keystore locked")),
      device: () => "en",
      publish: () => { throw new Error("published on a refused write"); },
      onChosen: () => { throw new Error("adopted on a refused write"); },
      onBusy: () => {},
    });
    await expect(failing.set("de")).rejects.toThrow(/keystore locked/);
    expect(failing.chosen()).toBeNull();
    void r;
  });

  it("a foreground wake reads the choice as of NOW, not as of the last render", async () => {
    const r = rig("en");
    const setting = r.seq.set("de");
    await tick();
    r.writes[0]!.release();
    await setting;
    r.published.length = 0;
    r.seq.wake();
    expect(r.published, "the wake resolved against a stale choice").toEqual(["de"]);
  });

  it("a wake with NO choice follows the phone, which is the whole point of System", () => {
    const r = rig("de");
    r.seq.wake();
    expect(r.published).toEqual(["de"]);
  });
});

describe("what the DEVICE is left holding — the half a publish cannot show you", () => {
  /*
   * ═══ THE PUBLISH WAS ORDERED AND THE KEYSTORE WAS NOT ════════════════════════════════════
   *
   * Every case above asserts what was PUBLISHED, which is what the screen shows. That half was
   * correct. The keystore was not: `set` issued its write and awaited it independently of every
   * other press, so two presses in one render raced INSIDE the store. The app displayed the newer
   * language and the device kept whichever write the keystore happened to finish last.
   *
   * Nothing on screen can show you that. It surfaces one launch later, as an app that "forgets" a
   * setting — close to the hardest thing for a person to report, because setting it again fixes it
   * and it comes back tomorrow.
   *
   * So these drive the real store over the keystore double and assert the BYTES, then relaunch
   * over the same device and assert what comes back.
   */
  const tick = () => new Promise<void>((r) => { setTimeout(r, 0); });

  /**
   * A keystore whose writes take the time they are told, so the OLDER press can be made to settle
   * last — the ordering the concurrent code left on disk. Delays are consumed in call order, and
   * every write is recorded, `null` for a clear.
   */
  const pacedKV = (...delays: number[]) => {
    const store = new Map<string, string>();
    const writes: (string | null)[] = [];
    let n = 0;
    const wait = () => new Promise<void>((r) => { setTimeout(r, delays[n++] ?? 0); });
    return {
      store,
      writes,
      get: (k: string) => Promise.resolve(store.get(k) ?? null),
      set: async (k: string, v: string) => { writes.push(v); await wait(); store.set(k, v); },
      remove: async (k: string) => { writes.push(null); await wait(); store.delete(k); },
    };
  };

  /** A sequencer bound to the real store functions, the way `LocaleProvider` binds one. */
  const overStore = (kv: SecureKV, device: AppLocale | null = "en") => {
    const published: AppLocale[] = [];
    const seq = localeSequencer({
      read: () => readStoredLocale(kv),
      write: (next) => writeStoredLocale(kv, next),
      device: () => device,
      publish: (l) => { published.push(l); },
      onChosen: () => {},
      onBusy: () => {},
    });
    return { seq, published };
  };

  for (const [older, newer] of [["de", "en"], ["en", "de"]] as const) {
    it(`${older} then ${newer}: the device holds ${newer}, though the older write is the slow one`, async () => {
      /* 30ms for the first keystore write and none for the second. Issued concurrently, the older
         value lands LAST and is what the phone keeps. */
      const kv = pacedKV(30, 0);
      const a = overStore(kv);
      const first = a.seq.set(older);
      const second = a.seq.set(newer);
      await Promise.all([first, second]);

      expect(kv.store.get(LOCALE_KEY), "the phone kept the language nobody chose").toBe(newer);
      expect(kv.writes, "a superseded press reached the keystore").toEqual([newer]);
      expect(a.published.at(-1)).toBe(newer);

      /* ── AND THE NEXT LAUNCH, which is the only place this was ever visible ── */
      await tick();
      const relaunch = overStore(kv);
      await relaunch.seq.boot();
      expect(relaunch.published, "the relaunch came back in the older language").toEqual([newer]);
      expect(relaunch.seq.chosen()).toBe(newer);
    });
  }

  it("a press then System clears the key, rather than leaving the language in between on the device", async () => {
    /* The nastier direction: a slow `set` racing a fast `remove` deletes nothing and then writes,
       so "follow this phone" leaves an override behind and the next launch ignores the phone. */
    const kv = pacedKV(30, 0);
    const a = overStore(kv, "de");
    const chose = a.seq.set("en");
    const cleared = a.seq.set(null);
    await Promise.all([chose, cleared]);

    expect(kv.store.has(LOCALE_KEY), "System left an override behind on the device").toBe(false);
    expect(kv.writes).toEqual([null]);

    await tick();
    const relaunch = overStore(kv, "de");
    await relaunch.seq.boot();
    expect(relaunch.published, "a relaunch after System did not follow the phone").toEqual(["de"]);
    expect(relaunch.seq.chosen()).toBeNull();
  });
});

describe("the provider's wiring, and letting go of it", () => {
  /*
   * ═══ THE FOUR LINES NOTHING COULD LOOK AT ════════════════════════════════════════════════
   *
   * `LocaleProvider` is React, and this suite has no renderer — nothing here mounts a tree,
   * `react-test-renderer` is not a dependency, and `AppState` does not resolve under node. Every
   * case above drives the sequencer directly, so a provider wired to the wrong store, or to a
   * stale one, satisfied all of them. `keystoreDeps` is that wiring extracted as a value; the
   * provider calls it and does nothing else, so holding it is holding the real thing.
   */
  const tick = () => new Promise<void>((r) => { setTimeout(r, 0); });

  it("reads and writes the ONE namespaced key, in the keystore it is handed", async () => {
    const kv = memoryKV({ [LOCALE_KEY]: "de" });
    const deps = keystoreDeps(() => kv, () => {}, () => {});
    expect(await deps.read()).toBe("de");
    await deps.write("en");
    expect(kv.store.get(LOCALE_KEY)).toBe("en");
    await deps.write(null);
    expect(kv.store.has(LOCALE_KEY)).toBe(false);
  });

  it("follows a keystore replaced between renders, rather than the one it was built with", async () => {
    /* The provider reads `kv` through a ref and builds the sequencer ONCE. If the wiring closed
       over the object instead of the getter, a caller passing a fresh keystore each render would
       keep writing to the first one — and every read would answer from a store nothing writes. */
    let current = memoryKV({ [LOCALE_KEY]: "de" });
    const deps = keystoreDeps(() => current, () => {}, () => {});
    expect(await deps.read()).toBe("de");
    const replaced = memoryKV({ [LOCALE_KEY]: "en" });
    current = replaced;
    expect(await deps.read(), "the wiring is pinned to the keystore of the first render").toBe("en");
    await deps.write("de");
    expect(replaced.store.get(LOCALE_KEY)).toBe("de");
  });

  it("hands the state setters straight through", () => {
    const chosenSeen: (AppLocale | null)[] = [];
    const busySeen: boolean[] = [];
    const deps = keystoreDeps(memoryKV, (c) => chosenSeen.push(c), (b) => busySeen.push(b));
    deps.onChosen("de");
    deps.onBusy(true);
    expect(chosenSeen).toEqual(["de"]);
    expect(busySeen).toEqual([true]);
  });

  /*
   * ── AND LETTING GO ────────────────────────────────────────────────────────────────────────
   *
   * The register outlives the component. A boot read or a write settling after the unmount used
   * to point it from a provider that no longer exists — and where a second one has since mounted,
   * the dead one's late answer lands on top of the live one's and the language changes for a
   * reason nothing on screen explains.
   */
  it("publishes nothing after dispose, and calls no setter", async () => {
    const published: AppLocale[] = [];
    const chosenSeen: (AppLocale | null)[] = [];
    const busySeen: boolean[] = [];
    let release!: (v: AppLocale | null) => void;
    const seq = localeSequencer({
      read: () => new Promise<AppLocale | null>((r) => { release = r; }),
      write: () => Promise.resolve(),
      device: () => "en",
      publish: (l) => { published.push(l); },
      onChosen: (c) => { chosenSeen.push(c); },
      onBusy: (b) => { busySeen.push(b); },
    });

    const booting = seq.boot();
    seq.dispose();                       // …the provider unmounts while the keystore is slow
    release("de");
    await booting;

    expect(published, "a disposed sequencer published over whatever is live now").toEqual([]);
    expect(chosenSeen, "a disposed sequencer set state on an unmounted component").toEqual([]);
    expect(busySeen).toEqual([]);
    seq.wake();
    expect(published, "a disposed sequencer answered a foreground wake").toEqual([]);
  });

  it("still finishes the write a press had already been given", async () => {
    /* Only what LEAVES the module stops. A press accepted before the unmount is a press somebody
       made, and it has to reach the device or the setting is lost on a screen change. */
    const kv = memoryKV();
    const published: AppLocale[] = [];
    const seq = localeSequencer({
      ...keystoreDeps(() => kv, () => {}, () => {}),
      device: () => "en",
      publish: (l) => { published.push(l); },
    });

    const pressing = seq.set("de");
    seq.dispose();
    await pressing;
    await tick();

    expect(kv.store.get(LOCALE_KEY), "the press was accepted and then dropped").toBe("de");
    expect(published, "it published from a provider that is gone").toEqual([]);
    /* …and the next launch finds it, which is the point of having written it. */
    expect(await readStoredLocale(kv)).toBe("de");
  });
});

describe("the register, and what subscribes to it", () => {
  it("rests at English, whatever language the machine running the suite is in", () => {
    // Every other test file in this directory asserts English strings with no provider anywhere.
    // That only holds because nothing but the provider ever moves the register — a module-scope
    // read of the device would have made the whole suite depend on the host's ICU default.
    expect(activeLocale()).toBe("en");
    expect(Copy.settings).toBe("Settings");
  });

  it("publishes a switch to its subscribers", () => {
    const seen: AppLocale[] = [];
    const stop = subscribeLocale(() => seen.push(activeLocale()));
    setActiveLocale("de");
    setActiveLocale("en");
    stop();
    setActiveLocale("de");
    expect(seen).toEqual(["de", "en"]);
  });

  it("says nothing when the language did not change", () => {
    // A boot read that confirms what was already true must not re-render every subscribed screen.
    let calls = 0;
    subscribeLocale(() => { calls += 1; });
    setActiveLocale("en");
    expect(calls).toBe(0);
    setActiveLocale("de");
    setActiveLocale("de");
    expect(calls).toBe(1);
  });

  it("does NOT retranslate a string already captured — the fact behind the refusal fix", () => {
    /*
     * ═══ WHAT A GETTER CAN AND CANNOT DO, MEASURED RATHER THAN ASSUMED ═══════════════════════
     *
     * The deck's getters make every READ live. They cannot help a value that was read once and
     * kept — which is a property of VALUES, and stays true however the app is written.
     *
     * `net/connection.tsx` used to keep one: it stored a formatted refusal, so switching language
     * with a refusal on screen left the sentence in the language it was produced in. That is fixed
     * — the connection state carries a `Refusal` now and formats at render, and
     * `test/refusal.test.ts` asserts the switch is followed and that no producer stores a `Copy.`
     * read in a `reason` field again.
     *
     * What is asserted HERE is the underlying fact that made it a defect, because it has not gone
     * away and never will: a string read out of the deck and kept is a value, not a view. Anything
     * that must survive a language change has to keep a key, as the refusals and `StoreFault` now
     * do. The assertion exists so that
     * nobody reads the getters' guarantee as wider than it is.
     */
    const captured = Copy.notPairedHere;
    expect(captured).toBe("that server is no longer paired on this phone");
    setActiveLocale("de");
    expect(captured, "a captured string is a value, not a view").toBe(
      "that server is no longer paired on this phone",
    );
    expect(Copy.notPairedHere, "…while a fresh read follows the switch").toBe(
      "dieser Server ist auf diesem Handy nicht mehr gekoppelt",
    );
  });

  it("changes what the deck answers, on the next read and with nothing to invalidate", () => {
    expect(Copy.settings).toBe("Settings");
    setActiveLocale("de");
    expect(Copy.settings).toBe("Einstellungen");
    expect(Copy.folderDeleteGo).toBe("Ordner löschen");
    expect(Copy.metaItems(1)).toBe("1 Eintrag");
    expect(Copy.metaItems(4)).toBe("4 Einträge");
  });
});
