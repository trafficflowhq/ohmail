import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * EVERY SURFACE THAT SHOWS A MESSAGE'S CONTENT SHOWS ITS FILES (FIX-025). A body mount — the web
 * viewer, its text sink, the stream card, and on the phone the frame or a row's `.body` drawn as
 * a JSX child — must share its NEAREST enclosing function with the one strip (`MessageFiles` on
 * web and desktop, `AttachmentTiles` on the phone), so a member drawn in a `.map` callback needs
 * its own. Anything else is named below with the reason it shows no files. Out of scope: rows and
 * the phone's Trash card, which draw a stored preview and never a body.
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

interface Door {
  roots: string[];
  /** JSX tags that draw a message body. */
  tags: Set<string>;
  /** Whether a `{x.body}` JSX child counts as a body (the phone draws text rows that way). */
  bodyMember: boolean;
  strip: string;
}
const WEB: Door = {
  roots: ["apps/webapp/app", "apps/desktop/src"],
  tags: new Set(["MessageBody", "MessageBodyView", "BodyText", "StreamCard"]),
  bodyMember: false,
  strip: "MessageFiles",
};
const PHONE: Door = {
  roots: ["apps/mobile/src", "apps/mobile/app"],
  /* `BodyPages` is the phone's paged text body (FIX-026), the web's `BodyText` twin. */
  tags: new Set(["MailBodyFrame", "BodyPages"]),
  bodyMember: true,
  strip: "AttachmentTiles",
};

/** `file#Component` → why that mount shows no files. */
const NO_FILES: Record<string, string> = {
  "apps/webapp/app/letter-body/MessageBody.tsx#MessageBody": "the viewer itself; every host that mounts it is held here",
  "apps/webapp/app/views/TrashView.tsx#TrashLiveRead": "the live Trash window: an un-mirrored row read as text, with no list route",
  "apps/mobile/src/ui/MailBodyFrame.tsx#MailBodyFrame": "the reader's frame; its host, MessageReader, draws the tiles",
  "apps/mobile/src/ui/DraftReader.tsx#DraftReader": "the person's own unsent draft; its files are the composer's",
  "apps/mobile/src/ui/AccountWall.tsx#AccountWall": "not a message: `plan.body` is the account wall's own sentence",
};

const isFn = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
const tagOf = (n: ts.Node): string | null =>
  ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n) ? n.tagName.getText() : null;

/** The component a node stands in: the nearest function with a capitalised name. */
function componentOf(n: ts.Node): string {
  for (let p: ts.Node | undefined = n; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name && /^[A-Z]/.test(p.name.text)) return p.name.text;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && /^[A-Z]/.test(p.name.text)) return p.name.text;
  }
  return "(module)";
}
function containsTag(n: ts.Node, tag: string): boolean {
  let found = false;
  const visit = (c: ts.Node): void => {
    if (found) return;
    if (tagOf(c) === tag) found = true;
    else ts.forEachChild(c, visit);
  };
  visit(n);
  return found;
}

interface Mount { at: string; key: string; what: string; withStrip: boolean }

/** Every body mount in one source, with whether its nearest function also draws the strip. */
function bodyMounts(src: string, rel: string, door: Door): Mount[] {
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Mount[] = [];
  const record = (n: ts.Node, what: string): void => {
    let fn: ts.Node = sf;
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (isFn(p)) { fn = p; break; }
    const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    out.push({ at: `${rel}:${line}`, key: `${rel}#${componentOf(n)}`, what, withStrip: containsTag(fn, door.strip) });
  };
  const visit = (n: ts.Node): void => {
    const tag = tagOf(n);
    if (tag !== null && door.tags.has(tag)) record(n, `<${tag}>`);
    if (door.bodyMember && ts.isJsxExpression(n) && n.expression && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      const scan = (e: ts.Node): void => {
        if (ts.isPropertyAccessExpression(e) && e.name.text === "body" && ts.isIdentifier(e.expression)) {
          record(n, `{${e.getText(sf)}}`);
          return;
        }
        if (!isFn(e)) ts.forEachChild(e, scan);
      };
      scan(n.expression);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "node_modules" ? [] : walk(p);
    return /\.tsx$/.test(name) ? [p] : [];
  });
}
function census(door: Door): { files: number; mounts: Mount[] } {
  const files = door.roots.flatMap((r) => walk(join(ROOT, r)));
  const mounts = files.flatMap((f) => bodyMounts(readFileSync(f, "utf8"), relative(ROOT, f), door));
  return { files: files.length, mounts };
}
const refused = (mounts: Mount[]) =>
  mounts.filter((m) => !m.withStrip && NO_FILES[m.key] === undefined).map((m) => `${m.at} ${m.what}`);
