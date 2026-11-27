/**
 * A DRAFT OPEN IN THE PHONE'S COMPOSER THAT ANOTHER DEVICE SENDS (the path beside the
 * web's). The sheet saves into its row as it goes and sends that row; once the row is `sent` the
 * server refuses both (409 `draft_sent`, and a send from status `sent`), so every word typed after
 * was dropped by a quiet keep and Send said "not sent" about a letter that went. Driven through
 * `bootEngine`'s real HttpAdapter against the fake; the sheet's wiring is READ (no React Native
 * renderer in this workspace).
 */
import type { EngineDraft } from "@ohmail/wire";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { keptRecipients, liveActions, parseRecipients, type LiveWorldActions } from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";
/* @reads: apps/mobile/src/ui/MessageActions.tsx */

const SHEET = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/ui/MessageActions.tsx"), "utf8");

const draftRow = (): EngineDraft => ({
  id: "d-9", mailboxId: "mb-1", threadId: null, inReplyToMessageId: null,
  subject: "Invoice 12", body: "the body", to: [{ name: "Ada", address: "ada@fake.test" }],
  cc: [], bcc: [], rationale: null, status: "draft",
  createdAt: "2026-09-01T09:00:00.000Z", updatedAt: "2026-09-20T14:29:00.000Z",
} as EngineDraft);

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };
const open: { close(): void }[] = [];
afterEach(() => { for (const o of open.splice(0)) o.close(); });

async function scene(sentElsewhere: boolean, opts: { drained?: boolean; unbelted?: boolean } = {}) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
  fake.addMessage(dto("m1", { subject: "Welcome" }));
  fake.addDraft({ ...draftRow() } as unknown as Record<string, unknown> & { id: string });
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  await boot.engine.syncOnce();
  if (opts.unbelted) fake.unbeltedSentRows();
  if (sentElsewhere) {
    fake.sendElsewhere("d-9");
    if (opts.drained !== false) await boot.engine.syncOnce();
  }
  open.push({ close: () => { boot.store.close(); fake.server.close(); } });
  const toasts: string[] = [];
  const actions: LiveWorldActions = liveActions({ engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid, zone: "UTC" });
  return { fake, ...boot, actions, toasts };
}

const typed = { to: "Ada <ada@fake.test>", subject: "Invoice 12", body: "the body, and a word typed after the send" };
const keep = (live: Awaited<ReturnType<typeof scene>>, rebound: string[]) => live.actions.draftKeep({
  mode: "new", messageId: null, mailboxId: "mb-1", to: keptRecipients(typed.to),
  subject: typed.subject, body: typed.body, files: 0, draftId: "d-9", quiet: true,
  rebind: (id: string) => { rebound.push(id); },
} as never);

describe("a draft open in the phone's composer that another device sends", () => {
  it("the words typed after are kept as a NEW draft, and the composer is bound to it", async () => {
    const live = await scene(true);
    const rebound: string[] = [];
    expect(await keep(live, rebound), "the keep was refused and the words were dropped").toBe("kept");
    const rows = live.fake.draftRows() as Array<{ id: string; status?: string; body?: string }>;
    const fresh = rows.filter((r) => r.id !== "d-9");
    expect({ fresh: fresh.map((r) => r.body), sent: rows.find((r) => r.id === "d-9")?.status, rebound: rebound.length })
      .toEqual({ fresh: [typed.body], sent: "sent", rebound: 1 });
    expect(rebound[0]).toBe(fresh[0]!.id);
  }, 30_000);

  it("the mirror's word decides before the wire: an older server that would take the words over a sent row is never asked", async () => {
    const live = await scene(true, { unbelted: true });
    const rebound: string[] = [];
    expect(await keep(live, rebound)).toBe("kept");
    expect({ sentRowWritten: live.fake.seen.filter((r) => r.method === "PUT" && r.url === "/drafts/d-9").length, rebound: rebound.length })
      .toEqual({ sentRowWritten: 0, rebound: 1 });
  }, 30_000);

  it("the server's word decides when the mirror has not heard yet: `draft_sent` sends the words to a new row", async () => {
    const live = await scene(true, { drained: false });
    const rebound: string[] = [];
    expect(await keep(live, rebound), "a refused keep over a row sent a moment ago dropped the words").toBe("kept");
    const fresh = (live.fake.draftRows() as Array<{ id: string; body?: string }>).filter((r) => r.id !== "d-9");
    expect({ fresh: fresh.map((r) => r.body), rebound: rebound.length }).toEqual({ fresh: [typed.body], rebound: 1 });
  }, 30_000);

  it("Send of the sent row is refused before the wire and says why; the new text then goes as a new letter", async () => {
    const live = await scene(true);
    const res = await live.actions.sendNew("mb-1", parseRecipients(typed.to)!, typed.subject, typed.body, null, null, [], "d-9");
    expect({ outcome: res.outcome, failure: res.failure ?? null, sends: live.fake.seen.filter((r) => r.url === "/drafts/d-9/send").length })
      .toEqual({ outcome: "failed", failure: "replySentElsewhere", sends: 0 });
    const again = await live.actions.sendNew("mb-1", parseRecipients(typed.to)!, typed.subject, typed.body, null, null, [], null);
    expect({ outcome: again.outcome, deliveries: live.fake.deliveries().length }).toEqual({ outcome: "sent", deliveries: 1 });
  }, 30_000);

  it("CONTROL: a live bound draft keeps into its own row and is sent as itself", async () => {
    const live = await scene(false);
    const rebound: string[] = [];
    expect(await keep(live, rebound)).toBe("kept");
    expect({ rows: live.fake.draftRows().length, body: live.fake.draft("d-9")?.body, rebound })
      .toEqual({ rows: 1, body: typed.body, rebound: [] });
  }, 30_000);

  it("the sheet's question reads the mirror's word: sent elsewhere yes, a live row no", async () => {
    expect((await scene(true)).actions.draftSent("d-9")).toBe(true);
    expect((await scene(false)).actions.draftSent("d-9")).toBe(false);
  }, 30_000);

  it("the sheet says so, rebinds on a keep, and offers the new text as a new letter", () => {
    expect(SHEET).toContain("const left = draftId !== null && phase === \"idle\" ? w.actions.draftLeft(draftId) : null;");
    expect(SHEET).toContain("{gone.why === \"sent\" ? Copy.composeSentElsewhere : Copy.composeDeletedElsewhere}");
    expect(SHEET).toContain("rebind: setDraftId");
    expect(SHEET).toContain("onPress={() => { void send(null, false, true); }}");
    expect(SHEET).toContain("if (goneNote !== null && !asNew) { setFailNote(goneNote); return; }");
    expect(SHEET).toContain("const target = asNew && draftId !== null && w.actions.draftLeft(draftId) !== null ? null : draftId;");
  });
});
