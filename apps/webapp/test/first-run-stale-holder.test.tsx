/** @vitest-environment jsdom */
import { describe, expect, it, afterEach } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import deCatalogue from "../../../packages/app/messages/mailboxes.de.json" with { type: "json" };
import { holderStopped } from "@ohmail/app-logic/reading/reader-holder";
import type { OnboardingMailbox } from "@ohmail/app-logic/doors/onboarding";
import type { FirstRunRow } from "@ohmail/app-logic/mailboxes/first-run/ground";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { M, O, id } from "../../../packages/app/test/mailboxes/connect/support.js";
import { mountStage } from "./_first-run-stage.js";

/**
 * THE CLAIM QUESTION OVER A HOLDER THAT STOPPED CHECKING IN (desktop 0.25.1).
 * The banner said the other install had stopped; the lead said the mailbox had an organizer, and
 * both choices promised that install would stop "on its next pass" or "keep organizing". A person
 * who took "Just read it here" left the mailbox organized by nobody. The lease's `stopped` verdict
 * reaches the screen as `organizerState`, and `holderStopped` is the one reading of it.
 * HOW TO WATCH IT FAIL: make `holderStopped` answer `false` — the stale cases go red.
 *
 * RE-POINTED (the switch's older tests, sorted once): the run is the new frame's first-run stage
 * (`packages/app/src/mailboxes/first-run`) over a ground the case moves (`_first-run-stage.tsx`), its
 * words the stage's catalogue; a choice is the claim question's radio by its name; the lead is the step's line. The
 * census reads the step where the new stage says it (`Elsewhere.tsx`) and reads the holder's state
 * (`use-agree.ts`), today's first run not walked while it still stands. Every expectation is as it stood.
 */

const t = O;
const tm = M;
const de = deCatalogue;
const NAME = "Office laptop";

const NOBODY: OnboardingMailbox = {
  organizerRole: "reader",
  organizedBy: null,
  organizerState: null,
  organizeConsentedAt: null,
  initialImportCompletedAt: null,
};
const LIVE: OnboardingMailbox = {
  ...NOBODY,
  organizedBy: { kind: "local", name: NAME, since: "2026-09-01T09:00:00.000Z" },
  organizerState: "held",
};
const STALE: OnboardingMailbox = { ...LIVE, organizerState: "stopped" };

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

/** The row the ground hands: the account's id and address beside exactly the case's facts. */
const rowOf = (mailbox: OnboardingMailbox): FirstRunRow =>
  ({ id: id("mb-1"), address: "me@example.invalid", holderSince: "1 Sept 2026", ...mailbox }) as FirstRunRow;

async function mount(mailbox: OnboardingMailbox) {
  let current = rowOf(mailbox);
  const organizedWith: unknown[] = [];
  const st = await mountStage({
    rows: [current],
    door: "local",
    live: () => [current],
    verbs: {
      ai: "unset",
      organize: async (_id, body) => {
        organizedWith.push(body);
        current = { ...current, organizeConsentedAt: "2026-09-26T05:40:00.000Z" };
        return "stored";
      },
      complete: async () => { /* stamped */ },
      setAiEnabled: async () => { /* answered */ },
    },
  });
  const el = st.el;
  const NAMES = { here: [t.elsewhereChoiceHere, t.elsewhereChoiceHereStopped], read: [t.elsewhereChoiceRead] };
  const radios = (): HTMLElement[] => [...el.querySelectorAll<HTMLElement>("[role=radio]")];
  const valueOf = (r: HTMLElement): "here" | "read" | null => {
    const name = (r.querySelector(".oh-radioline-word")?.textContent ?? "").trim();
    return NAMES.here.includes(name) ? "here" : NAMES.read.includes(name) ? "read" : null;
  };
  return {
    heading: st.heading,
    /** The step's lead: the line under its sentence. */
    lead: () => (el.querySelector("h1")?.closest("main")?.querySelector(".oh-page-line")?.textContent ?? "").trim(),
    text: () => el.textContent ?? "",
    picked: () => {
      const on = radios().find((r) => r.getAttribute("aria-checked") === "true");
      return on ? valueOf(on) : null;
    },
    pick: async (value: "here" | "read") => {
      const radio = radios().find((r) => valueOf(r) === value);
      if (!radio) throw new Error(`no ${value} option`);
      await act(async () => { radio.click(); for (let i = 0; i < 4; i++) await Promise.resolve(); });
    },
    press: async (label: string) => {
      const button = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(label));
      if (!button) throw new Error(`no button labelled ${JSON.stringify(label)}`);
      await act(async () => { button.click(); for (let i = 0; i < 12; i++) await Promise.resolve(); });
    },
    organizedWith,
  };
}

