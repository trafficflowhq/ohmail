import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import {
  ImapAdapter, imapFlowOptions, smtpTransportOptions, resolveImapAuth, isOAuthAuth,
  type ImapConfig,
} from "../../src/adapters/imap.js";
import { SendNotSubmitted } from "../../src/send.js";

/**
 * OAUTH2 AT THE ADAPTER — the freshness story, proven at the line.
 *
 * The whole design is "no mid-session re-auth, no token pinning": `connect()` resolves the token
 * ONCE per dial, and a re-dial (which the worker's reconnect performs by building a fresh adapter)
 * resolves a FRESH one. There is no reconnect machinery here to test — the property is simply that
 * every `connect()` calls `fetchAccessToken`, and the resolved wire form never carries a password.
 */

/** The smallest client `connect()` accepts, on a real EventEmitter (so `close` can be fired). */
class FakeClient extends EventEmitter {
  async list(): Promise<Array<{ path: string; name: string; delimiter: string; flags: Set<string> }>> {
    return [{ path: "INBOX", name: "INBOX", delimiter: "/", flags: new Set<string>() }];
  }
  async logout(): Promise<void> { this.emit("close"); }
}

function oauthConfig(fetchAccessToken: () => Promise<string>): ImapConfig {
  return { host: "imap.example.net", port: 993, secure: true, auth: { user: "u@contoso-com.example", fetchAccessToken } };
}

describe("ImapAdapter.connect — OAuth token resolution", () => {
  it("calls fetchAccessToken exactly ONCE per connect(), and AGAIN on a re-dial after a close", async () => {
    let calls = 0;
    const client = new FakeClient();
    const seen: unknown[] = [];
    const adapter = new ImapAdapter(
      oauthConfig(async () => { calls += 1; return `AT-${calls}`; }),
      { client, onConnectionError: (e) => seen.push(e) },
    );

    await adapter.connect();
    expect(calls, "connect() must fetch a token").toBe(1);

    // A synthetic dead socket — the worker's reconnect trigger. It reaches the adapter's owner…
    client.emit("close");
    expect(seen, "the close reached the connection owner").toHaveLength(1);

    // …and the RE-DIAL fetches a FRESH token rather than reusing a stale one.
    await adapter.connect();
    expect(calls, "a re-dial must fetch a fresh token").toBe(2);
  });

  it("a password config does NOT invoke any token path — the union defaults to the password path", async () => {
    const client = new FakeClient();
    const adapter = new ImapAdapter(
      { host: "h", port: 993, secure: true, auth: { user: "u", pass: "p" } },
      { client },
    );
    // No throw, no token machinery: it simply connects as it always did.
    await expect(adapter.connect()).resolves.toBeUndefined();
  });
});

describe("resolveImapAuth", () => {
  it("awaits the OAuth callback into a literal { user, accessToken } — no callback survives", async () => {
    const resolved = await resolveImapAuth({ user: "u", fetchAccessToken: async () => "TOKEN" });
    expect(resolved).toEqual({ user: "u", accessToken: "TOKEN" });
    expect("fetchAccessToken" in resolved).toBe(false);
    expect("pass" in resolved).toBe(false);
  });

  it("passes a password through byte-for-byte", async () => {
    expect(await resolveImapAuth({ user: "u", pass: "p" })).toEqual({ user: "u", pass: "p" });
  });

  it("isOAuthAuth discriminates the members", () => {
    expect(isOAuthAuth({ user: "u", fetchAccessToken: async () => "t" })).toBe(true);
    expect(isOAuthAuth({ user: "u", pass: "p" })).toBe(false);
  });
});

describe("imapFlowOptions — the RESOLVED oauth wire form", () => {
  it("an oauth-resolved auth becomes { user, accessToken } with NO pass on the wire", () => {
    const opts = imapFlowOptions({
      host: "imap.example.net", port: 993, secure: true,
      auth: { user: "u@contoso-com.example", accessToken: "ACCESS-TOKEN" },
    }) as { auth: Record<string, unknown> };
    expect(opts.auth).toEqual({ user: "u@contoso-com.example", accessToken: "ACCESS-TOKEN" });
    expect("pass" in opts.auth).toBe(false);
  });

  it("a password auth is unchanged — the guard the TLS floor already rests on", () => {
    const opts = imapFlowOptions({
      host: "imap.example.net", port: 993, secure: true, auth: { user: "u", pass: "p" },
    }) as { auth: Record<string, unknown> };
    expect(opts.auth).toEqual({ user: "u", pass: "p" });
  });
});

