/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation, RuleEntity as RuleDTO } from "@ohmail/wire";
import { readFileSync } from "node:fs";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryMirrorStore, OhmailEngine, type MutationStatus, type StayVerdict, type SyncChange } from "@ohmail/client-engine";
import * as readBack from "@ohmail/app-logic/press/press-verdict";
import { confirmSyncOwner, createSyncGate, registerSyncGate } from "@ohmail/app-logic/session/sync-scheduler";
import { forgetOwner, rememberOwner } from "@ohmail/app-logic/storage/owner-cookie";
import { ISO, act, installShellEnv, mailbox, mountShell, teardownShellEnv, tick } from "./fixtures/live-walk-shell";
import en from "../messages/en.json";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { moveInBatches, verdictAction, verdictKeyOf } from "@ohmail/app-logic/press/press-verdict";
import { sliceOfDeclaration } from "./source-anchor";

/**
 * WHAT A SCREENING PRESS'S READ-BACK SENTENCE MAY OFFER. "Remove that rule" deletes only a subject
 * rule for the pressed address: a rule for everyone at the domain is named in the sentence and
 * nothing deletes it in one press. "Move them" moves every row it counted, fifty at a time.
 */
const ADDR = "info@shop.example";

function rule(o: Partial<RuleDTO> & Pick<RuleDTO, "id">): RuleDTO {
  return {
    kind: "sender", match: ADDR, destination: "ohmail/News", priority: 0, provenance: "manual", enabled: true,
    subjectContains: "[Weekly-Digest]", bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-08-12T17:00:00.000Z", updatedAt: "2026-08-12T17:00:00.000Z", ...o,
  } as RuleDTO;
}

const kept = (r: RuleDTO): StayVerdict =>
  ({ key: "kept", count: 2, kept: 1, keptPlace: r.destination, term: r.subjectContains!, field: "subject", rule: r });

