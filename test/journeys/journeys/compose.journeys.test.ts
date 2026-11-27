import { expect } from "vitest";
import type { PlaywrightPerson } from "../bench/dom-playwright.js";
import { EVERY_WEB, WEB, journey, journeysOf, signedIn, type Guard } from "../bench/web.js";
import type { Account, Bench, Person } from "../bench/seam.js";

import { PEOPLE } from "../vocabulary/world.js";

const OFFLINE: Guard[] = ["new letter", "reply"].map<Guard>((surface) => ({
  title: `The first ${surface} accepts text offline after the Ohbox loads`,
  rows: [],
  surfaces: WEB,
  needs: [],
  // The browser deliberately refuses every request after we take it offline.
  tolerates: [/^console: Failed to load resource: net::ERR_INTERNET_DISCONNECTED$/],
}));

const WHILE_LOADING: Guard[] = OFFLINE.map((guard) => ({
  ...guard,
  title: guard.title + " with a Settings script response held",
}));

const DELIVERY: Guard[] = ["after a reload", "while the first save is answering"].map((when) => ({
  title: `Adding the recipient late ${when} sends from one draft and Write starts empty`,
  rows: [], surfaces: WEB, needs: [],
}));

const RECOVERY: Guard[] = [
  { title: "A closed tab offers its draft once and sending the restored draft leaves nothing in Drafts", rows: [], surfaces: WEB, needs: [] },
  { title: "Closing after the server accepted Send does not bring back the draft", rows: [], surfaces: WEB, needs: [] },
  { title: "An app update keeps the existing draft until it is sent", rows: [], surfaces: WEB, needs: [] },
  { title: "An offline send goes once after reconnect and clears the draft", rows: [], surfaces: WEB, needs: [],
    tolerates: [/^console: Failed to load resource: net::ERR_INTERNET_DISCONNECTED$/] },
  { title: "Send later keeps one scheduled message and clears the composer", rows: [], surfaces: WEB, needs: [] },
  { title: "Sending a saved reply leaves no reply draft", rows: [], surfaces: WEB, needs: [] },
  { title: "Discarded compose words do not come back after opening a new tab", rows: [], surfaces: WEB, needs: [] },
  { title: "Reload after losing the first save answer keeps one draft through Send", rows: [], surfaces: WEB, needs: [] },
  { title: "Send survives closing before the first save answers", rows: [], surfaces: WEB, needs: [] },
  { title: "Pressing Send seals the letter while the first save is answering", rows: [], surfaces: WEB, needs: [] },
  { title: "A fresh tab at Compose waits for the Restore action", rows: [], surfaces: WEB, needs: [] },
  { title: "A waiting Send finishes when Drafts opens immediately in another tab", rows: [], surfaces: WEB, needs: [] },
];

const ORDINARY_SEND: Guard[] = ["saved draft", "fresh letter"].map((kind) => ({
  title: `A ${kind} sends when its tab closes before the outbox commits`,
  rows: [], surfaces: WEB, needs: [],
}));
const DISCARD_FROM_ANOTHER_TAB: Guard[] = [
  {
    title: "Discarding a saved draft in another tab clears its recovery copy",
    rows: [], surfaces: WEB, needs: [],
  },
  {
    title: "Discarding a saved draft in another tab keeps newer unsaved words",
    rows: [], surfaces: WEB, needs: [],
  },
];
const SEND_FROM_ANOTHER_TAB: Guard[] = [
  { title: "Sending a saved draft in another tab clears its recovery copy", rows: [], surfaces: WEB, needs: [] },
  { title: "Sending a saved draft in another tab keeps newer unsent words", rows: [], surfaces: WEB, needs: [] },
];
const SYNCED_SEND: Guard = {
  title: "Sync clears both tabs' copies of a sent draft when the retry fails", rows: [], surfaces: WEB, needs: [],
  tolerates: [
    /^http response with a status of 503: POST$/,
    /^console: Failed to load resource: the server responded with a status of 503 \(Service Unavailable\)$/,
  ],
};
const SYNCED_DISCARD: Guard[] = [
  { title: "Sync removes the Restore choice after a saved draft is discarded elsewhere", rows: [], surfaces: WEB, needs: [] },
  { title: "A draft opened from Drafts loses its Restore choice after a synced discard", rows: [], surfaces: WEB, needs: [] },
];
const OHBOX_RESTORE: Guard = {
  title: "A synced discard removes the Restore offer from the open Ohbox", rows: [], surfaces: WEB, needs: [],
};
const SEND_BEFORE_FIRST_WRITE: Guard = {
  title: "Send survives closure before the first autosave reaches browser storage", rows: [], surfaces: WEB, needs: [],
  // The first-save lookup returns 404 to say the key is vacant before the sealed Send creates its row.
  tolerates: [
    /^http response with a status of 404: GET$/,
    /^console: Failed to load resource: the server responded with a status of 404 \(Not Found\)$/,
  ],
};

