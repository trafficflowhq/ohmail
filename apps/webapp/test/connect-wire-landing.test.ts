/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECT_PURPOSES, type MailboxId } from "@ohmail/app-logic/mailboxes/connect/types";
import { NONE } from "@ohmail/app/host";

/**
 * WHERE A PROVIDER'S SIGN-IN LANDS, read on the web's own wire. The form says what it was opened for and never names
 * a landing; the wire maps it by a closed table, writes it down keyed to the ceremony before the browser leaves, and
 * the return reads it once. A forged or stale record lands in Settings.
 */
let mockAuthorize = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x";
let mockStarts: { mailboxId?: string; returnTo?: string }[] = [];
let mockCompletes: { state: string; code: string; search: string }[] = [];
let mockStates: string[] = [];

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    pendApiOwner: () => undefined,
    mailboxes: {
      ...actual.mailboxes,
      oauthAvailability: async () => ({ available: true, device: false }),
      oauthStart: async (b: { mailboxId?: string; returnTo?: string }) => {
        mockStarts.push(b);
        return { authorizeUrl: mockAuthorize, state: mockStates.shift() ?? "S-1" };
      },
      oauthComplete: async (b: { state: string; code: string }) => {
        mockCompletes.push({ ...b, search: window.location.search });
        return { mailbox: { id: "mb1", address: "person@contoso-com.example" }, created: true, returnTo: "/" };
      },
    },
  };
});

const LANDINGS = ["settings", "join", "first-run"];
const RETURNS = ["/", "/join"];
const LANDING_KEY = "ohmail.oauth.landing";
const settle = async (): Promise<void> => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
const stored = (): { landing?: unknown; state?: unknown } | null => {
  const raw = sessionStorage.getItem(LANDING_KEY);
  return raw === null ? null : (JSON.parse(raw) as { landing?: unknown; state?: unknown });
};

async function wireFor(returned: "join" | "page" = "page") {
  const left: string[] = [];
  const { webConnectWire } = await import("../app/(product)/mailbox/connect-wire");
  const wire = webConnectWire({ owner: () => "acct-1", returned, leave: (url) => void left.push(url) });
  if (wire.signIn === NONE) throw new Error("the web's wire signs in");
  return { signIn: wire.signIn, left };
}

