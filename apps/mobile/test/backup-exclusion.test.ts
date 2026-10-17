/**
 * THE COPIED MAIL AND THE DEVICE BACKUP — the measurement, and the sentence derived from it.
 *
 * The pairing credential has never ridden a backup; the mail it protects rode one on iOS, and
 * the About block said so honestly rather than claiming a parity the build did not have. The fix
 * is a reading, not a promise: the native half marks the mirror's directory and reads the mark
 * back, and the sentence comes from what came back. So the cases below are about the two ways
 * that can go wrong — believing a write instead of a read, and speaking silence as an answer.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  backupExclusion,
  measureBackupExclusion,
  recordBackupExclusion,
  subscribeBackupExclusion,
  type BackupExclusion,
  type BackupExclusionNative,
} from "../src/engine/backup-exclusion";
import { logBackupExclusion } from "../src/engine/engine-log";
import { DECKS } from "../src/copy";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** A native half whose two answers are set independently, which is the whole point. */
function native(set: boolean | Error, back: boolean | Error | "never"): BackupExclusionNative {
  return {
    excludeFromBackup: async () => {
      if (set instanceof Error) throw set;
      return set;
    },
    isExcluded: async () => {
      if (back === "never") return new Promise<boolean>(() => {});
      if (back instanceof Error) throw back;
      return back;
    },
  };
}

afterEach(() => {
  recordBackupExclusion("unknown");
  vi.restoreAllMocks();
});

describe("the measurement", () => {
  it("answers the READ-BACK, not what the set returned", async () => {
    // The defect this forbids: a platform call that returned without throwing is a statement
    // about the call, never about the item. A build that believed it would say the mail is
    // outside the backup while the directory carries no mark at all.
    expect(await measureBackupExclusion(native(true, false), "/db/mirror.db")).toBe("included");
    expect(await measureBackupExclusion(native(false, true), "/db/mirror.db")).toBe("excluded");
  });

  it("a refused SET is not the answer either — the read still decides", async () => {
    expect(await measureBackupExclusion(native(new Error("denied"), true), "/db/mirror.db"))
      .toBe("excluded");
  });

  it("no native half, no path, or a read that threw is UNKNOWN and never false", async () => {
    expect(await measureBackupExclusion(null, "/db/mirror.db")).toBe("unknown");
    expect(await measureBackupExclusion(native(true, true), "")).toBe("unknown");
    expect(await measureBackupExclusion(native(true, true), undefined)).toBe("unknown");
    expect(await measureBackupExclusion(native(true, new Error("io")), "/db/mirror.db"))
      .toBe("unknown");
  });

  it("ONE budget over both calls — a native half that never settles does not hold the open", async () => {
    // The budget on a FAKE clock: open one tick short of it, answered at it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const started = Date.now();
      let settled = false;
      const measured = measureBackupExclusion(native(true, "never"), "/db/mirror.db", 30).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(29);
      expect(settled, "the open was released before its budget").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await measured).toBe("unknown");
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the state every reader shares", () => {
  it("starts unknown, publishes a change, and stays quiet when nothing changed", () => {
    expect(backupExclusion()).toBe("unknown");
    let beats = 0;
    const off = subscribeBackupExclusion(() => { beats += 1; });
    recordBackupExclusion("excluded");
    expect(backupExclusion()).toBe("excluded");
    expect(beats).toBe(1);
    recordBackupExclusion("excluded");
    expect(beats, "a second open of the same directory is not news").toBe(1);
    off();
    recordBackupExclusion("included");
    expect(beats).toBe(1);
  });
});

describe("the one line the device run reads", () => {
  it("carries the boolean AND the state, so a false reading is not a missing one", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(line); });
    logBackupExclusion("excluded", "ios");
    logBackupExclusion("unknown", "android");
    const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(first).toMatchObject({
      service: "app", event: "backup_exclusion", backup_excluded: true, state: "excluded",
      platform: "ios",
    });
    const second = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
    expect(second).toMatchObject({ backup_excluded: false, state: "unknown", platform: "android" });
  });
});

describe("the sentence, in both languages", () => {
  const states: BackupExclusion[] = ["excluded", "included", "unknown"];

  it("says the mail is out of the backup ONLY where that was measured", () => {
    for (const [locale, deck] of Object.entries(DECKS)) {
      const said = Object.fromEntries(states.map((s) => [s, deck.aboutOnDeviceBackup(s)]));
      // Positive control: the measured-true sentence is the one that states the exclusion.
      expect(said.excluded, locale).toMatch(/herausbleibt|stay out of/);
      // And the other two never do — which is the half that goes red if the copy is unconditional.
      expect(said.included, locale).not.toMatch(/herausbleibt|stay out of/);
      expect(said.unknown, locale).not.toMatch(/herausbleibt|stay out of/);
      // Three distinct sentences: a deck that answered one string for every state would state
      // the same claim under a reading that contradicts it.
      expect(new Set(Object.values(said)).size, locale).toBe(3);
    }
  });

  it("states the opposite where the reading was false, and claims nothing where there was none", () => {
    for (const [locale, deck] of Object.entries(DECKS)) {
      expect(deck.aboutOnDeviceBackup("included"), locale)
        .toMatch(/backups include|Backups des Handys schließen sie ein/);
      expect(deck.aboutOnDeviceBackup("unknown"), locale)
        .toMatch(/could not be read|nicht\s+gelesen werden/);
    }
  });

  it("the platform claim left `aboutOnDevice`, so one sentence cannot outlive its build", () => {
    for (const [locale, deck] of Object.entries(DECKS)) {
      expect(deck.aboutOnDevice, locale).not.toMatch(/On Android it is excluded|aus beiden ausgenommen/);
      expect(deck.aboutOnDevice, locale).not.toMatch(/documents|Dokumenten dieser App/);
      // The pairing half is untouched — the claim that was already true stays stated.
      expect(deck.aboutOnDevice, locale).toMatch(/never included in a backup|nie in einem Backup/);
    }
  });
});

