/** @vitest-environment jsdom */
/**
 * THE WEB HANDS THE FRAME ONE HOST WHILE NOTHING CHANGED. Today's views are fed from the host once per host object;
 * an entry that built a new record on every render would draw the whole old shell again on every poll of the page.
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NONE, type FrameSupplies, type HostContract } from "@ohmail/app/host";
import { useWebHost, type WebWords } from "../../app/(product)/mailbox/web-supplies";

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

describe("the web's host", () => {
  it("is the same record on a render with nothing changed, and a new one when an answer moves", () => {
    const view = renderHook((w: WebWords) => useWebHost(engine, w, frame), { initialProps: words });
    const first = view.result.current;
    view.rerender(words);
    expect(view.result.current).toBe(first);
    view.rerender({ ...words, account: "acct-2" });
    expect(view.result.current).not.toBe(first);
    expect(view.result.current.session.account).toBe("acct-2");
  });
});
