/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type { EngineDraft, OhmailEngine } from "@ohmail/client-engine";
import {
  copyGoes, createLive, dropCopy, handleOf, landingOf, twins, type CreateClaim, type EditorNow,
} from "../app/shell/draft-creates";
import { accountSigOf } from "../app/shell/reply-autosave";

/**
 * WHAT A LANDED CREATE IS — the one table both editors decide by (`draft-creates.ts`), and the door's
 * handle for a listed row. Mutations: the held arm dropped → "wait" cases red; the ended arm after the
 * held or the binding arm → "drop, ended" red; the Send arm dropped → "drop, a Send since" red; the seq guard
 * reading `>=` → "a write no later than the create" red; the handle binding a painted local id →
 * "create" red; a landed create's handle naming the local id → "landed" red.
 */

const claim = (over: Partial<CreateClaim> = {}): CreateClaim => ({ sig: "s", binding: 1, sends: 0, held: false, seq: 3, ...over });
const now = (over: Partial<EditorNow> = {}): EditorNow => ({ binding: 1, ended: new Set(), sends: 0, row: null, ...over });

describe("landingOf — what a landed create is", () => {
  it.each([
    ["wait: a Send on the wire took it back", claim({ held: true }), now(), "wait"],
    ["drop, ended though held: a Discard after the Send was withdrawn", claim({ held: true }), now({ ended: new Set([1]) }), "drop"],
    ["drop, ended: its message was discarded or sent", claim(), now({ binding: 2, ended: new Set([1]) }), "drop"],
    ["keep: made under an earlier binding, another draft of its own", claim(), now({ binding: 2 }), "keep"],
    ["drop, a Send since: the send carried its words", claim(), now({ sends: 1 }), "drop"],
    ["take: same message, no row yet", claim(), now(), "take"],
    ["carry: same message, beside the row it holds", claim(), now({ row: "r1" }), "carry"],
  ] as const)("%s", (_what, c, e, want) => {
    expect(landingOf(c, e)).toBe(want);
  });

  it("the copy goes only once a write later than the create reached the row, or the row holds its very words", () => {
    expect(copyGoes(claim({ seq: 3 }), null, null), "no write reached the row").toBe(false);
    expect(copyGoes(claim({ seq: 3 }), 3, "older"), "a write no later than the create").toBe(false);
    expect(copyGoes(claim({ seq: 3 }), 4, "older")).toBe(true);
    expect(copyGoes(claim({ seq: -1 }), 0, null), "a claim a reload restored, then any write").toBe(true);
    expect(copyGoes(claim({ seq: 3, sig: "same" }), 1, "same"), "the row already holds the copy's words").toBe(true);
    expect(copyGoes(claim({ seq: -1, sig: "" }), null, ""), "words not known are never the same").toBe(false);
  });
});

const draft = (id: string, over: Partial<EngineDraft> = {}): EngineDraft => ({
  id, mailboxId: "mb1", threadId: null, inReplyToMessageId: null, subject: "s", body: "b",
  to: [], cc: [], bcc: [], rationale: null, status: "draft", createdAt: "", updatedAt: "", ...over,
} as EngineDraft);

function engineWith(o: {
  landed?: Record<string, { id: string; revision: string | null }>; painted?: EngineDraft[]; pending?: string[];
}): OhmailEngine & { mutate: ReturnType<typeof vi.fn> } {
  return {
    createdDraftOf: (key: string) => o.landed?.[key] ?? null,
    pendingCreateOf: () => null,
    pendingMutations: () => (o.pending ?? []).map((key) => ({ id: key, key, mutation: { kind: "draft_save" } })),
    inFlightMutations: () => [],
    read: () => ({ list: () => o.painted ?? [] }),
    mutate: vi.fn(async () => ({ status: "confirmed" })),
  } as unknown as OhmailEngine & { mutate: ReturnType<typeof vi.fn> };
}

describe("handleOf — what a door binds", () => {
  it("a row the server holds binds its id and version", () => {
    expect(handleOf(engineWith({}), draft("r1", { contentRevision: "v1" }))).toEqual({ kind: "row", id: "r1", revision: "v1" });
  });
  it("create: a painted row binds its create's key, never the local id", () => {
    expect(handleOf(engineWith({}), draft("local-1", { pendingCreate: "k1" }))).toEqual({ kind: "create", key: "k1" });
  });
  it("landed: a create the server answered binds the row it made", () => {
    const e = engineWith({ landed: { k1: { id: "r9", revision: "v9" } } });
    expect(handleOf(e, draft("local-1", { pendingCreate: "k1" }))).toEqual({ kind: "row", id: "r9", revision: "v9" });
  });
});

describe("createLive and dropCopy", () => {
  it("a key counts while this engine paints, queues or landed it — never one it does not carry", () => {
    expect(createLive(engineWith({ painted: [draft("l", { pendingCreate: "k1" })] }), "k1")).toBe(true);
    expect(createLive(engineWith({ pending: ["k1"] }), "k1")).toBe(true);
    expect(createLive(engineWith({ landed: { k1: { id: "r", revision: null } } }), "k1")).toBe(true);
    expect(createLive(engineWith({}), "k1"), "another window's key").toBe(false);
  });
  it("a copy is deleted, never the row the send went from (S(2))", () => {
    const e = engineWith({});
    dropCopy(e, "m1", "r2", "r1");
    dropCopy(e, "m1", "r1", "r1");
    expect(e.mutate.mock.calls).toEqual([[{ kind: "draft_discard", draftId: "r2" }]]);
  });
});

describe("twins — a landed copy beside the reply's row", () => {
  it("the same words on the server are twins; other words, a row past draft, or rows not held never are", () => {
    const rows = [draft("a", { body: "Thursday" }), draft("b", { body: "Thursday" }), draft("c", { body: "Friday" }),
      draft("d", { body: "Thursday", status: "sent" } as Partial<EngineDraft>)];
    const e = { store: { get: (_t: string, id: string) => rows.find((r) => r.id === id) } } as unknown as OhmailEngine;
    const twin = (a: string, b: string): boolean => twins(accountSigOf(e, a), accountSigOf(e, b));
    expect(twin("a", "b")).toBe(true);
    expect(twin("a", "c"), "other words").toBe(false);
    expect(twin("a", "d"), "a sent row").toBe(false);
    expect(twin("x", "y"), "neither held").toBe(false);
  });
});
