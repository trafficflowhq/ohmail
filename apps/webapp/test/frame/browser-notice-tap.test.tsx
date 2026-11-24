/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, expect, it, vi } from "vitest";
import { NONE, type Appearance } from "@ohmail/app/host";
import { useMailSupplies } from "@ohmail/app/mail";
import { MemoryMirrorStore } from "@ohmail/client-engine";
import { createSyncGate, registerSyncGate } from "@ohmail/app-logic/session/sync-scheduler";
import { forgetOwner, markSignedOutPending, rememberOwner } from "@ohmail/app-logic/storage/owner-cookie";
import { NO_ENGINE } from "../../../../packages/app/test/support/fake-host.js";
import { useCloudMailHost, WakeMailboxEntry } from "../../app/(product)/mailbox/CloudShell";
import * as sessionOutcome from "../../app/(product)/session-outcome";
import type { WebWords } from "../../app/(product)/mailbox/web-supplies";
import { WEB_MAIL_PARTS } from "../../app/(product)/mailbox/mail-parts";
import { bindApiOwner } from "../../app/api-client";
import messages from "../../messages/en.json";

const ACCOUNT = "account-mail";
const FAMILY = "family-mail";
const appearance: Appearance = { face: "paper", scheme: "light" };
const words: WebWords = {
  server: { pairing: false, remoteImages: false, searchPeople: false },
  invites: false, subscriptionPage: false, withdrawManage: () => {}, storageBlock: false,
  account: ACCOUNT, firstRun: undefined, mailboxFacts: async () => [],
  resolve: async () => ({ kind: "none" }), confirmed: () => {},
};
const Words = ({ children }: { children: ReactNode }) => (
  <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">{children}</NextIntlClientProvider>
);

afterEach(() => {
  cleanup();
  bindApiOwner(null);
  forgetOwner();
  document.cookie = "tf_family=; Path=/; Max-Age=0";
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("opens mail from the mounted account and refuses taps after its session changes", async () => {
  const worker = new EventTarget();
  const controller = new EventTarget();
  const showNotification = vi.fn(async (_title: string, _options: NotificationOptions) => {});
  Object.assign(worker, {
    controller,
    getRegistration: async () => ({ showNotification, getNotifications: async () => [] }),
  });
  const serviceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: worker });
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = registerSyncGate(new Proxy(NO_ENGINE, {
    get: (target, key) => key === "store" ? store : Reflect.get(target, key),
  }), createSyncGate(ACCOUNT));

  function signIn() {
    rememberOwner(ACCOUNT);
    document.cookie = `tf_family=${FAMILY}; Path=/`;
    bindApiOwner(ACCOUNT);
  }
  signIn();
  const mount = renderHook(() => {
    const frame = useMailSupplies(window, appearance, NONE, WEB_MAIL_PARTS);
    return useCloudMailHost(engine, words, frame);
  }, { wrapper: Words });
  const notifications = mount.result.current.device.notifications;
  const emitter = notifications === NONE ? NONE : notifications.emitter;
  try {
    if (emitter === NONE) throw new Error("No browser notice emitter");
    const showMail = async () => {
      window.history.replaceState(null, "", "/mailbox#/settings/general");
      expect(await emitter.post({ kind: "ohbox", count: 1 })).toBe(true);
    };
    const requestOpen = (opening: { open: string } | { wake: { owner: string; family: string } }) => {
      const reply = vi.fn();
      const event = Object.assign(new Event("message"), {
        source: controller,
        data: { type: "ohmail:notice-open", ...opening },
        ports: [{ postMessage: reply }],
      });
      act(() => { worker.dispatchEvent(event); });
      return reply;
    };

    const tap = () => {
      const open = showNotification.mock.lastCall?.[1].data.open;
      expect(open).toEqual(expect.any(String));
      return requestOpen({ open });
    };
    const openWake = () => requestOpen({ wake: { owner: ACCOUNT, family: FAMILY } });

    window.history.replaceState(null, "", "/mailbox#/settings/general");
    expect(openWake()).toHaveBeenCalledWith(true);
    expect(window.location.hash).toBe("#/ohbox");

    await showMail();
    expect(tap()).toHaveBeenCalledWith(true);
    expect(window.location.hash).toBe("#/ohbox");

    for (const replace of [
      () => { document.cookie = "tf_family=family-replacement; Path=/"; },
      () => rememberOwner("account-replacement"),
      () => markSignedOutPending(),
    ]) {
      signIn();
      await showMail();
      replace();
      expect(tap()).toHaveBeenCalledWith(false);
      expect(openWake()).toHaveBeenCalledWith(false);
      expect(window.location.hash).toBe("#/settings/general");
    }
  } finally {
    mount.unmount();
    if (emitter !== NONE) await act(async () => { emitter.takeBack(); });
    if (serviceWorker) Object.defineProperty(navigator, "serviceWorker", serviceWorker);
    else Reflect.deleteProperty(navigator, "serviceWorker");
  }
});


it.each(["account", "family", "signed out"])("does not render a mailbox when a fallback wake arrives after %s changes", async (change) => {
  const proof = "2cfcc3f0-be28-4ba9-9e03-6210584a9881";
  rememberOwner(ACCOUNT);
  document.cookie = `tf_family=${FAMILY}; Path=/`;
  window.history.replaceState(null, "", `/?wake=1#wake=${proof}`);
  vi.stubGlobal("caches", { open: async () => ({
    match: async () => Response.json({ enabled: true, registration: { proof, owner: ACCOUNT, family: FAMILY } }),
  }) });
  const response = Promise.withResolvers<Awaited<ReturnType<typeof sessionOutcome.resolveOwnerOutcome>>>();
  const resolve = vi.spyOn(sessionOutcome, "resolveOwnerOutcome").mockReturnValue(response.promise);
  const view = render(<WakeMailboxEntry />, { wrapper: Words });
  expect(resolve).toHaveBeenCalledOnce();
  const owner = change === "account" ? "account-other" : ACCOUNT;
  const family = change === "family" ? "family-other" : FAMILY;
  rememberOwner(owner);
  document.cookie = `tf_family=${family}; Path=/`;
  if (change === "signed out") markSignedOutPending();
  await act(async () => {
    response.resolve(change === "signed out" ? { kind: "none" } : { kind: "owner", accountId: owner, familyId: family });
  });
  expect(view.getByRole("status").textContent).toBe(messages.frame.connection.signedOut.title);
  expect(view.queryByRole("navigation")).toBeNull();
});
