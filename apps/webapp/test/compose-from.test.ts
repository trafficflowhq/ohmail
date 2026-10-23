/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { OhmailEngine, type EngineMutation, type MutationResult } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";
import type { MailboxFacts } from "../app/shell/mail-state";
import {
  defaultFrom,
  domainMatchedFrom,
  optionsFromFacts,
  optionsFromMirror,
  replyAllRecipients,
  replyRecipients,
  resolveComposeFrom,
  resolveReplyFrom,
} from "../app/shell/compose-from";
import { composeDraftKey } from "../app/shell/compose";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * WHICH ADDRESS IS ANSWERING.
 *
 * ── THE DEFECT, AS IT SHIPPED ───────────────────────────────────────────────────────────
 *
 * Compose resolved its sender through `sendingMailboxId` — the mailbox holding the account's
 * NEWEST MESSAGE — and rendered no From line at all. Production has connected mailboxes on more
 * than one address, so the From flipped with whichever address last received mail, and nothing
 * on screen said which one had won. With a single mailbox it was no better: a stranger could
 * not tell what address they were writing from.
 *
 * ── WHY THESE TESTS DRIVE THE REAL SHELL ────────────────────────────────────────────────
 *
 * Because the row exists precisely because a WORKING DATA PATH WITH NOTHING ON SCREEN passed
 * every test it had. `composePlan` was correct, `Engine.enrich` was correct, `POST /drafts`
 * was correct — and the surface rendered To, Subject and an editor. So the acceptance here is
 * the rendered surface: `#compose-from` in the DOM, `.reply-from` in the reply editor, and the
 * mutation the shell actually dispatched. A unit test over `resolveComposeFrom` alone would
 * have gone green against the shipped bug.
 *
 * Part 1 is the pure rule, one row at a time. Part 2 mounts `AppShell` on the fixture world
 * with a real mailbox probe and reads what a user would see.
 */

/* ══════════════════════════════════════════════════════════════════════════════════════════
   PART 1 — THE RULE
   ══════════════════════════════════════════════════════════════════════════════════════════ */

