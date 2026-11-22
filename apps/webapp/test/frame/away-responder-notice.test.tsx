/** @vitest-environment jsdom */
import { awayFeedOver } from "@ohmail/app/settings/away";
import { PANE_IDS } from "@ohmail/app/settings/contract";
import type { AwayWire } from "@ohmail/app/host";
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import en from "../../messages/en.json";
import {
  act, db503, hydrateCloudShell, installConfirmEnv, ISO, mountCloudShell, refresh204, rememberOwner, scriptRefresh, scriptSession,
  sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "../fixtures/cloud-confirm-shell";

beforeAll(warmCloudShell);
afterEach(async () => {
  await teardownConfirmEnv();
  window.history.replaceState(null, "", "/");
});

type AwayReading = Awaited<ReturnType<AwayWire["state"]>>;

async function mount(
  enabled: boolean,
  hash: string,
  { initiallyUnreachable = false, demo = false, unconfirmed = false, saved }: {
    initiallyUnreachable?: boolean;
    demo?: boolean;
    unconfirmed?: boolean;
    saved?: Partial<AwayReading>;
  } = {},
) {
  installConfirmEnv();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(unconfirmed ? db503 : sessionFull);
  const cloud = globalThis.fetch;
  let row: AwayReading = {
    enabled, body: "Back Monday.", startsAt: null, endsAt: null,
    audience: "screened_in", throttle: "per_day", piles: ["INBOX"], updatedAt: ISO,
    ...saved,
  };
  let unreachable = initiallyUnreachable;
  const reads: string[] = [];
  const writes: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === "/api/away-responder") {
      if (init?.method === "PUT") {
        const next = JSON.parse(String(init.body));
        writes.push(next);
        row = { ...next, updatedAt: ISO };
      } else {
        reads.push(path);
        if (unreachable) return Response.json({}, { status: 503 });
      }
      return Response.json(row);
    }
    if (path === "/api/mailboxes") {
      return Response.json({ items: [{
        id: "mb-1", address: ["mailbox", "example.invalid"].join("@"), status: "connected",
        organizerRole: "organizer", initialImportCompletedAt: ISO, organizeConsentedAt: ISO,
        lastSyncAt: ISO, createdAt: ISO,
      }] });
    }
    return cloud(input, init);
  };
  window.location.hash = hash;
  const frame = demo
    ? await hydrateCloudShell(`/?demo=1${hash}`)
    : await mountCloudShell();
  await tick(3000);
  return { screen: within(frame), reads, writes, setUnreachable: (value: boolean) => { unreachable = value; } };
}

async function press(button: HTMLElement) {
  await act(async () => { fireEvent.click(button); });
  await tick(0);
}

const sentence = new RegExp(en.away.noticeTitle);

async function bringAwayToFront(screen: ReturnType<typeof within>) {
  if (screen.queryByRole("button", { name: en.away.noticeSettings })) return;
  const more = screen.queryByRole("button", { name: /more notices?$/ });
  if (more) {
    await press(more);
    const away = screen.queryByRole("menuitem", { name: /^Away responder is on/ });
    if (away) await press(away);
  }
}

it("reports that the responder is enabled and opens Away settings", async () => {
  const { screen, reads } = await mount(true, "#/ohbox");
  await bringAwayToFront(screen);
  expect(screen.queryAllByRole("status").filter((el) => sentence.test(el.textContent ?? ""))).toHaveLength(1);
  expect(reads).toHaveLength(1);
  await press(screen.getByRole("button", { name: en.away.noticeSettings }));
  expect(window.location.hash).toBe("#/settings/away");
});