const hosts = (mounts: Mount[]) => [...new Set(mounts.map((m) => m.key))].sort();

describe("web and desktop: every body mount draws MessageFiles, or is named", () => {
  const { files, mounts } = census(WEB);

  it("the walk read both roots and found the known hosts (the positive control)", () => {
    expect(files, "the walk read nothing").toBeGreaterThan(100);
    expect(hosts(mounts)).toEqual([
      "apps/webapp/app/letter-body/MessageBody.tsx#MessageBody",
      "apps/webapp/app/shell/MessageCard.tsx#MessageCard",
      "apps/webapp/app/shell/MessagePane.tsx#MessagePane",
      "apps/webapp/app/shell/StreamCardMemo.tsx#StreamCardMemoInner",
      "apps/webapp/app/views/ScreenerView.tsx#HeldMail",
      "apps/webapp/app/views/TrashView.tsx#TrashLiveRead",
    ]);
  });

  it("no body mount stands without the strip", () => {
    expect(refused(mounts), "a surface shows a message's content and not its files").toEqual([]);
  });

  it("every named exception is still a real mount", () => {
    const named = Object.keys(NO_FILES).filter((k) => k.startsWith("apps/webapp/") || k.startsWith("apps/desktop/"));
    expect(named.filter((k) => !hosts(mounts).includes(k)), "an exception names a mount that is gone").toEqual([]);
  });
});

describe("the phone: every body mount draws AttachmentTiles, or is named", () => {
  const { files, mounts } = census(PHONE);

  it("the walk read both roots and found the known hosts (the positive control)", () => {
    expect(files, "the walk read nothing").toBeGreaterThan(30);
    expect(hosts(mounts)).toEqual([
      "apps/mobile/app/(tabs)/reads.tsx#StreamCard",
      "apps/mobile/src/ui/AccountWall.tsx#AccountWall",
      "apps/mobile/src/ui/DraftReader.tsx#DraftReader",
      "apps/mobile/src/ui/MailBodyFrame.tsx#MailBodyFrame",
      "apps/mobile/src/ui/MessageReader.tsx#MessageReader",
      "apps/mobile/src/ui/SenderDetail.tsx#SenderDetail",
    ]);
  });

  it("no body mount stands without the strip", () => {
    expect(refused(mounts), "a surface shows a message's content and not its files").toEqual([]);
  });

  it("every named exception is still a real mount", () => {
    const named = Object.keys(NO_FILES).filter((k) => k.startsWith("apps/mobile/"));
    expect(named.filter((k) => !hosts(mounts).includes(k)), "an exception names a mount that is gone").toEqual([]);
  });
});

describe("the census refuses a planted renderer and admits the ordinary host (driven)", () => {
  const planted = (src: string, door: Door) => refused(bodyMounts(src, "apps/x/Planted.tsx", door));

  it("web: a body without the strip is refused; with it, admitted", () => {
    expect(planted("export function Planted() { return <MessageBody text='x' />; }", WEB)).toEqual(["apps/x/Planted.tsx:1 <MessageBody>"]);
    expect(planted("export function Planted() { return <><MessageBody text='x' /><MessageFiles messageId='m' /></>; }", WEB)).toEqual([]);
  });

  it("web: a strip OUTSIDE the callback that draws the body does not cover it", () => {
    const src = "export function Planted({ ms }) { return <div>{ms.map((m) => <BodyText text={m.t} />)}<MessageFiles messageId='a' /></div>; }";
    expect(planted(src, WEB)).toEqual(["apps/x/Planted.tsx:1 <BodyText>"]);
  });

  it("phone: a row's body drawn as a child is refused without the tiles, admitted with them", () => {
    expect(planted("export function Planted({ h }) { return <Txt>{h.body}</Txt>; }", PHONE)).toEqual(["apps/x/Planted.tsx:1 {h.body}"]);
    expect(planted("export function Planted({ h }) { return <View><Txt>{h.body}</Txt><AttachmentTiles m={h} /></View>; }", PHONE)).toEqual([]);
    // An attribute is not a drawn body, and neither is a non-JSX read.
    expect(planted("export function Planted({ h }) { const n = h.body.length; return <Txt label={h.body}>{n}</Txt>; }", PHONE)).toEqual([]);
  });
});
