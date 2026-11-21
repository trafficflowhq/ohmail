/** @vitest-environment jsdom */
import { describe, expect, it, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { readEngineAsOneText } from "../../../test/support/engine-unit.js";
import { act, cleanup } from "@testing-library/react";
import de from "../../../packages/app/messages/mailboxes.de.json" with { type: "json" };
import { HOLDER_CHECK_MS, HOLDER_REREAD_MS } from "@ohmail/app-logic/mailboxes/first-run/rules";
import { holderAnswered } from "@ohmail/app-logic/reading/reader-holder";
import type { FirstRunOrganizeOutcome } from "@ohmail/app-logic/doors/first-run-host";
import type { OnboardingMailbox } from "@ohmail/app-logic/doors/onboarding";
import type { FirstRunRow } from "@ohmail/app-logic/mailboxes/first-run/ground";
import { O, id } from "../../../packages/app/test/mailboxes/connect/support.js";
import { mountStage } from "./_first-run-stage.js";

/**
 * SETUP WAITS FOR THE FIRST LOOK AT WHO HOLDS THE MAILBOX. A second computer's
 * How-far-back step offered "Agree and start organizing" for 11-26 s before the claim question
 * landed, and a press in that window took a live organizer's mailbox (0.30.5, 1 of 4 adds). The
 * consent step now shows a waiting panel while the door says it has not looked
 * (`organizerChecked: false`) and reads again every two seconds; a live holder lands on the claim
 * question, and only "Organize here instead" sends the takeover verb. HOW TO WATCH IT FAIL: make
 * `holderAnswered` answer `true` — the waiting cases go red.
 *
 * RE-POINTED (the switch's older tests, sorted once): the run is the new frame's first-run stage
 * (`packages/app/src/mailboxes/first-run`, its wait `use-holder-wait.ts`, its bounds `rules.ts`) over a ground
 * the case moves (`_first-run-stage.tsx`; a re-read is the ground's refresh), its words the stage's
 * catalogue (`packages/app/messages/mailboxes.*.json`); the census reads the presses where the new stage makes
 * them. Every expectation is as it stood.
 */

const t = O;

const UNLOOKED: OnboardingMailbox = {
  organizerRole: "reader", organizedBy: null, organizerState: null, organizerChecked: false,
  organizeConsentedAt: null, initialImportCompletedAt: null,
};
const NOBODY: OnboardingMailbox = { ...UNLOOKED, organizerChecked: undefined };
const LIVE: OnboardingMailbox = {
  ...NOBODY, organizedBy: { kind: "local", name: "W-live", since: "2026-09-26T08:00:00.000Z" },
  organizerState: "held", organizerEventAt: "2026-09-26T08:17:50.000Z",
};
const STOPPED: OnboardingMailbox = { ...LIVE, organizerState: "stopped" };

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

/** The row the ground hands: the account's id and address beside exactly the case's facts. */
const rowOf = (mailbox: OnboardingMailbox): FirstRunRow =>
  ({ id: id("mb-1"), address: "me@example.invalid", holderSince: "26 Sept 2026", ...mailbox }) as FirstRunRow;

async function mount(
  first: OnboardingMailbox, answer: () => FirstRunOrganizeOutcome = () => "stored",
  /** What a re-read answers with; counted in `reads`. */
  refresh: () => void | Promise<void> = () => undefined,
) {
  let current = rowOf(first);
  const organizedWith: Array<Record<string, unknown>> = [];
  const reads = { count: 0 };
  const st = await mountStage({
    rows: [current],
    door: "local",
    live: () => [current],
    refresh: async () => { reads.count += 1; await refresh(); },
    verbs: {
      ai: "unset",
      organize: async (_id, body) => {
        organizedWith.push(body as Record<string, unknown>);
        const out = answer();
        if (out === "stored") current = { ...current, organizeConsentedAt: "2026-09-26T08:18:00.000Z" };
        return out;
      },
      complete: async () => { /* stamped */ },
      setAiEnabled: async () => { /* answered */ },
    },
  });
  const el = st.el;
  const button = (label: string) =>
    [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(label)) as HTMLButtonElement | undefined;
  /** The claim question's radios by their names (the stopped holder's "here" has its own). */
  const NAMES = { here: [t.elsewhereChoiceHere, t.elsewhereChoiceHereStopped], read: [t.elsewhereChoiceRead] };
  return {
    heading: st.heading,
    text: () => el.textContent ?? "",
    agree: () => button(t.agree),
    press: async (label: string) => {
      const b = button(label);
      if (!b) throw new Error(`no button labelled ${JSON.stringify(label)}`);
      await act(async () => { b.click(); for (let i = 0; i < 12; i++) await Promise.resolve(); });
    },
    /** A choice on the claim question, as a click on its radio. */
    pick: async (value: "here" | "read") => {
      const radio = [...el.querySelectorAll<HTMLElement>("[role=radio]")].find((r) =>
        NAMES[value].includes((r.querySelector(".oh-radioline-word")?.textContent ?? "").trim()));
      if (!radio) throw new Error(`no ${value} option`);
      await act(async () => { radio.click(); for (let i = 0; i < 4; i++) await Promise.resolve(); });
    },
    /** Enter on the step's form — the keyboard's road to the same press. */
    submit: async () => {
      await act(async () => {
        el.querySelector("h1")?.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });
    },
    /** The door's next read, as the shell's poll delivers it. */
    read: async (mailbox: OnboardingMailbox) => {
      current = { ...rowOf(mailbox), organizeConsentedAt: current.organizeConsentedAt };
      await st.move([current]);
    },
    /** Time passing, as the stage's timers see it. */
    wait: async (ms: number) => {
      await act(async () => { vi.advanceTimersByTime(ms); for (let i = 0; i < 12; i++) await Promise.resolve(); });
    },
    button,
    organizedWith,
    reads,
  };
}

/** Consent, then Continue to How far back. */
async function toWindow(s: Awaited<ReturnType<typeof mount>>) {
  expect(s.heading()).toBe(t.mapTitle);
  await s.press(t.continue);
  expect(s.heading()).toContain(t.organizeLast.split("<window>")[0]!.trim());
}

/** The waiting panel stands where the consent statement would: no statement, no way forward. */
function waiting(s: Awaited<ReturnType<typeof mount>>, line: string = t.windowCheckingHolder) {
  expect(s.heading(), "the consent step showed before the look answered").toBe(t.resumeCheckingTitle);
  expect(s.text()).toContain(line);
  expect(s.text(), "the consent statement was on screen").not.toContain("ohmail re-arranges your existing inbox. The Ohbox is your Inbox itself, so that mail stays where it is; the rest moves into folders ohmail creates inside an ohmail folder in your mailbox: News, Receipts, Screener, Screened and Quarantine. They are ordinary IMAP folders — every other mail client sees them too, and you can leave any time with your mail exactly where it is.");
  expect(s.button(t.continue)?.disabled, "Continue was offered before anybody looked").toBe(true);
  expect(s.agree(), "Agree was offered before anybody looked").toBeUndefined();
}

describe("setup waits for the first look before it asks for consent", () => {
  it("before the look answers, the waiting panel stands in for the consent statement and no press goes anywhere", async () => {
    const s = await mount(UNLOOKED);
    waiting(s);
    await s.press(t.continue);
    await s.submit();
    waiting(s);
    expect(s.organizedWith, "a press before the look reached the door").toEqual([]);
  });

  it("while it waits it reads again every two seconds, one read at a time, and stops at the bound", async () => {
    vi.useFakeTimers();
    let hold = true;
    let answer: () => void = () => undefined;
    const s = await mount(UNLOOKED, undefined, () => (hold ? new Promise<void>((r) => { answer = r; }) : undefined));
    const before = s.reads.count;
    await s.wait(HOLDER_REREAD_MS);
    expect(s.reads.count - before, "no read after two seconds").toBe(1);
    for (let i = 0; i < 3; i++) await s.wait(HOLDER_REREAD_MS);
    expect(s.reads.count - before, "a read went out while one was still in flight").toBe(1);
    hold = false;
    await act(async () => { answer(); for (let i = 0; i < 12; i++) await Promise.resolve(); });
    for (let i = 0; i < 3; i++) await s.wait(HOLDER_REREAD_MS);
    expect(s.reads.count - before, "it did not read every two seconds").toBe(4);
    for (let i = 0; i * HOLDER_REREAD_MS <= HOLDER_CHECK_MS; i++) await s.wait(HOLDER_REREAD_MS);
    const atBound = s.reads.count;
    for (let i = 0; i < 5; i++) await s.wait(HOLDER_REREAD_MS);
    expect(s.reads.count, "it went on reading past the bound").toBe(atBound);
    waiting(s, t.holderCheckSlow);
  });

  it("the look lands a LIVE holder: the claim question with no consent in between, and Organize here instead names the takeover", async () => {
    const s = await mount(UNLOOKED);
    waiting(s);
    await s.read(LIVE);
    expect(s.heading(), "the claim question did not come").toContain(t.elsewhereSay.replace("{name}", "").replace(/\.$/, "").trim());
    await s.pick("here");
    await s.press(t.continue);
    await s.press(t.continue);
    expect(s.heading()).toContain(t.organizeLast.split("<window>")[0]!.trim());
    await s.press(t.agree);
    expect(s.organizedWith.map((b) => b.intent)).toEqual(["takeover"]);
  });

  it("CONTROL: the look lands nobody: the consent statement, then Agree is offered and the press is a join", async () => {
    const s = await mount(UNLOOKED);
    waiting(s);
    await s.read(NOBODY);
    await toWindow(s);
    expect(s.text()).not.toContain(t.windowCheckingHolder);
    expect(s.agree()?.disabled).toBe(false);
    await s.press(t.agree);
    expect(s.organizedWith.map((b) => b.intent)).toEqual(["join"]);
  });

  it("CONTROL: the look lands a STOPPED holder — the claim question, and its default still claims", async () => {
    const s = await mount(UNLOOKED);
    waiting(s);
    await s.read(STOPPED);
    expect(s.heading()).toBe(t.elsewhereSayStopped.replace("{name}", "W-live").replace(/\.$/, ""));
    await s.press(t.continue);
    await s.press(t.continue);
    await s.press(t.agree);
    expect(s.organizedWith.map((b) => b.intent)).toEqual(["takeover"]);
  });

  it("the door refuses over a holder the screen had not seen: nothing stored, it waits for the holder's name, then the claim question", async () => {
    let refuse = true;
    const s = await mount(NOBODY, () => (refuse ? "held" : "stored"));
    await toWindow(s);
    // The door has read the holder the window's facts do not show yet, and refuses the join.
    await s.press(t.agree);
    refuse = false;
    waiting(s);
    await s.read(NOBODY);
    waiting(s);
    await s.read(LIVE);
    expect(s.organizedWith.map((b) => b.intent)).toEqual(["join"]);
    expect(s.heading()).toContain(t.elsewhereSay.replace("{name}", "").replace(/\.$/, "").trim());
  });

  it("the door could not look: it says so, nothing is stored and the window stays", async () => {
    const s = await mount(NOBODY, () => "unchecked");
    await toWindow(s);
    await s.press(t.agree);
    expect(s.text()).toContain(t.holderCheckSlow);
    expect(s.heading()).toContain(t.organizeLast.split("<window>")[0]!.trim());
    expect(s.text(), "the run went on as if the press had been stored").not.toContain(t.aiTitle);
  });

  it("the wait is bounded: past HOLDER_CHECK_MS it says the check is slow, never offers consent or Agree, and Try again reads once", async () => {
    vi.useFakeTimers();
    const s = await mount(UNLOOKED);
    await s.wait(HOLDER_CHECK_MS + 1);
    waiting(s, t.holderCheckSlow);
    const before = s.reads.count;
    await s.press(t.resumeRetry);
    expect(s.reads.count - before).toBe(1);
    await s.wait(5 * HOLDER_REREAD_MS);
    expect(s.reads.count - before, "Try again started reading on a timer").toBe(1);
    waiting(s, t.holderCheckSlow);
    expect(s.organizedWith).toEqual([]);
    await s.read(NOBODY);
    expect(s.heading(), "the answer after the bound did not open consent").toBe(t.mapTitle);
  });
});

describe("holderAnswered reads the door's look", () => {
  it("a reader row the door has not looked at is the only no", () => {
    expect(holderAnswered({ organizerRole: "reader", organizerChecked: false })).toBe(false);
    expect(holderAnswered({ organizerRole: "reader" })).toBe(true);
    expect(holderAnswered({ organizerRole: "organizer", organizerChecked: false })).toBe(true);
    expect(holderAnswered(null)).toBe(true);
  });
  it("both catalogues carry the checking and the slow sentence", () => {
    expect(t.windowCheckingHolder).toBeTruthy();
    expect(de.onboarding.windowCheckingHolder).toBeTruthy();
    expect(t.holderCheckSlow).toBeTruthy();
    expect(de.onboarding.holderCheckSlow).toBeTruthy();
  });
});

/**
 * THE CENSUS OF EVERY PRESS THAT REACHES AN ORGANIZE DOOR, BY CALL. The local door now reads an
 * absent verb as a join, so a caller that meant a takeover and said nothing would turn a person's
 * "Organize here" into a press that yields — this row's defect in reverse. Each call is listed with
 * the verb it ends up carrying, and the server lines that make it so are read beside it.
 */
describe("census: every organize press carries the verb it means", () => {
  const REPO = join(__dirname, "..", "..", "..");
  const ROOTS = ["apps/webapp/app", "packages/app-logic/src", "packages/app/src", "packages/letter-body/src", "apps/desktop/src", "apps/paired-page/src", "apps/mobile/src", "apps/mobile/app"];
  /* Today's first run leaves with the switch (FOR-S7 group 5) and no host mounts it: its presses are the new stage's
     now (`packages/app-logic/src/mailboxes/first-run/actions.ts`), and the file is not walked while it still stands. */
  const LEAVING = new Set(["apps/webapp/app/shell/FirstRun.tsx"]);
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "build" || name === ".next") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name) && !LEAVING.has(relative(REPO, p))) out.push(p);
    }
    return out;
  };
  const code = (rel: string) => withoutComments(
    rel === "apps/sidecar/src/engine.ts" ? readEngineAsOneText() : readFileSync(join(REPO, rel), "utf8"),
  );
  /** A press: a call naming an organize route or an organize method. */
  const PRESS = /host\.organize\(|verbs\.organize\(|mailboxApi\.organize\(|organizePath\(mailboxId\)|\/organize`|"\/local\/organizer\/takeover"/g;

  /** file → how many presses, and what each one ends up asking for. */
  const EXPECTED: Record<string, { presses: number; verb: string }> = {
    // The shared setup: the re-entry press names the takeover; Agree names it only after
    // "Organize here instead", a join otherwise.
    "packages/app-logic/src/mailboxes/first-run/actions.ts": { presses: 2, verb: "takeover only by the person's choice" },
    // The desktop host forwards the verb FirstRun chose to the local door (its route builder and
    // its one call).
    "apps/desktop/src/local-first-run.ts": { presses: 2, verb: "forwards FirstRun's verb" },
    // The web host forwards it to the hosted door, which reads absent as takeover.
    "apps/webapp/app/(product)/mailbox/useCloudFirstRun.ts": { presses: 1, verb: "forwards FirstRun's verb" },
    // Settings → Mailboxes "Organize here" on the web: the hosted door, absent = takeover.
    "apps/webapp/app/(product)/mailbox/MailboxSection.tsx": { presses: 1, verb: "takeover (hosted default)" },
    // The new Mailboxes pane's web wire, the same press: no body, so the hosted door reads it as a takeover.
    "apps/webapp/app/(product)/mailbox/mailboxes-wire.ts": { presses: 1, verb: "takeover (hosted default)" },
    // Settings → Mailboxes "Organize from this machine" on the desktop: the takeover route.
    "apps/desktop/src/DesktopMailboxes.tsx": { presses: 1, verb: "takeover (its own route)" },
    // The phone's consent: its door stamps join over every consent and has no takeover verb.
    "apps/mobile/src/net/mailboxes.ts": { presses: 1, verb: "join (the phone door stamps it)" },
    // The client's own route builder, called by MailboxSection and useCloudFirstRun above.
    "apps/webapp/app/api-client.ts": { presses: 1, verb: "the route builder" },
  };

  it("names every press across the four roots, and no other", () => {
    const files = ROOTS.flatMap((r) => walk(join(REPO, r)));
    expect(files.length, "the walk read nothing").toBeGreaterThan(100);
    const found: Record<string, number> = {};
    for (const f of files) {
      const n = (code(relative(REPO, f)).match(PRESS) ?? []).length;
      if (n > 0) found[relative(REPO, f)] = n;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(EXPECTED).map(([k, v]) => [k, v.presses])));
  });

  it("each press carries the verb its row says", () => {
    /* The new stage: the presses are made in `actions.ts`, Agree's body (and its verb) is built in `use-agree.ts`. */
    const firstRun = code("packages/app-logic/src/mailboxes/first-run/actions.ts");
    const agreeBody = code("packages/app-logic/src/mailboxes/first-run/use-agree.ts");
    expect(firstRun).toMatch(/verbs\.organize\(act\.mailboxId, \{ intent: "takeover" \}\)/);
    expect(agreeBody).toMatch(/const takingOver = claimAnswered && choice === "here";/);
    expect(agreeBody).toMatch(/const intent = takingOver \? "takeover" : "join";/);
    expect(firstRun.match(/verbs\.organize\(act\.mailboxId, act\.body\)/g) ?? []).toHaveLength(1);
    expect(agreeBody.match(/body: \{[\s\S]*?intent,\s*\}/g) ?? []).toHaveLength(1);
    expect(code("apps/desktop/src/local-first-run.ts")).toMatch(/\.\.\.\(body\.intent \? \{ intent: body\.intent \} : \{\}\)/);
    expect(code("apps/webapp/app/(product)/mailbox/useCloudFirstRun.ts")).toMatch(/mailboxApi\.organize\(id, body\)/);
    expect(code("apps/webapp/app/(product)/mailbox/MailboxSection.tsx")).toMatch(/mailboxApi\.organize\(id\)/);
    // The server lines that decide what an absent or a named verb means on each door.
    expect(code("apps/sidecar/src/engine.ts")).toMatch(/const intent = body\.intent === "takeover" \? "takeover" : "join";/);
    expect(code("apps/sidecar/src/engine.ts")).toMatch(/mailboxId, now: now\(\), intent: "takeover",/);
    expect(code("packages/api/src/routes/mailboxes.ts")).toMatch(/intent: body\.intent === "join" \? "join" : "takeover"/);
    expect(code("apps/sidecar/src/mobile.ts")).toMatch(/intent: "join" \}\)/);
  });

  it("POSITIVE CONTROL: the press pattern finds a planted call and ignores one in a comment", () => {
    expect(withoutComments("await host.organize(id, {});").match(PRESS)).toHaveLength(1);
    expect(withoutComments("// await host.organize(id, {});\nconst a = 1;").match(PRESS)).toBeNull();
  });
});
