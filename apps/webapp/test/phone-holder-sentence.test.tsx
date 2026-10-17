/** @vitest-environment jsdom */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import messages from "../messages/en.json";
import de from "../messages/de.json";
import {
  PHONE_HOLDER_WHY_KEY, filingElsewhereKey, holderSentence, phoneHolder, phoneHolderKey,
} from "../app/shell/reader-holder";
import { holderFingerprint, readingAlong, setReadingAlong, clearReadingAlong } from "../app/shell/reading-along";
import type { MailState } from "../app/shell/mail-state";
import type { FirstRunHost } from "../app/shell/first-run-host";
import type { OnboardingFacts, OnboardingMailbox } from "../app/shell/onboarding";

/**
 * ═══ A PHONE HOLDS THE MAILBOX AND NO SURFACE SAID SO ═══════════════════════════════════════
 *
 * `mobile` is the third `OrganizerKind` the lease records, and four surfaces branched per KIND
 * with arms for `local` and `cloud` only. A phone fell into whichever arm was last:
 *
 *  · the rail            → "Another ohmail install files this mailbox on its own schedule" — said
 *                          over a phone whose claim had LAPSED too, which is filing nothing;
 *  · the desktop pane    → "Since <date>. This computer reads the mailbox…", naming no holder;
 *  · both `FirstRun` rows→ the LOCAL sentence, which says "This computer" about a phone;
 *  · the restore card    → the bare "Saved <date>.", naming nobody.
 *
 * The fact none of them carried is the phone's one difference: it organizes while its app is
 * open. ONE derivation answers it — `reader-holder.ts`'s {@link phoneHolder} and
 * {@link phoneHolderKey} — and four surfaces read that, so they cannot drift into four wordings.
 *
 * ── HOW TO WATCH THESE FAIL ─────────────────────────────────────────────────────────────────
 *
 * Drop the `named` arm from `phoneHolderKey` and every named case reddens on the unnamed
 * sentence. Drop the `state` arm and the stopped cases read as organizing, which is the "a
 * stopped phone is still filing" half of this row exactly. Remove `phone` from any one surface
 * and that surface's case reddens naming the arm the phone falls back into — the released
 * behaviour. Spell any phone key in a surface instead of reading the table and the census below
 * reddens naming the file.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const tm = (messages as unknown as { mailboxes: Record<string, string> }).mailboxes;
const ts = (messages as unknown as { sync: Record<string, string> }).sync;
const deM = (de as unknown as { mailboxes: Record<string, string> }).mailboxes;

/** Every ohmail phone writes a claim name; this is the shape one takes. */
const PHONE = "ohmail on a phone";

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => { for (const r of roots.splice(0)) r.unmount(); });
  document.body.innerHTML = "";
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE DERIVATION — one question, one table, and nowhere else to ask it
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("the one derivation", () => {
  it("answers only for a phone, and carries the two facts a sentence selects on", () => {
    expect(phoneHolder({ kind: "mobile", name: PHONE }, false))
      .toEqual({ state: "organizing", named: true });
    expect(phoneHolder({ kind: "mobile", name: PHONE }, true))
      .toEqual({ state: "stopped", named: true });
    /* A claim with no name, and a claim whose name is whitespace, are one state — the sentence
       that stands without a name. `readerHolder` settled this for the other holders. */
    expect(phoneHolder({ kind: "mobile", name: null }, false))
      .toEqual({ state: "organizing", named: false });
    expect(phoneHolder({ kind: "mobile", name: "   " }, false))
      .toEqual({ state: "organizing", named: false });
    for (const other of [
      { kind: "local", name: "omarchy" },
      { kind: "cloud", name: "ohmail Cloud" },
      { kind: "unknown", name: null },
      null,
      undefined,
    ]) {
      expect(phoneHolder(other, false), `${JSON.stringify(other)} was read as a phone`).toBe(null);
    }
  });

  it("every key the table can hand back is in BOTH catalogues", () => {
    const handed = new Set<string>([PHONE_HOLDER_WHY_KEY]);
    for (const state of ["organizing", "stopped"] as const) {
      for (const named of [true, false]) {
        for (const voice of ["full", "short"] as const) {
          handed.add(phoneHolderKey({ state, named }, voice));
        }
      }
    }
    /* SIX, and the number is exact in both directions: a seventh key nothing hands back is copy
       no surface can reach, and a fifth means an arm was collapsed. */
    expect([...handed].sort()).toEqual([
      "readerHolderPhone",
      "readerHolderPhoneShort",
      "readerHolderPhoneStopped",
      "readerHolderPhoneStoppedUnnamed",
      "readerHolderPhoneUnnamed",
      "readerHolderPhoneWhy",
    ]);
    for (const key of handed) {
      expect(typeof tm[key], `en.json has no mailboxes.${key}`).toBe("string");
      expect(typeof deM[key], `de.json has no mailboxes.${key}`).toBe("string");
    }
  });

  it("the table separates the states it exists to separate", () => {
    expect(phoneHolderKey({ state: "organizing", named: true }, "full")).toBe("readerHolderPhone");
    expect(phoneHolderKey({ state: "organizing", named: false }, "full"))
      .toBe("readerHolderPhoneUnnamed");
    expect(phoneHolderKey({ state: "stopped", named: true }, "full"))
      .toBe("readerHolderPhoneStopped");
    expect(phoneHolderKey({ state: "stopped", named: false }, "full"))
      .toBe("readerHolderPhoneStoppedUnnamed");
  });
});

