import type { EngineDraft } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, draftBodyKnown,
  type SyncChange,
} from "../src/index.js";

/**
 * THE MIRROR'S SIDE OF A ROW THE PAGE WITHHELD.
 *
 * A `/sync` page bounds itself by the bytes the transport refuses on, and a draft row heavier
 * than any page can carry arrives as `body: null` with `bodyOmitted: "over_page_budget"` — `html`
 * and `rationale` withheld with it, because those are where the weight was. Withheld rather than
 * dropped: the row LISTS, and the text is one `GET /drafts/:id` away.
 *
 * The parser's rule is that the reason changes NOTHING: `draftBodyKnown` is the one predicate, so
 * the surface that renders bodies takes the same fetch path it takes for `over_ceiling` and for a
 * reason this build has never heard of. That last case is the one worth measuring — an older
 * client meeting a newer server must not treat an unknown reason as "there is no draft". What the
 * SURFACE then does with it is measured where it lives: `apps/webapp/test/draft-body-hydrate.test.ts`.
 */
const NOW = new Date("2026-09-14T09:00:00.000Z");

const draftChange = (entity: Record<string, unknown>): SyncChange => ({
  type: "draft", op: "create", id: "d1", seq: 7,
  updatedAt: NOW.toISOString(),
  entity: {
    id: "d1", mailboxId: "mb-1", threadId: null, inReplyToMessageId: null,
    subject: "Quarterly numbers", to: [], cc: [], bcc: [], rationale: null,
    status: "draft", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    ...entity,
  },
});

async function mirrorWith(entity: Record<string, unknown>): Promise<EngineDraft> {
  const store = new MemoryMirrorStore();
  await store.applyChanges([draftChange(entity)]);
  return store.get<EngineDraft>("draft", "d1")!;
}

/** The withheld row exactly as the snapshot writer emits it. */
const WITHHELD = {
  body: null, html: null, rationale: null, bodyOmitted: "over_page_budget",
} as const;

describe("a withheld draft in the mirror", () => {
  it("keeps the reason and every field the row still lists by", async () => {
    const row = await mirrorWith(WITHHELD);
    expect(row.bodyOmitted).toBe("over_page_budget");
    expect(row.subject).toBe("Quarterly numbers");
    expect(row.updatedAt).toBe(NOW.toISOString());
  });

  it("reads as a body this mirror does not hold — the one predicate, unchanged", async () => {
    expect(draftBodyKnown(await mirrorWith(WITHHELD))).toBe(false);
    // And the reason changes nothing: the older reason and an unheard-of one answer the same.
    expect(draftBodyKnown(await mirrorWith({ body: null, bodyOmitted: "over_ceiling" }))).toBe(false);
    expect(draftBodyKnown(await mirrorWith({ body: null, bodyOmitted: "a_reason_from_2027" })))
      .toBe(false);
  });
});
