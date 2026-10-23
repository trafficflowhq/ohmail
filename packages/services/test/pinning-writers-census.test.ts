import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * ═══ EVERY WRITER THAT CAN PIN A MESSAGE CARRIES THE MESSAGE ═══════════════════════════════
 *
 * A windowed mirror keeps part of the mailbox and pins whatever the product is still using
 * (`OhmailEngine.pinnedMessageIds`). A pin that arrives for a row the client evicted first
 * protects nothing: the surface renders a hole, and the evicted row's own change sits below the
 * cursor, so nothing later re-delivers it. The repair is the writer's — a `/sync` change carries
 * the full DTO, so re-emitting the message beside the pinning row brings it back.
 *
 * This is a census and not a rule that can be proved: it enumerates every place in
 * `packages/services/src` that writes a PINNING entity and requires each to be CLASSIFIED. A new
 * writer, a renamed method or a new clause in the pin set is refused until somebody says which of
 * the three it is. The classifications are checked, not trusted:
 *
 *   · `paired`           — the same method emits a `message` change. Asserted.
 *   · `paired-by-caller` — the method is a helper; every `this.<name>(` call site in its file
 *                          sits in a method that emits `message`. Asserted.
 *   · `no-new-pin`       — the change cannot make a row point at a message it did not point at
 *                          before (a status flip, a delete). A REASON, and the one entry that
 *                          could ever be wrong; it is here because the alternative is a second
 *                          change row on every two-second autosave.
 */

const REPO = resolve(join(import.meta.dirname, "..", "..", ".."));
const SERVICES = join(REPO, "packages/services/src");
const ENGINE = join(REPO, "packages/client-engine/src/engine.ts");

/**
 * THE PIN KINDS, DERIVED FROM THE PIN SET ITSELF rather than restated. `pinnedMessageIds()` reads
 * one mirror collection per clause; a new clause therefore appears here on its own and fails the
 * equality below until its server writers are classified. `message` is excluded — a writer of the
 * message is the thing being asked for, not a writer that needs it.
 */
function pinKindsFromEngine(): string[] {
  const text = readFileSync(ENGINE, "utf8");
  const src = ts.createSourceFile(ENGINE, text, ts.ScriptTarget.ES2022, true);
  let body: ts.Node | null = null;
  const find = (n: ts.Node): void => {
    if (ts.isMethodDeclaration(n) && n.name.getText(src) === "pinnedMessageIds") body = n;
    ts.forEachChild(n, find);
  };
  find(src);
  expect(body, "pinnedMessageIds() must exist — the pin set is what this census is about").toBeTruthy();
  const kinds = new Set<string>();
  const walk = (n: ts.Node): void => {
    // `this.store.list<T>("draft")` / `this.store.entries<T>("message_state")` — the CALL, never
    // a mention: a census satisfied by a symbol appearing passes for a clause that reads nothing.
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(src);
      if (callee.endsWith(".list") || callee.endsWith(".entries")) {
        const arg = n.arguments[0];
        if (arg && ts.isStringLiteral(arg)) kinds.add(arg.text);
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(body!);
  /* THE ONE FOLD THE PIN SET READS THROUGH. `winningStates` is the single carrier for "comes back
     later" — it reads both wire homes and hands back one claim per message — so the park clause
     calls it instead of listing `message_state` itself. A reader that only walks this method would
     therefore report a pin set that had quietly lost a collection, which is the drift this census
     exists to catch; it follows the helper by name, into its own file, and no further. */
  if (text.includes("winningStates(")) {
    const sel = join(REPO, "packages/client-engine/src/selectors.ts");
    const selText = readFileSync(sel, "utf8");
    const selSrc = ts.createSourceFile(sel, selText, ts.ScriptTarget.ES2022, true);
    let fold: ts.Node | null = null;
    const findFold = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name?.getText(selSrc) === "winningStates") fold = n;
      ts.forEachChild(n, findFold);
    };
    findFold(selSrc);
    expect(fold, "winningStates() must exist — the park clause reads the pin set through it").toBeTruthy();
    const walkFold = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(selSrc);
        if (callee.endsWith(".list") || callee.endsWith(".entries")) {
          const arg = n.arguments[0];
          if (arg && ts.isStringLiteral(arg)) kinds.add(arg.text);
        }
      }
      ts.forEachChild(n, walkFold);
    };
    walkFold(fold!);
  }
  kinds.delete("message");
  return [...kinds].sort();
}

