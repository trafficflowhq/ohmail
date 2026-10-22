/* @reads: packages/services/src/dto/types.ts apps/webapp/app/api-client.ts apps/webapp/app/shell/mail-state.ts
   packages/core/src/reader-refusal.ts */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { toMailboxFacts } from "../app/(product)/mailbox/mailbox-facts";
import type { MailboxDTO } from "../app/api-client";

/**
 * THE WEB NARROWING MAY NOT DROP A FIELD THE SERVER SENDS AND THE SHELL READS. The server
 * counted a gap offer, `GET /mailboxes` carried `gapLetters`, and no web surface drew it: the client's
 * `MailboxDTO`, `MailboxFacts` and `toMailboxFacts` all lacked the field, while `gapOffers` read it
 * through the structural `OrganizerRow`, so neither the compiler nor the desktop's facts census could
 * see the hole. Every server field is classified here — forwarded, or named below with its reason —
 * and every field the shell's facts row types name must be one `MailboxFacts` declares.
 */

const read = (rel: string): ts.SourceFile => {
  const file = fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
};
const SERVER_DTO = "packages/services/src/dto/types.ts";
const CLIENT_DTO = "apps/webapp/app/api-client.ts";
const MAIL_STATE = "apps/webapp/app/shell/mail-state.ts";
/** The one module the shell's row types import a function's parameter from. */
const MODULES: Readonly<Record<string, string>> = { "@trafficflow/core/reader-refusal": "packages/core/src/reader-refusal.ts" };

const nameOf = (m: ts.TypeElement, sf: ts.SourceFile): string =>
  m.name && ts.isIdentifier(m.name) ? m.name.text : m.name?.getText(sf) ?? "?";

function interfaceMembers(rel: string, name: string): string[] {
  const sf = read(rel);
  const decl = sf.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === name);
  expect(decl, `${name} must still be declared in ${rel}`).toBeDefined();
  return decl!.members.map((m) => nameOf(m, sf));
}

/**
 * The member names a type node admits, read with the parser alone: literals, intersections, local
 * interfaces and aliases, `Partial`/`Readonly`/`Pick`, and `Parameters<typeof f>[0]` for a local or
 * mapped function. Anything else lands in `unresolved`, and the census refuses rather than guess.
 */
function membersOfType(node: ts.TypeNode, sf: ts.SourceFile, rel: string, unresolved: string[]): string[] {
  if (ts.isTypeLiteralNode(node)) return node.members.map((m) => nameOf(m, sf));
  if (ts.isParenthesizedTypeNode(node)) return membersOfType(node.type, sf, rel, unresolved);
  if (ts.isIntersectionTypeNode(node) || ts.isUnionTypeNode(node)) {
    return node.types.flatMap((t) => membersOfType(t, sf, rel, unresolved));
  }
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const ref = node.typeName.text;
    const args = node.typeArguments ?? [];
    if ((ref === "Partial" || ref === "Readonly" || ref === "Required") && args[0]) return membersOfType(args[0], sf, rel, unresolved);
    if (ref === "Pick" && args[1]) {
      const keys = ts.isUnionTypeNode(args[1]) ? args[1].types : [args[1]];
      return keys.flatMap((k) => (ts.isLiteralTypeNode(k) && ts.isStringLiteral(k.literal) ? [k.literal.text] : (unresolved.push(k.getText(sf)), [])));
    }
    for (const st of sf.statements) {
      if (ts.isInterfaceDeclaration(st) && st.name.text === ref) return st.members.map((m) => nameOf(m, sf));
      if (ts.isTypeAliasDeclaration(st) && st.name.text === ref) return membersOfType(st.type, sf, rel, unresolved);
    }
  }
  if (ts.isIndexedAccessTypeNode(node) && ts.isTypeReferenceNode(node.objectType)
    && ts.isIdentifier(node.objectType.typeName) && node.objectType.typeName.text === "Parameters"
    && node.objectType.typeArguments?.[0] && ts.isTypeQueryNode(node.objectType.typeArguments[0])
    && ts.isIdentifier(node.objectType.typeArguments[0].exprName)) {
    const fn = node.objectType.typeArguments[0].exprName.text;
    const param = (where: ts.SourceFile, at: string): string[] | null => {
      const decl = where.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === fn);
      const type = decl?.parameters[0]?.type;
      return type ? membersOfType(type, where, at, unresolved) : null;
    };
    const local = param(sf, rel);
    if (local !== null) return local;
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const named = st.importClause?.namedBindings;
      if (!named || !ts.isNamedImports(named) || !named.elements.some((e) => e.name.text === fn)) continue;
      const target = MODULES[st.moduleSpecifier.text];
      const found = target ? param(read(target), target) : null;
      if (found !== null) return found;
    }
  }
  unresolved.push(`${rel}: ${node.getText(sf)}`);
  return [];
}

