/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act, answerConsentWith, installShellEnv, ISO, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";
import { NONE, type HostContract } from "@ohmail/app/host";
import { screeningSettings } from "../app/api-client";
import { WEB_MAIL_PARTS } from "../app/(product)/mailbox/mail-parts";
import { MailFrame, useBrowserMail } from "../app/shell/browser-mail";
import { EngineProvider, useEngine } from "../app/shell/engine";
import { hostFromTodaysInputs } from "./_mail-shell";
import en from "../messages/en.json";

/**
 * THE DEFAULT QUIET WINDOW IS ALWAYS CHOOSABLE, through the real shell and the Cloud's echo.
 * The dial offered 60 only while 60 was stored: once somebody tried 90 the rungs
 * read 90 / 180 / 365 / All time and the product default could not be chosen again from any
 * screen. Now the default rung is always on the dial and says it is the default, and a stored
 * window off the ladder still joins it. Mutation: drop the default from the mounted window's rungs and
 * the first case goes red.
 */

/** The account row as the route stores it: the default window is stored as null. */
let storedDays: number | null;
let patches: Array<Record<string, unknown>>;

const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const effective = (): number => storedDays ?? 60;

function scriptAccount(): void {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (String(input).includes("/consent/settings") && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { dormancyDays?: number | null; screeningScope?: string };
      patches.push(body);
      if ("dormancyDays" in body) storedDays = body.dormancyDays === 60 ? null : (body.dormancyDays ?? null);
      answerConsentWith({ dormancyDays: effective(), screeningScope: body.screeningScope ?? "window" });
      return json({ dormancyDays: effective(), screeningScope: body.screeningScope ?? "window" });
    }
    // The pane's other section, answered in the shape the route sends rather than the harness's `{}`.
    if (String(input).includes("/account/screening")) {
      return json({ ohboxPolicy: null, ohboxBar: null, defaultBar: en.settings.screening.defaultBar });
    }
    return inner(input as RequestInfo, init);
  }) as typeof globalThis.fetch;
}

const DEFAULT_LABEL = en.settings.dormancy.dayLabelDefault.replace("{days}", "60");
const dial = (host: HTMLElement) =>
  within(within(host).getByRole("group", { name: en.settings.dormancy.ariaLabel }));
const rungs = (host: HTMLElement): string[] =>
  dial(host).getAllByRole("button").map((n) => (n.textContent ?? "").trim());
const chosen = (host: HTMLElement): string[] =>
  dial(host).queryAllByRole("button", { pressed: true }).map((n) => (n.textContent ?? "").trim());
async function press(host: HTMLElement, label: string): Promise<void> {
  const button = dial(host).getByRole("button", { name: label });
  await act(async () => { button.click(); });
  for (let i = 0; i < 6; i++) await tick(20);
}

const ACCOUNT = "acct_live_1";
const facts = [mailbox({ lastSyncAt: ISO })];
const screening: HostContract["wires"]["screening"] = {
  read: () => screeningSettings.get(),
  change: (change) => screeningSettings.set(change),
};

function ScreenerSettingsFrame() {
  const engine = useEngine();
  const frame = useBrowserMail(NONE, WEB_MAIL_PARTS);
  const host = hostFromTodaysInputs({
    mailboxFacts: async () => facts,
    scope: ACCOUNT,
    screeningSection: null,
  }, engine, frame, NONE);
  return <MailFrame host={{
    ...host,
    session: { ...host.session, account: ACCOUNT },
    wires: { ...host.wires, screening },
  }} />;
}

async function screenerPane(days: number): Promise<HTMLElement> {
  storedDays = days === 60 ? null : days;
  answerConsentWith({ dormancyDays: days, screeningScope: "window" });
  scriptAccount();
  window.location.hash = "#/settings/screener";
  const host = await mountShell(facts, {
    wrap: () => (
      <EngineProvider demo={false} resolveOwner={async () => ({ kind: "owner", accountId: ACCOUNT })}>
        <ScreenerSettingsFrame />
      </EngineProvider>
    ),
  });
  for (let i = 0; i < 6; i++) await tick(20);
  return host;
}

beforeEach(() => {
  installShellEnv();
  patches = [];
});
afterEach(async () => {
  await teardownShellEnv();
});

describe("Settings → Screener → days of quiet", () => {
  it("after trying 90, the default 60 is still on the dial, labelled the default, and choosing it stores the default", async () => {
    const host = await screenerPane(60);
    await press(host, "90");
    expect(chosen(host)).toEqual(["90"]);
    expect(rungs(host).filter((r) => r.startsWith("60")), "the product default left the dial once somebody moved off it")
      .toHaveLength(1);
    expect(rungs(host)).toEqual([DEFAULT_LABEL, "90", "180", "365", en.settings.dormancy.allTime]);

    await press(host, DEFAULT_LABEL);
    expect(patches).toEqual([
      { dormancyDays: 90, screeningScope: "window" },
      { dormancyDays: 60, screeningScope: "window" },
    ]);
    expect(storedDays, "choosing the default must store the default, which is null").toBeNull();
    expect(chosen(host)).toEqual([DEFAULT_LABEL]);
  });

  it("a stored window the ladder does not carry stays choosable beside the default, in order", async () => {
    const host = await screenerPane(120);
    expect(rungs(host)).toEqual([DEFAULT_LABEL, "90", "120", "180", "365", en.settings.dormancy.allTime]);
    expect(chosen(host)).toEqual(["120"]);
  });

  it("a stored rung on the ladder is shown once, and the default once", async () => {
    const host = await screenerPane(180);
    expect(rungs(host)).toEqual([DEFAULT_LABEL, "90", "180", "365", en.settings.dormancy.allTime]);
    expect(chosen(host)).toEqual(["180"]);
  });
});
