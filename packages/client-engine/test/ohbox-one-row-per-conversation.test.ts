import { describe, expect, it } from "vitest";
import {
  conversationKeyOf,
  foldOhboxRows,
  ohboxRows,
  ohboxView,
  resurfacedThreads,
  type EngineMessage,
  type EntityReader,
  type MessageStateDTO,
  type OhboxRowSection,
} from "@ohmail/client-engine";

/**
 * ═══ ONE ROW PER CONVERSATION, ACROSS THE OHBOX (owner 2026-09-28) ═══════════════════════════
 *
 * A user answered the open message and the Ohbox drew one conversation twice: the answered
 * message under New and the reply under Earlier. The rule now: a conversation stands in ONE
 * section — Resurfaced if the engine holds it there, else New if any Ohbox member is unread INBOX
 * mail or the row being read, else Earlier — and the fold draws it once. There is no property
 * library in the repo, so the space is BOUNDED and ENUMERATED: every conversation of one to three
 * members over six member states, crossed with every choice of the held open row, beside two
 * threadless controls. MUTATIONS WATCHED: `ohboxView`'s filing put back to per message reddens
 * (d); the fold keyed by section, (c); the last claim winning, (a) (b) (c); the absorb dropped,
 * the belt arm below only — the engine's own lists never need it; the row's target put back to
 * its face, or to the latest unread member with our own Sent copy counted, (e).
 */

/** `sent-unread`: our own Sent copy flagged unread, as a row's Mark unread over every member left it. */
type State = "unread" | "read" | "sent" | "sent-unread" | "pin" | "bubbled" | "parked";
const STATES: readonly State[] = ["unread", "read", "sent", "sent-unread", "pin", "bubbled", "parked"];
const OWN: ReadonlySet<State> = new Set(["sent", "sent-unread"]);

const CLAIM_AT = "2026-08-01T08:00:00.000Z";
const at = (i: number): string => `2026-08-0${2 + i}${"T"}09:00:00.000Z`;

function mk(id: string, threadId: string | null, s: State, i: number): EngineMessage {
  return {
    id, accountId: "a", mailboxId: "mb", threadId, messageIdHeader: null,
    subject: `s-${id}`, from: { name: id, address: `${id}@example.invalid` }, to: [], cc: [],
    date: at(i), arrivedAt: at(i), folder: OWN.has(s) ? "Sent" : "INBOX", snippet: "",
    unread: s === "unread" || s === "sent-unread", hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: at(i),
  } as EngineMessage;
}

const claimState: Partial<Record<State, string>> = { pin: "resurfaced", bubbled: "bubbled_up", parked: "reply_later" };

function readerOf(messages: EngineMessage[], states: State[]): EntityReader {
  const claims: MessageStateDTO[] = [];
  const rows = messages.map((m, i) => {
    const st = claimState[states[i]!];
    if (!st) return m;
    const c = {
      messageId: m.id, state: st as MessageStateDTO["state"],
      bubbleUpAt: st === "bubbled_up" ? "2026-09-30T09:00:00.000Z" : null, setAt: CLAIM_AT, updatedAt: CLAIM_AT,
    };
    claims.push(c);
    return { ...m, triage: c } as EngineMessage;
  });
  const byType: Record<string, unknown[]> = { message: rows, message_state: claims, thread: [] };
  return {
    list: <T,>(type: string) => (byType[type] ?? []) as T[],
    get: <T,>(type: string, id: string) => (byType[type] ?? []).find((e) => (e as { id?: string }).id === id) as T | undefined,
    entries: <T,>(type: string) => (byType[type] ?? []).map((entity, i) => ({
      id: (entity as { id?: string }).id ?? String(i), entity: entity as T, seq: i,
    })),
    version: () => 1,
  } as unknown as EntityReader;
}

interface Mirror { reader: EntityReader; held: string | null; states: Map<string, State> }

