/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  type EngineMessage,
  type Folder,
  type SyncChange,
  type UnsubscribeLetter,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { SenderMenu } from "../app/shell/SenderMenu";
import { senderScreening } from "../app/shell/sender-screening";
import { shellSliceOf } from "./source-anchor";

/**
 * ── THE SHEET IS REACHED, NOT MERELY BUILT ──────────────────────────────────
 *
 * The repository's recurring failure is *built, tested, unreachable*: a finished surface over
 * a verb that rejects, a strip whose update signal cannot see its own state, a success toast
 * fired on a server refusal. Every one of them was green in a suite that tested the pure
 * module underneath and never rendered the thing the user clicks.
 *
 * `sender-screening.test.ts` tests the plan. THIS renders the popover and drives it, so the
 * three rule-creation additions are asserted where a person meets them:
 *
 *   · the scope switch exists, and choosing it changes what gets dispatched;
 *   · the two reject destinations do NOT commit on the first click — they open the
 *     disclosure, which is the whole of the second coupling;
 *   · the detail affordance calls out with the scope that was on screen;
 *   · the RULE TOGGLE exists, is ON by default, and what the user leaves it at is what
 *     reaches `onChoose`. A default that only holds in the planner's signature and never
 *     arrives from the component is the same "built, tested, unreachable" shape.
 *
 * A `role`/text-driven test on purpose: it fails if the control is removed, renamed out of the
 * accessibility tree, or rendered but never wired.
 */

let seq = 0;

function msg(id: string, from: string, folder: Folder): EngineMessage {
  return {
    id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name: null, address: from },
    to: [],
    cc: [],
    date: "2026-08-01T09:00:00.000Z",
    folder,
    snippet: "s",
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-08-01T09:00:00.000Z",
  };
}