const fact = (over: Partial<MailboxFacts> = {}): MailboxFacts => ({
  id: "mb1",
  address: "one@example.test",
  status: "connected",
  errorCode: null,
  disabledReason: null,
  syncBlockedReason: null,
  syncBlockedSince: null,
  lastSyncAt: null,
  initialImportCompletedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const OLD = fact({ id: "old", address: "old@example.test", createdAt: "2024-01-05T00:00:00.000Z" });
const NEW = fact({ id: "new", address: "new@example.test", createdAt: "2025-03-02T00:00:00.000Z" });

/** The verb's LABEL, without the keycap the button also wears (`<Key chord>` / the send
 * chord's cap print the registry's key into the button, so textContent grew a suffix). */
const buttonLabel = (b: HTMLElement): string => {
  const kbd = b.querySelector("kbd")?.textContent ?? "";
  return (b.textContent ?? "").replace(kbd, "").trim();
};

describe("the fresh-compose default", () => {
  it("is the OLDEST connected mailbox, whatever order the server listed them in", () => {
    // Handed newest-first, which is the order `GET /mailboxes` happens to answer in.
    const options = optionsFromFacts([NEW, OLD]);
    expect(options.map((o) => o.id), "options are not oldest-first").toEqual(["old", "new"]);
    expect(resolveComposeFrom(options, null).mailboxId).toBe("old");
    expect(resolveComposeFrom(options, null).address).toBe("old@example.test");
  });

  it("skips a DISABLED oldest and takes the oldest that can actually send", () => {
    const options = optionsFromFacts([fact({ ...OLD, status: "disabled" }), NEW]);
    expect(defaultFrom(options)?.id).toBe("new");
  });

  it("never OFFERS a disabled mailbox — the server refuses it, so the control must not show it", () => {
    const resolved = resolveComposeFrom(optionsFromFacts([OLD, fact({ ...NEW, status: "disabled" })]), null);
    expect(resolved.choices.map((o) => o.id)).toEqual(["old"]);
  });

  /**
   * `sendable` is `!== "disabled"`, NOT `=== "connected"`, and this is the server's own rule:
   * `SendService.reserve` refuses only `'disabled'` because `'error'` is the sync worker's
   * verdict about IMAP and SMTP is a different transport. A UI that hid an `error` mailbox
   * would be inventing a refusal nobody wrote, and would strand the outbox on a fault the user
   * did not cause.
   */
  it("still offers a mailbox in `error` — that is an IMAP verdict, not an SMTP one", () => {
    const options = optionsFromFacts([fact({ ...OLD, status: "error", errorCode: "auth" }), NEW]);
    expect(options.find((o) => o.id === "old")?.sendable, "an `error` mailbox was hidden").toBe(true);
    // …but the DEFAULT still prefers a healthy one.
    expect(defaultFrom(options)?.id).toBe("new");
  });

  it("falls back to a merely-sendable mailbox when nothing at all is connected", () => {
    const options = optionsFromFacts([fact({ ...OLD, status: "error" })]);
    expect(defaultFrom(options)?.id).toBe("old");
  });

  it("names nothing when the account's mailboxes cannot be seen", () => {
    // `[]` here is "we cannot see", not "there are none" — the caller keeps its old fallback
    // and renders no From line. Claiming an address we cannot name is the failure this closes.
    expect(resolveComposeFrom([], null)).toMatchObject({ mailboxId: null, address: null });
  });
});

describe("the pick is a mailbox id, and only a mailbox id", () => {
  it("honours a stored pick that is still a real choice", () => {
    expect(resolveComposeFrom(optionsFromFacts([OLD, NEW]), "new").mailboxId).toBe("new");
  });

  /**
   * THE ALIAS CONSTRAINT, held down before aliases exist. An address is not a handle: the day
   * one mailbox carries three of them, an address-keyed pick has no answer. So an address
   * string is not a valid pick and cannot become what is submitted — it resolves to the
   * default, exactly like any other id this account does not have.
   */
  it("refuses an ADDRESS STRING as the pick and falls back to the default", () => {
    const resolved = resolveComposeFrom(optionsFromFacts([OLD, NEW]), "new@example.test");
    expect(resolved.mailboxId, "an address string was accepted as the selector's value").toBe("old");
  });

  it("re-derives when the picked mailbox has since been disconnected", () => {
    const options = optionsFromFacts([OLD, fact({ ...NEW, status: "disabled" })]);
    expect(resolveComposeFrom(options, "new").mailboxId).toBe("old");
  });

  /* A removed mailbox's drafts stay, so reopening one whose mailbox cannot send is
     the ordinary path now. The fallback is SAID, and the same address on another row is no change. */
  it("SAYS it substituted when the picked mailbox can no longer send, naming the address it replaced", () => {
    const options = optionsFromFacts([OLD, fact({ ...NEW, status: "disabled" })]);
    expect(resolveComposeFrom(options, "new")).toMatchObject({
      mailboxId: "old", substituted: true, substitutedFrom: "new@example.test",
    });
  });

  it("takes the SAME ADDRESS on another row silently — a re-added mailbox is the same identity", () => {
    const again = fact({ id: "new-again", address: "New@Example.test ", createdAt: "2026-02-01T00:00:00.000Z" });
    const options = optionsFromFacts([OLD, fact({ ...NEW, status: "disabled" }), again]);
    expect(resolveComposeFrom(options, "new")).toMatchObject({
      mailboxId: "new-again", substituted: false, substitutedFrom: null,
    });
  });

  it("CONTROL: an unknown pick and no pick are unchanged — no substitution is claimed", () => {
    const options = optionsFromFacts([OLD, NEW]);
    expect(resolveComposeFrom(options, "nobody")).toMatchObject({ mailboxId: "old", substituted: false });
    expect(resolveComposeFrom(options, null)).toMatchObject({ mailboxId: "old", substituted: false });
  });
});

/**
 * WRITING TO A DOMAIN YOU OWN AN ADDRESS ON (gap R10-4).
 *
 * The reported failure: two businesses on one account, and a message to somebody at company A
 * leaves from company B's address because B's mailbox happens to be the older one. The recipient
 * is the evidence — it is on screen, typed by the user, and it names a domain — so a fresh compose
 * addressed to a domain the account itself can send from switches to that address and SAYS it did.
 *
 * Every clause below is a refusal to guess. One recipient domain, one of the account's own
 * mailboxes on it, no pick made: only then. Anything a second reading could be attached to is left
 * where it was, because a sender chosen wrongly and silently is the defect this closes, not a
 * lesser version of it.
 */
describe("the recipient's domain picks the sender, when it can do so unambiguously (R10-4)", () => {
  const ACME = fact({ id: "acme", address: "me@acme.example", createdAt: "2025-09-09T00:00:00.000Z" });
  const GLOBEX = fact({ id: "globex", address: "me@globex.example", createdAt: "2025-10-10T00:00:00.000Z" });
  /** `OLD` is the oldest of the three, so it is the derived default every time here. */
  const THREE = () => optionsFromFacts([OLD, ACME, GLOBEX]);

  it("switches to the ONE own mailbox standing on the recipient's domain", () => {
    expect(domainMatchedFrom(THREE(), ["team@acme.example"])?.id).toBe("acme");
    const resolved = resolveComposeFrom(THREE(), null, "team@acme.example");
    expect(resolved.mailboxId, "the derived default was kept over a matching own address").toBe("acme");
    expect(resolved.address).toBe("me@acme.example");
    // The ceiling travels with the mailbox that will actually send, exactly as a pick's does.
    expect(resolved.maxMessageBytes).toBe(resolveComposeFrom(THREE(), "acme").maxMessageBytes);
  });

  it("SAYS it switched — and says nothing when it did not", () => {
    expect(resolveComposeFrom(THREE(), null, "team@acme.example").domainMatched).toBe(true);
    expect(
      resolveComposeFrom(THREE(), null, "team@elsewhere.example").domainMatched,
      "announced a switch that never happened",
    ).toBe(false);
  });

  /**
   * The hint is about a CHANGE. A recipient on the default's own domain resolves to the same
   * mailbox the compose was already sending from, so there is nothing to announce — a line
   * claiming a switch nobody made is the same class of untruth as a silent one.
   */
  it("announces nothing when the match IS the derived default", () => {
    const resolved = resolveComposeFrom(THREE(), null, "team@example.test");
    expect(resolved.mailboxId).toBe("old");
    expect(resolved.domainMatched, "claimed a switch to the address it was already using").toBe(false);
  });

  it("refuses when TWO recipients name TWO different addresses of yours — first typed does not win", () => {
    // Both are the account's own domains, and nothing on the form says which identity the message
    // belongs to. Reading the To line left to right would be a coin toss with an explanation.
    expect(domainMatchedFrom(THREE(), ["team@acme.example", "kim@globex.example"])).toBeNull();
    const resolved = resolveComposeFrom(THREE(), null, "team@acme.example, kim@globex.example");
    expect(resolved.mailboxId, "an ambiguous recipient set still moved the sender").toBe("old");
    expect(resolved.domainMatched).toBe(false);
  });

  it("refuses when TWO of your mailboxes stand on the recipient's domain", () => {
    const twin = fact({ id: "acme2", address: "sales@acme.example", createdAt: "2026-01-01T00:00:00.000Z" });
    const options = optionsFromFacts([OLD, ACME, twin]);
    expect(domainMatchedFrom(options, ["team@acme.example"])).toBeNull();
    expect(resolveComposeFrom(options, null, "team@acme.example").mailboxId).toBe("old");
  });

  it("holds when SEVERAL recipients name the same one of your domains", () => {
    // Not ambiguity — one answer, arrived at twice.
    expect(domainMatchedFrom(THREE(), ["team@acme.example", "kim@acme.example"])?.id).toBe("acme");
  });

  it("never matches a DISABLED mailbox, and does not fall through to another one either", () => {
    const options = optionsFromFacts([OLD, fact({ ...ACME, status: "disabled" })]);
    expect(domainMatchedFrom(options, ["team@acme.example"]), "offered a mailbox the server refuses")
      .toBeNull();
    expect(resolveComposeFrom(options, null, "team@acme.example").mailboxId).toBe("old");
  });

  it("matches a mailbox in `error` — that is an IMAP verdict, and this is a send", () => {
    const options = optionsFromFacts([OLD, fact({ ...ACME, status: "error", errorCode: "auth" })]);
    expect(domainMatchedFrom(options, ["team@acme.example"])?.id).toBe("acme");
  });

  it("is case-insensitive about the domain, on both sides", () => {
    const options = optionsFromFacts([OLD, fact({ ...ACME, address: "me@ACME.Example" })]);
    expect(domainMatchedFrom(options, ["team@acme.EXAMPLE"])?.id).toBe("acme");
  });

  /**
   * IDN: the comparison is between the STORED WIRE FORMS. A mailbox on an internationalized
   * domain is stored, sent and matched as its A-label (`idn.ts`), and the compose recipient field
   * is one of the two surfaces that slice deliberately leaves alone — what is typed there IS the
   * wire value. So both sides of this comparison are punycode already and `displayAddress` is
   * never called. Asserted as parity rather than as a trap: a decoded-form comparison would agree
   * with this case, and the reason not to write one is that its failure modes (a label that
   * refuses to decode falls back to raw) would make two equal domains stop matching.
   */
  it("matches internationalized domains on their punycode form", () => {
    const options = optionsFromFacts([
      OLD,
      fact({ id: "mueller", address: "sarada@xn--mller-kva.example", createdAt: "2025-05-05T00:00:00.000Z" }),
    ]);
    expect(domainMatchedFrom(options, ["team@xn--mller-kva.example"])?.id).toBe("mueller");
  });

  it("does not fire while an explicit pick is remembered — the pick is the answer", () => {
    const resolved = resolveComposeFrom(THREE(), "globex", "team@acme.example");
    expect(resolved.mailboxId, "a recipient's domain overrode the address the user chose").toBe("globex");
    expect(resolved.domainMatched).toBe(false);
  });

  /**
   * A pick that no longer names a sendable mailbox is dropped and the default derivation runs
   * (see above) — but the domain match stays off, because `fromMailboxId` is still SET. The rule
   * is the field's state, not whether the id still resolves: a user who chose an address has
   * taken the decision this would otherwise take for them.
   */
  it("stays off for a STALE pick too — the field is set, and that is the whole of the rule", () => {
    const options = optionsFromFacts([OLD, ACME, fact({ ...GLOBEX, status: "disabled" })]);
    const resolved = resolveComposeFrom(options, "globex", "team@acme.example");
    expect(resolved.mailboxId).toBe("old");
    expect(resolved.domainMatched).toBe(false);
  });

  it("never fires with no mailbox facts at all — the absent-config rule", () => {
    expect(domainMatchedFrom([], ["team@acme.example"])).toBeNull();
    expect(resolveComposeFrom([], null, "team@acme.example")).toMatchObject({
      mailboxId: null, domainMatched: false,
    });
  });

  it("ignores an entry that is not an address, and a half-typed one", () => {
    expect(domainMatchedFrom(THREE(), ["not-an-address"])).toBeNull();
    expect(resolveComposeFrom(THREE(), null, "team@").mailboxId).toBe("old");
    // The user is mid-way through typing the address that WILL match; nothing moves until it does.
    expect(resolveComposeFrom(THREE(), null, "team@acme.exam").mailboxId).toBe("old");
  });

  it("an empty recipient line is exactly the un-addressed resolution (default-argument parity)", () => {
    expect(resolveComposeFrom(THREE(), null, "")).toEqual(resolveComposeFrom(THREE(), null));
  });
});

/**
 * WRITING TO YOURSELF DOES NOT CHANGE WHO YOU ARE.
 *
 * ── THE DEFECT, AS IT SHIPPED ───────────────────────────────────────────────────────────
 *
 * The rule above reads the To line as evidence of which of the account's identities a message
 * belongs to. Every address the account holds stands on one of the account's own domains, so a
 * message addressed TO YOURSELF matched it perfectly: a note to your own second mailbox moved the
 * From line onto that same mailbox and printed "Switched to match the recipient's domain" — a
 * switch made on the strength of the user's own address, announced as though a correspondent had
 * asked for it, on a message whose only recipient was the person sending it.
 *
 * Measured before the fix, on an account holding `old@example.test` (the derived default),
 * `me@acme.example` and `me@globex.example`: a compose addressed to `me@acme.example` resolved to
 * `me@acme.example` with `domainMatched === true`.
 *
 * Four rows of the table are that measurement, and they are named rather than numbered because a
 * row inserted in the middle would silently renumber a comment: **your own second address**, **the
 * same address in another case**, **the same wearing a filing tag** (`me+notes@`), and **your own
 * address beside a stranger on no domain of yours** all left from an address the user had neither
 * typed nor chosen. **Your own address beside a stranger on another of your domains** is the
 * mirror image — your own address made the set look ambiguous, so a stranger who should have
 * decided was overruled by the person sending the message.
 *
 * Every other row is regression cover, and each answers correctly for a DIFFERENT reason: the
 * three rows holding no address of the account's are the baseline the fix must not disturb; a note
 * to the address you were already sending from resolved to the default anyway; a note to a
 * disabled mailbox of yours was never matchable; two of your own addresses read as ambiguity; and
 * a stranger's own tagged address has a base the account does not hold, so it decides exactly as
 * an untagged one does. They are here because the fix must not reach them by a new route either.
 *
 * ── THE TABLE IS THE ACCEPTANCE ─────────────────────────────────────────────────────────
 *
 * One row per recipient SET, because the mixed sets are where the two readings of the fix part
 * company. It is a per-recipient filter, not a gate over the whole line, so a stranger standing
 * beside one of your own addresses still decides — and decides exactly what they would have
 * decided alone. A gate would have made your own address on the To line silence the rule for
 * everybody else on it, which is a second surprise rather than the removal of one.
 */
describe("your own addresses are not evidence of an identity", () => {
  const ACME = fact({ id: "acme", address: "me@acme.example", createdAt: "2025-09-09T00:00:00.000Z" });
  const GLOBEX = fact({ id: "globex", address: "me@globex.example", createdAt: "2025-10-10T00:00:00.000Z" });
  /** A mailbox of the account's that the server will not send from. Still the account's address. */
  const OFF = fact({
    id: "off", address: "me@off.example", status: "disabled", createdAt: "2025-11-11T00:00:00.000Z",
  });
  /** `OLD` is the oldest of the four, so `old@example.test` is the derived default in every row. */
  const ALL = () => optionsFromFacts([OLD, ACME, GLOBEX, OFF]);

  /** recipient set → the address that sends, and whether the surface announces a switch. */
  const TABLE: { why: string; to: string; from: string; announced: boolean }[] = [
    { why: "nothing addressed yet", to: "", from: "old@example.test", announced: false },
    { why: "a stranger on no domain of yours", to: "team@elsewhere.example", from: "old@example.test", announced: false },
    { why: "a stranger on a domain of yours decides, as before", to: "team@acme.example", from: "me@acme.example", announced: true },
    { why: "a note to your own second address", to: "me@acme.example", from: "old@example.test", announced: false },
    { why: "a note to the address you were already sending from", to: "old@example.test", from: "old@example.test", announced: false },
    { why: "a note to a mailbox of yours the server will not send from", to: "me@off.example", from: "old@example.test", announced: false },
    { why: "your own address typed in another case, with spare spaces", to: "  ME@ACME.Example  ", from: "old@example.test", announced: false },
    { why: "your own address wearing a filing tag", to: "me+notes@acme.example", from: "old@example.test", announced: false },
    { why: "a stranger's tagged address on a domain of yours still decides", to: "team+work@acme.example", from: "me@acme.example", announced: true },
    { why: "two of your own addresses and nobody else", to: "me@acme.example, me@globex.example", from: "old@example.test", announced: false },
    { why: "your own address beside a stranger on no domain of yours", to: "me@acme.example, team@elsewhere.example", from: "old@example.test", announced: false },
    { why: "your own address beside a stranger on another of your domains", to: "me@globex.example, team@acme.example", from: "me@acme.example", announced: true },
    { why: "your own address beside a stranger on that same domain", to: "me@acme.example, team@acme.example", from: "me@acme.example", announced: true },
    { why: "two strangers on two of your domains is still ambiguous", to: "team@acme.example, kim@globex.example", from: "old@example.test", announced: false },
  ];

  for (const row of TABLE) {
    it(`${row.why}: [${row.to}] sends from ${row.from}`, () => {
      const resolved = resolveComposeFrom(ALL(), null, row.to);
      expect(resolved.address, row.why).toBe(row.from);
      expect(resolved.domainMatched, `${row.why} — the announcement disagreed`).toBe(row.announced);
    });
  }

  /**
   * THE `+`-TAG IS A GUESS, AND THESE ARE ITS EDGES. It is made only where a wrong guess is
   * cheap — a recipient whose BASE address is one of the account's own — so the two cases that
   * decide how far it reaches are pinned here rather than left to the table.
   */
  it("reads a `+`-tag off the local part only, and only in front of one", () => {
    // A local part that BEGINS with the tag has no base in front of it. Stripping would leave an
    // empty local part, which is nobody's address; it stays whole and is simply a stranger.
    expect(domainMatchedFrom(ALL(), ["+notes@acme.example"])?.id, "an empty local part matched")
      .toBe("acme");
    // A `+` after the `@` is part of a domain, not a tag. Nothing is stripped, so this is still a
    // stranger on a domain the account does not hold.
    expect(domainMatchedFrom(ALL(), ["me@acme+x.example"])).toBeNull();
    // And the account's own address wearing a tag is still the account's, however loudly typed.
    expect(domainMatchedFrom(ALL(), ["  ME+Notes@ACME.Example  "])).toBeNull();
  });

  /**
   * THE ONE DIRECTION THE KEY IS WIDER THAN THE ADDRESS, pinned so it is a decision rather than a
   * discovery. A mailbox whose OWN address carries a tag keys to its base, so the untagged form
   * reads as the account's too — and if that untagged address is somebody else's, the rule
   * declines a switch it would otherwise have made. That is the cheap direction on purpose (the
   * switch it declines is onto a mailbox on that very domain), and it is the same trade the
   * tag-stripping makes everywhere else; a rule that got this "right" would have to know which
   * providers implement tags, which nothing here can.
   */
  it("keys a tagged OWN address to its base, so the untagged form reads as yours as well", () => {
    const shop = fact({ id: "shop", address: "me+shop@acme.example", createdAt: "2025-09-09T00:00:00.000Z" });
    const options = optionsFromFacts([OLD, shop]);
    expect(domainMatchedFrom(options, ["me@acme.example"]), "the base of a tagged own address was a stranger")
      .toBeNull();
    expect(resolveComposeFrom(options, null, "me@acme.example").address).toBe("old@example.test");
    // A different local part on that domain is still a stranger and still decides.
    expect(domainMatchedFrom(options, ["team@acme.example"])?.id).toBe("shop");
  });

  /**
   * The case the disabled row above cannot reach on its own: with a SECOND mailbox on the same
   * domain, the account's disabled address stops being inert. Before the fix, writing to your own
   * disabled address matched the OTHER mailbox on that domain and sent from it — the sender moved
   * to an address the user had neither typed nor chosen, on a message to themselves.
   */
  it("a note to your own DISABLED address does not nominate your other mailbox on that domain", () => {
    const off = fact({
      id: "off", address: "me@off.example", status: "disabled", createdAt: "2025-11-11T00:00:00.000Z",
    });
    const sales = fact({ id: "sales", address: "sales@off.example", createdAt: "2025-12-12T00:00:00.000Z" });
    const options = optionsFromFacts([OLD, off, sales]);
    expect(domainMatchedFrom(options, ["me@off.example"]), "matched the account's own domain to itself")
      .toBeNull();
    expect(resolveComposeFrom(options, null, "me@off.example").address).toBe("old@example.test");
    // …and a STRANGER on that domain still nominates the sendable one, which is the rule intact.
    expect(domainMatchedFrom(options, ["team@off.example"])?.id).toBe("sales");
    // The TAGGED form of that disabled address reaches the same answer down the same path. Both
    // halves of the key have to hold at once for this row, which is why it is asserted rather than
    // inferred from the tag rows and this one standing separately.
    expect(domainMatchedFrom(options, ["me+receipts@off.example"]), "a tagged disabled own address nominated its sibling")
      .toBeNull();
    expect(resolveComposeFrom(options, null, "me+receipts@off.example").address).toBe("old@example.test");
  });

  /**
   * AN EXPLICIT CHOICE IS NEVER REVISITED. The gate is `picked !== null` and nothing downstream of
   * it re-reads the recipients, so a pick made before the To line was typed and a pick made after
   * it are the same field. Both directions asserted, because "the pick wins" is only worth
   * something if it also wins against a recipient the user adds afterwards.
   */
  it("an explicit pick stands however the recipients change afterwards", () => {
    const picked = "globex";
    for (const to of ["", "me@acme.example", "team@acme.example", "me@acme.example, team@acme.example"]) {
      const resolved = resolveComposeFrom(ALL(), picked, to);
      expect(resolved.address, `the chosen address was overridden by [${to}]`).toBe("me@globex.example");
      expect(resolved.domainMatched, `announced a switch over an explicit pick for [${to}]`).toBe(false);
    }
  });

  /**
   * THE DEMO AND THE DESKTOP, where `ownAddresses` is `[]` and the mirror rows are the only thing
   * that knows who the account is. The own-address set is read off the OPTIONS for exactly this
   * reason — a fourth parameter would have arrived empty here and the defect would have survived
   * on two of the three doors.
   */
  it("holds on the mirror surface too, where the options are the only account facts there are", () => {
    const options = optionsFromMirror([
      { id: "a", address: "me@first.test" },
      { id: "b", address: "me@second.test" },
    ]);
    expect(resolveComposeFrom(options, null, "me@second.test").address).toBe("me@first.test");
    expect(resolveComposeFrom(options, null, "me@second.test").domainMatched).toBe(false);
    // A stranger on the second mirror mailbox's domain still moves it.
    expect(resolveComposeFrom(options, null, "team@second.test").address).toBe("me@second.test");
  });

  /**
   * REPLY AND FORWARD ARE NOT THIS RULE. `resolveReplyFrom` is handed no recipients at all, so
   * answering yourself — or forwarding a message into your own second mailbox, which is the same
   * dock since Forward became `replyMode: "forward"` — keeps the mailbox the original arrived in
   * whatever stands on the To line. This is the assertion that would go red if the recipient rule
   * were ever wired into the reply path in the course of fixing the compose one.
   */
  it("a reply or forward to yourself keeps the mailbox the message arrived in", () => {
    const resolved = resolveReplyFrom(ALL(), "acme");
    expect(resolved.address).toBe("me@acme.example");
    expect(resolved.substituted).toBe(false);
    expect(resolved.domainMatched, "a reply announced a recipient-driven switch").toBe(false);
  });
});

describe("a reply keeps the mailbox the message arrived in", () => {
  it("uses the parent's mailbox and reports no substitution", () => {
    const resolved = resolveReplyFrom(optionsFromFacts([OLD, NEW]), "new");
    expect(resolved.mailboxId).toBe("new");
    expect(resolved.substituted).toBe(false);
  });

  it("substitutes when that mailbox is disabled, names what it replaced, and does not block", () => {
    const resolved = resolveReplyFrom(optionsFromFacts([OLD, fact({ ...NEW, status: "disabled" })]), "new");
    expect(resolved.mailboxId, "the reply was blocked instead of substituted").toBe("old");
    expect(resolved.substituted).toBe(true);
    expect(resolved.substitutedFrom).toBe("new@example.test");
  });

  it("substitutes for a mailbox that is GONE from the account, and says it cannot name it", () => {
    const resolved = resolveReplyFrom(optionsFromFacts([OLD]), "deleted-mailbox");
    expect(resolved.mailboxId).toBe("old");
    expect(resolved.substituted).toBe(true);
    expect(resolved.substitutedFrom).toBeNull();
  });

  it("claims no substitution when there is nothing to substitute with", () => {
    const resolved = resolveReplyFrom(optionsFromFacts([fact({ ...OLD, status: "disabled" })]), "old");
    expect(resolved.substituted, "named a substitution with no substitute").toBe(false);
    expect(resolved.mailboxId).toBeNull();
  });

  it("says nothing at all when the mailboxes cannot be seen", () => {
    // The Desktop and the demo. `enrich` derives the parent's mailbox as it always has, and
    // no sentence is put on screen about a fact nobody has.
    expect(resolveReplyFrom([], "whatever")).toMatchObject({ substituted: false, mailboxId: null });
  });
});

/**
 * A FROM PICK OVERRIDES THE INHERITED MAILBOX — and a pick is NOT a substitution (gap R9-7, which
 * overturns the "a reply's sender is not a choice"). The third argument is the sender the reader
 * chose; when it names a mailbox that can send, it stands and NOTHING is announced, because the
 * selector's value is the From line. A pick that no longer names a sendable option is dropped and
 * the un-picked derivation runs verbatim — so a stale pick can neither force a dead address onto
 * the wire nor hide a real substitution.
 */
describe("a reply From pick — honored when sendable, and never dressed as a substitution", () => {
  it("an explicit sendable pick stands, with no substitution announced", () => {
    const resolved = resolveReplyFrom(optionsFromFacts([OLD, NEW]), "new", "old");
    expect(resolved.mailboxId, "the pick was ignored").toBe("old");
    expect(resolved.substituted, "a pick was dressed up as a substitution").toBe(false);
    expect(resolved.substitutedFrom).toBeNull();
    // The chosen mailbox's own ceiling travels too, exactly as the derived one's does.
    expect(resolved.maxMessageBytes).toBe(resolveReplyFrom(optionsFromFacts([OLD, NEW]), "old").maxMessageBytes);
  });

  it("picking the inherited mailbox itself is honored and still announces nothing", () => {
    const resolved = resolveReplyFrom(optionsFromFacts([OLD, NEW]), "new", "new");
    expect(resolved.mailboxId).toBe("new");
    expect(resolved.substituted).toBe(false);
  });

  it("a pick that no longer names a SENDABLE option is dropped, and the derivation runs verbatim", () => {
    // The picked address (new) was disabled since the choice was made; the inherited one (old) is
    // still sendable, so the resolution is exactly the un-picked one — nothing is forced.
    const resolved = resolveReplyFrom(
      optionsFromFacts([OLD, fact({ ...NEW, status: "disabled" })]),
      "old",
      "new",
    );
    expect(resolved.mailboxId, "a disabled pick was honored").toBe("old");
    expect(resolved.substituted).toBe(false);
  });

  it("a dropped pick does not HIDE a real substitution — the inherited mailbox still governs", () => {
    // Both the pick and the inherited mailbox are `new`, now disabled: the pick is dropped, `own`
    // is not sendable, and the substitution to `old` is announced as it would be with no pick.
    const resolved = resolveReplyFrom(
      optionsFromFacts([OLD, fact({ ...NEW, status: "disabled" })]),
      "new",
      "new",
    );
    expect(resolved.mailboxId).toBe("old");
    expect(resolved.substituted, "the substitution was hidden by a dropped pick").toBe(true);
    expect(resolved.substitutedFrom).toBe("new@example.test");
  });

  it("a null override is exactly the plain reply resolution (default-argument parity)", () => {
    expect(resolveReplyFrom(optionsFromFacts([OLD, NEW]), "new", null))
      .toEqual(resolveReplyFrom(optionsFromFacts([OLD, NEW]), "new"));
  });
});

/**
 * WHO A REPLY IS ADDRESSED TO — the correspondent, not yourself, on a message you sent.
 *
 * `enrich` defaults a reply's `to` to `[parent.from]`, which is right until the parent is a
 * message the account itself sent: then `parent.from` is your own address and the default mails
 * you your own reply. `replyRecipients` is what corrects that, on the wire (`AppShell.sendReply`)
 * and in the head (`InlineReply`). It returns `null` for every ordinary reply so the default
 * keeps owning that path.
 */
describe("replyRecipients — the correspondent, not yourself", () => {
  const addr = (address: string, name: string | null = null) => ({ name, address });
  const MINE = ["me@example.test", "alt@example.test"];

  it("returns null for an ordinary reply so `enrich`'s [parent.from] stands", () => {
    const parent = { from: addr("lena@atelier.example"), to: [addr("me@example.test")] };
    expect(replyRecipients(parent, MINE)).toBeNull();
  });

  it("addresses a self-sent message to whom it was addressed TO, not back to yourself", () => {
    const parent = { from: addr("me@example.test"), to: [addr("lena@atelier.example", "Lena")] };
    expect(replyRecipients(parent, MINE)).toEqual([addr("lena@atelier.example", "Lena")]);
  });

  it("is case-insensitive about which address is yours", () => {
    const parent = { from: addr("ME@Example.Test"), to: [addr("lena@atelier.example")] };
    expect(replyRecipients(parent, MINE)).toEqual([addr("lena@atelier.example")]);
  });

  it("strips your OWN addresses out of the recipients so a self-copy never rides along", () => {
    const parent = {
      from: addr("me@example.test"),
      to: [addr("alt@example.test"), addr("lena@atelier.example")],
    };
    expect(replyRecipients(parent, MINE)).toEqual([addr("lena@atelier.example")]);
  });

  it("falls back to the sender for a note you sent only to yourself", () => {
    const parent = { from: addr("me@example.test"), to: [addr("alt@example.test")] };
    expect(replyRecipients(parent, MINE)).toEqual([addr("me@example.test")]);
  });

  it("returns null when the account's addresses cannot be seen (demo, Desktop, no provider)", () => {
    const parent = { from: addr("me@example.test"), to: [addr("lena@atelier.example")] };
    expect(replyRecipients(parent, [])).toBeNull();
  });
});

/**
 * WHO A REPLY TO ALL IS ADDRESSED TO — and, by the same call, WHETHER the verb is offered.
 *
 * `null` is the visibility rule: the action bar renders Reply all exactly when this returns an
 * envelope (`MessagePane.ActionBar`), and `AppShell.sendReply` resolves the same call for the
 * wire. So these cases are simultaneously "the button appears/does not appear" and "who the
 * mail goes to" — one function, asserted once.
 */
describe("replyAllRecipients — everyone on the message, or null when that is nobody new", () => {
  const addr = (address: string, name: string | null = null) => ({ name, address });
  const MINE = ["me@example.test", "alt@example.test"];

  it("returns null on a 1:1 message — Reply all on it would be noise, so no control renders", () => {
    const parent = { from: addr("lena@atelier.example"), to: [addr("me@example.test")], cc: [] };
    expect(replyAllRecipients(parent, MINE)).toBeNull();
  });

  it("puts the sender first on To, keeps the other To recipients, and drops the reader", () => {
    const parent = {
      from: addr("lena@atelier.example", "Lena"),
      to: [addr("me@example.test"), addr("piet@atelier.example", "Piet")],
      cc: [],
    };
    expect(replyAllRecipients(parent, MINE)).toEqual({
      to: [addr("lena@atelier.example", "Lena"), addr("piet@atelier.example", "Piet")],
      cc: [],
    });
  });

  it("keeps the Cc line, minus the reader", () => {
    const parent = {
      from: addr("lena@atelier.example"),
      to: [addr("me@example.test")],
      cc: [addr("alt@example.test"), addr("team@atelier.example")],
    };
    expect(replyAllRecipients(parent, MINE)).toEqual({
      to: [addr("lena@atelier.example")],
      cc: [addr("team@atelier.example")],
    });
  });

  it("never lists an address twice — a sender who also stands in To/Cc appears once, leading To", () => {
    const parent = {
      from: addr("lena@atelier.example"),
      to: [addr("Lena@Atelier.example"), addr("piet@atelier.example")],
      cc: [addr("piet@atelier.example")],
    };
    expect(replyAllRecipients(parent, MINE)).toEqual({
      to: [addr("lena@atelier.example"), addr("piet@atelier.example")],
      cc: [],
    });
  });

  it("is case-insensitive about which address is the reader's", () => {
    const parent = {
      from: addr("lena@atelier.example"),
      to: [addr("ME@Example.Test"), addr("piet@atelier.example")],
      cc: [],
    };
    expect(replyAllRecipients(parent, MINE)).toEqual({
      to: [addr("lena@atelier.example"), addr("piet@atelier.example")],
      cc: [],
    });
  });

  it("on a SELF-authored parent it is offered only for a surviving Cc line — the plain reply already covers To", () => {
    // Plain `replyRecipients` already answers every other To recipient on a message you sent,
    // so an "all" that adds nothing returns null…
    const noCc = { from: addr("me@example.test"), to: [addr("lena@atelier.example")], cc: [] };
    expect(replyAllRecipients(noCc, MINE)).toBeNull();
    // …and one that carries a Cc keeps it, reader filtered from both lines.
    const withCc = {
      from: addr("me@example.test"),
      to: [addr("lena@atelier.example"), addr("alt@example.test")],
      cc: [addr("team@atelier.example")],
    };
    expect(replyAllRecipients(withCc, MINE)).toEqual({
      to: [addr("lena@atelier.example")],
      cc: [addr("team@atelier.example")],
    });
  });

  it("with the reader unknown (demo, Desktop): two listed recipients offer it, one withholds it", () => {
    // One recipient is almost always the reader — a 1:1 mail — so nothing is offered…
    const oneListed = { from: addr("lena@atelier.example"), to: [addr("someone@example.test")], cc: [] };
    expect(replyAllRecipients(oneListed, [])).toBeNull();
    // …two prove somebody besides the reader is on the thread, and with no way to tell which
    // one is the reader, both stay on the envelope (the standard degradation, documented).
    const twoListed = {
      from: addr("lena@atelier.example"),
      to: [addr("someone@example.test"), addr("piet@atelier.example")],
      cc: [],
    };
    expect(replyAllRecipients(twoListed, [])).toEqual({
      to: [addr("lena@atelier.example"), addr("someone@example.test"), addr("piet@atelier.example")],
      cc: [],
    });
  });

  it("…and the two listed recipients must be two DISTINCT people, not one address twice", () => {
    /**
     * The reader-unknown gate counted header SLOTS. One address standing on both the To and the
     * Cc line is the ordinary shape of a mail somebody sent to a list and copied themselves on,
     * and it filled the quota on its own: two slots, one person. Reply all was then offered on
     * what is a 1:1 message to this reader, and the envelope it built was `[sender, that one
     * address]` — the sender plus the only other name on the mail, which is exactly what plain
     * Reply already sends. That is the noise the `null` exists to prevent, reached by counting
     * the wrong thing.
     *
     * Distinct, case-folded, and across BOTH lines — the same fold the envelope itself applies.
     */
    const sameTwice = {
      from: addr("lena@atelier.example"),
      to: [addr("someone@example.test")],
      cc: [addr("SOMEONE@Example.Test")],
    };
    expect(replyAllRecipients(sameTwice, []), "one address on two lines is one person").toBeNull();
    // The counterpart: two genuinely different people across the two lines still offer it.
    const twoAcrossLines = {
      from: addr("lena@atelier.example"),
      to: [addr("someone@example.test")],
      cc: [addr("piet@atelier.example")],
    };
    expect(replyAllRecipients(twoAcrossLines, [])).toEqual({
      to: [addr("lena@atelier.example"), addr("someone@example.test")],
      cc: [addr("piet@atelier.example")],
    });
  });
});

describe("the mirror's mailbox entities (demo and Desktop)", () => {
  /**
   * The fixture rows carry a capitalised DISPLAY label (`"Connected"`), not the three-member
   * lifecycle union. Reading it as the union would drop every demo mailbox and leave the demo
   * with no From line — this gap, re-created in the one place a stranger meets the product.
   */
  it("offers every seeded mailbox, and does not read the fixture status label", () => {
    const options = optionsFromMirror([
      { id: "lichtgrat", address: "mila@lichtgrat.example" },
      { id: "milabrunner", address: "hello@milabrunner.example" },
    ]);
    expect(options.map((o) => o.id)).toEqual(["lichtgrat", "milabrunner"]);
    expect(options.every((o) => o.sendable)).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   PART 2 — THE RENDERED SURFACE, through the shipped shell
   ══════════════════════════════════════════════════════════════════════════════════════════ */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/** The two fixture mailboxes, by the ids `FixturesAdapter` seeds. */
const LICHTGRAT = "lichtgrat";
const MILABRUNNER = "milabrunner";

/**
 * `milabrunner` is the OLDER of the two and `lichtgrat` is the newer — deliberately the
 * opposite way round from the roulette. Every fixture message carries `mailboxId:
 * "lichtgrat"` (`fixtures-adapter.ts:151`), so `sendingMailboxId` answers `lichtgrat`, and the
 * ruled default answers `milabrunner`. Any test below that expects `milabrunner` therefore goes
 * red the moment the newest-message guess comes back.
 */
const TWO_CONNECTED: MailboxFacts[] = [
  fact({ id: LICHTGRAT, address: "mila@lichtgrat.example", createdAt: "2025-03-02T00:00:00.000Z" }),
  fact({ id: MILABRUNNER, address: "hello@milabrunner.example", createdAt: "2024-01-05T00:00:00.000Z" }),
];

let roots: Root[] = [];
let host: HTMLDivElement | null = null;
let dispatched: EngineMutation[] = [];
const REAL_MUTATE = OhmailEngine.prototype.mutate;

beforeEach(() => {
  dispatched = [];
  window.location.hash = "";
  try { window.localStorage.clear(); } catch { /* storage blocked; the in-memory half still runs */ }
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
  // jsdom gaps, stubbed at their narrowest — the same set `reply-run.test.ts` installs.
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {} unobserve(): void {} disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(OhmailEngine.prototype, "mutate").mockImplementation(async function patched(
    this: OhmailEngine, m: EngineMutation,
  ): Promise<MutationResult> {
    dispatched.push(m);
    return REAL_MUTATE.call(this, m);
  });
});

afterEach(async () => {
  for (const root of roots) await act(async () => { root.unmount(); });
  roots = [];
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

/**
 * The shipped shell on the fixture world, with a REAL mailbox probe.
 *
 * `demo: true` keeps the engine on fixtures and off the network; the probe is the same seam
 * `(product)/mailbox/CloudShell.tsx` fills on a live account, so what is exercised here is the
 * Cloud path with a Cloud answer, minus the HTTP.
 */
async function mountShell(facts: MailboxFacts[] | null): Promise<HTMLElement> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, {
            children: h(AppShell, {
              demo: true,
              ...(facts ? { mailboxFacts: async () => facts } : {}),
            }),
          }),
        }),
      }),
    );
  });
  // The fixtures engine hydrates synchronously but through a promise chain, and the probe is
  // one more await on top of it.
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
  return host;
}

