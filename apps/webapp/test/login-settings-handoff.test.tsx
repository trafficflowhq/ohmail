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
  router.replace.mockClear();
  router.push.mockClear();
  session.account = "account-b";
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

it("prompts the other account on the same server and opens Devices only for the intended account", async () => {
  const reference = "a".repeat(96);
  const verify = vi.fn(async () => session.account === "account-a"
    ? Response.json({ account: "account-a", pane: "devices" })
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
    `/?settingsHandoff=${reference}#/settings/devices`,
  ));
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

  cleanup();
  session.account = "account-a";
  mount();
  expect((await screen.findByRole("region", { name: "Devices" })).textContent).toBe("account-a");
  expect(window.location.hash).toBe("#/settings/devices");
});
