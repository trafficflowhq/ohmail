/** @vitest-environment jsdom */
/**
 * A MICROSOFT SIGN-IN STARTED IN /JOIN GOES BACK TO /JOIN. Microsoft's bounce always lands on `/`, where
 * the shell finishes the ceremony at module load. A start the wizard made is finished there behind the
 * shell's loading gate, with the single-use values out of the address bar before the POST; then the
 * browser goes back to /join carrying the outcome's kind and reason, never the address. The real client
 * and the real shell module over a fetch double.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";

const ADDRESS = "mila.brunner@lichtgrat.example";
const SESSION = {
  user: {
    userId: "u1", accountId: "a1", email: "pat@family.example", displayName: "Pat", emailVerified: true,
    twofaEnrolled: { webauthn: true, totp: false, recoveryCodes: true },
  },
  scope: "full",
};

let calls: Array<{ url: string; at: string }> = [];
let release: (() => void) | null = null;
/** The server's own repair of a jar with no `tf_owner`: `GET /auth/session` writes it back (`healOwnerMarker`). */
let healsMarker = false;
let replaced: string | null = null;
let originalFetch: typeof globalThis.fetch;
const realLocation = Object.getOwnPropertyDescriptor(window, "location")!;

beforeEach(() => {
  calls = [];
  release = null;
  healsMarker = false;
  replaced = null;
  sessionStorage.clear();
  document.cookie = "tf_owner=; path=/; max-age=0";
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    calls.push({ url, at: document.URL });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/auth/session")) {
      if (healsMarker) document.cookie = "tf_owner=a1; path=/";
      return json(200, SESSION);
    }
    if (url.includes("/oauth/microsoft/start")) return json(201, { authorizeUrl: "https://login.microsoftonline.com/x", state: "STATE-R" });
    if (url.includes("/oauth/microsoft/complete")) {
      if (release === null) await new Promise<void>((go) => { release = go; });
      return json(201, {
        mailbox: { id: "mb1", provider: "microsoft", address: ADDRESS, displayName: null, status: "connected", lastSyncAt: null, createdAt: null },
        created: true, returnTo: "/join",
      });
    }
    if (url.includes("/mailboxes")) return json(200, { items: [] });
    return json(200, {});
  }) as unknown as typeof globalThis.fetch;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      get href() { return document.URL; },
      get origin() { return new URL(document.URL).origin; },
      get search() { return new URL(document.URL).search; },
      get pathname() { return new URL(document.URL).pathname; },
      get hash() { return new URL(document.URL).hash; },
      assign: () => {},
      replace: (url: string) => { replaced = url; },
    },
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(window, "location", realLocation);
  document.cookie = "tf_owner=; path=/; max-age=0";
  vi.restoreAllMocks();
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/** A fresh page load: the shell's module, whose import IS the landing. */
async function loadAt(url: string) {
  window.history.replaceState(null, "", url);
  vi.resetModules();
  process.env.NEXT_PUBLIC_API_BASE = "/api";
  delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
  await import("../app/(product)/mailbox/CloudShell.js");
  return import("../app/(product)/mailbox/oauth-return.js");
}

/** What the wizard's press leaves in this tab before it leaves for Microsoft. */
async function startFrom(landing: "join" | "first-run"): Promise<void> {
  vi.resetModules();
  process.env.NEXT_PUBLIC_API_BASE = "/api";
  const { startMicrosoftSignIn } = await import("../app/(product)/mailbox/microsoft-door.js");
  expect(await startMicrosoftSignIn({ landing, owner: () => "a1" })).toBe(true);
}

const completes = () => calls.filter((c) => c.url.includes("/oauth/microsoft/complete"));
const stored = (): string => {
  const out: string[] = [];
  for (let i = 0; i < sessionStorage.length; i += 1) out.push(sessionStorage.getItem(sessionStorage.key(i)!) ?? "");
  return out.join("\n");
};

