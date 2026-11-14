import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EngineMutation, MutationStatus, RuleDTO, StayVerdict } from "@ohmail/client-engine";
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

  it("the shell's press says the read-back through these two functions", () => {
    const src = withoutComments(readFileSync(`${process.cwd()}/apps/webapp/app/shell/shell-verbs.ts`, "utf8"));
    const press = sliceOfDeclaration(src, "changeScreening");
    expect(press).toMatch(/verdictAction\(v, \{ scope, address: sender\.address \}\)/);
    expect(press).toMatch(/moveInBatches\(act\.ids, wanted,/);
    expect(press).not.toMatch(/\.slice\(0, 50\)/);
  });
});
