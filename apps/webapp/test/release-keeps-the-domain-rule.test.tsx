/** @vitest-environment jsdom */
import type { EngineMessage, Folder, RuleEntity as RuleDTO, SyncResponse } from "@ohmail/wire";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import * as React from "react";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  consentIndex,
  decidedDestination,
  type SyncChange,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { COMMIT_MS, UNDO_MS } from "@ohmail/app-logic/screener/screener-state";
import {
  ACCOUNT, ISO, act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

/**
 * A PRESS ABOUT ONE SENDER NEVER CHANGES HOW ANOTHER SENDER'S MAIL IS FILED. Releasing a sender a
 * DOMAIN rule held retargeted that rule, which released everyone at the domain. Each of the three
 * presses (release, back to Waiting, the pinned rescue) goes through the mounted Web entry with
 * both domain and sender rules. The cases read the actual requests, resulting rules, and the
 * sentence each catalogue renders.
 */

const h = React.createElement;
const DOMAIN = "lists.example.test";
const PRESSED = `news@${DOMAIN}`;
const OTHER = `offers@${DOMAIN}`;
const SCREENED: Folder = "ohmail/Screened";
const SPAM: Folder = "ohmail/Quarantine";


function msg(id: string, from: string, folder: Folder, hour = 9): EngineMessage {
  return {
    id, accountId: ACCOUNT, mailboxId: "mb_1", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: `${ISO.slice(0, 10)}T0${hour}:00:00.000Z`, folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
  };
}

function rule(id: string, kind: "sender" | "domain", match: string, destination: Folder, priority = 0): RuleDTO {
  return {
    id, kind, match, destination, priority, provenance: "promoted", enabled: true,
    subjectContains: null, bodyContains: null,
    stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
  } as RuleDTO;
}

async function mirror(messages: EngineMessage[], rules: RuleDTO[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  let seq = 0;
  await store.load();
  await store.applyChanges([
    ...messages.map((entity): SyncChange => ({
      type: "message", op: "create", id: entity.id, seq: ++seq, updatedAt: ISO, entity,
    })),
    ...rules.map((entity): SyncChange => ({
      type: "rule", op: "create", id: entity.id, seq: ++seq, updatedAt: ISO, entity,
    })),
  ]);
  return store;
}

type ReleaseRequest = { method: string; path: string; body?: unknown };

async function mount(
  messages: EngineMessage[],
  rules: RuleDTO[],
  locale: "en" | "de" = "en",
  place: "screener" | "reads" = "screener",
) {
  const copy = (locale === "de" ? de : en).screener;
  const mail = new Map(messages.map((item) => [item.id, item]));
  const standing = new Map(rules.map((item) => [item.id, item]));
  const changes: SyncResponse["changes"] = { creates: [], updates: [], moves: [], deletes: [] };
  const writes: ReleaseRequest[] = [];
  let sequence = 0;
  const note = (
    bucket: keyof SyncResponse["changes"],
    type: "rule" | "message",
    id: string,
    entity: RuleDTO | EngineMessage | null,
  ) => {
    const op = ({ creates: "create", updates: "update", moves: "move", deletes: "delete" } as const)[bucket];
    const seq = ++sequence;
    changes[bucket].push({
      type, op, id, seq, updatedAt: ISO, entity,
      ...(op === "move" && entity && "folder" in entity ? { move: { from: null, to: entity.folder } } : {}),
    });
    return seq;
  };
  for (const item of messages) note("creates", "message", item.id, item);
  for (const item of rules) note("creates", "rule", item.id, item);
  const json = (body: unknown, status = 200, seq?: number) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(seq === undefined ? {} : { "x-sync-seq": String(seq) }) },
  });
  scriptSync(() => json({ changes, cursor: String(sequence), hasMore: false, serverTime: ISO } satisfies SyncResponse));

  const fetchForAccount = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const method = init?.method ?? "GET";
    if (method === "GET" && path === "/api/mailboxes") {
      return json({ items: [{
        id: "mb_1", address: ["mailbox", "example.invalid"].join("@"), status: "connected",
        organizerRole: "organizer", initialImportCompletedAt: ISO, organizeConsentedAt: ISO,
        lastSyncAt: ISO, createdAt: ISO,
      }] });
    }
    if (method === "GET" || !/^\/api\/(rules|messages|screener)(?:\/|$)/.test(path)) {
      return fetchForAccount(input, init);
    }
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    writes.push({ method, path, ...(body === undefined ? {} : { body }) });
    if (method === "POST" && path === "/api/rules") {
      const created = rule("r-new", body.kind, body.match, body.destination, body.priority);
      standing.set(created.id, created);
      return json(created, 201, note("creates", "rule", created.id, created));
    }
    const ruleId = /^\/api\/rules\/([^/]+)$/.exec(path)?.[1];
    if (ruleId && method === "PATCH") {
      const previous = standing.get(ruleId)!;
      const updated = { ...previous, destination: body.destination };
      standing.set(ruleId, updated);
      return json(updated, 200, note("updates", "rule", ruleId, updated));
    }
    if (ruleId && method === "DELETE") {
      standing.delete(ruleId);
      return new Response(null, { status: 204, headers: { "x-sync-seq": String(note("deletes", "rule", ruleId, null)) } });
    }
    const moveId = /^\/api\/messages\/([^/]+)\/move$/.exec(path)?.[1];
    if (moveId && method === "POST") {
      const moved = { ...mail.get(moveId)!, folder: body.folder };
      mail.set(moveId, moved);
      return json(moved, 200, note("moves", "message", moveId, moved));
    }
    const decideId = /^\/api\/screener\/([^/]+)$/.exec(path)?.[1];
    if (decideId && method === "POST") {
      const sender = mail.get(decideId)!.from.address;
      const scope = body.scope === "domain" ? "domain" : "sender";
      const promoted = rule("r-promoted", scope, scope === "domain" ? DOMAIN : sender, body.dest);
      standing.set(promoted.id, promoted);
      note("creates", "rule", promoted.id, promoted);
      for (const item of mail.values()) {
        if (item.folder !== "ohmail/Screener" || item.from.address !== sender) continue;
        const moved = { ...item, folder: body.dest };
        mail.set(item.id, moved);
        note("moves", "message", item.id, moved);
      }
      return json({
        messageId: decideId, appliedFolder: body.dest, createdRuleId: promoted.id, createdRule: promoted,
      }, 200, sequence);
    }
    throw new Error(`Unexpected release request: ${method} ${path}`);
  };

  window.location.hash = `#/${place}`;
  const shell = await mountCloudShell(locale === "en" ? undefined : (child) => h(NextIntlClientProvider, {
    locale, messages: de, timeZone: "UTC", now: new Date(ISO), children: child,
  }));
  await tick(3000);
  const frame = within(shell);
  const open = async (id: string) => {
    const list = frame.getByRole("listbox", { name: copy.title });
    const row = within(list).getAllByRole("option").find((option) => option.dataset.id === id);
    expect(row, "the sender is in the chosen Screener section").toBeTruthy();
    await click(row!);
  };
  const segment = (label: string) => {
    const group = frame.getByRole("group", { name: copy.segAria });
    return click(within(group).getByRole("button", {
      name: (name) => name === label || name.startsWith(`${label} `),
    }));
  };
  const press = (label: string) =>
    click(within(frame.getByRole("toolbar", { name: copy.place.panel })).getByRole("button", { name: label }));
  return { shell, frame, open, segment, press, writes, standing, copy };
}