it("dismisses the Away notice until the next reading without changing the responder", async () => {
  const { screen, reads, writes } = await mount(true, "#/ohbox");
  const count = () => screen.queryAllByRole("status").filter((el) => sentence.test(el.textContent ?? "")).length;
  await bringAwayToFront(screen);
  expect(count()).toBe(1);
  await press(screen.getByRole("button", { name: en.away.noticeDismiss }));
  expect(count()).toBe(0);
  expect(reads).toHaveLength(1);

  await act(async () => { window.location.hash = "#/settings/away"; });
  await tick(3000);
  expect(screen.getByRole("switch", { name: en.away.title }).getAttribute("aria-checked")).toBe("true");
  await act(async () => { window.location.hash = "#/ohbox"; });
  await tick(3000);
  await bringAwayToFront(screen);
  expect(count()).toBe(1);
  expect(reads).toHaveLength(2);
  expect(writes).toHaveLength(0);
});

const noticeCases: {
  name: string;
  enabled: boolean;
  options?: Parameters<typeof mount>[2];
  reads: number;
  words?: string;
}[] = [
  {
    name: "people let in, Ohbox, daily", enabled: true, reads: 1,
    words: en.away.noticeTitle,
  },
  {
    name: "everyone, Receipts, weekly", enabled: true, reads: 1,
    options: { saved: { audience: "everyone", throttle: "per_week", piles: ["ohmail/Receipts"] } },
    words: en.away.noticeTitle,
  },
  { name: "disabled", enabled: false, reads: 1 },
  { name: "no confirmed host wire", enabled: true, options: { unconfirmed: true }, reads: 0 },
  { name: "demo", enabled: true, options: { demo: true }, reads: 0 },
];

it.each(noticeCases)("the mounted Away notice follows the host and saved scope ($name)", async (testCase) => {
  const { screen, reads } = await mount(testCase.enabled, "#/ohbox", testCase.options);
  expect(screen.getByRole("heading", { name: "Ohbox" })).toBeTruthy();
  await bringAwayToFront(screen);
  const statuses = screen.queryAllByRole("status").filter((el) => el.textContent?.includes("Away responder is on"));
  if (testCase.words === undefined) {
    expect(statuses).toHaveLength(0);
    expect(screen.queryByRole("button", { name: en.away.noticeSettings })).toBeNull();
  } else {
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.textContent).toContain(testCase.words);
  }
  expect(reads).toHaveLength(testCase.reads);
});

it("the shell's ONE away read is gated on the RESOLVED demo answer, not the hydration one", async () => {
  const { screen, reads, writes } = await mount(true, "#/ohbox", { demo: true });
  expect(screen.getByRole("heading", { name: "Ohbox" })).toBeTruthy();
  expect(screen.getByText("Invented mail. Nothing leaves this tab.", { exact: false })).toBeTruthy();
  await bringAwayToFront(screen);
  expect(screen.queryByRole("button", { name: en.away.noticeSettings })).toBeNull();
  expect(reads).toHaveLength(0);
  expect(writes).toHaveLength(0);
});

it("updates the notice from the complete settings save without an extra read", async () => {
  const { screen, reads, writes } = await mount(false, "#/settings/away");
  expect(screen.queryByRole("button", { name: en.away.noticeSettings })).toBeNull();
  expect(reads).toHaveLength(1);
  const pane = within(screen.getByRole("region", { name: en.settings.away }));
  await press(pane.getByRole("switch", { name: en.away.title }));
  await press(pane.getAllByRole("button", { name: en.away.save })[0]!);
  expect(writes).toEqual([{
    enabled: true, body: "Back Monday.", startsAt: null, endsAt: null,
    audience: "screened_in", throttle: "per_day", piles: ["INBOX"],
  }]);
  await act(async () => { window.location.hash = "#/ohbox"; });
  await tick(3000);
  await bringAwayToFront(screen);
  expect(screen.queryByRole("button", { name: en.away.noticeSettings })).not.toBeNull();
  expect(screen.queryAllByRole("status").filter((el) => sentence.test(el.textContent ?? ""))).toHaveLength(1);
  expect(reads).toHaveLength(1);
});

