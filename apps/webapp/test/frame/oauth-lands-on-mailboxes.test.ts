/** @vitest-environment jsdom */
/**
 * BACK FROM MICROSOFT's SIGN-IN, THE NEW SHELL OPENS SETTINGS › MAILBOXES (the switch's point 66): the
 * one pane that says the mailbox was connected or why it was refused. The landing sets the fragment, which the frame's
 * router reads alone (the query names no pane there), so a bounce with no fragment, or a bare `/`, lands on that pane;
 * a refused consent lands there too. The single-use values leave the address before the call.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeOf } from "@ohmail/app/frame/route";

const completed: { state: string; code: string }[] = [];
vi.mock("../../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../../app/api-client")>("../../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    mailboxes: {
      ...actual.mailboxes,
      oauthComplete: async (b: { state: string; code: string }) => {
        completed.push(b);
        return { mailbox: { address: "mila@example.invalid" }, created: true, returnTo: null };
      },
    },
  };
});

async function landAt(url: string) {
  window.history.replaceState(null, "", url);
  vi.resetModules();
  const mod = await import("../../app/(product)/mailbox/oauth-return.js");
  mod.resetOAuthReturn();
  return mod;
}
const where = () => {
  const r = routeOf(window.location.hash);
  return { place: r.place, sub: r.sub };
};

afterEach(() => {
  completed.length = 0;
  window.history.replaceState(null, "", "/");
});

describe("the consent return lands on Settings › Mailboxes in the new shell", () => {
  it("a bounce with no fragment completes the ceremony and opens the Mailboxes pane", async () => {
    const mod = await landAt("/?oauth=pending&state=st-one&code=CODE1");
    mod.beginOAuthReturn();
    expect(where()).toEqual({ place: "settings", sub: "mailboxes" });
    expect(window.location.search).not.toContain("CODE1");
    await vi.waitFor(() => expect(completed).toEqual([{ state: "st-one", code: "CODE1" }]));
  });

  it("a bounce onto a bare / with the Ohbox's fragment is put on the pane too", async () => {
    const mod = await landAt("/?oauth=pending&state=st-two&code=CODE2#/ohbox");
    mod.beginOAuthReturn();
    expect(where()).toEqual({ place: "settings", sub: "mailboxes" });
  });

  it("a refused consent lands on the pane that says why", async () => {
    const mod = await landAt("/?oauth=error&reason=consent_denied");
    mod.beginOAuthReturn();
    expect(where()).toEqual({ place: "settings", sub: "mailboxes" });
    expect(completed).toEqual([]);
  });
});
