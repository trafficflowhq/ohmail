import type { AuthVerdict } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { managedDomain } from "../../../test/support/fixture-credentials.js";
import {
  corroboratedCounterparties, counterpartyEvidence, isCorroboratedCounterparty,
  mayGroupByMessageId, mergeCounterpartyEvidence,
  type CounterpartyEvidence, type CounterpartyMessage,
} from "../src/sender-headers.js";

/**
 * THE ONE RULE for reading a sender's own words as identity or as rank.
 *
 * The four sites that consult it — the twin collapse, the thread-join verdict, the address book
 * and the consent cutline — each have their own guard; these are the rule's own, so a change to
 * the classification is visible here rather than only in whichever of the four happens to run.
 */

type Recipients = readonly (string | null | undefined)[];

/** `authVerdict: null` is "nobody asked" — the permissive member, and the ordinary case. */
const inbound = (
  from: string | null, recipients: Recipients = [], authVerdict: AuthVerdict | null = null,
): CounterpartyMessage => ({ ownAuthored: false, from, recipients, authVerdict });

const ours = (recipients: Recipients): CounterpartyMessage =>
  ({ ownAuthored: true, from: null, recipients, authVerdict: null });

describe("who put this address on the conversation", () => {
  /**
   * ═══ A FORGED `From` IS A CLAIM ═══════════════════════════════════════════════════════════
   *
   * `they_wrote` says the delivery corroborates that this address wrote to us. Where the sending
   * side's own check says the claimed author is forged, it corroborates nothing — so the address
   * drops to `sender_named`, which every consumer already treats as a claim.
   *
   * ONLY an explicit `fail` demotes. Requiring `pass` would make a consented identity depend on
   * whether somebody's provider publishes Authentication-Results, which is the precondition
   * `pipeline.ts` states must never exist ("there is no `auth !== 'pass'` anywhere").
   */
  it("a message whose own provider says the author is FORGED is not a correspondent", () => {
    const out = counterpartyEvidence([inbound("ceo@bank.example", ["me@own.example"], "fail")]);
    expect(out.get("ceo@bank.example")).toBe("sender_named");
    expect(isCorroboratedCounterparty(out.get("ceo@bank.example"))).toBe(false);
  });

  it("every other verdict is admitted — `pass` is never a precondition", () => {
    for (const v of [null, "unauthenticated", "unavailable", "pass"] as const) {
      const out = counterpartyEvidence([inbound("nora@partner.example", [], v)]);
      expect(out.get("nora@partner.example"), `verdict ${String(v)} was refused`).toBe("they_wrote");
    }
  });

  it("a forged author does not lose us the OTHER facts on the message", () => {
    // The recipients of somebody else's mail are their claim whatever the verdict says, and a
    // demotion of the author must not quietly promote or drop them.
    const out = counterpartyEvidence([inbound("ceo@bank.example", ["cfo@own.example"], "fail")]);
    expect(out.get("cfo@own.example")).toBe("sender_named");
  });

  it("a forged claim cannot outrank a real record of writing to that address", () => {
    const out = counterpartyEvidence([
      ours(["nora@partner.example"]),
      inbound("nora@partner.example", [], "fail"),
    ]);
    expect(out.get("nora@partner.example"), "we did write to her").toBe("we_wrote");
  });

  it("a message WE wrote makes its recipients our own record", () => {
    expect(counterpartyEvidence([ours(["nora@partner.example"])]))
      .toEqual(new Map([["nora@partner.example", "we_wrote"]]));
  });

  it("a message we did NOT write names its author, and only claims about the rest", () => {
    const out = counterpartyEvidence([inbound("stranger@x.example", ["colleague@own.example"])]);
    expect(out.get("stranger@x.example")).toBe("they_wrote");
    // The whole subject: a `To`/`Cc` on somebody else's mail is that sender's claim.
    expect(out.get("colleague@own.example")).toBe("sender_named");
  });

  it("keeps the STRONGEST evidence per address, whatever order the messages arrive in", () => {
    const claimFirst = [
      inbound("stranger@x.example", ["nora@partner.example"]),
      ours(["nora@partner.example"]),
    ];
    const claimLast = [...claimFirst].reverse();
    for (const world of [claimFirst, claimLast]) {
      expect(counterpartyEvidence(world).get("nora@partner.example")).toBe("we_wrote");
    }
  });

  it("lowercases and trims, so two spellings of one address are one entry", () => {
    const out = counterpartyEvidence([ours([" Nora@Partner.Example "])]);
    expect([...out.keys()]).toEqual(["nora@partner.example"]);
  });

  it("ignores an empty or absent address rather than keying on it", () => {
    expect(counterpartyEvidence([inbound("", [""]), ours([undefined, null])]).size).toBe(0);
  });

  it("does not subtract the account's own addresses — that is each caller's own question", () => {
    // The join verdict subtracts them at its overlap; the address book excludes them at its
    // filter. Doing it here as well would be a second answer to one question.
    const out = counterpartyEvidence([ours(["me@own.example"])]);
    expect(out.get("me@own.example")).toBe("we_wrote");
  });
});

describe("what a grouping or a ranking may act on", () => {
  it("admits ours and theirs, refuses a third party's claim", () => {
    expect(isCorroboratedCounterparty("we_wrote")).toBe(true);
    expect(isCorroboratedCounterparty("they_wrote")).toBe(true);
    expect(isCorroboratedCounterparty("sender_named")).toBe(false);
    expect(isCorroboratedCounterparty(undefined)).toBe(false);
  });

  it("the corroborated set drops the named-only addresses", () => {
    const set = corroboratedCounterparties([
      ours(["written@x.example"]),
      inbound("wrote@x.example", ["named@x.example"]),
    ]);
    expect([...set].sort()).toEqual(["written@x.example", "wrote@x.example"]);
  });
});

describe("merging two conversations' facts", () => {
  it("keeps the stronger side, in both directions", () => {
    const into = new Map<string, CounterpartyEvidence>([["a@x.example", "sender_named"]]);
    mergeCounterpartyEvidence(into, new Map([["a@x.example", "we_wrote"]]));
    expect(into.get("a@x.example")).toBe("we_wrote");
    mergeCounterpartyEvidence(into, new Map([["a@x.example", "sender_named"]]));
    expect(into.get("a@x.example"), "a claim never overwrites our own record").toBe("we_wrote");
  });

  it("adds an address the other side brought", () => {
    const into = new Map<string, CounterpartyEvidence>();
    mergeCounterpartyEvidence(into, new Map([["b@x.example", "they_wrote"]]));
    expect(into.get("b@x.example")).toBe("they_wrote");
  });
});

describe("a Message-ID may key identity only on our own outbound copies", () => {
  it("admits a row the engine minted and one the server filed in Sent", () => {
    expect(mayGroupByMessageId({ messageIdHeader: `x@${managedDomain()}`, ownOutbound: true })).toBe(true);
  });

  it("refuses an inbound row, whatever its header says", () => {
    expect(mayGroupByMessageId({ messageIdHeader: `x@${managedDomain()}`, ownOutbound: false })).toBe(false);
  });

  it("refuses a row with no header — absence is not an identity two strangers can share", () => {
    expect(mayGroupByMessageId({ messageIdHeader: null, ownOutbound: true })).toBe(false);
    expect(mayGroupByMessageId({ messageIdHeader: "", ownOutbound: true })).toBe(false);
    expect(mayGroupByMessageId({ messageIdHeader: undefined, ownOutbound: true })).toBe(false);
  });
});
