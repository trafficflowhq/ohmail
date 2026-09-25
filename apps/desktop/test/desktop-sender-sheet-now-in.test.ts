import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  consentPartition,
  type EngineMessage,
  type Folder,
  type RuleDTO,
  type SyncChange,
} from "@ohmail/client-engine";
import { planScreeningChange, senderScreening } from "../../webapp/app/shell/sender-screening";

/**
 * THE DESKTOP WINDOW'S SENDER SHEET AND DECIDE OVER A SENDER'S RULE TWINS
 * (SENDER-SHEET-NOW-IN-READS-THE-FILED-FOLDER, SCREENER-DECIDE-PROMOTES-BESIDE-AN-OUTRANKING-TWIN).
 * The window mounts the shared shell, so its sheet reads the list's placement through the web's
 * `senderScreening` and its decide is the shared engine's `screener_decide`: this file pins that
 * wiring and drives both through the modules the window imports.
 */
const NOW = new Date("2026-09-25T09:00:00.000Z");
const ADDR = "lena@atelier.example";
/** A module's source; the needles below are anchored at a line start, where no comment begins. */
const code = (rel: string) => readFileSync(join(__dirname, rel), "utf8");

function msg(id: string, folder: Folder): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: id,
    from: { name: null, address: ADDR }, to: [], cc: [], date: "2026-09-24T09:00:00.000Z", folder,
    snippet: id, unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-24T09:00:00.000Z",
  };
}

function rule(id: string, destination: Folder): RuleDTO {
  return {
    id, kind: "sender", match: ADDR, destination, priority: 0, provenance: "manual", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-09-24T10:00:00.000Z", updatedAt: "2026-09-24T10:00:00.000Z",
  };
}

async function store(folder: Folder, rules: RuleDTO[]): Promise<MemoryMirrorStore> {
  const s = new MemoryMirrorStore();
  await s.load();
  let seq = 0;
  await s.applyChanges([
    { type: "message", op: "create", id: "m1", seq: ++seq, updatedAt: "2026-09-24T09:00:00.000Z", entity: msg("m1", folder) },
    ...rules.map((r): SyncChange => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
  ]);
  return s;
}

describe("the desktop window's sheet and decide", () => {
  it("is the shared shell's: the window mounts AppShell, which hands the sheet the list's placement", () => {
    expect(code("../src/DesktopGate.tsx")).toMatch(/^import \{ AppShell \} from "\.\.\/\.\.\/webapp\/app\/shell\/AppShell";$/m);
    expect(code("../../webapp/app/shell/AppShell.tsx"))
      .toMatch(/^ {4}\(\) => \(senderMenu \? senderScreening\(engine\.verbRead\(\), senderMenu\.messageId, senderMenu\.address, consentView\?\.placeOf\) : null\),$/m);
  });

  it("over an allow twin and an outranking deny the sheet says Screened, where the list shows the row", async () => {
    const s = await store("INBOX", [rule("r-allow", "INBOX"), rule("r-deny", "ohmail/Screened")]);
    const placeOf = consentPartition(s, { now: NOW }).placeOf;
    expect(placeOf.get("m1")).toBe("ohmail/Screened");
    expect(senderScreening(s, "m1", undefined, placeOf)!.current).toBe("screened");
  });

  it("deciding a held sender beside a deny twin shows them in the Ohbox while the decide is in flight", async () => {
    const s = await store("ohmail/Screener", [rule("r-deny", "ohmail/Screened")]);
    const answers: Array<() => void> = [];
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: async () => null,
        sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: s.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
        mutate: async () => {
          await new Promise<void>((r) => { answers.push(r); });
          return { changes: [], seq: null };
        },
      },
      store: s,
      now: () => NOW,
    });
    await engine.start();
    const plan = planScreeningChange(senderScreening(engine.read(), "m1")!, "ohbox");
    const sent = plan.mutations.map((m) => engine.mutate(m));
    await new Promise((r) => { setTimeout(r, 0); });
    expect(consentPartition(engine.read(), { now: NOW }).placeOf.get("m1")).toBe("INBOX");
    for (const a of answers) a();
    await Promise.all(sent);
  });

  it("one rule where the mail is filed reads as it always did", async () => {
    const s = await store("INBOX", [rule("r-allow", "INBOX")]);
    expect(senderScreening(s, "m1", undefined, consentPartition(s, { now: NOW }).placeOf)!.current).toBe("ohbox");
  });
});
