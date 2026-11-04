/** @vitest-environment jsdom */
import { describe, expect, it, afterEach } from "vitest";
import * as React from "react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { FirstRun } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import { holderStopped } from "../app/shell/reader-holder";
import type { FirstRunHost } from "../app/shell/first-run-host";
import type { OnboardingFacts, OnboardingMailbox } from "../app/shell/onboarding";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * THE CLAIM QUESTION OVER A HOLDER THAT STOPPED CHECKING IN (desktop 0.25.1).
 * The banner said the other install had stopped; the lead said the mailbox had an organizer, and
 * both choices promised that install would stop "on its next pass" or "keep organizing". A person
 * who took "Just read it here" left the mailbox organized by nobody. The lease's `stopped` verdict
 * reaches the screen as `organizerState`, and `holderStopped` is the one reading of it.
 * HOW TO WATCH IT FAIL: make `holderStopped` answer `false` — the stale cases go red.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const t = messages.onboarding;
const tm = messages.mailboxes;
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

const facts = (mailbox: OnboardingMailbox): OnboardingFacts => ({
  door: "local", mailbox, account: { onboardingCompletedAt: null }, ai: "unset", queuedSenders: 0,
});

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => { for (const r of roots.splice(0)) r.unmount(); });
  document.body.innerHTML = "";
});

