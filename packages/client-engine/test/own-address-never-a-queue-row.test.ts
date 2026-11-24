import type { EngineMessage, Folder } from "@ohmail/wire";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  consentPartition,
  presentationReader,
  screenerSegments,
  senderKey,
  type ConsentOptions,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * THE ACCOUNT IS NEVER A ROW IN ITS OWN SCREENER QUEUE, WHEREVER THE MAIL SITS.
 *
 * `ConsentOptions.ownAddresses` exists so "the user appears in their own Screener queue" cannot
 * happen. It held for mail in the INBOX and not for a message physically in `ohmail/Screener`:
 * the own guard keeps such a row in its own place, `screenerSegments` grouped on the presented
 * folder, and the row was minted — while `activity` held no entry for the address and
 * `counts.activeUndecidedSenders` counted nobody behind it. The queue's rows and the partition's
 * reckoning differed by one, and the account could be asked to screen itself
 * (OWN-ADDRESS-GATE-ROW-IS-STILL-A-QUEUE-ROW, measured 2026-09-11).
 *
 * The fix is ONE PREDICATE: `ownAddressKeys` lives in the partition module and the queue's
 * grouping calls it, so the two halves cannot hold different answers about who the reader is.
 * Two properties are pinned here, and either alone is passed by an accident:
 *
 *   · AGREEMENT — `waiting.length === counts.activeUndecidedSenders` over every fixture below,
 *     which is the arithmetic the defect broke, with the exact row sets beside it.
 *   · ONE PREDICATE — the queue imports it and defines none (by import, not by grep), and a
 *     case-and-whitespace variant of an own address is still excluded, which a hand-rolled
 *     second list comparing raw strings could not do.
 *
 * Scope, stated: the WAITING segment. A row physically in `ohmail/Screened` or
 * `ohmail/Quarantine` is an explicit placement somebody made — the partition's own rule — and it
 * keeps its row, because that segment is the only surface the message has. Asserted below rather
 * than left to be rediscovered.
 *
 * ── HOW TO WATCH IT FAIL ──────────────────────────────────────────────────────────────────────
 *
 * Over the projection the partition now presents own gate mail in the INBOX (ruling 2026-09-25),
 * so the grouping guard decides only for a RAW reader: delete the `segment === "waiting" &&
 * own.has(key)` guard and `own-mail-never-a-screener-decision.test.ts`'s raw-reader case goes
 * RED. Put the partition's own row back at the gate and the GATE-PHYSICAL case here goes RED.
 * Spell a second own-address set inside `screenerSegments` and the census block goes RED.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "src");

const NOW = new Date("2026-08-04T12:00:00.000Z");
/** Inside the 60-day window from {@link NOW}. */
const RECENT = "2026-07-20T09:00:00.000Z";
/** Outside it. */
const OLD = "2024-03-02T09:00:00.000Z";

const GATE: Folder = "ohmail/Screener";
const OWN = "me@example.com";
const STRANGER = "them@example.com";

let seq = 0;

