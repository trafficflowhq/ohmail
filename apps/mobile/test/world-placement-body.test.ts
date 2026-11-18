import type { EngineMessage, MessageBodyWire, RuleEntity as RuleDTO } from "@ohmail/wire";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, OhmailEngine, type EngineAdapter, type EntityReader,
  type SyncChange,
} from "@ohmail/client-engine";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { createProjector, listStamp, type ProjectionInputs, type Projected } from "../src/state/world-projection";
import { SCREENING_UNSUPPLIED, type WorldActions } from "../src/state/live";

/**
 * A BODY THAT DECIDES A PLACEMENT REACHES THE LISTS. A body-term rule reads a message's text, so
 * its body can move the row out of the Inbox; the engine moves `placementStamp` for exactly those
 * bodies. Run as the provider runs it (a memo on `listStamp`, one kept projector), the row must
 * leave the Inbox when the body lands — and a body no rule reads must re-derive nothing.
 */

const NOW = new Date("2026-09-24T12:00:00.000Z");
let seq = 0;
function msg(id: string, from: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-09-20T09:00:00.000Z", folder: "INBOX", snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  } as EngineMessage;
}
const bodyRule = {
  id: "b", kind: "sender", match: "person@shop.example", destination: "ohmail/Screened", priority: 0,
  provenance: "manual", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), subjectContains: null, bodyContains: "unsubscribe",
} as RuleDTO;

const OWN = ["me@example.test"] as readonly string[];
const HIDDEN = new Set<string>();
const PLACES = new Map() as never;
const SCOPES = {};
const LEAVING: never[] = [];

async function rig() {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...[msg("ruled", "person@shop.example"), msg("other", "someone@else.example")]
      .map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: m })),
    { type: "rule", op: "create", id: bodyRule.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: bodyRule },
  ] as SyncChange[]);
  const body = (id: string): MessageBodyWire => ({
    text: `the text of ${id}, unsubscribe here`, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
  } as MessageBodyWire);
  const adapter = {
    sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async () => ({ changes: [], seq: null }),
    fetchBody: async (id: string) => body(id),
  } as unknown as EngineAdapter;
  return new OhmailEngine({ store, now: () => NOW, adapter } as never);
}

function run(projector: ReturnType<typeof createProjector>, engine: OhmailEngine, seen: { pres: EntityReader | null }): Projected {
  return projector.project({
    engine, worldKey: "rig", standalone: false, bearer: null, images: "direct",
    zone: "Europe/Zurich", locale: "en", now: new Date(NOW), foldersOn: false, foldersPending: false, foldersStorable: true,
    signatures: null, resurfaceTime: null, screenerServer: null, relayed: null, mailboxes: null, walker: null, searchWalker: null,
    openOffMirror: () => undefined, scopes: SCOPES, leavingWaiting: LEAVING, heldDeletes: HIDDEN, heldPlaces: PLACES,
    ownAddresses: OWN, posture: SCREENING_UNSUPPLIED, actions: {} as WorldActions,
    onPresented: (p: EntityReader) => { seen.pres = p; }, account: () => ({ name: "rig", email: "" }),
    setFoldersEnabled: async () => true, folderSummary: async () => null, rememberResurfaceTime: () => undefined,
  } as unknown as ProjectionInputs);
}

/* The provider: a run only when `listStamp` moved, through ONE kept projector. */
function provider(engine: OhmailEngine) {
  const projector = createProjector();
  const seen = { pres: null as EntityReader | null };
  let last: number | null = null;
  const render = (): string | undefined => {
    const key = listStamp(engine);
    if (last === null || key !== last) { last = key; run(projector, engine, seen); }
    return seen.pres?.get<EngineMessage>("message", "ruled")?.folder;
  };
  return { render, projector };
}

describe("a body that decides a placement reaches the phone's lists", () => {
  it("the row leaves the Inbox when its body lands, as a fresh projection places it", async () => {
    const engine = await rig();
    const p = provider(engine);
    expect(p.render(), "the rule placed the message before its body was read — the rig measures nothing").toBe("INBOX");

    await engine.hydrateBody("ruled");
    const fresh = { pres: null as EntityReader | null };
    run(createProjector(), engine, fresh);
    expect(fresh.pres?.get<EngineMessage>("message", "ruled")?.folder, "the body-term rule did not place the message").toBe("ohmail/Screened");
    expect(p.render(), "the kept projector still shows the row where the body no longer places it").toBe("ohmail/Screened");
  });

  it("a body no rule reads moves no list stamp and derives nothing", async () => {
    const engine = await rig();
    const p = provider(engine);
    p.render();
    const key = listStamp(engine);
    const before = JSON.stringify(p.projector.stats());
    const version = engine.read().version();
    await engine.hydrateBody("other");
    expect(engine.read().version(), "the body write moved nothing — the arm measures nothing").toBeGreaterThan(version);
    expect(listStamp(engine), "an ordinary body moved the list stamp — every eager body would re-derive the lists").toBe(key);
    p.render();
    expect(JSON.stringify(p.projector.stats())).toBe(before);
  });
});

describe("the phone keys its lists in one place", () => {
  const SRC = fileURLToPath(new URL("../src", import.meta.url));
  const files = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) files(full, out);
      else if (/\.tsx?$/.test(name)) out.push(full);
    }
    return out;
  };

  it("only listStamp spells the body-blind stamp, and the provider reads listStamp", () => {
    const all = files(SRC);
    expect(all.length, "the walk reached no source").toBeGreaterThan(50);
    const spellers = all.filter((f) => withoutComments(readFileSync(f, "utf8")).includes("stampExcept(NOT_DERIVED_FROM)"))
      .map((f) => f.slice(SRC.length + 1));
    expect(spellers, "a second spelling of the list key — it can drop the placement stamp again").toEqual(["state/world-projection.ts"]);
    const world = withoutComments(readFileSync(join(SRC, "state/world.tsx"), "utf8"));
    const at = world.indexOf("const derivedStamp = useSyncExternalStore(");
    expect(at, "the provider's derived stamp moved").toBeGreaterThan(-1);
    expect(world.slice(at, world.indexOf(");", at))).toContain("listStamp(engine)");
  });
});
