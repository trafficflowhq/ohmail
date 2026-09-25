import { describe, expect, it } from "vitest";
import {
  askFor, incomingFromAsk, knownIncoming, readServerUnknown,
} from "../src/sign-in-again-server.js";

/**
 * WHERE "SIGN IN AGAIN" DIALS FOR A MAILBOX AN EARLIER VERSION SIGNED OUT WITH NOTHING KEPT. A
 * provider FACT places the server (the named preset it was added as, or the named preset its
 * outgoing server belongs to); the address's domain only pre-fills the ask-once form.
 */
describe("the server a signed-out mailbox is placed by", () => {
  const hint = (over: Partial<{ provider: string | null; login: string | null; outgoingHost: string | null }>) =>
    ({ provider: "imap", login: null, outgoingHost: null, ...over });

  it("reads only its own refusal, field by field", () => {
    expect(readServerUnknown("mailbox_probe_failed", { provider: "gmail" })).toBeNull();
    expect(readServerUnknown(undefined, undefined)).toBeNull();
    expect(readServerUnknown("mailbox_server_unknown", undefined))
      .toEqual({ provider: null, login: null, outgoingHost: null });
    expect(readServerUnknown("mailbox_server_unknown", { provider: 7, login: " ", outgoingHost: "smtp.x.test" }))
      .toEqual({ provider: null, login: null, outgoingHost: "smtp.x.test" });
  });

  it("the named provider the mailbox was added as places it", () => {
    expect(knownIncoming(hint({ provider: "fastmail" }), "me@example.test"))
      .toEqual({ host: "imap.fastmail.com", port: 993, secure: true, user: "me@example.test" });
  });

  it("…and so does the named provider its outgoing server belongs to, with the kept login", () => {
    expect(knownIncoming(hint({ outgoingHost: "SMTP.gmail.com", login: "the-login" }), "me@example.test"))
      .toEqual({ host: "imap.gmail.com", port: 993, secure: true, user: "the-login" });
  });

  it("nothing else places it — not the generic entry, an unknown id, a foreign server or the address", () => {
    /* `providerById` falls back to the generic entry for an unknown id; that fallback must never
       read as a fact here. */
    expect(knownIncoming(hint({ provider: "no-such-provider" }), "me@example.test")).toBeNull();
    expect(knownIncoming(hint({ outgoingHost: "smtp.example.test" }), "me@example.test")).toBeNull();
    expect(knownIncoming(hint({}), "me@gmail.com"), "the address's domain dialled a server").toBeNull();
  });

  it("the ask starts from the address's guess and the kept login, and says the outgoing server", () => {
    expect(askFor(hint({ login: "the-login", outgoingHost: "mail.example.test" }), "me@gmail.com"))
      .toEqual({ host: "imap.gmail.com", port: "993", user: "the-login", outgoingHost: "mail.example.test" });
    expect(askFor(hint({}), " me@example.test "))
      .toEqual({ host: "", port: "993", user: "me@example.test", outgoingHost: null });
  });

  it("the ask is sent only whole, with TLS as the port says", () => {
    const ask = { host: " mail.example.test ", port: "143", user: "the-login", outgoingHost: null };
    expect(incomingFromAsk(ask)).toEqual({ host: "mail.example.test", port: 143, secure: false, user: "the-login" });
    expect(incomingFromAsk({ ...ask, port: "993" })?.secure).toBe(true);
    expect(incomingFromAsk({ ...ask, host: "  " })).toBeNull();
    expect(incomingFromAsk({ ...ask, user: "" })).toBeNull();
    for (const port of ["", "0", "65536", "99x", "1.5"]) expect(incomingFromAsk({ ...ask, port }), port).toBeNull();
  });
});