/** Every mirror in the bounded space: T of 1–3 members, every state, every held choice. */
function* mirrors(): Generator<Mirror> {
  const combos = (k: number): State[][] =>
    k === 0 ? [[]] : combos(k - 1).flatMap((c) => STATES.map((s) => [...c, s]));
  for (let k = 1; k <= 3; k++) {
    for (const combo of combos(k)) {
      const members = combo.map((s, i) => mk(`t${i}`, "T", s, i));
      // The two threadless controls: an unread one and a read one, their own conversations.
      const all = [...members, mk("solo-u", null, "unread", 4), mk("solo-r", null, "read", 5)];
      const states = [...combo, "unread", "read"] as State[];
      const byId = new Map(all.map((m, i) => [m.id, states[i]!]));
      const heldChoices = [null, ...all.filter((m) => m.folder === "INBOX").map((m) => m.id)];
      for (const held of heldChoices) yield { reader: readerOf(all, states), held, states: byId };
    }
  }
}

/** The mirrors the space predicts: per combo, one with nothing held plus one per INBOX member. */
function predictedCount(): number {
  const s = STATES.length;
  const inbox = STATES.filter((x) => !OWN.has(x)).length;
  let n = 0;
  for (let k = 1; k <= 3; k++) {
    // Σ over combos of (1 + inbox members) = s^k (1 + 2 controls) + k · inbox · s^(k−1).
    n += s ** k * 3 + k * inbox * s ** (k - 1);
  }
  return n;
}

/** Ohbox members by the rule's own words: not parked, not the account's calendar reply. */
const onOhbox = (s: State): boolean => s === "unread" || s === "read" || OWN.has(s);

describe("the Ohbox draws each conversation once (exhaustive census)", () => {
  it("every mirror: one row per key, nothing dropped, the section by the rule, ohboxView exclusive", () => {
    let count = 0;
    const sections = new Map<OhboxRowSection, number>();
    const failures: string[] = [];
    for (const { reader, held, states } of mirrors()) {
      count += 1;
      const label = `${[...states].map(([id, s]) => `${id}:${s}`).join(",")} held=${held}`;
      const rows = ohboxRows(reader, held);
      const flat = [...rows.resurfaced, ...rows.new, ...rows.earlier, ...rows.older];
      for (const r of flat) sections.set(r.section, (sections.get(r.section) ?? 0) + 1);

      // (a) no key stands on two rows across all sections.
      const keys = flat.map((r) => r.key);
      if (new Set(keys).size !== keys.length) failures.push(`(a) ${label}: ${keys.join(" ")}`);

      // (b) the rows' members are exactly the fold's inputs: every message once, none invented.
      const view = ohboxView(reader, held);
      const engineRows = resurfacedThreads(reader);
      const input = [...engineRows.flatMap((r) => r.members), ...view.newForYou, ...view.previouslySeen]
        .map((m) => m.id).sort();
      const drawn = flat.flatMap((r) => r.members.map((m) => m.id)).sort();
      if (JSON.stringify(input) !== JSON.stringify(drawn)) failures.push(`(b) ${label}: ${drawn} vs ${input}`);

      // (c) each conversation's section, derived from the states rather than read off the code.
      const resurfacedKeys = new Set(engineRows.map((r) => r.key));
      for (const key of ["T", "msg:solo-u", "msg:solo-r"]) {
        const ids = [...states.keys()].filter((id) => (key === "T" ? id.startsWith("t") : key === `msg:${id}`));
        const here = ids.filter((id) => onOhbox(states.get(id)!));
        const want = resurfacedKeys.has(key)
          ? "resurfaced"
          : here.some((id) => states.get(id) === "unread" || id === held)
            ? "new"
            : here.length > 0 ? "earlier" : null;
        const got = flat.filter((r) => r.key === key).map((r) => r.section);
        if (JSON.stringify(got) !== JSON.stringify(want === null ? [] : [want])) {
          failures.push(`(c) ${label}: ${key} in ${got.join("+") || "none"}, rule says ${want ?? "none"}`);
        }
      }

      // (d) ohboxView itself files every conversation into one list.
      const listOf = new Map<string, Set<string>>();
      const note = (list: string, ms: readonly EngineMessage[]) => {
        for (const m of ms) {
          const k = conversationKeyOf(m);
          if (!listOf.has(k)) listOf.set(k, new Set());
          listOf.get(k)!.add(list);
        }
      };
      note("new", view.newForYou);
      note("earlier", view.previouslySeen);
      for (const [k, lists] of listOf) {
        if (lists.size > 1) failures.push(`(d) ${label}: ${k} in ${[...lists].join("+")}`);
        if (resurfacedKeys.has(k)) failures.push(`(d) ${label}: ${k} resurfaced and in ${[...lists].join("+")}`);
      }

      // (e) a New or Earlier row never stands for our own mail beside a letter, read or unread.
      for (const r of [...rows.new, ...rows.earlier]) {
        if (!OWN.has(states.get(r.openTarget.id)!)) continue;
        if (r.members.some((m) => !OWN.has(states.get(m.id)!))) failures.push(`(e) ${label}: ${r.key} stands for ${r.openTarget.id}`);
      }
    }
    // A zero is a reading only beside the space it was read over.
    expect(count, "fewer mirrors than the space predicts").toBe(predictedCount());
    for (const s of ["resurfaced", "new", "earlier"] as const) {
      expect(sections.get(s) ?? 0, `the census never produced a ${s} row`).toBeGreaterThan(0);
    }
    const byClause = ["(a)", "(b)", "(c)", "(d)", "(e)"].map((c) => `${c} ${failures.filter((f) => f.startsWith(c)).length}`);
    expect(failures.slice(0, 12), `${failures.length} failures — ${byClause.join(", ")}`).toEqual([]);
  });

  it("CONTROL: an unread reply beside read history and an own reply is ONE row, in New, opened on the unread", () => {
    const members = [mk("t0", "T", "read", 0), mk("t1", "T", "sent", 1), mk("t2", "T", "unread", 2)];
    const rows = ohboxRows(readerOf(members, ["read", "sent", "unread"]));
    expect(rows.new.map((r) => r.key)).toEqual(["T"]);
    expect(rows.earlier).toEqual([]);
    expect(rows.new[0]!.members.map((m) => m.id)).toEqual(["t2", "t1", "t0"]);
    expect(rows.new[0]!.openTarget.id).toBe("t2");
    expect(rows.new[0]!.unreadCount).toBe(1);
  });

  it("CONTROL: once it is all read it is ONE row under Earlier, faced by the newest member", () => {
    const members = [mk("t0", "T", "read", 0), mk("t1", "T", "read", 1), mk("t2", "T", "sent", 2)];
    const rows = ohboxRows(readerOf(members, ["read", "read", "sent"]));
    expect(rows.new).toEqual([]);
    expect(rows.earlier.map((r) => r.key)).toEqual(["T"]);
    expect(rows.earlier[0]!.face.id).toBe("t2");
    expect(rows.earlier[0]!.openTarget.id, "the letter, not our reply").toBe("t1");
  });

  it("CONTROL: plain threadless rows are unchanged — one row each, their own section", () => {
    const rows = ohboxRows(readerOf([mk("u", null, "unread", 1), mk("r", null, "read", 0)], ["unread", "read"]));
    expect(rows.new.map((r) => [r.key, r.members.length])).toEqual([["msg:u", 1]]);
    expect(rows.earlier.map((r) => [r.key, r.members.length])).toEqual([["msg:r", 1]]);
  });
});

