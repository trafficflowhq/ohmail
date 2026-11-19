/** @vitest-environment jsdom */
import type { EngineMessage, Folder, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, type SyncChange } from "@ohmail/client-engine";
import { screeningReadBack } from "@ohmail/app-logic/press/press-verdict";

/** After applying a screening rule, read the result from the mirror and name the message left in the person's own folder by another mail app. */
const ADDR = "letters@vendor.example";
const NOW = "2026-10-02T21:00:00.000Z";
let seq = 0;

function msg(id: string, folder: Folder, date: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: `Issue ${id}`,
    from: { name: null, address: ADDR }, to: [], cc: [], date, folder, snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW,
  };
}
const rule = (): RuleDTO => ({
  id: "r-1", kind: "sender", match: ADDR, destination: "INBOX", priority: 0, provenance: "manual", enabled: true,
  stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: NOW, updatedAt: NOW, subjectContains: null, bodyContains: null,
  retro: { requestedAt: NOW, doneAt: NOW },
} as RuleDTO);

/** Five in INBOX where the rule's pass put them; `fixture` adds the one another app filed. */
async function readBack(o: { fixture: boolean }) {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => msg(`in-${i}`, "INBOX", `2026-09-${String(30 - i).padStart(2, "0")}${"T"}09:00:00.000Z`)),
    ...(o.fixture ? [msg("fix-1", "Fixture" as Folder, "2026-09-20T09:00:00.000Z")] : []),
  ];
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...rows.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW, entity: m })),
    { type: "rule", op: "create", id: "r-1", seq: ++seq, updatedAt: NOW, entity: rule() },
  ] as SyncChange[]);
  const back = screeningReadBack(store, "in-0", undefined, "ohbox", "sender", {
    consent: { known: true, standalone: false, dormancyDays: 60, screeningBaselineAt: null, screeningScope: "window", foldersEnabled: false },
    now: new Date(NOW), ownAddresses: ["me@home.example"], retro: true,
  });
  return { back };
}

describe("the sheet's split is the wire's when another mail app filed one", () => {
  it("the press's after-sentence says the one that stayed, never 'all 5' over six", async () => {
    // `screening.verdictAll` ("All 5 from … are in Ohbox.") is said only on `none`.
    const r = await readBack({ fixture: true });
    expect(r.back?.verdict).toMatchObject({ key: "still", count: 5, still: 1, stillPlace: "Fixture", ids: ["fix-1"] });
  });
});
