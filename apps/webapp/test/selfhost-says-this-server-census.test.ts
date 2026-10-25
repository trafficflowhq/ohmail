import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { bracketSpan, lineOf, withoutComments, withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";
import { FILER_HOST_KEYS, FILER_TABLE } from "../app/shell/mail-state";

/**
 * A SELF-HOSTED INSTALL NEVER CALLS ITSELF OHMAIL CLOUD IN SETTINGS → MAILBOXES. The web pane on a
 * self-hosted build said "Cloud is not organizing this mailbox…", "Take over on Cloud…" and six
 * more about the server it is served by; the desktop headed a self-hosted door "Cloud mailboxes".
 * Who files, the takeover and the heading are chosen by the filer table (`mail-state.ts`); this
 * census reads every other catalogue key the two panes can reach, from en.json and de.json as raw
 * text, and refuses one naming Cloud unless the ledger below says why it never renders on a
 * self-hosted build. JSX text is the copy census's (it must be a catalogue read there).
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
type Catalogue = Record<string, Record<string, unknown>>;
const raw = (lang: "en" | "de"): Catalogue =>
  JSON.parse(fs.readFileSync(path.join(REPO, `apps/webapp/messages/${lang}.json`), "utf8")) as Catalogue;
const EN = raw("en");
const DE = raw("de");

/** The managed service's name, in either language — the predicate every arm decides on. */
const namesCloud = (s: unknown): boolean => typeof s === "string" && /\bCloud\b/.test(s);

const PANES = {
  web: "apps/webapp/app/(product)/mailbox/MailboxSection.tsx",
  desktop: "apps/desktop/src/DesktopMailboxes.tsx",
} as const;
type Pane = keyof typeof PANES;

/**
 * READS THE CENSUS CANNOT RESOLVE FROM THE ARGUMENT, with the key prefixes each one can reach —
 * those keys are then checked like any literal. A new dynamic read refuses until it is named here.
 */
const DYNAMIC: Record<string, { reaches: string[]; why: string }> = {
  "web: key": { reaches: ["oauth_", "probe_tls"], why: "the OAuth refusal and the TLS probe tables" },
  "web: statusKey(m)": { reaches: ["status_"], why: "the row's status line" },
  "web: probeCopyKey(reason, false, refusalTransport(err), hint, ownRefusalOf(presetId))": {
    reaches: ["probe_"], why: "a refused probe by reason, Google's by its hint, a named preset's by its id",
  },
  "web: probeCopyKey(\"auth\", false, \"imap\", authHelp)": {
    reaches: ["probe_auth_gmail_"], why: "Google's sentence, matched to place its App Password links",
  },
  "web: probeCopyKey(probeBad.reason, false, probeBad.transport, probeBad.authHint, ownRefusalOf(typed.provider?.id))": {
    reaches: ["probe_"], why: "the Test's refusal by reason, Google's by its hint, a named preset's by its id",
  },
  "web: errSaid.key": {
    reaches: ["err_", "syncError"],
    why: "the failing row's sentence, by code, by the one detail that outranks it, or by a stated storage count",
  },
  "web: standDownKey(standDown, filer)": {
    reaches: ["standDown_organized_elsewhere_local", "standDown_organized_elsewhere_mobile", "standDown_organized_elsewhere_unknown"],
    why: "the stand-down sentences; a server holder's is the filer table's `claimedElsewhere` row",
  },
  "web: said.key": {
    reaches: ["probe_connect_noport", "probe_timeout_noport", "probe_tls_noport"],
    why: "noPortProbeSentence, the connect form's refusal where the form has no port field",
  },
  "web: probeBad.noPort.key": {
    reaches: ["probe_connect_noport", "probe_timeout_noport", "probe_tls_noport"],
    why: "noPortProbeSentence, the probe verdict's refusal where the form has no port field",
  },
  "desktop: said.key": {
    reaches: ["readerSince", "readerStopped", "readerReadsOnly", "readerHolderPhone"],
    why: "holderSentence, the reader row's holder table",
  },
  "desktop: refusedKey": {
    reaches: ["desktopStateSignInRefused"], why: "the refused sign-in: a local server's, a Google mailbox's, or the plain one",
  },
  "desktop: holderSentence({ who: whoOf(m)!, verb: \"reclaim\", managed }).key": {
    reaches: ["readerSince", "readerStopped", "readerReadsOnly", "readerHolderPhone"],
    why: "holderSentence, the reader row's holder table",
  },
  "desktop: reached.settingsLeft === \"kept_other\" ? \"stateReleasedSettingsOther\" : \"stateReleasedSettingsUnsaved\"": {
    reaches: ["stateReleasedSettingsOther", "stateReleasedSettingsUnsaved"],
    why: "the released row's line on where a stop left this computer's settings",
  },
};

/** Keys that name Cloud and are read by a pane, each with why no self-hosted build renders it. */
const READER_ROWS_ONLY =
  "a reader row's sentence, and the hosted door renders none: `claimable` is false on every hosted row, "
  + "so each one is an organizer row there";
const OFF_SELF_HOST: Record<string, string> = {
  "web:sync.blocked_organized_elsewhere_cloud":
    "the pane reads `blocked_` only for a SYNC_BLOCK_REASONS member (`isSyncBlockReason`), a set with no "
    + "organized_elsewhere token — asserted below",
  "desktop:mailboxes.stopOrganizingHandBackWhat":
    "the stop verb's gloss, offered on the desktop's own door only (`offerRelease` needs `!cloud`)",
  "desktop:mailboxes.readerSinceCloud": READER_ROWS_ONLY,
  "desktop:mailboxes.readerSinceCloudHow": READER_ROWS_ONLY,
};

/** String literals in a pane's code that name Cloud, with the same reason. */
const LITERALS_OFF_SELF_HOST: Record<string, string> = {
  "desktop:ohmail Cloud": `holderOf, the name of an unnamed server holder — ${READER_ROWS_ONLY}`,
};

interface Read { pane: Pane; line: number; arg: string; keys: string[] }

/** Index of the first comma at depth 0 in `bare[start, end)`, or `end`. */
function firstArgEnd(bare: string, start: number, end: number): number {
  let depth = 0;
  for (let i = start; i < end; i++) {
    const c = bare[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) return i;
  }
  return end;
}

function scan(pane: Pane): { reads: Read[]; dynamic: Read[]; table: number; literals: { line: number; text: string }[] } {
  const src = fs.readFileSync(path.join(REPO, PANES[pane]), "utf8");
  const code = withoutComments(src);
  const bare = withoutCommentsAndLiterals(src);
  const spaces = new Map<string, string>();
  for (const m of code.matchAll(/const (\w+) = useTranslations\("(\w+)"\)/g)) spaces.set(m[1]!, m[2]!);
  const reads: Read[] = [];
  const dynamic: Read[] = [];
  let table = 0;
  for (const [id, space] of spaces) {
    const keysOf = (prefixes: string[]): string[] => Object.keys(EN[space] ?? {})
      .filter((k) => prefixes.some((p) => k.startsWith(p))).map((k) => `${space}.${k}`);
    for (const m of bare.matchAll(new RegExp(`(?<![\\w.$])${id}(?:\\.(?:rich|markup|raw))?\\(`, "g"))) {
      const open = m.index! + m[0].length - 1;
      const s = bracketSpan(bare, open);
      expect(s.closed, `${PANES[pane]}:${lineOf(src, open)} a call that never closes`).toBe(true);
      const arg = code.slice(s.start, firstArgEnd(bare, s.start, s.end)).trim().replace(/\s+as\s+"[\w.]+"$/, "");
      const line = lineOf(src, open);
      const viaTable = /^filerKey\(/.test(arg)
        || (/^(\w+)\.key$/.test(arg) && new RegExp(`const ${arg.split(".")[0]} = filerSentence\\(`).test(code));
      /* A literal, a `prefix_${…}` family, or a condition choosing between those: every key named
         after the first `?`, and nothing else there. */
      const branches = /^[^"'`?]*\?/.test(arg) ? arg.slice(arg.indexOf("?") + 1) : arg;
      const plain = branches.replace(/"[\w.]+"|'[\w.]+'|`\w+\$\{[^`]*\}`/g, "").replace(/:/g, "").trim() === "";
      if (viaTable) table++;
      else if (plain) {
        const named = [...branches.matchAll(/"([\w.]+)"|'([\w.]+)'/g)].map((l) => `${space}.${l[1] ?? l[2]}`);
        const families = keysOf([...branches.matchAll(/`(\w+)\$\{/g)].map((f) => f[1]!));
        reads.push({ pane, line, arg, keys: [...named, ...families] });
      } else {
        const known = DYNAMIC[`${pane}: ${arg}`];
        const read = { pane, line, arg, keys: known ? keysOf(known.reaches) : [] };
        dynamic.push(read);
        if (known) reads.push(read);
      }
    }
  }
  const literals: { line: number; text: string }[] = [];
  for (let i = 0; i < bare.length; i++) {
    const q = bare[i];
    if (q !== '"' && q !== "'" && q !== "`") continue;
    const j = bare.indexOf(q, i + 1);
    if (j === -1) break;
    const text = code.slice(i + 1, j);
    if (namesCloud(text)) literals.push({ line: lineOf(src, i), text });
    i = j;
  }
  return { reads, dynamic, table, literals };
}

