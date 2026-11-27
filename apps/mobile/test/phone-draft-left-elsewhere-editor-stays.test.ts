/**
 * THE PHONE'S EDITOR STAYS ON A DRAFT ANOTHER DEVICE SENT OR DELETED. The route
 * re-asked the live Drafts list on every render, so the row leaving it (sent or deleted) swapped
 * the open sheet for "This draft can't be edited here" and the sheet's own handling never ran.
 * The route's decision is driven directly (`compose-route.ts`), the rows come off `liveDrafts`
 * over `bootEngine`'s real HttpAdapter against the fake, and the wiring is READ (no RN renderer).
 */
import type { EngineDraft } from "@ohmail/wire";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { keptRecipients, liveActions, liveDrafts, parseRecipients, type LiveWorldActions } from "../src/state/live";
import { composeDraftPlan, type ComposeDraftOpen } from "../src/ui/compose-route";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";
/* @reads: apps/mobile/src/ui/MessageActions.tsx, apps/mobile/app/compose.tsx */

const here = dirname(fileURLToPath(import.meta.url));
const SHEET = readFileSync(join(here, "../src/ui/MessageActions.tsx"), "utf8");
const ROUTE = readFileSync(join(here, "../app/compose.tsx"), "utf8");

const draftRow = (over: Record<string, unknown> = {}): EngineDraft => ({
  id: "d-9", mailboxId: "mb-1", threadId: null, inReplyToMessageId: null,
  subject: "Invoice 12", body: "the body", to: [{ name: "Ada", address: "ada@fake.test" }],
  cc: [], bcc: [], rationale: null, status: "draft",
  createdAt: "2026-09-01T09:00:00.000Z", updatedAt: "2026-09-20T14:29:00.000Z",
  ...over,
} as EngineDraft);

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };
const open: { close(): void }[] = [];
afterEach(() => { for (const o of open.splice(0)) o.close(); });

async function scene(row: EngineDraft = draftRow()) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
  fake.addMessage(dto("m1", { subject: "Welcome" }));
  fake.addDraft({ ...row } as unknown as Record<string, unknown> & { id: string });
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  await boot.engine.syncOnce();
  open.push({ close: () => { boot.store.close(); fake.server.close(); } });
  const toasts: string[] = [];
  const actions: LiveWorldActions = liveActions({ engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid, zone: "UTC" });
  /* The route's two reads, as the screen makes them: the Drafts list's row and the original. */
  const rowNow = () => liveDrafts(boot.engine.read(), { now: new Date(), zone: "UTC", locale: "en" }).find((d) => d.id === "d-9");
  const plan = (held: ComposeDraftOpen | null) => composeDraftPlan("d-9", held, rowNow(), () => undefined);
  return { fake, ...boot, actions, toasts, rowNow, plan };
}

type Live = Awaited<ReturnType<typeof scene>>;

/** The sheet's question, read as the sheet reads it; absent on a build without it, which says nothing. */
const leftOf = (live: Live, id: string) => (live.actions as Partial<LiveWorldActions>).draftLeft?.(id) ?? null;

/** The sheet opens: the route holds what it opened, and the sheet's first render sights its row. */
function openSheet(live: Live): ComposeDraftOpen {
  const first = live.plan(null);
  if (first.kind !== "sheet") throw new Error(`the route did not open the sheet: ${first.kind}`);
  expect(leftOf(live, "d-9"), "a live bound row read as gone").toBeNull();
  return first.open;
}

const typed = { to: "Ada <ada@fake.test>", subject: "Invoice 12", body: "the body, and a word typed after" };
const keep = (live: Live, draftId: string, rebound: string[]) => live.actions.draftKeep({
  mode: "new", messageId: null, mailboxId: "mb-1", to: keptRecipients(typed.to),
  subject: typed.subject, body: typed.body, files: 0, draftId, quiet: true,
  rebind: (id: string) => { rebound.push(id); },
} as never);
const sendBound = (live: Live, draftId: string | null) =>
  live.actions.sendNew("mb-1", parseRecipients(typed.to)!, typed.subject, typed.body, null, null, [], draftId);
