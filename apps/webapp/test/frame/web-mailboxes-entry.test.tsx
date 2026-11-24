/** @vitest-environment jsdom */
/**
 * THE MAILBOXES SECTION ON THE WEB's HOST (the switch's point 58): the section's wire, one for the page's life, and
 * the entry's notices (the organizer's change, the gap's offer), which the frame's notice slot calls. Standing the
 * wire asks the server nothing: a call goes only when the section asks.
 */
import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NONE, type FrameSupplies, type HostContract } from "@ohmail/app/host";
import { useCloudMailHost as useWebHost } from "../../app/(product)/mailbox/CloudShell";
import { type WebWords } from "../../app/(product)/mailbox/web-supplies";
import messages from "../../messages/en.json";

const { mailboxNotice, awayNotice } = vi.hoisted(() => ({
  mailboxNotice: { kind: "organizer", title: "Mailbox update" },
  awayNotice: { kind: "away", title: "Away responder is on" },
}));

vi.mock("../../app/shell/browser-mail", async (original) => ({
  ...await original<typeof import("../../app/shell/browser-mail")>(),
  MAILBOXES_NOTICES: () => [mailboxNotice],
}));

vi.mock("@ohmail/app/settings/away", async (original) => ({
  ...await original<typeof import("@ohmail/app/settings/away")>(),
  useAwayNotice: () => [awayNotice],
}));

const Words = ({ children }: { children: ReactNode }) => (
  <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">{children}</NextIntlClientProvider>
);

const named = <T,>(name: string) => ({ named: name }) as unknown as T;
const frame = {
  places: named("places"), stages: named("stages"), overs: named("overs"), address: named("address"), window: named("window"),
  appearance: named("appearance"), recover: NONE,
} as FrameSupplies;
const engine = named<HostContract["engine"]>("engine");
const words: WebWords = {
  server: { pairing: true, remoteImages: false, searchPeople: false }, invites: false, subscriptionPage: true, withdrawManage: () => undefined,
  storageBlock: false, account: "acct-1", firstRun: undefined, mailboxFacts: async () => [],
  resolve: async () => ({ kind: "none" }) as never, confirmed: () => undefined,
};

const asked = vi.fn();
beforeEach(() => {
  asked.mockReset();
  vi.stubGlobal("fetch", (...args: unknown[]) => {
    asked(...args);
    return new Promise(() => undefined);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("the web's host and the Mailboxes section", () => {
  it("answers the section's wire, one for the page's life, and standing it asks the server nothing", () => {
    const view = renderHook((w: WebWords) => useWebHost(engine, w, frame), { initialProps: words, wrapper: Words });
    const wire = view.result.current.wires.mailboxes;
    if (wire === NONE) throw new Error("the web's host hands the Mailboxes section no wire");
    expect(typeof wire.list).toBe("function");
    expect(typeof wire.remove).toBe("function");
    view.rerender({ ...words, account: "acct-2" });
    expect(view.result.current.wires.mailboxes).toBe(wire);
    expect(asked).not.toHaveBeenCalled();
  });

  it("hands the Mailboxes entry the mail ground's notices for the frame's notice slot", () => {
    const view = renderHook((w: WebWords) => useWebHost(engine, w, frame), { initialProps: words, wrapper: Words });
    const entry = view.result.current.features.mailboxes;
    if (entry === NONE) throw new Error("the web lists the Mailboxes section");
    const useNotices = entry.notice;
    if (useNotices === undefined) throw new Error("the Mailboxes entry supplies no notices");
    expect(renderHook(useNotices).result.current).toEqual([mailboxNotice, awayNotice]);
  });
});
