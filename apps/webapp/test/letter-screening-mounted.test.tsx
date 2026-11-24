/** @vitest-environment jsdom */
import de from "../messages/de.json";
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { IndexedDbMirrorStore } from "@ohmail/client-engine";
import type { EngineMessage, Folder, MessageBodyRecord, RuleEntity } from "@ohmail/wire";
import messages from "../messages/en.json";
import {
  ACCOUNT, ISO, act, installScreeningWeb, mountScreeningWeb, syncScreeningWeb,
  teardownScreeningWeb, tick, warmScreeningWeb,
} from "./fixtures/screening-web";

const MESSAGE_ID = "held-alert";
const MAILBOX_ID = "mb_1";
const DOMAIN = "sender.example";
const SENDER = `alerts@${DOMAIN}`;
const SUBJECT = "[Reports] Delivery requires attention";

const heldMessage: EngineMessage = {
  id: MESSAGE_ID,
  accountId: ACCOUNT,
  mailboxId: MAILBOX_ID,
  threadId: null,
  messageIdHeader: null,
  subject: SUBJECT,
  from: { name: "Delivery reports", address: SENDER },
  to: [],
  cc: [],
  date: ISO,
  folder: "ohmail/Screener",
  snippet: "A report from this sender.",
  unread: true,
  hasAttachments: false,
  attachmentCount: 0,
  sensitivity: {
    sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false,
  },
  triage: null,
  labels: [],
  remoteContent: "none",
  updatedAt: ISO,
};

beforeAll(warmScreeningWeb, 60_000);
afterEach(teardownScreeningWeb);

async function mountSender({
  ruleAnswer, rules = [], moveAnswer, extra = [], stayed = [], organizerState, locale = "en", own = false, oneClickId, threadId = null,
}: {
  ruleAnswer?: () => Promise<Response>;
  rules?: readonly RuleEntity[];
  moveAnswer?: () => Response;
  extra?: EngineMessage[];
  stayed?: Array<{ id: string; why: string }>;
  organizerState?: "held" | "stopped" | "returned";
  locale?: "en" | "de";
  own?: boolean | "failed";
  oneClickId?: string;
  threadId?: string | null;
} = {}) {
  const rows: EngineMessage[] = [{
    ...heldMessage, threadId, folder: "INBOX", subject: "Plain letter",
    from: own ? { name: "Delivery reports", address: "inbox@example.invalid" } : heldMessage.from,
    ...(own === "failed" ? { authVerdict: "fail" } : {}),
  }, ...extra];

  let rosterReads = 0;
  const writes: Array<{ method: string; path: string; body: unknown; key: string | null }> = [];
  const { sessionCalls } = installScreeningWeb(`#/ohbox/m/${MESSAGE_ID}`, (path, searchParams, method, init) => {
    if (method === "GET" && path === "/api/mailboxes") {
      rosterReads += 1;
      return Promise.resolve(Response.json({ items: [{
        id: MAILBOX_ID,
        address: "inbox@example.invalid",
        status: "connected",
        createdAt: ISO,
        lastSyncAt: ISO,
        initialImportCompletedAt: ISO,
        organizerRole: organizerState ? "reader" : "organizer",
        organizerState: organizerState === "returned" ? null : organizerState,
        organizerReleasedAt: organizerState === "returned" ? ISO : null,
        organizedBy: organizerState && organizerState !== "returned" ? { kind: "local", name: "Office computer", since: ISO } : null,
        organizerChecked: true,
        organizeConsentedAt: ISO,
      }] }));
    }
    if (oneClickId && method === "GET" && path === `/api/messages/${oneClickId}/body`) {
      return Promise.resolve(Response.json({ text: "A newsletter with one-click unsubscribe.", unsubscribe: "one_click" }));
    }
    if (method === "GET" && path === "/api/screener/stayed") {
      return Promise.resolve(Response.json({ stayed }));
    }
    if (method === "GET" && path === "/api/sync") {
      if (searchParams.get("types") === "rule") return syncScreeningWeb(rules.map((rule, index) => ({
        type: "rule", op: "create", seq: index + 1, id: rule.id, updatedAt: ISO, entity: rule,
      })), rules.length);
      return syncScreeningWeb(rows.map((row, index) => ({
        type: "message", op: "create", seq: index + rules.length + 1, id: row.id, updatedAt: ISO, entity: row,
      })), rows.length + rules.length);
    }
    if (method !== "GET" && /^\/api\/(rules|messages|screener|consent)(\/|$)/.test(path)) {
      const headers = new Headers(init?.headers);
      writes.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null, key: headers.get("idempotency-key") });
      if (path.startsWith("/api/rules") && ruleAnswer) return ruleAnswer();
      if (method === "POST" && path.endsWith("/move") && path.startsWith("/api/messages/") && moveAnswer)
        return Promise.resolve(moveAnswer());
      return Promise.resolve(Response.json({ error: { code: "unexpected_write" } }, { status: 500 }));
    }
    return undefined;
  });

  if (oneClickId) {
    // A previously read body names the one-click posture of this held message.
    vi.useRealTimers();
    const mirror = new IndexedDbMirrorStore({ owner: ACCOUNT });
    try {
      await mirror.load();
      const body: MessageBodyRecord = {
        messageId: oneClickId, state: "ready", text: "A newsletter with one-click unsubscribe.",
        html: null, unsubscribe: "one_click",
      };
      await mirror.putLocal("message_body", oneClickId, body);
    } finally {
      mirror.close();
      vi.useFakeTimers();
      vi.setSystemTime(new Date(ISO));
    }
  }
  const shell = await mountScreeningWeb(locale);
  await tick(4000);
  expect(sessionCalls()).toBeGreaterThan(0);
  expect(rosterReads).toBeGreaterThan(0);
  await click(within(shell).getByRole("button", { name: own ? /^(You|Du) / : /^Delivery reports / }));
  const words = locale === "en" ? messages : de;
  const dialog = () => within(document.body).getByRole("dialog", { name: new RegExp(words.screening.aria.split("{sender}")[0]!) });
  return { sheet: dialog(), dialog, writes };
}