type DraftChange = { id: string; entity?: { subject?: string; status?: string } };

async function draftChanges(b: Bench, a: Account) {
  const res = await b.ask(a, "GET", "/sync?since=0&types=draft&limit=100", { session: "fresh" });
  expect(res.status).toBe(200);
  return (res.body as { changes: { creates: DraftChange[]; updates: DraftChange[]; deletes: DraftChange[] } }).changes;
}

async function draftStates(b: Bench, a: Account, subject?: string): Promise<string[]> {
  const changes = await draftChanges(b, a);
  const latest = new Map([...changes.creates, ...changes.updates].map((row) => [row.id, row.entity]));
  for (const row of changes.deletes) latest.delete(row.id);
  return [...latest.values()].flatMap((row) => row?.status && (subject === undefined || row.subject === subject) ? [row.status] : []);
}

const SUBJECT = "Garden delivery";
const WORDS = "The seedlings are ready.";
const MARK = /The seedlings are ready/;
const scratchWords = async (p: Person) => Object.values(await p.kept(MARK)).flat();

async function startLetter(b: Bench): Promise<{ account: Account; person: Person }> {
  const account = await b.account();
  await account.planter.mailboxId();
  const person = await b.person({ account, clock: "driven" });
  await person.arrive("ohbox");
  await person.act("press", "rail-compose");
  await person.act("type", "compose-subject", { value: SUBJECT });
  await person.act("write", "compose-body", { value: WORDS });
  return { account, person };
}

async function openSavedLetter(b: Bench): Promise<{ account: Account; person: Person }> {
  const account = await b.account();
  const mailboxId = await account.planter.mailboxId();
  const seed = await b.ask(account, "POST", "/drafts", { session: "fresh", body: { mailboxId, subject: SUBJECT, body: WORDS } });
  expect(seed.status).toBe(201);
  const person = await b.person({ account });
  await person.arrive("drafts");
  await person.act("press", "conversation", { named: `No recipient yet: ${SUBJECT}` });
  await person.here("compose");
  expect(await person.text("compose-body")).toBe(WORDS);
  return { account, person };
}

async function sentWithoutDraft(b: Bench, account: Account, person: Person, subject?: string): Promise<void> {
  await expect.poll(() => draftStates(b, account, subject), { timeout: 20_000 }).toEqual(["sent"]);
  await person.arrive("drafts");
  await expect.poll(() => scratchWords(person), { timeout: 20_000 }).toEqual([]);
  await expect.poll(() => person.shows(SUBJECT)).toBe(false);
}

const addressLetter = (p: Person): Promise<void> => p.act("type", "compose-to", { value: "ben@lichtgrat.example" });

function holdDraftAnswer(b: Bench, path: "/drafts" | "/drafts/:id/send"): () => boolean {
  const from = b.heard.length;
  let held = false;
  b.faults.push((method, pattern) => {
    if (held || method !== "POST" || pattern !== path) return null;
    held = true;
    return "hold-answer";
  });
  return () => b.heard.slice(from).some((row) => row.method === "POST" && row.pattern === path && row.status < 300);
}

