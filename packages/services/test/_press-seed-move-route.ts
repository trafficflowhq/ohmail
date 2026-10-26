import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { accounts, mailboxes, rules } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { LearningService, MessageService, RulesService, GRADUATION_THRESHOLD, type ServiceContext } from "../src/index.js";
import { seedMessage } from "./helpers.js";

/**
 * A SHEET PRESS'S OWN SEED MOVE IS NOT AN OVERRIDE OF THE ROUTE THAT PRESS REWRITES — the cases
 * `press-seed-move-keeps-the-route.test.ts` (PGlite) and its `.pg` twin both run. A learned
 * route files X to News; one hand move out of News stands. The press moves the seed to Receipts
 * (marked `pressRule`) before its PATCH: unmarked, that move was the route's second override and
 * switched the rule off, and the PATCH left it off.
 */
export type Db = Awaited<ReturnType<typeof makeTestDb>>;
export interface World { db: Db; accountId: string; mailboxId: string; ctx: ServiceContext }

const X = "shop@x.example";
const NEWS = "ohmail/News";
const RECEIPTS = "ohmail/Receipts";
const NOW = new Date("2026-10-20T12:00:00.000Z");
const learning = new LearningService();
const moves = new MessageService();
const rulesSvc = new RulesService();
let n = 0;