async function mirror(list: EngineMessage[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(list.map((m): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  return store;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

interface Rendered {
  onChoose: ReturnType<typeof vi.fn>;
  onOpenDetail: ReturnType<typeof vi.fn>;
  el: HTMLElement;
}

async function render(
  list: EngineMessage[],
  seedId: string,
  /**
   * The account switch (mail 0054) as `AppShell` resolves it, defaulted here to the component's
   * own default so every existing case in this file keeps asserting the shipped behaviour.
   * `address` is the contact-chip override (viewer), resolved exactly as `AppShell` does.
   */
  opts: { autoUnsubscribe?: boolean; address?: string; letters?: readonly UnsubscribeLetter[] } = {},
): Promise<Rendered> {
  const store = await mirror(list);
  const sender = senderScreening(store, seedId, opts.address)!;
  const onChoose = vi.fn();
  const onOpenDetail = vi.fn();

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      React.createElement(NextIntlClientProvider, {
        locale: "en",
        messages,
        // `children` as a PROP, not a third argument: `NextIntlClientProvider` declares it
        // required in its own props type, and the variadic form does not satisfy that under
        // `tsc`. `apps/webapp` typechecks its tests, so the variadic form fails the build.
        children: React.createElement(SenderMenu, {
          state: { messageId: seedId, x: 0, y: 0 },
          sender,
          onChoose,
          onOpenDetail,
          ...(opts.autoUnsubscribe === undefined ? {} : { autoUnsubscribe: opts.autoUnsubscribe }),
          ...(opts.letters === undefined ? {} : { lettersFor: () => opts.letters! }),
          onClose: () => {},
        }),
      }),
    );
  });
  return { onChoose, onOpenDetail, el: host };
}

const click = async (node: Element | null | undefined) => {
  expect(node, "the control this test drives does not exist").toBeTruthy();
  await act(async () => {
    node!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

const byText = (el: HTMLElement, selector: string, text: string) =>
  [...el.querySelectorAll(selector)].find((n) => (n.textContent ?? "").includes(text));

describe("the scope switch is on the sheet and does something", () => {
  it("offers the domain, states its size, and dispatches with scope='domain'", async () => {
    const { onChoose, el } = await render([
      msg("a", "no-reply-1@x.example", "ohmail/News"),
      msg("b", "no-reply-2@x.example", "ohmail/News"),
      msg("c", "no-reply-3@x.example", "ohmail/News"),
    ], "a");

    const domainBtn = byText(el, ".sm-scope button", "Everyone at x.example");
    expect(domainBtn).toBeTruthy();
    // The COUNT is on the control, which is the mitigation for "everyone at gmail.com":
    // the wide option can only be chosen with its size visible.
    expect(domainBtn!.textContent).toContain("3 messages");
    expect(domainBtn!.textContent).toContain("3 senders");

    // It starts on the ADDRESS — defaulting to the domain would silently widen what every
    // existing habit-click does.
    expect(el.querySelector(".sm-scope button.on")!.textContent).toContain("This address");

    await click(domainBtn);
    await click(byText(el, "li", "Receipts"));
    expect(onChoose).toHaveBeenCalledWith("receipts", "domain", true, true);
  });

  it("is not offered at all for an address with no domain", async () => {
    // `decide` answers 422 for this, so presenting the choice would be offering a refusal.
    //
    // BY ROLE, NOT BY CLASS. This read `.sm-scope` until that change, when the rule toggle started
    // reusing that class for its own styling — at which point the selector stopped naming the
    // scope switch and started naming "any pill row", which is not the claim. The role IS the
    // claim ("no scope CHOICE is presented"), and this file's header says role- and text-driven
    // on purpose. Render a second radiogroup here and it still goes red.
    const { el } = await render([msg("a", "malformed-no-at-sign", "INBOX")], "a");
    expect(el.querySelector("[role=radiogroup]")).toBeNull();
    expect(byText(el, "button", "Everyone at")).toBeUndefined();
  });
});

describe("the unsubscribe coupling is disclosed BEFORE it runs", () => {
  it("screening a waiting sender out opens the disclosure instead of committing", async () => {
    // A held letter that offers one-click from a sender its provider confirmed: a fact (`unsubscribe-claim.ts`).
    const { onChoose, el } = await render([msg("a", "spam@bulk.example", "ohmail/Screener")], "a", {
      letters: [{ posture: "one_click", authVerdict: "pass" }],
    });

    await click(byText(el, "li", "Screened"));
    // THE ASSERTION THAT MATTERS: nothing has been dispatched yet.
    expect(onChoose).not.toHaveBeenCalled();

    const confirm = el.querySelector(".sm-confirm");
    expect(confirm).toBeTruthy();
    expect(confirm!.textContent).toContain("one-click unsubscribe request");

    await click(byText(el, ".sm-confirm-row button", "Screen out and unsubscribe"));
    expect(onChoose).toHaveBeenCalledWith("screened", "sender", true, true);
  });

  it("names the domain and the number of senders when the scope is the domain", async () => {
    const { el } = await render([
      msg("a", "one@bulk.example", "ohmail/Screener"),
      msg("b", "two@bulk.example", "ohmail/Screener"),
    ], "a");

    await click(byText(el, ".sm-scope button", "Everyone at bulk.example"));
    await click(byText(el, "li", "Screened"));

    const confirm = el.querySelector(".sm-confirm");
    expect(confirm!.textContent).toContain("2 senders");
    expect(confirm!.textContent).toContain("bulk.example");
  });

  it("cancelling dispatches nothing and puts the destinations back", async () => {
    const { onChoose, el } = await render([msg("a", "spam@bulk.example", "ohmail/Screener")], "a");
    await click(byText(el, "li", "Screened"));
    await click(byText(el, ".sm-confirm-row button", "Cancel"));
    expect(onChoose).not.toHaveBeenCalled();
    expect(el.querySelector(".sm-confirm")).toBeNull();
    expect(el.querySelector("ul[role=listbox]")).toBeTruthy();
  });

  /**
   * The honest negative. A sender past the gate is moved, and a move arms nothing today —
   * `onScreenOut` is reached only from `decide`. Warning here would train the user to click
   * through the warning that is real.
   */
  it("a sender already past the gate commits straight away — no rule, nothing armed", async () => {
    const { onChoose, el } = await render([msg("a", "spam@bulk.example", "INBOX")], "a");
    await click(byText(el, "li", "Screened"));
    expect(el.querySelector(".sm-confirm")).toBeNull();
    expect(onChoose).toHaveBeenCalledWith("screened", "sender", true, true);
  });

  /**
   * ── THE ACCOUNT SWITCH, AT THE SURFACE (mail 0054) ──────────────────────────────────────
   *
   * The other honest negative, and the one this slice adds. The plan still reports
   * `unsubscribes: true` for a waiting sender — nothing about the CODE PATH changed — but the
   * account has turned auto-unsubscribe off, so the request will not be made and the sheet must
   * not ask for consent to it.
   *
   * An empty confirm is not a harmless extra step: it is exactly how people learn to click
   * through the confirm that IS real, which is the same argument the header makes for not
   * warning on a rule written past the gate.
   *
   * Wire the prop to a constant `true`, or drop it from `commit`'s condition, and this goes red.
   */
  it("OFF: a waiting sender commits straight away, with no disclosure of a request nobody will send", async () => {
    const { onChoose, el } = await render(
      [msg("a", "spam@bulk.example", "ohmail/Screener")], "a", { autoUnsubscribe: false },
    );

    await click(byText(el, "li", "Screened"));

    expect(el.querySelector(".sm-confirm")).toBeNull();
    expect(onChoose).toHaveBeenCalledWith("screened", "sender", true, true);
  });

  it("OFF: spam likewise — both reject destinations read the same switch", async () => {
    const { onChoose, el } = await render(
      [msg("a", "spam@bulk.example", "ohmail/Screener")], "a", { autoUnsubscribe: false },
    );

    await click(byText(el, "li", "Spam"));

    expect(el.querySelector(".sm-confirm")).toBeNull();
    expect(onChoose).toHaveBeenCalledWith("spam", "sender", true, true);
  });

  /**
   * THE DEFAULT IS THE DISCLOSURE, and it is asserted separately from the cases above because it
   * is a claim about the COMPONENT'S OWN default rather than about a value `AppShell` passes.
   *
   * A mount that has not been taught about the switch — a test, an older caller, a surface added
   * later — keeps asking, because the failure worth preventing is the silent one: a click that
   * quietly leaves a mailing list. Change the parameter default to `false` and this goes red
   * while every OTHER test in this describe stays green, which is the point of pinning it here.
   */
  /**
   * THE CONFIRM SAYS WHAT THIS SENDER IS SENT. The server asks for any of the sender's
   * mail offering one-click, now and later, so held letters offering none, read or not, still get the
   * request as that condition; a seen one-click letter makes it a fact.
   */
  it("held mail read and offering no one-click: the confirm still says the sender-level condition", async () => {
    const { onChoose, el } = await render([msg("a", "spam@bulk.example", "ohmail/Screener")], "a", {
      letters: [{ posture: "no_header", authVerdict: "pass" }],
    });
    await click(byText(el, "li", "Screened"));
    expect(onChoose, "a press that may ask a list committed with no word").not.toHaveBeenCalled();
    expect(el.querySelector(".sm-confirm")?.getAttribute("data-unsub")).toBe("may_send");
    expect(el.querySelector(".sm-confirm")!.textContent).toContain("now and for their later mail");
  });

  it("the shell hands the sheet each held letter's posture, read from the body the server sent", () => {
    const shell = readFileSync(resolve(process.cwd(), "apps/webapp/app/shell/AppShell.tsx"), "utf8");
    const at = shell.indexOf("<SenderMenu");
    const mount = shell.slice(at, shell.indexOf("/>", shell.indexOf("onClose={() => setSenderMenu(null)}", at)));
    expect(at, "the sheet is mounted in the shell").toBeGreaterThan(-1);
    expect(mount).toMatch(/lettersFor=\{\(scope\) => senderMenuFor\.scopes\[scope\]\.messages/);
    expect(mount).toContain("unsubscribeLetterOf(engine.read(), m.id)");
  });

  it("a one-click letter its provider did not confirm: the condition, not the fact", async () => {
    const { onChoose, el } = await render([msg("a", "spam@bulk.example", "ohmail/Screener")], "a", {
      letters: [{ posture: "one_click", authVerdict: "unavailable" }],
    });
    await click(byText(el, "li", "Screened"));
    expect(onChoose).not.toHaveBeenCalled();
    expect(el.querySelector(".sm-confirm")?.getAttribute("data-unsub")).toBe("may_send");
    expect(byText(el, ".sm-confirm-row button", "Screen out and unsubscribe")).toBeUndefined();
  });

  it("a held letter still unread: the same condition, and its commit is Continue rather than a promise", async () => {
    const { onChoose, el } = await render([msg("a", "spam@bulk.example", "ohmail/Screener")], "a", {
      letters: [{ posture: "no_header", authVerdict: null }, { posture: null, authVerdict: null }],
    });
    await click(byText(el, "li", "Screened"));
    const confirm = el.querySelector(".sm-confirm");
    expect(confirm?.getAttribute("data-unsub")).toBe("may_send");
    expect(confirm!.textContent).toContain("where they offer one-click unsubscribe, ohmail also asks to unsubscribe you on your behalf, now and for their later mail");
    expect(byText(el, ".sm-confirm-row button", "Screen out and unsubscribe")).toBeUndefined();
    await click(byText(el, ".sm-confirm-row button", "Continue"));
    expect(onChoose).toHaveBeenCalledWith("screened", "sender", true, true);
  });

  it("the prop defaults to ON: a caller that passes nothing still discloses", async () => {
    const { onChoose, el } = await render([msg("a", "spam@bulk.example", "ohmail/Screener")], "a");
    await click(byText(el, "li", "Screened"));
    expect(onChoose).not.toHaveBeenCalled();
    expect(el.querySelector(".sm-confirm")).toBeTruthy();
  });
});

/**
 * ── VIEWER THE SHEET OPENED FROM A CONTACT CHIP ─────────────────────────────────────────
 *
 * A Cc chip's "Screener settings" resolves the CHIP'S address. The mutation this pins red:
 * resolve the message id alone — the head then names the SENDER while the control the user
 * pressed named the Cc'd person, and every destination click rules on the wrong human.
 */
describe("the sheet resolved to a chip's address", () => {
  it("names the CC person in the head and rules on THEIR address — never the sender's", async () => {
    const seed = {
      ...msg("seed", "sender@corp.example", "INBOX"),
      cc: [{ name: "Cy Cole", address: "cy@x.example" }],
    };
    const { onChoose, el } = await render([seed], "seed", { address: "cy@x.example" });

    const head = el.querySelector(".sm-head")!;
    expect(head.textContent).toContain("Cy Cole");
    expect(head.textContent).not.toContain("sender@corp.example");
    // The scope switch names the CHIP's domain, so the wide option widens the right subject.
    expect(byText(el, ".sm-scope button", "Everyone at x.example")).toBeTruthy();

    await click(byText(el, "li", "News"));
    expect(onChoose).toHaveBeenCalledWith("reads", "sender", true, true);
  });
});

describe("the way into the detail view", () => {
  it("carries the scope that is on screen", async () => {
    const { onOpenDetail, el } = await render([
      msg("a", "one@x.example", "INBOX"),
      msg("b", "two@x.example", "INBOX"),
    ], "a");

    const detail = el.querySelector(".sm-detail")!;
    expect(detail.textContent).toContain("See all 1 message");
    await click(detail);
    expect(onOpenDetail).toHaveBeenLastCalledWith("sender");

    await click(byText(el, ".sm-scope button", "Everyone at x.example"));
    expect(el.querySelector(".sm-detail")!.textContent).toContain("See all 2 messages");
    await click(el.querySelector(".sm-detail"));
    expect(onOpenDetail).toHaveBeenLastCalledWith("domain");
  });
});

/**
 * ── THE RULE IS THE DEFAULT, AND THE DEFAULT HAS TO ARRIVE ────────────────────────
 *
 * Reported: *"this should be the default behaviour to efficiently manage the mailbox."* A default
 * that lives only in `planScreeningChange`'s signature and never leaves the component is the
 * repository's own recurring failure one more time. These drive the control.
 */
describe("the rule toggle", () => {
  it("is on by default, and that is what reaches onChoose", async () => {
    const { onChoose, el } = await render([msg("a", "one@x.example", "INBOX")], "a");
    const toggle = el.querySelector(".sm-rule")!;
    expect(toggle, "the rule toggle does not exist").toBeTruthy();
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    await click(byText(el, "li", "News"));
    expect(onChoose).toHaveBeenCalledWith("reads", "sender", true, true);
  });

  it("turning it off is the explicit non-default, and it travels", async () => {
    const { onChoose, el } = await render([msg("a", "one@x.example", "INBOX")], "a");
    await click(el.querySelector(".sm-rule"));
    expect(el.querySelector(".sm-rule")!.getAttribute("aria-checked")).toBe("false");

    await click(byText(el, "li", "News"));
    expect(onChoose).toHaveBeenCalledWith("reads", "sender", false, true);
  });

  it("is not offered for a WAITING sender — the decide promotes the rule regardless", async () => {
    // A switch that cannot change the outcome is a control that lies about having one.
    const { el } = await render([msg("a", "one@x.example", "ohmail/Screener")], "a");
    expect(el.querySelector(".sm-rule")).toBeNull();
  });

  /**
   * THE HONEST NEGATIVE, AT THE COMPONENT. A rule to a reject folder is now genuinely created
   * from past the gate — and it still opens no disclosure, because it arms nothing:
   * `onScreenOut` is reached only from `decide`. Wiring the confirm to "a rule is being made"
   * rather than to `ScreeningPlan.unsubscribes` makes this go red.
   */
  it("screening past the gate to a reject folder commits straight away, rule and all", async () => {
    const { onChoose, el } = await render([msg("a", "spam@bulk.example", "INBOX")], "a");
    await click(byText(el, "li", "Screened"));
    expect(el.querySelector(".sm-confirm")).toBeNull();
    expect(onChoose).toHaveBeenCalledWith("screened", "sender", true, true);
  });
});

describe("the footer keeps telling the truth", () => {
  it("a contact chip's sheet moves no letter, so it promises none moves", async () => {
    const { el } = await render([
      msg("a", "one@x.example", "INBOX"),
      msg("b", "two@x.example", "INBOX"),
    ], "a", { address: "two@x.example" });
    const foot = () => el.querySelector(".sm-foot")!.textContent!;
    expect(foot()).not.toContain("This message moves there now");
    expect(foot()).toContain("Future mail from two@x.example files there too");
    await click(el.querySelector(".sm-retro"));
    expect(foot()).toContain("Mail already here stays where it is");
  });

  it("promises a rule for the whole domain only when the domain is waiting", async () => {
    const { el } = await render([
      msg("a", "one@x.example", "ohmail/Screener"),
      msg("b", "two@x.example", "ohmail/Screener"),
    ], "a");
    await click(byText(el, ".sm-scope button", "Everyone at x.example"));
    expect(el.querySelector(".sm-foot")!.textContent).toContain("anyone at x.example");
  });

  /**
   * `footNoRule` USED TO BE THE ONLY SENTENCE HERE, and this test used to assert it as *"the
   * sentence rule creation could not retire"* — true while rule creation past the gate had no verb. It
   * has one now, so the sentence is no longer the default; it is what the OPT-OUT says, and it
   * is still exactly true there. Both halves are asserted rather than one being dropped.
   *
   * The retroactive half widened the default sentence again: the rule is now applied to mail already on the
   * server, so the footer names the PAST as well as the future. The substring moved from
   * "future mail from … files there too" to the two claims that must both be present, because
   * the retroactive half is the one a user would be surprised by afterwards.
   */
  it("says future mail follows AND that the rule reaches mail already here, by default", async () => {
    const { el } = await render([msg("a", "one@x.example", "INBOX")], "a");
    const foot = () => el.querySelector(".sm-foot")!.textContent!;
    // The press files the letter it was made on now: said before the press, not promised to stay.
    expect(foot()).toContain("This message moves there now, and future mail from one@x.example files there too");
    expect(foot()).toContain("applies the rule to the rest of the mail it has already filed for you");
    // The half with no undo. The sentence NARROWED in 0.19 — "the mail already in your mailbox"
    // claimed more than the pass reaches, which only reconsiders the six folders ohmail organizes
    // (`rule-retro.ts#selectCandidates`), never a customer's own folders or their Sent.
    expect(foot()).toContain("the mail it has already filed for you");
    expect(foot(), "a claim the pass cannot keep").not.toContain("already in your mailbox");
    expect(foot()).toContain("stays moved if you later revoke the rule");
    // THE-CLIENTS-FIFTY: the pass is the only half now, and the sentence names what it leaves
    // alone; the press moves nothing of its own, so no count of moves "now" may be claimed.
    // A filing the person made stays, here (`decided_at`) or in another mail app (`last_set_by 'external'`).
    expect(foot()).toContain("leaves alone messages you have replied to, filed yourself here or in another mail app, or set aside");
    expect(foot(), "a count the press no longer makes").not.toContain("Up to 50");

    await click(el.querySelector(".sm-rule"));
    expect(foot()).toContain("It makes no rule, so future mail is unchanged.");
  });

  /**
   * THE OPT-OUT IS STILL AN OPT-OUT OF BOTH HALVES. Turning the rule off must stop the
   * retroactive apply too — `planScreeningChange` reports `retro: false` for every plan that
   * writes no rule — and the footer must not keep a sentence about mail already here.
   */
  it("the opt-out withdraws the retroactive claim as well, not only the future one", async () => {
    const { el } = await render([msg("a", "one@x.example", "INBOX")], "a");
    await click(el.querySelector(".sm-rule"));
    const foot = el.querySelector(".sm-foot")!.textContent!;
    expect(foot).not.toContain("already filed for you");
    expect(foot).not.toContain("revoke the rule");
    // …and the past-mail row goes with it: no rule, nothing for it to be a question about.
    expect(el.querySelector(".sm-retro")).toBeNull();
  });

  it("follows the SCOPE as well — a domain rule is not described as one address's", async () => {
    const { el } = await render([
      msg("a", "one@x.example", "INBOX"),
      msg("b", "two@x.example", "INBOX"),
    ], "a");
    await click(byText(el, ".sm-scope button", "Everyone at x.example"));
    expect(el.querySelector(".sm-foot")!.textContent)
      .toContain("This message moves there now, and future mail from anyone at x.example files there too");
  });

  /**
   * THE SIZE OF THE RETROACTIVE HALF IS ON THE SWITCH THAT TURNS IT ON — the count before the
   * click, which is what the risk review asks for. It says "applies to", never "moves": the worker pass
   * re-evaluates through `evaluateRules`, so a higher-priority deny rule keeps its mail put, and
   * anything the user has already acted on is skipped.
   */
  it("states how much mail the rule will be applied to, before the click", async () => {
    const { el } = await render([
      msg("a", "one@x.example", "INBOX"),
      msg("b", "one@x.example", "ohmail/News"),
    ], "a");
    // The count moved WITH the claim in 0.19: it sits on the switch that turns the retroactive
    // apply on, not on the rule's label, so the rule's own sentence is about the future alone.
    expect(el.querySelector(".sm-rule")!.textContent, "the rule label promises only the future")
      .not.toContain("messages");
    const note = el.querySelector(".sm-retro small")!.textContent!;
    expect(note).toContain("2 messages");
    expect(note, "a count must never be phrased as a promise that they all move")
      .not.toContain("move");
  });
});

/**
 * ── 0.19: APPLYING THE RULE TO PAST MAIL IS ITS OWN CONTROL ──────────────────────────────
 *
 * Reported: *"we also want to have the option to apply this for past mails, so they get moved
 * according to the set rule, default is on"*. It rode the rule switch until this slice, so the
 * only way to keep old mail where it was, was to abandon the rule as well — the opposite of the
 * choice being asked for. The second switch is what makes both halves expressible, and the
 * footer must follow whichever pair of answers is on screen.
 */
describe("the past-mail option", () => {
  it("turns off without taking the rule with it", async () => {
    const { onChoose, el } = await render([
      msg("a", "one@x.example", "INBOX"),
      msg("b", "one@x.example", "ohmail/News"),
    ], "a");
    const retro = el.querySelector(".sm-retro")!;
    expect(retro, "the past-mail option does not exist").toBeTruthy();
    expect(retro.getAttribute("role")).toBe("switch");
    expect(retro.getAttribute("aria-checked"), "the default is ON").toBe("true");

    await click(retro);
    expect(el.querySelector(".sm-retro")!.getAttribute("aria-checked")).toBe("false");
    // The rule is untouched — that is the whole point of the second control.
    expect(el.querySelector(".sm-rule")!.getAttribute("aria-checked")).toBe("true");

    const foot = el.querySelector(".sm-foot")!.textContent!;
    expect(foot).toContain("files there too");
    // The needle here was `not.toContain("already")` — the absence of a WORD, which the off-state
    // sentence satisfied while it read "This moves the mail that is here" over a switch that had
    // just said not to. 0.19.1 asks for the claim instead: the retroactive half is withdrawn AND
    // the sentence that replaces it states what the switch decided.
    expect(foot, "the past-mail claim must go with the option").not.toContain("applies the rule");
    expect(foot, "…and the off state says what it does").toContain("The rest of their mail here stays where it is");
    expect(foot, "the letter pressed on moves, and the sheet says so").toContain("This message moves there now");
    expect(foot, "a promise the press breaks").not.toContain("Mail already here stays where it is");

    await click(byText(el, "li", "News"));
    expect(onChoose).toHaveBeenCalledWith("reads", "sender", true, false);
  });

  /**
   * THE SEAM THIS FILE EXISTS FOR — the switch REACHES the dispatch. Every case above renders the
   * component and reads `onChoose`, which is green even when the shell then throws the answer
   * away: drop the argument at `AppShell`'s `planScreeningChange` call and the switch is a
   * decoration whose mutation nothing else notices. Read as source, on `contact-chips.test.tsx`'s
   * precedent for this same call: a rendered `AppShell` is not reachable from this suite, and a
   * wiring fact with a silent failure mode is worth asserting by the shape of the call.
   */
  it("the answer reaches the plan through the shell, not only through onChoose", () => {
    // From the repo root, which is where this suite runs (CLAUDE.md): under `jsdom`
    // `import.meta.url` is not a file URL and `fileURLToPath` throws, which would be a red for the
    // harness rather than for the wiring.
    /* TWO FRAMES, BECAUSE THE CLAIM HAS TWO HALVES SINCE ARCH-022: the JSX that hands the
       sheet's answer over stayed in `AppShell.tsx`, and the verbs that hand it to the planner
       moved to `shell-verbs.ts`. Each half is asked of the frame that holds it, and the verbs
       are asked inside their OWN declarations rather than file-wide — a file-wide match would
       pass on any other call spelled the same way. */
    const shell = readFileSync(resolve(process.cwd(), "apps/webapp/app/shell/AppShell.tsx"), "utf8");
    expect(shell, "the sheet hands its four answers and the step's to changeScreening")
      .toMatch(/onChoose=\{\(dest, scope, makeRule, applyRetro, press\) => changeScreening\(/);
    expect(shellSliceOf("changeScreening"), "…and the shell hands the fifth to the planner")
      .toMatch(/planScreeningChange\(sender, dest, scope, makeRule, applyRetro\)/);
    expect(shellSliceOf("confirmSubjectRule"), "the subject sheet's answer is threaded the same way")
      .toMatch(/planSubjectRule\(ctx, term, dest, field, applyRetro\)/);
  });

  it("is offered only while the rule is on — it is subordinate to it, not a peer", async () => {
    const { el } = await render([msg("a", "one@x.example", "INBOX")], "a");
    expect(el.querySelector(".sm-retro")).toBeTruthy();
    await click(el.querySelector(".sm-rule"));
    expect(el.querySelector(".sm-retro"), "no rule, nothing to apply to past mail").toBeNull();
  });

  /**
   * THE COUNT IS THE MIRROR'S, AND IT SAYS SO. `subject.messages.length` is what this install has
   * synced — a 90-day window — while the worker pass walks every matching row on the server. The
   * note follows `auditCount`'s precedent rather than pretending the two numbers are one, and it
   * never phrases the count as a promise that they all move: the pass re-evaluates and skips.
   * Asserted on the NOTE, not the row: the label's own verb is "move" and belongs there.
   */
  it("carries the count in the mirror's own honest grammar, and never promises they all move", async () => {
    const { el } = await render([
      msg("a", "one@x.example", "INBOX"),
      msg("b", "one@x.example", "ohmail/News"),
    ], "a");
    const note = el.querySelector(".sm-retro small")!.textContent!;
    expect(note).toContain("2 messages");
    expect(note, "the count is what has SYNCED, and the sheet says so").toContain("synced");
    expect(note, "a count must never be phrased as a promise that they all move")
      .not.toContain("move");
  });
});