async function click(button: HTMLElement): Promise<void> {
  await act(async () => { button.click(); });
  await tick(50);
}

const commit = () => tick(COMMIT_MS + UNDO_MS + 100);

/** A catalogue sentence with its holes filled — what the reader is shown, from the file they are shown it from. */
const fill = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);

function lastToast(): string {
  const report = document.querySelector('.fr-report [role="status"]:not([data-leaving])');
  expect(report, "the release report is shown").toBeTruthy();
  const sentence = report!.cloneNode(true) as HTMLElement;
  sentence.querySelectorAll("button, kbd").forEach((node) => node.remove());
  return sentence.textContent ?? "";
}
const ruleWrites = (writes: ReleaseRequest[]) => writes.filter(({ path }) => path.startsWith("/api/rules"));
const rulesTouched = (writes: ReleaseRequest[], id: string) =>
  writes.filter(({ path }) => path === `/api/rules/${id}`);
const moves = (writes: ReleaseRequest[]) => writes.filter(({ path }) => path.endsWith("/move"));
const createAddressRule = {
  method: "POST", path: "/api/rules",
  body: { kind: "sender", match: PRESSED, destination: "INBOX", applyRetro: true },
};
const retarget = (id: string) => ({ method: "PATCH", path: `/api/rules/${id}`, body: { destination: "INBOX" } });
const move = (id: string, folder: Folder, pressRule = false) => ({
  method: "POST", path: `/api/messages/${id}/move`, body: { folder, ...(pressRule ? { pressRule: true } : {}) },
});
const decided = (standing: Map<string, RuleDTO>, address: string) =>
  decidedDestination(consentIndex([...standing.values()]), address);

