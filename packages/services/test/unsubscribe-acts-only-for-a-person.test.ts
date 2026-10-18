import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  applyScreenerDecision, folderState, messageBodies, readDrainCursor, rules, UNSUB_DRAIN_PASS,
} from "@trafficflow/db";
import { carryDialect } from "@trafficflow/db/dialect";
import { makeProfileDoc, profileFingerprint } from "@trafficflow/core/adapters/organizer-profile";
import { applyOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import {
  makeUnsubscribeService, ServiceError, type HostResolver, type OneClickPost,
} from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * UD-R4-03 — THE AUTOMATIC UNSUBSCRIBE ACTS ONLY FOR A SENDER A PERSON SCREENED OUT. Three rows
 * sit in Screened inside the drain's window, each publishing a one-click route: one sender a
 * person screened out, one the auto-act pass filed through the same apply, one an import adopted
 * with no rule at all. Runs on both stores (the sqlite project lists this file). No socket.
 */

const PUBLIC_DNS: HostResolver = { async resolve() { return ["93.184.216.34"]; } };
/**
 * The position a Gmail-held mailbox trusts (`providerAuthservIds`); every letter below carries that
 * provider's confirmation of its sender, so the licence is what each case decides on.
 */
const GMAIL: ReadonlySet<string> = new Set(["mx.google.com"]);
const NOW = new Date("2026-07-28T12:00:00Z");
const secondsAgo = (s: number): Date => new Date(NOW.getTime() - s * 1000);

function spy(): OneClickPost & { calls: string[] } {
  const calls: string[] = [];
  return { calls, async post(url: string) { calls.push(url); return { status: 200 }; } };
}

const svcWith = (post: OneClickPost) =>
  makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => GMAIL });

type Ctx = Awaited<ReturnType<typeof makeCtx>>;

const oneClick = (host: string) => ({
  "list-unsubscribe": [`<https://${host}/u?t=abc>`],
  "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
  "authentication-results": ["mx.google.com; dmarc=pass"],
});

/** Held at the gate, then decided `no` through the one apply — by a person or by the auto-act pass. */
async function decided(w: Ctx, host: string, decidedBy: "person" | "pass", at: Date): Promise<string> {
  const from = `news@${host}`;
  const id = await seedMessage(w.db, w.accountId, w.mailboxId, { from, folder: "ohmail/Screener" });
  await w.db.insert(messageBodies).values({ messageId: id, text: "", headers: oneClick(host) });
  await w.db.transaction((tx) => applyScreenerDecision(carryDialect(w.db, tx), {
    accountId: w.accountId, scope: "sender", address: from, appliedFolder: "ohmail/Screened",
    decision: "no", triggeringActionId: `screener:${id}`, now: NOW, stampBaseline: false, decidedBy, overExisting: "converge",
  }));
  await w.db.update(folderState).set({ updatedAt: at }).where(eq(folderState.messageId, id));
  return id;
}

/** Found already in Screened by an import: adopted as it stands, no decision, no rule. */
async function adopted(w: Ctx, host: string, at: Date): Promise<string> {
  const id = await seedMessage(w.db, w.accountId, w.mailboxId, { from: `news@${host}`, folder: "ohmail/Screened" });
  await w.db.update(folderState).set({ lastSetBy: "external", updatedAt: at }).where(eq(folderState.messageId, id));
  await w.db.insert(messageBodies).values({ messageId: id, text: "", headers: oneClick(host) });
  return id;
}

/** The person's row is the NEWEST, so a walk that takes it has read past the other two. */
async function world() {
  const w = await makeCtx(NOW);
  const adoptedId = await adopted(w, "adopted.example", secondsAgo(30));
  const autoAct = await decided(w, "auto-act.example", "pass", secondsAgo(20));
  const person = await decided(w, "person.example", "person", secondsAgo(10));
  return { w, person, autoAct, adoptedId };
}