const fromControl = (): HTMLElement | null =>
  host!.querySelector<HTMLElement>("#compose-from");

const optionsOnScreen = (): { value: string; text: string }[] =>
  [...host!.querySelectorAll<HTMLOptionElement>("#compose-from option")]
    .map((o) => ({ value: o.value, text: o.textContent ?? "" }));

/**
 * `#/compose`, the way the `c` shortcut and the rail button both reach it (`routing.ts` → `go`).
 *
 * The `hashchange` is dispatched by hand: jsdom queues it as a TASK, and the microtask drain
 * below would return before the route store ever heard about it.
 */
async function goCompose(): Promise<void> {
  await act(async () => {
    window.location.hash = "#/compose";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
  await settleFirstPaint();
}

async function setValue(el: HTMLElement, proto: object, value: string, event: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(event, { bubbles: true }));
  });
}

/** The editable surface of the compose editor — `.compose-editor` is the frame around it. */
const composeEditor = (): HTMLElement =>
  host!.querySelector<HTMLElement>(".compose-editor .rte-surface")!;

/** The open reply editor's surface. */
const replyEditor = (): HTMLElement =>
  host!.querySelector<HTMLElement>(".reply-editor .rte-surface")!;

/** Put text into a rich editor — see `fixtures/rich-editor-driver.ts` for why not `value`. */
async function typeRich(el: HTMLElement, text: string): Promise<void> {
  await act(async () => { typeInto(el, text); });
}

