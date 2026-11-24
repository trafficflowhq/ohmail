/** @vitest-environment jsdom */
import type { EngineDraft } from "@ohmail/wire";
import { apiRoutes, createApp } from "@trafficflow/api";
import { drafts, outboundSends } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { FIXED_NOW, makeDeps, seedMailbox, seedSession } from "../../../../packages/api/test/helpers.js";
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import en from "../../messages/en.json";
import { withNodeBlobs } from "../fixtures/node-blobs.js";
import { settleEditor } from "../_first-paint.js";
import { act, DraftServer, message, mountShell, press, replyDraft, stubDom, unmountAll, waitFor } from "../_draft-shell.js";

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  stubDom();
});
afterEach(unmountAll);

type Surface = "Drafts" | "Write" | "Reply";

async function open(surface: Surface, server?: DraftServer) {
  const parent = message("parent");
  const row: EngineDraft = {
    ...replyDraft("letter", parent.id, "Words waiting for an answer"),
    status: surface === "Write" ? "draft" : "unverified",
    inReplyToMessageId: surface === "Reply" ? parent.id : null,
    subject: "A letter in doubt",
  };
  server?.rows.set(row.id, row);
  const shell = await mountShell(surface === "Reply" ? "#/ohbox" : "#/drafts", [parent], [row], { server });
  const ui = within(shell.el);
  if (surface === "Reply") {
    await press(await ui.findByRole("option", { name: /Subject parent/ }), "open the parent letter");
    await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: "r" }); });
    await settleEditor();
    await ui.findByRole("textbox", { name: "Reply body" });
  } else {
    await press(await ui.findByRole("option", { name: /A letter in doubt/ }), "open the draft");
  }
  if (surface === "Write") {
    await ui.findByRole("textbox", { name: en.compose.subject });
    shell.refuseSend.on = true;
    shell.refuseSend.unverified = true;
    const actions = within(ui.getByRole("toolbar", { name: "Send or discard" }));
    await press(actions.getByRole("button", { name: "Send" }), "attempt delivery");
  }
  return { row, shell, ui };
}

it.each([
  ["Drafts", "arrived"], ["Drafts", "not_arrived"],
  ["Write", "arrived"], ["Write", "not_arrived"],
  ["Reply", "arrived"], ["Reply", "not_arrived"],
] as const)("%s resolves %s from the same two named actions without sending again", async (surface, outcome) => {
  const { row, shell, ui } = await open(surface);
  const again = await ui.findByRole("button", { name: en.drafts.sendAgain });
  const sent = ui.getByRole("button", { name: en.drafts.heldItWasSent });
  const before = shell.sent.length;
  await press(outcome === "arrived" ? sent : again, "answer the held send");
  await waitFor(
    () => shell.store.get<EngineDraft>("draft", row.id)?.status === (outcome === "arrived" ? "sent" : "draft"),
    "the confirmed draft resolution",
  );
  expect(shell.sent.slice(before).filter((m) => m.kind === "draft_resolve" || m.kind === "mail_send")).toEqual([
    { kind: "draft_resolve", draftId: row.id, outcome, ifUpdatedAt: expect.any(String) },
  ]);
  if (surface === "Drafts" && outcome === "not_arrived") {
    expect(await ui.findByRole("textbox", { name: en.compose.subject })).toHaveProperty("value", row.subject);
  }
});

it.each(["sent", "draft"] as const)("Send again follows the server's current %s row", async (status) => {
  class ResolvedElsewhere extends DraftServer {
    override answer(m: Parameters<DraftServer["answer"]>[0]): ReturnType<DraftServer["answer"]> {
      if (m.kind !== "draft_resolve") return super.answer(m);
      const draft = this.rows.get(m.draftId)!;
      const seq = 10_000;
      return {
        seq,
        changes: [{
          type: "draft", id: draft.id, op: "update", seq, updatedAt: draft.updatedAt,
          entity: { ...draft, status, subject: "The server's current subject" },
        }],
      };
    }
  }
  const { row, shell, ui } = await open("Drafts", new ResolvedElsewhere());
  const place = window.location.hash;
  await press(await ui.findByRole("button", { name: en.drafts.sendAgain }), "answer the held send");
  await waitFor(() => shell.store.get<EngineDraft>("draft", row.id)?.status === status, "the server's draft status");
  if (status === "sent") {
    expect(window.location.hash).toBe(place);
    expect(ui.queryByRole("textbox", { name: en.compose.subject })).toBeNull();
  } else {
    expect(await ui.findByRole("textbox", { name: en.compose.subject })).toHaveProperty("value", "The server's current subject");
  }
  expect(shell.sent.filter((m) => m.kind === "mail_send")).toHaveLength(0);
});