export const GUARDS: Guard[] = [
  { title: "A letter with a recipient, a subject and words can be sent", rows: [], surfaces: EVERY_WEB, needs: [] },
  { title: "The demo sends a letter and says so", rows: [], surfaces: ["W-d"], needs: [] },
  {
    title: "A letter whose formatting was removed and retyped plain is still sent",
rows: [], surfaces: ["W-d"], needs: [],
  },
  ...OFFLINE,
  ...WHILE_LOADING,
  ...DELIVERY,
  ...RECOVERY,
  ...ORDINARY_SEND,
  ...DISCARD_FROM_ANOTHER_TAB,
  ...SEND_FROM_ANOTHER_TAB,
  SYNCED_SEND,
  ...SYNCED_DISCARD,
  OHBOX_RESTORE,
  SEND_BEFORE_FIRST_WRITE,
];

journeysOf("compose", () => {
  SYNCED_DISCARD.forEach((guard, index) => journey(guard, async (b) => {
    const { account, person } = index === 0 ? await startLetter(b) : await openSavedLetter(b);
    if (index === 0) await person.later(3_000);
    await expect.poll(() => draftStates(b, account, SUBJECT)).toEqual(["draft"]);
    const { creates } = await draftChanges(b, account);
    const draft = creates.find((change) => change.entity?.subject === SUBJECT);
    expect(draft).toBeDefined();
    const next = await person.tab();
    await person.closeTab();
    await next.arrive("compose");
    await expect.poll(() => next.offered("compose-restore")).toBe(true);
    const discarded = await b.ask(account, "DELETE", `/drafts/${draft!.id}`, { session: "fresh" });
    expect(discarded.status).toBe(204);
    await next.reload();
    await next.here("compose");
    await expect.poll(() => next.storedWriting(WORDS), { timeout: 20_000 }).toEqual([]);
    await expect.poll(() => scratchWords(next), { timeout: 15_000 }).toEqual([]);
    expect(await next.offered("compose-restore")).toBe(false);
  }));

  journey(OHBOX_RESTORE, async (b) => {
    const { account, person } = await startLetter(b);
    await person.later(3_000);
    await expect.poll(() => draftStates(b, account, SUBJECT)).toEqual(["draft"]);
    const { creates } = await draftChanges(b, account);
    const draft = creates.find((change) => change.entity?.subject === SUBJECT)!;
    await expect.poll(() => person.storedWriting(WORDS, SUBJECT)).toContain("draft");
    const next = (await person.tab()) as PlaywrightPerson;
    await person.closeTab();
    await next.arrive("ohbox");
    await expect.poll(() => next.offered("compose-restore")).toBe(true);
    // Keep the clock inside the notice's lifetime so a timeout cannot pass this check.
    const now = await next.page.evaluate(() => Date.now());
    await next.page.clock.pauseAt(new Date(now + 150));
    const discarded = await b.ask(account, "DELETE", `/drafts/${draft.id}`, { session: "fresh" });
    expect(discarded.status).toBe(204);
    await next.page.evaluate(() => window.dispatchEvent(new Event("online")));
    await next.page.clock.runFor(500);
    await expect.poll(() => next.storedWriting(WORDS, SUBJECT)).toEqual([]);
    await expect.poll(() => scratchWords(next)).toEqual([]);
    await next.page.clock.runFor(150);
    expect(await next.offered("compose-restore")).toBe(false);
  });

  journey(SYNCED_SEND, async (b) => {
    const { account, person } = await startLetter(b);
    await person.later(3_000);
    await expect.poll(() => draftStates(b, account, SUBJECT)).toEqual(["draft"]);
    const sender = await person.tab();
    await sender.arrive("drafts");
    await person.closeTab();
    expect(await scratchWords(sender)).toHaveLength(1);
    await sender.act("press", "conversation", { named: `No recipient yet: ${SUBJECT}` });
    await sender.here("compose");
    await addressLetter(sender);
    let held = false;
    b.faults.push((method, pattern) => {
      if (method !== "POST" || pattern !== "/drafts/:id/send") return null;
      if (held) return "refuse";
      held = true;
      return "hold-answer";
    });
    const from = b.heard.length;
    const next = await sender.tab();
    await sender.act("press", "compose-send");
    await expect.poll(() => draftStates(b, account, SUBJECT)).toEqual(["sent"]);
    await sender.closeTab();
    await next.arrive("compose");
    const answers = () => b.heard.slice(from).filter((r) => r.method === "POST" && r.pattern === "/drafts/:id/send");
    await expect.poll(() => answers().map(({ status }) => status), { timeout: 20_000 }).toContain(503);
    await expect.poll(() => next.storedWriting(WORDS, SUBJECT), { timeout: 20_000 }).toContain("sent-draft");
    await expect.poll(() => scratchWords(next), { timeout: 15_000 }).toEqual([]);
    await expect.poll(() => next.offered("compose-restore")).toBe(false);
    await next.arrive("drafts");
    expect(await next.shows(SUBJECT)).toBe(false);
    expect(answers().filter(({ status }) => status === 200)).toHaveLength(1);
    expect(b.heard.slice(from).filter((r) => r.status === 503).every((r) => r.pattern === "/drafts/:id/send")).toBe(true);
  });

  journey(SEND_BEFORE_FIRST_WRITE, async (b) => {
    const from = b.heard.length;
    const { account, person } = await startLetter(b);
    const other = await person.tab();
    await person.holdMirrorWrites();
    await person.later(3_000);
    await addressLetter(person);
    await person.act("press", "compose-send");
    await person.closeTab();
    expect(await draftStates(b, account, SUBJECT)).toEqual([]);
    expect(b.heard.slice(from).filter((r) => r.method === "POST" && r.pattern.startsWith("/drafts"))).toEqual([]);
    expect(await other.storedWriting(WORDS)).toContain("pressed-send");
    await other.arrive("drafts");
    await expect.poll(async () => {
      const requests = b.heard.slice(from).filter((r) => r.pattern.startsWith("/drafts"));
      return requests.some((r) => r.method === "POST" && r.pattern === "/drafts/:id/send" && r.status < 300)
        ? "delivered" : { requests, mirror: await other.storedWriting(WORDS) };
    }, { timeout: 20_000 }).toBe("delivered");
    await sentWithoutDraft(b, account, other, SUBJECT);
    await expect.poll(() => other.storedWriting(WORDS)).toEqual([]);
    const changes = await draftChanges(b, account);
    expect(new Set([...changes.creates, ...changes.updates, ...changes.deletes].map((row) => row.id)).size).toBe(1);
    expect(b.heard.slice(from).filter((r) => r.status === 404)).toEqual([
      { method: "GET", pattern: "/drafts/:id", status: 404 },
    ]);
    expect(b.problems().filter((problem) => problem.includes("status of 404")
      && !/ \(\/api\/drafts\/[0-9a-f-]{36}\)$/.test(problem))).toEqual([]);
    expect(b.heard.slice(from).filter((r) => r.method === "POST" && r.pattern === "/drafts/:id/send")).toHaveLength(1);
  });

  SEND_FROM_ANOTHER_TAB.forEach((guard, index) => journey(guard, async (b) => {
    const { account, person } = await startLetter(b);
    await person.later(3_000);
    await expect.poll(() => draftStates(b, account, SUBJECT)).toEqual(["draft"]);
    const other = await person.tab();
    await other.arrive("drafts");
    const correction = "Please use the side entrance.";
    if (index === 1) await person.act("write", "compose-body", { value: `${WORDS} ${correction}` });
    await person.closeTab();
    expect(await scratchWords(other)).toContain("The seedlings are ready");
    await other.act("press", "conversation", { named: `No recipient yet: ${SUBJECT}` });
    await other.here("compose");
    await addressLetter(other);
    await other.act("press", "compose-send");
    await expect.poll(() => draftStates(b, account, SUBJECT)).toEqual(["sent"]);
    if (index === 0) await expect.poll(() => scratchWords(other), { timeout: 20_000 }).toEqual([]);
    const next = await other.tab();
    await next.arrive("compose");
    if (index === 1) {
      await next.act("press", "compose-restore");
      await expect.poll(() => next.text("compose-body")).toContain(correction);
    } else {
      expect(await next.offered("compose-restore")).toBe(false);
      expect(await scratchWords(next)).toEqual([]);
    }
  }));

  ORDINARY_SEND.forEach((guard, index) => journey(guard, async (b) => {
    const { account, person } = await startLetter(b);
    const from = b.heard.length;
    const other = await person.tab();
    await other.arrive("drafts");
    if (index === 0) {
      await person.later(3_000);
      await expect.poll(() => draftStates(b, account, SUBJECT)).toEqual(["draft"]);
      await expect.poll(() => other.storedWriting(WORDS)).toContain("draft");
    } else {
      expect(await draftStates(b, account, SUBJECT)).toEqual([]);
    }
    await addressLetter(person);
    await person.holdMirrorWrites();
    await person.act("press", "compose-send");
    await person.closeTab();
    expect(await other.storedWriting(WORDS)).toContain("pressed-send");
    await other.reload();
    await other.here("drafts");
    await sentWithoutDraft(b, account, other, SUBJECT);
    await expect.poll(() => other.storedWriting(WORDS)).toEqual([]);
    expect(b.heard.slice(from).filter((r) => r.method === "POST" && r.pattern === "/drafts/:id/send")).toHaveLength(1);
  }));

  DISCARD_FROM_ANOTHER_TAB.forEach((guard, index) => journey(guard, async (b) => {
    const { account, person } = await startLetter(b);
    await person.later(3_000);
    await expect.poll(() => draftStates(b, account, SUBJECT)).toEqual(["draft"]);
    const other = await person.tab();
    await other.arrive("drafts");
    const correction = WORDS + " Please use the side entrance.";
    if (index === 1) await person.act("write", "compose-body", { value: correction });
    await person.closeTab();
    expect(await scratchWords(other)).toContain("The seedlings are ready");
    await other.act("press", "conversation", { named: `No recipient yet: ${SUBJECT}` });
    await other.here("compose");
    await other.act("press", "compose-cancel");
    await expect.poll(() => draftStates(b, account, SUBJECT)).toEqual([]);
    if (index === 1) {
      const next = await other.tab();
      await next.arrive("compose");
      await next.act("press", "compose-restore");
      await expect.poll(() => next.text("compose-body")).toContain("Please use the side entrance.");
      return;
    }
    await expect.poll(() => scratchWords(other)).toEqual([]);
    const next = await other.tab();
    await next.arrive("ohbox");
    expect(await next.offered("compose-restore")).toBe(false);
    expect(await scratchWords(next)).toEqual([]);
  }));

  DELIVERY.forEach((guard, index) => journey(guard, async (b) => {
    const account = await b.account();
    await account.planter.mailboxId();
    const person = await b.person({ account, clock: "driven" });
    await person.arrive("ohbox");
    await person.act("press", "rail-compose");
    const subject = "Garden delivery";
    const words = "The seedlings are ready.";
    const createsFrom = b.heard.length;
    if (index === 1) b.faults.push((method, path) => method === "POST" && path === "/drafts" ? "hold" : null);
    await person.act("type", "compose-subject", { value: subject });
    await person.act("write", "compose-body", { value: words });
    await person.later(3_000);

    if (index === 0) {
      await expect.poll(() => draftStates(b, account, subject), { timeout: 20_000 }).toContain("draft");
      const second = await person.tab();
      await second.arrive("ohbox");
      await second.act("press", "rail-compose");
      expect(await second.holds("compose-subject")).toBe("");
      await person.reload();
      await person.here("compose");
      expect(await person.holds("compose-subject")).toBe(subject);
    } else {
      await person.until(async () => b.held().includes("POST /drafts"), "the first save on the wire");
    }

    await person.act("type", "compose-to", { value: "ben@lichtgrat.example" });
    await person.act("press", "compose-send");
    await person.later(500);
    b.release();
    await expect.poll(() => draftStates(b, account, subject), { timeout: 20_000 }).toContain("sent");
    await person.later(4_000);
    await person.arrive("drafts");
    expect(await person.shows(subject)).toBe(false);
    expect(await draftStates(b, account, subject)).toEqual(["sent"]);
    expect(Object.values(await person.kept(/The seedlings are ready/)).flat()).toEqual([]);
    expect(b.heard.slice(createsFrom).filter((r) => r.method === "POST" && r.pattern === "/drafts")).toHaveLength(1);
    await person.act("press", "rail-compose");
    expect(await person.holds("compose-subject")).toBe("");
  }));

  journey(RECOVERY[0]!, async (b) => {
    const { account, person } = await startLetter(b);
    const tab = await person.tab();
    await person.closeTab();
    await tab.arrive("ohbox");
    await tab.act("press", "compose-restore");
    await tab.here("compose");
    expect(await tab.text("compose-body")).toBe(WORDS);
    await tab.gone("compose-restore");
    await addressLetter(tab);
    await tab.act("press", "compose-send");
    await sentWithoutDraft(b, account, tab, SUBJECT);
  });

  journey(RECOVERY[1]!, async (b) => {
    const { account, person } = await startLetter(b);
    await person.later(3_000);
    await expect.poll(() => draftStates(b, account, SUBJECT)).toEqual(["draft"]);
    await addressLetter(person);
    const answered = holdDraftAnswer(b, "/drafts/:id/send");
    const tab = await person.tab();
    await person.act("press", "compose-send");
    await person.until(async () => answered(), "the send accepted by the server");
    await person.closeTab();
    await sentWithoutDraft(b, account, tab, SUBJECT);
    await tab.act("press", "rail-compose");
    expect(await tab.holds("compose-subject")).toBe("");
  });

  journey(RECOVERY[2]!, async (b) => {
    const { account, person } = await startLetter(b);
    await person.restartForNewBuild();
    await person.here("compose");
    await expect.poll(() => person.holds("compose-subject")).toBe(SUBJECT);
    await addressLetter(person);
    await person.act("press", "compose-send");
    await person.later(4_000);
    await sentWithoutDraft(b, account, person, SUBJECT);
  });

  journey(RECOVERY[3]!, async (b) => {
    const { account, person } = await startLetter(b);
    await person.later(3_000);
    await expect.poll(() => draftStates(b, account, SUBJECT)).toEqual(["draft"]);
    await person.goOffline();
    await addressLetter(person);
    await person.act("press", "compose-send");
    await person.later(3_000);
    expect(await draftStates(b, account, SUBJECT)).toEqual(["draft"]);
    await person.goOnline();
    await person.later(10_000);
    await sentWithoutDraft(b, account, person, SUBJECT);
  });

  journey(RECOVERY[4]!, async (b) => {
    const { account, person } = await startLetter(b);
    await person.later(3_000);
    await expect.poll(() => draftStates(b, account, SUBJECT)).toEqual(["draft"]);
    await addressLetter(person);
    await person.act("press", "compose-later");
    await person.act("keyIn", "compose-later-menu", { value: "2" });
    await expect.poll(() => draftStates(b, account, SUBJECT)).toEqual(["scheduled"]);
    await expect.poll(() => scratchWords(person), { timeout: 20_000 }).toEqual([]);
    await person.arrive("drafts");
    expect((await person.listed("list-scheduled", "option")).filter((name) => name.includes(SUBJECT))).toHaveLength(1);
    expect(await person.offered("list-drafts")).toBe(false);
    await person.act("press", "rail-compose");
    expect(await person.holds("compose-subject")).toBe("");
  });

  journey(RECOVERY[5]!, async (b) => {
    const account = await b.account();
    const [letter] = await account.planter.plant({ conversations: [
      { from: PEOPLE.ben, subject: "Garden question", text: "How are the seedlings?", pile: "ohbox" },
    ] });
    const person = await b.person({ account, clock: "driven" });
    await person.arrive("ohbox");
    await person.act("press", "conversation", { named: `${letter!.from}: ${letter!.subject}` });
    await person.act("press", "reply");
    await person.act("write", "reply-body", { value: WORDS });
    await person.later(3_000);
    await expect.poll(() => draftStates(b, account)).toEqual(["draft"]);
    await person.act("press", "reply-send");
    await person.later(4_000);
    await sentWithoutDraft(b, account, person);
  });

  journey(RECOVERY[6]!, async (b) => {
    const { account, person } = await startLetter(b);
    await person.later(3_000);
    await expect.poll(() => draftStates(b, account, SUBJECT)).toEqual(["draft"]);
    await person.act("press", "compose-cancel");
    await expect.poll(() => draftStates(b, account, SUBJECT)).toEqual([]);
    const other = await person.tab();
    await other.arrive("drafts");
    expect(await other.shows(SUBJECT)).toBe(false);
    expect(await scratchWords(other)).toEqual([]);
    await other.act("press", "rail-compose");
    expect(await other.holds("compose-subject")).toBe("");
  });

  journey(RECOVERY[7]!, async (b) => {
    const account = await b.account();
    await account.planter.mailboxId();
    const person = await b.person({ account, clock: "driven" });
    await person.arrive("ohbox");
    const answered = holdDraftAnswer(b, "/drafts");
    await person.act("press", "rail-compose");
    await person.act("type", "compose-subject", { value: SUBJECT });
    await person.act("write", "compose-body", { value: WORDS });
    await person.later(3_000);
    await person.until(async () => answered(), "the draft saved on the server");
    await expect.poll(() => draftStates(b, account, SUBJECT)).toEqual(["draft"]);
    await person.reload();
    await person.here("compose");
    await expect.poll(() => person.holds("compose-subject")).toBe(SUBJECT);
    await addressLetter(person);
    await person.act("press", "compose-send");
    await person.later(4_000);
    await sentWithoutDraft(b, account, person, SUBJECT);
    const changes = await draftChanges(b, account);
    expect(new Set([...changes.creates, ...changes.updates, ...changes.deletes].map((row) => row.id)).size).toBe(1);
  });

  [RECOVERY[8]!, RECOVERY[11]!].forEach((guard, index) => journey(guard, async (b) => {
    const firstRequest = b.heard.length;
    const answered = holdDraftAnswer(b, "/drafts");
    const { account, person } = await startLetter(b);
    await person.later(3_000);
    await person.until(async () => answered(), "the first draft save accepted by the server");
    expect(await draftStates(b, account, SUBJECT)).toEqual(["draft"]);
    await addressLetter(person);
    const other = await person.tab();
    if (index === 0) await person.holdMirrorWrites();
    await person.act("press", "compose-send");
    await person.closeTab();
    if (index === 0) expect(await other.storedWriting(WORDS)).toContain("pressed-send");
    b.release();
    await other.arrive("drafts");
    const delivered = () => b.heard.slice(firstRequest).filter(({ method, pattern, status }) =>
      method === "POST" && pattern === "/drafts/:id/send" && status < 300);
    await expect.poll(async () => {
      const requests = b.heard.slice(firstRequest).filter(({ pattern }) => pattern.startsWith("/drafts"));
      return delivered().length === 1 ? "delivered" : { requests, mirror: await other.storedWriting(WORDS) };
    }, { timeout: 20_000 }).toBe("delivered");
    await sentWithoutDraft(b, account, other, SUBJECT);
    await expect.poll(() => other.storedWriting(WORDS)).toEqual([]);
    const changes = await draftChanges(b, account);
    expect(new Set([...changes.creates, ...changes.updates, ...changes.deletes].map((row) => row.id)).size).toBe(1);
  }));

  journey(RECOVERY[9]!, async (b) => {
    b.faults.push((method, path) => method === "POST" && path === "/drafts" ? "hold" : null);
    const { account, person } = await startLetter(b);
    await person.later(3_000);
    await person.until(async () => b.held().includes("POST /drafts"), "the first draft save waiting for its answer");
    await addressLetter(person);
    expect((await person.spoken("compose-subject")).editable).toBe(true);
    await person.act("press", "compose-send");
    expect((await person.spoken("compose-subject")).editable).toBe(false);
    b.release();
    await sentWithoutDraft(b, account, person, SUBJECT);
  });

  journey(RECOVERY[10]!, async (b) => {
    const { person } = await startLetter(b);
    const other = await person.tab();
    await person.closeTab();
    await other.arrive("compose");
    await other.until(async () => (await other.holds("compose-subject")) === SUBJECT
      || await other.offered("compose-restore"), "the closed draft or its Restore action");
    expect(await other.holds("compose-subject")).toBe("");
    await other.act("press", "compose-restore");
    await expect.poll(() => other.holds("compose-subject")).toBe(SUBJECT);
    await other.gone("compose-restore");
  });

  journey(GUARDS[0]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("compose");
    expect((await person.spoken("compose-send")).disabled).toBe(true);
    await person.act("type", "compose-to", { value: "ben@lichtgrat.example" });
    await person.act("type", "compose-subject", { value: "Friday" });
    await person.act("write", "compose-body", { value: "See you at the kiln." });
    await person.until(async () => !(await person.spoken("compose-send")).disabled, "Send to be offered");
  });
  journey(GUARDS[1]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("compose");
    await person.act("type", "compose-to", { value: "ben@lichtgrat.example" });
    await person.act("type", "compose-subject", { value: "Friday" });
    await person.act("write", "compose-body", { value: "See you at the kiln." });
    await person.act("press", "compose-send");
    await person.reads("compose.toastSent");
  });
  journey(GUARDS[2]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("compose");
    await person.act("type", "compose-to", { value: "ben@lichtgrat.example" });
    await person.act("type", "compose-subject", { value: "Friday" });
    await person.act("press", "compose-bold");
    await person.act("write", "compose-body", { value: "Loud words." });
    await person.act("keyIn", "compose-body", { value: "Control+A" });
    await person.act("keyIn", "compose-body", { value: "Delete" });
    await person.act("write", "compose-body", { value: "Plain words." });
    await person.act("press", "compose-send");
    await person.reads("compose.toastSent");
  });

  [...OFFLINE, ...WHILE_LOADING].forEach((guard, index) => journey(guard, async (b) => {
    const reply = index % 2 === 1;
    const whileLoading = index >= OFFLINE.length;
    const account = await b.account();
    const [letter] = await account.planter.plant({ conversations: [{
      from: PEOPLE.ben, subject: "Kiln schedule", text: "The next firing is on Friday.", pile: "ohbox",
    }] });
    const named = `${letter!.from}: ${letter!.subject}`;
    const person = await b.person({ account, clock: "driven" });
    await person.arrive("ohbox");
    await person.see("conversation", { named });
    if (reply) {
      await person.act("press", "conversation", { named });
      await person.see("reply");
    }
    if (whileLoading) {
      await person.goOfflineWhileOpeningSettings();
      await person.here("ohbox", 5_000);
    } else await person.goOffline();
    if (reply) await person.act("press", "reply");
    else await person.act("keyIn", "conversation", { named, value: "c" });
    const body = reply ? "reply-body" : "compose-body";
    const text = "These words were written offline.";
    await person.see(body, {}, 5_000);
    await person.act("write", body, { value: text });
    await person.later(30_000);
    expect(await person.text(body)).toBe(text);
  }));
});