describe("ACCEPTANCE: compose says which address it is sending from", () => {
  it("defaults to the OLDEST CONNECTED mailbox, not the one that last received mail", async () => {
    await mountShell(TWO_CONNECTED);
    await goCompose();

    const control = fromControl();
    expect(control, "compose rendered no From control at all").not.toBeNull();
    expect(control!.tagName).toBe("SELECT");
    expect(
      (control as HTMLSelectElement).value,
      "compose picked the mailbox of the newest message instead of the oldest connected one",
    ).toBe(MILABRUNNER);
    // …and the address is legible, not only the id.
    expect(host!.textContent).toContain("hello@milabrunner.example");
  });

  it("puts MAILBOX IDS in the control and addresses only in the text", async () => {
    await mountShell(TWO_CONNECTED);
    await goCompose();

    const opts = optionsOnScreen();
    expect(opts.map((o) => o.value).sort()).toEqual([LICHTGRAT, MILABRUNNER]);
    for (const o of opts) {
      expect(o.value, `the selector's value is an address (${o.value})`).not.toContain("@");
      expect(o.text, "the option shows an id instead of an address").toContain("@");
    }
  });

  it("offers no control and states the address as text when there is one mailbox", async () => {
    await mountShell([TWO_CONNECTED[0]!]);
    await goCompose();

    const control = fromControl();
    expect(control, "the single address was not stated at all").not.toBeNull();
    expect(control!.tagName, "a one-option select is a choice nobody has").not.toBe("SELECT");
    expect(control!.textContent).toBe("mila@lichtgrat.example");
  });

  /**
   * THE STANDALONE DOOR'S OWN ROW, and the branch its install always takes.
   *
   * On that door the facts are this install's roster — one mailbox as a rule, carrying the
   * organizer columns and no announced ceiling — so the `<output>` branch is the one a desktop
   * user meets, and its WIRE half was the part nothing read: the cases above prove the id
   * travels out of the `<select>`. `null` stays the answer where nothing can be named, which the
   * two `mountShell(null)` cases below hold.
   */
  it("a standalone roster: the address is stated, and it is the id that is sent", async () => {
    await mountShell([fact({
      id: "mbx-1", address: "one@example.test",
      organizerRole: "organizer", organizeConsentedAt: "2026-08-01T08:05:00.000Z",
    })]);
    await goCompose();

    expect(fromControl()!.textContent, "the install's own address was not stated").toBe("one@example.test");
    const to = host!.querySelector<HTMLInputElement>("#compose-to")!;
    await setValue(to, window.HTMLInputElement.prototype, "someone@example.test", "input");
    await typeRich(composeEditor(), "Hallo.");
    const send = [...host!.querySelectorAll<HTMLButtonElement>(".send-row button")]
      .find((b) => buttonLabel(b) === "Send")!;
    await act(async () => { send.click(); });

    const sent = dispatched.filter((m) => m.kind === "mail_send");
    expect(sent, "pressing Send dispatched no mutation").toHaveLength(1);
    expect(
      (sent[0] as { mailboxId?: string }).mailboxId,
      "the stated address was not the mailbox the send carried",
    ).toBe("mbx-1");
  });

  it("never offers a disconnected mailbox", async () => {
    await mountShell([
      TWO_CONNECTED[0]!,
      { ...TWO_CONNECTED[1]!, status: "disabled" },
    ]);
    await goCompose();

    // One sendable mailbox left ⇒ static text, and it is the connected one.
    expect(fromControl()!.textContent).toBe("mila@lichtgrat.example");
    expect(optionsOnScreen()).toEqual([]);
  });

  it("sends from the mailbox on screen — the id, never the address", async () => {
    await mountShell(TWO_CONNECTED);
    await goCompose();

    await setValue(fromControl()!, window.HTMLSelectElement.prototype, LICHTGRAT, "change");
    const to = host!.querySelector<HTMLInputElement>("#compose-to")!;
    await setValue(to, window.HTMLInputElement.prototype, "someone@example.test", "input");
    await typeRich(composeEditor(), "Hallo.");

    const send = [...host!.querySelectorAll<HTMLButtonElement>(".send-row button")]
      .find((b) => buttonLabel(b) === "Send")!;
    expect(send.disabled, "Send stayed locked with a recipient, a body and a mailbox").toBe(false);
    await act(async () => { send.click(); });

    const sent = dispatched.filter((m) => m.kind === "mail_send");
    expect(sent, "pressing Send dispatched no mutation").toHaveLength(1);
    const mailboxId = (sent[0] as { mailboxId?: string }).mailboxId;
    expect(mailboxId).toBe(LICHTGRAT);
    expect(mailboxId, "an address string reached the wire as the sender").not.toContain("@");
  });
});