/** Every `…Row` alias in mail-state.ts: the rows the shell's organizer derivations read off the facts. */
function factsRowTypes(): { rows: Map<string, string[]>; unresolved: string[] } {
  const sf = read(MAIL_STATE);
  const unresolved: string[] = [];
  const rows = new Map<string, string[]>();
  for (const st of sf.statements) {
    if (ts.isTypeAliasDeclaration(st) && /Row$/.test(st.name.text)) rows.set(st.name.text, membersOfType(st.type, sf, MAIL_STATE, unresolved));
  }
  return { rows, unresolved };
}

/** Server fields `MailboxFacts` does not declare, each read off the DTO where it is read at all. */
const NOT_FACTS: Readonly<Record<string, string>> = {
  organizedByThisInstall: "the Mailboxes pane reads it off the DTO (`claimLeftBehind`)",
  setAside: "the Mailboxes pane reads it off the DTO",
  provider: "the Mailboxes pane and the rail read it off the DTO",
  failedAt: "the Mailboxes pane's error line reads it off the DTO",
  retryCount: "the Mailboxes pane's error line reads it off the DTO",
  erasure: "the Mailboxes pane's erasure row reads it off the DTO",
  folders: "no web surface reads it; the web client does not declare it",
};
/** Fields `MailboxFacts` declares that the hosted tab drops on purpose. */
const WEB_DROPS: Readonly<Record<string, string>> = {
  messageCount: "on a hosted tab it is the server's count, not this device's (`MailboxFacts.messageCount`)",
};

describe("the web mailbox-facts seam", () => {
  const server = interfaceMembers(SERVER_DTO, "MailboxDTO");
  const client = new Set(interfaceMembers(CLIENT_DTO, "MailboxDTO"));
  const facts = new Set(interfaceMembers(MAIL_STATE, "MailboxFacts"));
  const forwarded = server.filter((k) => facts.has(k) && !(k in WEB_DROPS));

  it("reads the three declarations it compares", () => {
    // ANTI-VACUITY: a parse that found nothing agrees with everything.
    expect(server.length).toBeGreaterThan(30);
    expect(server).toContain("gapLetters");
    expect(server).toContain("gapStrangers");
    expect(server).toContain("organizerRole");
    expect(client.size).toBeGreaterThan(30);
    expect(facts.size).toBeGreaterThan(30);
    expect(forwarded).toContain("gapLetters");
    expect(forwarded).toContain("gapStrangers");
  });

  it("classifies every field the server sends: declared on MailboxFacts, or named with its reason", () => {
    const unclassified = server.filter((k) => !facts.has(k) && !(k in NOT_FACTS));
    expect(unclassified, "a server field the shell can neither read nor is said not to read").toEqual([]);
    const stale = Object.keys(NOT_FACTS).filter((k) => !server.includes(k) || facts.has(k));
    expect(stale, "a NOT_FACTS entry the server no longer sends, or MailboxFacts now declares").toEqual([]);
    expect(Object.keys(WEB_DROPS).filter((k) => !server.includes(k) || !facts.has(k))).toEqual([]);
  });

  it("the shell's facts row types name only fields MailboxFacts declares", () => {
    const { rows, unresolved } = factsRowTypes();
    expect(unresolved, "a row type this census cannot read").toEqual([]);
    expect([...rows.keys()]).toContain("OrganizerRow");
    expect(rows.get("OrganizerRow")).toContain("gapLetters");
    expect(rows.get("OrganizerRow")).toContain("gapStrangers");
    expect(rows.get("NothingOrganizesRow")).toContain("organizerReleasedAt");
    const undeclared = [...rows].flatMap(([row, keys]) => keys.filter((k) => !facts.has(k)).map((k) => `${row}.${k}`));
    expect(undeclared, "a derivation reads a field no narrowing carries").toEqual([]);
    const exempted = [...rows.values()].flat().filter((k) => k in NOT_FACTS || k in WEB_DROPS);
    expect(exempted, "a field a derivation reads cannot be exempted").toEqual([]);
  });

  it("the web client declares every field it forwards", () => {
    expect(forwarded.filter((k) => !client.has(k)), "api-client.ts MailboxDTO lacks a forwarded field").toEqual([]);
  });

  it("toMailboxFacts forwards every one of them untouched, and drops what it drops on purpose", () => {
    const row: Record<string, unknown> = Object.fromEntries(server.map((k) => [k, `v:${k}`]));
    row.organizerRole = "reader";
    const got = toMailboxFacts(row as unknown as MailboxDTO) as unknown as Record<string, unknown>;
    expect(forwarded.filter((k) => !(k in got)), "toMailboxFacts dropped a field the server sends").toEqual([]);
    expect(forwarded.filter((k) => got[k] !== row[k]), "forwarded, but not as the server sent it").toEqual([]);
    for (const k of Object.keys(WEB_DROPS)) expect(k in got, `${k} is dropped on purpose`).toBe(false);
    expect(got.gapLetters).toBe("v:gapLetters");
    expect(got.gapStrangers).toBe("v:gapStrangers");
  });
});