function msg(o: {
  id: string;
  from: string;
  folder: string;
  date?: string | null;
  unread?: boolean;
}): EngineMessage {
  return {
    id: o.id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${o.id}`,
    from: { name: null, address: o.from },
    to: [],
    cc: [],
    date: o.date === undefined ? RECENT : o.date,
    folder: o.folder as Folder,
    snippet: `snippet ${o.id}`,
    unread: o.unread ?? true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: o.date ?? RECENT,
  };
}

async function mirrorOf(
  messages: EngineMessage[], mailboxes: Array<{ id: string; address: string }> = [],
): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...messages.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
    ...mailboxes.map((b) => ({ type: "mailbox", op: "create", id: b.id, seq: ++seq, updatedAt: RECENT, entity: b })),
  ] as SyncChange[]);
  return store;
}

/** The queue exactly as the shells read it — `screenerSegments` over the projection. */
function queue(store: MemoryMirrorStore, opts: ConsentOptions) {
  const part = consentPartition(store, opts);
  const segments = screenerSegments(
    presentationReader(store, part), opts.now ?? NOW, "en", "UTC", opts.ownAddresses,
  );
  return { part, segments };
}

/** The waiting senders, case-folded and sorted — the rows the doorbell counts faces from. */
function waitingSenders(store: MemoryMirrorStore, opts: ConsentOptions): string[] {
  return queue(store, opts).segments.waiting.map((r) => senderKey(r.from.address)).sort();
}

const opts: ConsentOptions = { now: NOW, ownAddresses: [OWN] };

describe("own-address mail mints no waiting row, and the two numbers agree", () => {
  /**
   * The defect's own fixture: one message from the account's own address, physically at the gate.
   * It presents in the INBOX (ruling 2026-09-25) with nothing moved, and the queue is empty.
   */
  it("GATE-PHYSICAL — no row, no face, and the message is presented in the INBOX", async () => {
    const store = await mirrorOf([msg({ id: "m1", from: OWN, folder: GATE })]);
    const { part, segments } = queue(store, opts);

    expect(segments.waiting).toEqual([]);
    expect(part.counts.activeUndecidedSenders).toBe(0);
    expect(part.activity.has(OWN)).toBe(false);

    // PRESENTED, not deleted: the projection answers with the message in the INBOX, and its
    // `physicalFolder` still names the gate it sits in on the server.
    const projected = presentationReader(store, part);
    expect(projected.get<EngineMessage>("message", "m1")?.folder).toBe("INBOX");
    expect(projected.get<EngineMessage>("message", "m1")?.physicalFolder).toBe(GATE);
    expect(projected.list<EngineMessage>("message").map((m) => m.id)).toEqual(["m1"]);
    expect(part.placeOf.get("m1")).toBe("INBOX");
    expect(part.history).toEqual([]);

    // Nothing moved, and no other segment picked the row up either.
    expect(store.list<EngineMessage>("message").map((m) => m.folder)).toEqual([GATE]);
    expect(segments.screenedOut).toEqual([]);
    expect(segments.spam).toEqual([]);
  });

  /** THE CONTRARY STATE. The same message from a stranger is one row — the guard is not a mute. */
  it("the same message from a foreign address is one row", async () => {
    const store = await mirrorOf([msg({ id: "m1", from: STRANGER, folder: GATE })]);
    const { part, segments } = queue(store, opts);

    expect(waitingSenders(store, opts)).toEqual([STRANGER]);
    expect(segments.waiting).toHaveLength(1);
    expect(part.counts.activeUndecidedSenders).toBe(1);
    expect(segments.waiting[0]!.held.map((h) => h.id)).toEqual(["m1"]);
  });

  /**
   * THE AGREEMENT PROPERTY, which is the arithmetic the defect broke: the queue's row count IS
   * the partition's count of active undecided senders, over every mix of own and foreign mail in
   * both undecided residences.
   */
  it("rows.length === activeUndecidedSenders, over every mix", async () => {
    for (const [label, messages, expected] of [
      ["own at the gate, alone", [msg({ id: "a", from: OWN, folder: GATE })], []],
      ["own in the INBOX, alone", [msg({ id: "a", from: OWN, folder: "INBOX" })], []],
      ["own in both residences", [
        msg({ id: "a", from: OWN, folder: GATE }),
        msg({ id: "b", from: OWN, folder: "INBOX" }),
      ], []],
      ["own at the gate beside two strangers", [
        msg({ id: "a", from: OWN, folder: GATE }),
        msg({ id: "b", from: STRANGER, folder: GATE }),
        msg({ id: "c", from: "third@example.com", folder: "INBOX" }),
      ], [STRANGER, "third@example.com"]],
      ["own at the gate, the stranger retired", [
        msg({ id: "a", from: OWN, folder: GATE }),
        msg({ id: "b", from: STRANGER, folder: GATE, date: OLD, unread: false }),
      ], []],
      ["own at the gate, an own row already read", [
        msg({ id: "a", from: OWN, folder: GATE, date: OLD, unread: false }),
        msg({ id: "b", from: STRANGER, folder: GATE }),
      ], [STRANGER]],
    ] as const) {
      const store = await mirrorOf([...messages]);
      const { part, segments } = queue(store, opts);
      expect(waitingSenders(store, opts), label).toEqual([...expected].sort());
      expect(segments.waiting.length, `${label}: rows vs activeUndecidedSenders`)
        .toBe(part.counts.activeUndecidedSenders);
      // And the account is never weighed as one of its own correspondents, in either residence.
      expect(part.activity.has(OWN), label).toBe(false);
    }
  });

  /**
   * THE SCOPE, asserted rather than assumed. `ohmail/Screened` and `ohmail/Quarantine` hold mail
   * somebody explicitly placed there, and that segment is the message's only surface — so an own
   * row keeps it. Holding it out here would hide the user's own mail with nowhere else to read it.
   */
  it("a screened-out or quarantined own row KEEPS its row — an explicit placement is an answer", async () => {
    const store = await mirrorOf([
      msg({ id: "s1", from: OWN, folder: "ohmail/Screened" }),
      msg({ id: "q1", from: OWN, folder: "ohmail/Quarantine" }),
    ]);
    const { part, segments } = queue(store, opts);

    expect(segments.waiting).toEqual([]);
    expect(segments.screenedOut.map((r) => senderKey(r.from.address))).toEqual([OWN]);
    expect(segments.spam.map((r) => senderKey(r.from.address))).toEqual([OWN]);
    expect(part.placeOf.get("s1")).toBe("ohmail/Screened");
    expect(part.placeOf.get("q1")).toBe("ohmail/Quarantine");
  });
});

describe("one predicate — the queue reads the partition's own answer", () => {
  /**
   * A case-and-whitespace variant of the own address is STILL excluded, which is a behavioural
   * proof that the queue went through `ownAddressKeys` (which folds through `senderKey`) rather
   * than through a second list comparing raw strings. A naive `new Set(addresses)` keeps the row.
   */
  it("folds the address the way the predicate does, not the way a raw list would", async () => {
    const store = await mirrorOf([msg({ id: "m1", from: OWN, folder: GATE })]);
    const messy: ConsentOptions = { now: NOW, ownAddresses: ["  Me@Example.COM  "] };

    expect(waitingSenders(store, messy)).toEqual([]);
    expect(queue(store, messy).part.counts.activeUndecidedSenders).toBe(0);
    // And the fold is not a blanket: a different mailbox on the same domain is still a stranger.
    expect(waitingSenders(store, { now: NOW, ownAddresses: ["someone@example.com"] })).toEqual([OWN]);
  });

  /**
   * THE PREDICATE'S FALLBACK IS SHARED TOO. With no explicit addresses both halves read the
   * mirror's `mailbox` rows, so a caller that passes nothing still gets one answer rather than
   * two — the queue does not degrade to "everybody is a stranger" while the partition knows.
   */
  it("with no explicit addresses, both halves fall back to the mirror's mailbox rows", async () => {
    const messages = [msg({ id: "m1", from: OWN, folder: GATE })];
    const seeded = await mirrorOf(messages, [{ id: "mb", address: "Me@Example.com" }]);
    const bare: ConsentOptions = { now: NOW };

    expect(waitingSenders(seeded, bare)).toEqual([]);
    expect(queue(seeded, bare).part.counts.activeUndecidedSenders).toBe(0);

    // THE FLIP: no rows to read, nobody is known, and the row is minted — which is the demo and
    // the pre-facts render, and the reason a caller that KNOWS should pass the addresses.
    const empty = await mirrorOf(messages);
    expect(waitingSenders(empty, bare)).toEqual([OWN]);
    expect(queue(empty, bare).part.counts.activeUndecidedSenders).toBe(1);
  });

  /**
   * THE CENSUS, BY IMPORT. `own-address.ts` declares the predicate; BOTH consumers take it from
   * there and neither declares one — read from the import declarations, the top-level
   * declarations and the two function slices, never from a search for a behaviour string.
   */
  it("both halves import the predicate from the leaf module, and neither defines one", () => {
    const queueSrc = readFileSync(join(SRC, "selectors.ts"), "utf8");
    const partitionSrc = readFileSync(join(SRC, "consent-cutline.ts"), "utf8");
    const leafSrc = readFileSync(join(SRC, "own-address.ts"), "utf8");
    const PREDICATE = "ownAddressKeys";
    const LEAF = "./own-address.js";

    // The LEAF declares it, exported, exactly once — and the fold it keys on beside it.
    expect(declarationsIn(leafSrc).filter((d) => d === PREDICATE)).toEqual([PREDICATE]);
    expect(leafSrc).toContain(`export function ${PREDICATE}(`);
    expect(declarationsIn(leafSrc).filter((d) => d === "senderKey")).toEqual(["senderKey"]);

    // BOTH consumers import it FROM THERE — one declaration each, naming this specifier.
    for (const [name, src] of [["selectors.ts", queueSrc], ["consent-cutline.ts", partitionSrc]] as const) {
      const decls = importsIn(src).filter((d) => d.from === LEAF);
      expect(decls, `${name} must import from ${LEAF}`).toHaveLength(1);
      expect(decls[0]!.specifiers, name).toContain(PREDICATE);
      // …and DEFINES none, so nothing local can shadow the imported one.
      expect(declarationsIn(src), name).not.toContain(PREDICATE);
    }

    // Both CALL it — a symbol appearing is not a symbol used.
    const grouping = sliceOf(queueSrc, "export function screenerSegments(");
    const partition = sliceOf(partitionSrc, "export function consentPartition(");
    expect(callsIn(grouping, PREDICATE), "screenerSegments must call the predicate").toBe(1);
    expect(callsIn(partition, PREDICATE), "consentPartition must call the predicate").toBe(1);

    // NO SECOND LIST in the grouping: it neither reads the mirror's mailbox rows itself nor
    // builds a set of addresses of its own. Both are how a second predicate would be spelled.
    expect(grouping).not.toContain('"mailbox"');
    expect(grouping).not.toContain("new Set(");
  });

  /**
   * AND THE LEAF STAYS A LEAF — no import cycle anywhere in the package.
   *
   * Evaluation order inside a cycle is a property nobody watches until a bundler changes it, so
   * it is not something to measure once: the predicate lives in a module that imports nothing
   * local precisely so that both consumers can take it without closing one. VALUE imports only —
   * a `import type` edge is erased before anything runs and carries no order (the package holds
   * one such pair, `adapters/adapter.ts` and `engine.ts`, which is not an evaluation cycle).
   *
   * The detector is measured in the same case: given the one edge this lane refused to add, it
   * finds the cycle and names both files.
   */
  it("the package's value imports hold no cycle, and the detector would find one", () => {
    const graph = valueImportGraph(SRC);
    expect(graph.size).toBeGreaterThan(20);
    expect(cyclesIn(graph)).toEqual([]);

    // POSITIVE CONTROL: put `selectors.ts -> consent-cutline.js` back and the detector fires.
    const withEdge = new Map(graph);
    const queue = join(SRC, "selectors.ts");
    withEdge.set(queue, [...(graph.get(queue) ?? []), join(SRC, "consent-cutline.ts")]);
    const found = cyclesIn(withEdge);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("selectors.ts");
    expect(found[0]).toContain("consent-cutline.ts");
  });
});

/**
 * Every top-level import (and re-export) DECLARATION, as its specifier names, its module and
 * whether it is `import type` — which is erased before anything runs and is no evaluation edge.
 * A statement is accumulated until the line that ends it, and abandoned past a length no import
 * reaches, so a multi-line `export interface` can never swallow the file.
 */
function importsIn(src: string): Array<{ specifiers: string[]; from: string; typeOnly: boolean }> {
  const out: Array<{ specifiers: string[]; from: string; typeOnly: boolean }> = [];
  let buf: string | null = null;
  for (const line of src.split("\n")) {
    const opens = line.startsWith("import ")
      || (line.startsWith("export ") && (line.includes(' from "') || line.trimEnd().endsWith("{")));
    if (buf === null && !opens) continue;
    buf = buf === null ? line : `${buf} ${line.trim()}`;
    if (buf.length > 8000) { buf = null; continue; }
    if (!buf.trimEnd().endsWith(";")) continue;
    const at = buf.lastIndexOf(' from "');
    if (at >= 0) {
      const from = buf.slice(at + 7, buf.indexOf('"', at + 7));
      const clause = buf.slice(buf.startsWith("export ") ? 7 : 7, at);
      const typeOnly = /^\s*type\s/.test(clause);
      const open = clause.indexOf("{");
      const specifiers = open < 0
        ? [clause.trim()]
        : clause.slice(open + 1, clause.lastIndexOf("}")).split(",")
          .map((x) => x.replace(/^type /, "").trim()).filter((x) => x.length > 0);
      out.push({ specifiers, from, typeOnly });
    }
    buf = null;
  }
  return out;
}

/** Every name this module declares at the TOP LEVEL (column zero), exported or not. */
function declarationsIn(src: string): string[] {
  const out: string[] = [];
  for (const line of src.split("\n")) {
    if (line.startsWith(" ") || line.startsWith("\t")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length) : line;
    const m = /^(?:async )?(?:function|const|let|var|class|interface|type|enum) ([A-Za-z_$][\w$]*)/
      .exec(body);
    if (m) out.push(m[1]!);
  }
  return out;
}

/**
 * One top-level function's SLICE — from its declaration to its own closing brace, which in this
 * package is the next `}` alone at column zero. Read that way rather than by brace arithmetic:
 * both files carry long comments, and a brace inside one would move the end of the slice.
 */
function sliceOf(src: string, declaration: string): string {
  const at = src.indexOf(declaration);
  if (at < 0) throw new Error(`no declaration ${declaration}`);
  const end = src.indexOf("\n}\n", at);
  if (end < 0) throw new Error(`no closing brace for ${declaration}`);
  return src.slice(at, end + 3);
}

/** How many CALL expressions of `name` a slice holds — `name(`, never the bare identifier. */
function callsIn(slice: string, name: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const at = slice.indexOf(`${name}(`, from);
    if (at < 0) return n;
    n += 1;
    from = at + name.length;
  }
}

/**
 * The package's own import graph, VALUE imports only — `import type X from` edges are erased
 * before anything runs. `export … from` counts: it evaluates the module like an import does.
 */
function valueImportGraph(root: string): Map<string, string[]> {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(root);
  files.sort();
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const out = new Set<string>();
    for (const decl of importsIn(readFileSync(file, "utf8"))) {
      if (!decl.from.startsWith(".") || decl.typeOnly) continue;
      const base = decl.from.replace(/\.js$/, "");
      for (const cand of [join(dirname(file), `${base}.ts`), join(dirname(file), base, "index.ts")]) {
        try {
          if (statSync(cand).isFile()) { out.add(cand); break; }
        } catch { /* not this spelling */ }
      }
    }
    graph.set(file, [...out]);
  }
  return graph;
}

/** Every cycle the graph holds, as `a.ts -> b.ts -> a.ts`. Empty is the verdict this wants. */
function cyclesIn(graph: Map<string, string[]>): string[] {
  const found: string[] = [];
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const dfs = (node: string): void => {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === 1) {
        const loop = [...stack.slice(stack.indexOf(next)), next];
        found.push(loop.map((f) => f.slice(f.lastIndexOf("/src/") + 5)).join(" -> "));
      } else if (!state.has(next)) dfs(next);
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const node of [...graph.keys()].sort()) if (!state.has(node)) dfs(node);
  return found;
}
