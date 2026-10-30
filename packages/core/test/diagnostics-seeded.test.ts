/**
 * THE DIAGNOSTIC FILE CARRIES NONE OF A MAILBOX'S WORDS. The builder is fed a fixture seeded with
 * an address (whole and in the split "local @domain" form), a subject, folder names, a host name,
 * a sentence and a home directory's account name, through every channel that could carry one:
 * mailbox rows, store counts, the build and platform slots, logger lines, the shell's prose and a
 * crashed run's trace. None may appear in the file's text. The positive control plants one past
 * the builder and the same reader must find it.
 */
import { describe, expect, it } from "vitest";
import {
  buildDiagnosticBundle,
  renderDiagnosticBundle,
  type DiagnosticBundle,
  type DiagnosticInput,
} from "../src/diagnostics/index.js";

const ADDRESS = "rosalind.quartermain@kestrel-mail.example";
const SPLIT_ADDRESS = "rosalind.quartermain @kestrel-mail.example";
const SUBJECT = "Quarterly lease renewal for Wexford Street";
const FOLDER = "Kundenakten/Wexford 2026";
const FOLDER_WORD = "Wexfordakten";
const HOST = "imap.kestrel-mail.example";
const SENTENCE = "The mailbox refused the password because the account is locked.";
const HOME_USER = "rosalindq";
/** A folder the self-check compared — its name reaches the file only as a hash. */
const CHECKED_FOLDER = "Steuerbelege/Harrowgate Lieferungen";
const CHECKED_WORD = "Harrowgate";

/** What must never be in the file, each as it could appear on its own. */
const NEEDLES = [
  ADDRESS, "rosalind.quartermain", "kestrel-mail", SUBJECT, "Wexford", FOLDER, "Kundenakten",
  FOLDER_WORD, HOST, SENTENCE, "refused the password", HOME_USER, CHECKED_FOLDER, CHECKED_WORD,
  "Steuerbelege",
];

const MAILBOX_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ACCOUNT_ID = "0b6f0a39-8d3f-4a57-9d4e-44e3a1a2b7c1";
const TS = "2026-09-27T04:00:00.000Z";

const line = (o: Record<string, unknown>): string => JSON.stringify({ ts: TS, level: "info", service: "engine", ...o });

/** The rows as each surface holds them — wider than the builder reads, which is the point. */
const MAILBOX_ROWS = [
  {
    id: MAILBOX_ID, address: ADDRESS, displayName: SUBJECT, status: "connected",
    errorCode: HOST, disabledReason: SENTENCE, syncBlockedReason: FOLDER, organizerRole: "organizer",
    organizerState: "held", junkFolder: FOLDER, sentFolder: FOLDER, firstSyncStopFolder: FOLDER_WORD,
    organizedBy: { kind: "local", name: HOST }, lastSyncAt: TS, releaseRefusal: SENTENCE,
  },
  { id: SPLIT_ADDRESS, status: SENTENCE, organizerRole: FOLDER_WORD, organizerState: HOST },
];