export async function world(given?: Db): Promise<World> {
  const db = given ?? await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `seedmove-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `box-${accountId.slice(0, 8)}@ex.test`,
    organizerRole: "organizer", organizeConsentedAt: NOW,
  }).returning();
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => NOW, requestId: "seedmove" };
  return { db, accountId, mailboxId: mb!.id, ctx };
}

/** The learned route: three approvals, then the promotion pass. Answers the promoted rule's id. */
export async function learnedRoute(w: World): Promise<string> {
  for (let i = 0; i < GRADUATION_THRESHOLD; i++) {
    await learning.record(w.ctx, {
      triggeringActionId: `seedmove:${n++}`, kind: "approval", senderAddress: X, destination: NEWS, label: "positive",
    });
  }
  await learning.promoteOrDemote(w.ctx, `sender:${X}→${NEWS}`);
  const [r] = await w.db.select({ id: rules.id }).from(rules).where(and(eq(rules.accountId, w.accountId), eq(rules.provenance, "promoted")));
  return r!.id;
}

/** A letter of X's the route filed to News. */
export const filedToNews = (w: World): Promise<string> =>
  seedMessage(w.db, w.accountId, w.mailboxId, { from: X, folder: NEWS, desired: NEWS });

/** One hand move of an X letter out of News: the route's first override. */
export async function handMoveOut(w: World): Promise<void> {
  await moves.move(w.ctx, await filedToNews(w), { folder: "INBOX" });
}

/** The press: the seed's move at the press, marked or not (an older client), then the rule's PATCH. */
export async function seedMove(w: World, seed: string, marked: boolean): Promise<void> {
  await moves.move(w.ctx, seed, { folder: RECEIPTS, ...(marked ? { pressRule: true } : {}) });
}
export const patchToReceipts = (w: World, ruleId: string): Promise<unknown> =>
  rulesSvc.update(w.ctx, ruleId, { destination: RECEIPTS, applyRetro: true });
export const undoSeed = (w: World, seed: string): Promise<unknown> => moves.move(w.ctx, seed, { folder: NEWS });

export async function ruleOf(w: World, id: string) {
  const [r] = await w.db.select({
    enabled: rules.enabled, destination: rules.destination, provenance: rules.provenance,
    demotions: rules.demotions, stamped: rules.personDecidedAt,
  }).from(rules).where(eq(rules.id, id));
  return { enabled: r!.enabled, destination: r!.destination, provenance: r!.provenance, demotions: r!.demotions, stamped: r!.stamped !== null };
}

export async function patchArm(w: World): Promise<void> {
  const ruleId = await learnedRoute(w);
  await handMoveOut(w);
  await seedMove(w, await filedToNews(w), true);
  expect(await ruleOf(w, ruleId), "the press's own move is no override").toMatchObject({ enabled: true, demotions: 0 });
  await patchToReceipts(w, ruleId);
  expect(await ruleOf(w, ruleId), "the PATCH leaves the rule on, at Receipts, the person's")
    .toMatchObject({ enabled: true, destination: RECEIPTS, provenance: "manual", demotions: 0 });
}

export async function undoArm(w: World): Promise<void> {
  const ruleId = await learnedRoute(w);
  await handMoveOut(w);
  const seed = await filedToNews(w);
  await seedMove(w, seed, true);
  await undoSeed(w, seed);
  expect(await ruleOf(w, ruleId), "Undo leaves the learned rule as it was")
    .toEqual({ enabled: true, destination: NEWS, provenance: "promoted", demotions: 0, stamped: false });
}

/**
 * THE CLAIMED PRESS TAKEN BACK: a press at the learned route's own place moves the seed the lift
 * kept in INBOX there, marked, and its Undo moves it back. The inverse is marked too
 * (`inverseMutations`): taking a press back is no correction of the route. Unmarked (the positive
 * control) it is the route's second override and switches the learned rule off.
 */
export async function claimedUndoArm(w: World, markedInverse: boolean): Promise<void> {
  const ruleId = await learnedRoute(w);
  await handMoveOut(w);
  const seed = await seedMessage(w.db, w.accountId, w.mailboxId, { from: X, folder: "INBOX", desired: "INBOX" });
  await moves.move(w.ctx, seed, { folder: NEWS, pressRule: true });
  await moves.move(w.ctx, seed, { folder: "INBOX", ...(markedInverse ? { pressRule: true } : {}) });
  expect(await ruleOf(w, ruleId), markedInverse ? "Undo leaves the learned rule as it was" : "unmarked, Undo demotes it")
    .toMatchObject(markedInverse ? { enabled: true, provenance: "promoted", demotions: 0 } : { enabled: false, demotions: 1 });
}

/** POSITIVE CONTROL: the same move unmarked (an older client) is the second override and demotes. */
export async function unmarkedDemotes(w: World): Promise<string> {
  const ruleId = await learnedRoute(w);
  await handMoveOut(w);
  await seedMove(w, await filedToNews(w), false);
  expect(await ruleOf(w, ruleId), "unmarked, the seed move is the route's second override")
    .toMatchObject({ enabled: false, demotions: 1 });
  return ruleId;
}

/** The belt for older clients: a PATCH naming a destination switches a demoted row back on. */
export async function beltArm(w: World): Promise<void> {
  const ruleId = await unmarkedDemotes(w);
  await patchToReceipts(w, ruleId);
  expect(await ruleOf(w, ruleId), "the press names a place: the rule files there, on")
    .toMatchObject({ enabled: true, destination: RECEIPTS, provenance: "manual" });
}

/** CONTROL: one override only, unmarked: the rule stays on and moves to Receipts. */
export async function oneOverrideArm(w: World): Promise<void> {
  const ruleId = await learnedRoute(w);
  await seedMove(w, await filedToNews(w), false);
  await patchToReceipts(w, ruleId);
  expect(await ruleOf(w, ruleId)).toMatchObject({ enabled: true, destination: RECEIPTS, demotions: 0 });
}

/** CONTROL: a person's pause stands under a destination PATCH. */
export async function pauseArm(w: World): Promise<void> {
  const ruleId = await learnedRoute(w);
  await rulesSvc.update(w.ctx, ruleId, { enabled: false });
  await patchToReceipts(w, ruleId);
  expect(await ruleOf(w, ruleId), "their pause stays").toMatchObject({ enabled: false, destination: RECEIPTS, stamped: true });
}

/** A marked move files the letter as the rule's, deciding no place of its own; a hand move decides one. */
export async function decidedArm(w: World): Promise<void> {
  const placeDecided = async (marked: boolean) => {
    const r = await moves.move(w.ctx, await filedToNews(w), { folder: RECEIPTS, ...(marked ? { pressRule: true } : {}) });
    return "dto" in r && r.dto.placeDecided === true;
  };
  expect([await placeDecided(true), await placeDecided(false)], "[marked, by hand]").toEqual([false, true]);
}
