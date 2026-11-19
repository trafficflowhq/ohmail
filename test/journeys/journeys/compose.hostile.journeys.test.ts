import { expect } from "vitest";
import type { Account, Bench, Person } from "../bench/seam.js";
import { WEB, journey, journeysOf, type DoorFault, type Guard } from "../bench/web.js";
import { PEOPLE } from "../vocabulary/world.js";

/**
 * THE FIVE HOSTILE SEQUENCES (the composer and the sign-out under another account), on the web bench where they
 * were first walked: two accounts in one browser. Each journey holds its GUARD FACTS alone, what must never happen:
 * a letter sent under the other account, one account's words shown or kept under the other, a second send, words
 * lost. Each holds the guard its expectations name: the composer's scope, its leaving save, the sign-out's sweep.
 */
const TOLERATED = [/status of 40[1349]/, /status of 424/, /SyncAbortedError/];
const MARK = /[AB]WORDS-[A-Z]+/;
/** The autosave's delay, twice: whatever a page would save has been saved. */
const SAVED = 4_000;

export const GUARDS: Guard[] = [
  { title: "H1: A's half letter and half reply, sign out, sign in as B in the same browser: nothing of A's is kept or shown under B, and A's letter is kept at A's server", rows: [], surfaces: WEB, needs: [], tolerates: TOLERATED },
  { title: "H1b: half a letter and half a reply in one tab, Sign out pressed in another: the first tab shows no mail and keeps none of A's words", rows: [], surfaces: WEB, needs: [], tolerates: TOLERATED },
  { title: "H2: a page on A while the jar turns to B: B's letter left by B's closed tab keeps B's words, and A's page writes nothing under B", rows: [], surfaces: WEB, needs: [], tolerates: TOLERATED },
  { title: "HS: a send held at the server while the jar turns to B: one send, nothing kept under B, and the letter's words still kept under A", rows: [], surfaces: WEB, needs: [], tolerates: TOLERATED },
  // WAITS: the consent switch stands in Settings' Folders pane, which mount-settings brings.
  { title: "H5: a consent press answered after the jar turned to B: the answer is A's alone, and the stale page's second press asks nothing of B", rows: ["settings-folders-not-mounted"], surfaces: WEB, needs: [], tolerates: TOLERATED, open: true },
];

async function two(b: Bench): Promise<{ A: Account; B: Account; namedA: string; namedB: string }> {
  const A = await b.account();
  await A.planter.plant({ conversations: [{ from: PEOPLE.ben, subject: "Kiln is fixed", pile: "ohbox", unread: false }] });
  const B = await b.account();
  await B.planter.plant({ conversations: [{ from: PEOPLE.giulia, subject: "Tiles for the hall", pile: "ohbox", unread: false }] });
  return { A, B, namedA: "Ben Arnold: Kiln is fixed", namedB: "Giulia Ferrari: Tiles for the hall" };
}
async function halfReply(p: Person, named: string, words: string): Promise<void> {
  await p.arrive("ohbox");
  await p.act("press", "conversation", { named });
  await p.act("press", "reply");
  await p.act("write", "reply-body", { value: words });
}
async function halfLetter(p: Person, subject: string, words: string): Promise<void> {
  await p.arrive("compose");
  await p.act("type", "compose-to", { value: "ben@lichtgrat.example" });
  await p.act("type", "compose-subject", { value: subject });
  await p.act("write", "compose-body", { value: words });
}
/** The stored keys holding a marker word of `who`'s (A or B). */
const holdingWordsOf = (kept: Record<string, string[]>, who: "A" | "B"): string[] =>
  Object.entries(kept).filter(([, marks]) => marks.some((m) => m.startsWith(`${who}WORDS`))).map(([k]) => k);
const naming = (kept: Record<string, string[]>, a: Account): string[] => Object.keys(kept).filter((k) => k.includes(a.accountId));
/**
 * A's letters, as A's server holds them: the far end of "no words lost". Its drafts reach a browser through the sync
 * feed (there is no list of drafts to ask for), asked from a session of A's own: the browser's ended with its sign-out.
 */
async function draftsOf(b: Bench, a: Account): Promise<string> {
  const { status, body } = await b.ask(a, "GET", "/sync?types=draft&limit=500", { session: "fresh" });
  expect(status, "the account's drafts").toBe(200);
  return JSON.stringify(body);
}
async function signOut(p: Person): Promise<void> {
  await p.arrive("settings-account");
  await p.act("press", "sign-out");
}

