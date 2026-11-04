import { describe, expect, it, vi } from "vitest";
import { Copy } from "../src/copy";
import { connectionSaid, connectionSay } from "../src/state/live";
import { resupplyPassword } from "../src/net/mailboxes";
import { maySignInAgain } from "../src/ui/standalone-form";

/**
 * ═══ A PASSWORD CHANGED AT THE PROVIDER, AND THE PHONE CAN GIVE THE NEW ONE ═════════════════
 *
 * Measured on the desktop of the same release and true of this app for the same reason: a
 * mailbox the server had started refusing offered no way to re-supply a password. Here it was
 * worse by one step — the refusal was SILENT. `connectionSaid` answered null for it on the
 * stated ground that nothing was re-dialling, so a phone that had stopped syncing said nothing
 * at all and the only way back was forgetting the mailbox and opening it again, which takes this
 * phone's copy of the mail with it.
 *
 * ── WHAT IS DRIVEN, AND WHAT A DOUBLE MAY NOT DO HERE ─────────────────────────────────────
 *
 * The decision, the sentence and the REQUEST — the three things this app owns. The engine's
 * behaviour on that request is not doubled here at all: it is measured against a real adapter
 * and a real mail server in `apps/sidecar/test/seed-password-resupply.imap.test.ts`, because a
 * double that answered `sealed` where the engine answers a refusal would have hidden both the
 * fix and its guard.
 *
 * Mutations watched red and restored:
 *  · `maySignInAgain` returning true for a door with no id → the no-id case;
 *  · the body sent as `{ imap: {} }`                        → the request case;
 *  · the refusal's own sentence replaced by the status      → the refused case;
 *  · `connectionSaid` returning null for `refused` again    → the sentence case.
 */

describe("the verb is offered where there is a mailbox to send to", () => {
  it("is offered on a door that has named its mailbox", () => {
    expect(maySignInAgain({ id: "m1" })).toBe(true);
  });

  it("is withheld where nothing names a mailbox — the press would address nobody", () => {
    expect(maySignInAgain(null)).toBe(false);
    expect(maySignInAgain({ id: null })).toBe(false);
    expect(maySignInAgain({ id: "" })).toBe(false);
  });
});

describe("resupplyPassword — the request, and the words a refusal comes back with", () => {
  const session = (res: Partial<Response> | Error) => {
    const fetch = vi.fn(async () => {
      if (res instanceof Error) throw res;
      return res as Response;
    });
    return {
      it: {
        profile: { origin: "https://srv.test", accountId: "a" },
        fetch,
      } as unknown as Parameters<typeof resupplyPassword>[0],
      fetch,
    };
  };

  it("sends the password to that mailbox's own path, and nothing else with it", async () => {
    const s = session({ ok: true, status: 200 });
    expect(await resupplyPassword(s.it, "m1", "replacement-entry-password")).toEqual({ kind: "sealed" });
    expect(s.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = s.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/local/mailboxes/m1");
    expect(init.method).toBe("PATCH");
    /* THE SERVER, THE PORT AND THE USERNAME ARE NOT IN IT. They are in the credential this
       mailbox was proved against, and nothing on this phone is told them — a body that carried
       them would be this app inventing coordinates it never read. */
    expect(init.body).toBe(JSON.stringify({ imap: { pass: "replacement-entry-password" } }));
  });

  it("a refusal carries the engine's own sentence, and nothing was stored", async () => {
    const s = session({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: "mailbox_probe_failed", message: "the server said no" } }),
    });
    expect(await resupplyPassword(s.it, "m1", "still-wrong"))
      .toEqual({ kind: "refused", detail: "the server said no" });
    /* ONE ATTEMPT. A refused sign-in retried is how a wrong password becomes a locked account,
       which is the rule the engine keeps and this app must not undo from outside. */
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });

  it("a refusal with no sentence keeps its number rather than inventing one", async () => {
    const s = session({ ok: false, status: 503, json: async () => ({}) });
    expect(await resupplyPassword(s.it, "m1", "x")).toEqual({ kind: "refused", detail: "503" });
  });

  it("a transport that threw is quoted, not swallowed", async () => {
    const s = session(new Error("the engine is not answering"));
    const out = await resupplyPassword(s.it, "m1", "x");
    expect(out.kind).toBe("refused");
    expect(out.kind === "refused" && out.detail).toContain("not answering");
  });
});

describe("a refused sign-in is said, where it used to be silence", () => {
  const say = (over: Record<string, unknown>) => connectionSay(
    { reachable: false, unreachableSince: null, signInRefused: false, ...over } as never,
    new Date("2026-09-18T12:00:00Z"),
    "UTC",
  );

  it("names the refusal in the words every other surface uses", () => {
    expect(connectionSaid(say({ signInRefused: true }))).toBe(Copy.connectionSignInRefused);
  });

  it("and is still not dressed as an outage — the two sentences stay apart", () => {
    /* The reason it was silent was that "Connection lost. Reconnecting…" is a promise nothing is
       keeping. That stays true: this is a different sentence, not the outage one. */
    expect(connectionSaid(say({ signInRefused: true }))).not.toBe(Copy.connectionLost);
    expect(connectionSaid(say({}))).toBe(Copy.connectionLost);
    expect(connectionSaid(say({ reachable: true }))).toBeNull();
  });
});