interface Site { file: string; method: string; kinds: Set<string> }

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Every method in `packages/services/src` that names an `entityType`, and which ones. */
function emitSites(): Map<string, Site> {
  const sites = new Map<string, Site>();
  for (const f of sourceFiles(SERVICES)) {
    const rel = f.slice(REPO.length + 1);
    const src = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.ES2022, true);
    const owner = (n: ts.Node): string => {
      let p: ts.Node | undefined = n;
      while (p) {
        if (ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p)) {
          let c: ts.Node | undefined = p;
          while (c && !ts.isClassDeclaration(c)) c = c.parent;
          const cls = (c as ts.ClassDeclaration | undefined)?.name?.getText(src) ?? "(module)";
          return `${cls}.${p.name?.getText(src) ?? "(anon)"}`;
        }
        p = p.parent;
      }
      return "(module).(top)";
    };
    const walk = (n: ts.Node): void => {
      // The needle is the `entityType:` PROPERTY, not a call name: `recordChange`,
      // `recordChanges` and a `changes.push({…})` shape all write one, and a census keyed on the
      // function it is handed to would miss whichever spelling is added next.
      if (ts.isPropertyAssignment(n) && n.name.getText(src) === "entityType"
          && ts.isStringLiteral(n.initializer)) {
        const key = `${rel}  ${owner(n)}`;
        if (!sites.has(key)) sites.set(key, { file: rel, method: owner(n), kinds: new Set() });
        sites.get(key)!.kinds.add(n.initializer.text);
      }
      ts.forEachChild(n, walk);
    };
    walk(src);
  }
  return sites;
}

/** Does any method in `file` that calls `this.<name>(` fail to emit a `message` change? */
function callersWithoutMessage(file: string, name: string, sites: Map<string, Site>): string[] {
  const abs = join(REPO, file);
  const src = ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.ES2022, true);
  const bad: string[] = [];
  let found = 0;
  const owner = (n: ts.Node): string => {
    let p: ts.Node | undefined = n;
    while (p) {
      if (ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p)) {
        let c: ts.Node | undefined = p;
        while (c && !ts.isClassDeclaration(c)) c = c.parent;
        const cls = (c as ts.ClassDeclaration | undefined)?.name?.getText(src) ?? "(module)";
        return `${cls}.${p.name?.getText(src) ?? "(anon)"}`;
      }
      p = p.parent;
    }
    return "(module).(top)";
  };
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.expression.getText(src) === `this.${name}`) {
      found += 1;
      const caller = owner(n);
      if (caller.endsWith(`.${name}`)) return; // recursion, not a caller
      const site = sites.get(`${file}  ${caller}`);
      if (!site || !site.kinds.has("message")) bad.push(caller);
    }
    ts.forEachChild(n, walk);
  };
  walk(src);
  if (found === 0) bad.push("(no call site found — the helper is unreachable or was renamed)");
  return [...new Set(bad)];
}

/**
 * THE REGISTRY. Keyed by `<file>  <Class>.<method>`, never by line: a line pin shifts under the
 * next insertion and says nothing about what moved.
 */
const CLASSIFIED: Record<string, { how: "paired" | "paired-by-caller" | "no-new-pin"; why: string }> = {
  "packages/services/src/approval-service.ts  ApprovalService.decide":
    { how: "paired", why: "an approval's decision moves the message it is about" },
  "packages/services/src/drafts-service.ts  DraftsService.recordDraftChange":
    { how: "paired", why: "the reference this change establishes, carried with it" },
  "packages/services/src/thread-service.ts  ThreadService.merge":
    { how: "paired", why: "a merge repoints messages and drafts together" },
  "packages/services/src/triage-service.ts  TriageService.setState":
    { how: "paired", why: "MessageDTO.triage projects the row just written" },
  "packages/services/src/workflows-service.ts  WorkflowsService.applyInverse":
    { how: "paired", why: "an undo restores the message beside the draft it recreates" },

  "packages/services/src/message-service.ts  MessageService.spendResurface":
    {
      how: "paired-by-caller",
      why: "a helper run inside a read, a file or a delete — each emits the message itself, and "
        + "clearing a state to 'none' removes a pin rather than making one",
    },

  "packages/services/src/drafts-service.ts  DraftsService.resolve":
    { how: "no-new-pin", why: "settles a send's outcome; the reply target is not written" },
  "packages/services/src/drafts-service.ts  DraftsService.remove":
    { how: "no-new-pin", why: "a delete takes a pin away" },
  "packages/services/src/schedule-send-pass.ts  (module).closeAppointment":
    { how: "no-new-pin", why: "an appointment's status; the reply target is not written" },
  "packages/services/src/schedule-service.ts  ScheduleService.schedule":
    { how: "no-new-pin", why: "an appointment's status; the reply target is not written" },
  "packages/services/src/schedule-service.ts  ScheduleService.cancel":
    { how: "no-new-pin", why: "an appointment's status; the reply target is not written" },
  "packages/services/src/send-service.ts  SendService.reserve":
    { how: "no-new-pin", why: "the send's own status; the reply target is not written" },
  "packages/services/src/send-service.ts  SendService.finalizeSent":
    { how: "no-new-pin", why: "the send's own status; the reply target is not written" },
  "packages/services/src/send-service.ts  SendService.finalizeFailed":
    { how: "no-new-pin", why: "the send's own status; the reply target is not written" },
  "packages/services/src/send-service.ts  SendService.finalizeUnverified":
    { how: "no-new-pin", why: "the send's own status; the reply target is not written" },
  "packages/services/src/send-service.ts  SendService.finalizeSentFromUnverified":
    { how: "no-new-pin", why: "the send's own status; the reply target is not written" },
  "packages/services/src/send-service.ts  SendService.forgetUnoffered":
    { how: "no-new-pin", why: "the draft's status back to draft; the reply target is not written" },
};