describe("where the sentence and the reading are joined", () => {
  const settings = read("../app/settings.tsx");

  it("the About block renders the SUBSCRIBED state, never a literal", () => {
    // A `Copy.aboutOnDeviceBackup("excluded")` here is the unconditional copy the fix replaces:
    // it would state the exclusion on a build that measured the opposite.
    expect(settings).toMatch(/Copy\.aboutOnDeviceBackup\(backupSays\)/);
    expect(settings).not.toMatch(/Copy\.aboutOnDeviceBackup\("/);
    expect(settings)
      .toMatch(/useSyncExternalStore\(subscribeBackupExclusion, backupExclusion, backupExclusion\)/);
  });

  it("the mirror's open measures, with the path the platform actually opened", () => {
    // `native.ts` is the one module the node suite cannot load (expo-sqlite), so this is read as
    // source — the same shape `privacy.test.ts` established here. What matters is that the
    // measurement takes the OPENED handle's own path rather than a name it reconstructed.
    const src = read("../src/engine/native.ts");
    const body = /openExecutor: async \(dbName\) => \{([\s\S]*?)\n    \},/.exec(src)?.[1] ?? "";
    expect(body, "the openExecutor body must be readable").not.toBe("");
    expect(body).toMatch(/await settleBackupExclusion\(db\.databasePath\)/);
    expect(body.indexOf("settleBackupExclusion")).toBeGreaterThan(body.indexOf("openDatabaseAsync"));
  });

  it("the native half is asked for OPTIONALLY — a bare require of a missing module is fatal", () => {
    const door = read("../src/engine/backup-exclusion-native.ts");
    expect(door).toMatch(/requireOptionalNativeModule<BackupExclusionNative>\("OhmailBackupExclusion"\)/);
    expect(door).not.toMatch(/requireNativeModule/);
  });
});

describe("the native halves — read as source, because neither compiles here", () => {
  const module = (rel: string): string => read(`../modules/backup-exclusion/${rel}`);

  it("one module name, both platforms, both functions", () => {
    const config = JSON.parse(module("expo-module.config.json")) as {
      platforms: string[];
      android: { modules: string[] };
      apple: { modules: string[] };
    };
    expect(config.platforms.sort()).toEqual(["android", "apple"]);
    expect(config.android.modules).toEqual(["app.ohmail.backupexclusion.BackupExclusionModule"]);
    expect(config.apple.modules).toEqual(["OhmailBackupExclusionModule"]);
    for (const half of ["ios/OhmailBackupExclusionModule.swift", "android/src/main/java/app/ohmail/backupexclusion/BackupExclusionModule.kt"]) {
      const src = module(half);
      expect(src, half).toContain('Name("OhmailBackupExclusion")');
      expect(src, half).toContain("excludeFromBackup");
      expect(src, half).toContain("isExcluded");
    }
  });

  it("iOS reads back through a URL built fresh, because a URL caches what it was asked", () => {
    const swift = module("ios/OhmailBackupExclusionModule.swift");
    expect(swift).toMatch(/let fresh = URL\(fileURLWithPath: dir\.path\)/);
    expect(swift).toMatch(/fresh\.resourceValues\(forKeys: \[\.isExcludedFromBackupKey\]\)/);
    // The set's outcome is discarded on this platform too: both functions end in the read.
    expect(swift).toMatch(/return OhmailBackupExclusionModule\.readBack\(path\)/);
  });

  it("Android answers the RULESET in force, never `allowBackup` alone", () => {
    // `plugins/backup-exclusions.js` leaves `allowBackup="true"` and keeps the mirror out with an
    // include-only ruleset, so an arm that answered the flag would report the mail as backed up
    // on a build where it is not — the opposite of the truth, stated in the app's own sentence.
    const rules = module("android/src/main/java/app/ohmail/backupexclusion/BackupRules.kt");
    expect(rules).toContain("ohmail_data_extraction_rules");
    expect(rules).toContain("ohmail_backup_rules");
    expect(rules).toMatch(/if \(includes\.isEmpty\(\)\) return false/);
    expect(rules).toMatch(/return includes\.none \{/);
    // An unplaceable file is not reported as excluded: nothing measured it.
    expect(rules).toMatch(/val placed = place\(context, target\) \?: return false/);
  });

  it("the resource names it reads are the ones the plugin writes", () => {
    const plugin = read("../plugins/backup-exclusions.js");
    const rules = module("android/src/main/java/app/ohmail/backupexclusion/BackupRules.kt");
    for (const name of ["ohmail_backup_rules", "ohmail_data_extraction_rules"]) {
      expect(plugin, name).toContain(`"${name}"`);
      expect(rules, name).toContain(`"${name}"`);
    }
  });
});
