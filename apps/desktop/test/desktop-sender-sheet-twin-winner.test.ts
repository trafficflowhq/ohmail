/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, type EngineMessage, type RuleDTO, type SyncChange } from "@ohmail/client-engine";
import { planScreeningChange, senderScreening } from "../../webapp/app/shell/sender-screening";

/**
 * THE DESKTOP'S SENDER SHEET OVER A SENDER'S RULE TWINS (SENDER-SHEET-ALREADY-OVER-AN-OUTRANKING-TWIN).
 * The window renders the shared shell, so its sheet plans through the web's ladder: this file pins
 * that wiring and drives the probe through the module the window imports. An allow into the Ohbox
 * and a deny into Screened for one address — the deny wins — and pressing Ohbox must retarget the
 * deny rather than answer "already".
 */
const ADDR = "lena@atelier.example";
/** A module's source; the needles below are anchored at a line start, where no comment begins. */
const code = (rel: string) => readFileSync(join(__dirname, rel), "utf8");

function msg(id: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: id,
    from: { name: null, address: ADDR }, to: [], cc: [], date: "2026-08-03T09:00:00.000Z", folder: "INBOX",
    snippet: id, unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-03T09:00:00.000Z",
  };
}

function rule(id: string, destination: RuleDTO["destination"]): RuleDTO {
  return {
    id, kind: "sender", match: ADDR, destination, priority: 0, provenance: "manual", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-08-01T09:00:00.000Z", updatedAt: "2026-08-01T09:00:00.000Z",
  };
}

async function sheet(rules: RuleDTO[]) {
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges([
    { type: "message", op: "create", id: "m1", seq: ++seq, updatedAt: "2026-08-03T09:00:00.000Z", entity: msg("m1") },
    ...rules.map((r): SyncChange => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
  ]);
  return senderScreening(store, "m1")!;
}

describe("the desktop window's sender sheet", () => {
  it("is the shared shell's sheet — the window mounts AppShell, which plans through the ladder", () => {
    expect(code("../src/DesktopGate.tsx")).toMatch(/^import \{ AppShell \} from "\.\.\/\.\.\/webapp\/app\/shell\/AppShell";$/m);
    expect(code("../../webapp/app/shell/AppShell.tsx")).toMatch(/^import \{[^}]*\bplanScreeningChange,[^}]*\} from "\.\/sender-screening";$/m);
  });

  it("pressing Ohbox over an allow twin and an outranking deny twin retargets the deny", async () => {
    const plan = planScreeningChange(await sheet([rule("r-allow", "INBOX"), rule("r-deny", "ohmail/Screened")]), "ohbox");
    expect(plan.ruleState).toBe("retargeted");
    expect(plan.ruleMutations).toContainEqual({ kind: "rule_update", ruleId: "r-deny", destination: "INBOX", applyRetro: true });
  });

  it("one rule already there is still 'already' and re-armed — the ordinary case", async () => {
    const plan = planScreeningChange(await sheet([rule("r-allow", "INBOX")]), "ohbox");
    expect(plan.ruleState).toBe("already");
    expect(plan.ruleMutations).toEqual([{ kind: "rule_update", ruleId: "r-allow", destination: "INBOX", applyRetro: true }]);
  });
});