describe("ACCEPTANCE: the pick survives closing and reopening the draft", () => {
  it("reopens on the picked mailbox and not on the derived default", async () => {
    await mountShell(TWO_CONNECTED);
    await goCompose();

    // A draft: a pick AND the text it belongs to. A pick on an empty form is not a draft and
    // deliberately stores nothing — see `writeComposeDraft`.
    await setValue(fromControl()!, window.HTMLSelectElement.prototype, LICHTGRAT, "change");
    await typeRich(composeEditor(), "Halb fertig.");
    expect((fromControl() as HTMLSelectElement).value).toBe(LICHTGRAT);

    // CLOSE. A full unmount and remount, which is the reload — the React state that holds the
    // form across a route change is gone, so only the scratch buffer can answer.
    for (const root of roots) await act(async () => { root.unmount(); });
    roots = [];
    host?.remove();
    host = null;

    await mountShell(TWO_CONNECTED);
    await goCompose();
    // The DOCUMENT'S text, not a `value` property: the editor is a `contenteditable`, and
    // `.value` on one is `undefined` — which reads as "the draft was lost" in exactly the
    // assertion that is checking whether it was.
    expect(composeEditor().textContent, "the draft text did not survive the reopen")
      .toContain("Halb fertig.");
    expect(
      (fromControl() as HTMLSelectElement).value,
      "reopening the draft silently reverted the sender to the derived default",
    ).toBe(LICHTGRAT);
  });
});