beforeAll(warmCloudShell);
beforeEach(() => {
  window.localStorage.clear();
  installConfirmEnv();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  Element.prototype.animate ??= (() => ({
    cancel() {}, finished: Promise.resolve(),
  })) as unknown as Element["animate"];
});

afterEach(teardownConfirmEnv);

const screenedMail = () => [msg("p1", PRESSED, SCREENED), msg("o1", OTHER, SCREENED, 8)];
const spamMail = () => [msg("p1", PRESSED, SPAM), msg("o1", OTHER, SPAM, 8)];

describe("Allow on a screened-out sender", () => {
  it("held by a DOMAIN rule: an address rule for them alone, the domain rule untouched, and the sentence names it", async () => {
    const s = await mount(screenedMail(), [rule("r-dom", "domain", DOMAIN, SCREENED)]);
    await s.segment(s.copy.segScreened);
    await s.open("p1");
    await s.press(s.copy.pileOhbox);
    expect(lastToast()).toBe(fill(en.screener.toastReleasedAddress, {
      dest: en.screener.pileOhbox, count: "1", sender: PRESSED, domain: DOMAIN,
    }));
    await commit();

    expect(ruleWrites(s.writes)).toEqual([createAddressRule]);
    expect(rulesTouched(s.writes, "r-dom"), "the domain rule was rewritten by one sender's press").toEqual([]);
    expect(moves(s.writes)).toEqual([move("p1", "INBOX", true)]);
    expect(decided(s.standing, PRESSED)).toBe("INBOX");
    expect(decided(s.standing, OTHER), "another sender at the domain was released").toBe(SCREENED);
  });

  it("held by their OWN rule: that rule is retargeted, nothing is created", async () => {
    const s = await mount(screenedMail(), [
      rule("r-own", "sender", PRESSED, SCREENED), rule("r-other", "sender", OTHER, SCREENED),
    ]);
    await s.segment(s.copy.segScreened);
    await s.open("p1");
    await s.press(s.copy.pileOhbox);
    expect(lastToast()).toBe(fill(en.screener.toastReleasedRuled, {
      dest: en.screener.pileOhbox, count: "1", sender: PRESSED,
    }));
    await commit();

    expect(ruleWrites(s.writes)).toEqual([retarget("r-own")]);
    expect(moves(s.writes)).toEqual([move("p1", "INBOX", true)]);
    expect(decided(s.standing, PRESSED)).toBe("INBOX");
    expect(decided(s.standing, OTHER)).toBe(SCREENED);
  });

  it("a domain rule the address rule cannot outrank (a higher priority) is said, and nothing is sent", async () => {
    const s = await mount(screenedMail(), [rule("r-dom", "domain", DOMAIN, SCREENED, 5)]);
    await s.segment(s.copy.segScreened);
    await s.open("p1");
    await s.press(s.copy.pileOhbox);
    expect(lastToast()).toBe(fill(en.screener.toastReleaseRuleStands, {
      sender: PRESSED, place: en.screener.segScreened, domain: DOMAIN,
    }));
    await commit();
    expect(s.writes, "a press that cannot win wrote or moved something").toEqual([]);
  });

  it("the German catalogue says the same thing", async () => {
    const s = await mount(screenedMail(), [rule("r-dom", "domain", DOMAIN, SCREENED)], "de");
    await s.segment(s.copy.segScreened);
    await s.open("p1");
    await s.press(s.copy.pileOhbox);
    expect(lastToast()).toBe(fill(de.screener.toastReleasedAddress, {
      dest: de.screener.pileOhbox, count: "1", sender: PRESSED, domain: DOMAIN,
    }));
  });
});