const freshRows = (live: Live) => (live.fake.draftRows() as Array<{ id: string; body?: string }>).filter((r) => r.id !== "d-9");

describe.each([
  ["sent", (live: Live) => live.fake.sendElsewhere("d-9"), "replySentElsewhere"],
  ["deleted", (live: Live) => live.fake.deleteElsewhere("d-9"), "replyDeletedElsewhere"],
] as const)("a draft open in the phone's editor that another device %s", (word, elsewhere, refusal) => {
  it("the editor stays, says so, keeps what is typed as a new row, and Send offers a new letter", async () => {
    const live = await scene();
    const held = openSheet(live);
    elsewhere(live);
    await live.engine.syncOnce();
    expect(live.rowNow(), "the row is still in the Drafts list").toBeUndefined();
    expect(live.plan(held).kind, "the open editor was torn down").toBe("sheet");
    expect(live.actions.draftLeft("d-9")).toBe(word);
    const rebound: string[] = [];
    expect(await keep(live, "d-9", rebound), "the words typed after were dropped").toBe("kept");
    expect({ fresh: freshRows(live).map((r) => r.body), rebound: rebound.length }).toEqual({ fresh: [typed.body], rebound: 1 });
    const res = await sendBound(live, "d-9");
    expect({ outcome: res.outcome, failure: res.failure ?? null, sends: live.fake.seen.filter((r) => r.url === "/drafts/d-9/send").length })
      .toEqual({ outcome: "failed", failure: refusal, sends: 0 });
    // The offer: the new text goes as the row the keep bound, once.
    const again = await sendBound(live, rebound[0]!);
    expect({ outcome: again.outcome, deliveries: live.fake.deliveries().length }).toEqual({ outcome: "sent", deliveries: 1 });
  }, 30_000);
});

describe("deleted on another device before this mirror heard", () => {
  it("the server's 404 on the keep sends the words to a new row", async () => {
    const live = await scene();
    openSheet(live);
    live.fake.deleteElsewhere("d-9");
    const rebound: string[] = [];
    expect(await keep(live, "d-9", rebound), "a refused keep over a row deleted a moment ago dropped the words").toBe("kept");
    expect({ fresh: freshRows(live).map((r) => r.body), rebound: rebound.length }).toEqual({ fresh: [typed.body], rebound: 1 });
  }, 30_000);
});