it("allows only the first answer while a held send is being resolved", async () => {
  const { row, shell, ui } = await open("Drafts");
  const sent = await ui.findByRole("button", { name: en.drafts.heldItWasSent });
  const again = ui.getByRole("button", { name: en.drafts.sendAgain });
  const place = window.location.hash;
  const gate = Promise.withResolvers<void>();
  const mutate = shell.engine.mutate.bind(shell.engine);
  const attempts = vi.spyOn(shell.engine, "mutate").mockImplementation(async (op, options) => {
    if (op.kind === "draft_resolve") await gate.promise;
    return mutate(op, options);
  });
  try {
    await press(sent, "answer that the letter arrived");
    await press(again, "press the second answer before the first has returned");
    expect(attempts.mock.calls.filter(([op]) => op.kind === "draft_resolve").map(([op]) => op)).toEqual([
      { kind: "draft_resolve", draftId: row.id, outcome: "arrived", ifUpdatedAt: row.updatedAt },
    ]);
  } finally {
    gate.resolve();
    await waitFor(() => shell.store.get<EngineDraft>("draft", row.id)?.status !== "unverified", "the first answer settles");
    attempts.mockRestore();
  }
  expect(window.location.hash).toBe(place);
});

it("ignores an answer from the old held row after the mirror sees a later attempt", async () => {
  const { row, shell, ui } = await open("Drafts");
  const answer = await ui.findByRole("button", { name: en.drafts.heldItWasSent });
  const updatedAt = "2026-09-28T10:00:00.000Z";
  await act(async () => {
    await shell.store.applyChanges([{
      type: "draft", op: "update", id: row.id, seq: 20_000, updatedAt,
      entity: { ...row, updatedAt },
    }]);
    fireEvent.click(answer);
  });
  expect(shell.store.get<EngineDraft>("draft", row.id)).toMatchObject({ status: "unverified", updatedAt });
  expect(shell.sent.filter((m) => m.kind === "draft_resolve" || m.kind === "mail_send")).toEqual([]);
});

it("refuses an old answer on the server when a later send of the same draft is held", async () => {
  const { db, deps } = await withNodeBlobs(() => makeDeps(FIXED_NOW));
  const session = await seedSession(db, { now: FIXED_NOW });
  const address = ["mailbox", "example.invalid"].join("@");
  const mailboxId = await seedMailbox(db, { accountId: session.accountId, address });
  const accountId = session.accountId;
  const [row] = await db.insert(drafts).values({
    accountId, mailboxId, subject: "The letter", body: "Words awaiting an answer", status: "unverified",
    to: [{ name: null, address }], createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).returning();
  const [attempt] = await db.insert(outboundSends).values({
    accountId, draftId: row!.id, status: "unverified", idempotencyKey: "later-attempt",
    mintedMessageId: "<later-attempt.example.invalid>",
  }).returning();
  const request = new Request(`http://localhost/drafts/${row!.id}/resolve`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
    body: JSON.stringify({ outcome: "arrived", ifUpdatedAt: new Date(FIXED_NOW.getTime() - 60_000).toISOString() }),
  });

  const response = await createApp(apiRoutes).handle(request, { ...deps, session: null, idempotency: null });
  expect(response.status).toBe(409);
  expect((await db.select({ status: drafts.status }).from(drafts).where(eq(drafts.id, row!.id)))[0]?.status).toBe("unverified");
  expect((await db.select({ status: outboundSends.status }).from(outboundSends).where(eq(outboundSends.id, attempt!.id)))[0]?.status).toBe("unverified");
});

it("offers Mailboxes when the sending mailbox is not signed in", async () => {
  const parent = message("parent");
  const row: EngineDraft = {
    ...replyDraft("letter", parent.id, "Words waiting for an answer"),
    status: "draft",
    inReplyToMessageId: null,
    subject: "A letter to send",
  };
  const shell = await mountShell("#/drafts", [parent], [row]);
  const ui = within(shell.el);
  await press(await ui.findByRole("option", { name: /A letter to send/ }), "open the draft");
  await ui.findByRole("textbox", { name: en.compose.subject });
  Object.assign(shell.refuseSend, { on: true, code: "mailbox_not_signed_in" });
  await press(within(ui.getByRole("toolbar", { name: "Send or discard" })).getByRole("button", { name: "Send" }), "attempt delivery");
  const routes: string[] = [];
  const readRoute = () => routes.push(window.location.hash);
  window.addEventListener("hashchange", readRoute);
  try {
    await press(await ui.findByRole("button", { name: "Mailboxes" }), "open Mailboxes");
    expect(routes).toContain("#/settings/mailboxes");
  } finally {
    window.removeEventListener("hashchange", readRoute);
  }
});
