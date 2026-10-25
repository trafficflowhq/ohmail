/**
 * A DRAFT OPENED ON THE PHONE IS EDITED IN PLACE (PHONE-DRAFTS-ARE-READ-AND-RECOVERED-NOT-EDITED).
 *
 * The Drafts card offers Edit for a draft the composer can take whole, and the composer is bound
 * to that row: it saves into it as it goes and sends it. Driven through `bootEngine`'s real
 * HttpAdapter against the fake speaking the drafts routes; the sheet's wiring is READ, the
 * `compose-offline-send` idiom (no React Native renderer in this workspace).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineDraft } from "@ohmail/client-engine";
import { sayArg } from "../src/refusal";
import { Copy } from "../src/copy";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { draftEditOf, keptRecipients, liveActions, parseRecipients, type LiveWorldActions } from "../src/state/live";
import { baseAfter, baseFor, waitedFor, type DraftBase } from "../src/ui/compose-keep";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";
/* @reads: apps/mobile/src/ui/MessageActions.tsx, apps/mobile/src/ui/DraftReader.tsx, apps/mobile/app/compose.tsx */

const here = dirname(fileURLToPath(import.meta.url));
const SHEET = readFileSync(join(here, "../src/ui/MessageActions.tsx"), "utf8");
const CARD = readFileSync(join(here, "../src/ui/DraftReader.tsx"), "utf8");
const ROUTE = readFileSync(join(here, "../app/compose.tsx"), "utf8");

const draftRow = (over: Partial<EngineDraft> & Record<string, unknown> = {}): EngineDraft => ({
  id: "d-9", mailboxId: "mb-1", threadId: null, inReplyToMessageId: null,
  subject: "Invoice 12", body: "the body", to: [{ name: "Ada", address: "ada@fake.test" }],
  cc: [], bcc: [], rationale: null, status: "draft",
  createdAt: "2026-09-01T09:00:00.000Z", updatedAt: "2026-09-20T14:29:00.000Z",
  ...over,
} as EngineDraft);

describe("which drafts the phone edits", () => {
  it("a plain To-only draft whose text is here: its row, its recipients as typed, its own subject", () => {
    const edit = draftEditOf(draftRow({
      subject: "",
      to: [{ name: "Ada", address: "ada@fake.test" }, { name: "Doe, Bob", address: "bob@fake.test" }, { name: null, address: "cy@fake.test" }],
    }));
    expect(edit).toEqual({
      mailboxId: "mb-1", to: 'Ada <ada@fake.test>, "Doe, Bob" <bob@fake.test>, cy@fake.test', cc: "", bcc: "", subject: "", forwardOf: null, forwardParts: null,
      revision: null,
    });
    expect(parseRecipients(edit!.to), "the typed To does not parse back to the row's recipients").toEqual([
      { name: "Ada", address: "ada@fake.test" }, { name: "Doe, Bob", address: "bob@fake.test" }, { name: null, address: "cy@fake.test" },
    ]);
  });

  it.each([
    ["a Cc on a reply", { inReplyToMessageId: "m-1", cc: [{ name: null, address: "c@fake.test" }] }],
    ["a Bcc on a forward", { forwardOfMessageId: "m-1", bcc: [{ name: null, address: "b@fake.test" }] }],
    ["formatting", { html: "<p>the <b>body</b></p>" }],
    ["a send on record", { status: "unverified" as const }],
    ["a send running", { status: "sending" as const }],
    ["an appointment", { status: "scheduled" as const }],
    ["a body this mirror never received", { body: null }],
  ])("not a draft with %s: the composer would drop it on the first save", (_what, over) => {
    expect(draftEditOf(draftRow(over as Partial<EngineDraft>))).toBeNull();
  });

  /* PHONE-MAILTO-CC-BCC-NOT-CARRIED: a new mail's composer shows Cc and Bcc where the letter has them. */
  it("a new mail with copies opens with them typed, so a save keeps them", () => {
    const edit = draftEditOf(draftRow({ cc: [{ name: "Cy", address: "cy@fake.test" }], bcc: [{ name: null, address: "b@fake.test" }] }));
    expect(edit).toMatchObject({ cc: "Cy <cy@fake.test>", bcc: "b@fake.test" });
  });
});

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };
const open: { close(): void }[] = [];
afterEach(() => { for (const o of open.splice(0)) o.close(); });