function fixture(): DiagnosticInput {
  return {
    surface: "desktop",
    now: new Date("2026-09-27T05:00:00.000Z"),
    build: { version: SUBJECT, commit: HOST },
    platform: { os: HOST, arch: FOLDER_WORD, osVersion: SENTENCE },
    install: { id: "0123456789abcdef0123456789abcdef", mintedAt: "2026-09-20T00:00:00.000Z" },
    app: { uptimeMs: 1234, heapUsedBytes: 10, heapTotalBytes: 20 },
    store: {
      counts: { message: 12, thread: 4, [FOLDER]: 3, [ADDRESS]: 1, [FOLDER_WORD]: 2 },
      window: { mode: "windowed", days: 90, minRows: 5000, maxRows: 10000 },
    },
    mailboxes: MAILBOX_ROWS,
    selfChecks: {
      [MAILBOX_ID]: {
        mailboxId: MAILBOX_ID, checkedAt: TS, elapsedMs: 812, verdict: SENTENCE,
        folders: [
          { folder: CHECKED_FOLDER, k: "server_more", server: 3, mirror: 2 },
          { folder: CHECKED_WORD, k: "unreadable", error: SENTENCE },
          { folder: FOLDER, k: HOST, server: ADDRESS, mirror: 1 },
        ],
      },
      [SPLIT_ADDRESS]: { mailboxId: SPLIT_ADDRESS, folders: [{ folder: CHECKED_FOLDER, k: "in_step", server: 1, mirror: 1 }] },
    },
    log: [
      line({
        event: "imap_connect_failed", level: "warn", mailboxId: MAILBOX_ID, accountId: ACCOUNT_ID,
        host: HOST, reason: SENTENCE, fromFolder: FOLDER, toFolder: FOLDER_WORD, folderLabel: FOLDER_WORD,
        errorClass: "Error", errorCode: HOST, causeClass: SUBJECT, causeCode: ADDRESS, errorText: SENTENCE,
        detail: SUBJECT, route: `/mailboxes/${ADDRESS}`, why: SENTENCE, sample: SUBJECT, heldBy: HOST,
        droppedFields: [ADDRESS, FOLDER], attempt: 3,
      }),
      line({ event: "label_probe", phase: HOST, state: FOLDER, kind: ADDRESS, verdict: SPLIT_ADDRESS, outcome: SENTENCE }),
      line({ event: "planted_keys", [FOLDER]: 1, [ADDRESS]: 2, [FOLDER_WORD]: 3, [HOST]: 4, nested: { subject: SUBJECT } }),
      line({ event: SUBJECT, service: HOST, level: SENTENCE, ts: ADDRESS }),
      line({
        event: "engine_vitals", rss: 1000, heapUsed: 400, heapTotal: 800, storeBytes: 50, uptimeMs: 99,
        memoryReading: "process", reason: SENTENCE,
      }),
      JSON.stringify({ ts: TS, level: "error", service: "phone", event: "render_error_caught", errorClass: "TypeError",
        errorText: `Cannot read ${SUBJECT} of ${ADDRESS}`, surface: "reader", frame: FOLDER_WORD.toLowerCase() === "x" ? "" : "MessageReader" }),
      `ohmail engine: ${HOST} could not be opened (/home/${HOME_USER}/.local/share/app.ohmail/logs/engine.log) — ${SENTENCE}`,
      `/home/${HOME_USER}/.local/share/app.ohmail/engine/main.js:12`,
      `    throw new Error("${SUBJECT}")`,
      `Error: getaddrinfo ENOTFOUND ${HOST} ${SENTENCE}`,
      `    at connect (/home/${HOME_USER}/.local/share/app.ohmail/engine/main.js:12:3)`,
      `    at Socket.<anonymous> (C:\\Users\\${HOME_USER}\\AppData\\Local\\app.ohmail\\engine\\main.js:4:1)`,
      `    at open (\\\\${HOST}\\share\\main.js:1:1)`,
      `    at read (/Users/${HOME_USER}/Library/Application Support/app.ohmail/engine/main.js:9:9)`,
      `    at file (/opt/${ADDRESS}/engine/main.js:1:1)`,
      `    at split (/opt/${SPLIT_ADDRESS}/main.js:1:1)`,
      `${SPLIT_ADDRESS} ${SUBJECT}`,
      "not json {",
    ],
  };
}

const found = (file: string): string[] => NEEDLES.filter((n) => file.toLowerCase().includes(n.toLowerCase()));

