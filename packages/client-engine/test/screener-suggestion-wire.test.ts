import type { EngineMessage, Folder, ScreenerSuggestionEntity } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  SYNC_ENTITY_TYPES,
  screenerSegments,
  type EntityReader,
  type SyncChange,
} from "../src/index.js";

/**
 * A BOUGHT SUGGESTION RIDES `/sync` AND FILLS THE WAITING ROW'S `ai` — no activation re-read, no
 * purchase from this client. `screenerSegments` reads the newest per sender; the badge renders
 * on every surface that renders these rows, the phone included. MUTATION-WATCH (each run red,
 * restored): `selectors.ts` `ai: suggestionAi(sug)` → `ai: null` — the fill cases go red with
 * the entity parsed and stored but the chip absent; `types.ts` drop `"screener_suggestion"`
 * from `SYNC_ENTITY_TYPES` — the vocabulary case goes red, and every `?types=`-naming drain
 * (the phone's) would never be sent the entity; `selectors.ts` drop `kept.suggestionId ===
 * (sug?.id ?? null)` from the cache hit — the bag-stands-still case goes red, `ai` stays null.
 */

const NOW = new Date("2026-09-18T12:00:00.000Z");

let seq = 100;
function change(type: string, id: string, op: SyncChange["op"], entity?: unknown): SyncChange {
  return {
    type, op, id, seq: ++seq, updatedAt: NOW.toISOString(),
    ...(entity !== undefined ? { entity } : {}),
  } as SyncChange;
}

function msg(id: string, from: string, folder: Folder): EngineMessage {
  const date = "2026-09-17T08:00:00.000Z";
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date, folder, snippet: "s", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  };
}

function suggestion(over: Partial<ScreenerSuggestionEntity> = {}): ScreenerSuggestionEntity {
  return {
    id: "sg-1", messageId: "m-1", senderKey: "stranger@corp.test",
    decision: "yes", destination: "INBOX", spam: false, confidence: 0.8,
    boughtAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...over,
  };
}

