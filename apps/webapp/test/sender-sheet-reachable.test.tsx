/** @vitest-environment jsdom */
import type { EngineMessage, Folder } from "@ohmail/wire";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { UnsubscribeLetter } from "@ohmail/client-engine";
import { settleFirstPaint } from "./_first-paint.js";
import messages from "../messages/en.json";
import { clickMounted, withMountedSender } from "./fixtures/mounted-sender-sheet.js";
import {
  ACCOUNT, ISO, act, installScreeningWeb, mountScreeningWeb, syncScreeningWeb,
  teardownScreeningWeb, tick, warmScreeningWeb,
} from "./fixtures/screening-web.js";
import { UNDO_MS } from "@ohmail/app-logic/press/routing-undo";
import { screen, within } from "@testing-library/react";
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

function msg(id: string, from: string, folder: Folder): EngineMessage {
  return {
    id,
    accountId: ACCOUNT,
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

beforeAll(warmScreeningWeb, 30_000);
let mounted = false;
async function clearLetterMenu() {
  if (mounted) await teardownScreeningWeb();
  mounted = false;
}
afterEach(clearLetterMenu);

interface RequestWrite {
  path: string;
  method: string;
  body: Record<string, unknown>;
}
async function render(
  list: EngineMessage[], seedId: string,
  opts: { autoUnsubscribe?: boolean; address?: string; letters?: readonly UnsubscribeLetter[]; atScreener?: boolean } = {},
) {
  const seed = list.find(({ id }) => id === seedId)!;
  const person = opts.address ?? seed.from.address;
  const contactName = [...seed.cc, ...seed.to].find(({ address }) => address === person)?.name ?? person;
  const opened = opts.address && contactName === person
    ? { ...seed, cc: [...seed.cc, { name: null, address: person }] }
    : seed;
  const rows = list.map((row, index) => ({
    ...(row.id === seedId ? opened : row),
    ...(opts.letters?.[index]?.authVerdict ? { authVerdict: opts.letters[index]!.authVerdict } : {}),
  }));
  const writes: RequestWrite[] = [];
  let seq = rows.length * 2;
  installScreeningWeb(opts.atScreener ? "#/screener" : `#/ohbox/m/${seedId}`, (path, query, method, init) => {
    const reply = (data: unknown, status = 200, written = false) => Response.json(data, {
      status,
      headers: { "X-Ohmail-Account": ACCOUNT, ...(written ? { "X-Sync-Seq": String(++seq) } : {}) },
    });
    if (path === "/api/mailboxes") return reply({ items: [{
      id: "mb", address: ["fixture", "mailbox.example"].join("@"), status: "connected", organizerRole: "organizer",
      organizerChecked: true, providerConfirms: true, createdAt: ISO, lastSyncAt: ISO, organizeConsentedAt: ISO,
    }] });
    if (path === "/api/consent") return reply({
      seedConfirmedAt: ISO, screeningResetAt: null, dormancyDays: 60, blockAutoUnsubscribeAt: opts.autoUnsubscribe === false ? ISO : null,
    });
    if (path === "/api/sync") return query.get("types") === "rule"
      ? syncScreeningWeb([], 0)
      : syncScreeningWeb(rows.flatMap((message, index) => {
        const letter = opts.letters?.[index];
        return [
          { type: "message", op: "create", id: message.id, seq: index * 2 + 1, updatedAt: message.updatedAt, entity: message },
          ...(letter && letter.posture !== null ? [{
            type: "message_body", op: "create", id: message.id, seq: index * 2 + 2, updatedAt: message.updatedAt,
            entity: {
              messageId: message.id, state: "ready", text: "Hello", html: null,
              loadedRemoteContent: false, unsubscribe: letter.posture, unsubscribeUrl: null, withheld: null,
            },
          }] : []),
        ];
      }), rows.length * 2);
    if (method !== "GET" && /^\/api\/(messages|screener|rules)(?:\/|$)/.test(path)) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      writes.push({ path, method, body });
      if (path === "/api/rules") return reply({
        ...body, id: "new-rule", priority: 0, enabled: true, provenance: "manual",
        createdAt: ISO, updatedAt: ISO, stats: { hits: 0, lastHitAt: null, demotions: 0 },
      }, 201, true);
      const moved = rows.find(({ id }) => path === `/api/messages/${id}/move`);
      if (moved) return reply({ ...moved, folder: body.folder }, 200, true);
      return reply({ messageId: seedId, appliedFolder: body.dest, createdRuleId: "new-rule" }, 200, true);
    }
    return undefined;
  });
  mounted = true;
  const frame = within(await mountScreeningWeb());
  await tick(4000);
  await settleFirstPaint();
  if (opts.atScreener) {
    const listbox = within(frame.getByRole("listbox", { name: messages.screener.title }));
    await clickMounted(listbox.getByRole("option", { name: (name) => name.startsWith(`${person}:`) }));
    return { el: frame.getByRole("region", { name: messages.frame.landmark.reading }), writes, person };
  }
  const reader = within(frame.getByRole("region", { name: messages.frame.landmark.reading }));
  await clickMounted(reader.getByRole("button", { name: (name) => name.startsWith(contactName) }));
  const page = within(document.body);
  return {
    el: page.getByRole("dialog", { name: messages.screening.aria.replace("{sender}", person) }),
    writes,
    person,
  };
}

const click = async (node: Element | null | undefined) => {
  expect(node, "the control this test drives does not exist").toBeTruthy();
  await act(async () => { node!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
};
const domain = (el: HTMLElement, name: RegExp = /^Everyone at x\.example/) => within(el).queryByRole("radio", { name });
const option = (el: HTMLElement, name: RegExp) => within(el).getByRole("radio", { name });
const ruleControl = (el: HTMLElement) => within(el).queryByRole("switch", { name: messages.screening.ruleToggleAria });
const retroControl = (el: HTMLElement) => within(el).queryByRole("switch", { name: messages.screening.retroToggleAria });
const rulesWritten = (writes: RequestWrite[]) => writes.filter(({ path }) => path === "/api/rules").map(({ body }) => body);
const afterDecision = () => tick(UNDO_MS + 500);

describe("the scope switch is on the sheet and does something", () => {
  it("offers the domain, states its size, and dispatches with scope='domain'", async () => {
    const { writes, el, person } = await render([
      msg("a", "no-reply-1@x.example", "ohmail/News"),
      msg("b", "no-reply-2@x.example", "ohmail/News"),
      msg("c", "no-reply-3@x.example", "ohmail/News"),
    ], "a");

    const domainBtn = domain(el);
    expect(domainBtn).toBeTruthy();
    // The COUNT is on the control, which is the mitigation for "everyone at gmail.com":
    // the wide option can only be chosen with its size visible.
    expect(domainBtn!.textContent).toContain("3 messages");
    expect(domainBtn!.textContent).toContain("3 senders");

    // It starts on the ADDRESS — defaulting to the domain would silently widen what every
    // existing habit-click does.
    expect(within(el).getByRole("radio", { name: /^This address/, checked: true }).textContent).toContain("This address");

    await click(domainBtn);
    await click(option(el, /^Receipts/));
    await afterDecision();
    expect(rulesWritten(writes)).toEqual([expect.objectContaining({ kind: "domain", match: "x.example", destination: "ohmail/Receipts", applyRetro: true })]);
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
    expect(within(el).queryByRole("radiogroup", { name: messages.screening.scopeAria })).toBeNull();
    expect(domain(el, /^Everyone at/)).toBeNull();
  });
});

describe("the unsubscribe coupling is disclosed BEFORE it runs", () => {
  it("names the domain and the number of senders when the scope is the domain", async () => {
    const senders = ["one@bulk.example", "two@bulk.example"];
    const { el, writes } = await render(
      senders.map((sender, index) => msg(String(index + 1), sender, "ohmail/Screener")),
      "1", { atScreener: true, letters: senders.map(() => ({ posture: "one_click", authVerdict: "pass" })) },
    );
    await click(within(el).getByRole("button", { name: "Decision scope" }));
    const page = within(document.body);
    await click(page.getByRole("menuitemradio", { name: /^Whole domain/i }));
    const actions = within(within(el).getByRole("toolbar", { name: messages.screener.place.panel }));
    await click(actions.getByRole("button", { name: "Screen out" }));
    expect(writes).toEqual([]);
    const question = page.queryByRole("dialog", { name: messages.screener.place.unsub.screened });
    expect(question).not.toBeNull();
    expect(question!.textContent).toContain("2 senders");
    expect(question!.textContent).toContain("bulk.example");
    await click(within(question!).getByRole("button", { name: messages.screener.place.unsub.screened }));
    await afterDecision();
    expect(writes.filter(({ path }) => path.startsWith("/api/screener/"))).toEqual([{
      path: "/api/screener/1",
      method: "POST",
      body: { decision: "no", dest: "ohmail/Screened", scope: "domain", applyRetro: false, unsubscribeIds: ["1", "2"] },
    }]);
  });

  /**
   * The honest negative. A sender past the gate is moved, and a move arms nothing today —
   * `onScreenOut` is reached only from `decide`. Warning here would train the user to click
   * through the warning that is real.
   */
  it("a sender already past the gate commits straight away — no rule, nothing armed", async () => {
    const { writes, el, person } = await render([msg("a", "spam@bulk.example", "INBOX")], "a");
    await click(option(el, /^Screen out/));
    expect(screen.queryByRole("dialog", { name: /^Screening for / })).toBeNull();
    await afterDecision();
    expect(rulesWritten(writes)).toEqual([expect.objectContaining({ kind: "sender", match: person, destination: "ohmail/Screened", applyRetro: true })]);
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
    const { writes, el, person } = await render([seed], "seed", { address: "cy@x.example" });

    expect(within(el).getByText("Cy Cole", { exact: true })).toBeTruthy();
    expect(el.textContent).not.toContain("sender@corp.example");
    // The scope switch names the CHIP's domain, so the wide option widens the right subject.
    expect(domain(el)).toBeTruthy();

    await click(option(el, /^News/));
    await afterDecision();
    expect(rulesWritten(writes)).toEqual([expect.objectContaining({ kind: "sender", match: person, destination: "ohmail/News", applyRetro: true })]);
  });
});

describe("the way into the detail view", () => {
  it("carries the scope that is on screen", async () => {
    const letters = [
      msg("a", "one@x.example", "INBOX"),
      msg("b", "two@x.example", "INBOX"),
    ];
    const { el } = await render(letters, "a");
    const detail = within(el).getByRole("button", { name: /See all 1 message/ });
    expect(detail.textContent).toBe("See all");
    await click(detail);
    expect(within(document.body).getByRole("dialog", { name: new RegExp(letters[0]!.from.address) })).toBeTruthy();

    await clearLetterMenu();
    const wide = await render(letters, "a");
    await click(domain(wide.el));
    const audit = within(wide.el).getByRole("button", { name: /See all 2 messages/ });
    expect(audit.textContent).toBe("See all");
    await click(audit);
    expect(within(document.body).getByRole("dialog", { name: /x\.example/ })).toBeTruthy();
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
  // The letter menu explicitly applies the rule to past mail. This is separate from the waiting card.
  async function expectLetterMenuDecision(
    destination: "screened" | "spam", name: string, opts: Parameters<typeof render>[2],
    confirmation?: string,
  ): Promise<void> {
    await clearLetterMenu();
    const letters = [msg("a", "waiting@bulk.example", "ohmail/Screener")];
    if (opts?.letters?.length === 2) {
      letters.push({
        ...msg("earlier", letters[0]!.from.address, "ohmail/Screener"),
        date: "2026-07-31T09:00:00.000Z",
      });
    }
    const { writes, el } = await render(letters, "a", opts);
    const sheet = within(el);
    const label = name === "Screened" ? /^Screen out/ : new RegExp(`^${name}`);
    await click(sheet.getByRole("radio", { name: label }));
    if (confirmation) {
      expect(writes).toEqual([]);
      await click(within(screen.getByRole("dialog", { name: /^Screening for / })).getByRole("button", { name: confirmation }));
    } else {
      expect(screen.queryByRole("dialog", { name: /^Screening for / })).toBeNull();
    }
    await afterDecision();
    const grant = confirmation ? ["a"] : undefined;
    const decisions = writes.filter(({ path }) => path === "/api/screener/a");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.body).toEqual(expect.objectContaining({
      scope: "sender", applyRetro: true,
      dest: destination === "screened" ? "ohmail/Screened" : "ohmail/Quarantine",
    }));
    expect(decisions[0]!.body.unsubscribeIds).toEqual(grant);
  }

  it("does not offer to unsubscribe from an earlier letter", async () => {
    await expectLetterMenuDecision("screened", "Screened", {
      letters: [{ posture: "no_header", authVerdict: "pass" }, { posture: "one_click", authVerdict: "pass" }],
    });
  });

  it("is on by default, and that is what reaches onChoose", async () => {
    const { writes, el, person } = await render([msg("a", "one@x.example", "INBOX")], "a");
    const sheet = within(el);
    expect(sheet.getByRole("switch", { name: messages.screening.ruleToggleAria }).getAttribute("aria-checked")).toBe("true");
    expect(sheet.getByRole("switch", { name: messages.screening.retroToggleAria }).getAttribute("aria-checked")).toBe("true");
    await click(sheet.getByRole("radio", { name: /^News/ }));
    await afterDecision();
    expect(rulesWritten(writes)).toEqual([expect.objectContaining({ kind: "sender", match: person, destination: "ohmail/News", applyRetro: true })]);
    await expectLetterMenuDecision("screened", "Screened", {
      letters: [{ posture: "one_click", authVerdict: "pass" }],
    }, "Screen out and unsubscribe");
    await expectLetterMenuDecision("screened", "Screened", { autoUnsubscribe: false });
    await expectLetterMenuDecision("spam", "Spam", { autoUnsubscribe: false });
    await expectLetterMenuDecision("screened", "Screened", {
      letters: [{ posture: null, authVerdict: null }, { posture: "no_header", authVerdict: null }],
    }, "Continue");
  });

  it("turning it off is the explicit non-default, and it travels", async () => {
    const { writes, el, person } = await render([msg("a", "one@x.example", "INBOX")], "a");
    await click(ruleControl(el));
    expect(ruleControl(el)!.getAttribute("aria-checked")).toBe("false");

    await click(option(el, /^News/));
    await afterDecision();
    expect(rulesWritten(writes)).toEqual([]);
    expect(writes).toContainEqual(expect.objectContaining({ path: "/api/messages/a/move", body: expect.objectContaining({ folder: "ohmail/News" }) }));
  });

  it("is not offered for a WAITING sender — the decide promotes the rule regardless", async () => {
    // A switch that cannot change the outcome is a control that lies about having one.
    const { el } = await render([msg("a", "one@x.example", "ohmail/Screener")], "a");
    expect(ruleControl(el)).toBeNull();
  });

  /**
   * THE HONEST NEGATIVE, AT THE COMPONENT. A rule to a reject folder is now genuinely created
   * from past the gate — and it still opens no disclosure, because it arms nothing:
   * `onScreenOut` is reached only from `decide`. Wiring the confirm to "a rule is being made"
   * rather than to `ScreeningPlan.unsubscribes` makes this go red.
   */
  it("screening past the gate to a reject folder commits straight away, rule and all", async () => {
    const { writes, el, person } = await render([msg("a", "spam@bulk.example", "INBOX")], "a");
    await click(option(el, /^Screen out/));
    expect(screen.queryByRole("dialog", { name: /^Screening for / })).toBeNull();
    await afterDecision();
    expect(rulesWritten(writes)).toEqual([expect.objectContaining({ kind: "sender", match: person, destination: "ohmail/Screened", applyRetro: true })]);
  });
});

describe("the footer keeps telling the truth", () => {
  it("a contact chip's sheet moves no letter, so it promises none moves", async () => {
    const { el } = await render([
      msg("a", "one@x.example", "INBOX"),
      msg("b", "two@x.example", "INBOX"),
    ], "a", { address: "two@x.example" });
    const foot = () => option(el, /^News/).getAttribute("aria-description")!;
    expect(foot()).not.toContain("This message moves there now");
    expect(foot()).toContain("Future mail from two@x.example files there too");
    await click(retroControl(el));
    expect(foot()).toContain("Mail already here stays where it is");
  });

  it("promises a rule for the whole domain only when the domain is waiting", async () => {
    const { el } = await render([
      msg("a", "one@x.example", "ohmail/Screener"),
      msg("b", "two@x.example", "ohmail/Screener"),
    ], "a");
    await click(domain(el));
    expect(option(el, /^News/).getAttribute("aria-description")).toContain("anyone at x.example");
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
    const foot = () => option(el, /^News/).getAttribute("aria-description")!;
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

    await click(ruleControl(el));
    expect(foot()).toContain("It makes no rule, so future mail is unchanged.");
  });

  /**
   * THE OPT-OUT IS STILL AN OPT-OUT OF BOTH HALVES. Turning the rule off must stop the
   * retroactive apply too — `planScreeningChange` reports `retro: false` for every plan that
   * writes no rule — and the footer must not keep a sentence about mail already here.
   */
  it("the opt-out withdraws the retroactive claim as well, not only the future one", async () => {
    const { el } = await render([msg("a", "one@x.example", "INBOX")], "a");
    await click(ruleControl(el));
    const foot = option(el, /^News/).getAttribute("aria-description")!;
    expect(foot).not.toContain("already filed for you");
    expect(foot).not.toContain("revoke the rule");
    // …and the past-mail row goes with it: no rule, nothing for it to be a question about.
    expect(retroControl(el)).toBeNull();
  });

  it("follows the SCOPE as well — a domain rule is not described as one address's", async () => {
    const { el } = await render([
      msg("a", "one@x.example", "INBOX"),
      msg("b", "two@x.example", "INBOX"),
    ], "a");
    await click(domain(el));
    expect(option(el, /^News/).getAttribute("aria-description"))
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
    const label = ruleControl(el)!.closest("label")!;
    expect(label.textContent, "the visible rule label promises only the future")
      .toBe(messages.screening.cardFuture);
    const note = retroControl(el)!.getAttribute("aria-description")!;
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
    const { writes, el, person } = await render([
      msg("a", "one@x.example", "INBOX"),
      msg("b", "one@x.example", "ohmail/News"),
    ], "a");
    const retro = retroControl(el)!;
    expect(retro, "the past-mail option does not exist").toBeTruthy();
    expect(retro.getAttribute("role")).toBe("switch");
    expect(retro.getAttribute("aria-checked"), "the default is ON").toBe("true");

    await click(retro);
    expect(retroControl(el)!.getAttribute("aria-checked")).toBe("false");
    // The rule is untouched — that is the whole point of the second control.
    expect(ruleControl(el)!.getAttribute("aria-checked")).toBe("true");

    const foot = option(el, /^News/).getAttribute("aria-description")!;
    expect(foot).toContain("files there too");
    // The needle here was `not.toContain("already")` — the absence of a WORD, which the off-state
    // sentence satisfied while it read "This moves the mail that is here" over a switch that had
    // just said not to. 0.19.1 asks for the claim instead: the retroactive half is withdrawn AND
    // the sentence that replaces it states what the switch decided.
    expect(foot, "the past-mail claim must go with the option").not.toContain("applies the rule");
    expect(foot, "…and the off state says what it does").toContain("The rest of their mail here stays where it is");
    expect(foot, "the letter pressed on moves, and the sheet says so").toContain("This message moves there now");
    expect(foot, "a promise the press breaks").not.toContain("Mail already here stays where it is");

    await click(option(el, /^News/));
    await afterDecision();
    expect(rulesWritten(writes)).toEqual([expect.objectContaining({ kind: "sender", match: person, destination: "ohmail/News", applyRetro: false })]);
  });

  it("the answer reaches the plan through the shell, not only through onChoose", async () => {
    await withMountedSender(async ({ sheet, writes, sender }) => {
      await clickMounted(sheet.getByRole("switch", { name: messages.screening.retroToggleAria }));
      await clickMounted(sheet.getByRole("radio", { name: /^News/ }));
      expect(writes.filter(({ path }) => path.startsWith("/api/rules"))).toEqual([]);
      await tick(UNDO_MS + 500);
      expect(writes.filter(({ path }) => path.startsWith("/api/rules"))).toEqual([{
        method: "POST", path: "/api/rules",
        body: expect.objectContaining({ kind: "sender", match: sender, destination: "ohmail/News", applyRetro: false }),
      }]);
    });
    for (const applyRetro of [false, true]) {
      await withMountedSender(async ({ sheet, writes, sender }) => {
        await clickMounted(sheet.getByRole("menuitem", { name: messages.screening.cardSubject }));
        const editor = within(document.body).getByRole("dialog", {
          name: messages.screening.subjectAria.replace("{who}", sender),
        });
        await clickMounted(within(editor).getByRole("radio", { name: messages.screener.pileReads }));
        const retro = within(editor).getByRole("switch", { name: messages.screening.retroToggleAria });
        expect(retro.getAttribute("aria-checked")).toBe("true");
        if (!applyRetro) await clickMounted(retro);
        expect(retro.getAttribute("aria-checked")).toBe(String(applyRetro));
        expect(writes).toEqual([]);
        await clickMounted(within(editor).getByRole("button", {
          name: messages.screening.subjectMakeRule,
        }));
        await tick(500);
        expect(writes.filter(({ path }) => path.startsWith("/api/rules"))).toEqual([{
          method: "POST", path: "/api/rules",
          body: expect.objectContaining({
            kind: "sender", match: sender, subjectContains: "A note from Ada", destination: "ohmail/News", applyRetro,
          }),
        }]);
      });
    }
  }, 30_000);

  it("is offered only while the rule is on — it is subordinate to it, not a peer", async () => {
    const { el } = await render([msg("a", "one@x.example", "INBOX")], "a");
    expect(retroControl(el)).toBeTruthy();
    await click(ruleControl(el));
    expect(retroControl(el), "no rule, nothing to apply to past mail").toBeNull();
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
    const note = retroControl(el)!.getAttribute("aria-description")!;
    expect(note).toContain("2 messages");
    expect(note, "the count is what has SYNCED, and the sheet says so").toContain("synced");
    expect(note, "a count must never be phrased as a promise that they all move")
      .not.toContain("move");
  });
});
