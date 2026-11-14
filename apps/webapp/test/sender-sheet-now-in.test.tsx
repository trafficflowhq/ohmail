/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  consentPartition,
  type EngineMessage,
  type Folder,
  type RuleDTO,
  type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { SenderMenu } from "../app/shell/SenderMenu";
import { senderScreening } from "@ohmail/app-logic/press/sender-screening";
import { shellSliceOf } from "./source-anchor";

/**
 * THE SHEET SAYS WHERE THE LIST SHOWS THE MAIL (SENDER-SHEET-NOW-IN-READS-THE-FILED-FOLDER). The
 * "Now in" line and the check mark read each message's FILED folder, while the list presents mail
 * by the consent partition: a deny twin shows INBOX mail in Screened, a News rule shows it in
 * News, a dormant stranger's read mail sits in History. The sheet reads the list's placement.
 */
const NOW = new Date("2026-09-25T09:00:00.000Z");
const ADDR = "lena@atelier.example";
let seq = 0;

function msg(id: string, folder: Folder, over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: id,
    from: { name: null, address: ADDR }, to: [], cc: [], date: "2026-09-24T09:00:00.000Z", folder,
    snippet: id, unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-24T09:00:00.000Z", ...over,
  };
}

function rule(id: string, destination: string, over: Partial<RuleDTO> = {}): RuleDTO {
  return {
    id, kind: "sender", match: ADDR, destination: destination as Folder, priority: 0, provenance: "manual",
    enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-09-20T09:00:00.000Z", updatedAt: "2026-09-20T09:00:00.000Z", ...over,
  };
}

async function mirror(list: EngineMessage[], rules: RuleDTO[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...list.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
    ...rules.map((r): SyncChange => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
  ]);
  return store;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** The sheet as the shell resolves it: the list's placement handed in beside the mirror. */
async function sheet(list: EngineMessage[], rules: RuleDTO[], opts: { placed?: boolean } = {}) {
  const store = await mirror(list, rules);
  const placeOf = consentPartition(store, { now: NOW }).placeOf;
  const sender = senderScreening(store, list[0]!.id, undefined, opts.placed === false ? undefined : placeOf)!;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(React.createElement(NextIntlClientProvider, {
      locale: "en", messages,
      children: React.createElement(SenderMenu, {
        state: { messageId: list[0]!.id, x: 0, y: 0 }, sender, onChoose: () => {}, onOpenDetail: () => {}, onClose: () => {},
      }),
    }));
  });
  const el = host;
  return {
    placeOf,
    now: el.querySelector(".sm-now")?.textContent ?? "",
    checked: [...el.querySelectorAll("li[role=option]")]
      .filter((li) => li.getAttribute("aria-selected") === "true" || li.querySelector(".ck"))
      .map((li) => (li.firstChild?.textContent ?? "").trim()),
  };
}

describe("the sheet reads the list's placement", () => {
  it("allow Ohbox and a deny Screened: the row shows in Screened, and so does the sheet", async () => {
    const s = await sheet([msg("m1", "INBOX")], [rule("r-allow", "INBOX"), rule("r-deny", "ohmail/Screened")]);
    expect(s.placeOf.get("m1")).toBe("ohmail/Screened");
    expect(s.now, "the sheet named the filed folder").toContain("now in Screened out");
    expect(s.checked).toEqual(["Screened out"]);
  });

  it("one News rule over mail still filed in the Inbox: Now says Ohbox, as the list does; the ✓ is the rule's", async () => {
    // INVERTED by ARCH-R902: the rule never moved m1, so the list and the Now line
    // both show it in the Ohbox. The ✓ is where their RULE files their mail, News (tester round
    // 24: a sheet marking the letters' place hid the rule once the letters were split).
    const s = await sheet([msg("m1", "INBOX")], [rule("r-news", "ohmail/News")]);
    expect(s.placeOf.get("m1")).toBe("INBOX");
    expect(s.now).toContain("now in Ohbox");
    expect(s.checked).toEqual(["News"]);
  });

  it("a rule in the News pile's older spelling is the same pile", async () => {
    // Mail the organizer FILED in the old-spelled folder since ARCH-R902 — the place is its folder.
    const s = await sheet([msg("m1", "ohmail/Reads" as never)], [rule("r-old", "ohmail/Reads")]);
    expect(s.now).toContain("now in News");
    expect(s.checked).toEqual(["News"]);
  });

  it("a dormant stranger's read mail is in History, and no pile is checked", async () => {
    const s = await sheet([msg("m1", "INBOX", { unread: false, date: "2026-01-05T09:00:00.000Z" })], []);
    expect(s.placeOf.get("m1")).toBeNull();
    expect(s.now).toContain("now in History");
    expect(s.checked).toEqual([]);
  });

  it("mail split between two places names each with its count, and no pile is checked", async () => {
    const s = await sheet([
      msg("m1", "ohmail/Receipts"),
      msg("m2", "INBOX", { unread: false, date: "2026-01-05T09:00:00.000Z" }),
    ], []);
    expect(s.now).toBe("2 messages — Receipts 1 · the Screener 1");
    expect(s.checked).toEqual([]);
  });

  it("four places or more stay spread", async () => {
    const s = await sheet([
      msg("m1", "ohmail/Receipts"),
      msg("m2", "ohmail/News"),
      msg("m3", "ohmail/Screened"),
      msg("m4", "ohmail/Quarantine"),
    ], []);
    expect(s.now).toContain("spread across several views");
  });

  it("the ordinary case is unchanged: one rule where the mail is filed", async () => {
    const s = await sheet([msg("m1", "INBOX")], [rule("r-allow", "INBOX")]);
    expect(s.now).toContain("now in Ohbox");
    expect(s.checked).toEqual(["Ohbox"]);
  });

  it("with no placement handed in the sheet reads the filed folder, as it always did", async () => {
    const s = await sheet([msg("m1", "INBOX")], [rule("r-allow", "INBOX"), rule("r-deny", "ohmail/Screened")], { placed: false });
    expect(s.now).toContain("now in Ohbox");
  });
});

describe("the shell hands the sheet the list's placement", () => {
  it("the sender sheet is resolved with the partition the lists render from", () => {
    expect(shellSliceOf("senderMenuFor")).toMatch(/senderScreening\([^;]*consentView\?\.placeOf\)/);
  });
});
