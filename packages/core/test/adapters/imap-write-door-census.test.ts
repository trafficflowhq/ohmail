import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * ═══ EVERY IMAP WRITE IN THE ADAPTER ASKS THE ONE DOOR, IMMEDIATELY BEFORE THE COMMAND ═════════
 *
 * the lease was asked at page boundaries in the worker and the
 * adapter then awaited several preflights before the command, so a write could land after the claim
 * that licensed it had gone. The invariant is at the adapter: each write command is preceded, in its
 * own function, by `this.admitWrite(door, …)` with NO await completing between the ask and the
 * command — nothing that talks to the server may sit in that window.
 *
 * The domain is every call of an imapflow write verb on the adapter's client in the three adapter
 * files. Each site is classified; an unclassified site, or a classified one that is gone, is red.
 */

const ROOT = resolve(__dirname, "../../src/adapters");

const WRITE_VERBS = new Set([
  "messageMove", "messageCopy", "messageDelete", "messageFlagsAdd", "messageFlagsRemove",
  "messageFlagsSet", "mailboxCreate", "mailboxRename", "mailboxDelete", "mailboxSubscribe",
  "mailboxUnsubscribe", "append",
]);

/** The ask. One spelling; a second would let a site satisfy this census by proxy. */
const ASK = "admitWrite";

type Disposition =
  /** An organizer write: the ask must immediately precede it. */
  | "door"
  /** The sender's own Sent copy: any install that may send may file its own copy, reader included. */
  | "sender_by_design"
  /** The lease's own records in `ohmail/_meta` — the medium the door answers from. */
  | "lease_medium";

const CENSUS: Readonly<Record<string, Disposition>> = {
  "imap.ts:ensureFolders:mailboxRename#1": "door",
  /* #1 is the parent `ohmail`, created first where the LIST names it nowhere; #2 the child. */
  "imap.ts:createOwnFolder:mailboxCreate#1": "door",
  "imap.ts:createOwnFolder:mailboxCreate#2": "door",
  "imap.ts:createFolder:mailboxCreate#1": "door",
  "imap.ts:renameFolder:mailboxRename#1": "door",
  "imap.ts:deleteFolderByPath:mailboxDelete#1": "door",
  "imap.ts:moveAllByPath:messageMove#1": "door",
  /* No MOVE: a UID COPY proved in the destination, then the same UIDs expunged, each asked. */
  "imap.ts:moveAllByPath:messageCopy#1": "door",
  "imap.ts:moveAllByPath:messageDelete#1": "door",
  "imap.ts:move:messageMove#1": "door",
  "imap.ts:move:messageCopy#1": "door",
  "imap.ts:move:messageDelete#1": "door",
  "imap.ts:moveMany:messageMove#1": "door",
  "imap.ts:setFlags:messageFlagsAdd#1": "door",
  "imap.ts:setFlags:messageFlagsRemove#1": "door",
  "imap.ts:resolveSentFolder:mailboxCreate#1": "sender_by_design",
  "imap.ts:send:append#1": "sender_by_design",
};

/** The two `_meta` modules: every write there is the lease medium, counted so none is silent. */
const MEDIUM_FILES = ["organizer-lease.ts", "organizer-profile.ts"] as const;

interface Site { key: string; line: number; verdict: "asked" | "no_ask" | "await_between" }

function enclosingName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name) return n.name.getText();
    if (ts.isPropertyAssignment(n) || ts.isVariableDeclaration(n)) {
      if (ts.isFunctionLike(n.initializer as ts.Node) || n.initializer && ts.isArrowFunction(n.initializer)) {
        return n.name.getText();
      }
    }
  }
  return "<top>";
}

function enclosingBody(node: ts.Node): ts.Node | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isArrowFunction(n)
      || ts.isFunctionExpression(n)) return n;
  }
  return null;
}