const click = (control: HTMLElement) => act(() => { fireEvent.click(control); });

const ruleResponse = (retro: boolean, subject = SUBJECT) => Response.json({
  id: "rule-held-alert",
  kind: "sender",
  match: SENDER,
  destination: "ohmail/News",
  subjectContains: subject,
  bodyContains: null,
  enabled: true,
  priority: 0,
  provenance: "manual",
  stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: ISO,
  updatedAt: ISO,
  ...(retro ? { retro: { requestedAt: ISO, doneAt: null, from: null } } : {}),
}, { status: 201, headers: { "X-Sync-Seq": "2" } });

const standingSubject: RuleEntity = {
  id: "standing-subject",
  kind: "sender",
  match: SENDER,
  destination: "ohmail/News",
  subjectContains: SUBJECT,
  bodyContains: null,
  enabled: true,
  priority: 0,
  provenance: "manual",
  stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: ISO,
  updatedAt: ISO,
};

it("adds a whole-sender rule from an Ohbox letter while keeping the narrower rule", async () => {
  const { dialog, writes } = await mountSender({
    ruleAnswer: async () => ruleResponse(true), rules: [standingSubject], moveAnswer: () => Response.json({}),
    extra: [{ ...heldMessage, id: "kept-narrow", folder: "ohmail/News" }],
  });
  await click(within(dialog()).getByRole("radio", { name: /Receipts/ }));
  const choice = within(dialog()).getByRole("radio", { name: /Keep/ });
  await click(choice);
  await click(within(dialog()).getByRole("button", { name: /File to Receipts/ }));
  await tick(12_000);
  expect(writes.filter((write) => write.path.startsWith("/api/rules"))).toEqual([{
    method: "POST", path: "/api/rules",
    body: expect.objectContaining({ kind: "sender", match: SENDER, destination: "ohmail/Receipts" }),
    key: expect.any(String),
  }]);
});

it("retargets only the broad rule and cancels the first conflict choice without writes", async () => {
  const broad = { ...standingSubject, id: "plain-sender-rule", subjectContains: null };
  const { dialog, writes } = await mountSender({
    ruleAnswer: async () => ruleResponse(true), rules: [standingSubject, broad], moveAnswer: () => Response.json({}),
    extra: [{ ...heldMessage, id: "kept-narrow", folder: "ohmail/News" }],
  });
  const target = () => within(dialog()).getByRole("radio", { name: /Receipts/ });
  await click(target());
  await act(() => { fireEvent.keyDown(within(dialog()).getByRole("radio", { name: /Keep/ }), { key: "Escape" }); });
  expect(document.activeElement).toBe(target());
  expect(writes).toEqual([]);
  await click(target());
  await click(within(dialog()).getByRole("radio", { name: /Keep/ }));
  await click(within(dialog()).getByRole("button", { name: /File to Receipts/ }));
  await tick(12_000);
  expect(writes.filter((write) => write.path.startsWith("/api/rules"))).toEqual([{
    method: "PATCH", path: "/api/rules/plain-sender-rule",
    body: expect.objectContaining({ destination: "ohmail/Receipts", applyRetro: true }),
    key: expect.any(String),
  }]);
});