async function scene() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
  fake.addMessage(dto("m1", { subject: "Welcome" }));
  fake.addDraft({ ...draftRow(), id: "d-9", contentRevision: "rev-0" } as unknown as Record<string, unknown> & { id: string });
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  await boot.engine.syncOnce();
  open.push({ close: () => { boot.store.close(); fake.server.close(); } });
  const toasts: string[] = [];
  const actions: LiveWorldActions = liveActions({ engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid, zone: "UTC" });
  return { fake, origin, ...boot, actions, toasts };
}

const calls = (fake: ReturnType<typeof mailServer>, method: string, path: string) =>
  fake.seen.filter((r) => r.method === method && r.url === path);

describe("a draft opened here is one row from the first keystroke to the send", () => {
  it("opened, edited and sent: the row is written and sent, and no second row is made", async () => {
    const live = await scene();
    const screen = { to: "Ada <ada@fake.test>", subject: "Invoice 12", body: "the body, finished" };
    // The sheet's save as it goes, then Send — both bound to the row the card opened.
    expect(await live.actions.draftKeep({
      mode: "new", messageId: null, mailboxId: "mb-1", to: keptRecipients(screen.to),
      subject: screen.subject, body: screen.body, files: 0, draftId: "d-9", quiet: true,
    })).toBe("kept");
    const res = await live.actions.sendNew("mb-1", parseRecipients(screen.to)!, screen.subject, screen.body, null, null, [], "d-9");
    expect(res.outcome).toBe("sent");
    expect(live.fake.draftRows().map((d) => d.id), "a second row was made for one letter").toEqual(["d-9"]);
    expect(calls(live.fake, "POST", "/drafts"), "a bound send created a row").toHaveLength(0);
    expect(calls(live.fake, "POST", "/drafts/d-9/send")).toHaveLength(1);
    expect(live.fake.deliveries()).toHaveLength(1);
    expect(live.fake.draft("d-9")?.body).toBe(screen.body);
  }, 30_000);

  it("opened and abandoned: the row holds exactly what was on screen, and nothing is said", async () => {
    const live = await scene();
    const screen = { to: "Ada <ada@fake.test>, cy@fake.test", subject: "Invoice 12 (v2)", body: "" };
    expect(await live.actions.draftKeep({
      mode: "new", messageId: null, mailboxId: "mb-1", to: keptRecipients(screen.to),
      subject: screen.subject, body: screen.body, files: 0, draftId: "d-9", quiet: true,
    })).toBe("kept");
    const row = live.fake.draft("d-9")!;
    expect({ subject: row.subject, body: row.body, to: row.to }).toEqual({
      subject: screen.subject, body: "", to: [{ name: "Ada", address: "ada@fake.test" }, { name: null, address: "cy@fake.test" }],
    });
    expect(live.fake.draftRows()).toHaveLength(1);
    expect(live.toasts, "a quiet keep announced itself, with an Undo that would discard the row").toEqual([]);
  }, 30_000);

  it("the sheet is seeded from the row, saves into it as it goes, and keeps what is on screen on close", () => {
    expect(SHEET).toContain("const [draftId, setDraftId] = useState<string | null>(draft?.id ?? null);");
    expect(SHEET).toContain("const [body, setBody] = useState(draft?.body ?? prefill?.body ?? \"\");");
    expect(SHEET).toContain("mode: forward ? \"forward\" : \"new\", messageId: forward ? m!.id : null,");
    expect(SHEET).toContain("mailboxId, to: keptRecipients(to), ...copiesToKeep(copies), subject, body, files: 0, draftId, quiet: true,");
    expect(SHEET).toContain("}, DRAFT_AUTOSAVE_MS);");
    // Files are content too: the close and the unmount count them (`compose-keep.ts`).
    expect(SHEET).toContain("const worth = bound && draftId !== null ? saved.current !== onScreen : worthKeeping({ fresh, subject, body, files });");
    // `tooLong` is a flag of the words on screen, not the seed: past the limit nothing is saved.
    expect(SHEET, "the timer must not reset on the route's per-render seed").toContain("}, [bound, draftId, phase, onScreen, tooLong]);");
  });

  it("the card offers Edit only where the composer can take the draft whole, and the route opens it bound", () => {
    expect(CARD).toContain("{row.edit !== null ? (");
    expect(CARD).toContain("router.push({ pathname: \"/compose\", params: { draft: row.id } })");
    expect(CARD).toContain("{row.edit === null ? (");
    expect(ROUTE).toContain("hint={plan.kind === \"notEditable\" ? Copy.draftsEditNote");
    // Sent from Edit, the card it returns to says the draft left Drafts — never the Trash's sentence.
    expect(CARD).toContain("{Copy.draftsRowGone}");
    expect(CARD).not.toContain("Copy.trashRowGone");
    expect(ROUTE).toContain("draft={draft} onClose={leave}");
    // A forward draft opens as a forward of its original, or says this phone does not hold it.
    expect(ROUTE).toContain("m={original} mode={original ? \"forward\" : \"new\"} forwardConfirmed={confirmed}");
    expect(ROUTE).toContain(": plan.kind === \"gone\" ? Copy.draftsRowGone : Copy.draftsForwardOriginalAbsent}");
  });
});

