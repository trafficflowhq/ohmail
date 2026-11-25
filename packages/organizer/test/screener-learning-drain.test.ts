import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { makeHaikuClassifier, type ClassifierPort } from "@trafficflow/core";
import {
  accounts,
  accountSettings,
  changeScreenerLearning,
  screenerLearningContext,
  mailboxes,
  messages,
  readScreenerLearning,
  updateScreenerLearning,
  UNMETERED_ACCESS,
  type AccessPort,
} from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { drainScreenerLearning } from "../src/screener-learning.js";

const now = new Date("2026-11-24T12:00:00Z");
async function fixture(clock = () => now) {
  const db = await makeTestDb();
  const scope = { accountId: randomUUID(), mailboxId: randomUUID() };
  await db.insert(accounts).values({ id: scope.accountId });
  await db.insert(mailboxes).values({
    id: scope.mailboxId,
    accountId: scope.accountId,
    provider: "imap",
    address: "fixture@example.test",
  });
  const [mail] = await db
    .insert(messages)
    .values({
      ...scope,
      fromName: "Examplecorps",
      subject: "Your quarterly partner briefing",
      bodyHash: "file",
      dedupKey: "letter",
    })
    .returning();
  await updateScreenerLearning(db, scope, (state) => ({
    ...state,
    notice: false,
    text: "Keep receipts.",
    revision: 1,
    lessons: [
      {
        id: "choice",
        decisionId: "decision",
        messageRef: "ref",
        messageId: mail!.id,
        at: now.getTime(),
        kind: "correction",
        topic: "invoice",
        suggested: "ohmail/News",
        chosen: "ohmail/Receipts",
        previous: null,
        revision: 1,
      },
    ],
  }));
  const classify: ClassifierPort["classify"] = async () => ({
    destination: "ohmail/Screener",
    confidence: 0,
    rationale: "",
    spam: false,
  });
  const before = () => readScreenerLearning(db, scope, now);
  const drain = (rewriteScreener: NonNullable<ClassifierPort["rewriteScreener"]>, access?: AccessPort) =>
    drainScreenerLearning(db, scope.accountId, { classify, rewriteScreener }, clock, access);
  return { db, scope, before, drain };
}

it("leases one rewrite and only saves while the choices are unchanged", async () => {
  const w = await fixture();
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const rewrite = vi.fn(async () => {
    enter();
    await finished;
    return { text: "File invoices with receipts." };
  });
  const pending = w.drain(rewrite);
  await entered;
  try {
    await w.drain(rewrite);
    expect(rewrite).toHaveBeenCalledTimes(1);
    await updateScreenerLearning(w.db, w.scope, (state) => ({ ...state, revision: 2 }));
  } finally {
    finish();
    await pending;
  }
  expect(await w.before()).toMatchObject({ text: "Keep receipts.", revision: 2, rewrittenRevision: 0 });
});

it.each(["", " \n", " Keep invoices with receipts."])(
  "keeps the saved note, timestamp and topics on a placeholder echo with suffix %j",
  async (suffix) => {
    const w = await fixture();
    const text = "Keep receipts. Your verification code: 638194.";
    const updatedAt = now.getTime() - 60_000;
    const noteTopics = ["receipt", "security"];
    await updateScreenerLearning(w.db, w.scope, (state) => ({ ...state, text, updatedAt, noteTopics }));
    const original = await w.before();
    const wire: string[] = [];
    const classifier = makeHaikuClassifier({
      client: {
        messages: {
          async create(request) {
            wire.push(JSON.stringify(request));
            const {
              messages: [user],
            } = request as { messages: [{ content: string }] };
            const { previous } = JSON.parse(user.content) as { previous: string };
            return { content: [{ type: "text", text: JSON.stringify({ text: previous + suffix }) }] };
          },
        },
      },
    });
    await w.drain(classifier.rewriteScreener!);
    expect(wire).toHaveLength(1);
    expect(wire[0]).toContain("Your verification code: [code].");
    expect(wire[0]).not.toContain("638194");
    expect(await w.before()).toEqual({ ...original, rewrittenRevision: 1 });
  },
);

it.each([
  "Verification codes always come to me. Mail from Shop" +
    "24 and Galaxus go to the feed. Keep 2026 tax letters with me.",
  "You keep one-time passwords and login links in the Inbox. You screen out webinar invitations from 2025 onwards.",
  "Sicherheitscodes bleiben im Posteingang. Rechnungen aus 2026 gehen in Belege.",
])("sends the saved lesson intact and accepts a clean rewrite of %s", async (text) => {
  const w = await fixture();
  await updateScreenerLearning(w.db, w.scope, (state) => ({ ...state, text }));
  const suffix = " Webinar invitations are screened out.";
  const rewrite = vi.fn<NonNullable<ClassifierPort["rewriteScreener"]>>(async (request) => ({
    text: request.input.previous + suffix,
  }));
  await w.drain(rewrite);
  expect(rewrite).toHaveBeenCalledTimes(1);
  expect(rewrite.mock.calls[0]?.[0].input.previous).toBe(text);
  expect(await w.before()).toMatchObject({ text: text + suffix, rewrittenRevision: 1 });
});