it("shows why a message stayed in its own folder after the rule finished", async () => {
  const broad = {
    ...standingSubject, id: "plain-sender-rule", subjectContains: null, destination: "INBOX" as const,
    retro: { requestedAt: ISO, doneAt: ISO },
  };
  const { sheet, writes } = await mountSender({
    rules: [broad], moveAnswer: () => Response.json({}),
    extra: [{ ...heldMessage, id: "stayed-project", folder: "Projects" as Folder }],
    stayed: [{ id: "stayed-project", why: "filed-elsewhere" }],
  });
  await tick(100);
  expect(within(sheet).getByText("1 stays in Projects: filed in another mail app.")).toBeTruthy();
  expect(writes).toEqual([]);
  await click(within(sheet).getByRole("button", { name: /Move it too/ }));
  await tick(250);
  expect(writes).toEqual([{
    method: "POST", path: "/api/messages/stayed-project/move",
    body: expect.objectContaining({ folder: "INBOX" }), key: expect.any(String),
  }]);
});

it.each(["held", "stopped"] as const)("describes the actual organizer when its lease is %s", async (lease) => {
  const { sheet, writes } = await mountSender({ rules: [standingSubject], organizerState: lease });
  const note = lease === "held" ? messages.screening.orgPending.replace("{name}", "Office computer") : messages.screening.orgNobody;
  expect(within(sheet).getByText(note)).toBeTruthy();
  expect(writes).toEqual([]);
});


it.each(["en", "de"] as const)("the sender and subject sheets tell the truth after a hand-back (%s)", async (locale) => {
  const words = locale === "en" ? messages : de;
  const { sheet, writes } = await mountSender({ organizerState: "returned", locale });
  expect(within(sheet).getByText(words.screening.orgNobody)).toBeTruthy();
  expect(within(sheet).getByRole("radio", { name: words.screener.pileReads }).getAttribute("aria-description"))
    .not.toBe(words.screening.footWillRuleRetro.replace("{sender}", SENDER));
  await click(within(sheet).getByRole("menuitem", { name: words.screening.cardSubject }));
  const editor = within(document.body).getByRole("dialog", { name: words.screening.subjectAria.replace("{who}", SENDER) });
  expect(within(editor).getByText(words.screening.subjectOrgNobody)).toBeTruthy();
  await click(within(editor).getByRole("radio", { name: words.screener.pileReads }));
  expect(within(editor).getByText(words.screening.subjectOrgNobody)).toBeTruthy();
  expect(within(editor).queryByText(/ohmail applies the rule|ohmail wendet die Regel/)).toBeNull();
  await click(within(editor).getByRole("button", {
    name: words.screening.subjectMakeRule,
  }));
  await tick(250);
  expect(writes).toEqual([]);
});

it("an organizing mailbox previews and writes the exact subject rule for the current letter", async () => {
  const { sheet, writes } = await mountSender({ ruleAnswer: async () => ruleResponse(true, "Plain letter") });
  expect(within(sheet).queryByText(messages.screening.orgNobody)).toBeNull();
  expect(within(sheet).getByRole("radio", { name: messages.screener.pileReads }).getAttribute("aria-description"))
    .toBe(messages.screening.footWillRuleRetro.replace("{sender}", SENDER));
  await click(within(sheet).getByRole("menuitem", { name: messages.screening.cardSubject }));
  const editor = within(document.body).getByRole("dialog", { name: messages.screening.subjectAria.replace("{who}", SENDER) });
  await click(within(editor).getByRole("radio", { name: messages.screener.pileReads }));
  expect(within(editor).getByRole("radio", { name: messages.screener.pileReads, checked: true })).toBeTruthy();
  expect(within(editor).getByRole("switch", { name: messages.screening.retroToggleAria, checked: true })).toBeTruthy();
  expect(within(editor).getByText("1 of 1 match")).toBeTruthy();
  expect(within(editor).queryByText(/ohmail applies the rule/)).toBeNull();
  expect(within(editor).queryByText(messages.screening.subjectOrgNobody)).toBeNull();
  expect(writes).toEqual([]);
  await click(within(editor).getByRole("button", {
    name: messages.screening.subjectMakeRule,
  }));
  await tick(250);
  expect(writes).toContainEqual({
    method: "POST", path: "/api/rules",
    body: expect.objectContaining({ match: SENDER, subjectContains: "Plain letter", destination: "ohmail/News" }),
    key: expect.any(String),
  });
});

