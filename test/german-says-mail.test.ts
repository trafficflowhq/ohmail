import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import desktopDe from "../packages/app/messages/desktop.de.json";

/**
 * GERMAN MAIL AND ACCOUNT WORDING.
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
 *  - the German side of the mails in `packages/services/src/mail/templates.ts` (literals under a
 *    `de:` property), for Post only: the mails say Konto, as the brand's voice has it. Most German mail
 *    words sit in `de ? … : …` branches this reader does not see; the mails' own gate
 *    (`mail-templates.test.ts`, "German says Mail and Konto") holds the mails' Post rule over every
 *    German render (every word holding "post" is a Postfach word), and that they never say Account,
 *    E-Mail or Nachricht;
 *  - the German paragraph of the last-resort error page (`lang="de"`).
 *
 * Admitted, each with its reason:
 *  - anything built on "Postfach" (Postfach, Postfächer, Postfach-Passwort, IMAP-Postfach, …): it
 *    names the mailbox itself, which is the ordinary German word for it;
 *  - "Postgres": the database's name;
 *  - "Konto" on the desktop installation account label and the sign-in link to create an account;
 *  - "Konto" where it means an account somewhere else: the AI provider's
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
  "write.reply.ask.verification": "a mail verifying an account at some other service",
  "write.reply.ask.security_alert": "a security alert about an account at some other service",
  "providerPicker.note_microsoft": "the Microsoft account's security defaults, and work accounts at Microsoft",
  "join.mailboxMicrosoftAfterSetup": "the Microsoft account an app password is allowed on",
  "providerPicker.note_yahoo": "the Yahoo account's security page and its password",
  "providerPicker.note_infomaniak": "the Infomaniak account's two-factor setting",
  "providerPicker.help_yahoo": "the name of Yahoo's own account security page",
  "providerPicker.note_gmail": "Google accounts that cannot create App Passwords",
  "mailboxes.probe_auth_gmail_app_password_required": "Google accounts that cannot create App Passwords",
  "mailboxes.probe_auth_gmail_imap_disabled": "the Google account IMAP is turned off for",
  "phoneDoor.form.appOnlyNote": "Google accounts that cannot create App Passwords",
  "phoneRefusal.standaloneAuthImapDisabled": "the provider's account IMAP is turned off for",
  "mailboxes.probe_auth_microsoft": "work accounts at Microsoft",
  "mailboxes.probe_auth_yahoo": "the name of Yahoo's own account security page",
};

/** The phone's twins of the two forwarded-mail sentences above. */
const THIRD_PARTY_KONTO_PHONE = [
  "ohmail hat diese Nachricht als Kontobestätigung erkannt.",
  "ohmail hat diese Nachricht als Sicherheitswarnung zu einem Konto erkannt.",
  /* The provider's accounts (the web's `note_gmail`, `probe_auth_gmail_*`), pieces of their templates. */
  " meldet, dass IMAP für dieses Konto ausgeschaltet ist. Eine Administratorin oder ein Administrator ",
  "Manche Arbeits-, Schul- und Advanced-Protection-Konten sowie Konten, die sich nur mit ",
];

/* Empty since the signup copy change landed: it rewrote the three join lines and the signup screens' Konto. */
const PENDING: Record<string, string> = {};

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

const lastResortDe = (): Array<[string, string]> => literals("apps/webapp/app/last-resort.tsx", (n) => under(n, isLangDe));

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

describe("German account wording", () => {
  it("the web catalogue uses Konto on the two approved ohmail account labels", () => {
    const catalogue = new Map(readDe());
    const installAccountKey = "desktopDoor.installAccount";
    const createAccountKey = "login.createAccount";
    const desktopLabel = desktopDe.desktopDoor.installAccount;
    expect(desktopLabel).toBe("Konto");
    expect(catalogue.get(installAccountKey)).toBe(desktopLabel);
    expect(catalogue.get(createAccountKey)).toBe("Konto erstellen");
    const found = [...catalogue]
      .filter(([key]) => !(key in THIRD_PARTY_KONTO))
      .flatMap(([key, value]) => kontoWords(value).map((w) => `${key}: ${w}`))
      .sort();
    expect(found).toEqual([`${installAccountKey}: Konto`, `${createAccountKey}: Konto`]);
  });

  it("the phone's deck and the last-resort page: Konto only for somebody else's", () => {
    const found = [...phoneDeck(), ...lastResortDe()]
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
