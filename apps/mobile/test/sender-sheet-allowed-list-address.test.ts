/**
 * A LIST ADDRESS THE PERSON ALLOWED TO THE OHBOX, WITH A CLAIM UNDER ANOTHER NAME HELD (R32-03). The
 * sheet said "First contact. Nothing from this sender has reached the Ohbox" over four letters the
 * person's own rule had filed there, and its caption named a first contact the web's does not.
 * Measured on the row both surfaces derive, and on the sheet's code with comments blanked.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryMirrorStore, type SyncChange } from "@ohmail/client-engine";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { liveScreener, presentedOf, type WorldView } from "../src/state/live";
import { Copy } from "../src/copy";
import { DE } from "../src/copy.de";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sheet = withoutComments(fs.readFileSync(path.join(HERE, "..", "src/ui/SenderDetail.tsx"), "utf8"));
const view: WorldView = { now: new Date("2026-10-11T02:10:00Z"), zone: "UTC" };
const LIST = "list@lists.invalid";
const at = (min: number) => new Date(Date.UTC(2026, 9, 11, 1, min)).toISOString();

/** `inOhbox` letters the person's rule filed, `held` claims under another name; the waiting row. */
async function rowOf(o: { inOhbox: number; held: number; rule: boolean }) {
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  const letter = (id: string, folder: string, min: number, extra: Record<string, unknown> = {}) => ({
    type: "message", op: "create", id, seq: ++seq, updatedAt: at(min),
    entity: {
      id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: `S ${id}`,
      from: { name: "The Lists", address: LIST }, to: [], cc: [], date: at(min), arrivedAt: at(min), folder,
      snippet: "s", unread: true, hasAttachments: false, attachmentCount: 0,
      sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: null, labels: [], remoteContent: "none", updatedAt: at(min), senderCheck: null, ...extra,
    },
  }) as SyncChange;
  const claim = { senderCheck: { reason: "impersonation", brand: "PayPal", domainShared: false, by: "ingest", list: true } };
  await store.applyChanges([
    ...(o.rule ? [{ type: "rule", op: "create", id: "r-list", seq: ++seq, updatedAt: at(30), entity: {
      id: "r-list", kind: "sender", match: LIST, destination: "INBOX", enabled: true, createdAt: at(30) } } as SyncChange] : []),
    ...Array.from({ length: o.inOhbox }, (_, i) => letter(`in-${i}`, "INBOX", 20 + i)),
    ...Array.from({ length: o.held }, (_, i) => letter(`held-${i}`, "ohmail/Screener", 40 + i, claim)),
  ]);
  const row = liveScreener(presentedOf(store, view.now), view).waiting.find((r) => r.address === LIST);
  if (!row) throw new Error("no waiting row for the list address");
  return row;
}

/** The caption exactly as the sheet draws it — the sheet's own call is pinned below. */
const caption = (row: Awaited<ReturnType<typeof rowOf>>) => Copy.heldCaption(row.held.length, row.firstContact);

describe("the sheet for a list address the person allowed, over a claim it holds", () => {
  it("R32-03: the row counts the four letters the rule filed, and the sheet names them", async () => {
    const row = await rowOf({ inOhbox: 4, held: 1, rule: true });
    expect(row.checked).toMatchObject({ brand: "PayPal", list: true });
    expect(row.reached).toBe(4);
    expect(sheet).toMatch(/\{row\.reached > 0 \? Copy\.senderPastTheGate\(row\.reached\) : Copy\.senderFirstContact\}/);
  });

  it("R32-03: the caption names no first contact, as the web's names none", async () => {
    expect(sheet).toMatch(/\{Copy\.heldCaption\(row\.held\.length, row\.firstContact\)\}/);
    expect(caption(await rowOf({ inOhbox: 4, held: 1, rule: true }))).toBe("1 message — all shown");
    expect(caption(await rowOf({ inOhbox: 4, held: 2, rule: true }))).toBe("2 messages — all shown");
  });

  it("CONTROL: two letters waiting and nothing past the gate is a first contact, and the caption says when", async () => {
    const row = await rowOf({ inOhbox: 0, held: 2, rule: false });
    expect(row.reached).toBe(0);
    expect(caption(row)).toBe("2 messages — all shown · first contact 01:40");
  });

  it("one letter waiting names no first contact apart from its own time, as the web's caption", async () => {
    const row = await rowOf({ inOhbox: 0, held: 1, rule: false });
    expect(row.reached).toBe(0);
    expect(caption(row)).toBe("1 message — all shown");
  });

  it("a letter of an undecided sender still in the Inbox is listed, and counted as a message, not as held", async () => {
    const row = await rowOf({ inOhbox: 1, held: 1, rule: false });
    expect(row.held).toHaveLength(2);
    expect(caption(row)).toMatch(/^2 messages — all shown/);
    expect(DE.heldCaption(row.held.length)).toBe("2 Nachrichten — vollständig gezeigt");
    expect(DE.heldCaption(1)).toBe("1 Nachricht — vollständig gezeigt");
  });
});
