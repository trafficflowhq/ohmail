/**
 * THE DIAGNOSTIC FILE'S PARTS, each against the thing it copies or promises. The pure hash is
 * held to `node:crypto`, the closed vocabularies to the database's own sets, the section list and
 * every section's keys to a pinned census (a field added without its slot reddens here), the
 * install identity to its rotation, and the home-directory rule to each platform's spelling.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAILBOX_DISABLED_REASONS,
  MAILBOX_ERROR_CODES,
  MAILBOX_SYNC_BLOCK_REASONS,
} from "../../db/src/mailbox-errors.js";
import {
  DIAGNOSTIC_BLOCK_REASONS,
  DIAGNOSTIC_DISABLED_REASONS,
  DIAGNOSTIC_INSTALL_ROTATES_AFTER_DAYS,
  DIAGNOSTIC_MAILBOX_ERROR_CODES,
  buildDiagnosticBundle,
  diagnosticInstall,
  readSelfCheck,
  renderDiagnosticBundle,
  selfCheckSaid,
  sha256Hex,
  stripFrame,
  supportBlock,
  supportFacts,
  supportMailto,
  withSupportBlock,
  withoutSupportBlock,
  type DiagnosticBundle,
  type DiagnosticSection,
} from "../src/diagnostics/index.js";

const INSTALL = { id: "0123456789abcdef0123456789abcdef", mintedAt: "2026-09-20T00:00:00.000Z" };

function fullBundle(): DiagnosticBundle {
  return buildDiagnosticBundle({
    surface: "phone",
    now: new Date("2026-09-27T05:00:00.000Z"),
    build: { version: "0.26.0", commit: "dev" },
    platform: { os: "android", arch: null, osVersion: 35 },
    install: INSTALL,
    app: { uptimeMs: 5, heapUsedBytes: 6, heapTotalBytes: 7 },
    store: { counts: { message: 3, somethingNewer: 2 }, window: { mode: "windowed", days: 90, minRows: 5000 } },
    mailboxes: [{ id: "m1", status: "error", errorCode: "auth", organizerRole: "reader", organizerChecked: false }],
    selfChecks: {
      m1: {
        mailboxId: "m1", checkedAt: "2026-09-27T04:59:00.000Z", elapsedMs: 40, verdict: "unreadable",
        folders: [{ folder: "INBOX", k: "in_step", server: 1, mirror: 1 }, { folder: "Archive", k: "unreadable", error: "timeout" }],
      },
    },
    log: [
      JSON.stringify({ ts: "2026-09-27T04:00:00.000Z", level: "error", service: "phone", event: "render_error_caught", errorClass: "TypeError", surface: "reader" }),
      "TypeError: boom",
      "    at f (/home/x/a.js:1:1)",
    ],
  });
}

describe("the diagnostic file's parts", () => {
  it("the pure SHA-256 answers what node:crypto answers", () => {
    for (const s of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "b".repeat(1000), "grüße ✓ 😀"]) {
      expect(sha256Hex(s), JSON.stringify(s.slice(0, 8))).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });

  it("each closed vocabulary is the database's own set, member for member", () => {
    expect([...DIAGNOSTIC_MAILBOX_ERROR_CODES]).toEqual([...MAILBOX_ERROR_CODES]);
    expect([...DIAGNOSTIC_DISABLED_REASONS]).toEqual([...MAILBOX_DISABLED_REASONS]);
    expect([...DIAGNOSTIC_BLOCK_REASONS]).toEqual([...MAILBOX_SYNC_BLOCK_REASONS]);
  });

  it("THE CENSUS — the sections and every section's keys, pinned", () => {
    const parsed = JSON.parse(renderDiagnosticBundle(fullBundle())) as { sections: Record<string, unknown>[] } & Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["kind", "v", "writtenAt", "sections"]);
    const keys = Object.fromEntries(parsed.sections.map((s) => [String(s.k), Object.keys(s)]));
    expect(keys).toEqual({
      build: ["k", "surface", "version", "commit"],
      platform: ["k", "os", "arch", "osVersion"],
      install: ["k", "hash", "since", "rotatesAfterDays"],
      process: ["k", "appUptimeMs", "appHeapUsedBytes", "appHeapTotalBytes", "engineUptimeMs", "engineRssBytes",
        "engineHeapUsedBytes", "engineHeapTotalBytes", "engineStoreBytes"],
      store: ["k", "counts", "otherTypes", "window"],
      mailbox: ["k", "hash", "sync", "errorCode", "disabledReason", "blockReason", "role", "lease", "selfCheck"],
      log: ["k", "lines", "linesRead"],
      crash: ["k", "records"],
    });
    const log = parsed.sections.find((s) => s.k === "log") as { lines: Record<string, unknown>[] };
    expect(log.lines.map((l) => Object.keys(l))).toEqual([
      ["shape", "ts", "level", "service", "event", "errorClass", "errorCode", "causeClass", "causeCode", "mailbox",
        "account", "values", "labels"],
      ["shape", "kind"],
      ["shape", "kind"],
    ]);
    const crash = parsed.sections.find((s) => s.k === "crash") as { records: Record<string, unknown>[] };
    expect(crash.records.map((r) => Object.keys(r))).toEqual([
      ["from", "event", "errorClass", "surface", "frame"],
      ["from", "errorClass", "frames"],
    ]);
    const mailbox = parsed.sections.find((s) => s.k === "mailbox") as { selfCheck: { folders: Record<string, unknown>[] } & Record<string, unknown> };
    expect(Object.keys(mailbox.selfCheck)).toEqual(["verdict", "checkedAt", "elapsedMs", "folders"]);
    expect(mailbox.selfCheck.folders.map((f) => Object.keys(f))).toEqual([
      ["hash", "k", "server", "mirror", "error"], ["hash", "k", "server", "mirror", "error"],
    ]);
    const store = parsed.sections.find((s) => s.k === "store") as { otherTypes: number; window: unknown };
    expect(store.otherTypes).toBe(2);
    expect(store.window).toEqual({ mode: "windowed", days: 90, minRows: 5000, maxRows: null });
  });

  it("the self-check wire is narrowed: closed classes, real counts, the verdict re-derived", () => {
    const c = readSelfCheck({
      mailboxId: "m1", checkedAt: "yesterday", elapsedMs: -1, verdict: "in_step",
      folders: [
        { folder: "INBOX", k: "server_more", server: 3, mirror: 1 },
        { folder: "Archive", k: "sideways", server: 1, mirror: 1 },
        { folder: "Sent", k: "in_step", server: 1.5, mirror: 1 },
        { folder: "Drafts", k: "unreadable", error: "the server said something" },
        { folder: "", k: "in_step", server: 0, mirror: 0 },
        "not an object",
      ],
    });
    expect(c).toEqual({
      mailboxId: "m1", checkedAt: null, elapsedMs: null, verdict: "unreadable",
      folders: [
        { folder: "INBOX", k: "server_more", server: 3, mirror: 1 },
        { folder: "Archive", k: "unreadable", error: "unknown" },
        { folder: "Sent", k: "unreadable", error: "unknown" },
        { folder: "Drafts", k: "unreadable", error: "unknown" },
      ],
    });
    expect(readSelfCheck({ folders: [] })).toBeNull();
    expect(readSelfCheck(null)).toBeNull();
  });

  it("the sentence's parts: in step, nothing to compare, unreached, and the differing list", () => {
    const of = (folders: unknown[]) => selfCheckSaid(readSelfCheck({ mailboxId: "m", folders })!);
    expect(of([])).toEqual({ k: "empty" });
    expect(of([{ folder: "INBOX", k: "in_step", server: 2, mirror: 2 }])).toEqual({ k: "in_step" });
    expect(of([{ folder: "INBOX", k: "unreadable", error: "auth" }, { folder: "A", k: "unreadable", error: "auth" }]))
      .toEqual({ k: "unreached", error: "auth" });
    expect(of([
      { folder: "INBOX", k: "server_more", server: 5, mirror: 2 },
      { folder: "Archive", k: "mirror_more", server: 1, mirror: 2 },
      { folder: "Old", k: "uidvalidity_changed", server: 4, mirror: 4 },
      { folder: "Sent", k: "in_step", server: 1, mirror: 1 },
      { folder: "Drafts", k: "unreadable", error: "timeout" },
    ])).toEqual({
      k: "differs", differCount: 3, unreadCount: 1, unread: ["Drafts"],
      differ: [
        { folder: "INBOX", k: "server_more", n: 3 },
        { folder: "Archive", k: "mirror_more", n: 1 },
        { folder: "Old", k: "uidvalidity_changed", n: 0 },
      ],
    });
    const many = of(Array.from({ length: 9 }, (_, i) => ({ folder: `F${i}`, k: "server_more", server: 2, mirror: 1 })));
    expect(many).toMatchObject({ k: "differs", differCount: 9 });
    expect(many.k === "differs" && many.differ.length).toBe(6);
  });

  it("predecessorOf is closed to the News folder, and carried on the differing entry", () => {
    const c = readSelfCheck({
      mailboxId: "m", folders: [
        { folder: "ohmail/Reads", k: "server_more", server: 28, mirror: 0, predecessorOf: "ohmail/News" },
        { folder: "Archive", k: "server_more", server: 2, mirror: 1, predecessorOf: "Archive2" },
        { folder: "Old", k: "unreadable", error: "timeout", predecessorOf: "ohmail/News" },
      ],
    })!;
    expect(c.folders).toEqual([
      { folder: "ohmail/Reads", k: "server_more", server: 28, mirror: 0, predecessorOf: "ohmail/News" },
      { folder: "Archive", k: "server_more", server: 2, mirror: 1 },
      { folder: "Old", k: "unreadable", error: "timeout" },
    ]);
    expect(selfCheckSaid(c)).toMatchObject({
      k: "differs", differCount: 2,
      differ: [
        { folder: "ohmail/Reads", k: "server_more", n: 28, predecessorOf: "ohmail/News" },
        { folder: "Archive", k: "server_more", n: 1 },
      ],
    });
    const said = selfCheckSaid(c);
    expect(said.k === "differs" && "predecessorOf" in said.differ[1]!).toBe(false);
  });

  it("a reading for another mailbox is not written under this one", () => {
    const b = buildDiagnosticBundle({
      surface: "desktop", now: new Date("2026-09-27T05:00:00.000Z"), build: {}, platform: {}, install: INSTALL,
      mailboxes: [{ id: "m1" }],
      selfChecks: { m1: { mailboxId: "m2", folders: [{ folder: "INBOX", k: "in_step", server: 0, mirror: 0 }] } },
    });
    const m = b.sections.find((s) => s.k === "mailbox");
    expect(m && m.k === "mailbox" && m.selfCheck).toBeNull();
  });

  it("a section of a kind the renderer does not know is refused, never written", () => {
    const b = fullBundle();
    b.sections.push({ k: "subject", text: "anything" } as unknown as DiagnosticSection);
    expect(() => renderDiagnosticBundle(b)).toThrow(/no case for "subject"/);
  });

  it("a value or label key the gate does not admit is dropped by the renderer too", () => {
    const b = fullBundle();
    const log = b.sections.find((s) => s.k === "log")!;
    if (log.k !== "log" || log.lines[0]!.shape !== "event") throw new Error("fixture moved");
    log.lines[0]!.values.subject = 1;
    log.lines[0]!.labels.host = "x";
    log.lines[0]!.values.attempt = 2;
    const text = renderDiagnosticBundle(b);
    expect(text).not.toContain('"subject"');
    expect(text).not.toContain('"host"');
    expect(text).toContain('"attempt": 2');
  });

  it("a window process's end keeps its signal, method and numbers, and drops its pid", () => {
    const line = '{"service":"shell","event":"renderer_exit","pid":1855920,"signal":"SIGSEGV","signo":11,"core":true,"exitStatus":null,"method":"pidfd_info","stderrLines":3}';
    const b = buildDiagnosticBundle({ surface: "desktop", now: new Date("2026-10-26T00:00:00.000Z"), build: {}, platform: {}, install: INSTALL, log: [line] });
    const log = b.sections.find((s) => s.k === "log");
    if (log?.k !== "log" || log.lines[0]?.shape !== "event") throw new Error("the line was not read as an event");
    expect(log.lines[0].event).toBe("renderer_exit");
    expect(log.lines[0].labels).toEqual({ signal: "SIGSEGV", method: "pidfd_info" });
    expect(log.lines[0].values).toEqual({ signo: 11, core: true, exitStatus: null, stderrLines: 3 });
    expect(renderDiagnosticBundle(b)).not.toContain("1855920");
  });

  it("the install identity is kept inside its rotation and minted fresh outside it", () => {
    const now = new Date("2026-09-27T00:00:00.000Z");
    const mint = () => "fedcba9876543210fedcba9876543210";
    expect(diagnosticInstall(INSTALL, now, mint)).toEqual({ record: INSTALL, rotated: false });
    const old = { id: INSTALL.id, mintedAt: new Date(now.getTime() - DIAGNOSTIC_INSTALL_ROTATES_AFTER_DAYS * 86_400_000).toISOString() };
    expect(diagnosticInstall(old, now, mint)).toEqual({ record: { id: mint(), mintedAt: now.toISOString() }, rotated: true });
    expect(diagnosticInstall({ id: "not hex", mintedAt: INSTALL.mintedAt }, now, mint).rotated).toBe(true);
    expect(diagnosticInstall(null, now, mint).rotated).toBe(true);
    expect(() => diagnosticInstall(null, now, () => "short")).toThrow(/32 lowercase hex/);
    // A rotated identity writes a different hash for the same mailbox.
    const hashOf = (id: string) => {
      const s = buildDiagnosticBundle({ surface: "phone", now, build: {}, platform: {}, install: { id, mintedAt: now.toISOString() }, mailboxes: [{ id: "m" }] })
        .sections.find((x) => x.k === "mailbox");
      return s?.k === "mailbox" ? s.hash : "";
    };
    expect(hashOf(INSTALL.id)).not.toBe(hashOf(mint()));
  });

  it("each platform's home directory becomes ~, and the rest of the frame stays", () => {
    expect(stripFrame("    at a (/home/ann/x.js:1:2)")).toBe("at a (~/x.js:1:2)");
    expect(stripFrame("at a (/var/home/ann/x.js:1:2)")).toBe("at a (~/x.js:1:2)");
    expect(stripFrame("at a (/Users/ann/Library/Application Support/x.js:1:2)")).toBe("at a (~/Library/Application Support/x.js:1:2)");
    expect(stripFrame("at a (/root/x.js:1:2)")).toBe("at a (~/x.js:1:2)");
    expect(stripFrame("at a (C:\\Users\\ann\\AppData\\x.js:1:2)")).toBe("at a (~\\AppData\\x.js:1:2)");
    expect(stripFrame("at a (c:/users/ann/x.js:1:2)")).toBe("at a (~/x.js:1:2)");
    expect(stripFrame("at a (file:///home/ann/x.js:1:2)")).toBe("at a (file://~/x.js:1:2)");
    // Control: a path outside every home directory is left as it was.
    expect(stripFrame("at a (/opt/ohmail/engine/main.js:1:2)")).toBe("at a (/opt/ohmail/engine/main.js:1:2)");
    expect(stripFrame("at node:internal/modules/cjs/loader:1145:15")).toBe("at node:internal/modules/cjs/loader:1145:15");
  });
});

describe("the support mail's diagnostics block", () => {
  // Assembled at run time: a provider-domain address is what the block must classify and never write.
  const GMAIL = ["ana", "gmail.com"].join("@");
  const WORDS = { title: "Diagnostics", app: "App", build: "build", platform: "Platform", account: "Account", mailbox: "Mailbox", lastSync: "Last sync error", none: "none" };
  const facts = () => supportFacts({
    surface: "web",
    build: { version: "0.30.3", commit: "0123456789abcdef0123456789abcdef01234567" },
    platform: { os: "linux" },
    account: "3f2a9c1e-0b7d-4e55-9a10-2c3d4e5f6a7b",
    mailboxes: [
      { id: "m1", address: GMAIL, status: "error", errorCode: "auth", authKind: "password" },
      { id: "m2", address: "ana@work.example.org", status: "connected", errorCode: null, authKind: "oauth" },
      { id: "m3", address: "ana@mail.example.org", status: "error", errorCode: "imap.example.org:993 refused" },
    ],
  });

  it("names the build, the platform, the account and each mailbox's provider and error class", () => {
    expect(supportBlock(facts(), WORDS)).toBe([
      "— Diagnostics (ohmail) —",
      "App: ohmail web 0.30.3 · build 012345678",
      "Platform: linux",
      "Account: 3f2a9c1e-0b7d-4e55-9a10-2c3d4e5f6a7b",
      "Mailbox: gmail · Last sync error: auth",
      "Mailbox: microsoft_oauth · Last sync error: none",
      "Mailbox: imap · Last sync error: other",
    ].join("\n"));
  });

  it("holds no address, host or port from the account it describes", () => {
    const block = supportBlock(facts(), WORDS);
    for (const leak of ["@", "gmail.com", "example.org", "993", "ana"]) expect(block).not.toContain(leak);
    // An address offered as the account id is dropped, not written.
    expect(supportFacts({ surface: "phone", build: {}, platform: {}, account: GMAIL }).account).toBeNull();
  });

  it("says none where a fact is missing, and drops what fails the file's own checks", () => {
    const f = supportFacts({ surface: "desktop", build: { version: "nightly", commit: "dev" }, platform: { os: "beos" } });
    expect(supportBlock(f, WORDS).split("\n").slice(1)).toEqual([
      "App: ohmail desktop none", "Platform: other", "Account: none", "Mailbox: none",
    ]);
  });

  it("comes out whole and goes back in, leaving what was written around it", () => {
    const block = supportBlock(facts(), WORDS);
    expect(withoutSupportBlock(`Sync stopped.\n\n${block}`, block)).toBe("Sync stopped.");
    expect(withoutSupportBlock(`\n\n${block}`, block)).toBe("");
    expect(withoutSupportBlock(`a\n\n${block}\n\nb`, block)).toBe("a\n\nb");
    // An edited block is not the block any more.
    expect(withoutSupportBlock(`a\n\n${block.replace("auth", "x")}`, block)).toBeNull();
    expect(withSupportBlock("Sync stopped.\n", block)).toBe(`Sync stopped.\n\n${block}`);
    expect(withSupportBlock("", block)).toBe(`\n\n${block}`);
  });

  it("the mailto carries the same subject and body, line breaks as CRLF", () => {
    const url = supportMailto("Help with ohmail", "a\nb & c");
    expect(url).toBe("mailto:support@ohmail.app?subject=Help%20with%20ohmail&body=a%0D%0Ab%20%26%20c");
  });
});
