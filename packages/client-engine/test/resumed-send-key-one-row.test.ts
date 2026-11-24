/**
 * ONE KEY, ONE SEND, ONE ROW. A send queued offline and pressed again under the SAME
 * Idempotency-Key (the phone resumes a standing intent's key) used to leave both verbs queued:
 * the newer one went, and the older one reached the wire on the next flush, made a second draft
 * row for the same message and was answered from the reservation. The newer verb under that key
 * now retires the queued older one in its own transaction.
 * Mutation: the same-key arm in `supersedeQueued` removed → case 1 red on the row count.
 */
import type { EngineMutation } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, MutationRejectedError, OhmailEngine,
} from "@ohmail/client-engine";

const NOW = new Date("2026-09-27T09:00:00.000Z");

interface Route {
  offline: boolean;
  /** Draft rows the account holds — one per rowless send that reached it, as the adapter creates. */
  rows: string[];
  reserved: Set<string>;
  delivered: string[];
  sends: number;
  /** One-shot: the next send's create answers unreadably, as a torn response does. */
  tearNextCreate: boolean;
}

function engineOver(r: Route): OhmailEngine {
  return new OhmailEngine({
    store: new MemoryMirrorStore(),
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: "1", hasMore: false, serverTime: NOW.toISOString(),
      }),
      fetchBody: async () => null,
      /* No memory of its own, as the adapter after a reload keeps none: only what the verb carries. */
      mutate: async (m: EngineMutation, opts: { idempotencyKey: string; createAttempted?: boolean }) => {
        if (m.kind !== "mail_send") return { changes: [], seq: null };
        if (r.offline) throw new MutationRejectedError("network failure", { code: "network", retryable: true });
        r.sends += 1;
        if (opts.createAttempted === true) {
          throw new MutationRejectedError("could not tell whether this draft was created", {
            code: "draft_unverified", status: null, retryable: false,
          });
        }
        if (r.tearNextCreate) {
          r.tearNextCreate = false;
          r.rows.push(`d${r.rows.length + 1}`);
          throw new MutationRejectedError("unreadable", {
            code: "unreadable_response", retryable: true, createAttempted: true,
          });
        }
        const row = (m as { draftId?: string | null }).draftId ?? `d${r.rows.length + 1}`;
        if (!r.rows.includes(row)) r.rows.push(row);
        // A reserved key is answered from its reservation and delivers nothing new.
        if (r.reserved.has(opts.idempotencyKey)) return { changes: [], seq: null, entityId: row };
        r.reserved.add(opts.idempotencyKey);
        r.delivered.push(String((m as { body?: string }).body ?? ""));
        return { changes: [], seq: null, entityId: row, providerMessageId: `<${row}@x>` };
      },
    } as never,
  });
}

const reply = (body: string): EngineMutation => ({
  kind: "mail_send", inReplyTo: null, mailboxId: "mb", subject: "Invoice 12", body,
  to: [{ name: null, address: "ada@fake.test" }], cc: [], bcc: [],
} as unknown as EngineMutation);

const route = (): Route => ({
  offline: false, rows: [], reserved: new Set(), delivered: [], sends: 0, tearNextCreate: false,
});

describe("a send resumed under its standing key", () => {
  it("1 — the queued older verb does not reach the wire after the newer one: one row, one delivery", async () => {
    const r = route();
    const engine = engineOver(r);
    await engine.start();
    r.offline = true;
    const first = await engine.mutate(reply("FIRST VERSION"));
    expect(first.status, "the offline press did not queue").toBe("queued");

    r.offline = false;
    const second = await engine.mutate(reply("SECOND VERSION"), { key: first.key });
    expect(second.status).toBe("confirmed");
    await engine.flushPending();

    expect(
      { rows: r.rows, delivered: r.delivered, pending: engine.pendingMutations().length },
      "the superseded send reached the wire and left a second row for one message",
    ).toEqual({ rows: ["d1"], delivered: ["SECOND VERSION"], pending: 0 });
  });

  it("2 — a create the older verb could not read is inherited: the newer one does not make another", async () => {
    const r = route();
    const engine = engineOver(r);
    await engine.start();
    r.tearNextCreate = true;
    const first = await engine.mutate(reply("FIRST VERSION"));
    expect(first.status, "the torn create did not queue").toBe("queued");
    expect(r.rows, "the torn create did not leave its row on the account").toEqual(["d1"]);

    const second = await engine.mutate(reply("SECOND VERSION"), { key: first.key });
    expect(r.rows, "the resumed press created a second row over an unreadable first").toEqual(["d1"]);
    expect(second.error?.code, "the resume forgot the create it could not read").toBe("draft_unverified");
  });

  it("CONTROL: a different key is a different send, and both stay queued", async () => {
    const r = route();
    const engine = engineOver(r);
    await engine.start();
    r.offline = true;
    await engine.mutate(reply("ONE"));
    await engine.mutate(reply("TWO"));
    expect(engine.pendingMutations().length, "a send under another key was retired").toBe(2);
  });
});
