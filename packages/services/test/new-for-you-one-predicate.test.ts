import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { mailboxes, messageStates, messages, threads } from "@trafficflow/db";
import { MessageService, TriageService } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/* @reads: packages/services/src/
   Walks the package's source by a path built at runtime, so no landing pass selects this file when
   a reader there moves; the shape `reads-list.mjs` exists for. */

/**
 * ONE "NEW FOR YOU" PREDICATE — THE SCREEN'S, IMPORTED BY THE ACT OVER IT.
 *
 * `GET /views/power-through` walks the group the Ohbox shows under "New for you", one message at
 * a time. It spelled three predicates of its own — this account, unread, desired folder INBOX —
 * which is NEITHER the screen it claims to read NOR bounded by it: it served and counted
 * tombstoned mail, and every message the reader had already parked or resurfaced, none of which
 * is on the screen the button exists to clear..
 *
 * The parity below is asserted BY IMPORT: both readers call `newForYouFilters`, so this file
 * measures that the two answers agree over a world built to make the OLD spellings disagree —
 * one parked, one resurfaced, one tombstoned, one read, one in another folder. A test that
 * seeded only plain unread INBOX mail would pass against either implementation, which is how the
 * defect survived: `triage-service.test.ts` had a parked message among Power Through's answers
 * written down as expected behaviour.
 */
const msgs = new MessageService();
const triage = new TriageService();

/** Every id the group holds, walked to the end through the view's own cursor. */
async function newForYouIds(ctx: Parameters<typeof msgs.list>[0]): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await msgs.list(ctx, { view: "new_for_you", limit: 50, ...(cursor ? { cursor } : {}) });
    out.push(...page.items.map((m) => m.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return out;
}

/** Every id Power Through walks, by advancing its cursor exactly as a surface does. */
async function powerThroughIds(ctx: Parameters<typeof triage.powerThrough>[0]): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  // Bounded by the seeded world; a runaway cursor is a failure, never a hang.
  for (let i = 0; i < 50; i++) {
    const view = await triage.powerThrough(ctx, cursor ? { cursor } : {});
    if (!view.current) break;
    out.push(view.current.id);
    if (!view.nextCursor) break;
    cursor = view.nextCursor;
  }
  return out;
}

describe("Power Through reads the screen's own predicate", () => {
  it("answers exactly the New-for-you group over a world the old spelling got wrong", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const seed = (o: Record<string, unknown>) =>
      seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX", unread: true, ...o });

    // IN the group: plain unread INBOX mail, nothing said about it.
    const plain = await seed({ from: "plain@example.com" });
    const plain2 = await seed({ from: "plain2@example.com" });

    // OUT, and each one the old predicate answered WITH.
    const parked = await seed({ from: "parked@example.com" });
    await triage.setState(ctx, parked, { state: "reply_later" });
    const setAside = await seed({ from: "aside@example.com" });
    await triage.setState(ctx, setAside, { state: "set_aside" });
    const scheduled = await seed({ from: "later@example.com" });
    await triage.bubbleUp(ctx, scheduled, "2026-12-01T09:00:00.000Z");
    const back = await seed({ from: "back@example.com" });
    await triage.resurfaceNow(ctx, back);
    const gone = await seed({ from: "gone@example.com" });
    await db.update(messages).set({ deletedAt: new Date("2026-07-28T10:00:00Z") }).where(eq(messages.id, gone));

    // OUT, and the old predicate agreed: read mail, and mail filed elsewhere.
    await seed({ from: "read@example.com", unread: false });
    await seed({ from: "filed@example.com", desired: "ohmail/News" });

    // `muted` is deliberately NOT an exclusion — no Ohbox group holds it out, and a census that
    // admitted one more state than the screen does would be the same defect with a longer list.
    const muted = await seed({ from: "muted@example.com" });
    await triage.mute(ctx, muted);

    const screen = await newForYouIds(ctx);
    const act = await powerThroughIds(ctx);

    expect([...screen].sort()).toEqual([plain, plain2, muted].sort());
    // THE PARITY. Not "both are non-empty": the same SET, both walked to the end.
    expect([...act].sort()).toEqual([...screen].sort());
    for (const out of [parked, setAside, scheduled, back, gone]) {
      expect(act).not.toContain(out);
    }

    // And the count the surface states is the size of that set, never of the unread pile.
    const first = await triage.powerThrough(ctx, {});
    expect(first.remaining).toBe(screen.length);
  });

  it("an empty group answers nothing, and the screen agrees", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const only = await seedMessage(db, accountId, mailboxId, {
      folder: "INBOX", desired: "INBOX", unread: true, from: "one@example.com",
    });
    await triage.setState(ctx, only, { state: "set_aside" });

    expect(await newForYouIds(ctx)).toEqual([]);
    const view = await triage.powerThrough(ctx, {});
    expect(view.current).toBeNull();
    expect(view.remaining).toBe(0);
    expect(view.nextCursor).toBeNull();
  });
});

/**
 * "EARLIER" IS THE SAME PREDICATE WITH THE OTHER UNREAD VALUE. `previously_seen` kept the generic
 * view filter, so read mail the person had parked, set aside, scheduled or resurfaced was listed
 * under Earlier while the Ohbox shows it in its pile or pinned above the group.
 */