describe("the return of a sign-in the wizard started", () => {
  it("finishes at `/` behind the shell's loading gate, then goes back to /join", async () => {
    await startFrom("join");
    document.cookie = "tf_owner=a1; path=/";
    const mod = await loadAt("/?settings=mailboxes&oauth=pending&state=STATE-R&code=CODE-R#/settings");
    await settle();

    expect(completes(), "the completion was sent from the landing").toHaveLength(1);
    expect(completes()[0]!.at, "the code left the address bar before the POST").not.toContain("CODE-R");
    const bar = new URL(document.URL);
    expect([...bar.searchParams.keys()], "nothing single-use and no pane is left in the bar").toEqual([]);
    expect(bar.hash, "the wait is not the Settings pane").toBe("");

    // While Microsoft's answer is awaited the shell draws the gate, not the mail client.
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { NextIntlClientProvider } = await import("next-intl");
    const { CloudShell } = await import("../app/(product)/mailbox/CloudShell.js");
    (globalThis as unknown as { React: unknown }).React = React;
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(NextIntlClientProvider, {
        locale: "en", messages: en, timeZone: "UTC", children: React.createElement(CloudShell, { demo: false }),
      }));
    });
    const gate = host.querySelector('main.gate[aria-busy="true"]');
    expect(gate, "no loading gate").toBeTruthy();
    expect(gate!.textContent).toBe("ohmail");
    expect(host.querySelector(".app-root"), "the mail client mounted under a sign-in in flight").toBeNull();
    expect(replaced, "left before the answer").toBeNull();

    await act(async () => { release!(); await settle(); });
    expect(replaced).toBe("/join");
    expect(mod.takeJoinOAuthOutcome()).toEqual({ kind: "connected" });
    expect(stored(), "the address is kept nowhere in this tab").not.toContain(ADDRESS);
    await act(async () => root.unmount());
    host.remove();
  });

  it("a session born in sign-up, with no tf_owner in the jar, is asked first and still completes", async () => {
    await startFrom("join");
    healsMarker = true;
    release = () => {};
    const mod = await loadAt("/?settings=mailboxes&oauth=pending&state=STATE-R&code=CODE-R#/settings");
    await settle();

    const read = calls.findIndex((c) => c.url.includes("/auth/session"));
    const done = calls.findIndex((c) => c.url.includes("/oauth/microsoft/complete"));
    expect(done, "the account gate refused the completion as `absent`").toBeGreaterThan(-1);
    expect(read, "the session was not asked before the completion").toBeGreaterThan(-1);
    expect(read).toBeLessThan(done);
    expect(replaced).toBe("/join");
    expect(mod.takeJoinOAuthOutcome()).toEqual({ kind: "connected" });
  });

  it("an error return carries no state, and still goes back to /join with its reason", async () => {
    await startFrom("join");
    const mod = await loadAt("/?settings=mailboxes&oauth=error&reason=consent_declined#/settings");
    await settle();
    expect(completes()).toHaveLength(0);
    expect(new URL(document.URL).searchParams.get("reason")).toBeNull();
    expect(replaced).toBe("/join");
    expect(mod.takeJoinOAuthOutcome()).toEqual({ kind: "refused", reason: "consent_declined" });
    // One-time: the wizard reads it once.
    expect(mod.takeJoinOAuthOutcome()).toBeNull();
  });

  it("a first-run start lands on the setup stage, and the shell finishes it there", async () => {
    await startFrom("first-run");
    document.cookie = "tf_owner=a1; path=/";
    release = () => {};
    await loadAt("/?settings=mailboxes&oauth=pending&state=STATE-R&code=CODE-R#/settings");
    await settle();
    expect(completes()).toHaveLength(1);
    expect(window.location.hash).toBe("#/first-run");
    expect(new URL(document.URL).searchParams.get("settings")).toBeNull();
    expect(replaced).toBeNull();
  });
});
