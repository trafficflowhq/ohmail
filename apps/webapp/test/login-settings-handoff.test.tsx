/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, expect, it, vi } from "vitest";
import { TextProvider } from "@ohmail/app/text";
import { SettingsHandoffGate } from "../app/(product)/mailbox/SettingsHandoffGate";
import LoginPage from "../app/(product)/login/page";
import messages from "../messages/en.json";

vi.mock("../app/(product)/mailbox/CloudShell", () => ({
  CloudShell: ({ settingsAccount }: { settingsAccount: string }) => <div role="region" aria-label="Devices">{settingsAccount}</div>,
}));

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
const resumeSession = vi.hoisted(() => vi.fn());
vi.mock("../app/session-refresh", async (original) => ({
  ...await original<typeof import("../app/session-refresh")>(),
  resumeSession,
}));
const session = vi.hoisted(() => ({ account: "account-b" }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("../app/api-client", async (original) => ({
  ...await original<typeof import("../app/api-client")>(),
  apiConfigured: () => true,
}));
vi.mock("../app/(product)/session-outcome", () => ({
  resolveOwnerOutcome: async () => ({ kind: "owner", accountId: session.account }),
}));

afterEach(() => {
  cleanup();
  resumeSession.mockReset();
  router.replace.mockClear();
  router.push.mockClear();
  session.account = "account-b";
  document.cookie = "tf_family=; Path=/; Max-Age=0";
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

it.each([
  { pane: "devices", path: "/settings/devices" },
  { pane: "calendar-google", path: "/cal/cal-setup?via=google" },
  { pane: "calendar-microsoft", path: "/cal/cal-setup?via=microsoft" },
])("prompts another browser account and only continues to $pane for the intended account", async ({ pane, path }) => {
  const reference = "a".repeat(96);
  const verify = vi.fn(async () => session.account === "account-a"
    ? Response.json({ account: "account-a", pane })
    : Response.json({}, { status: 409 }));
  vi.stubGlobal("fetch", verify);
  const mount = async () => render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <TextProvider locale="en" messages={messages} timeZone="UTC">
        {await LoginPage({ searchParams: Promise.resolve({ settingsHandoff: reference }) })}
      </TextProvider>
    </NextIntlClientProvider>,
  );

  await mount();
  expect(await screen.findByLabelText(/password/i)).toBeTruthy();
  expect(router.replace).not.toHaveBeenCalled();
  await waitFor(() => expect(verify).toHaveBeenCalled());
  expect(router.push).not.toHaveBeenCalled();

  cleanup();
  session.account = "account-a";
  await mount();
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith(
    `/?settingsHandoff=${reference}#${path}`,
  ));
});

it.each(["google", "microsoft"])("refuses another account at the calendar handoff (%s)", async (provider) => {
  const reference = "a".repeat(96);
  const check = vi.fn(async () => session.account === "account-a"
    ? Response.json({ account: session.account, pane: `calendar-${provider}` })
    : Response.json({}, { status: 409 }));
  vi.stubGlobal("fetch", check);
  const login = `/login?settingsHandoff=${reference}`;
  const destination = `/?settingsHandoff=${reference}#/cal/cal-setup?via=${provider}`;

  const mount = () => render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <SettingsHandoffGate reference={reference} />
    </NextIntlClientProvider>,
  );
  window.history.replaceState(null, "", destination);
  mount();
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith(login));
  expect(screen.queryByRole("region")).toBeNull();

  cleanup();
  session.account = "account-a";
  mount();
  expect((await screen.findByRole("region")).textContent).toBe("account-a");
  expect(window.location.hash).toBe(`#/cal/cal-setup?via=${provider}`);
});

it("checks the reference again at the mailbox destination before mounting Settings", async () => {
  const reference = "a".repeat(96);
  vi.stubGlobal("fetch", vi.fn(async () => session.account === "account-a"
    ? Response.json({ account: session.account, pane: "devices" })
    : Response.json({}, { status: 409 })));
  const mount = () => render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <SettingsHandoffGate reference={reference} />
    </NextIntlClientProvider>,
  );

  window.history.replaceState(null, "", `/?settingsHandoff=${reference}#/settings/devices`);
  mount();
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/login?settingsHandoff=${reference}`));
  expect(screen.queryByRole("region", { name: "Devices" })).toBeNull();
  expect(resumeSession).not.toHaveBeenCalled();

  cleanup();
  session.account = "account-a";
  mount();
  expect((await screen.findByRole("region", { name: "Devices" })).textContent).toBe("account-a");
  expect(window.location.hash).toBe("#/settings/devices");
});

it.each([
  { renewal: "resumed", retry: 200, opens: true },
  { renewal: "resumed", retry: 401, opens: false },
  { renewal: "refused", retry: null, opens: false },
])("renews the Settings handoff once after a 401 ($renewal, retry $retry)", async ({ renewal, retry, opens }) => {
  const reference = "a".repeat(96);
  const verify = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockImplementationOnce(async () => retry === 200
      ? Response.json({ account: "account-a", pane: "devices" })
      : new Response(null, { status: retry ?? 500 }));
  vi.stubGlobal("fetch", verify);
  resumeSession.mockResolvedValue(renewal);
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <SettingsHandoffGate reference={reference} />
    </NextIntlClientProvider>,
  );

  if (opens) {
    expect((await screen.findByRole("region", { name: "Devices" })).textContent).toBe("account-a");
    expect(router.replace).not.toHaveBeenCalled();
  } else {
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/login?settingsHandoff=${reference}`));
    expect(screen.queryByRole("region", { name: "Devices" })).toBeNull();
  }
  expect(resumeSession).toHaveBeenCalledTimes(1);
  expect(verify).toHaveBeenCalledTimes(retry === null ? 1 : 2);
  if (retry !== null) expect(verify.mock.calls[1]).toEqual(verify.mock.calls[0]);
});

it("leaves a newly signed-in browser session alone when an earlier handoff returns 401", async () => {
  const reference = "a".repeat(96);
  document.cookie = "tf_family=previous-family; Path=/";
  const verify = vi.fn(async () => {
    document.cookie = "tf_family=new-family; Path=/";
    return new Response(null, { status: 401 });
  });
  vi.stubGlobal("fetch", verify);
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <SettingsHandoffGate reference={reference} />
    </NextIntlClientProvider>,
  );

  await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/login?settingsHandoff=${reference}`));
  expect(resumeSession).not.toHaveBeenCalled();
  expect(verify).toHaveBeenCalledTimes(1);
});