/** A client that can resolve a Sent folder and accept an append — enough to drive `send()`. */
class SendFakeClient extends EventEmitter {
  appended: Array<{ path: string; flags: string[] }> = [];
  async list(): Promise<Array<{ path: string; name: string; delimiter: string; flags: Set<string>; specialUse?: string }>> {
    return [
      { path: "INBOX", name: "INBOX", delimiter: "/", flags: new Set<string>() },
      { path: "Sent", name: "Sent", delimiter: "/", flags: new Set<string>(), specialUse: "\\Sent" },
    ];
  }
  async append(path: string, _raw: unknown, flags: string[]): Promise<{ uid: number; uidValidity: number }> {
    this.appended.push({ path, flags });
    return { uid: 1, uidValidity: 1 };
  }
  async logout(): Promise<void> { this.emit("close"); }
}

describe("ImapAdapter.send — OAuth is a PER-MESSAGE override, fetched at send time", () => {
  it("fetches a token at send time and hands nodemailer message-level OAuth2 auth", async () => {
    let sendCalls = 0;
    const client = new SendFakeClient();
    const adapter = new ImapAdapter(
      {
        host: "imap.example.net", port: 993, secure: true,
        auth: { user: "u@contoso-com.example", fetchAccessToken: async () => { sendCalls += 1; return `SEND-TOKEN-${sendCalls}`; } },
        smtp: { host: "smtp.office365.com", port: 587, secure: false },
      },
      { client },
    );
    await adapter.connect();
    // connect() resolved one token for IMAP…
    expect(sendCalls).toBe(1);

    // …now intercept the transporter to capture what send() hands nodemailer.
    const sent: Array<Record<string, unknown>> = [];
    (adapter as unknown as { transporter: { sendMail: (m: Record<string, unknown>) => Promise<unknown> } })
      .transporter.sendMail = async (m) => { sent.push(m); return { messageId: m.messageId }; };

    await adapter.send({ from: "u@contoso-com.example", to: "b@example.net", subject: "s", text: "t", messageId: "<x@contoso-com.example>" });

    // A SECOND token was fetched at send time (the transporter outlives any access token)…
    expect(sendCalls).toBe(2);
    // …and it is carried as message-level XOAUTH2 auth, with the fresh token and no password.
    expect(sent[0].auth).toEqual({ type: "OAuth2", user: "u@contoso-com.example", accessToken: "SEND-TOKEN-2" });
    // The Sent copy was still appended.
    expect(client.appended).toHaveLength(1);
  });

  it("a token that cannot be fetched at send time offered nothing: SendNotSubmitted at `token`, nodemailer never called", async () => {
    let calls = 0;
    const outage = Object.assign(new Error("token endpoint 503"), { code: "OAUTH_TOKEN_ENDPOINT_UNAVAILABLE" });
    const adapter = new ImapAdapter(
      {
        host: "imap.example.net", port: 993, secure: true,
        auth: { user: "u@contoso-com.example", fetchAccessToken: async () => { calls += 1; if (calls > 1) throw outage; return "IMAP-TOKEN"; } },
        smtp: { host: "smtp.office365.com", port: 587, secure: false },
      },
      { client: new SendFakeClient() },
    );
    await adapter.connect();
    let offered = 0;
    (adapter as unknown as { transporter: { sendMail: () => Promise<unknown> } }).transporter.sendMail = async () => { offered += 1; return {}; };
    const err = await adapter.send({ from: "u@contoso-com.example", to: "b@example.net", subject: "s", text: "t", messageId: "<t@contoso-com.example>" })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SendNotSubmitted);
    expect({ step: (err as SendNotSubmitted).step, cause: (err as { cause?: unknown }).cause }).toEqual({ step: "token", cause: outage });
    expect(offered, "nothing was handed to SMTP").toBe(0);
  });

  it("a password config leaves the message with NO per-message auth override", async () => {
    const client = new SendFakeClient();
    const adapter = new ImapAdapter(
      {
        host: "imap.example.net", port: 993, secure: true,
        auth: { user: "u@example.net", pass: "p" },
        smtp: { host: "smtp.example.net", port: 587, secure: false, auth: { user: "u@example.net", pass: "p" } },
      },
      { client },
    );
    await adapter.connect();
    const sent: Array<Record<string, unknown>> = [];
    (adapter as unknown as { transporter: { sendMail: (m: Record<string, unknown>) => Promise<unknown> } })
      .transporter.sendMail = async (m) => { sent.push(m); return { messageId: m.messageId }; };
    await adapter.send({ from: "u@example.net", to: "b@example.net", subject: "s", text: "t", messageId: "<y@example.net>" });
    expect(sent[0].auth).toBeUndefined();
  });
});

describe("smtpTransportOptions — oauth SMTP has NO static auth", () => {
  it("an smtp block with no auth (the oauth shape) yields a transporter with no static credential", () => {
    const opts = smtpTransportOptions({
      host: "imap.example.net", port: 993, secure: true,
      auth: { user: "u", fetchAccessToken: async () => "t" },
      smtp: { host: "smtp.office365.com", port: 587, secure: false },
    }) as { auth?: unknown };
    // No password, no token: the token is a PER-MESSAGE override at send time, not transporter state.
    expect(opts.auth).toBeUndefined();
  });
});