it.each([true, false])("a failed Away read hides the notice until a confirmed read, starting offline=%s", async (initiallyUnreachable) => {
  const { screen, setUnreachable } = await mount(true, "#/ohbox", { initiallyUnreachable });
  const count = () => screen.queryAllByRole("status").filter((el) => sentence.test(el.textContent ?? "")).length;
  await bringAwayToFront(screen);
  expect(count()).toBe(initiallyUnreachable ? 0 : 1);
  setUnreachable(true);
  const go = async (hash: string) => {
    await act(async () => { window.location.hash = hash; });
    await tick(3000);
  };
  await go("#/settings/away");
  expect(screen.getByText(en.away.unreachable)).toBeTruthy();
  await go("#/ohbox");
  await bringAwayToFront(screen);
  expect(count()).toBe(0);

  setUnreachable(false);
  await go("#/settings/away");
  expect(screen.getByRole("switch", { name: en.away.title }).getAttribute("aria-checked")).toBe("true");
  await go("#/ohbox");
  await bringAwayToFront(screen);
  expect(count()).toBe(1);
});

it("the affordance opens Settings at the AWAY pane, where the control lives", async () => {
  const { screen, reads, writes } = await mount(true, "#/ohbox");
  await bringAwayToFront(screen);
  const button = screen.getByRole("button", { name: en.away.noticeSettings });
  expect(reads).toHaveLength(1);
  /* THE ORDER IS STILL THE FACT, in its new shape: the frame's go writes the pane into the
     address in one step — `#/settings/away` from the first write, never a bare `#/settings`
     adopted first with the pane bolted on afterwards, which the router restored over. The spy
     records every hash the click puts in place. */
  const hashes: string[] = [];
  const real = window.history.pushState.bind(window.history);
  const replace = window.history.replaceState.bind(window.history);
  window.history.pushState = ((data: unknown, unused: string, url?: string | URL | null) => {
    hashes.push(String(url ?? window.location.hash));
    return real(data, unused, url ?? undefined);
  }) as typeof window.history.pushState;
  window.history.replaceState = ((data: unknown, unused: string, url?: string | URL | null) => {
    hashes.push(String(url ?? window.location.hash));
    return replace(data, unused, url ?? undefined);
  }) as typeof window.history.replaceState;
  try {
    await press(button);
    await tick(3000);
  } finally {
    window.history.pushState = real;
    window.history.replaceState = replace;
  }
  expect(window.location.hash).toBe("#/settings/away");
  const settingsWrites = hashes.map((url) => new URL(url, window.location.href).hash)
    .filter((hash) => /^#\/settings(?:[/?]|$)/.test(hash));
  expect(settingsWrites[0], "the first Settings write names the Away pane").toBe("#/settings/away");
  expect(settingsWrites).not.toContain("#/settings");
  // The notice lands on the registered pane and its responder switch.
  expect(PANE_IDS).toContain("away");
  expect(screen.getByRole("region", { name: en.settings.away })).toBeTruthy();
  expect(screen.getByRole("switch", { name: en.away.title })).toBeTruthy();
  // Opening it writes nothing and adds only the pane's own mount read.
  expect(writes).toHaveLength(0);
  expect(reads).toHaveLength(2);
});

it("keeps the newest Away reading across out-of-order reads and a confirmed save", async () => {
  const enabled = {
    enabled: true, body: "Back Monday.", startsAt: null, endsAt: null,
    audience: "screened_in" as const, throttle: "per_day" as const, piles: ["INBOX" as const], updatedAt: ISO,
  };
  const early = Promise.withResolvers<typeof enabled>();
  const late = Promise.withResolvers<typeof enabled>();
  const failure = new Error("Away is unreachable");
  const feed = awayFeedOver({
    state: vi.fn<() => Promise<typeof enabled>>()
      .mockReturnValueOnce(early.promise)
      .mockRejectedValueOnce(failure)
      .mockReturnValueOnce(late.promise),
    save: async () => enabled,
  });
  const earlierRead = feed.wire.state();
  await expect(feed.wire.state()).rejects.toThrow(failure);
  early.resolve(enabled);
  await earlierRead;
  expect(feed.read()).toBeNull();

  const lateRead = expect(feed.wire.state()).rejects.toThrow(failure);
  await feed.wire.save(enabled);
  late.reject(failure);
  await lateRead;
  expect(feed.read()).toEqual(enabled);
});