const with_ = (s: string) => s.replace("{name}", NAME);

describe("the claim question tells the lease's state", () => {
  it("LIVE holder: today's lead and choices, and no stopped sentence", async () => {
    const s = await mount(LIVE);
    expect(s.heading()).toContain(t.elsewhereSay.replace("{name}", "").replace(/\.$/, "").trim());
    expect(s.lead()).toBe("");
    expect(s.text()).toContain(with_("{name} stops organizing on its next pass — within a minute — and becomes a reader: it keeps its copy of your mail and moves nothing. Your rules and the away responder travel with the mailbox."));
    expect(s.text()).not.toContain(with_("This install reads, searches and sends. {name} keeps organizing. You can take over later from Settings → Mailboxes."));
    expect(s.text()).not.toContain("The install that organized this mailbox has stopped checking in, so nothing organizes it now.");
    expect(s.text()).not.toContain(with_("This install takes the mailbox over and starts screening new mail. There is no hand-over to wait for: {name} stopped checking in."));
    expect(s.text()).not.toContain("This install reads, searches and sends. Nothing organizes the mailbox then: new mail waits in the inbox. You can take over later from Settings → Mailboxes.");
    // Over a live holder the person picks: nothing is pre-selected.
    expect(s.picked()).toBeNull();
  });

  it("STALE holder: named as stopped, no hand-off promised, reading leaves nobody organizing", async () => {
    const s = await mount(STALE);
    expect(s.heading(), "the title still said the mailbox is organized elsewhere").toBe(with_(t.elsewhereSayStopped).replace(/\.$/, ""));
    expect(s.lead()).toBe("");
    expect(s.text()).toContain(with_(tm.readerStopped));
    expect(s.text()).toContain(t.elsewhereChoiceHereStopped);
    expect(s.text()).not.toContain(with_("This install takes the mailbox over and starts screening new mail. There is no hand-over to wait for: {name} stopped checking in."));
    expect(s.text()).not.toContain("This install reads, searches and sends. Nothing organizes the mailbox then: new mail waits in the inbox. You can take over later from Settings → Mailboxes.");
    expect(s.text(), "a stopped install was promised a pass").not.toContain("next pass");
    expect(s.text(), "a stopped install was said to keep organizing").not.toContain("keeps organizing");
    expect(s.text()).not.toContain("This mailbox already has an organizer. Two installs never organize one mailbox at once.");
    expect(s.picked(), "organizing here is not the default over a stopped holder").toBe("here");
  });

  it("STALE holder, the default taken: the run goes on to take the lease", async () => {
    const s = await mount(STALE);
    await s.press(t.continue);
    expect(s.heading()).toContain(t.organizeLast.split("<window>")[0]!.trim());
    expect(s.heading()).toContain(t.organizeLast.split("<window>")[0]!.trim());
    await s.press(t.agree);
    expect(s.organizedWith.length, "the default press did not ask for the mailbox").toBe(1);
  });

  it("STALE holder, 'Just read it here': the summary says nothing organizes it", async () => {
    const s = await mount(STALE);
    await s.pick("read");
    await s.press(t.continue);
    expect(s.heading()).toBe(t.doneReaderTitle);
    expect(s.text()).not.toContain("Reading, searching, marking read and sending all work. It moves nothing and screens nothing, and the organizer below has stopped, so new mail waits in the inbox.");
    expect(s.text()).not.toContain("Settings → Mailboxes has the button. Nothing has to hand the mailbox over first.");
    expect(s.text(), "the summary sent the work to a stopped organizer").not.toContain("Reading, searching, marking read and sending all work. It moves nothing and screens nothing — the organizer below does that.");
    expect(s.text()).not.toContain("Settings → Mailboxes has the button. Whatever organizes it then becomes a reader and keeps its copy of your mail.");
    expect(s.organizedWith).toEqual([]);
  });

  it("STALE holder with no name: the choices name 'another install'", async () => {
    const s = await mount({ ...STALE, organizedBy: { kind: "local", name: "", since: null } });
    expect(s.heading()).toBe(t.elsewhereSayStopped.replace("{name}", tm.readerHolderUnknown).replace(/\.$/, ""));
    expect(s.text()).not.toContain("This install takes the mailbox over and starts screening new mail. There is no hand-over to wait for: {name} stopped checking in.".replace("{name}", tm.readerHolderUnknown));
  });

  it("NO holder: the question is not asked at all", async () => {
    const s = await mount(NOBODY);
    expect(s.heading()).toContain(t.organizeLast.split("<window>")[0]!.trim());
    expect(s.text()).not.toContain("This mailbox already has an organizer. Two installs never organize one mailbox at once.");
    expect(s.text()).not.toContain("The install that organized this mailbox has stopped checking in, so nothing organizes it now.");
  });

  it("CONTROL: LIVE holder's reader summary keeps today's sentences", async () => {
    const s = await mount(LIVE);
    await s.pick("read");
    await s.press(t.continue);
    expect(s.text()).not.toContain("Reading, searching, marking read and sending all work. It moves nothing and screens nothing — the organizer below does that.");
    expect(s.text()).not.toContain("Reading, searching, marking read and sending all work. It moves nothing and screens nothing, and the organizer below has stopped, so new mail waits in the inbox.");
  });
});