const SCANS = { web: scan("web"), desktop: scan("desktop") } as const;
const value = (cat: Catalogue, nsKey: string): unknown => {
  const dot = nsKey.indexOf(".");
  return cat[nsKey.slice(0, dot)]?.[nsKey.slice(dot + 1)];
};

describe("the filer table: a self-hosted server is never named ohmail Cloud", () => {
  const rows = Object.entries(FILER_TABLE ?? {});

  it("CONTROL — the predicate reads Cloud in every managed-service sentence, in both languages", () => {
    expect(rows.length, "the table is empty").toBeGreaterThanOrEqual(14);
    for (const [sentence, row] of rows) {
      const key = (row as Record<string, string>).cloud;
      expect(key, `${sentence} has no managed column`).toBeTypeOf("string");
      expect(namesCloud(EN.mailboxes?.[key!]), `en ${sentence} → ${key}`).toBe(true);
      expect(namesCloud(DE.mailboxes?.[key!]), `de ${sentence} → ${key}`).toBe(true);
    }
  });

  it("every self-hosted sentence and every paired one names no Cloud, in both languages", () => {
    const keys = [
      ...rows.map(([sentence, row]) => [sentence, (row as Record<string, string>).server] as const),
      ...Object.entries(FILER_HOST_KEYS ?? {}),
    ];
    for (const [sentence, key] of keys) {
      for (const [lang, cat] of [["en", EN], ["de", DE]] as const) {
        const said = cat.mailboxes?.[key!];
        expect(said, `${lang} ${sentence} → ${key} is missing`).toBeTypeOf("string");
        expect(namesCloud(said), `${lang} ${sentence} → ${key} names Cloud: ${String(said)}`).toBe(false);
      }
    }
  });
});

