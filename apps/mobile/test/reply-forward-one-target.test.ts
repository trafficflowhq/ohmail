import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { replyMemberId } from "../src/ui/reader-marks";

/**
 * The reader uses one composer. Forward uses the viewed member. Reply and Reply All keep their
 * resolved member from the time the composer opens. Both sends use the handed member.
 */
const SRC = readFileSync(fileURLToPath(new URL("../src/ui/MessageActions.tsx", import.meta.url)), "utf8");

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("MessageActions.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function all(sf: ts.SourceFile, pick: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const walk = (n: ts.Node): void => {
    if (pick(n)) out.push(n);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

/** The first argument of every `w.actions.<verb>(…)` call — the member that send names. */
function targetsOf(source: string, verb: string): string[] {
  const sf = parse(source);
  return all(sf, (n) => ts.isCallExpression(n) && n.expression.getText(sf) === `w.actions.${verb}`)
    .map((n) => (n as ts.CallExpression).arguments[0]!.getText(sf));
}

/** Every reader-side composer mount: its `m` and `mode` attributes. */
function mountsOf(source: string): Array<{ m: string; mode: string }> {
  const sf = parse(source);
  return all(sf, (n) => ts.isJsxSelfClosingElement(n) && n.tagName.getText(sf) === "ComposeSheet").map((n) => {
    const attr = (name: string) => (n as ts.JsxSelfClosingElement).attributes.properties
      .find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === name) as ts.JsxAttribute | undefined;
    const text = (a: ts.JsxAttribute | undefined) => a?.initializer?.getText(sf) ?? "";
    return { m: text(attr("m")), mode: text(attr("mode")) };
  });
}

/** What `openForward` opens the composer for: the member its id is read from. */
function forwardOpensFor(source: string): string | null {
  const at = source.indexOf("const openForward = () => {");
  const body = source.slice(at, source.indexOf("\n  };", at));
  return /const id = ([\w.!]+);/.exec(body)?.[1] ?? null;
}

describe("Reply and Forward keep their composer target", () => {
  it("both sends name the member handed to the composer", () => {
    const reply = targetsOf(SRC, "sendReply");
    const forward = targetsOf(SRC, "sendForward");
    expect(reply.length, "the census found the reply send").toBeGreaterThan(0);
    expect(forward.length, "the census found the forward send").toBeGreaterThan(0);
    expect(new Set([...reply, ...forward])).toEqual(new Set(["m!.id"]));
  });

  it("one composer forwards the viewed member and keeps the reply target when opened", () => {
    const mounts = mountsOf(SRC);
    const reader = mounts.filter((x) => x.mode === "{open.compose}");
    expect(reader, "one mount for reply, reply all and forward").toHaveLength(1);
    expect(reader[0]!.m).toBe('{open.compose === "forward" ? m : replyTarget.current}');
    expect(forwardOpensFor(SRC)).toBe("m.id");
    expect(SRC).toMatch(/const openReply = \(all: boolean\) => \{\s+const replyTo = availableReply\.current;\s+replyTarget\.current = replyTo;\s+setOpen\(replyOpen\(a\.keptReply\(replyTo\.id\), all \? "replyAll" : "reply"\)\);/);
  });

  const incoming = (id: string) => ({ id, subject: "Conversation", time: "09:00", body: "Hello", seen: true });
  const sent = { ...incoming("sent"), mine: true as const, seen: false };
  const opened = {
    id: "opened",
    from: { name: "Lee", address: "" },
    unread: false,
    earlier: [
      incoming("earliest"),
      { ...incoming("latest"), later: true as const },
      { ...sent, later: true as const },
    ],
  };

  it("Reply and Reply All target the explicitly selected member", () => {
    expect(replyMemberId(opened, true)).toBe("opened");
  });

  it("without a selection, the newest incoming member wins even after a sent reply", () => {
    expect(replyMemberId(opened, false)).toBe("latest");
    expect(replyMemberId({ ...opened, earlier: [incoming("earliest"), { ...sent, later: true }] }, false)).toBe("opened");
    expect(replyMemberId({ ...opened, ownMail: true, earlier: [incoming("earliest")] }, false)).toBe("earliest");
  });

  it("without an incoming letter, Reply and Reply All target the open sent letter", () => {
    expect(replyMemberId({ ...opened, ownMail: true, earlier: [sent] }, false)).toBe("opened");
    expect(replyMemberId({ ...opened, ownMail: true, earlier: [] }, false)).toBe("opened");
  });

  it("a forward that resolves a member of its own reads as the refusal it is", () => {
    const own = SRC.replace(
      "await w.actions.sendForward(m!.id,",
      "await w.actions.sendForward(newestInThread(m!).id,",
    );
    expect(own).not.toBe(SRC);
    expect(new Set([...targetsOf(own, "sendReply"), ...targetsOf(own, "sendForward")]).size).toBe(2);
    const second = SRC.replace("const id = m.id;\n    const ask = m.forwardAsk;", "const id = newest.id;\n    const ask = m.forwardAsk;");
    expect(second).not.toBe(SRC);
    expect(forwardOpensFor(second)).not.toBe("m.id");
  });
});