journeysOf("compose", () => {
  journey(GUARDS[0]!, async (b) => {
    const { A, B, namedA, namedB } = await two(b);
    const p = await b.person({ account: A, clock: "driven" });
    await halfReply(p, namedA, "AWORDS-REPLY half written");
    await halfLetter(p, "AWORDS-SUBJECT", "AWORDS-LETTER half written");
    await p.later(SAVED);
    await signOut(p);
    await p.gone("rail", {}, 60_000);
    expect(holdingWordsOf(await p.kept(MARK), "A"), "a key this browser keeps with A's words after A signed out").toEqual([]);
    expect(await draftsOf(b, A), "A's half letter at A's server").toContain("AWORDS-LETTER");
    await b.signedInElsewhere(p, B);
    await p.front();
    await p.here("ohbox");
    await p.arrive("compose");
    expect(await p.holds("compose-subject"), "B's letter's subject").toBe("");
    expect(await p.text("compose-body"), "B's letter's words").toBe("");
    await halfReply(p, namedB, "BWORDS-REPLY");
    expect(await p.shows("AWORDS"), "A's words on B's page").toBe(false);
    await p.later(SAVED);
    const asB = await p.kept(MARK);
    expect(holdingWordsOf(asB, "A"), "a key holding A's words while B is signed in").toEqual([]);
    expect(naming(asB, A), "a key of A's while B is signed in").toEqual([]);
    expect(Object.keys(asB).filter((k) => /[.:]local(?:[.:]|$)/.test(k)), "a key of no account").toEqual([]);
  });

  journey(GUARDS[1]!, async (b) => {
    const { A, namedA } = await two(b);
    const p = await b.person({ account: A, clock: "driven" });
    await halfReply(p, namedA, "AWORDS-REPLY half written");
    await halfLetter(p, "AWORDS-SUBJECT", "AWORDS-LETTER half written");
    await p.later(SAVED);
    const other = await p.tab();
    await signOut(other);
    await p.gone("rail", {}, 60_000);
    await other.gone("rail", {}, 60_000);
    expect(holdingWordsOf(await p.kept(MARK), "A"), "a key this browser keeps with A's words after A signed out").toEqual([]);
    expect(await draftsOf(b, A), "A's half letter at A's server").toContain("AWORDS-LETTER");
  });

  journey(GUARDS[2]!, async (b) => {
    const { A, B } = await two(b);
    const p = await b.person({ account: A, clock: "driven" });
    const slot = `ohmail.ui.compose.${B.accountId}`;
    await p.keep(slot, JSON.stringify({ to: "giulia@lichtgrat.example", cc: "", bcc: "", subject: "BWORDS-SUBJECT", body: "BWORDS-HANDOFF" }));
    await halfLetter(p, "AWORDS-SUBJECT", "AWORDS-ONE");
    await p.later(SAVED);
    await b.signedInElsewhere(p, B);
    await p.act("write", "compose-body", { value: " AWORDS-TWO" });
    await p.later(SAVED);
    await p.later(SAVED);
    const kept = await p.kept(MARK);
    expect(kept[slot], "B's letter as B's closed tab left it").toEqual(["BWORDS-HANDOFF", "BWORDS-SUBJECT"]);
    expect(naming(kept, B).filter((k) => k !== slot), "a key of B's that A's page wrote").toEqual([]);
    expect(holdingWordsOf(kept, "A").filter((k) => k.includes(B.accountId)), "A's words under a key of B's").toEqual([]);
  });

  journey(GUARDS[3]!, async (b) => {
    const { A, B } = await two(b);
    const p = await b.person({ account: A, clock: "driven" });
    const isSend = (m: string, pat: string): boolean => m === "POST" && (pat === "/drafts/:id/send" || pat === "/drafts/:id/send-attempt");
    const hold: DoorFault = (m, pat) => (isSend(m, pat) ? "hold" : null);
    await halfLetter(p, "AWORDS-SUBJECT", "AWORDS-SEND");
    await p.until(async () => !(await p.spoken("compose-send")).disabled, "Send to be offered");
    const from = b.heard.length;
    b.faults.push(hold);
    await p.act("press", "compose-send");
    await p.until(async () => b.held().length > 0, "the send asked and held", 30_000);
    await b.signedInElsewhere(p, B);
    b.release();
    await p.later(SAVED);
    expect(b.heard.slice(from).filter((h) => isSend(h.method, h.pattern)).length, "sends asked for one press").toBe(1);
    const kept = await p.kept(MARK);
    expect(naming(kept, B), "a key of B's that A's page wrote").toEqual([]);
    expect(holdingWordsOf(kept, "A").some((k) => k.includes(A.accountId)), "the letter's words still kept under A").toBe(true);
    const tab = await p.tab();
    await tab.arrive("ohbox");
    expect(await tab.shows("AWORDS"), "A's words on B's page").toBe(false);
  });

  journey(GUARDS[4]!, async (b) => {
    const { A, B } = await two(b);
    const p = await b.person({ account: A });
    await p.arrive("settings-folders");
    const before = await b.ask(B, "GET", "/consent/settings");
    b.faults.push((m, pat) => (m === "PATCH" && pat === "/consent/settings" ? "hold" : null));
    await p.act("press", "folders-switch");
    await p.until(async () => b.held().length > 0, "the consent press asked and held", 30_000);
    await b.signedInElsewhere(p, B);
    b.release();
    await p.until(async () => b.held().length === 0, "the consent answer applied");
    const kept = await p.kept(MARK);
    expect(Object.keys(kept).filter((k) => k.includes("consent") && k.includes(B.accountId)), "a consent answer kept under B").toEqual([]);
    const from = b.heard.length;
    await p.act("press", "folders-switch");
    expect(b.heard.slice(from).filter((h) => h.pattern === "/consent/settings"), "the stale page's second press").toEqual([]);
    expect((await b.ask(B, "GET", "/consent/settings")).body, "B's settings at B's server").toEqual(before.body);
  });
});