describe("a forward kept as a draft is still a forward", () => {
  it("kept, closed, reopened and sent: one row, and the send carries the original", async () => {
    const live = await scene();
    expect(await live.actions.draftKeep({
      mode: "forward", messageId: "m1", mailboxId: null,
      to: [{ name: null, address: "peer@fake.test" }], subject: "", body: "FYI", files: 0,
    })).toBe("kept");
    await live.engine.syncOnce();
    // The scene holds a draft of its own; the kept forward is the one under `Fwd:`.
    const row = live.engine.read().list<EngineDraft>("draft").find((d) => d.subject === "Fwd: Welcome")!;
    expect(row, "the kept forward never reached the mirror").toBeDefined();
    const edit = draftEditOf({ ...row, status: row.status ?? "draft" } as EngineDraft);
    expect(edit?.forwardOf, "the reopened draft does not say what it forwards").toBe("m1");
    const res = await live.actions.sendForward("m1", row.to, "FYI, and more", null, [], false, false, row.id);
    expect(res.outcome).toBe("sent");
    const send = live.fake.seen.find((r) => r.method === "POST" && r.url === `/drafts/${row.id}/send`);
    expect(send, "the reopened forward was not sent from its own row").toBeDefined();
    expect((JSON.parse(send!.body) as { forwardOf?: string }).forwardOf, "the reopened forward left as a plain mail").toBe("m1");
    expect(calls(live.fake, "POST", "/drafts"), "the send made a second row for one forward").toHaveLength(1);
  }, 30_000);
});