describe("Not spam → back to Waiting", () => {
  it("held by a DOMAIN rule: unperformable, said with the rule and where to change it, nothing deleted", async () => {
    const s = await mount(spamMail(), [rule("r-dom", "domain", DOMAIN, SPAM)]);
    await s.segment(s.copy.segSpam);
    await s.open("p1");
    await s.press(s.copy.place.toWaiting);
    expect(lastToast()).toBe(fill(en.screener.toastReleaseRuleStands, {
      sender: PRESSED, place: en.screener.segSpam, domain: DOMAIN,
    }));
    await commit();
    expect(s.writes, "back to Waiting deleted or moved something under a domain rule").toEqual([]);
    expect([...s.standing.values()].map((r) => [r.id, r.destination])).toEqual([["r-dom", SPAM]]);
  });

  it("held by their OWN rule: the rule is deleted and the mail goes back to the gate", async () => {
    const s = await mount(spamMail(), [rule("r-own", "sender", PRESSED, SPAM)]);
    await s.segment(s.copy.segSpam);
    await s.open("p1");
    await s.press(s.copy.place.toWaiting);
    expect(lastToast()).toBe(fill(en.screener.toastNotSpamWaiting, { sender: PRESSED }));
    await commit();

    expect(ruleWrites(s.writes)).toEqual([{ method: "DELETE", path: "/api/rules/r-own" }]);
    expect(moves(s.writes)).toEqual([move("p1", "ohmail/Screener")]);
  });

  it("the German catalogue says the refusal too", async () => {
    const s = await mount(spamMail(), [rule("r-dom", "domain", DOMAIN, SPAM)], "de");
    await s.segment(s.copy.segSpam);
    await s.open("p1");
    await s.press(s.copy.place.toWaiting);
    expect(lastToast()).toBe(fill(de.screener.toastReleaseRuleStands, {
      sender: PRESSED, place: de.screener.segSpam, domain: DOMAIN,
    }));
  });
});

describe("Not spam → Ohbox on a sender marked spam this session (the pinned rescue)", () => {
  async function pinned(scope: "sender" | "domain", locale: "en" | "de" = "en") {
    const s = await mount([msg("h1", PRESSED, "ohmail/Screener"), msg("o1", OTHER, SPAM, 8)], [], locale);
    await s.open("h1");
    if (scope === "domain") {
      await click(s.frame.getByRole("button", { name: s.copy.barScopeAria }));
      const menu = within(document.body).getByRole("menu", { name: s.copy.barScopeAria });
      await click(within(menu).getByRole("menuitemradio", { name: s.copy.barScopeDomain }));
    }
    await s.press(s.copy.pileSpam);
    const confirmation = within(document.body).queryByRole("dialog", { name: s.copy.place.unsub.spam });
    if (confirmation) {
      const alternate = (locale === "de" ? de : en).screening.unsubCommitMaybe;
      await click(within(confirmation).getByRole("button", {
        name: (label) => label === s.copy.place.unsub.spam || label === alternate,
      }));
    }
    await commit();
    expect(s.writes.filter(({ path }) => path.startsWith("/api/screener"))).toEqual([{
      method: "POST", path: "/api/screener/h1",
      body: { decision: "no", dest: SPAM, scope, applyRetro: false },
    }]);
    await s.segment(s.copy.segSpam);
    await s.open("h1");
    s.writes.length = 0;
    return s;
  }

  it("a DOMAIN-scoped spam decision: an address rule for them alone, the domain rule stays", async () => {
    const s = await pinned("domain");
    await s.press(s.copy.pileOhbox);
    expect(lastToast()).toBe(fill(en.screener.toastNotSpamOhboxAddress, { sender: PRESSED, domain: DOMAIN }));
    await commit();

    expect(ruleWrites(s.writes)).toEqual([createAddressRule]);
    expect(rulesTouched(s.writes, "r-promoted"), "the domain spam rule was rewritten by one sender's rescue").toEqual([]);
    expect(moves(s.writes)).toEqual([move("h1", "INBOX", true)]);
    expect(decided(s.standing, PRESSED)).toBe("INBOX");
    expect(decided(s.standing, OTHER), "another sender at the domain was rescued").toBe(SPAM);
  });

  it("a sender-scoped spam decision: their own rule is retargeted", async () => {
    const s = await pinned("sender");
    await s.press(s.copy.pileOhbox);
    expect(lastToast()).toBe(fill(en.screener.toastNotSpamOhbox, { sender: PRESSED }));
    await commit();

    expect(ruleWrites(s.writes)).toEqual([retarget("r-promoted")]);
    expect(moves(s.writes)).toEqual([move("h1", "INBOX", true)]);
    expect(decided(s.standing, PRESSED)).toBe("INBOX");
  });

  it("the German catalogue names the domain rule", async () => {
    const s = await pinned("domain", "de");
    await s.press(s.copy.pileOhbox);
    expect(lastToast()).toBe(fill(de.screener.toastNotSpamOhboxAddress, { sender: PRESSED, domain: DOMAIN }));
  });
});