describe("the fold's belt: session lists and the Older tail", () => {
  it("a conversation split across the lists is drawn once, by the first section to claim it", () => {
    const t = (id: string, i: number, s: State = "read") => mk(id, "T", s, i);
    const rows = foldOhboxRows({
      resurfaced: [], new: [t("n", 3, "unread")], earlier: [t("e", 2), mk("x", null, "read", 1)],
      older: [t("o", 0), mk("o2", "U", "read", 0), mk("o3", "U", "read", 0)],
    }, []);
    expect(rows.new.map((r) => r.members.map((m) => m.id))).toEqual([["n", "e", "o"]]);
    expect(rows.new[0]!.placing.map((m) => m.id)).toEqual(["n"]);
    expect(rows.earlier.map((r) => r.key)).toEqual(["msg:x"]);
    // Rows wholly in the Older tail fold among themselves.
    expect(rows.older.map((r) => [r.key, r.members.length])).toEqual([["U", 2]]);
  });

  it("a message handed in twice is drawn once", () => {
    const m = mk("dup", "T", "read", 0);
    const rows = foldOhboxRows({ resurfaced: [], new: [m], earlier: [m] }, []);
    expect([...rows.new, ...rows.earlier].flatMap((r) => r.members.map((x) => x.id))).toEqual(["dup"]);
  });
});