/**
 * THE CENSUS. A second place that decides what a phone is called is the whole defect coming
 * back: four surfaces each branching on the kind is how they came to say four different things.
 * So `reader-holder.ts` is the ONLY file under the shell and the desktop window that may test
 * the kind or spell one of these keys. Watch it fail: put `t("readerHolderPhone")` back into any
 * surface and this names that file and line.
 */
describe("nowhere else composes the phone's words", () => {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const ROOTS = ["apps/webapp/app/shell", "apps/webapp/app/views", "apps/desktop/src"];
  const DERIVATION = "apps/webapp/app/shell/reader-holder.ts";

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(p);
    }
    return out;
  };

  const hits = (needle: RegExp): string[] => {
    const found: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(path.join(REPO, root))) {
        const rel = path.relative(REPO, file);
        if (rel === DERIVATION) continue;
        fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
          if (needle.test(line)) found.push(`${rel}:${i + 1}  ${line.trim()}`);
        });
      }
    }
    return found;
  };

  it("no surface spells a phone-holder key", () => {
    expect(
      hits(/readerHolderPhone/),
      "read the key from `phoneHolderKey` instead — one table, four surfaces",
    ).toEqual([]);
  });

  it("no surface asks whether the holder kind is `mobile`", () => {
    expect(
      hits(/kind\s*===\s*"mobile"|kind\s*!==\s*"mobile"/),
      "ask `phoneHolder` instead — the kind test lives in one file",
    ).toEqual([]);
  });

  it("POSITIVE CONTROL: the derivation itself holds both, or this census is scanning nothing", () => {
    const src = fs.readFileSync(path.join(REPO, DERIVATION), "utf8");
    expect(src).toMatch(/kind !== "mobile"/);
    expect(src).toMatch(/readerHolderPhone/);
    for (const root of ROOTS) expect(walk(path.join(REPO, root)).length).toBeGreaterThan(5);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE CATALOGUE — the ruled sentence, in both languages
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("the phone holder's sentence, as the catalogue spells it", () => {
  it("the running sentence names the holder AND the phone's one difference", () => {
    expect(tm.readerHolderPhone)
      .toBe("{name} is organizing this mailbox — a phone organizes while its app is open.");
    expect(tm.readerHolderPhoneUnnamed)
      .toBe("A phone is organizing this mailbox, and only while its app is open.");
    expect(tm.readerHolderPhoneShort).toBe("Organized by a phone");
    expect(tm.readerHolderPhoneWhy).toBe("A phone organizes while its app is open.");
  });

  it("the stopped sentence is PAST TENSE and says what is true now", () => {
    for (const s of [tm.readerHolderPhoneStopped!, tm.readerHolderPhoneStoppedUnnamed!]) {
      expect(s).toContain("was organizing this mailbox");
      expect(s).toContain("Nothing is organizing it until something claims it.");
      expect(s, "a stopped phone was said to be organizing").not.toContain("is organizing this");
    }
    for (const s of [deM.readerHolderPhoneStopped!, deM.readerHolderPhoneStoppedUnnamed!]) {
      expect(s).toContain("hat dieses Postfach organisiert");
      expect(s).toContain("Es wird nicht mehr organisiert, bis etwas es übernimmt.");
    }
  });

  it("German is written, not transliterated — no dash construction, and the same verb as its neighbours", () => {
    expect(deM.readerHolderPhone)
      .toBe("{name} organisiert dieses Postfach. Ein Handy tut das nur, solange seine App geöffnet ist.");
    expect(deM.readerHolderPhoneUnnamed)
      .toBe("Ein Handy organisiert dieses Postfach, und nur solange seine App geöffnet ist.");
    expect(deM.readerHolderPhoneShort).toBe("Von einem Handy organisiert");
    expect(deM.readerHolderPhoneWhy).toBe("Ein Handy organisiert nur, solange seine App geöffnet ist.");
    for (const key of [
      "readerHolderPhone", "readerHolderPhoneUnnamed",
      "readerHolderPhoneStopped", "readerHolderPhoneStoppedUnnamed",
    ]) {
      expect(deM[key], `de.${key} kept the English dash construction`).not.toContain(" — ");
      /* `organisieren` is the verb every neighbouring German holder sentence uses
         (`readerStopped`, `organizeHere`); `ordnen` would be a second word for one act. */
      expect(deM[key]).toContain("organisiert");
      expect(deM[key], `de.${key} is the English`).not.toBe(tm[key]);
    }
  });

  it("no form calls a phone a computer, a laptop or another install", () => {
    for (const key of [
      "readerHolderPhone", "readerHolderPhoneUnnamed", "readerHolderPhoneShort",
      "readerHolderPhoneWhy", "readerHolderPhoneStopped", "readerHolderPhoneStoppedUnnamed",
    ]) {
      for (const s of [tm[key]!.toLowerCase(), deM[key]!.toLowerCase()]) {
        expect(s, key).not.toContain("computer");
        expect(s, key).not.toContain("laptop");
        expect(s, key).not.toContain("rechner");
        expect(s, key).not.toContain("another install");
        expect(s, key).not.toContain("andere installation");
      }
      /* The running forms carry the clause; the stopped ones carry the state instead, and a
         stopped phone's app being open or shut is no longer the fact. */
      if (!key.includes("Stopped")) {
        expect(tm[key]!.toLowerCase() + deM[key]!.toLowerCase()).toContain("phone");
      }
    }
    expect(tm.readerHolderPhone).toContain("while its app is open");
    expect(deM.readerHolderPhone).toContain("solange seine App geöffnet ist");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   SURFACE 1 — THE RAIL (`SyncBar`), including the stopped half this row is half about
   ══════════════════════════════════════════════════════════════════════════════════════════ */

const QUIET: MailState = {
  key: "quiet",
  clock: false,
  count: 0,
  total: null,
  reason: null,
  errorCode: null,
  asOf: null,
  address: null,
  minutes: null,
  slow: false,
  screenerCandidate: false,
  pending: 0,
  filing: null,
  continuesAtFolder: null,
  settled: true,
  owed: false,
};

let railState: MailState = QUIET;
vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: railState, refresh: () => {} }),
}));

/** The `elsewhere` arm, with the holder each case is about. */
const heldBy = (
  who: { kind: string; name: string | null; stopped: boolean; mailboxId?: string; since?: string | null },
): MailState => ({
  ...QUIET,
  key: "filing",
  count: 2,
  address: "someone@example.com",
  filing: {
    arm: "elsewhere",
    count: 2,
    deferred: 0,
    reason: null,
    nextAttemptAt: null,
    waitedMinutes: null,
    lastPassSeconds: null,
    who: { ...who, mailboxId: who.mailboxId ?? "mbx-1", since: who.since ?? null },
    asOf: null,
  },
});

async function rail(state: MailState): Promise<HTMLElement> {
  railState = state;
  const { SyncBar } = await import("../app/shell/SyncBar.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      /* The RAIL variant, because it is the rail this row is about: the shell variant lays the
         same sentence out differently and `.rs-line b` is the rail's own title node. */
      children: h(SyncBar, { variant: "rail" }),
    }));
  });
  return container;
}

