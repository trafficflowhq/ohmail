import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { NONE, type HostContract } from "@ohmail/app/host";
import { useText } from "@ohmail/app/text";
import { useJunkWindow, type JunkWire } from "@ohmail/app-logic/screener/junk-window";
import { afterEach, vi } from "vitest";
import { DesktopLocale, useAppLocale } from "../../apps/desktop/src/DesktopLocale.js";
import { BearerManager } from "../../apps/paired-page/src/bearer.js";
import { HostGate } from "../../apps/paired-page/src/HostGate.js";
import { useTrashWindow, type TrashWire } from "../../apps/webapp/app/shell/trash-window";

const frame = vi.hoisted(() => ({ host: null as HostContract | null }));
vi.mock("../../apps/webapp/app/api-client", async (load) => {
  const real = await load<typeof import("../../apps/webapp/app/api-client")>();
  const refuse = (): never => { throw new Error("the Cloud client is unavailable on a paired device"); };
  return {
    ...real,
    apiConfigured: () => false,
    trashWindow: { list: refuse, body: refuse },
    screener: { junkList: refuse, junkBody: refuse },
  };
});
vi.mock("../../apps/webapp/app/shell/browser-mail", async (load) => ({
  ...(await load<typeof import("../../apps/webapp/app/shell/browser-mail")>()),
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
  function PairedWindow() {
    return <HostGate bearer={bearer} language={useAppLocale()} />;
  }
  await act(async () => {
    render(<DesktopLocale><PairedWindow /></DesktopLocale>);
  });
  return waitFor(() => {
    if (frame.host === null) throw new Error("the paired gate has not mounted the mail frame");
    return frame.host;
  });
}

/** Run both actual mail windows to the point where they decide whether their supplied wires serve them. */
export async function mountLiveWindows(junk?: JunkWire, trash?: TrashWire) {
  const { result, unmount } = renderHook(() => ({
    junk: useJunkWindow(true, () => undefined, junk ?? NONE, useText("screener")),
    trash: useTrashWindow(true, trash),
  }), { wrapper: DesktopLocale });
  await act(async () => {});
  const windows = result.current;
  unmount();
  return windows;
}
