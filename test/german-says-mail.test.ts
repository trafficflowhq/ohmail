import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * GERMAN SAYS MAIL, NOT POST, AND ACCOUNT, NOT KONTO.
 *
 * German-speaking people who use a mail app write "Mail" and "Mails" ("deine Mails", "neue Mail")
 * and call their ohmail sign-in an "Account". "Post" for mail read like a word-for-word rendering of
 * the English and was all over the German catalogues (about 370 web strings and 120 phone strings);
 * "Konto" was in about 150. This census reads every German sentence the apps render and fails on any
 * word containing "post" or "konto"/"konten" unless the list below admits it.
 *
 * What it reads:
 *  - every value of `apps/webapp/messages/de.json` (web, desktop window);
 *  - every string literal and template text in `apps/mobile/src/copy.de.ts` (the phone's deck),
 *    found through the TypeScript parser so comments are not read as copy;
 *  - the German side of the lifecycle mails in `packages/services/src/mail/templates.ts`
 *    (literals under a `de:` property);
 *  - the German paragraph of the last-resort error page (`lang="de"`).
 *
 * Admitted, each with its reason:
 *  - anything built on "Postfach" (Postfach, Postfächer, Postfach-Passwort, IMAP-Postfach, …): it
 *    names the mailbox itself, which is the ordinary German word for it;
 *  - "Postgres": the database's name;
 *  - "Konto" where it means an account somewhere else, never the ohmail one: the AI provider's
 *    billing account (Anthropic, OpenAI, OpenCode), the mail provider's account password, and the
 *    account a forwarded verification or security mail is about (THIRD_PARTY_KONTO).
 *
 * PENDING lists keys another open change rewrites, so this one leaves them alone. Delete an entry
 * when that change lands and this sweep reaches the key.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWED: Array<{ word: RegExp; why: string }> = [
  { word: /postf(a|ä)ch/i, why: "Postfach is the mailbox itself" },
  { word: /^Postgres$/, why: "the database's name" },
];

/** Web keys whose Konto is somebody else's account, not the ohmail one. */
const THIRD_PARTY_KONTO: Record<string, string> = {
  "aiProvider.choiceAnthropicWhy": "billed to the person's Anthropic account",
  "aiProvider.choiceOpenaiWhy": "billed to the person's OpenAI account",
  "aiProvider.choiceOpenCodeGoWhy": "billed through the person's OpenCode account",
  "aiProvider.goPrivacyBilling": "settings in the person's OpenCode account",
  "aiProvider.verdictRequestRejected": "the person's OpenCode account",
  "desktopScreener.autoSuggestGoAllowance": "usage in the person's OpenCode account",
  "mailboxes.probe_auth": "the mail provider's account password",
  "onboarding.passwordHint": "the mail provider's account password",
  "reply.forwardAsk.verification": "a mail verifying an account at some other service",
  "reply.forwardAsk.security_alert": "a security alert about an account at some other service",
};

/** The phone's twins of the two forwarded-mail sentences above. */
const THIRD_PARTY_KONTO_PHONE = [
  "ohmail hat diese Nachricht als Kontobestätigung erkannt.",
  "ohmail hat diese Nachricht als Sicherheitswarnung zu einem Konto erkannt.",
];

const SIGNUP_PENDING = "the signup screens' German is rewritten by the signup copy change";
const PENDING: Record<string, string> = {
  "join.step_account_lead": SIGNUP_PENDING,
  "join.footer": SIGNUP_PENDING,
  "join.step_done_lead": SIGNUP_PENDING,
};
/** The signup screens still say Konto; the same change owns them. */
const pendingKonto = (key: string): boolean => key.startsWith("join.") || key.startsWith("verify.");

const POST_WORD = /[\p{L}\p{N}-]*post[\p{L}\p{N}-]*/giu;
/** Konto, Kontos, Konten and every compound of them; "Kontakt" is not one. */
const KONTO_WORD = /[\p{L}\p{N}-]*kont(?:o|en)[\p{L}\p{N}-]*/giu;

function offending(text: string): string[] {
  return (text.match(POST_WORD) ?? []).filter((w) => !ALLOWED.some((a) => a.word.test(w)));
}

function kontoWords(text: string): string[] {
  return [...new Set(text.match(KONTO_WORD) ?? [])];
}

function leaves(tree: Record<string, unknown>, prefix = ""): Array<[string, string]> {
  return Object.entries(tree).flatMap(([k, v]) =>
    v !== null && typeof v === "object"
      ? leaves(v as Record<string, unknown>, `${prefix}${k}.`)
      : [[`${prefix}${k}`, String(v)] as [string, string]]);
}

/** Every piece of text a string literal, template or JSX text node carries, with its line. */
function literals(file: string, keep: (node: ts.Node) => boolean = () => true): Array<[string, string]> {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Array<[string, string]> = [];
  const visit = (node: ts.Node): void => {
    let text: string | undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) text = node.text;
    else if (ts.isJsxText(node)) text = node.text;
    if (text !== undefined && keep(node)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      out.push([`${file}:${line}`, text]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function under(node: ts.Node, test: (n: ts.Node) => boolean): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) if (test(n)) return true;
  return false;
}

const isDeProperty = (n: ts.Node): boolean =>
  ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "de";

const isLangDe = (n: ts.Node): boolean =>
  ts.isJsxElement(n)
  && n.openingElement.attributes.properties.some((p) =>
    ts.isJsxAttribute(p) && p.name.getText() === "lang"
    && p.initializer !== undefined && ts.isStringLiteral(p.initializer) && p.initializer.text === "de");

const readDe = (): Array<[string, string]> =>
  leaves(JSON.parse(fs.readFileSync(path.join(ROOT, "apps/webapp/messages/de.json"), "utf8")));

const phoneDeck = (): Array<[string, string]> => literals("apps/mobile/src/copy.de.ts");

const mailsAndLastResort = (): Array<[string, string]> => [
  ...literals("packages/services/src/mail/templates.ts", (n) => under(n, isDeProperty)),
  ...literals("apps/webapp/app/last-resort.tsx", (n) => under(n, isLangDe)),
];

describe("German says Mail, not Post", () => {
  it("the web catalogue (de.json): no Post for mail outside Postfach", () => {
    const all = readDe();
    expect(all.length).toBeGreaterThan(1400);
    const found = all
      .filter(([key]) => !(key in PENDING))
      .flatMap(([key, value]) => offending(value).map((w) => `${key}: ${w}`));
    expect(found, `German uses Mail/Mails for messages:\n  ${found.join("\n  ")}`).toEqual([]);
  });

  it("the phone's deck (copy.de.ts): no Post for mail outside Postfach", () => {
    const all = phoneDeck();
    expect(all.length).toBeGreaterThan(500);
    const found = all.flatMap(([at, text]) => offending(text).map((w) => `${at}: ${w}`));
    expect(found, `German uses Mail/Mails for messages:\n  ${found.join("\n  ")}`).toEqual([]);
  });

  it("the German lifecycle mails and the last-resort page: no Post for mail", () => {
    const mails = literals("packages/services/src/mail/templates.ts", (n) => under(n, isDeProperty));
    const lastResort = literals("apps/webapp/app/last-resort.tsx", (n) => under(n, isLangDe));
    // Not vacuous: both readers found their German.
    expect(mails.length).toBeGreaterThan(6);
    expect(lastResort.join(" ")).toMatch(/Mails/);
    const found = [...mails, ...lastResort].flatMap(([at, text]) => offending(text).map((w) => `${at}: ${w}`));
    expect(found, `German uses Mail/Mails for messages:\n  ${found.join("\n  ")}`).toEqual([]);
  });

  it("the census catches what it is for, and lets the mailbox through", () => {
    expect(offending("Deine Post bleibt, wo sie ist.")).toEqual(["Post"]);
    expect(offending("Neue Post wartet im Posteingang.")).toEqual(["Post", "Posteingang"]);
    expect(offending("Der Postausgangsserver und die Massenpost")).toEqual(["Postausgangsserver", "Massenpost"]);
    expect(offending("Dein Postfach, deine Postfächer, das IMAP-Postfach und das Postfach-Passwort")).toEqual([]);
    expect(offending("Postgres, Ordner, Mails")).toEqual([]);
    // Every PENDING entry is a real key, so a renamed key cannot hide behind the list.
    const de = new Map(readDe());
    for (const key of Object.keys(PENDING)) expect(de.has(key), key).toBe(true);
  });
});

describe("German says Account for the ohmail account, not Konto", () => {
  it("the web catalogue (de.json): Konto only for somebody else's account", () => {
    const found = readDe()
      .filter(([key]) => !pendingKonto(key) && !(key in THIRD_PARTY_KONTO))
      .flatMap(([key, value]) => kontoWords(value).map((w) => `${key}: ${w}`));
    expect(found, `the ohmail account is an Account in German:\n  ${found.join("\n  ")}`).toEqual([]);
  });

  it("the phone's deck, the lifecycle mails and the last-resort page: Konto only for somebody else's", () => {
    const found = [...phoneDeck(), ...mailsAndLastResort()]
      .filter(([, text]) => !THIRD_PARTY_KONTO_PHONE.includes(text))
      .flatMap(([at, text]) => kontoWords(text).map((w) => `${at}: ${w}`));
    expect(found, `the ohmail account is an Account in German:\n  ${found.join("\n  ")}`).toEqual([]);
  });

  it("the census catches Konto in every shape, and each admitted key still needs its admission", () => {
    expect(kontoWords("Dein Konto, dieses Kontos, alle Konten, die Kontoseite, das ohmail-Konto"))
      .toEqual(["Konto", "Kontos", "Konten", "Kontoseite", "ohmail-Konto"]);
    expect(kontoWords("Kontakt, Account, Account-Seite")).toEqual([]);
    const de = new Map(readDe());
    for (const key of Object.keys(THIRD_PARTY_KONTO)) {
      expect(kontoWords(de.get(key) ?? ""), `${key} no longer says Konto — delete its row`).not.toEqual([]);
    }
    const phone = phoneDeck().map(([, text]) => text);
    for (const sentence of THIRD_PARTY_KONTO_PHONE) expect(phone, sentence).toContain(sentence);
  });
});
