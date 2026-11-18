/** @vitest-environment jsdom */
import type { EngineDraft } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { openDraftDecision } from "../app/shell/AppShell";

/**
 * A DRAFT IS NEVER OPENED WITH A BODY THIS CLIENT DOES NOT HAVE.
 *
 * `EngineDraft.body` is nullable because a bounded `/sync/snapshot` page may carry a draft row
 * without its text, and `freshenStaleResume` applies page 1 over the mirror on every session
 * older than five minutes. Seeded as "" that row opens as an empty editor and autosave's next
 * PUT replaces the person's message with the blank. These arms watch the one decision that
 * stands between the two.
 */

const draft = (over: Partial<EngineDraft> = {}): EngineDraft => ({
  id: "d1",
  mailboxId: "mb-1",
  threadId: null,
  inReplyToMessageId: null,
  subject: "Quarterly numbers, revised",
  body: "the third tab is the one that changed",
  to: [{ name: null, address: "petra@example.com" }],
  cc: [],
  bcc: [],
  rationale: null,
  status: "draft",
  createdAt: "2026-09-01T09:00:00.000Z",
  updatedAt: "2026-09-01T14:02:00.000Z",
  ...over,
});

function rig(answer: string | null): {
  opened: Array<{ id: string; body: string }>;
  reads: string[];
  refusals: number;
  io: Parameters<typeof openDraftDecision>[1];
} {
  const opened: Array<{ id: string; body: string }> = [];
  const reads: string[] = [];
  const state = { refusals: 0 };
  return {
    opened, reads,
    get refusals() { return state.refusals; },
    io: {
      readDraftBody: async (id) => { reads.push(id); return answer; },
      openWithBody: (d, body) => { opened.push({ id: d.id, body }); },
      unavailable: () => { state.refusals++; },
    },
  };
}

describe("openDraftDecision", () => {
  it("opens a known body straight through, asking nothing", async () => {
    const r = rig(null);
    await openDraftDecision(draft(), r.io);
    expect(r.opened).toEqual([{ id: "d1", body: "the third tab is the one that changed" }]);
    expect(r.reads, "a row that carries its text costs no request").toEqual([]);
  });

  it("treats an EMPTY body as known — clearing a draft is an edit, not an absence", async () => {
    const r = rig(null);
    await openDraftDecision(draft({ body: "" }), r.io);
    expect(r.opened).toEqual([{ id: "d1", body: "" }]);
    expect(r.reads).toEqual([]);
  });

  it("fetches a NULL body and opens with what the server holds", async () => {
    const r = rig("the third tab is the one that changed");
    await openDraftDecision(draft({ body: null }), r.io);
    expect(r.reads).toEqual(["d1"]);
    expect(r.opened).toEqual([{ id: "d1", body: "the third tab is the one that changed" }]);
    expect(r.refusals).toBe(0);
  });

  it("fetches a body the page OMITTED, which reaches a reader as undefined", async () => {
    /* `applyToRecords` stores the DTO verbatim, so a page with no `body` key produces a row whose
       body is `undefined` behind a type that promises a string. The predicate answers on the
       runtime value, which is the only reading that covers this. */
    const bodyless = { ...draft(), body: undefined } as unknown as EngineDraft;
    const r = rig("what the account actually holds");
    await openDraftDecision(bodyless, r.io);
    expect(r.reads).toEqual(["d1"]);
    expect(r.opened).toEqual([{ id: "d1", body: "what the account actually holds" }]);
  });

  it("OPENS NOTHING when the text cannot be had — no empty editor, so no PUT of a blank", async () => {
    const r = rig(null);
    await openDraftDecision(draft({ body: null }), r.io);
    expect(r.reads).toEqual(["d1"]);
    expect(
      r.opened,
      "an editor opened with no text is one autosave away from overwriting the message",
    ).toEqual([]);
    expect(r.refusals).toBe(1);
  });
});

/**
 * A ROW THE PAGE WITHHELD — the same decision, reached by a different fact.
 *
 * A `/sync` page bounds itself by the bytes the transport refuses on, and a draft row heavier
 * than any page can carry arrives whole except for its text: `body`, `html` and `rationale` null,
 * with `bodyOmitted: "over_page_budget"`. The reason is for a support answer and changes no
 * decision here — which is the claim these two arms hold, including for a reason this build has
 * never heard of, because an older client meets a newer server on every deploy.
 */
describe("openDraftDecision over a withheld row", () => {
  it("fetches a row withheld for the page budget, exactly as it does one over the ceiling", async () => {
    for (const reason of ["over_page_budget", "over_ceiling", "a_reason_from_2027"]) {
      const r = rig("the words the person wrote");
      const withheld = {
        ...draft(), body: null, html: null, rationale: null, bodyOmitted: reason,
      } as unknown as EngineDraft;
      await openDraftDecision(withheld, r.io);
      expect(r.reads, `${reason}: the reason may not change the decision`).toEqual(["d1"]);
      expect(r.opened).toEqual([{ id: "d1", body: "the words the person wrote" }]);
    }
  });

  it("opens nothing when a withheld row cannot be fetched either", async () => {
    const r = rig(null);
    const withheld = {
      ...draft(), body: null, bodyOmitted: "over_page_budget",
    } as unknown as EngineDraft;
    await openDraftDecision(withheld, r.io);
    expect(r.opened).toEqual([]);
    expect(r.refusals).toBe(1);
  });
});
