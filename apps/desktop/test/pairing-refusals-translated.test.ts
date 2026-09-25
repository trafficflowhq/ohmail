import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { DEFAULT_LOCALE, fillFrom, setActiveCatalog } from "../../webapp/app/shell/locale";
import { DOOR_COPY } from "../src/door-copy.js";
import { HOST_REFUSAL_KINDS } from "../src/doors.js";
import { sentenceForKind } from "../src/DoorChooser.js";

/**
 * EVERY REFUSAL THE PAIRING'S REDEEM CAN ANSWER IS A SENTENCE IN BOTH CATALOGUES. The card maps the
 * engine's code through `sentenceForKind` and shows the engine's own English only for a code this
 * build has never heard of. `rate_limited` is a code this build's engine names and the table did
 * not, so a German window read the other computer's 429 in English. The codes are read out of the
 * route and the redeem with the TypeScript parser, never listed by hand.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");
const HOST = "kestrel";

function stringsIn(node: ts.Node): string[] {
  if (ts.isStringLiteral(node)) return [node.text];
  const out: string[] = [];
  ts.forEachChild(node, (c) => { out.push(...stringsIn(c)); });
  return out;
}

/** `code: "<literal>"` inside the route's `if` for the pair-redeem path. */
function routeCodes(source: string): string[] {
  const sf = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const inRoute = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(sf) === "code" && ts.isStringLiteral(node.initializer)) {
      out.push(node.initializer.text);
    }
    ts.forEachChild(node, inRoute);
  };
  const find = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && node.expression.getText(sf).includes('"/cloud/pair-redeem"')) inRoute(node.thenStatement);
    else ts.forEachChild(node, find);
  };
  find(sf);
  return out;
}

/** The first argument of every `new CloudSignInError(…)` in `redeemPairingToken`, literals only. */
function redeemCodes(source: string): string[] {
  const sf = ts.createSourceFile("redeem.ts", source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const inFn = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && node.expression.getText(sf) === "CloudSignInError" && node.arguments?.[0]) {
      out.push(...stringsIn(node.arguments[0]));
    }
    ts.forEachChild(node, inFn);
  };
  const find = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "redeemPairingToken") inFn(node);
    else ts.forEachChild(node, find);
  };
  find(sf);
  return out;
}

const CODES = [...new Set([
  ...routeCodes(read("apps/sidecar/src/cloud-engine.ts")),
  ...redeemCodes(read("apps/sidecar/src/cloud-signin.ts")),
])].sort();

afterEach(() => { setActiveCatalog(DEFAULT_LOCALE, null); });

function german(): void {
  const en = JSON.parse(read("apps/webapp/messages/en.json")) as never;
  setActiveCatalog("de", fillFrom(en, JSON.parse(read("apps/webapp/messages/de.json")) as never) as never);
}

describe("the pairing's refusals are sentences in both catalogues", () => {
  it("the census reads the route and the redeem", () => {
    for (const code of ["invalid_pair_code", "host_refused", "pair_account_mismatch", "restart_required", "rate_limited"]) {
      expect(CODES, code).toContain(code);
    }
    expect(CODES.length).toBeGreaterThanOrEqual(12);
  });

  it("every code the engine can answer is a kind the window knows, with an English sentence", () => {
    expect(CODES.filter((c) => !(HOST_REFUSAL_KINDS as readonly string[]).includes(c))).toEqual([]);
    expect(CODES.filter((c) => sentenceForKind(c, HOST) === null)).toEqual([]);
  });

  it("and every one reads German in a German window", () => {
    const english = new Map(CODES.map((c) => [c, sentenceForKind(c, HOST)]));
    german();
    const untranslated = CODES.filter((c) => {
      const de = sentenceForKind(c, HOST);
      return de === null || de === english.get(c) || de.includes("desktopDoor.");
    });
    expect(untranslated).toEqual([]);
  });

  it("the rate-limit sentence, as written and as rendered", () => {
    expect(read("apps/webapp/messages/en.json")).toContain(
      '"hostRefuseRateLimited": "Too many pairing attempts reached {host} from here. Wait a few minutes, then try again."');
    expect(read("apps/webapp/messages/de.json")).toContain(
      '"hostRefuseRateLimited": "Von hier kamen zu viele Kopplungsversuche bei {host} an. Warte ein paar Minuten und versuche es dann erneut."');
    expect(sentenceForKind("rate_limited", HOST)).toBe(DOOR_COPY.hostRefuseRateLimited(HOST));
    german();
    expect(sentenceForKind("rate_limited", HOST))
      .toBe("Von hier kamen zu viele Kopplungsversuche bei kestrel an. Warte ein paar Minuten und versuche es dann erneut.");
  });

  it("the readers take the shapes they exist for, driven", () => {
    expect(routeCodes(`if (path === "/cloud/pair-redeem") { return json({ error: { code: "a_b" } }); }
      if (path === "/other") { return json({ error: { code: "not_here" } }); }`)).toEqual(["a_b"]);
    expect(routeCodes(`if (path === "/cloud/pair-redeem") { return json({ error: { code: err.code } }); }`)).toEqual([]);
    expect(redeemCodes(`export async function redeemPairingToken() {
      throw new CloudSignInError(s === 401 ? "one" : "two", 401, "words");
    }
    function other() { throw new CloudSignInError("elsewhere", 500, "x"); }`)).toEqual(["one", "two"]);
  });
});
