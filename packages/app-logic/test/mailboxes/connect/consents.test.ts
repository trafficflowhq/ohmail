import { describe, expect, it } from "vitest";
import {
  NO_CONSENTS,
  afterRefusal,
  claimsOf,
  linesOf,
  offersOfProbed,
  offersOfRefusal,
  withOffers,
  withTick,
  type Consents,
} from "../../../src/mailboxes/connect/consents.js";
import { NO_DETAILS } from "../../../src/mailboxes/connect/refusal.js";
import type { Refusal, RefusedTls } from "../../../src/mailboxes/connect/types.js";

const SHA = `${"7A:".repeat(31)}7A`;
const SHA_NEW = `${"3C:".repeat(31)}3C`;
const A = "mail-a.home.arpa";
const B = "mail-b.home.arpa";
const tls = (over: Partial<RefusedTls>): RefusedTls => ({
  kind: "tls_unavailable",
  certHost: null,
  expectedHost: null,
  suggestedHost: null,
  plaintext: null,
  trustVariable: null,
  certificate: null,
  ...over,
});
const refused = (transport: "imap" | "smtp", t: RefusedTls): Refusal => ({
  status: 422,
  code: "mailbox_probe_failed",
  message: "",
  details: { ...NO_DETAILS, reason: "tls", transport, tls: t },
});
const noEncryption = (leg: "imap" | "smtp"): Refusal => refused(leg, tls({ plaintext: "offered" }));
const ownCertificate = (leg: "imap" | "smtp", sha256: string): Refusal =>
  refused(leg, tls({ kind: "self_signed", certificate: sha256 }));
/** A press dialled these; the refusal it got back opens what it offers. */
const after = (consents: Consents, refusal: Refusal, sent: { imap: string; smtp: string | null }): Consents =>
  afterRefusal(consents, offersOfRefusal(refusal, sent));

describe("a consent is about one server", () => {
  it("nothing typed, stored or remembered opens a line or claims anything", () => {
    expect(linesOf(NO_CONSENTS, { imap: A, smtp: B })).toEqual([]);
    expect(claimsOf(NO_CONSENTS, { imap: A, smtp: B })).toEqual({ imap: {}, smtp: {} });
    // A tick with no offer behind it claims nothing.
    expect(
      claimsOf(withTick(NO_CONSENTS, "plain", "imap", true, { imap: A, smtp: B }), { imap: A, smtp: B }),
    ).toEqual({ imap: {}, smtp: {} });
  });

  it("an offer comes only from a refusal of that press for a leg it dialled, on a private network", () => {
    expect(offersOfRefusal(noEncryption("imap"), { imap: A, smtp: B })).toEqual([
      { kind: "plain", leg: "imap", host: A },
    ]);
    expect(offersOfRefusal(noEncryption("smtp"), { imap: A, smtp: null })).toEqual([]);
    expect(offersOfRefusal(refused("imap", tls({ plaintext: "not_private" })), { imap: A, smtp: B })).toEqual(
      [],
    );
    expect(offersOfRefusal(ownCertificate("smtp", SHA), { imap: A, smtp: B })).toEqual([
      { kind: "certificate", leg: "smtp", host: B, sha256: SHA },
    ]);
  });

  it("unticked it claims nothing; ticked it rides its own leg alone", () => {
    const offered = after(NO_CONSENTS, noEncryption("imap"), { imap: A, smtp: B });
    expect(linesOf(offered, { imap: A, smtp: B })).toEqual([{ kind: "plain", legs: "imap", on: false }]);
    expect(claimsOf(offered, { imap: A, smtp: B })).toEqual({ imap: {}, smtp: {} });
    const ticked = withTick(offered, "plain", "imap", true, { imap: A, smtp: B });
    expect(linesOf(ticked, { imap: A, smtp: B })).toEqual([{ kind: "plain", legs: "imap", on: true }]);
    expect(claimsOf(ticked, { imap: A, smtp: B })).toEqual({ imap: { allowInsecure: true }, smtp: {} });
  });

  it("a tick for one server is none for another: the claim is read against the host now", () => {
    const ticked = withTick(
      after(NO_CONSENTS, noEncryption("imap"), { imap: A, smtp: B }),
      "plain",
      "imap",
      true,
      { imap: A, smtp: B },
    );
    expect(claimsOf(ticked, { imap: B, smtp: B })).toEqual({ imap: {}, smtp: {} });
    expect(linesOf(ticked, { imap: B, smtp: B })).toEqual([]);
    expect(claimsOf(ticked, { imap: `${A}:1143`, smtp: B })).toEqual({ imap: {}, smtp: {} });
    // Back on the server it was given for, it stands again only because nothing dropped it; the form drops it on the change.
    expect(claimsOf(ticked, { imap: A, smtp: B })).toEqual({ imap: { allowInsecure: true }, smtp: {} });
  });

  it("one host on both legs is one line for both, and ticking it ticks both", () => {
    const offered = after(NO_CONSENTS, noEncryption("imap"), { imap: A, smtp: A });
    expect(linesOf(offered, { imap: A, smtp: A })).toEqual([{ kind: "plain", legs: "both", on: false }]);
    const ticked = withTick(offered, "plain", "both", true, { imap: A, smtp: A });
    expect(linesOf(ticked, { imap: A, smtp: A })).toEqual([{ kind: "plain", legs: "both", on: true }]);
    expect(claimsOf(ticked, { imap: A, smtp: A })).toEqual({
      imap: { allowInsecure: true },
      smtp: { allowInsecure: true },
    });
  });

  it("two hosts, both offered: a line each, and a tick of one is not a tick of the other", () => {
    let c = after(NO_CONSENTS, noEncryption("imap"), { imap: A, smtp: B });
    c = after(c, noEncryption("smtp"), { imap: A, smtp: B });
    c = withTick(c, "plain", "imap", true, { imap: A, smtp: B });
    expect(linesOf(c, { imap: A, smtp: B })).toEqual([
      { kind: "plain", legs: "imap", on: true },
      { kind: "plain", legs: "smtp", on: false },
    ]);
    expect(claimsOf(c, { imap: A, smtp: B }).smtp).toEqual({});
  });

  it("un-ticking withdraws the claim", () => {
    const now = { imap: A, smtp: B };
    const ticked = withTick(after(NO_CONSENTS, noEncryption("imap"), now), "plain", "imap", true, now);
    expect(claimsOf(withTick(ticked, "plain", "imap", false, now), now)).toEqual({ imap: {}, smtp: {} });
  });
});