describe("the read half of the Imbox holds out what the unread half does", () => {
  it("previously_seen lists plain and muted read mail, never parked, set-aside, scheduled or resurfaced", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const seed = (from: string) =>
      seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX", unread: false, from });
    const plain = await seed("plain@example.com");
    const muted = await seed("muted@example.com");
    const held: string[] = [];
    for (const state of ["reply_later", "set_aside", "bubbled_up", "resurfaced"] as const) {
      const id = await seed(`${state}@example.com`);
      await db.insert(messageStates).values({ accountId, messageId: id, state });
      held.push(id);
    }
    await db.insert(messageStates).values({ accountId, messageId: muted, state: "muted" });
    // The other half's mail, as the control that this is a read-only list.
    await seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX", unread: true, from: "new@example.com" });

    const page = await msgs.list(ctx, { view: "previously_seen", limit: 50 });
    expect(page.items.map((m) => m.id).sort()).toEqual([plain, muted].sort());
    for (const id of held) expect(page.items.map((m) => m.id)).not.toContain(id);
  });
});

/**
 * THE FOLD KNOWS SENT BY THE MAILBOX'S RECORDED NAME. A parked conversation whose only letter after
 * the pin is the person's own reply, filed in the Sent folder the attach recorded ('Envoyés'), is
 * not pulled forward, so its other unread member stays in New for you as the client shows it.
 * MUTATION WATCHED: drop the recorded folder from `foldMemberOf` and the reply reads as somebody's.
 */
describe("New for you folds with the mailbox's recorded Sent folder", () => {
  async function world(sentFolder: string | null) {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    await db.update(mailboxes).set({ sentFolder }).where(eq(mailboxes.id, mailboxId));
    const [t] = await db.insert(threads).values({ accountId, subject: "plans" }).returning();
    const seed = (o: Record<string, unknown>) => seedMessage(db, accountId, mailboxId, { folder: "INBOX", ...o });
    const pin = await seed({ from: "a@example.com", unread: false, date: new Date("2026-07-01T09:00:00Z") });
    const other = await seed({ from: "b@example.com", unread: true, date: new Date("2026-07-05T09:00:00Z") });
    const reply = await seed({ folder: "Envoyés", from: "mila@lichtgrat.example", unread: false, date: new Date("2026-07-20T09:00:00Z") });
    for (const id of [pin, other, reply]) await db.update(messages).set({ threadId: t!.id }).where(eq(messages.id, id));
    await db.insert(messageStates).values({
      accountId, messageId: pin, state: "bubbled_up",
      setAt: new Date("2026-07-10T09:00:00Z"), bubbleUpAt: new Date("2026-12-01T09:00:00Z"),
    });
    return { ids: await newForYouIds(ctx), other };
  }

  it("the own reply in a recorded 'Envoyés' pulls nothing forward: the other unread member stays", async () => {
    const { ids, other } = await world("Envoyés");
    expect(ids).toEqual([other]);
  });

  it("control: with nothing recorded, 'Envoyés' is somebody's folder and the conversation is pulled forward", async () => {
    const { ids } = await world(null);
    expect(ids).toEqual([]);
  });
});

/**
 * AND NOTHING SPELLS IT TWICE.
 *
 * The parity above is only as durable as "there is one definition": a reader that rebuilt the
 * conjunction inline would pass every behavioural case on the day it was written and drift the
 * first time an exclusion moved. So this counts the spellings in the scanned root.
 *
 * MEASURED BEFORE IT WAS BUILT: at this commit `packages/services/src` holds the conjunction
 * exactly once (`message-service.ts#newForYouFilters`) and `eq(messages.unread, true)` nowhere
 * else at all.
 */
const SRC = join(fileURLToPath(new URL("../src", import.meta.url)));
const OWNER = "message-service.ts";

/** Every `.ts` under the scanned root, recursively — the root is named, and so are its skips. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    // No skips: this package's `src` is source only — no build output, no fixtures.
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("the New-for-you predicate has one home", () => {
  const files = sources(SRC);

  it("scans a root that is really there", () => {
    // A census's zero is a reading only beside a positive control: this one proves the walk
    // found the file the answer lives in, so an empty scan cannot read as a clean result.
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith(OWNER))).toBe(true);
  });

  it("names the unread half in exactly one file, and that file is the owning module", () => {
    const hits = files.filter((f) => /eq\(\s*messages\.unread\s*,\s*(true|VIEW_UNREAD)/.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => f.slice(SRC.length + 1))).toEqual([OWNER]);
  });

  it("names the INBOX desired folder in no reader but the owning module", () => {
    const hits = files.filter((f) =>
      /desiredFolder\s*,\s*["']INBOX["']/.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });

  it("the act imports the predicate rather than restating it", () => {
    const act = readFileSync(join(SRC, "triage-service.ts"), "utf8");
    expect(act).toContain("newForYouFilters");
    expect(act).toMatch(/import \{ newForYouFilters \} from "\.\/message-service\.js";/);
    /* The three it used to spell are gone — it composes nothing of its own onto the imported
       set except the cursor. `unread = true` and not `messages.unread` at large: this file
       legitimately guards an UPDATE on `unread = false` (un-parking re-homes a READ row), and a
       needle that refused that would refuse a correct line — measured, it is the only other
       mention in the file. */
    expect(act).not.toMatch(/eq\(\s*messages\.unread\s*,\s*true/);
    expect(act).not.toMatch(/desiredFolder\s*,\s*["']INBOX["']/);
  });
});