/** The rail's title, alone — the detail line below it names a count and is not the sentence. */
const railTitle = (el: HTMLElement): string => (el.querySelector(".rs-line b")?.textContent ?? "").trim();

describe("SURFACE 1 — the rail says a phone is a phone", () => {
  it("a phone holding the mailbox is named as one, with the clause", async () => {
    const el = await rail(heldBy({ kind: "mobile", name: PHONE, stopped: false }));
    expect(railTitle(el)).toBe(tm.readerHolderPhone!.replace("{name}", PHONE));
    expect(el.textContent ?? "", "the rail called a phone another install")
      .not.toContain(ts.filingElsewhereUnknown!);
  });

  it("a phone whose claim recorded no name still gets a phone's sentence", async () => {
    const el = await rail(heldBy({ kind: "mobile", name: null, stopped: false }));
    expect(railTitle(el)).toBe(tm.readerHolderPhoneUnnamed);
    expect(railTitle(el), "an unnamed phone rendered a sentence with a hole in it")
      .not.toContain("{name}");
  });

  /**
   * THE FILING RAIL'S RED HALF. A phone whose claim has LAPSED was told to be filing this mailbox
   * on its own schedule — two false statements over a mailbox nothing is organizing at all. Watch
   * it fail: drop the `state` arm from `phoneHolderKey` and this reads the running sentence.
   */
  it("a phone whose claim has LAPSED is not filing anything, and the rail says so", async () => {
    const el = await rail(heldBy({ kind: "mobile", name: PHONE, stopped: true }));
    expect(railTitle(el)).toBe(tm.readerHolderPhoneStopped!.replace("{name}", PHONE));
    expect(railTitle(el), "a stopped phone was reported as organizing")
      .not.toBe(tm.readerHolderPhone!.replace("{name}", PHONE));
    const all = el.textContent ?? "";
    expect(all, "a stopped phone was told to be filing on a schedule")
      .not.toContain(ts.filingElsewhereUnknown!);
    expect(all, "a stopped phone was told to be filing on a schedule")
      .not.toContain("files this mailbox on its own schedule");
  });

  it("a lapsed phone with no name takes the stopped sentence that names none", async () => {
    const el = await rail(heldBy({ kind: "mobile", name: null, stopped: true }));
    expect(railTitle(el)).toBe(tm.readerHolderPhoneStoppedUnnamed);
  });

  /* THE THREE NON-PHONE HOLDERS KEEP THEIR OWN SENTENCES — and each now ENDS with the clause
     issue #5 is about, which is the one thing that changed here. Still an exact match, and
     against the `How` twin rather than a `toContain`: a control that stopped asserting the whole
     sentence would stop noticing the next holder to lose its own words. The plain keys are
     asserted unchanged beside them, because a surface with no press still reads those. */
  it("CONTROL: Cloud, a named computer, a stopped computer and an unknown holder keep their own sentences, each now saying what to press", async () => {
    const cloud = await rail(heldBy({ kind: "cloud", name: "ohmail Cloud", stopped: false }));
    expect(railTitle(cloud)).toBe(ts.filingElsewhereCloudHow);
    const local = await rail(heldBy({ kind: "local", name: "omarchy", stopped: false }));
    expect(railTitle(local)).toBe(ts.filingElsewhereLocalHow!.replace("{name}", "omarchy"));
    const stopped = await rail(heldBy({ kind: "local", name: "omarchy", stopped: true }));
    expect(railTitle(stopped)).toBe(ts.filingElsewhereStoppedHow!.replace("{name}", "omarchy"));
    const unknown = await rail(heldBy({ kind: "unknown", name: null, stopped: false }));
    expect(railTitle(unknown)).toBe(ts.filingElsewhereUnknownHow);
    /* Each `How` twin is its plain sentence plus a clause — not a rewording of it. */
    for (const [plain, how] of [
      ["filingElsewhereCloud", "filingElsewhereCloudHow"],
      ["filingElsewhereLocal", "filingElsewhereLocalHow"],
      ["filingElsewhereStopped", "filingElsewhereStoppedHow"],
      ["filingElsewhereStoppedUnknown", "filingElsewhereStoppedUnknownHow"],
      ["filingElsewhereUnknown", "filingElsewhereUnknownHow"],
    ]) expect(ts[how], how).toContain(ts[plain]!);
  });

  /* FILING-RAIL-SAYS-A-STOPPED-HOLDER-FILES: the stop arm was a named computer's alone, so a Cloud
     or unnamed holder that stopped was said to file this mailbox on its own schedule. */
  it("a stopped Cloud or unnamed holder files nothing, and the rail says so", async () => {
    const cloud = await rail(heldBy({ kind: "cloud", name: "ohmail Cloud", stopped: true }));
    expect(railTitle(cloud)).toBe(ts.filingElsewhereStoppedHow!.replace("{name}", "ohmail Cloud"));
    expect(railTitle(cloud), "a stopped Cloud was said to file").not.toBe(ts.filingElsewhereCloudHow);
    const unknown = await rail(heldBy({ kind: "unknown", name: null, stopped: true }));
    expect(railTitle(unknown)).toBe(ts.filingElsewhereStoppedUnknownHow);
    expect(railTitle(unknown), "a stopped install was said to file").not.toBe(ts.filingElsewhereUnknownHow);
  });

  it("reading along here silences the strip, and a different holder brings it back", async () => {
    const who = { kind: "local", name: "omarchy", stopped: false };
    const said = await rail(heldBy(who));
    expect(railTitle(said)).toBe(ts.filingElsewhereLocalHow!.replace("{name}", "omarchy"));
    setReadingAlong("mbx-1", { ...who, since: null }, null);
    const quiet = await rail(heldBy(who));
    expect(railTitle(quiet), "the strip went on saying it after the press")
      .not.toBe(ts.filingElsewhereLocalHow!.replace("{name}", "omarchy"));
    /* A DIFFERENT INSTALL MAY NEVER BE HIDDEN by an intention about the last one. */
    const other = await rail(heldBy({ kind: "local", name: "someone else", stopped: false }));
    expect(railTitle(other)).toBe(ts.filingElsewhereLocalHow!.replace("{name}", "someone else"));
    clearReadingAlong("mbx-1", null);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   SURFACES 2 AND 3 — `FirstRun`'s banner and its summary row
   ══════════════════════════════════════════════════════════════════════════════════════════ */

const READER: OnboardingMailbox = {
  organizerRole: "reader",
  organizedBy: null,
  organizerState: null,
  organizeConsentedAt: null,
  initialImportCompletedAt: null,
};

const holder = (kind: string, name: string): OnboardingMailbox => ({
  ...READER,
  organizedBy: { kind, name, since: "2026-08-30T09:00:00.000Z" },
  organizerState: "held",
});

const onboardingFacts = (mailbox: OnboardingMailbox): OnboardingFacts => ({
  door: "local",
  mailbox,
  account: { onboardingCompletedAt: null },
  ai: "unset",
  queuedSenders: 0,
});

const HOST: FirstRunHost = {
  door: "local",
  ai: "unset",
  probe: async () => ({ host: "h", user: "u", folders: 1 }),
  connect: async () => ({ id: "mb-1" }),
  organize: async () => "stored",
  complete: async () => { /* the summary's own verb */ },
  setAiEnabled: async () => { /* answered */ },
  probeReason: () => null,
  probeMessage: () => null,
};

interface FirstRunHarness {
  el: HTMLElement;
  press: (label: string) => Promise<void>;
  pick: (value: "here" | "read") => Promise<void>;
  heading: () => string;
}

async function firstRun(mailbox: OnboardingMailbox): Promise<FirstRunHarness> {
  const { FirstRun } = await import("../app/shell/FirstRun.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);

  const Stage = () => {
    const [, bump] = React.useState(0);
    return h(FirstRun as never, {
      host: HOST,
      facts: onboardingFacts(mailbox),
      onRefresh: () => bump((n) => n + 1),
      onLeave: () => { /* left */ },
      pull: { screened: 0, history: 0, mirrorCount: 0 },
      decide: null,
      mailboxId: "mb-1",
      /* Derived the way `AppShell` derives it: a real instant, so the dated arms are reachable
         and the phone arm cannot pass merely because there was no date to print. */
      organizedSince: "30 Aug 2026",
    } as never);
  };

  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(KeymapProvider as never, { children: h(Stage, null) } as never),
    }));
  });

  const press = async (label: string) => {
    const button = [...el.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").trim().startsWith(label));
    if (!button) {
      throw new Error(`no button labelled ${JSON.stringify(label)}; saw: `
        + [...el.querySelectorAll("button")].map((b) => JSON.stringify(b.textContent)).join(", "));
    }
    await act(async () => {
      button.click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
  };

  const pick = async (value: "here" | "read") => {
    const radios = [...el.querySelectorAll("input[type=radio]")] as HTMLInputElement[];
    const radio = radios.find((i) => i.value === value);
    if (!radio) throw new Error(`no ${JSON.stringify(value)} option`);
    await act(async () => { radio.click(); for (let i = 0; i < 4; i++) await Promise.resolve(); });
  };

  return { el, press, pick, heading: () => (el.querySelector("h1")?.textContent ?? "").trim() };
}

const t = (messages as unknown as { onboarding: Record<string, string> }).onboarding;

/** The banner's own description, by equality — `toContain` cannot separate these sentences. */
const bannerSaid = (el: HTMLElement): string =>
  (el.querySelector(".set-banner .lab span")?.textContent ?? "").trim();

describe("SURFACE 2 — the claim question's banner", () => {
  it("a phone holder gets the phone sentence, never the local one about 'this computer'", async () => {
    const s = await firstRun(holder("mobile", PHONE));
    expect(s.heading()).toBe(t.elsewhereTitle);
    expect(bannerSaid(s.el)).toBe(tm.readerHolderPhone!.replace("{name}", PHONE));
    expect(s.el.textContent ?? "", "a phone was described as a computer")
      .not.toContain(tm.readerSinceLocal!.replace("{since}", "30 Aug 2026").replace("{name}", PHONE));
  });

  it("a phone that has STOPPED gets the past-tense sentence, not `readerStopped`", async () => {
    const s = await firstRun({ ...holder("mobile", PHONE), organizerState: "stopped" });
    expect(bannerSaid(s.el)).toBe(tm.readerHolderPhoneStopped!.replace("{name}", PHONE));
    expect(bannerSaid(s.el), "the stopped phone took the holder-kind-blind sentence")
      .not.toBe(tm.readerStopped!.replace("{name}", PHONE));
  });

  it("CONTROL: a computer, Cloud and a stopped computer keep their sentences", async () => {
    const local = await firstRun(holder("local", "omarchy"));
    expect(bannerSaid(local.el))
      .toBe(tm.readerSinceLocal!.replace("{since}", "30 Aug 2026").replace("{name}", "omarchy"));
    const cloud = await firstRun(holder("cloud", "ohmail Cloud"));
    expect(bannerSaid(cloud.el)).toBe(tm.readerSinceCloud!.replace("{since}", "30 Aug 2026"));
    const stopped = await firstRun({ ...holder("local", "omarchy"), organizerState: "stopped" });
    expect(bannerSaid(stopped.el)).toBe(tm.readerStopped!.replace("{name}", "omarchy"));
  });
});

describe("SURFACE 3 — the reader summary's holder row", () => {
  /** The summary is reached the way a person reaches it: the claim question, answered "just read". */
  async function summary(mailbox: OnboardingMailbox): Promise<HTMLElement> {
    const s = await firstRun(mailbox);
    // A stopped holder's claim question carries its own title.
    expect(s.heading(), "the walk did not start on the claim question")
      .toBe(mailbox.organizerState === "stopped" ? t.elsewhereTitleStopped : t.elsewhereTitle);
    await s.pick("read");
    await s.press(t.continue!);
    expect(s.heading(), "the walk did not reach the reader summary").toBe(t.doneReaderTitle);
    return s.el;
  }

  /* The holder row is the SECOND of the summary's rows; the first reports what it reads. That
     position is asserted here so a row inserted above cannot move every case onto another
     sentence and leave them all still passing. */
  const rowSaid = (el: HTMLElement): string => {
    const rows = el.querySelectorAll(".ob-done .set-row");
    expect((rows[0]?.querySelector(".lab b")?.textContent ?? "").trim(),
      "the summary's rows moved — the holder row is no longer second").toBe(t.doneReaderReads);
    return (rows[1]?.querySelector(".lab span")?.textContent ?? "").trim();
  };

  it("a phone holder gets the phone sentence here too, from the same derivation", async () => {
    expect(rowSaid(await summary(holder("mobile", PHONE))))
      .toBe(tm.readerHolderPhone!.replace("{name}", PHONE));
  });

  it("a stopped phone is past tense here too — the two rows may not disagree", async () => {
    const el = await summary({ ...holder("mobile", PHONE), organizerState: "stopped" });
    expect(rowSaid(el)).toBe(tm.readerHolderPhoneStopped!.replace("{name}", PHONE));
  });

  it("CONTROL: a computer keeps the dated local sentence", async () => {
    expect(rowSaid(await summary(holder("local", "omarchy"))))
      .toBe(tm.readerSinceLocal!.replace("{since}", "30 Aug 2026").replace("{name}", "omarchy"));
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   SURFACE 4 — the restore card's producer line, the one surface with no room for the clause
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("SURFACE 4 — the restore card names the phone that saved the settings", () => {
  async function card(kind: string): Promise<HTMLElement> {
    const { ProfileImportCard } = await import("../app/shell/ProfileImportCard.js");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    roots.push(root);
    await act(async () => {
      root.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC",
        children: h(ProfileImportCard as never, {
          offer: {
            mailboxId: "mb-1",
            address: "someone@example.com",
            candidate: {
              state: "found",
              fingerprint: "a".repeat(64),
              updatedAt: "2026-08-10T09:00:00.000Z",
              producer: { kind, version: "0.18.0" },
              counts: { screener: 3, rules: 1, notifyRules: 0, tags: 0, awayResponder: false },
            },
          },
          phase: { kind: "offer" },
          onImport: () => { /* pressed elsewhere */ },
          onNotNow: () => { /* pressed elsewhere */ },
          onAcknowledge: () => { /* pressed elsewhere */ },
        } as never),
      }));
    });
    return el;
  }

  it("a phone's profile says a phone saved it, and the clause it has no room for is its title", async () => {
    const el = await card("mobile");
    const line = [...el.querySelectorAll("p.pfi-meta")]
      .find((p) => (p.textContent ?? "").trim() === tm.readerHolderPhoneShort);
    expect(line, "the card did not name the phone").toBeTruthy();
    expect(line!.getAttribute("title"), "the short form lost its clause")
      .toBe(tm.readerHolderPhoneWhy);
    expect(el.textContent ?? "", "a phone was described as another computer")
      .not.toContain("on another computer");
  });

  it("CONTROL: a computer and Cloud keep their own lines and gain no phone line", async () => {
    const local = await card("local");
    expect(local.textContent ?? "").toContain("on another computer");
    expect(local.textContent ?? "").not.toContain(tm.readerHolderPhoneShort!);
    const cloud = await card("cloud");
    expect(cloud.textContent ?? "").toContain("by ohmail Cloud");
    expect(cloud.textContent ?? "").not.toContain(tm.readerHolderPhoneShort!);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   AND WHAT TO PRESS — issue #5. Every sentence above names WHO and stopped there.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("the sentence says what to press", () => {
  /* THE DEFECT, AS A PROPERTY: a holder sentence that offers no way out. Of the desktop pane's
     arms only the NO-holder one told a person what to do, and those are not the rows anybody is
     stuck on. Watch it fail: return `key` from `holderSentence` without the `How` suffix and
     every case here reddens naming the sentence that names no verb. */
  /* ── A CLAUSE IS ADDED, NEVER SUBSTITUTED ─────────────────────────────────────────────────
     The first version of these keys REPLACED the reader clause with the press one, so "this
     computer reads the mailbox; it moves nothing and screens nothing" — the only sentence in the
     product that says what a reader install is not doing — went missing from every dated row.
     `organize-here.test.ts` caught it, naming that clause. Each `How` twin is its plain sentence
     plus a clause, and this is what says so in both catalogues. */
  it("every How twin CONTAINS its plain sentence, in both languages", () => {
    for (const [plain, how] of [
      ["readerSinceLocal", "readerSinceLocalHow"],
      ["readerSinceCloud", "readerSinceCloudHow"],
      ["readerSinceUnknown", "readerSinceUnknownHow"],
      ["readerStopped", "readerStoppedHow"],
    ]) {
      for (const [lang, cat] of [["en", tm], ["de", deM]] as Array<[string, Record<string, string>]>) {
        const trimmed = cat[plain]!.replace(/\.$/, "");
        expect(cat[how], `${lang}: ${how} does not carry ${plain}`).toContain(trimmed);
        expect(cat[how]!.length, `${lang}: ${how} adds nothing`).toBeGreaterThan(cat[plain]!.length);
      }
    }
  });

  it("every holder kind gets a verb clause when the surface has a press", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["readerSinceLocalHow", { kind: "local", name: "omarchy", since: "31 Aug 2026" }],
      ["readerSinceCloudHow", { kind: "cloud", name: null, since: "31 Aug 2026" }],
      ["readerSinceUnknownHow", { kind: "unknown", name: null, since: "31 Aug 2026" }],
      ["readerStoppedHow", { kind: "local", name: "omarchy", stopped: true }],
    ];
    for (const [key, who] of cases) {
      const said = holderSentence({ who: who as never, verb: "reclaim" });
      expect(said.key, JSON.stringify(who)).toBe(key);
      expect(tm[key], `${key} is not in the catalogue`).toBeTruthy();
      expect(tm[key], `${key} names no press`).toMatch(/press/i);
      expect(deM[key], `${key} is not in the German catalogue`).toBeTruthy();
    }
  });

  it("a surface with NO press keeps the sentence it had — the restore card's case", () => {
    for (const [plain, who] of [
      ["readerSinceLocal", { kind: "local", name: "omarchy", since: "31 Aug 2026" }],
      ["readerStopped", { kind: "local", name: "omarchy", stopped: true }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(holderSentence({ who: who as never, verb: "none" }).key).toBe(plain);
      expect(tm[plain], `${plain} gained a press it cannot offer`).not.toMatch(/press/i);
    }
  });

  it("the rail's table is the same bargain, in the strip's own words", () => {
    expect(filingElsewhereKey({ kind: "cloud" }, "takeover")).toBe("filingElsewhereCloudHow");
    expect(filingElsewhereKey({ kind: "local", name: "omarchy" }, "takeover"))
      .toBe("filingElsewhereLocalHow");
    expect(filingElsewhereKey({ kind: "local", name: "omarchy", stopped: true }, "takeover"))
      .toBe("filingElsewhereStoppedHow");
    expect(filingElsewhereKey({ kind: "cloud", name: "ohmail Cloud", stopped: true }, "takeover"))
      .toBe("filingElsewhereStoppedHow");
    expect(filingElsewhereKey({ kind: null, name: null, stopped: true }, "none"))
      .toBe("filingElsewhereStoppedUnknown");
    expect(filingElsewhereKey({ kind: null, name: null }, "takeover"))
      .toBe("filingElsewhereUnknownHow");
    /* No press on this door, no clause. */
    expect(filingElsewhereKey({ kind: "cloud" }, "none")).toBe("filingElsewhereCloud");
    for (const k of [
      "filingElsewhereLocalHow", "filingElsewhereStoppedHow", "filingElsewhereStoppedUnknownHow",
      "filingElsewhereCloudHow", "filingElsewhereUnknownHow",
    ]) {
      expect(ts[k], `${k} missing`).toBeTruthy();
      expect(deM === undefined).toBe(false);
    }
  });

  it("a phone still goes through the one phone table, verb or no verb", () => {
    const said = holderSentence({ who: { kind: "mobile", name: PHONE }, verb: "reclaim" });
    expect(said.key).toBe("readerHolderPhone");
    expect(holderSentence({ who: { kind: "mobile", name: PHONE }, verb: "none", voice: "short" }).key)
      .toBe("readerHolderPhoneShort");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   READING ALONG ON PURPOSE — the sentence is right, the repetition is not
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("reading along on purpose", () => {
  const WHO = { kind: "local", name: "omarchy", stopped: false, since: "2026-08-31T00:00:00.000Z" };
  const OWNER = "acct-1";
  afterEach(() => { try { globalThis.localStorage.clear(); } catch { /* no jar */ } });

  it("set -> silenced; a DIFFERENT holder -> said again", () => {
    expect(readingAlong("mb-1", WHO, OWNER)).toBe(false);
    setReadingAlong("mb-1", WHO, OWNER);
    expect(readingAlong("mb-1", WHO, OWNER), "the press did not silence it").toBe(true);
    /* The same install, re-becoming: `since` moves, so the sentence comes back. A false positive
       that FAILS SAFE — it speaks about a holder that may be new rather than staying quiet. */
    expect(readingAlong("mb-1", { ...WHO, since: "2026-09-01T00:00:00.000Z" }, OWNER)).toBe(false);
    /* A different machine entirely, which is the case this may never hide. */
    expect(readingAlong("mb-1", { ...WHO, name: "someone else" }, OWNER)).toBe(false);
    /* And it is per mailbox. */
    expect(readingAlong("mb-2", WHO, OWNER)).toBe(false);
  });

  it("a press withdraws it, which is what a refused press calls", () => {
    setReadingAlong("mb-1", WHO, OWNER);
    clearReadingAlong("mb-1", OWNER);
    expect(readingAlong("mb-1", WHO, OWNER)).toBe(false);
  });

  it("no holder, no intention: nothing to read along WITH", () => {
    expect(holderFingerprint(null)).toBeNull();
    setReadingAlong("mb-1", null, OWNER);
    expect(readingAlong("mb-1", WHO, OWNER)).toBe(false);
  });

  it("a name with the separator in it cannot impersonate another holder", () => {
    const a = { kind: "local", name: 'a", "b', stopped: false, since: "x" };
    const b = { kind: "local", name: "a", stopped: false, since: 'b", "x' };
    expect(holderFingerprint(a)).not.toBe(holderFingerprint(b));
  });
});