async function mount(mailbox: OnboardingMailbox) {
  let current = facts(mailbox);
  const organizedWith: unknown[] = [];
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  const host: FirstRunHost = {
    door: "local",
    ai: current.ai,
    probe: async () => ({ host: "h", user: "u", folders: 1 }),
    connect: async () => ({ id: "mb-1" }),
    organize: async (_id, body) => {
      organizedWith.push(body);
      current = { ...current, mailbox: { ...current.mailbox!, organizeConsentedAt: "2026-09-26T05:40:00.000Z" } };
      return "stored";
    },
    complete: async () => { /* stamped */ },
    setAiEnabled: async () => { /* answered */ },
    probeReason: () => null,
    probeMessage: () => null,
  };
  const Stage = () => {
    const [, bump] = React.useState(0);
    return h(FirstRun, {
      host, facts: current, onRefresh: () => bump((n) => n + 1), onLeave: () => { /* left */ },
      pull: { screened: 0, history: 0, pulled: 0 }, decide: null, mailboxId: "mb-1",
      organizedSince: "1 Sept 2026",
    });
  };
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(KeymapProvider, { children: h(Stage, null) }),
    }));
  });
  const radios = (): HTMLInputElement[] => [...el.querySelectorAll("input[type=radio]")] as HTMLInputElement[];
  return {
    heading: () => (el.querySelector("h1")?.textContent ?? "").trim(),
    lead: () => (el.querySelector("p.sub")?.textContent ?? "").trim(),
    text: () => el.textContent ?? "",
    picked: () => radios().find((i) => i.checked)?.value ?? null,
    pick: async (value: "here" | "read") => {
      const radio = radios().find((i) => i.value === value);
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
    expect(s.heading()).toBe(t.elsewhereTitle);
    expect(s.lead()).toBe(t.elsewhereLead);
    expect(s.text()).toContain(with_(t.elsewhereChoiceHereWhy));
    expect(s.text()).toContain(with_(t.elsewhereChoiceReadWhy));
    expect(s.text()).not.toContain(t.elsewhereLeadStopped);
    expect(s.text()).not.toContain(with_(t.elsewhereChoiceHereStoppedWhy));
    expect(s.text()).not.toContain(t.elsewhereChoiceReadStoppedWhy);
    // Over a live holder the person picks: nothing is pre-selected.
    expect(s.picked()).toBeNull();
  });

  it("STALE holder: named as stopped, no hand-off promised, reading leaves nobody organizing", async () => {
    const s = await mount(STALE);
    expect(s.heading(), "the title still said the mailbox is organized elsewhere").toBe(t.elsewhereTitleStopped);
    expect(s.lead(), "the lead still said the mailbox has an organizer").toBe(t.elsewhereLeadStopped);
    expect(s.text()).toContain(with_(tm.readerStopped));
    expect(s.text()).toContain(t.elsewhereChoiceHereStopped);
    expect(s.text()).toContain(with_(t.elsewhereChoiceHereStoppedWhy));
    expect(s.text()).toContain(t.elsewhereChoiceReadStoppedWhy);
    expect(s.text(), "a stopped install was promised a pass").not.toContain("next pass");
    expect(s.text(), "a stopped install was said to keep organizing").not.toContain("keeps organizing");
    expect(s.text()).not.toContain(t.elsewhereLead);
    expect(s.picked(), "organizing here is not the default over a stopped holder").toBe("here");
  });

  it("STALE holder, the default taken: the run goes on to take the lease", async () => {
    const s = await mount(STALE);
    await s.press(t.continue);
    expect(s.heading()).toBe(t.consentTitle);
    await s.press(t.continue);
    expect(s.heading()).toBe(t.windowTitle);
    await s.press(t.agree);
    expect(s.organizedWith.length, "the default press did not ask for the mailbox").toBe(1);
  });

  it("STALE holder, 'Just read it here': the summary says nothing organizes it", async () => {
    const s = await mount(STALE);
    await s.pick("read");
    await s.press(t.continue);
    expect(s.heading()).toBe(t.doneReaderTitle);
    expect(s.text()).toContain(t.doneReaderReadsWhyStopped);
    expect(s.text()).toContain(t.doneReaderClaimWhyStopped);
    expect(s.text(), "the summary sent the work to a stopped organizer").not.toContain(t.doneReaderReadsWhy);
    expect(s.text()).not.toContain(t.doneReaderClaimWhy);
    expect(s.organizedWith).toEqual([]);
  });

  it("STALE holder with no name: the choices name 'another install'", async () => {
    const s = await mount({ ...STALE, organizedBy: { kind: "local", name: "", since: null } });
    expect(s.heading()).toBe(t.elsewhereTitleStopped);
    expect(s.text()).toContain(t.elsewhereChoiceHereStoppedWhy.replace("{name}", tm.readerHolderUnknown));
  });

  it("NO holder: the question is not asked at all", async () => {
    const s = await mount(NOBODY);
    expect(s.heading()).toBe(t.consentTitle);
    expect(s.text()).not.toContain(t.elsewhereLead);
    expect(s.text()).not.toContain(t.elsewhereLeadStopped);
  });

  it("CONTROL: LIVE holder's reader summary keeps today's sentences", async () => {
    const s = await mount(LIVE);
    await s.pick("read");
    await s.press(t.continue);
    expect(s.text()).toContain(t.doneReaderReadsWhy);
    expect(s.text()).not.toContain(t.doneReaderReadsWhyStopped);
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
    const twins = [
      "elsewhereTitleStopped", "elsewhereLeadStopped", "elsewhereChoiceHereStopped",
      "elsewhereChoiceHereStoppedWhy", "elsewhereChoiceReadStoppedWhy",
      "doneReaderReadsWhyStopped", "doneReaderClaimWhyStopped",
    ] as const;
    for (const k of twins) {
      expect(t[k], `en ${k}`).toBeTruthy();
      expect(de.onboarding[k], `de ${k}`).toBeTruthy();
    }
    expect(t.elsewhereChoiceHereStoppedWhy).toContain("{name}");
    expect(de.onboarding.elsewhereChoiceHereStoppedWhy).toContain("{name}");
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
  const ROOTS = ["apps/webapp/app", "apps/desktop/src", "apps/mobile/app", "apps/mobile/src"];
  const KEYS = [
    "elsewhereLead", "elsewhereLeadStopped", "elsewhereChoiceHereWhy", "elsewhereChoiceHereStoppedWhy",
    "elsewhereChoiceReadWhy", "elsewhereChoiceReadStoppedWhy",
  ];
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "build" || name === ".next") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  };
  const files = ROOTS.flatMap((r) => walk(join(REPO, r)));
  const code = (p: string) => withoutComments(readFileSync(p, "utf8"));

  it("the step's sentences are rendered by FirstRun.tsx alone", () => {
    expect(files.length, "the walk read nothing").toBeGreaterThan(100);
    const sites = files
      .filter((p) => KEYS.some((k) => code(p).includes(`"${k}"`)))
      .map((p) => relative(REPO, p));
    expect(sites).toEqual(["apps/webapp/app/shell/FirstRun.tsx"]);
  });

  it("FirstRun.tsx reads the holder's state only through holderStopped", () => {
    const src = code(join(REPO, "apps/webapp/app/shell/FirstRun.tsx"));
    expect(src).toMatch(/holderStopped\(facts\.mailbox\)/);
    expect(src.match(/organizerState/g) ?? [], "an inline reading of the lease state").toEqual([]);
  });

  it("the desktop reaches the step through the shared shell", () => {
    expect(code(join(REPO, "apps/desktop/src/DesktopGate.tsx")))
      .toMatch(/import \{ AppShell \} from "\.\.\/\.\.\/webapp\/app\/shell\/AppShell"/);
    expect(code(join(REPO, "apps/webapp/app/shell/AppShell.tsx"))).toMatch(/<FirstRun\b/);
  });
});