describe("the automatic unsubscribe acts only for a sender a person screened out", () => {
  it("the apply stamps the rule a person's decision promotes, and not the auto-act pass's", async () => {
    const { w } = await world();
    const stamp = async (match: string) => (await w.db.select({ at: rules.personDecidedAt }).from(rules)
      .where(and(eq(rules.accountId, w.accountId), eq(rules.match, match))))[0]!.at;
    expect(await stamp("news@person.example"), "a person's decision is stamped").not.toBeNull();
    expect(await stamp("news@auto-act.example"), "the auto-act pass's is not").toBeNull();
  });

  it("the drain reads all three, sends exactly once, and its cursor ends past them", async () => {
    const { w, person } = await world();
    const post = spy();
    const svc = svcWith(post);
    const run = await svc.drainScreenedOut(w.db, { now: () => NOW, requestId: "d1", accounts: 1, perAccount: 1 });
    expect(post.calls, "only the list a person screened out is left").toEqual(["https://person.example/u?t=abc"]);
    // The walk's own flag: the two unlicensed rows are read past, never handed to the seam.
    expect(run.sweep.considered).toBe(1);
    const cursor = await readDrainCursor(w.db as never, UNSUB_DRAIN_PASS);
    expect(cursor?.messageId, "the cursor stands on the newest row, past the other two").toBe(person);
    const again = await svc.drainScreenedOut(w.db, { now: () => NOW, requestId: "d2" });
    expect(again.sweep.considered, "and nothing is owed afterwards").toBe(0);
    expect(again.remaining).toBe(0);
  });

  it("the seam refuses the automatic arm without a person's rule, and the button is unchanged", async () => {
    const { w, person, autoAct, adoptedId } = await world();
    const post = spy();
    const svc = svcWith(post);
    // Past the drain's flag: `run` is the one body every automatic entry point reaches.
    const run = (svc as unknown as {
      run(ctx: Ctx["ctx"], id: string, mode: "manual" | "automatic"): Promise<unknown>;
    }).run.bind(svc);
    for (const id of [autoAct, adoptedId]) {
      const err = await run(w.ctx, id, "automatic").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe("unsubscribe_not_person_decided");
    }
    expect(post.calls, "nothing is sent for a sender nobody screened out").toEqual([]);
    expect((await svc.onScreenOut(w.ctx, [person])).posted, "a person's screen-out still leaves its list").toBe(1);
    const manual = await svc.unsubscribe(w.ctx, autoAct);
    expect(manual.posted, "the positive control: a person pressing the button is the decision").toBe(true);
  });

  // The stamp is also a pause's mark (a person's pause makes a learned row theirs), so the licence
  // reads `enabled` beside it: a paused screen-out sends nothing in the person's name.
  it("a paused rule a person screened out licenses nothing, and the licence returns with the rule", async () => {
    const { w, person } = await world();
    const personRule = and(eq(rules.accountId, w.accountId), eq(rules.match, "news@person.example"));
    const paused = await w.db.update(rules).set({ enabled: false }).where(personRule).returning({ at: rules.personDecidedAt });
    expect(paused.map((r) => r.at !== null), "the paused row still carries the person's stamp").toEqual([true]);
    const post = spy();
    const svc = svcWith(post);
    const run = (svc as unknown as {
      run(ctx: Ctx["ctx"], id: string, mode: "manual" | "automatic"): Promise<unknown>;
    }).run.bind(svc);
    const sweep = await svc.drainScreenedOut(w.db, { now: () => NOW, requestId: "p1", accounts: 1, perAccount: 1 });
    expect(sweep.sweep.considered, "the drain took a paused screen-out as licensed").toBe(0);
    const err = await run(w.ctx, person, "automatic").catch((e: unknown) => e);
    expect((err as ServiceError).code, "the seam took a paused screen-out as licensed").toBe("unsubscribe_not_person_decided");
    expect(post.calls).toEqual([]);
    await w.db.update(rules).set({ enabled: true }).where(personRule);
    await run(w.ctx, person, "automatic");
    expect(post.calls, "the positive control: the same row switched on licenses again").toEqual(["https://person.example/u?t=abc"]);
  });

  // A profile import carries the stamp for learning's sake; it is not a decision made on this account.
  it("a screen-out a profile import carried licenses nothing, and the same press made here does", async () => {
    const w = await makeCtx(NOW);
    const host = "imported.example";
    const from = `news@${host}`;
    const id = await seedMessage(w.db, w.accountId, w.mailboxId, { from, folder: "ohmail/Screened" });
    await w.db.insert(messageBodies).values({ messageId: id, text: "", headers: oneClick(host) });
    await w.db.update(folderState).set({ updatedAt: secondsAgo(5) }).where(eq(folderState.messageId, id));
    const doc = makeProfileDoc({
      screener: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null,
      rules: [{
        kind: "sender", match: from, destination: "ohmail/Screened", priority: 0, enabled: true,
        provenance: "promoted", personDecidedAt: "2026-07-01T00:00:00.000Z",
      }],
    }, { updatedAt: NOW, producer: { kind: "local", version: "0.25.15" } });
    await w.db.transaction((tx) => applyOrganizerProfile(carryDialect(w.db, tx) as never, {
      accountId: w.accountId, mailboxId: w.mailboxId, doc, fingerprint: profileFingerprint(doc), now: NOW,
    }));
    const [imported] = await w.db.select({ at: rules.personDecidedAt, enabled: rules.enabled }).from(rules)
      .where(and(eq(rules.accountId, w.accountId), eq(rules.match, from)));
    expect(imported, "the import did not carry the stamp: the case measures nothing").toMatchObject({ enabled: true });
    expect(imported!.at).not.toBeNull();
    const post = spy();
    const svc = svcWith(post);
    const sweep = await svc.drainScreenedOut(w.db, { now: () => NOW, requestId: "i1", accounts: 1, perAccount: 1 });
    expect(sweep.sweep.considered, "the drain took an imported stamp as a licence").toBe(0);
    const run = (svc as unknown as {
      run(ctx: Ctx["ctx"], id: string, mode: "manual" | "automatic"): Promise<unknown>;
    }).run.bind(svc);
    const err = await run(w.ctx, id, "automatic").catch((e: unknown) => e);
    expect((err as ServiceError).code, "the seam took an imported stamp as a licence").toBe("unsubscribe_not_person_decided");
    expect(post.calls).toEqual([]);
    await w.db.transaction((tx) => applyScreenerDecision(carryDialect(w.db, tx), {
      accountId: w.accountId, scope: "sender", address: from, appliedFolder: "ohmail/Screened",
      decision: "no", triggeringActionId: `screener:${id}`, now: NOW, stampBaseline: false, decidedBy: "person", overExisting: "converge",
    }));
    await run(w.ctx, id, "automatic");
    expect(post.calls, "the positive control: the same press made on this account licenses").toEqual([`https://${host}/u?t=abc`]);
  });
});