it("shows the focused older letter's exact subject in the sender's rule dialog", async () => {
  const threadId = "delivery-conversation";
  const newer = {
    ...heldMessage, id: "newer-report", threadId, folder: "INBOX" as const,
    date: new Date(Date.parse(ISO) + 60_000).toISOString(),
    from: { ...heldMessage.from, name: "Newer delivery reports" },
    subject: "The revised delivery date",
  };
  const { sheet, writes } = await mountSender({ threadId, extra: [newer] });
  expect(within(document.body).getByRole("button", { name: /^Newer delivery reports / })).toBeTruthy();
  await click(within(sheet).getByRole("menuitem", { name: messages.screening.cardSubject }));
  const dialog = within(document.body).getByRole("dialog", {
    name: messages.screening.subjectAria.replace("{who}", SENDER),
  });
  expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: messages.screening.subjectEditAria }).value)
    .toBe("Plain letter");
  expect(writes).toEqual([]);
});

it("our own address offers onward links and no destination or rule editor", async () => {
  const { sheet, writes } = await mountSender({ own: true });
  expect(within(sheet).getByText(messages.screening.toastOwnAddress)).toBeTruthy();
  expect(within(sheet).queryByRole("radio")).toBeNull();
  expect(within(sheet).queryByRole("menuitem", { name: messages.screening.cardSubject })).toBeNull();
  expect(within(sheet).getByRole("menuitem", { name: messages.message.contactAllMail })).toBeTruthy();
  expect(within(sheet).getByRole("button", { name: /See all 1 message/ })).toBeTruthy();
  expect(writes).toEqual([]);
});

it("an own-address claim that failed its provider check offers no filing", async () => {
  const { sheet, writes } = await mountSender({ own: "failed" });
  expect(within(sheet).getByText(messages.screener.senderCheck.failed.replace("{address}", "inbox@example.invalid"))).toBeTruthy();
  expect(within(sheet).queryByText(messages.screening.toastOwnAddress)).toBeNull();
  expect(within(sheet).queryByRole("radio")).toBeNull();
  expect(writes).toEqual([]);
});

it("marks the rule’s destination even if it has no letters there yet", async () => {
  const broad = { ...standingSubject, subjectContains: null };
  const { sheet, writes } = await mountSender({ rules: [broad] });
  expect(within(sheet).getByRole("radio", { name: /News/, checked: true })).toBeTruthy();
  const rules = within(sheet).getByRole("group", { name: messages.screening.rulesHead });
  expect(within(rules).getByText(messages.screening.ruleAll).parentElement?.textContent).toMatch(/^News.*All their mail.*0 messages$/);
  expect(writes).toEqual([]);
});

it("retargets the domain when the person confirms everyone at the sender's domain", async () => {
  const domain = { ...standingSubject, id: "standing-domain", kind: "domain" as const, match: DOMAIN, subjectContains: null, priority: 30 };
  const { dialog, writes } = await mountSender({
    rules: [domain], ruleAnswer: async () => Response.json({
      ...domain, destination: "ohmail/Receipts", retro: { requestedAt: ISO, doneAt: null },
    }), moveAnswer: () => Response.json({}),
  });
  await click(within(dialog()).getByRole("radio", { name: /Receipts/ }));
  await click(within(within(dialog()).getByRole("radiogroup", { name: messages.screening.resolveChoiceAria })).getByRole("radio", { name: /Everyone at/ }));
  await click(within(dialog()).getByRole("button", { name: /File to Receipts/ }));
  await tick(12_000);
  expect(writes.filter((write) => write.path.startsWith("/api/rules"))).toEqual([{
    method: "PATCH", path: "/api/rules/standing-domain",
    body: expect.objectContaining({ destination: "ohmail/Receipts" }),
    key: expect.any(String),
  }]);
});

it("names the wider unsubscribe scope before a domain Yes", async () => {
  const covering = {
    ...standingSubject, id: "covering-domain", kind: "domain" as const,
    match: DOMAIN, subjectContains: null, priority: 5, destination: "ohmail/News" as const,
  };
  const another = {
    ...heldMessage, id: "other-domain-letter", authVerdict: "pass" as const,
    from: { name: "Another sender", address: ["list", DOMAIN].join("@") },
  };
  const { dialog, writes } = await mountSender({ rules: [covering], extra: [another], oneClickId: another.id });
  await click(within(dialog()).getByRole("radio", { name: /Spam/ }));
  await click(within(dialog()).getByRole("radio", { name: /Everyone at.*Spam/ }));
  const disclosure = within(dialog()).getByText(/Confirming sends one-click unsubscribe requests/);
  expect(disclosure.textContent).toContain(`1 sender at ${DOMAIN}`);
  expect(disclosure.textContent).toContain("rule for the whole domain");
  expect(disclosure.textContent).toContain("there is no undo");
  expect(writes).toEqual([]);
  await click(within(dialog()).getByRole("button", { name: messages.screening.unsubCommit }));
  await tick(12_000);
  const decisions = writes.filter(({ path, method }) => method === "POST" && path.startsWith("/api/screener/"));
  expect(decisions[0]?.body).toMatchObject({ scope: "domain", unsubscribeIds: [another.id] });
});