beforeEach(() => {
  mockAuthorize = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x";
  mockStarts = [];
  mockCompletes = [];
  mockStates = [];
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
afterEach(async () => {
  const { resetOAuthReturn } = await import("../app/(product)/mailbox/oauth-return");
  resetOAuthReturn();
  vi.resetModules();
});

describe("a start writes down where it lands, from a closed table", () => {
  it.each(CONNECT_PURPOSES)("opened for %s: the landing is one of the three and the return path one of the two", async (purpose) => {
    const { LANDING_OF, RETURN_TO } = await import("../app/(product)/mailbox/connect-wire");
    const { signIn, left } = await wireFor();
    const answer = await signIn.start({ provider: "microsoft", purpose, stillWanted: () => true });
    expect(answer).toEqual({ ok: true, value: "leaving" });
    expect(LANDINGS).toContain(LANDING_OF[purpose]);
    expect(stored()).toEqual({ landing: LANDING_OF[purpose], state: "S-1" });
    expect(RETURNS).toContain(mockStarts[0]!.returnTo);
    expect(mockStarts[0]!.returnTo).toBe(RETURN_TO[LANDING_OF[purpose]]);
    expect(left).toEqual([mockAuthorize]);
    expect(sessionStorage.getItem("ohmail.oauth.owner.S-1")).toBe("acct-1");
  });

  it("the join returns to the join, and everything else to Settings: no purpose starts the landing nothing started before", async () => {
    const { LANDING_OF } = await import("../app/(product)/mailbox/connect-wire");
    expect(LANDING_OF).toEqual({ join: "join", firstRun: "settings", add: "settings", edit: "settings", reconnect: "settings", standalone: "settings" });
  });

  it("a reconnect's mailbox rides the start, and nothing else of the form does", async () => {
    const { signIn } = await wireFor();
    await signIn.start({ provider: "microsoft", purpose: "reconnect", mailboxId: "mbx-7" as MailboxId, stillWanted: () => true });
    expect(mockStarts).toEqual([{ mailboxId: "mbx-7", returnTo: "/" }]);
    await signIn.start({ provider: "microsoft", purpose: "add", stillWanted: () => true });
    expect(mockStarts[1]).toEqual({ returnTo: "/" });
  });

  it("a press retired while the server answered records nothing and leaves nowhere", async () => {
    const { signIn, left } = await wireFor();
    expect(await signIn.start({ provider: "microsoft", purpose: "join", stillWanted: () => false })).toEqual({ ok: true, value: "retired" });
    expect(stored()).toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect(left).toEqual([]);
  });

  it.each([
    "https://login.microsoftonline.com.evil.example/common/oauth2/v2.0/authorize",
    "http://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    "https://user@login.microsoftonline.com/common/oauth2/v2.0/authorize",
    "javascript:alert(1)",
    "/relative/authorize",
    "",
  ])("an address to leave for that is not the provider's own records nothing and leaves nowhere: %s", async (authorize) => {
    mockAuthorize = authorize;
    const { signIn, left } = await wireFor();
    const answer = await signIn.start({ provider: "microsoft", purpose: "add", stillWanted: () => true });
    expect(answer.ok).toBe(false);
    expect(sessionStorage.length).toBe(0);
    expect(left).toEqual([]);
  });
});

describe("the return reads its landing once, and trusts nothing it finds", () => {
  async function comeBack(search: string) {
    window.history.replaceState(null, "", `/${search}`);
    const { beginOAuthReturn } = await import("../app/(product)/mailbox/oauth-return");
    beginOAuthReturn();
    await settle();
  }

  it.each([
    ['{"landing":"https://evil.example/","state":"S-9"}'],
    ['{"landing":"/join","state":"S-9"}'],
    ['{"landing":"admin","state":"S-9"}'],
    ['{"landing":"join","state":"another-ceremony"}'],
    ["{broken"],
    ['"join"'],
  ])("a forged or stale record lands in Settings: %s", async (record) => {
    sessionStorage.setItem(LANDING_KEY, record);
    await comeBack("?oauth=pending&state=S-9&code=C-9");
    expect(window.location.hash).toBe("#/settings/mailboxes");
    expect(window.location.pathname).toBe("/");
    expect(new URLSearchParams(window.location.search).get("settings")).toBe("mailboxes");
  });

  it("the single-use values have left the address before the completion is sent", async () => {
    await comeBack("?oauth=pending&state=S-9&code=C-9");
    expect(mockCompletes).toHaveLength(1);
    expect(mockCompletes[0]).toMatchObject({ state: "S-9", code: "C-9" });
    for (const word of ["oauth", "state", "code", "S-9", "C-9"]) expect(mockCompletes[0]!.search).not.toContain(word);
  });

  it("an error return names no ceremony, and its reason is one of the four or the one honest fallback", async () => {
    await comeBack("?oauth=error&reason=%3Cimg%20src%3Dx%3E&state=S-9");
    const { signIn } = await wireFor();
    expect(signIn.returned.read()).toEqual({ kind: "refused", reason: "consent_failed" });
    expect(mockCompletes).toEqual([]);
    expect(window.location.search).not.toContain("reason");
  });

  it("a declined consent comes back as that word", async () => {
    await comeBack("?oauth=error&reason=consent_declined");
    const { signIn } = await wireFor();
    expect(signIn.returned.read()).toEqual({ kind: "refused", reason: "consent_declined" });
  });

  it("a finished one says connected, with the address the provider named", async () => {
    await comeBack("?oauth=pending&state=S-9&code=C-9");
    const { signIn } = await wireFor();
    expect(signIn.returned.read()).toEqual({ kind: "connected", created: true, address: "person@contoso-com.example" });
  });

  it("with no return, nothing came back", async () => {
    const { signIn } = await wireFor();
    expect(signIn.returned.read()).toBeNull();
  });
});