describe("a refused press that offers nothing", () => {
  const now = { imap: A, smtp: B };
  const ticked = withTick(after(NO_CONSENTS, noEncryption("imap"), now), "plain", "imap", true, now);

  it("leaves no older offer and no tick: no line stays ticked beside a sentence that the server is not private", () => {
    const refusedAgain = after(ticked, refused("imap", tls({ plaintext: "not_private" })), now);
    expect(refusedAgain).toEqual({ offers: [], ticks: [] });
    expect(linesOf(refusedAgain, now)).toEqual([]);
    expect(claimsOf(refusedAgain, now)).toEqual({ imap: {}, smtp: {} });
  });

  it("one that offers for the other server leaves the first one's line and its tick: both can be consented to", () => {
    expect(linesOf(after(ticked, noEncryption("smtp"), now), now)).toEqual([
      { kind: "plain", legs: "imap", on: true },
      { kind: "plain", legs: "smtp", on: false },
    ]);
  });

  it("a passed test that offers nothing clears nothing: the consent it rode stands for the connect", () => {
    const passed = withOffers(ticked, offersOfProbed({ host: A, user: "u", folders: 3 }, now));
    expect(claimsOf(passed, now)).toEqual({ imap: { allowInsecure: true }, smtp: {} });
  });
});

describe("a trusted certificate is that one certificate", () => {
  const now = { imap: A, smtp: B };

  it("is claimed by its fingerprint, for the leg and the host it was offered for", () => {
    const ticked = withTick(
      after(NO_CONSENTS, ownCertificate("imap", SHA), now),
      "certificate",
      "imap",
      true,
      now,
    );
    expect(linesOf(ticked, now)).toEqual([{ kind: "certificate", legs: "imap", on: true, sha256: SHA }]);
    expect(claimsOf(ticked, now)).toEqual({ imap: { trustCertificate: SHA }, smtp: {} });
    expect(claimsOf(ticked, { imap: B, smtp: B })).toEqual({ imap: {}, smtp: {} });
  });

  it("a certificate that changed un-ticks its line: the tick was for the fingerprint it showed", () => {
    const ticked = withTick(
      after(NO_CONSENTS, ownCertificate("imap", SHA), now),
      "certificate",
      "imap",
      true,
      now,
    );
    const changed = after(ticked, ownCertificate("imap", SHA_NEW), now);
    expect(linesOf(changed, now)).toEqual([
      { kind: "certificate", legs: "imap", on: false, sha256: SHA_NEW },
    ]);
    expect(claimsOf(changed, now)).toEqual({ imap: {}, smtp: {} });
  });

  it("one host and one certificate is one line for both; two certificates are two lines", () => {
    const same = { imap: A, smtp: A };
    let one = after(NO_CONSENTS, ownCertificate("imap", SHA), same);
    expect(linesOf(one, same)).toEqual([{ kind: "certificate", legs: "both", on: false, sha256: SHA }]);
    one = withTick(one, "certificate", "both", true, same);
    expect(claimsOf(one, same)).toEqual({ imap: { trustCertificate: SHA }, smtp: { trustCertificate: SHA } });
    const two = after(one, ownCertificate("smtp", SHA_NEW), same);
    expect(linesOf(two, same).map((line) => line.legs)).toEqual(["imap", "smtp"]);
  });
});

describe("what a passed test offers", () => {
  it("the sending leg's own: no encryption on this network, or its own certificate", () => {
    const sent = { imap: A, smtp: B };
    const ok = { host: A, user: "u", folders: 3 };
    expect(
      offersOfProbed(
        {
          ...ok,
          sending: {
            state: "refused",
            host: B,
            reason: "tls",
            tls: { kind: "tls_unavailable", plaintext: "offered" },
          },
        },
        sent,
      ),
    ).toEqual([{ kind: "plain", leg: "smtp", host: B }]);
    expect(
      offersOfProbed(
        {
          ...ok,
          sending: {
            state: "refused",
            host: B,
            reason: "tls",
            tls: { kind: "self_signed", certificate: { sha256: SHA } },
          },
        },
        sent,
      ),
    ).toEqual([{ kind: "certificate", leg: "smtp", host: B, sha256: SHA }]);
    expect(
      offersOfProbed(
        {
          ...ok,
          sending: {
            state: "refused",
            host: B,
            reason: "tls",
            tls: { kind: "self_signed", certificate: { sha256: "AB:CD" } },
          },
        },
        sent,
      ),
    ).toEqual([]);
    expect(offersOfProbed({ ...ok, sending: { state: "ok", host: B } }, sent)).toEqual([]);
    expect(
      offersOfProbed(
        {
          ...ok,
          sending: {
            state: "refused",
            host: B,
            reason: "tls",
            tls: { kind: "tls_unavailable", plaintext: "offered" },
          },
        },
        { imap: A, smtp: null },
      ),
    ).toEqual([]);
  });
});
