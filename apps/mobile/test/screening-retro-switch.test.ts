/**
 * THE PAST-MAIL SWITCH GATES THE DISPATCH, NOT A LABEL.
 *
 * "Also move the mail already in your mailbox" is a control, and a control that says "do not do
 * X" prevents X. Turned off, the screening sheet's sentence promises that mail already here stays
 * where it is; the sheet used to dispatch a `move` for up to 50 of the sender's messages anyway,
 * in BOTH branches of the ladder (a sender still waiting at the gate, and one past it) — so a
 * person's own filing was undone by a switch they had turned off.
 *
 * Measured on the real wire, through the same `bootEngine` composition the app runs: what the
 * phone dispatches is what reaches `POST /messages/:id/move`. A move would be unawaited, so every
 * zero arm waits the whole settle window before it reads — a zero read without that window is
 * green for nothing. ON asks the server's pass instead (THE-CLIENTS-FIFTY). On either position the
 * press files the one letter it was made on (RULE-FILED-MESSAGE-SNAPS-BACK-TO-OHBOX), never more.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, type LiveWorldActions } from "../src/state/live";
import { Copy } from "../src/copy";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })(),
};

const SENDER = { name: "Ledger", address: "ledger@shop.test" };

async function liveOn(fake: ReturnType<typeof mailServer>, origin: string) {
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const toasts: string[] = [];
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine,
    toast: (m) => toasts.push(sayArg(m)),
    uuid: deps.uuid,
    zone: "UTC",
  });
  return { ...boot, actions, toasts };
}

/** Every `POST /messages/:id/move` the phone put on the wire. */
const moves = (fake: ReturnType<typeof mailServer>): string[] =>
  fake.seen.filter((r) => r.method === "POST" && /^\/messages\/[^/]+\/move$/.test(r.url)).map((r) => r.url);

/**
 * The settle window the unawaited moves need. `want` is what the ON arm expects; the zero arms
 * pass `Infinity`, which can never be reached, so they wait the WHOLE window before reading —
 * the same wall clock the ON arm proves is enough.
 */
async function settleMoves(fake: ReturnType<typeof mailServer>, want: number, ms = 1500): Promise<void> {
  const until = Date.now() + ms;
  while (moves(fake).length < want && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
}

/** A sender past the gate with `n` messages in the INBOX and no rule of their own. */
async function pastTheGate(n: number) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  for (let i = 1; i <= n; i += 1) {
    // Distinct instants, built by `Date` rather than spliced into an ISO template: an expression
    // ending right before the time part reads to a source scanner as a letters-and-digits id.
    const at = new Date(Date.UTC(2026, 7, 10 + (i % 9), 8, i % 60)).toISOString();
    fake.addMessage(dto(`p${i}`, { subject: `Receipt ${i}`, from: SENDER, date: at }));
  }
  const live = await liveOn(fake, origin);
  return { fake, live };
}

describe("the switch OFF: the rule is written and only the letter pressed on moves", () => {
  it("a sender past the gate — only the letter pressed on moves, and the rule still lands", async () => {
    const { fake, live } = await pastTheGate(3);
    expect(await live.actions.screenSender("p1", "reads", "sender", false)).toBe(true);
    // The durable half DID happen: the person asked for a rule and got one.
    expect(fake.seen.filter((r) => r.method === "POST" && r.url === "/rules")).toHaveLength(1);
    await settleMoves(fake, Infinity);
    // The half they declined did not: the rest of their mail stays.
    expect(moves(fake)).toEqual(["/messages/p1/move"]);
    live.store.close();
    fake.server.close();
  });

  it("a sender still WAITING at the gate — the decide fires, the mail past the gate stays put", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addMessage(dto("g1", { from: SENDER, folder: "ohmail/Screener" }));
    fake.addMessage(dto("g2", { from: SENDER, folder: "INBOX", date: "2026-08-18T08:00:00Z" }));
    const live = await liveOn(fake, origin);
    expect(await live.actions.screenSender("g1", "reads", "sender", false)).toBe(true);
    // The decision itself is not the retroactive half — it is what the person pressed, and it
    // carries the answer they gave.
    const decides = fake.seen.filter((r) => r.method === "POST" && r.url === "/screener/g1");
    expect(decides).toHaveLength(1);
    expect((JSON.parse(decides[0]!.body) as { applyRetro?: boolean }).applyRetro).toBe(false);
    await settleMoves(fake, Infinity);
    // `g2` left the gate long ago and is the person's own mail: it is not moved beside the decide.
    expect(moves(fake)).toEqual([]);
    live.store.close();
    fake.server.close();
  });

  it("the sentence the OFF switch shows is true of what the OFF switch does", async () => {
    // The claim under test, in the deck the phone renders: the letter pressed on moves now, the rest stays.
    expect(Copy.screeningNote("ledger@shop.test")).toContain("This message moves there now");
    expect(Copy.screeningNote("ledger@shop.test")).toContain("The rest of their mail here stays where it is");
    expect(Copy.screeningNote("ledger@shop.test"), "a promise the press breaks").not.toContain("Mail already here stays where it is");
    const { fake, live } = await pastTheGate(2);
    expect(await live.actions.screenSender("p1", "receipts", "sender", false)).toBe(true);
    await settleMoves(fake, Infinity);
    expect(moves(fake)).toEqual(["/messages/p1/move"]);
    live.store.close();
    fake.server.close();
  });
});