describe("Remove that rule is offered only for the pressed address's own rule", () => {
  it("a subject rule for the pressed address: offered (the positive control)", () => {
    const r = rule({ id: "own" });
    expect(verdictAction(kept(r), { scope: "sender", address: "Info@Shop.example" })).toEqual({ kind: "remove", ruleId: "own" });
    expect(verdictKeyOf(kept(r) as Exclude<StayVerdict, { key: "none" }>)).toBe("verdictKept");
  });

  it("removes only the addressed subject rule, then retries the mounted screening press", async () => {
    installShellEnv();
    const apiBase = process.env.NEXT_PUBLIC_API_BASE;
    process.env.NEXT_PUBLIC_API_BASE = "";
    const store = new MemoryMirrorStore();
    const accountId = "acct_live_1";
    const box = mailbox({ id: "mb_1", organizerRole: "organizer", lastSyncAt: ISO,
      organizerChecked: true, organizeConsentedAt: ISO });
    const addressed = rule({ id: "addressed", destination: "ohmail/Receipts" });
    const control = rule({ id: "unrelated", match: ["other", "mail.invalid"].join("@") });
    const general = rule({ id: "general", destination: "INBOX", subjectContains: null });
    const seed: EngineMessage = {
      id: "seed", accountId, mailboxId: box.id, folder: "INBOX", subject: "The open delivery",
      from: { name: "Shop", address: ADDR }, to: [], cc: [], threadId: null, messageIdHeader: null,
      date: ISO, updatedAt: ISO, snippet: "Delivery information", unread: false, hasAttachments: false,
      attachmentCount: 0, sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      labels: [], triage: null, remoteContent: "none",
    };
    const stayed: EngineMessage = {
      ...seed, id: "stayed", subject: "[Weekly-Digest] Earlier delivery", folder: "ohmail/Receipts",
      date: "2026-08-03T09:00:00.000Z",
    };
    const recent = Array.from({ length: 49 }, (_, index): EngineMessage => ({
      ...seed, id: `recent-${index}`, folder: "ohmail/Receipts", subject: "Recent delivery",
    }));
    const letters = new Map([seed, ...recent, stayed].map((m) => [m.id, m]));
    const sent: EngineMutation[] = [];
    let removed = false;
    let seq = 0;
    const change = (id: string, type: "message" | "rule", op: SyncChange["op"], entity?: unknown): SyncChange => ({
      id, type, op, seq: ++seq, updatedAt: ISO, ...(entity === undefined ? {} : { entity }),
    });
    const verdict = vi.spyOn(readBack, "screeningReadBack").mockImplementation(() => ({
      at: 1, shown: ["seed"],
      verdict: removed ? { key: "none" } : kept(addressed),
    }));
    try {
      await store.load();
      await store.applyChanges([
        ...[...letters.values()].map((letter) => change(letter.id, "message", "create", letter)),
        ...[addressed, control, general].map((row) => change(row.id, "rule", "create", row)),
      ]);
      const engine = new OhmailEngine({ store, adapter: {
        sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] },
          cursor: store.getCursor(), hasMore: false, serverTime: ISO }),
        mutate: async (mutation: EngineMutation) => {
          sent.push(mutation);
          if (mutation.kind === "rule_delete") {
            removed = mutation.ruleId === addressed.id;
            return { changes: [change(mutation.ruleId, "rule", "delete")], seq: null };
          }
          if (mutation.kind !== "move") return { changes: [], seq: null };
          const current = letters.get(mutation.messageId)!;
          const row = { ...current, folder: mutation.folder as EngineMessage["folder"] };
          letters.set(row.id, row);
          return { changes: [change(row.id, "message", "update", row)], seq: null };
        },
        fetchBody: async () => null,
      } } as never);
      rememberOwner(accountId);
      registerSyncGate(engine, createSyncGate(accountId));
      confirmSyncOwner(engine, accountId);
      const { WebContactScreening } = await import("../app/(product)/mailbox/WebContactScreening");
      const host = within(await mountShell([box], { engine, contactScreening: WebContactScreening }));
      const press = async (button: HTMLElement) => {
        await act(async () => { button.click(); });
        await tick(50);
      };
      await press(host.getByRole("option", { name: /The open delivery/ }));
      const reader = within(screen.getByRole("region", { name: "Open message" }));
      await press(reader.getByRole("button", { name: en.screening.action }));
      const dialog = within(screen.getByRole("dialog", { name: /^Screening/ }));
      await press(dialog.getByRole("switch", { name: en.screening.ruleToggleAria }));
      await press(dialog.getByRole("radio", { name: new RegExp(en.screener.pileReads) }));
      await tick(250);
      expect(verdict).toHaveBeenCalled();
      expect(sent).toContainEqual(expect.objectContaining({ kind: "move", messageId: seed.id, folder: "ohmail/News" }));
      expect(letters.get(stayed.id)?.folder).toBe("ohmail/Receipts");
      const beforeFollowUp = sent.length;
      await press(screen.getByRole("button", { name: en.screening.verdictRemoveRule }));
      await tick(250);
      const followUp = sent.slice(beforeFollowUp);
      expect(followUp[0]).toMatchObject({ kind: "rule_delete", ruleId: addressed.id });
      expect(followUp.filter(({ kind }) => kind === "rule_delete")).toHaveLength(1);
      expect(followUp.slice(1)).toContainEqual(
        expect.objectContaining({ kind: "move", messageId: stayed.id, folder: "ohmail/News" }),
      );
      expect(letters.get(stayed.id)?.folder).toBe("ohmail/News");
      expect(engine.read().get("rule", addressed.id)).toBeUndefined();
      expect(engine.read().get("rule", control.id)).toMatchObject({ id: control.id });
      expect(engine.read().get("rule", general.id)).toMatchObject({ id: general.id });
    } finally {
      verdict.mockRestore();
      await teardownShellEnv();
      forgetOwner();
      process.env.NEXT_PUBLIC_API_BASE = apiBase;
    }
  });

  it("a rule for everyone at the domain, narrowed by subject: named as the domain's, never offered", () => {
    const r = rule({ id: "wide", kind: "domain", match: "shop.example" });
    expect(verdictAction(kept(r), { scope: "sender", address: ADDR })).toBeNull();
    expect(verdictKeyOf(kept(r) as Exclude<StayVerdict, { key: "none" }>)).toBe("verdictKeptDomain");
  });

  it("a domain press over one address's subject rule: not offered — it is somebody's own rule", () => {
    const r = rule({ id: "theirs", match: "sales@shop.example" });
    expect(verdictAction(kept(r), { scope: "domain", address: ADDR })).toBeNull();
    expect(verdictAction(kept(rule({ id: "other" , match: "sales@shop.example" })), { scope: "sender", address: ADDR })).toBeNull();
  });

  it("both catalogues carry the domain sentence with the domain and the term", async () => {
    for (const lang of ["en", "de"]) {
      const cat = JSON.parse(readFileSync(`${process.cwd()}/apps/webapp/messages/${lang}.json`, "utf8")) as { screening: Record<string, string> };
      expect(cat.screening.verdictKeptDomain).toMatch(/\{domain\}[\s\S]*\{term\}/);
      expect(cat.screening.verdictMoved).toMatch(/\{count, plural/);
    }
  });
});