describe("holderStopped reads the decider's stop and nothing else", () => {
  it("a named holder whose lease stopped is the only yes; held, not-looked, nobody and no row are no", () => {
    const by = { kind: "local", name: "W", since: null };
    expect(holderStopped({ organizedBy: by, organizerState: "stopped" })).toBe(true);
    expect(holderStopped({ organizedBy: by, organizerState: "held" })).toBe(false);
    expect(holderStopped({ organizedBy: by, organizerState: null })).toBe(false);
    expect(holderStopped({ organizedBy: null, organizerState: "stopped" }), "nobody named is not a stop").toBe(false);
    expect(holderStopped({})).toBe(false);
    expect(holderStopped(null)).toBe(false);
  });

  it("both catalogues carry every stopped twin, with {name} where the live one has it", () => {
    for (const deck of [t, de.onboarding]) {
      expect(deck.elsewhereSay).toContain("{name}");
      expect(deck.elsewhereSayStopped).toContain("{name}");
      expect(deck.elsewhereSayStopped).not.toBe(deck.elsewhereSay);
      expect(deck.elsewhereChoiceHereStopped).toBeTruthy();
    }
  });
});

/**
 * THE CENSUS: every surface that shows the claim question reads the one predicate. The web and the
 * desktop share the step (`AppShell` renders `FirstRun`); the phone's door has no such step. So the
 * step's sentences live in exactly one source file across the four roots, and that file reads the
 * holder's state only through `holderStopped`. A new surface showing the step lands here.
 */
describe("census: one step, one predicate", () => {
  const REPO = join(__dirname, "..", "..", "..");
  const ROOTS = ["apps/webapp/app", "packages/app-logic/src", "packages/app/src", "packages/letter-body/src", "apps/desktop/src", "apps/paired-page/src", "apps/mobile/app", "apps/mobile/src"];
  /* Today's first run leaves with the switch (FOR-S7 group 5) and no host mounts it: the step is the new stage's now,
     and the file is not walked while it still stands. */
  const LEAVING = new Set(["apps/webapp/app/shell/FirstRun.tsx"]);
  const KEYS = [
    "elsewhereSay", "elsewhereSayStopped",
  ];
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "build" || name === ".next") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name) && !LEAVING.has(relative(REPO, p))) out.push(p);
    }
    return out;
  };
  const files = ROOTS.flatMap((r) => walk(join(REPO, r)));
  const code = (p: string) => withoutComments(readFileSync(p, "utf8"));

  /* The stage names a sentence by its namespace too (`"onboarding.elsewhereLead"`). */
  it("the step's sentences are rendered by FirstRun.tsx alone", () => {
    expect(files.length, "the walk read nothing").toBeGreaterThan(100);
    const sites = files
      .filter((p) => KEYS.some((k) => code(p).includes(`"${k}"`) || code(p).includes(`"onboarding.${k}"`)))
      .map((p) => relative(REPO, p));
    expect(sites).toEqual(["packages/app/src/mailboxes/first-run/Elsewhere.tsx"]);
  });

  /* The step's state is read where the stage decides it (`use-agree.ts`) and drawn by `Elsewhere.tsx`. */
  it("FirstRun.tsx reads the holder's state only through holderStopped", () => {
    const src = code(join(REPO, "packages/app-logic/src/mailboxes/first-run/use-agree.ts"));
    const drawn = code(join(REPO, "packages/app/src/mailboxes/first-run/Elsewhere.tsx"));
    expect(src).toMatch(/holderStopped\(facts\.mailbox\)/);
    expect(src.match(/organizerState/g) ?? [], "an inline reading of the lease state").toEqual([]);
    expect(drawn.match(/organizerState/g) ?? [], "an inline reading of the lease state").toEqual([]);
  });

});