describe("the switch ON: the rule asks the pass, and the phone moves only the letter pressed on", () => {
  /* THE-CLIENTS-FIFTY: the ON arm used to move up to 50 of the mail already here from the phone,
     chosen by a predicate that cannot see a reply or a hand filing. The pass alone moves it now,
     so the ON arm's proof is the answer on the wire, and its zero reads wait the same window. */
  it("a sender past the gate — the rule carries the past-mail answer, and no backlog move leaves the phone", async () => {
    const { fake, live } = await pastTheGate(3);
    expect(await live.actions.screenSender("p1", "reads", "sender", true)).toBe(true);
    const creates = fake.seen.filter((r) => r.method === "POST" && r.url === "/rules");
    expect(creates).toHaveLength(1);
    expect((JSON.parse(creates[0]!.body) as { applyRetro?: boolean }).applyRetro).toBe(true);
    await settleMoves(fake, Infinity);
    expect(moves(fake)).toEqual(["/messages/p1/move"]);
    live.store.close();
    fake.server.close();
  });

  it("however much mail there is — the bound was the phone's, and the phone moves none of the backlog", async () => {
    const { fake, live } = await pastTheGate(56);
    expect(await live.actions.screenSender("p1", "reads", "sender", true)).toBe(true);
    await settleMoves(fake, Infinity);
    expect(moves(fake)).toEqual(["/messages/p1/move"]);
    live.store.close();
    fake.server.close();
  });

  it("the waiting branch decides the held row and carries the answer; the mail past the gate is the pass's", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addMessage(dto("g1", { from: SENDER, folder: "ohmail/Screener" }));
    fake.addMessage(dto("g2", { from: SENDER, folder: "INBOX", date: "2026-08-18T08:00:00Z" }));
    const live = await liveOn(fake, origin);
    expect(await live.actions.screenSender("g1", "reads", "sender", true)).toBe(true);
    const decides = fake.seen.filter((r) => r.method === "POST" && r.url === "/screener/g1");
    expect(decides).toHaveLength(1);
    expect((JSON.parse(decides[0]!.body) as { applyRetro?: boolean }).applyRetro).toBe(true);
    await settleMoves(fake, Infinity);
    expect(moves(fake)).toEqual([]);
    live.store.close();
    fake.server.close();
  });
});

describe("one boolean, two readers — the label and the dispatch cannot drift apart", () => {
  const SHEET = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src/ui/MessageActions.tsx"),
    "utf8",
  );

  it("the sheet holds ONE past-mail state and hands it to the sentence and to the dispatch", () => {
    // One declaration, so there is one fact on this sheet, not two that can disagree.
    expect(SHEET.match(/setApplyRetro\] = useState\(/g) ?? []).toHaveLength(1);
    // The sentence reads it…
    expect(SHEET).toContain("applyRetro ? Copy.screeningNoteRetro(target) : Copy.screeningNote(target)");
    // …the switch's own label and checked state read it…
    expect(SHEET).toContain("accessibilityState={{ checked: applyRetro }}");
    // …and the press that files the mail carries the SAME value to the world.
    expect(SHEET).toContain("w.actions.screenSender(m.id, dest, scope, applyRetro)");
  });

  it("the deck's two sentences are the two answers, and the ON one names what the pass leaves alone", () => {
    const off = Copy.screeningNote("ledger@shop.test");
    const on = Copy.screeningNoteRetro("ledger@shop.test");
    expect(off).not.toBe(on);
    // The OFF sentence promises nothing about the rest of the past beyond leaving it alone.
    expect(off).toContain("The rest of their mail here stays where it is");
    // The ON sentence is the pass's: it applies the rule and leaves the person's own acts alone.
    // The phone moves only the letter pressed on, so no count of moves "now" may be claimed.
    expect(on).toContain("applies the rule to the rest of the mail it has already filed for you");
    // A filing the person made stays, here (`decided_at`, which the pass leaves) or in another mail app.
    expect(on).toContain("replied to, filed yourself here or in another mail app, or set aside are left alone");
    expect(on).not.toContain("50");
  });
});