describe("every server writer of a pinning row", () => {
  const sites = emitSites();
  const pinKinds = pinKindsFromEngine();
  const pinning = [...sites.entries()]
    .filter(([, s]) => [...s.kinds].some((k) => pinKinds.includes(k)))
    .map(([k]) => k)
    .sort();

  it("the pin set reads the four collections this census is written against", () => {
    // Derived, so a new clause in `pinnedMessageIds()` lands here rather than nowhere.
    expect(pinKinds).toEqual(["approval", "draft", "message_state", "routing_decision"]);
  });

  it("is classified — no more, no fewer", () => {
    expect(pinning).toEqual(Object.keys(CLASSIFIED).sort());
  });

  it("and the classification is true of the code", () => {
    const wrong: string[] = [];
    for (const key of pinning) {
      const entry = CLASSIFIED[key]!;
      const site = sites.get(key)!;
      if (entry.how === "paired") {
        if (!site.kinds.has("message")) wrong.push(`${key} — classified 'paired' and emits no message`);
        continue;
      }
      if (entry.how === "paired-by-caller") {
        if (site.kinds.has("message")) wrong.push(`${key} — 'paired-by-caller' but pairs itself; say 'paired'`);
        const name = site.method.split(".").pop()!;
        const bad = callersWithoutMessage(site.file, name, sites);
        if (bad.length) wrong.push(`${key} — callers without a message emit: ${bad.join(", ")}`);
        continue;
      }
      // `no-new-pin` is the one a person asserts. What IS checkable is that it does not quietly
      // become a writer of the reference: no `.values({…})` or `.set({…})` in its body carries
      // `inReplyToMessageId`. The enclosing CALL is what makes it a write — the same identifier
      // names a select projection and a content fingerprint elsewhere in these files.
      const abs = join(REPO, site.file);
      const src = ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.ES2022, true);
      let writes = false;
      const owner = (n: ts.Node): string => {
        let p: ts.Node | undefined = n;
        while (p) {
          if (ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p)) {
            let c: ts.Node | undefined = p;
            while (c && !ts.isClassDeclaration(c)) c = c.parent;
            const cls = (c as ts.ClassDeclaration | undefined)?.name?.getText(src) ?? "(module)";
            return `${cls}.${p.name?.getText(src) ?? "(anon)"}`;
          }
          p = p.parent;
        }
        return "(module).(top)";
      };
      const intoAWrite = (n: ts.Node): boolean => {
        let p: ts.Node | undefined = n.parent;
        while (p) {
          if (ts.isCallExpression(p)) {
            const callee = p.expression.getText(src);
            if (callee.endsWith(".values") || callee.endsWith(".set")) return true;
          }
          if (ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p)) return false;
          p = p.parent;
        }
        return false;
      };
      const walk = (n: ts.Node): void => {
        // Either pointer pins: the message a draft answers, and the one it forwards.
        if (ts.isPropertyAssignment(n) && ["inReplyToMessageId", "forwardOfMessageId"].includes(n.name.getText(src))
            && owner(n) === site.method && intoAWrite(n)) writes = true;
        ts.forEachChild(n, walk);
      };
      walk(src);
      if (writes) wrong.push(`${key} — classified 'no-new-pin' and writes a message pointer`);
    }
    expect(wrong, wrong.join("\n")).toEqual([]);
  });
});
