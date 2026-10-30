/**
 * The phone's Screener list draws a sender whose name claims a company with the claim
 * on the row ("Not PayPal" with the shield), and speaks it, as the web's row does — not only once the
 * row is opened. No React Native renderer here (`mail-row-badges-spoken.test.ts` says why), so the
 * row is measured by its code with comments blanked and the words by calling the copy.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryMirrorStore, type SyncChange } from "@ohmail/client-engine";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { liveScreener, presentedOf, type WorldView } from "../src/state/live";
import { Copy } from "../src/copy";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const code = withoutComments(fs.readFileSync(path.join(HERE, "..", "app/(tabs)/screener.tsx"), "utf8"));
const waitingRow = code.slice(code.indexOf("function WaitingRow("));

describe("the phone's waiting row names the claim", () => {
  it("draws the chip with the shield, from the row's own fact", () => {
    expect(waitingRow).toMatch(/const claim = row\.checked \? Copy\.senderCheckChip\(row\.checked\.brand\) : null;/);
    expect(waitingRow).toMatch(/\{claim \? <Badge icon="shield">\{claim\}<\/Badge> : null\}/);
  });

  it("speaks it in the row's label, in the deck's own sentence", () => {
    expect(waitingRow).toMatch(/const aria = Copy\.senderRowAria\(row\.name, row\.address, row\.held\.length, claim \?\? ""\);/);
    expect(waitingRow).toMatch(/accessibilityLabel=\{mark \? `\$\{aria\} \$\{mark\.text\}` : aria\}/);
    expect(Copy.senderRowAria("Pay", "service@stranger-fixture.example", 1, "Not PayPal")).toBe("Pay, service@stranger-fixture.example, 1 message, Not PayPal");
    expect(Copy.senderRowAria("Pay", "service@stranger-fixture.example", 1, "")).toBe("Pay, service@stranger-fixture.example, 1 message");
    expect(Copy.senderRowAria("Pay", "service@stranger-fixture.example", 2, "")).toBe("Pay, service@stranger-fixture.example, 2 messages");
  });

  it("the chip's words are the sheet's", () => {
    expect(Copy.senderCheckChip("PayPal")).toBe("Not PayPal");
  });

  it("the fact reaches the row the tab renders (the data half)", async () => {
    const view: WorldView = { now: new Date("2026-10-09T10:42:00Z"), zone: "UTC" };
    const store = new MemoryMirrorStore();
    await store.load();
    const date = "2026-10-09T10:30:00.000Z";
    await store.applyChanges([{
      type: "message", op: "create", id: "m-pp", seq: 1, updatedAt: date,
      entity: {
        id: "m-pp", accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
        subject: "Your account", from: { name: "Fixture Stranger PayPal", address: "service@stranger-fixture.example" },
        to: [], cc: [], date, folder: "ohmail/Screener", snippet: "s", unread: true,
        hasAttachments: false, attachmentCount: 0,
        sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
        triage: null, labels: [], remoteContent: "none", updatedAt: date,
        senderCheck: { reason: "impersonation", brand: "PayPal", domainShared: false },
      },
    } as SyncChange]);
    const rows = liveScreener(presentedOf(store, view.now), view);
    expect(rows.waiting[0]?.checked?.brand).toBe("PayPal");
  });
});
