import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { HostContract } from "@ohmail/app/host";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, vi } from "vitest";
import { BearerManager } from "../../paired-page/src/bearer.js";
import { HostGate } from "../../paired-page/src/HostGate.js";
import messages from "../../webapp/messages/en.json";

const frame = vi.hoisted(() => ({ host: null as HostContract | null }));
vi.mock("../../webapp/app/shell/browser-mail", async (load) => ({
  ...(await load<typeof import("../../webapp/app/shell/browser-mail")>()),
  MailFrame({ host }: { host: HostContract }) {
    frame.host = host;
    return null;
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Mount the paired host and observe the actual frame contract over a synthetic transport. */
export async function capturePairedFrame(fetchImpl: typeof fetch): Promise<HostContract> {
  frame.host = null;
  window.localStorage.clear();
  vi.stubGlobal("fetch", async () => { throw new Error("a paired wire bypassed its bearer"); });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  }));
  const bearer = new BearerManager({ storage: window.localStorage, fetchImpl });
  bearer.adopt({ accessToken: "a1", refreshToken: "r1" }, { fresh: true });
  await act(async () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <HostGate bearer={bearer} />
      </NextIntlClientProvider>,
    );
  });
  return waitFor(() => {
    if (frame.host === null) throw new Error("the paired gate has not mounted the mail frame");
    return frame.host;
  });
}