describe("ACCEPTANCE: a reopened draft whose mailbox is gone says where it will send from", () => {
  it("names the disconnected address on screen, and Send carries the substitute", async () => {
    await mountShell(TWO_CONNECTED);
    await goCompose();
    await setValue(fromControl()!, window.HTMLSelectElement.prototype, LICHTGRAT, "change");
    await typeRich(composeEditor(), "Halb fertig.");
    for (const root of roots) await act(async () => { root.unmount(); });
    roots = [];
    host?.remove();
    host = null;

    /* The picked mailbox is removed: still on the roster as `disabled`, and a third address exists
       so the From line stays a selector. */
    await mountShell([
      { ...TWO_CONNECTED[0]!, status: "disabled" },
      TWO_CONNECTED[1]!,
      fact({ id: "wolke", address: "mila@wolkenmail.example", createdAt: "2026-05-01T00:00:00.000Z" }),
    ]);
    await goCompose();
    expect((fromControl() as HTMLSelectElement).value).toBe(MILABRUNNER);
    const hint = host!.querySelector<HTMLElement>(".compose-from-hint[role='status']");
    expect(hint, "the sender changed and nothing said so").not.toBeNull();
    expect(hint!.textContent).toContain("mila@lichtgrat.example");

    const to = host!.querySelector<HTMLInputElement>("#compose-to")!;
    await setValue(to, window.HTMLInputElement.prototype, "someone@example.test", "input");
    const send = [...host!.querySelectorAll<HTMLButtonElement>(".send-row button")]
      .find((b) => buttonLabel(b) === "Send")!;
    await act(async () => { send.click(); });
    const sent = dispatched.filter((m) => m.kind === "mail_send");
    expect(sent).toHaveLength(1);
    expect((sent[0] as { mailboxId?: string }).mailboxId, "Send did not carry the substitute it named")
      .toBe(MILABRUNNER);
  });
});

/* ── the reply half ───────────────────────────────────────────────────────────────────── */

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
};

const replyFrom = (): HTMLElement | null => host!.querySelector<HTMLElement>(".reply-from");
const replySub = (): HTMLElement | null => host!.querySelector<HTMLElement>(".reply-from-sub");

/**
 * Put the cursor on the first Ohbox row — what `r` needs something to reply TO.
 *
 * The Ohbox used to resolve a selection through `?? allOhbox[0]`, so a shell that had only just
 * mounted already had a message "open" and `r` acted on it. That fallback is gone: a fresh
 * Ohbox rests until somebody picks a row, so the act that picks one is written here.
 */
const openFirstMessage = async (): Promise<void> => { await key("j"); };

