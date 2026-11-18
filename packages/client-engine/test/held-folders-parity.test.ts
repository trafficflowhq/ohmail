import type { EngineMessage, Folder } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { HELD_FOLDERS, ORGANIZED_FOLDERS, isHeldFolder } from "@trafficflow/core/destinations";
import {
  MemoryMirrorStore,
  VIEW_OF_FOLDER,
  screenerSegments,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * ONE HELD SET. The Screener places a message by `VIEW_OF_FOLDER` → `SEGMENT_OF_VIEW`; the Ohbox
 * keeps a held message out of a conversation by `isHeldFolder`. The two are one set spelled twice,
 * so this reads the Screener's domain off what it RENDERS — one stranger per folder — and refuses
 * any difference. Watch it fail: add a folder to `SEGMENT_OF_VIEW`, or drop one from `HELD_FOLDERS`.
 */

const NOW = new Date("2026-08-04T12:00:00.000Z");

function msg(folder: string, i: number): EngineMessage {
  return {
    id: `m${i}`, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `s${i}`, from: { name: null, address: `stranger${i}@example.invalid` }, to: [], cc: [],
    date: "2026-07-20T09:00:00.000Z", folder: folder as Folder, snippet: "", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-07-20T09:00:00.000Z",
  };
}

describe("the Screener's segments and the held predicate are one set", () => {
  it("every folder whose mail the Screener lists is held, and every held folder's mail is listed", async () => {
    const folders = [...new Set([...Object.keys(VIEW_OF_FOLDER), ...ORGANIZED_FOLDERS, "Sent", "Archive"])];
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges(folders.map((f, i) => ({
      type: "message", op: "create", id: `m${i}`, seq: i + 1, updatedAt: NOW.toISOString(), entity: msg(f, i),
    })) as SyncChange[]);
    const s = screenerSegments(store, NOW);
    const listed = new Set([...s.waiting, ...s.screenedOut, ...s.spam].flatMap((row) => row.held.map((m) => folders[Number(m.id.slice(1))]!)));

    expect([...listed].sort()).toEqual([...HELD_FOLDERS].sort());
    expect(folders.filter(isHeldFolder).sort()).toEqual([...HELD_FOLDERS].sort());
    // Anti-vacuity: the set is the three places a message waits or was screened out, nothing else.
    expect([...HELD_FOLDERS].sort()).toEqual(["ohmail/Quarantine", "ohmail/Screened", "ohmail/Screener"]);
  });
});