describe.each(["web", "desktop"] as const)("the %s Mailboxes pane reads no Cloud sentence off the table", (pane) => {
  const { reads, dynamic, table, literals } = SCANS[pane];

  it("reads the pane, and says so with a number", () => {
    expect(reads.length, "the walk found almost nothing").toBeGreaterThan(pane === "web" ? 100 : 60);
    expect(table, "no read goes through the filer table").toBeGreaterThanOrEqual(pane === "web" ? 8 : 2);
  });

  it("every dynamic read is named, with what it can reach", () => {
    const unnamed = dynamic.filter((r) => !(`${pane}: ${r.arg}` in DYNAMIC));
    expect(unnamed.map((r) => `${PANES[pane]}:${r.line} ${r.arg}`)).toEqual([]);
  });

  it("no key the pane reads names Cloud unless it never renders on a self-hosted build", () => {
    const hits: string[] = [];
    for (const r of reads) {
      for (const k of r.keys) {
        const cloudy = namesCloud(value(EN, k)) || namesCloud(value(DE, k));
        if (cloudy && !(`${pane}:${k}` in OFF_SELF_HOST)) hits.push(`${PANES[pane]}:${r.line} ${k}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("no string literal in the pane names Cloud unless it never renders on a self-hosted build", () => {
    const hits = literals.filter((l) => !(`${pane}:${l.text}` in LITERALS_OFF_SELF_HOST));
    expect(hits.map((l) => `${PANES[pane]}:${l.line} ${JSON.stringify(l.text)}`)).toEqual([]);
  });

  it("the ledger is not stale: every entry is still read by the pane and still names Cloud", () => {
    const read = new Set(reads.flatMap((r) => r.keys));
    for (const entry of Object.keys(OFF_SELF_HOST).filter((e) => e.startsWith(`${pane}:`))) {
      const k = entry.slice(pane.length + 1);
      expect(read.has(k), `${entry} is no longer read`).toBe(true);
      expect(namesCloud(value(EN, k)) || namesCloud(value(DE, k)), `${entry} no longer names Cloud`).toBe(true);
    }
    const said = new Set(literals.map((l) => l.text));
    for (const entry of Object.keys(LITERALS_OFF_SELF_HOST).filter((e) => e.startsWith(`${pane}:`))) {
      expect(said.has(entry.slice(pane.length + 1)), `${entry} is no longer in the pane`).toBe(true);
    }
    const found = new Set(dynamic.map((r) => `${pane}: ${r.arg}`));
    for (const entry of Object.keys(DYNAMIC).filter((e) => e.startsWith(`${pane}:`))) {
      expect(found.has(entry), `${entry} is no longer a read`).toBe(true);
    }
  });
});

describe("the ledger's premises", () => {
  it("the web pane's `blocked_` reason set carries no organized-elsewhere token", async () => {
    const { SYNC_BLOCK_REASONS } = await import("../app/shell/mail-state");
    expect(SYNC_BLOCK_REASONS.length).toBeGreaterThan(0);
    for (const r of SYNC_BLOCK_REASONS) expect(namesCloud(EN.sync?.[`blocked_${r}`]), r).toBe(false);
  });
});