describe("ACCEPTANCE: a reply says which address is answering", () => {
  it("shows the mailbox the message arrived in, and adds nothing to the envelope", async () => {
    await mountShell(TWO_CONNECTED);
    await openFirstMessage();
    await key("r");

    const line = replyFrom();
    expect(line, "the reply editor says nothing about which address is answering").not.toBeNull();
    // Every fixture message arrived in `lichtgrat`, and that is what a reply must answer from.
    expect(line!.textContent).toContain("mila@lichtgrat.example");
    expect(replySub(), "claimed a substitution that did not happen").toBeNull();

    await typeRich(replyEditor(), "Passt.");
    const send = [...host!.querySelectorAll<HTMLButtonElement>(".reply-actions button")]
      .find((b) => buttonLabel(b) === "Send")!;
    await act(async () => { send.click(); });

    const sent = dispatched.filter((m) => m.kind === "mail_send");
    expect(sent).toHaveLength(1);
    // NOT overridden: `Engine.enrich` derives the parent's mailbox, as it always has. Naming it
    // here would be a second copy of that rule with nothing watching the two agree.
    expect(
      (sent[0] as { mailboxId?: string }).mailboxId,
      "the ordinary reply started pinning a mailbox it did not need to",
    ).toBeUndefined();
  });

  it("substitutes for a disconnected mailbox, SAYS it substituted, and still sends", async () => {
    await mountShell([
      { ...TWO_CONNECTED[0]!, status: "disabled" }, // lichtgrat — where the message arrived
      TWO_CONNECTED[1]!, // milabrunner — the substitute
    ]);
    await openFirstMessage();
    await key("r");

    const line = replyFrom();
    expect(line, "the reply editor said nothing while answering from a different address").not.toBeNull();
    expect(line!.textContent, "the substitute address is not shown").toContain("hello@milabrunner.example");
    const sub = replySub();
    expect(sub, "the substitution happened SILENTLY").not.toBeNull();
    expect(sub!.textContent, "the substitution does not name what it replaced")
      .toContain("mila@lichtgrat.example");

    const box = replyEditor();
    expect(
      box.getAttribute("contenteditable"),
      "a disconnected mailbox blocked the reply instead of substituting",
    ).toBe("true");
    await typeRich(box, "Passt.");
    const send = [...host!.querySelectorAll<HTMLButtonElement>(".reply-actions button")]
      .find((b) => buttonLabel(b) === "Send")!;
    expect(send.disabled, "Send was locked on a reply the product offered to substitute").toBe(false);
    await act(async () => { send.click(); });

    const sent = dispatched.filter((m) => m.kind === "mail_send");
    expect(sent).toHaveLength(1);
    // THE SCREEN AND THE WIRE ARE ONE DECISION. The editor named `milabrunner`; anything else
    // here means the sentence on screen was decoration.
    expect(
      (sent[0] as { mailboxId?: string }).mailboxId,
      "the reply announced one sender and sent from another",
    ).toBe(MILABRUNNER);
  });

  it("says nothing when the account's mailboxes cannot be seen", async () => {
    // Desktop and demo: no probe. `enrich` still derives the parent's mailbox, and no claim is
    // made about an address nobody can name.
    await mountShell(null);
    await openFirstMessage();
    await key("r");
    expect(host!.querySelector(".reply-editor"), "the reply editor did not open").not.toBeNull();
    expect(replyFrom(), "claimed a From with no mailbox facts behind it").toBeNull();
  });
});

/** The reply editor's From selector, where the account has more than one sendable address.
 *
 *  SELECTOR WIDENED BY THE PANEL REDESIGN, ASSERTION UNTOUCHED: while the audience is the
 *  collapsed head the From control lives in the `.reply-from` caption, and once the head is
 *  opened for editing it stands as the recipients stack's own first row (`.reply-from-row`,
 *  `reply-panel.test.tsx`). Same control, same id, same wire — one of the two places. */
const replyFromSelect = (): HTMLSelectElement | null =>
  host!.querySelector<HTMLSelectElement>(".reply-from select, .reply-from-row select");

/** The Send button in the open reply editor. */
const replySend = (): HTMLButtonElement =>
  [...host!.querySelectorAll<HTMLButtonElement>(".reply-actions button")]
    .find((b) => buttonLabel(b) === "Send")!;

/**
 * A REPLY LETS YOU CHOOSE WHICH ADDRESS ANSWERS (overturning an earlier ruling that
 * a reply's sender is a fact, not a choice). The selector is offered exactly when the account has a
 * choice to make: more than one sendable address. The screen and the wire are still one decision —
 * the picked id is what leaves the account — and a pick is a STATEMENT, so it silences the
 * substitution notice rather than sitting beside it.
 */
describe("ACCEPTANCE: a reply lets you choose which address answers (R9-7)", () => {
  it("offers a keyboard-reachable selector when there is more than one sendable address", async () => {
    await mountShell(TWO_CONNECTED);
    await openFirstMessage();
    await key("r");

    const select = replyFromSelect();
    expect(select, "no From selector with two mailboxes to choose from").not.toBeNull();
    expect(select!.tagName).toBe("SELECT");
    // A native <select> is in the tab order and driven from the keyboard by construction — not a
    // div-with-onClick. `disabled` is the only thing that would remove it, and it is not set.
    expect(select!.disabled).toBe(false);
    // Named by an associated label, so a screen reader hears "From".
    expect(
      host!.querySelector(`.reply-from label[for="${select!.id}"]`),
      "the From selector has no associated label",
    ).not.toBeNull();
    const values = [...select!.options].map((o) => o.value);
    expect(values).toContain(LICHTGRAT);
    expect(values).toContain(MILABRUNNER);
  });

  it("a pick changes the mailbox on the WIRE — the selector value is the sender", async () => {
    await mountShell(TWO_CONNECTED);
    await openFirstMessage();
    await key("r");
    // Untouched, the mailbox the message arrived in leads and nothing is announced.
    expect(replyFromSelect()!.value).toBe(LICHTGRAT);
    expect(replySub(), "an untouched reply announced a substitution").toBeNull();

    await setValue(replyFromSelect()!, HTMLSelectElement.prototype, MILABRUNNER, "change");
    await typeRich(replyEditor(), "Passt.");
    await act(async () => { replySend().click(); });

    const sent = dispatched.filter((m) => m.kind === "mail_send");
    expect(sent).toHaveLength(1);
    expect(
      (sent[0] as { mailboxId?: string }).mailboxId,
      "the reply answered from the picked address only on screen, not on the wire",
    ).toBe(MILABRUNNER);
  });

  it("picking an address SILENCES the substitution notice — a pick is not a substitution", async () => {
    // The mailbox the message arrived in (lichtgrat) is disabled, so a fresh reply substitutes and
    // SAYS so; two other sendable addresses mean the selector is offered. Choosing one is the reader
    // making the decision the notice flagged, so the notice goes and the wire follows the pick.
    await mountShell([
      { ...TWO_CONNECTED[0]!, status: "disabled" }, // lichtgrat — where the message arrived
      TWO_CONNECTED[1]!,                            // milabrunner — sendable
      fact({ id: "wolke", address: "mila@wolkenmail.example", createdAt: "2026-05-01T00:00:00.000Z" }),
    ]);
    await openFirstMessage();
    await key("r");

    expect(replySub(), "the substitution was not announced").not.toBeNull();
    const select = replyFromSelect();
    expect(select, "no selector where two sendable addresses exist").not.toBeNull();

    await setValue(select!, HTMLSelectElement.prototype, "wolke", "change");
    expect(replySub(), "the notice survived an explicit pick").toBeNull();

    await typeRich(replyEditor(), "Passt.");
    await act(async () => { replySend().click(); });
    const sent = dispatched.filter((m) => m.kind === "mail_send");
    expect((sent.at(-1) as { mailboxId?: string }).mailboxId).toBe("wolke");
  });

  it("the pick is PER-MESSAGE — reopening the editor elsewhere does not carry it", async () => {
    await mountShell(TWO_CONNECTED);
    await openFirstMessage();
    await key("r");
    await setValue(replyFromSelect()!, HTMLSelectElement.prototype, MILABRUNNER, "change");
    expect(replyFromSelect()!.value).toBe(MILABRUNNER);

    await key("Escape"); // close — nulls replyTo, which resets the pick
    await key("j");      // move to another message
    await key("r");      // a fresh reply

    expect(
      replyFromSelect()!.value,
      "a From pick rode from one message's reply to another's",
    ).toBe(LICHTGRAT);
  });
});

/* ── the domain match, on the shipped surface ─────────────────────────────────────────── */

/** The recipient field on the compose form — the one the user types the address into. */
const composeTo = (): HTMLInputElement => host!.querySelector<HTMLInputElement>("#compose-to")!;

/** The line that says the sender moved. Absent is the assertion in half the cases below. */
const matchHint = (): HTMLElement | null => host!.querySelector<HTMLElement>(".compose-from-hint");

/** Type a recipient the way the field receives one — the input holds the wire text. */
const addressTo = (line: string): Promise<void> =>
  setValue(composeTo(), window.HTMLInputElement.prototype, line, "input");

const composeSend = (): HTMLButtonElement =>
  [...host!.querySelectorAll<HTMLButtonElement>(".send-row button")]
    .find((b) => buttonLabel(b) === "Send")!;

/**
 * WRITING TO A DOMAIN YOU OWN AN ADDRESS ON (gap R10-4) — on the surface, because that is where
 * it failed. The two fixture mailboxes are the case exactly: `milabrunner` is the older, so it is
 * the derived default, and a message to somebody at `lichtgrat.example` therefore left from the
 * WRONG business until this rule existed.
 *
 * The acceptance is the whole path — the value in the selector, the line on screen, the id on the
 * wire, and the scratch buffer that must NOT have learned anything. A derived default that got
 * written down as the user's pick would be sticky for every later message in that draft, which is
 * the one thing this must never become (the "No silent AI actions" invariant: visible, overridable, never silent).
 */