describe("a draft the phone edits while another device changes it", () => {
  const DESKTOP = "Written on the desktop.";
  /** Another device saves the row, stating no version: the server's version moves on. */
  const elsewhere = (origin: string, id: string, extra: Record<string, unknown> = {}) => fetch(`${origin}/drafts/${id}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject: "Invoice 12", body: DESKTOP, to: [{ name: "Ada", address: "ada@fake.test" }], cc: [], bcc: [], ...extra }),
  });
  const stated = (fake: ReturnType<typeof mailServer>, id: string) => calls(fake, "PUT", `/drafts/${id}`)
    .map((r) => (JSON.parse(r.body) as { ifContentRevision?: string }).ifContentRevision ?? null);
  const keep = (live: Awaited<ReturnType<typeof scene>>, body: string, revision: string | null, more: Record<string, unknown> = {}) =>
    live.actions.draftKeep({
      mode: "new", messageId: null, mailboxId: "mb-1", to: keptRecipients("Ada <ada@fake.test>"),
      subject: "Invoice 12", body, files: 0, draftId: "d-9", revision, quiet: true, ...more,
    });

  it("the quiet keep states the version it opened, keeps their words, and forks the phone's into a new row, said once", async () => {
    const live = await scene();
    const edit = draftEditOf(live.engine.read().get<EngineDraft>("draft", "d-9")!);
    await elsewhere(live.origin, "d-9");
    let forks = 0;
    const bound: string[] = [];
    expect(await keep(live, "typed on the phone", edit!.revision, { forked: () => { forks += 1; }, rebind: (id: string) => bound.push(id) })).toBe("kept");
    const mine = live.fake.draftRows().find((d) => d.id !== "d-9");
    expect({ stated: stated(live.fake, "d-9").slice(1), theirs: live.fake.draft("d-9")?.body, mine: mine?.body, bound, forks, toasts: live.toasts })
      .toEqual({ stated: ["rev-0"], theirs: DESKTOP, mine: "typed on the phone", bound: [mine?.id], forks: 1, toasts: [] });
  }, 30_000);

  it("a keep with the sheet closed says it by toast", async () => {
    const live = await scene();
    await elsewhere(live.origin, "d-9");
    expect(await keep(live, "typed on the phone", "rev-0")).toBe("kept");
    expect(live.toasts).toEqual([Copy.composeKeptChangedElsewhere]);
  }, 30_000);

  it("the phone's own saves, one after another, never fork (the control)", async () => {
    const live = await scene();
    let rev: string | null = "rev-0";
    let forks = 0;
    for (const body of ["first", "second"]) {
      expect(await keep(live, body, rev, { forked: () => { forks += 1; }, row: (r: { revision?: string }) => { rev = r.revision ?? rev; } })).toBe("kept");
    }
    expect({ rows: live.fake.draftRows().map((d) => d.id), body: live.fake.draft("d-9")?.body, forks }).toEqual({ rows: ["d-9"], body: "second", forks: 0 });
  }, 30_000);

  it("Send over newer words sends nothing, keeps the words unsigned as a new row, and names it", async () => {
    const live = await scene();
    await elsewhere(live.origin, "d-9");
    const res = await live.actions.sendNew("mb-1", parseRecipients("Ada <ada@fake.test>")!, "Invoice 12", "typed on the phone", "Sig", null, [], "d-9", { cc: [], bcc: [] }, "rev-0");
    const mine = live.fake.draftRows().find((d) => d.id !== "d-9");
    expect({ outcome: res.outcome, failure: res.failure, draftId: res.draftId, sent: live.fake.deliveries().length, theirs: live.fake.draft("d-9")?.body, mine: mine?.body })
      .toEqual({ outcome: "failed", failure: "replyChangedElsewhere", draftId: mine?.id, sent: 0, theirs: DESKTOP, mine: "typed on the phone" });
  }, 30_000);

  it("a forward sent over newer words does the same, and its new row still forwards", async () => {
    const live = await scene();
    live.fake.addDraft({ ...draftRow({ subject: "Fwd: Welcome", forwardOfMessageId: "m1" }), id: "d-f", contentRevision: "rev-0" } as unknown as Record<string, unknown> & { id: string });
    await live.engine.syncOnce();
    await elsewhere(live.origin, "d-f", { subject: "Fwd: Welcome", forwardOfMessageId: "m1" });
    const res = await live.actions.sendForward("m1", [{ name: null, address: "peer@fake.test" }], "FYI", null, [], false, false, "d-f", {}, "rev-0");
    const mine = live.fake.draftRows().find((d) => d.id !== "d-9" && d.id !== "d-f");
    expect({ failure: res.failure, draftId: res.draftId, sent: live.fake.deliveries().length, mine: [mine?.body, mine?.forwardOfMessageId] })
      .toEqual({ failure: "replyChangedElsewhere", draftId: mine?.id, sent: 0, mine: ["FYI", "m1"] });
  }, 30_000);

  it("a forward with a file removed, sent over newer words, keeps only the files it kept on its new row", async () => {
    const live = await scene();
    live.fake.setHello({ forwardParts: true });
    live.fake.addDraft({ ...draftRow({ subject: "Fwd: Welcome", forwardOfMessageId: "m1" }), id: "d-f", contentRevision: "rev-0", forwardParts: ["att-1"] } as unknown as Record<string, unknown> & { id: string });
    await live.engine.syncOnce();
    await elsewhere(live.origin, "d-f", { subject: "Fwd: Welcome", forwardOfMessageId: "m1" });
    const res = await live.actions.sendForward("m1", [{ name: null, address: "peer@fake.test" }], "FYI", null, [], false, false, "d-f", { forwardParts: ["att-1"] }, "rev-0");
    const mine = live.fake.draftRows().find((d) => d.id !== "d-9" && d.id !== "d-f") as { forwardOfMessageId?: string; forwardParts?: string[] } | undefined;
    expect({ failure: res.failure, sent: live.fake.deliveries().length, mine: [mine?.forwardOfMessageId, mine?.forwardParts ?? null] })
      .toEqual({ failure: "replyChangedElsewhere", sent: 0, mine: ["m1", ["att-1"]] });
  }, 30_000);

  /** The sheet's own bookkeeping of the row it holds: the version it states and its own saves' keys. */
  const sheet = (rev: string | null) => {
    let b: DraftBase = { row: "d-9", rev };
    return () => ({ revision: baseFor(b, "d-9"), waited: waitedFor(b, "d-9"), row: (r: { draftId: string | null; key: string | null; revision?: string }) => { b = baseAfter(b, r); } });
  };
  /** Another device saves on the row's current version. */
  const current = (live: Awaited<ReturnType<typeof scene>>, body: string) =>
    elsewhere(live.origin, "d-9", { body, ifContentRevision: (live.fake.draft("d-9") as { contentRevision?: string }).contentRevision });

  it("a keep queued, refused when it lands, then typed on: two rows, never three", async () => {
    const live = await scene();
    live.fake.failNextStatus("PUT", "/drafts/d-9", 503);
    const track = sheet("rev-0");
    expect(await keep(live, "typed offline", null, track())).toBe("kept");
    await elsewhere(live.origin, "d-9");
    await live.engine.flushPending().catch(() => undefined);
    await live.engine.syncOnce();
    expect(await keep(live, "typed offline, and more", null, track())).toBe("kept");
    const rows = live.fake.draftRows();
    expect({ count: rows.length, theirs: live.fake.draft("d-9")?.body, mine: rows.find((d) => d.id !== "d-9")?.body })
      .toEqual({ count: 2, theirs: DESKTOP, mine: "typed offline, and more" });
  }, 30_000);

  it("a second conflict in a later sheet never writes over the words the first one kept", async () => {
    const live = await scene();
    live.fake.failNextStatus("PUT", "/drafts/d-9", 503);
    const first = sheet("rev-0");
    expect(await keep(live, "mine, typed first", null, first())).toBe("kept");
    expect((await current(live, "theirs")).status).toBe(200);
    await live.engine.flushPending().catch(() => undefined);
    await live.engine.syncOnce();
    const later = sheet(draftEditOf(live.engine.read().get<EngineDraft>("draft", "d-9")!)!.revision);
    expect(await keep(live, "theirs, and mine", null, later())).toBe("kept");
    expect((await current(live, "theirs again")).status).toBe(200);
    expect(await keep(live, "theirs, mine, and more", null, later())).toBe("kept");
    expect(live.fake.draftRows().map((d) => d.body).sort()).toEqual(["mine, typed first", "theirs again", "theirs, mine, and more"]);
  }, 30_000);
});