/** Classify every write call in `source` — the census and its fixture arm both read this. */
function classifyWrites(file: string, source: string): Site[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const counts = new Map<string, number>();
  const out: Site[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const verb = node.expression.name.text;
      const target = node.expression.expression.getText(sf);
      if (WRITE_VERBS.has(verb) && /(^|\.)client$/.test(target)) {
        const fn = enclosingName(node);
        const base = `${file}:${fn}:${verb}`;
        const k = (counts.get(base) ?? 0) + 1;
        counts.set(base, k);
        const body = enclosingBody(node);
        const asks: ts.CallExpression[] = [];
        const awaits: ts.AwaitExpression[] = [];
        const walk = (n: ts.Node): void => {
          if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
            && n.expression.name.text === ASK && n.end <= node.getStart(sf)) asks.push(n);
          if (ts.isAwaitExpression(n)) awaits.push(n);
          ts.forEachChild(n, walk);
        };
        if (body) walk(body);
        const ask = asks.sort((a, b) => b.end - a.end)[0];
        let verdict: Site["verdict"] = "no_ask";
        if (ask) {
          // An await that STARTS after the ask and ENDS before the write begins is a round trip
          // (or any wait) between the answer and the command — the window this census closes.
          const between = awaits.some((a) => a.getStart(sf) >= ask.end && a.end <= node.getStart(sf));
          verdict = between ? "await_between" : "asked";
        }
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        out.push({ key: `${base}#${k}`, line, verdict });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const read = (f: string): string => readFileSync(resolve(ROOT, f), "utf8");

describe("the write-site census over the IMAP adapter", () => {
  const sites = classifyWrites("imap.ts", read("imap.ts"));

  it("every write call is classified, and every classified site still exists", () => {
    const found = new Set(sites.map((s) => s.key));
    expect(sites.filter((s) => !(s.key in CENSUS)).map((s) => `${s.key} (line ${s.line})`),
      "a write the census has not classified").toEqual([]);
    expect(Object.keys(CENSUS).filter((k) => !found.has(k)), "a classified site that is gone").toEqual([]);
  });

  it("every organizer write asks the door immediately before the command", () => {
    const bad = sites
      .filter((s) => CENSUS[s.key] === "door" && s.verdict !== "asked")
      .map((s) => `${s.key} (line ${s.line}): ${s.verdict}`);
    expect(bad, "an IMAP write reachable without the lease asked at the write").toEqual([]);
    expect(sites.filter((s) => CENSUS[s.key] === "door")).toHaveLength(15);
  });

  it("the `_meta` medium's writes are counted by name, none of them silent", () => {
    // The lease cannot ask the door it is the answer for; these are the claim, profile and request
    // records themselves. A count, so a new write in either module is a decision, not an accident.
    const medium = MEDIUM_FILES.flatMap((f) => classifyWrites(f, read(f)));
    // FIX-026 added one: `markSeen`'s STORE of \Seen on the current settings document; and one
    // more, `probeUndeletable`'s EXPUNGE of the one own claim a blocked gate probes; and
    // `createParentFirst`'s CREATE of `ohmail` before `_meta`, for a server that makes no parent.
    expect(medium.length).toBe(17);
  });

  it("FIXTURE — a write with no ask, and a write with a round trip after its ask, are both red", () => {
    const fixture = [
      "class A {",
      "  async good(door) { await this.client.search(); this.admitWrite(door, 'move'); await this.client.messageMove(1, 'x'); }",
      "  async late(door) { this.admitWrite(door, 'move'); await this.client.search(); await this.client.messageMove(1, 'x'); }",
      "  async none() { await this.client.messageCopy(1, 'y'); }",
      "  async pair(door) { this.admitWrite(door, 'seen'); const ok = await (x ? this.client.messageFlagsAdd(1) : this.client.messageFlagsRemove(1)); }",
      "}",
    ].join("\n");
    const v = Object.fromEntries(classifyWrites("fx.ts", fixture).map((s) => [s.key, s.verdict]));
    expect(v).toEqual({
      "fx.ts:good:messageMove#1": "asked",
      "fx.ts:late:messageMove#1": "await_between",
      "fx.ts:none:messageCopy#1": "no_ask",
      "fx.ts:pair:messageFlagsAdd#1": "asked",
      "fx.ts:pair:messageFlagsRemove#1": "asked",
    });
  });
});
