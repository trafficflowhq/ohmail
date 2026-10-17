/**
 * THE ANSWER STANDS UNDER THE OPTION THAT WAS PRESSED. Pressing ohmail Cloud put its
 * answer under Your own computer, in a card headed "Add a server" over four answers two of which
 * are not servers. There is no React Native renderer in this workspace (`fourth-door.test.ts`
 * says why), so the tree is read from `Doors.tsx` with the TypeScript parser: every `<Result>`
 * must sit inside the `<Door>` it answers for. The decisions are driven through `doors-answer.ts`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { DECKS } from "../src/copy";

const FILE = fileURLToPath(new URL("../src/ui/Doors.tsx", import.meta.url));
const SRC = readFileSync(FILE, "utf8");
const SF = ts.createSourceFile(FILE, SRC, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

const tagOf = (n: ts.Node): string | null =>
  ts.isJsxElement(n) ? n.openingElement.tagName.getText(SF)
    : ts.isJsxSelfClosingElement(n) ? n.tagName.getText(SF) : null;

const attrsOf = (n: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxAttributes =>
  ts.isJsxElement(n) ? n.openingElement.attributes : n.attributes;

const attr = (n: ts.JsxElement | ts.JsxSelfClosingElement, name: string): string | null => {
  for (const p of attrsOf(n).properties) {
    if (ts.isJsxAttribute(p) && p.name.getText(SF) === name) {
      const init = p.initializer;
      return init && ts.isJsxExpression(init) && init.expression ? init.expression.getText(SF) : null;
    }
  }
  return null;
};

/** The `Doors` component's own body — the list a person sees. */
function doorsBody(): ts.Node {
  let found: ts.Node | null = null;
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === "Doors") found = n;
    ts.forEachChild(n, visit);
  };
  visit(SF);
  if (found === null) throw new Error("no Doors component in Doors.tsx");
  return found;
}

function elementsIn(root: ts.Node, tag: string): (ts.JsxElement | ts.JsxSelfClosingElement)[] {
  const out: (ts.JsxElement | ts.JsxSelfClosingElement)[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && tagOf(n) === tag) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

/** The `<Door>` element a node renders inside, by its `name` — `null` when it stands outside every door. */
function owningDoor(n: ts.Node, stop: ts.Node): string | null {
  for (let p = n.parent; p !== undefined && p !== stop; p = p.parent) {
    if (ts.isJsxElement(p) && tagOf(p) === "Door") return attr(p, "name");
  }
  return null;
}

const DOOR_OF_NAME: Record<string, string> = {
  "Copy.doorCloud": "cloud",
  "Copy.doorOwnServer": "self",
  "Copy.doorDesktop": "desktop",
  "Copy.doorPhone": "phone",
};

describe("each option's answer renders under that option", () => {
  const body = doorsBody();
  const results = elementsIn(body, "Result");

  it("the four options are the four doors, in order", () => {
    const doors = [...elementsIn(body, "Door")]
      .sort((a, b) => a.getStart(SF) - b.getStart(SF))
      .map((d) => DOOR_OF_NAME[attr(d, "name") ?? ""]);
    expect(doors).toEqual(["cloud", "self", "desktop", "phone"]);
  });

  it("no answer stands outside the door it answers for", () => {
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      const line = SF.getLineAndCharacterOfPosition(r.getStart(SF)).line + 1;
      expect(owningDoor(r, body), `Doors.tsx:${line}`).not.toBeNull();
    }
  });

  it("ohmail Cloud and Your own server each own one answer; the computer and the phone own none", () => {
    const owned = results.map((r) => DOOR_OF_NAME[owningDoor(r, body) ?? ""] ?? "outside");
    expect(owned.sort()).toEqual(["cloud", "self"]);
  });

  it("each answer reads the probe of the door it stands under, and no other", () => {
    for (const r of results) {
      const door = DOOR_OF_NAME[owningDoor(r, body) ?? ""];
      expect(attr(r, "probe")).toBe(`probeUnder("${door}", open, probe)`);
    }
  });
});

describe("the heading names what the four choices are", () => {
  it("renders the doors' own heading, never the Servers screen's add label", () => {
    const sections = elementsIn(doorsBody(), "Section");
    expect(sections).toHaveLength(1);
    const text = ts.isJsxElement(sections[0]!)
      ? sections[0]!.children.map((c) => c.getText(SF).trim()).join("")
      : "";
    expect(text).toBe("{Copy.doorsHead}");
  });

  it("says it in both languages", () => {
    expect(DECKS.en.doorsHead).toBe("What organizes your mail");
    expect(DECKS.de.doorsHead).toBe("Was deine Mails organisiert");
  });
});

describe("the press decides where the answer shows", () => {
  const probed = (door: "cloud" | "self") =>
    ({ k: "probed", door, origin: "https://o.test", flavor: "managed", base: "https://o.test", prefixed: false }) as const;

  it("the pressed door shows its answer and the other shows none", async () => {
    const { pressDoor, probeUnder } = await import("../src/ui/doors-answer");
    for (const door of ["cloud", "self"] as const) {
      const other = door === "cloud" ? "self" : "cloud";
      const open = pressDoor(null, door);
      expect(probeUnder(door, open, probed(door)).k, door).toBe("probed");
      expect(probeUnder(other, open, probed(door)).k, door).toBe("idle");
    }
  });

  it("an answer that lands after the person moved on shows under neither door", async () => {
    const { pressDoor, probeUnder } = await import("../src/ui/doors-answer");
    const open = pressDoor(pressDoor(null, "cloud"), "self");
    expect(open).toBe("self");
    expect(probeUnder("self", open, probed("cloud")).k).toBe("idle");
    expect(probeUnder("cloud", open, probed("cloud")).k).toBe("idle");
  });

  it("Your own server toggles; ohmail Cloud stays open and asks again", async () => {
    const { pressDoor } = await import("../src/ui/doors-answer");
    expect(pressDoor(pressDoor(null, "self"), "self")).toBeNull();
    expect(pressDoor("cloud", "cloud")).toBe("cloud");
    expect(pressDoor("self", "cloud")).toBe("cloud");
  });
});