describe("the diagnostic file carries none of a mailbox's words", () => {
  it("the fixture really carries every needle, so an absence below is evidence", () => {
    const fed = JSON.stringify(fixture());
    expect(NEEDLES.filter((n) => !fed.includes(n))).toEqual([]);
  });

  it("no seeded string reaches the file", () => {
    const file = renderDiagnosticBundle(buildDiagnosticBundle(fixture()));
    expect(found(file)).toEqual([]);
  });

  it("the diagnosis survives the scrub — what the file is FOR is still in it", () => {
    const bundle = buildDiagnosticBundle(fixture());
    const file = renderDiagnosticBundle(bundle);
    const log = bundle.sections.find((s) => s.k === "log")!;
    const crash = bundle.sections.find((s) => s.k === "crash")!;
    const mailbox = bundle.sections.find((s) => s.k === "mailbox")!;
    expect(log.k === "log" && log.lines.length).toBe(18);
    expect(file).toContain('"imap_connect_failed"');
    expect(file).toContain('"attempt": 3');
    expect(file).toContain('"errorClass": "Error"');
    expect(file).toContain('"engineRssBytes": 1000');
    expect(mailbox.k === "mailbox" && [mailbox.sync, mailbox.role, mailbox.lease, mailbox.errorCode]).toEqual(["blocked", "organizer", "held", "other"]);
    expect(crash.k === "crash" && crash.records.map((r) => r.from)).toEqual(["event", "trace"]);
    // The frames stay, with the home directory, the network host and the address taken out.
    expect(file).toContain("at connect (~/.local/share/app.ohmail/engine/main.js:12:3)");
    expect(file).toContain("at Socket.<anonymous> (~\\\\AppData\\\\Local\\\\app.ohmail\\\\engine\\\\main.js:4:1)");
    expect(file).toContain("at read (~/Library/Application Support/app.ohmail/engine/main.js:9:9)");
    expect(file).toContain("[host]");
    // The mailbox's id is hashed the same way in its section and in the log line that named it.
    expect(log.k === "log" && mailbox.k === "mailbox" && log.lines[0]!.shape === "event" && log.lines[0]!.mailbox).toBe(
      mailbox.k === "mailbox" ? mailbox.hash : "",
    );
    expect(file).not.toContain(MAILBOX_ID);
    expect(file).not.toContain(ACCOUNT_ID);
    // The self-check survives as counts and closed classes; the folders are there, unnamed.
    const sc = mailbox.k === "mailbox" ? mailbox.selfCheck : null;
    expect(sc && [sc.verdict, sc.elapsedMs, sc.folders.map((f) => [f.k, f.server, f.mirror, f.error])]).toEqual([
      "unreadable", 812,
      [["server_more", 3, 2, null], ["unreadable", null, null, "unknown"], ["unreadable", null, null, "unknown"]],
    ]);
    expect(new Set(sc!.folders.map((f) => f.hash)).size).toBe(3);
  });

  it("POSITIVE CONTROL — a seed planted past the builder is found by the same reader", () => {
    const bundle = buildDiagnosticBundle(fixture());
    const log = bundle.sections.find((s) => s.k === "log")!;
    if (log.k !== "log" || log.lines[1]!.shape !== "event") throw new Error("fixture moved");
    // A single-word folder name passes the label grammar, so a slot the builder did not gate would
    // carry it; the reader must say so.
    log.lines[1]!.labels.state = FOLDER_WORD;
    const planted: DiagnosticBundle = bundle;
    const expected = NEEDLES.filter((n) => FOLDER_WORD.toLowerCase().includes(n.toLowerCase()));
    expect(expected).toContain(FOLDER_WORD);
    expect(found(renderDiagnosticBundle(planted))).toEqual(expected);
  });

  /* A FULL `ohmail/_meta` is its own lease outcome: it does not heal by waiting, which is what
     support reads the file for. The ordinary unreadable lease beside it keeps its own. */
  it.each([
    ["meta_folder_full", "meta_folder_full"], ["lease_unreadable", "unreadable"], ["clock_off", "clock_off"],
    ["meta_undeletable", "meta_undeletable"],
  ] as const)("a mailbox blocked %s reads lease %s and keeps its block reason", (reason, lease) => {
    const input = fixture();
    input.mailboxes = [{ id: MAILBOX_ID, status: "connected", syncBlockedReason: reason, organizerRole: "organizer" }];
    const mailbox = buildDiagnosticBundle(input).sections.find((s) => s.k === "mailbox");
    expect(mailbox?.k === "mailbox" && [mailbox.sync, mailbox.lease, mailbox.blockReason])
      .toEqual(["blocked", lease, reason]);
  });

  it("POSITIVE CONTROL — a checked folder's name planted in its hash slot is found", () => {
    const bundle = buildDiagnosticBundle(fixture());
    const mailbox = bundle.sections.find((s) => s.k === "mailbox");
    if (!mailbox || mailbox.k !== "mailbox" || mailbox.selfCheck === null) throw new Error("fixture moved");
    mailbox.selfCheck.folders[0]!.hash = CHECKED_FOLDER;
    expect(found(renderDiagnosticBundle(bundle))).toEqual([CHECKED_FOLDER, CHECKED_WORD, "Steuerbelege"]);
  });
});