async function mirror(rows: SyncChange[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(rows);
  return store;
}

const waitingOf = (store: MemoryMirrorStore) =>
  screenerSegments(store as unknown as EntityReader, NOW).waiting;

describe("a suggestion applied from the delta fills the waiting row's ai", () => {
  it("the entity is in the vocabulary every ?types=-naming drain derives", () => {
    expect(SYNC_ENTITY_TYPES).toContain("screener_suggestion");
  });

  // `id` is the mirror entity the chip came from — which purchase it is, for the overlay join; the
  // model's text never arrives.
  it("the chip's facts arrive without a re-read: dest, confidence, empty rationale", async () => {
    const store = await mirror([
      change("message", "m-1", "create", msg("m-1", "stranger@corp.test", "ohmail/Screener")),
      change("screener_suggestion", "sg-1", "create", suggestion()),
    ]);
    const rows = waitingOf(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ai).toEqual({ dest: "ohbox", confidence: 0.8, rationale: "", id: "sg-1" });
  });

  it("a suggestion arriving while the bag stands still re-derives that sender", async () => {
    const store = await mirror([
      change("message", "m-1", "create", msg("m-1", "stranger@corp.test", "ohmail/Screener")),
    ]);
    expect(waitingOf(store)[0]!.ai).toBeNull();
    await store.applyChanges([change("screener_suggestion", "sg-1", "create", suggestion())]);
    expect(waitingOf(store)[0]!.ai).toEqual({ dest: "ohbox", confidence: 0.8, rationale: "", id: "sg-1" });
  });

  it("a re-buy's delete + create pair replaces the chip; newest boughtAt wins a tie", async () => {
    const store = await mirror([
      change("message", "m-1", "create", msg("m-1", "stranger@corp.test", "ohmail/Screener")),
      change("screener_suggestion", "sg-1", "create", suggestion()),
    ]);
    await store.applyChanges([
      change("screener_suggestion", "sg-1", "delete"),
      change("screener_suggestion", "sg-2", "create", suggestion({
        id: "sg-2", destination: "ohmail/News",
        boughtAt: new Date(NOW.getTime() + 1000).toISOString(),
      })),
    ]);
    expect(waitingOf(store)[0]!.ai).toMatchObject({ dest: "reads" });
    // Both momentarily present (one page holding the pair unapplied yet): newest boughtAt wins.
    await store.applyChanges([change("screener_suggestion", "sg-1", "create", suggestion())]);
    expect(waitingOf(store)[0]!.ai).toMatchObject({ dest: "reads" });
  });

  it("hold renders the gate; an unknown destination falls to the decision's side", async () => {
    const store = await mirror([
      change("message", "m-1", "create", msg("m-1", "stranger@corp.test", "ohmail/Screener")),
      change("screener_suggestion", "sg-1", "create", suggestion({ decision: "hold", destination: "ohmail/Screener" })),
    ]);
    expect(waitingOf(store)[0]!.ai).toMatchObject({ dest: "screener" });
    await store.applyChanges([
      change("screener_suggestion", "sg-1", "delete"),
      change("screener_suggestion", "sg-3", "create", suggestion({
        id: "sg-3", decision: "no", destination: "ohmail/Later-from-a-newer-server",
        boughtAt: new Date(NOW.getTime() + 1000).toISOString(),
      })),
    ]);
    expect(waitingOf(store)[0]!.ai).toMatchObject({ dest: "screened" });
  });

  it("spam names spam; a reason travels and a foreign code is dropped, never rendered raw", async () => {
    const store = await mirror([
      change("message", "m-1", "create", msg("m-1", "stranger@corp.test", "ohmail/Screener")),
      change("screener_suggestion", "sg-1", "create", suggestion({
        decision: "no", destination: "ohmail/Quarantine", spam: true,
        reasonCode: "impersonation", reasonBrand: "Acme",
      })),
    ]);
    expect(waitingOf(store)[0]!.ai).toMatchObject({
      dest: "spam", reasonCode: "impersonation", reasonBrand: "Acme",
    });
    await store.applyChanges([
      change("screener_suggestion", "sg-1", "delete"),
      change("screener_suggestion", "sg-4", "create", suggestion({
        id: "sg-4", reasonCode: "a_code_this_client_predates",
        boughtAt: new Date(NOW.getTime() + 1000).toISOString(),
      })),
    ]);
    expect(waitingOf(store)[0]!.ai).toEqual({ dest: "ohbox", confidence: 0.8, rationale: "", id: "sg-4" });
  });

  /* The act on suggestions' refusal arrives as an UPDATE on the same entity, and its
     clear too. The row says so, and says it no more once cleared — with the bag standing still. */
  it("a refused act on the same entity marks the row, and its clear unmarks it", async () => {
    const store = await mirror([
      change("message", "m-1", "create", msg("m-1", "stranger@corp.test", "ohmail/Screener")),
      change("screener_suggestion", "sg-1", "create", suggestion()),
    ]);
    expect(waitingOf(store)[0]!.ai).not.toHaveProperty("actRefused");
    const later = new Date(NOW.getTime() + 60_000).toISOString();
    await store.applyChanges([change("screener_suggestion", "sg-1", "update", suggestion({
      actRefusal: "store_fault", actRefusedAt: later, updatedAt: later,
    }))]);
    expect(waitingOf(store)[0]!.ai).toMatchObject({ dest: "ohbox", actRefused: true });
    const cleared = new Date(NOW.getTime() + 120_000).toISOString();
    await store.applyChanges([change("screener_suggestion", "sg-1", "update", suggestion({
      actRefusal: null, actRefusedAt: null, updatedAt: cleared,
    }))]);
    expect(waitingOf(store)[0]!.ai).toEqual({ dest: "ohbox", confidence: 0.8, rationale: "", id: "sg-1" });
  });

  it("only the waiting shelf carries the fill — a screened-out row's ai stays null", async () => {
    const store = await mirror([
      change("message", "m-1", "create", msg("m-1", "stranger@corp.test", "ohmail/Screened")),
      change("screener_suggestion", "sg-1", "create", suggestion()),
    ]);
    const segments = screenerSegments(store as unknown as EntityReader, NOW);
    expect(segments.waiting).toHaveLength(0);
    expect(segments.screenedOut).toHaveLength(1);
    expect(segments.screenedOut[0]!.ai).toBeNull();
  });
});
