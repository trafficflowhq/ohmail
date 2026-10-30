/**
 * SETTINGS → ABOUT → DIAGNOSTIC FILE, on the phone. The engine sink keeps its newest lines, the
 * press builds the file with the desktop's builder from those lines, the mirror's counts and the
 * mailbox rows, and writes it into the mirror's own directory; the row then says where it is and
 * that nothing was sent, and only then offers the share sheet. There is no React Native renderer
 * in this workspace, so the row's sentences are driven through `diagnosticSaid` and its wiring is
 * read from the screen's source, the house pattern for a phone surface.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import type { EntityReader } from "@ohmail/client-engine";

import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import {
  PHONE_DIAGNOSTIC_INSTALL_KEY,
  diagnosticFileUri,
  readablePath,
  writePhoneDiagnostics,
  type PhoneDiagnosticDeps,
} from "../src/engine/diagnostics";
import { ENGINE_LOG_RING_LINES, engineLogSink, recentEngineLines } from "../src/engine/engine-log";
import { diagnosticSaid } from "../src/ui/diagnostic-said";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const code = (rel: string): string => withoutComments(readFileSync(join(APP, rel), "utf8"));

const ADDRESS = "juno.halvorsen@fjordpost.example";
const SPLIT = "juno.halvorsen @fjordpost.example";
const SUBJECT = "Invoice for the Bergen apartment";
const FOLDER = "Rechnungen/Bergen 2026";
const HOST = "mail.fjordpost.example";
const SENTENCE = "The server closed the connection before the greeting.";
const NEEDLES = [ADDRESS, "juno.halvorsen", "fjordpost", SUBJECT, "Bergen", FOLDER, "Rechnungen", HOST, SENTENCE];

function kv(): { store: Map<string, string>; kv: NonNullable<PhoneDiagnosticDeps["kv"]> } {
  const store = new Map<string, string>();
  return {
    store,
    kv: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => { store.set(k, v); },
      remove: async (k) => { store.delete(k); },
    },
  };
}

function reader(counts: Record<string, number>): EntityReader {
  return { list: (t: string) => new Array(counts[t] ?? 0).fill({}) } as unknown as EntityReader;
}

const ROWS = [{
  id: "3f1c2b9a-0d4e-4c55-9a7b-1b2c3d4e5f60", address: ADDRESS, displayName: SUBJECT, status: "connected",
  organizerRole: "organizer", organizerState: "held", junkFolder: FOLDER, sentFolder: FOLDER, organizedBy: { kind: "mobile", name: HOST },
}];

afterEach(() => { resetLocaleRegisterForTests(); });

describe("the phone's diagnostic file", () => {
  it("the sink keeps its newest lines, bounded, for the file", () => {
    const sink = engineLogSink();
    for (let i = 0; i < ENGINE_LOG_RING_LINES + 5; i++) sink(JSON.stringify({ service: "app", event: "tick", count: i }));
    const lines = recentEngineLines();
    expect(lines).toHaveLength(ENGINE_LOG_RING_LINES);
    expect(lines.at(-1)).toContain(`"count":${ENGINE_LOG_RING_LINES + 4}`);
  });

  it("one press builds the file from the ring, the mirror and the rows, and none of their words reach it", async () => {
    const sink = engineLogSink();
    sink(JSON.stringify({ ts: "2026-09-27T04:00:00.000Z", level: "warn", service: "engine", event: "imap_connect_failed", host: HOST, reason: SENTENCE, fromFolder: FOLDER, attempt: 4 }));
    sink(JSON.stringify({ ts: "2026-09-27T04:00:01.000Z", level: "error", service: "phone", event: "render_error_caught", errorClass: "TypeError", errorText: `${SUBJECT} ${SPLIT}`, surface: "reader" }));
    const { store, kv: k } = kv();
    const written: string[] = [];
    const deps: PhoneDiagnosticDeps = {
      kv: k,
      now: () => new Date("2026-09-27T05:00:00.000Z"),
      random16: () => new Uint8Array(16).fill(7),
      platform: { os: "android", osVersion: 35 },
      build: { version: "0.26.0", commit: "dev" },
      lines: recentEngineLines,
      write: async (text) => { written.push(text); return "file:///data/user/0/app.ohmail/files/SQLite/ohmail-diagnostics.json"; },
    };
    const where = await writePhoneDiagnostics({ reader: reader({ message: 7, [FOLDER]: 2 }), mailboxes: ROWS }, deps);
    expect(where).toMatch(/ohmail-diagnostics\.json$/);
    const file = written[0]!;
    expect(NEEDLES.filter((n) => file.includes(n))).toEqual([]);
    expect(file).toContain('"imap_connect_failed"');
    expect(file).toContain('"surface": "phone"');
    expect(file).toContain('"message": 7');
    expect(file).toContain('"from": "event"');
    // The identity is kept for the next press, and the second file wears the same install hash.
    expect(JSON.parse(store.get(PHONE_DIAGNOSTIC_INSTALL_KEY)!).id).toBe("07".repeat(16));
    await writePhoneDiagnostics({ reader: null, mailboxes: [] }, deps);
    const hash = (t: string) => (JSON.parse(t) as { sections: { k: string; hash?: string }[] }).sections.find((s) => s.k === "install")?.hash;
    expect(hash(written[1]!)).toBe(hash(file));
  });

  it("the file goes into the directory every mirror is opened in", () => {
    expect(diagnosticFileUri("/data/user/0/app.ohmail/files/SQLite", "ohmail-diagnostics.json"))
      .toBe("file:///data/user/0/app.ohmail/files/SQLite/ohmail-diagnostics.json");
    expect(diagnosticFileUri("file:///var/mobile/Documents/SQLite/", "ohmail-diagnostics.json"))
      .toBe("file:///var/mobile/Documents/SQLite/ohmail-diagnostics.json");
    expect(readablePath("file:///var/mobile/My%20Docs/SQLite/x.json")).toBe("/var/mobile/My Docs/SQLite/x.json");
    // The native half names expo-sqlite's own directory, and every mirror is opened without another.
    expect(code("src/engine/diagnostics-native.ts")).toContain("SQLite.defaultDatabaseDirectory");
    expect(code("src/engine/native.ts")).toMatch(/SQLite\.openDatabaseAsync\(dbFileName\(dbName\)\)/);
  });

  it("the row says where the file is and that nothing was sent, in both decks, and shares only a written file", () => {
    for (const [lang, sent] of [["en", "Nothing was sent."], ["de", "Es wurde nichts gesendet."]] as const) {
      setActiveLocale(lang);
      expect(diagnosticSaid({ k: "rest" }).share).toBeNull();
      expect(diagnosticSaid({ k: "busy" }).busy).toBe(true);
      const written = diagnosticSaid({ k: "written", where: "file:///data/SQLite/ohmail-diagnostics.json" });
      expect(written.sentence).toContain("/data/SQLite/ohmail-diagnostics.json");
      expect(written.sentence).toContain(sent);
      expect(written.share).toBe("file:///data/SQLite/ohmail-diagnostics.json");
      expect(diagnosticSaid({ k: "failed" }).sentence.replace(/[.;]$/, "")).toContain(sent.replace(/\.$/, ""));
      expect(diagnosticSaid({ k: "failed" }).share).toBeNull();
      expect(diagnosticSaid({ k: "share_failed", where: "file:///x" }).share).toBe("file:///x");
    }
  });

  it("Settings → About mounts the row, and nothing in its path opens a connection", () => {
    const settings = code("app/settings.tsx");
    expect(settings).toMatch(/<DiagnosticPanel \/>\s*<\/Panel>/);
    expect(settings).toContain("diagnosticSaid(press)");
    expect(settings.match(/shareDiagnosticFile\(/g)).toHaveLength(1);
    for (const rel of ["src/engine/diagnostics.ts", "src/engine/diagnostics-native.ts", "src/ui/diagnostic-said.ts"]) {
      const src = code(rel);
      expect(src, rel).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|from "\.\.\/net\//);
    }
    // Control: the same reader does see a transport where there is one.
    expect(code("src/net/mailboxes.ts")).toMatch(/\bfetch/);
  });
});