describe("controls: no false sentence", () => {
  it("a draft this phone sends itself is sent as itself, and no second row is made", async () => {
    const live = await scene();
    openSheet(live);
    expect((await sendBound(live, "d-9")).outcome).toBe("sent");
    expect({ rows: live.fake.draftRows().length, deliveries: live.fake.deliveries().length }).toEqual({ rows: 1, deliveries: 1 });
  }, 30_000);

  it("a draft edited on another device without a send stays an ordinary bound draft", async () => {
    const live = await scene();
    const held = openSheet(live);
    live.fake.addDraft({ ...draftRow({ body: "edited on the web", updatedAt: new Date().toISOString() }) } as unknown as Record<string, unknown> & { id: string });
    await live.engine.syncOnce();
    expect(live.rowNow()?.body).toBe("edited on the web");
    expect({ plan: live.plan(held).kind, left: leftOf(live, "d-9") }).toEqual({ plan: "sheet", left: null });
    const rebound: string[] = [];
    expect(await keep(live, "d-9", rebound)).toBe("kept");
    expect({ rows: live.fake.draftRows().length, body: live.fake.draft("d-9")?.body, rebound }).toEqual({ rows: 1, body: typed.body, rebound: [] });
  }, 30_000);

  it("a re-bootstrap's empty mirror is not a delete: no drain completed since the sighting", async () => {
    const live = await scene();
    openSheet(live);
    live.fake.answerNext("GET", "/sync", 410, { error: { code: "cursor_expired", message: "gone" } });
    const release = live.fake.holdNext("GET", "/sync/snapshot");
    const snapshots = () => live.fake.seen.filter((r) => r.url.startsWith("/sync/snapshot")).length;
    const before = snapshots();
    const drain = live.engine.syncOnce();
    for (let i = 0; i < 200 && snapshots() === before; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(live.engine.read().get("draft", "d-9"), "the window under test never opened").toBeUndefined();
    expect(leftOf(live, "d-9")).toBeNull();
    release();
    await drain;
    expect(leftOf(live, "d-9")).toBeNull();
  }, 30_000);

  it("a row taken out by a verb still in flight, with no drain since, is not called deleted", async () => {
    const live = await scene();
    openSheet(live);
    const release = live.fake.holdNext("DELETE", "/drafts/d-9");
    const discard = live.engine.mutate({ kind: "draft_discard", draftId: "d-9" } as never);
    expect(live.engine.read().get("draft", "d-9"), "the window under test never opened").toBeUndefined();
    expect(leftOf(live, "d-9")).toBeNull();
    release();
    await discard;
  }, 30_000);

  it("a bound row this mirror cannot name, with no drain to ask, makes no second row", async () => {
    const live = await scene();
    for (let i = 0; i < 4; i += 1) live.fake.failNextStatus("GET", "/sync", 503);
    const posts = () => live.fake.seen.filter((r) => r.method === "POST" && r.url === "/drafts").length;
    expect(await keep(live, "d-unseen", []), "an absence was taken for a delete").toBe("refused");
    expect({ posts: posts(), rows: live.fake.draftRows().length }).toEqual({ posts: 0, rows: 1 });
  }, 30_000);
});

describe("\"can't be edited here\" is said only where it is true", () => {
  it("a draft the phone cannot take whole, at the open: the sentence; a row not here: the gone sentence", async () => {
    const live = await scene(draftRow({ html: "<p>the <b>body</b></p>" }));
    expect(live.rowNow()?.edit).toBeNull();
    expect(live.plan(null).kind).toBe("notEditable");
    expect(composeDraftPlan("d-404", null, undefined, () => undefined).kind).toBe("gone");
    // What the route holds is the sheet for ITS row only: another id is asked afresh.
    const held = composeDraftPlan("d-1", null, { id: "d-1", body: "", edit: { mailboxId: "mb-1", to: "", cc: "", bcc: "", subject: "", forwardOf: null } } as never, () => undefined);
    if (held.kind !== "sheet") throw new Error("the plain row did not open");
    expect(composeDraftPlan("d-404", held.open, undefined, () => undefined).kind).toBe("gone");
  }, 30_000);

  it("the route renders each plan's own sentence and holds the sheet it opened", () => {
    expect(ROUTE).toContain("const plan = composeDraftPlan(draftParam, held.current, w.drafts.find((d) => d.id === draftParam), (id) => w.message(id));");
    expect(ROUTE).toContain("hint={plan.kind === \"notEditable\" ? Copy.draftsEditNote");
    expect(ROUTE).toContain(': plan.kind === "gone" ? Copy.draftsRowGone');
    expect(ROUTE).toContain(': plan.kind === "replyOriginalAbsent" ? Copy.draftsReplyOriginalAbsent : Copy.draftsForwardOriginalAbsent');
    expect(ROUTE).toContain("held.current = plan.open;");
  });

  it("the sheet says which, refuses Send in those words, and offers the new text as a new letter", () => {
    // It asks only while idle on its row: its own send leaves the sheet, so it is never "elsewhere".
    expect(SHEET).toContain("const left = draftId !== null && phase === \"idle\" ? w.actions.draftLeft(draftId) : null;");
    expect(SHEET).toContain("{gone.why === \"sent\" ? Copy.composeSentElsewhere : Copy.composeDeletedElsewhere}");
    expect(SHEET).toContain("if (goneNote !== null && !asNew) { setFailNote(goneNote); return; }");
    expect(SHEET).toContain("goneNote !== null && typedSinceGone && failNote === goneNote ? (");
    expect(SHEET).toContain("const target = asNew && draftId !== null && w.actions.draftLeft(draftId) !== null ? null : draftId;");
    expect(SHEET).toContain("const press = () => toRow(target);");
  });
});