describe("Move them moves every row it counted, fifty at a time", () => {
  const ids = Array.from({ length: 120 }, (_, i) => `m-${i}`);

  it("the action carries every counted row", () => {
    const v: StayVerdict = { key: "stillLegacy", count: 3, still: 120, ids, folder: "ohmail/Reads", movable: true };
    expect(verdictAction(v, { scope: "sender", address: ADDR })).toEqual({ kind: "move", ids });
  });

  it("rows past two batches: one move each, in three batches, never more than fifty in flight, each answered first", async () => {
    let inFlight = 0;
    let peak = 0;
    const sent: EngineMutation[] = [];
    const dispatch = async (m: EngineMutation): Promise<{ status: MutationStatus }> => {
      sent.push(m);
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return { status: m.kind === "move" && m.messageId === "m-7" ? "rolled_back" : m.kind === "move" && m.messageId === "m-99" ? "awaiting_organizer" : "confirmed" };
    };
    const r = await moveInBatches(ids, "INBOX", dispatch);
    expect(sent.map((m) => (m.kind === "move" ? m.messageId : ""))).toEqual(ids);
    expect(sent.every((m) => m.kind === "move" && m.folder === "INBOX")).toBe(true);
    expect(peak).toBe(50);
    expect(r).toEqual({ moved: 118, refused: 1, waiting: 1 });
  });

  it("the shell's press says the read-back through these two functions", async () => {
    const src = withoutComments(readFileSync(`${process.cwd()}/apps/webapp/app/(product)/mailbox/WebContactScreening.tsx`, "utf8"));
    const press = sliceOfDeclaration(src, "choose");
    expect(press).toMatch(/verdictAction\(back\.verdict, \{ scope, address: current\.sender\.address \}\)/);
    expect(press).toMatch(/moveStayed\(action\.ids, dest, scope, current\.sender\.address, current\.message\.mailboxId, originalMissing\)/);
    const batch = sliceOfDeclaration(src, "moveStayed");
    expect(batch).toMatch(/const eligible = ids\.filter\(/);
    expect(batch).toMatch(/const wanted = FOLDER_OF_VIEW\[dest\]/);
    expect(batch).toMatch(/const moving = eligible\.filter\(\(id\) => placeOf\.get\(id\) !== wanted\)/);
    expect(batch).toMatch(/moveInBatches\(moving, wanted,/);
    expect(press + batch).not.toMatch(/\.slice\(0, 50\)/);

    installShellEnv();
    const apiBase = process.env.NEXT_PUBLIC_API_BASE;
    process.env.NEXT_PUBLIC_API_BASE = "";
    const store = new MemoryMirrorStore();
    const rows = new Map<string, EngineMessage>();
    const sent: string[] = [];
    const firstBatch = Array.from({ length: 49 }, (_, i) => `first-${i}`);
    const accountId = "acct_live_1";
    const mailboxId = "mb_1";
    const own = mailbox({
      id: mailboxId, organizerRole: "organizer", lastSyncAt: ISO, organizerChecked: true, organizeConsentedAt: ISO,
    });
    let seq = 0;
    const change = (entity: EngineMessage, op: "create" | "update"): SyncChange => ({
      type: "message", op, id: entity.id, seq: ++seq, updatedAt: ISO, entity,
    });
    const make = (id: string, folder: EngineMessage["folder"], subject: string): EngineMessage => ({
      id, accountId, mailboxId, folder, subject, from: { name: "Shop", address: ADDR }, to: [], cc: [],
      threadId: null, messageIdHeader: null, date: ISO, updatedAt: ISO,
      snippet: "Delivery information", unread: false, hasAttachments: false, attachmentCount: 0,
      sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      labels: [], triage: null, remoteContent: "none",
    });
    const verdict = vi.spyOn(readBack, "screeningReadBack").mockReturnValue({
      at: 1, shown: ["seed"],
      verdict: { key: "still", count: 1, still: ids.length, stillPlace: "ohmail/Receipts", ids, movable: true },
    });
    try {
      const letters = [
        make("seed", "INBOX", "The newest delivery"),
        ...firstBatch.map((id) => make(id, "ohmail/Receipts", "A recent delivery")),
        ...ids.map((id) => ({ ...make(id, "ohmail/Receipts", "An earlier delivery"), date: "2026-08-03T09:00:00.000Z" })),
        { ...make("unreported", "ohmail/Receipts", "A delivery left out of the report"), date: "2026-08-02T09:00:00.000Z" },
      ];
      for (const row of letters) rows.set(row.id, row);
      await store.load();
      await store.applyChanges([
        ...letters.map((row) => change(row, "create")),
        { type: "rule", op: "create", id: "sender-rule", seq: ++seq, updatedAt: ISO,
          entity: rule({ id: "sender-rule", destination: "INBOX", subjectContains: null }) },
      ]);
      const engine = new OhmailEngine({
        store,
        adapter: {
          sync: async () => ({
            changes: { creates: [], updates: [], moves: [], deletes: [] },
            cursor: store.getCursor(), hasMore: false, serverTime: ISO,
          }),
          mutate: async (mutation: EngineMutation) => {
            if (mutation.kind !== "move") return { changes: [], seq: null };
            sent.push(mutation.messageId);
            const row = { ...rows.get(mutation.messageId)!, folder: mutation.folder as EngineMessage["folder"] };
            rows.set(row.id, row);
            return { changes: [change(row, "update")], seq: null };
          },
          fetchBody: async () => null,
        },
      } as never);
      rememberOwner(accountId);
      registerSyncGate(engine, createSyncGate(accountId));
      confirmSyncOwner(engine, accountId);
      const { WebContactScreening } = await import("../app/(product)/mailbox/WebContactScreening");
      const host = within(await mountShell([own], { engine, contactScreening: WebContactScreening }));
      const press = async (button: HTMLElement) => {
        await act(async () => { button.click(); });
        await tick(50);
      };
      await press(host.getByRole("option", { name: /The newest delivery/ }));
      const reading = within(screen.getByRole("region", { name: "Open message" }));
      await press(reading.getByRole("button", { name: en.screening.action }));
      const dialogue = within(screen.getByRole("dialog", { name: /^Screening/ }));
      await press(dialogue.getByRole("switch", { name: en.screening.ruleToggleAria }));
      await press(dialogue.getByRole("radio", { name: new RegExp(en.screener.pileReads) }));
      await tick(250);
      expect([...sent].sort()).toEqual(["seed", ...firstBatch].sort());
      expect(verdict).toHaveBeenCalled();
      await press(screen.getByRole("button", { name: "Move them" }));
      await tick(250);
      expect(sent.slice(50)).toEqual(ids);
      expect(rows.get("unreported")?.folder).toBe("ohmail/Receipts");
    } finally {
      verdict.mockRestore();
      await teardownShellEnv();
      forgetOwner();
      process.env.NEXT_PUBLIC_API_BASE = apiBase;
    }
  });

});