describe("a Move out of a domain rule's pile holds an address rule, and Undo takes it back", () => {
  const NEWS = "ohmail/News";

  async function moveToOhbox() {
    const s = await mount(
      [msg("p1", PRESSED, NEWS), msg("o1", OTHER, NEWS, 8)],
      [rule("r-dom", "domain", DOMAIN, NEWS)],
      "en",
      "reads",
    );
    const row = s.shell.querySelector<HTMLElement>('[data-stream-item="p1"]');
    expect(row, "the domain-held letter is in News").toBeTruthy();
    await click(row!);
    const panel = s.frame.getByRole("toolbar", { name: "Actions" });
    await click(within(panel).getByRole("button", { name: "More" }));
    await click(within(document.body).getByRole("menuitem", { name: "Move" }));
    await click(within(document.body).getByRole("menuitem", { name: "Ohbox" }));
    expect(moves(s.writes)).toEqual([move("p1", "INBOX", true)]);
    return s;
  }

  it("the window commits an address rule for this sender, never a rewrite of the domain rule", async () => {
    const s = await moveToOhbox();
    expect(ruleWrites(s.writes), "a rule went out inside the undo window").toEqual([]);
    await commit();
    expect(ruleWrites(s.writes)).toEqual([{
      ...createAddressRule, body: { ...createAddressRule.body, applyRetro: false },
    }]);
    expect(decided(s.standing, OTHER)).toBe(NEWS);
  });

  it("Undo inside the window: nothing is sent, the domain rule and the address rule alike", async () => {
    const s = await moveToOhbox();
    const report = document.querySelector('.fr-report [role="status"]:not([data-leaving])');
    expect(report, "Move offers Undo").toBeTruthy();
    await click(within(report as HTMLElement).getByRole("button", { name: /^Undo/ }));
    await commit();
    expect(ruleWrites(s.writes), "Undo let a rule out").toEqual([]);
    expect(moves(s.writes)).toEqual([move("p1", "INBOX", true), move("p1", NEWS, true)]);
    expect(decided(s.standing, PRESSED)).toBe(NEWS);
  });
});

describe("releaseRules, the one ladder all three presses and the phone's mirror read", () => {
  it("their own rule AND a domain rule: only their own is retargeted, the domain rule stays", async () => {
    const { releaseRules } = await import("@ohmail/app-logic/press/sender-screening");
    const both = [rule("r-own", "sender", PRESSED, SCREENED), rule("r-dom", "domain", DOMAIN, SCREENED)];
    const store = await mirror(screenedMail(), both);
    expect(releaseRules(store, PRESSED, SCREENED, "INBOX")).toEqual({
      kind: "retarget", mutations: [{ kind: "rule_update", ruleId: "r-own", destination: "INBOX" }],
    });
    const s = await mount(screenedMail(), both);
    await s.segment(s.copy.segScreened);
    await s.open("p1");
    await s.press(s.copy.pileOhbox);
    await commit();
    expect(ruleWrites(s.writes)).toEqual([retarget("r-own")]);
    expect(decided(s.standing, OTHER)).toBe(SCREENED);
  });

  it("an address rule already standing at the destination: nothing more is written", async () => {
    const { releaseRules } = await import("@ohmail/app-logic/press/sender-screening");
    const both = [rule("r-dom", "domain", DOMAIN, SCREENED), rule("r-mine", "sender", PRESSED, "INBOX")];
    const store = await mirror(screenedMail(), both);
    expect(releaseRules(store, PRESSED, SCREENED, "INBOX")).toEqual({ kind: "address", mutations: [], domain: DOMAIN });
    const s = await mount(screenedMail(), both);
    await s.segment(s.copy.segScreened);
    await s.open("p1");
    await s.press(s.copy.pileOhbox);
    await commit();
    expect(moves(s.writes)).toEqual([move("p1", "INBOX")]);
    expect(ruleWrites(s.writes)).toEqual([]);
    expect(decided(s.standing, OTHER)).toBe(SCREENED);
  });
});
