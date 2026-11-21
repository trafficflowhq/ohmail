/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useMemo } from "react";
import { createSyncGate, registerSyncGate } from "@ohmail/app-logic/session/sync-scheduler";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { mailSettings, NO_PANE_PARTS } from "@ohmail/app/mail";
import { fakeHost, NO_ENGINE } from "../../../../packages/app/test/support/fake-host.js";
import { fakeAddress } from "../../../../packages/app/test/support/fake-window.js";
import { bindApiOwner, pendApiOwner } from "../../app/api-client";
import * as renewal from "../../app/session-refresh";
import { WEB_PANE_PARTS } from "../../app/(product)/mailbox/pane-parts";
import { useCloudMailHost } from "../../app/(product)/mailbox/CloudShell";
import { MailFrame } from "../../app/shell/browser-mail";
import words from "../../messages/en.json";

vi.hoisted(() => { process.env.NEXT_PUBLIC_API_BASE = "/api"; });

const OWNER_A = "settings-a";
const OWNER_B = "settings-b";
const awayRow = {
  enabled: false, body: "Back on Monday", startsAt: null, endsAt: null,
  audience: "screened_in", throttle: "per_day", piles: ["INBOX"], updatedAt: "2026-11-19T08:00:00Z",
};
const settings = mailSettings({ ...NO_PANE_PARTS, ai: WEB_PANE_PARTS.ai, away: WEB_PANE_PARTS.away });

function SettingsFrame({ scope, pane, account }: { scope: string; pane: "ai" | "away"; account: string | null }) {
  const engine = useMemo(() => registerSyncGate(Object.create(NO_ENGINE), createSyncGate(scope)), [scope]);
  const { host } = useMemo(() => fakeHost({
    scope, account, engine, service: "self",
    address: fakeAddress(`#/settings/${pane}`), places: { settings },
    features: { ai: { name: "ai", render: () => null } },
  }), [scope, engine, pane, account]);
  const web = useCloudMailHost(engine, {
    server: { pairing: false, remoteImages: false, searchPeople: false },
    account, firstRun: undefined, invites: false, subscriptionPage: false, storageBlock: false,
    withdrawManage: () => {}, confirmed: () => {}, resolve: async () => ({ kind: "none" }) as never,
    mailboxFacts: async () => [],
  }, {
    places: host.features.places, stages: host.features.stages, overs: host.features.overs,
    reader: host.features.reader, above: host.features.above, calendar: host.features.calendar,
    recover: host.session.recover, window: host.device.window, address: host.device.address,
    appearance: host.device.appearance,
  });
  return <MailFrame host={{
    ...host,
    wires: { ...host.wires, away: web.wires.away },
    capabilities: { ...host.capabilities, awayRunsOn: "service" },
  }} />;
}

function view(scope: string, pane: "ai" | "away", account: string | null = scope) {
  return (
    <NextIntlClientProvider messages={words} locale="en" timeZone="UTC">
      <ThemeProvider><ToastHost><SettingsFrame scope={scope} pane={pane} account={account} /></ToastHost></ThemeProvider>
    </NextIntlClientProvider>
  );
}

function bind(owner: string) {
  document.cookie = `tf_owner=${owner}; Path=/`;
  bindApiOwner(owner);
}

function saveAway(): HTMLElement {
  const save = screen.getAllByRole("button", { name: words.away.save });
  const inPrompt = save.find((button) => button.closest('[aria-live="polite"]'));
  if (!inPrompt) throw new Error("The unsaved change did not offer Save");
  return inPrompt;
}

afterEach(() => {
  cleanup();
  bindApiOwner(null);
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { pane: "ai", path: "/account/ai", title: words.settings.aiLabel, method: "PATCH" },
  { pane: "away", path: "/away-responder", title: words.away.title, method: "PUT" },
] as const)("keeps an account's $pane press with the account that made it", async ({ pane, path, title, method }) => {
  const changes: Array<{ owner: string; method: string }> = [];
  let owner = OWNER_A;
  let waitForRenewal: Promise<boolean> | null = null;
  const otherTab = vi.spyOn(renewal, "otherTabRenewalSettled").mockImplementation(async () => waitForRenewal ?? false);
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    if (!String(url).endsWith(path)) return new Response("{}", { status: 404 });
    const verb = init?.method ?? "GET";
    if (verb !== "GET") changes.push({ owner, method: verb });
    const patch = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const answer = pane === "ai" ? { aiEnabled: true, ...patch } : { ...awayRow, ...patch };
    return Response.json(answer, { headers: { "X-Ohmail-Account": owner } });
  }));
  bind(OWNER_A);
  const mounted = render(view(OWNER_A, pane));
  const choice = await screen.findByRole("switch", { name: title });
  await waitFor(() => expect(choice).toHaveProperty("disabled", false));

  if (pane === "away") fireEvent.click(choice);
  const press = pane === "away" ? saveAway() : choice;
  let settle!: (result: boolean) => void;
  waitForRenewal = new Promise((resolve) => { settle = resolve; });
  otherTab.mockClear();
  fireEvent.click(press);
  await waitFor(() => expect(otherTab).toHaveBeenCalled());
  expect(changes).toEqual([]);

  await act(async () => {
    owner = OWNER_B;
    bind(OWNER_B);
    waitForRenewal = null;
    settle(true);
    await Promise.resolve();
  });
  expect(changes).toEqual([]);

  mounted.rerender(view(OWNER_B, pane));
  const ownChoice = await screen.findByRole("switch", { name: title });
  await waitFor(() => expect(ownChoice).toHaveProperty("disabled", false));
  fireEvent.click(ownChoice);
  if (pane === "away") fireEvent.click(saveAway());
  await waitFor(() => expect(changes).toEqual([{ owner: OWNER_B, method }]));
});

it.each([
  { pane: "ai", path: "/account/ai", title: words.settings.aiLabel, row: { aiEnabled: true } },
  { pane: "away", path: "/away-responder", title: words.away.title, row: awayRow },
] as const)("waits to read $pane until a warm account has been confirmed", async ({ pane, path, title, row }) => {
  const called = vi.fn(async (url: unknown) => String(url).endsWith(path)
    ? Response.json(row, { headers: { "X-Ohmail-Account": OWNER_A } })
    : new Response("{}", { status: 404 }));
  vi.stubGlobal("fetch", called);
  document.cookie = `tf_owner=${OWNER_A}; Path=/`;
  pendApiOwner(OWNER_A);
  const mounted = render(view(OWNER_A, pane, null));
  await act(async () => { await Promise.resolve(); });
  expect(called.mock.calls.filter(([url]) => String(url).endsWith(path))).toEqual([]);

  bind(OWNER_A);
  mounted.rerender(view(OWNER_A, pane));
  const choice = await screen.findByRole("switch", { name: title });
  await waitFor(() => expect(choice).toHaveProperty("disabled", false));
  expect(called.mock.calls.filter(([url]) => String(url).endsWith(path))).toHaveLength(1);
});