describe("ACCEPTANCE: composing to a domain you own switches the From (R10-4)", () => {
  it("moves the sender to the matching address and says that it did", async () => {
    await mountShell(TWO_CONNECTED);
    await goCompose();
    expect((fromControl() as HTMLSelectElement).value, "the derived default is not the older mailbox")
      .toBe(MILABRUNNER);
    expect(matchHint(), "announced a match before anything was addressed").toBeNull();

    await addressTo("piet@lichtgrat.example");

    expect(
      (fromControl() as HTMLSelectElement).value,
      "the message to lichtgrat.example still leaves from the other business's address",
    ).toBe(LICHTGRAT);
    const hint = matchHint();
    expect(hint, "the sender changed under the user with nothing on screen").not.toBeNull();
    expect(hint!.textContent).toBe("Switched to match the recipient's domain");
    // The line is attached to the control it is about, so it is not visual-only.
    expect(fromControl()!.getAttribute("aria-describedby")).toBe(hint!.id);
  });

  it("sends from the matched mailbox and stores NOTHING as the user's pick", async () => {
    await mountShell(TWO_CONNECTED);
    await goCompose();
    await addressTo("piet@lichtgrat.example");
    await typeRich(composeEditor(), "Kurz zum Angebot.");

    // The buffer is written on every keystroke and is what a reload restores from. A derived
    // default in `fromMailboxId` would come back as an explicit pick and silence the rule for
    // every later recipient in this draft.
    const buffered = JSON.parse(window.localStorage.getItem(composeDraftKey()) ?? "{}") as
      { to?: string; fromMailboxId?: string | null };
    expect(buffered.to, "the draft buffer was never written").toContain("piet@lichtgrat.example");
    expect(
      buffered.fromMailboxId,
      "a derived default was written down as the user's own choice",
    ).toBeNull();

    expect(composeSend().disabled).toBe(false);
    await act(async () => { composeSend().click(); });
    const sent = dispatched.filter((m) => m.kind === "mail_send");
    expect(sent, "pressing Send dispatched no mutation").toHaveLength(1);
    // THE SCREEN AND THE WIRE ARE ONE DECISION — the derived match travels the same way the
    // oldest-connected default does, or the line on screen was decoration.
    expect(
      (sent[0] as { mailboxId?: string }).mailboxId,
      "the form showed one sender and sent from another",
    ).toBe(LICHTGRAT);
  });

  it("an explicit pick suppresses it for that draft", async () => {
    await mountShell(TWO_CONNECTED);
    await goCompose();
    await setValue(fromControl()!, window.HTMLSelectElement.prototype, LICHTGRAT, "change");
    // A recipient at the OTHER own domain — the one the rule would otherwise switch to.
    await addressTo("jan@milabrunner.example");

    expect(
      (fromControl() as HTMLSelectElement).value,
      "the recipient's domain overruled the address the user chose",
    ).toBe(LICHTGRAT);
    expect(matchHint(), "announced a switch over an explicit pick").toBeNull();
  });

  it("two recipients on two of your own domains leave the sender alone", async () => {
    await mountShell(TWO_CONNECTED);
    await goCompose();
    await addressTo("piet@lichtgrat.example, jan@milabrunner.example");

    expect(
      (fromControl() as HTMLSelectElement).value,
      "an ambiguous recipient set still moved the sender",
    ).toBe(MILABRUNNER);
    expect(matchHint()).toBeNull();
  });

  it("says nothing on a surface with no mailbox facts", async () => {
    // The Desktop and a Cloud tab before its first poll: `optionsFromMirror` still seeds the demo,
    // but a shell with no mailboxes at all can name no address and must not guess at one.
    await mountShell(null);
    await goCompose();
    await addressTo("piet@lichtgrat.example");
    // The demo's seeded mirror rows ARE the account's mailboxes here, so a match is legitimate;
    // what must never appear is a claim with nothing behind it.
    if (fromControl() === null) expect(matchHint()).toBeNull();
  });

  /**
   * A REPLY NEVER SWITCHES. Its sender is the mailbox the message arrived in — a fact about the
   * conversation, not a derivation from who is being written to — so editing a reply's recipients
   * to an address at another of the account's own domains must move nothing. `resolveReplyFrom`
   * takes no recipients at all, and this is what would go red if it ever did.
   */
  it("a reply keeps the mailbox the message arrived in, whatever its recipients say", async () => {
    await mountShell(TWO_CONNECTED);
    await openFirstMessage();
    await key("r");
    expect(replyFromSelect()!.value).toBe(LICHTGRAT);

    // Open the editable envelope and address it at the account's OTHER domain.
    const head = host!.querySelector<HTMLButtonElement>(".reply-head-btn");
    expect(head, "the reply's recipients cannot be edited at all").not.toBeNull();
    await act(async () => { head!.click(); });
    const to = host!.querySelector<HTMLInputElement>(".reply-rcpt input.rcp-input");
    expect(to, "the reply recipient row did not open").not.toBeNull();
    await setValue(to!, window.HTMLInputElement.prototype, "jan@milabrunner.example", "input");

    expect(
      replyFromSelect()!.value,
      "a reply changed the address it answers from because of who it is addressed to",
    ).toBe(LICHTGRAT);
    expect(matchHint(), "the compose hint appeared inside a reply").toBeNull();
  });
});

/**
 * ACCEPTANCE: WRITING TO YOURSELF, on the shipped surface.
 *
 * The two fixture mailboxes are the reported case exactly. `milabrunner` is the older, so it is
 * the derived default and the address the From line shows when Compose opens; `mila@lichtgrat.
 * studio` is the account's OTHER address. Addressing a message to it — a note to yourself, the
 * commonest reason to type your own address into a compose form — moved the From line onto
 * `lichtgrat` and printed the switch notice, which is the whole of what is being fixed.
 *
 * Driven through the rendered shell rather than the resolver because that is where the user meets
 * it: what is asserted is the value in the selector, the presence or absence of the notice, and
 * the mailbox id the send actually carries.
 */
describe("ACCEPTANCE: composing to one of your OWN addresses leaves the sender alone", () => {
  it("keeps the address Compose opened on, and says nothing", async () => {
    await mountShell(TWO_CONNECTED);
    await goCompose();
    expect((fromControl() as HTMLSelectElement).value).toBe(MILABRUNNER);

    await addressTo("mila@lichtgrat.example");

    expect(
      (fromControl() as HTMLSelectElement).value,
      "a note to the account's own address moved the sender onto it",
    ).toBe(MILABRUNNER);
    expect(matchHint(), "announced a switch on a message addressed to the sender").toBeNull();
  });

  it("is case- and space-blind about which address is yours", async () => {
    await mountShell(TWO_CONNECTED);
    await goCompose();
    await addressTo("  Mila@Lichtgrat.Example  ");
    expect((fromControl() as HTMLSelectElement).value).toBe(MILABRUNNER);
    expect(matchHint()).toBeNull();
  });

  it("still lets a STRANGER on that same domain decide, standing beside you", async () => {
    await mountShell(TWO_CONNECTED);
    await goCompose();
    // Your own address AND a correspondent at that domain. The correspondent is the evidence;
    // your own address is not, and dropping it must not drop theirs.
    await addressTo("mila@lichtgrat.example, piet@lichtgrat.example");

    expect(
      (fromControl() as HTMLSelectElement).value,
      "the account's own address on the To line silenced the rule for the correspondent too",
    ).toBe(LICHTGRAT);
    expect(matchHint(), "switched without saying so").not.toBeNull();
  });

  it("sends from the address on screen — the wire agrees with the From line", async () => {
    await mountShell(TWO_CONNECTED);
    await goCompose();
    await addressTo("mila@lichtgrat.example");
    await typeRich(composeEditor(), "Notiz an mich selbst.");

    expect(composeSend().disabled).toBe(false);
    await act(async () => { composeSend().click(); });
    const sent = dispatched.filter((m) => m.kind === "mail_send");
    expect(sent, "pressing Send dispatched no mutation").toHaveLength(1);
    expect(
      (sent[0] as { mailboxId?: string }).mailboxId,
      "the note to yourself left from the mailbox it was addressed TO",
    ).toBe(MILABRUNNER);
  });

  /**
   * THE Cc AND Bcc LINES ARE NOT READ AT ALL, which is the pre-existing rule (`compose.to` is the
   * only recipient source `AppShell` hands the resolver) and is what makes "every recipient is
   * your own address" true for those two lines without a clause of their own. Asserted with a
   * STRANGER on Cc, because that is the case where reading them would show: if Cc were read, this
   * message would leave from `lichtgrat` instead of the default.
   */
  it("never moves the sender for a Cc recipient, own or otherwise", async () => {
    await mountShell(TWO_CONNECTED);
    await goCompose();
    const ccToggle = host!.querySelector<HTMLButtonElement>('button[aria-controls="compose-cc compose-bcc"]');
    expect(ccToggle, "the Cc row cannot be opened").not.toBeNull();
    await act(async () => { ccToggle!.click(); });
    const cc = host!.querySelector<HTMLInputElement>("#compose-cc");
    expect(cc, "the Cc field did not render").not.toBeNull();
    await setValue(cc!, window.HTMLInputElement.prototype, "piet@lichtgrat.example", "input");

    expect(
      (fromControl() as HTMLSelectElement).value,
      "a Cc recipient decided which identity is writing",
    ).toBe(MILABRUNNER);
    expect(matchHint()).toBeNull();
  });
});