it.each(["Examplecorps sends invoices.", "Keep your quarterly partner briefing."])(
  "keeps the note and cursor when the output identifies mail (%s)",
  async (text) => {
    const w = await fixture();
    await w.drain(async (request) => {
      expect(JSON.stringify(request.input)).not.toMatch(/Examplecorps|quarterly partner/);
      return { text };
    });
    expect(await w.before()).toMatchObject({ text: "Keep receipts.", rewrittenRevision: 0, updatedAt: null });
  },
);

it("replaces the note only for an AI-enabled account with available balance", async () => {
  const w = await fixture();
  const ask = vi.fn(async () => ({ text: "File invoices with receipts." }));
  const credit = (remaining: number): AccessPort => {
    const verdict = { ...UNMETERED_ACCESS, aiCredits: { remaining } };
    return { access: async () => verdict, accessOrFault: async () => verdict };
  };
  await w.db.update(accounts).set({ aiEnabled: false }).where(eq(accounts.id, w.scope.accountId));
  await w.drain(ask, credit(1));
  expect(ask).not.toHaveBeenCalled();
  await w.db.update(accounts).set({ aiEnabled: true }).where(eq(accounts.id, w.scope.accountId));
  await w.drain(ask, credit(0));
  expect(ask).not.toHaveBeenCalled();
  await updateScreenerLearning(w.db, w.scope, (state) => {
    const { rewrite: _lease, ...rest } = state;
    return rest;
  });
  await w.drain(ask, credit(1));
  expect(ask).toHaveBeenCalledOnce();
  expect(await w.before()).toMatchObject({ text: "File invoices with receipts.", rewrittenRevision: 1 });
});

it.each(["refused", "failed"])("backs off a %s rewrite and stops until a new choice", async (failure) => {
  let time = now.getTime();
  const w = await fixture(() => new Date(time));
  const rewrite = vi.fn(async () => {
    if (failure === "failed") throw new Error("Provider unavailable");
    return { text: "File Examplecorps invoices." };
  });
  await w.drain(rewrite);
  time += 4 * 60_000;
  await w.drain(rewrite);
  expect(rewrite).toHaveBeenCalledTimes(1);
  time += 60_000;
  await w.drain(rewrite);
  expect(rewrite).toHaveBeenCalledTimes(2);
  time += 59 * 60_000;
  await w.drain(rewrite);
  expect(rewrite).toHaveBeenCalledTimes(2);
  time += 60_000;
  await w.drain(rewrite);
  expect(rewrite).toHaveBeenCalledTimes(3);
  time += 24 * 60 * 60_000;
  await w.drain(rewrite);
  expect(rewrite).toHaveBeenCalledTimes(3);
  expect(await w.before()).toMatchObject({ text: "Keep receipts.", rewrittenRevision: 0 });
  await updateScreenerLearning(w.db, w.scope, (state) => ({ ...state, revision: 2 }));
  const next = vi.fn(async () => ({ text: "File invoices with receipts." }));
  await w.drain(next);
  expect(next).toHaveBeenCalledOnce();
  expect(await w.before()).toMatchObject({ text: "File invoices with receipts.", rewrittenRevision: 2 });
});

it.each([{ ohboxBar: "Only personal letters" }, { locale: "de" as const }])(
  "discards an answer when the person's settings change during the call (%j)",
  async (change) => {
    const w = await fixture();
    await w.db.insert(accountSettings).values({ accountId: w.scope.accountId, locale: "en" });
    const rewrite = vi.fn(async () => {
      await w.db.update(accountSettings).set(change).where(eq(accountSettings.accountId, w.scope.accountId));
      return { text: "File invoices with receipts." };
    });
    await w.drain(rewrite);
    expect(rewrite).toHaveBeenCalledOnce();
    expect(await w.before()).toMatchObject({ text: "Keep receipts.", rewrittenRevision: 0, updatedAt: null });
  },
);

it("rebuilds a forgotten lesson's note without sending the old note or charging for remaining corrections meanwhile", async () => {
  const w = await fixture();
  await updateScreenerLearning(w.db, w.scope, (state) => ({
    ...state,
    text: "File invoices with Receipts. Keep shop confirmations in Receipts.",
    rewrittenRevision: 2,
    revision: 2,
    lessons: [...state.lessons, { ...state.lessons[0]!, id: "forgotten", topic: "order", revision: 2 }],
  }));
  const cleared = await changeScreenerLearning(w.db, w.scope, { kind: "forget", id: "forgotten" }, now);
  expect(cleared?.text).toBe("");
  expect(screenerLearningContext(cleared)).toEqual({});
  const rewrite = vi
    .fn<NonNullable<ClassifierPort["rewriteScreener"]>>()
    .mockResolvedValue({ text: "File invoices with receipts." });
  await w.drain(rewrite);
  expect(rewrite.mock.calls[0]?.[0].input).toMatchObject({
    previous: "",
    choices: [{ topic: "invoice" }],
  });
  expect(screenerLearningContext(await w.before())).toMatchObject({
    learnedWords: "File invoices with receipts.",
  });
});
