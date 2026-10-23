/** @vitest-environment jsdom */
/**
 * SETTINGS → MAILBOXES → CHECK THIS MAILBOX, rendered on the local door. The press goes down the
 * bridge as one GET of `/mailboxes/:id/self-check`, the engine's reading comes back, and the row
 * says one sentence: in step, or which folders differ and by how much, or why nothing could be
 * read. The reading is kept for the session and the diagnostic file carries it without a name.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import { readSelfCheck } from "@trafficflow/core/diagnostics";

import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";

const FACTS = [
  { id: "m1", address: "ann@example.test", displayName: null, status: "connected" },
  { id: "m2", address: "old@example.test", displayName: null, status: "disabled" },
];
vi.mock("../../webapp/app/shell/MailStateProvider", async () => {
  const real = await vi.importActual<typeof import("../../webapp/app/shell/MailStateProvider")>(
    "../../webapp/app/shell/MailStateProvider",
  );
  return { ...real, useMailboxFacts: () => FACTS };
});

const { MailboxSelfCheck, selfCheckPressSentence, selfCheckSentence } = await import("../../webapp/app/shell/MailboxSelfCheck");
const { checkMailboxHere, selfChecksThisSession } = await import("../src/local-self-check.js");
const { writeDesktopDiagnostics } = await import("../src/local-diagnostics.js");

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
const globe = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } };

function framed(status: number, body: unknown): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "", h: [["content-type", "application/json"]] }));
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const out = new Uint8Array(4 + meta.length + bytes.length);
  new DataView(out.buffer).setUint32(0, meta.length, false);
  out.set(meta, 4);
  out.set(bytes, 4 + meta.length);
  return out;
}

const reading = (folders: unknown[]) => ({ mailboxId: "m1", checkedAt: "2026-09-27T06:00:00.000Z", elapsedMs: 90, verdict: "x", folders });
let asked: Array<{ method: unknown; url: unknown }> = [];

function engine(status: number, body: unknown): void {
  asked = [];
  globe.__TAURI_INTERNALS__ = {
    invoke: (command, payload) => {
      if (command !== "engine_request") return Promise.reject(new Error(`unexpected ${command}`));
      asked.push({ method: payload?.method, url: payload?.url });
      return Promise.resolve(framed(status, body));
    },
  };
}

let root: Root | null = null;
let el: HTMLDivElement | null = null;

async function render(messages: typeof en | typeof de, locale: string): Promise<HTMLDivElement> {
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  await act(() => {
    root?.render(h(NextIntlClientProvider, { locale, messages: messages as never, timeZone: "UTC", children: h(MailboxSelfCheck, { check: checkMailboxHere }) }));
  });
  return el;
}

async function press(node: HTMLDivElement): Promise<void> {
  const button = node.querySelector("button");
  if (!button) throw new Error("no button");
  await act(async () => { button.click(); });
  for (let i = 0; i < 40 && node.querySelector("button")?.hasAttribute("disabled"); i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
}

afterEach(async () => {
  if (root) await act(() => { root?.unmount(); });
  el?.remove();
  root = null;
  delete globe.__TAURI_INTERNALS__;
});

describe("Check this mailbox — the desktop's local door", () => {
  it("one row per live mailbox, one GET down the bridge, and the differing folder named with its count", async () => {
    engine(200, reading([
      { folder: "INBOX", k: "in_step", server: 4, mirror: 4 },
      { folder: "Archive", k: "server_more", server: 3, mirror: 2 },
    ]));
    const node = await render(en, "en");
    expect(node.querySelectorAll("button")).toHaveLength(1);
    expect(node.textContent).toContain("ann@example.test");
    expect(node.textContent).not.toContain("old@example.test");
    expect(node.textContent).toContain("Check this mailbox");
    await press(node);
    expect(asked).toEqual([{ method: "GET", url: "/mailboxes/m1/self-check" }]);
    expect(node.textContent).toContain("1 folder differs from your mail server: Archive (1 more message on the server).");
  });

  it("a clean reading says it is in step, in the window's language", async () => {
    engine(200, reading([{ folder: "INBOX", k: "in_step", server: 4, mirror: 4 }]));
    const node = await render(de, "de");
    await press(node);
    expect(node.textContent).toContain("Stimmt mit deinem Mailserver überein.");
  });

  it("an engine that refuses the request says the check could not run, and claims nothing about the mail", async () => {
    engine(500, { error: { message: "boom" } });
    const node = await render(en, "en");
    await press(node);
    expect(node.textContent).toContain("The check could not run. Nothing was changed.");
    expect(node.textContent).not.toContain("In step");
  });

  it("the session's reading reaches the diagnostic file as classes and counts, never the folder's name", async () => {
    engine(200, reading([{ folder: "Kundenakten Wexford", k: "mirror_more", server: 1, mirror: 3 }]));
    await checkMailboxHere("m1");
    const kept = selfChecksThisSession();
    expect(Object.keys(kept).sort()).toEqual(["bridge", "m1"]);
    let text = "";
    await writeDesktopDiagnostics({ counts: {}, mailboxes: [{ id: "m1", status: "connected" }], selfChecks: kept }, {
      facts: async () => ({ os: "linux", arch: "x86_64", lines: [] }),
      save: async (t) => { text = t; return "/tmp/ohmail-diagnostics.json"; },
      now: () => new Date("2026-09-27T06:10:00.000Z"),
      storage: { get: () => null, set: () => undefined } as never,
      random16: () => new Uint8Array(16),
      app: () => ({ uptimeMs: null, heapUsedBytes: null, heapTotalBytes: null }),
    });
    const file = JSON.parse(text) as { sections: Array<{ k: string; selfCheck?: { verdict: string; folders: Array<{ k: string; server: number; mirror: number }> } }> };
    const mailbox = file.sections.find((s) => s.k === "mailbox");
    expect(mailbox?.selfCheck).toMatchObject({ verdict: "mirror_more", folders: [{ k: "mirror_more", server: 1, mirror: 3 }] });
    expect(text).not.toContain("Wexford");
    expect(text).not.toContain("Kundenakten");
    // The transport self-check is the log's newest line: every raw answer so far crossed as bytes.
    expect(bridgeEntry(text)).toMatchObject({ level: "info", labels: { kind: "ipc" }, values: { count: 0 } });
  });

  /* THE FALLBACK IS LOUD. An answer that crossed as a JSON array (the runtime's channel under a
     policy that refused the scheme) still reads, but is counted, warned once, and named in the file.
     The last case here to cross the bridge, on purpose: the reading is the session's. */
  it("an answer that took the JSON fallback is counted, warned about once, and the file says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const before = selfChecksThisSession().bridge as { answers: number; json: number };
    expect(before.json).toBe(0);
    globe.__TAURI_INTERNALS__ = { invoke: async () => Array.from(framed(200, reading([]))) };
    await checkMailboxHere("m1");
    await checkMailboxHere("m1");
    const after = selfChecksThisSession().bridge as { bridgeTransport: string; answers: number; json: number };
    expect(after).toEqual({ bridgeTransport: "json", answers: before.answers + 2, json: 2 });
    expect(warn.mock.calls.filter((c) => /crossed the command channel as a JSON array/.test(String(c[0])))).toHaveLength(1);
    warn.mockRestore();
    let text = "";
    await writeDesktopDiagnostics({ counts: {}, mailboxes: [], selfChecks: selfChecksThisSession() }, {
      facts: async () => ({ os: "linux", arch: "x86_64", lines: [] }),
      save: async (t) => { text = t; return "/tmp/ohmail-diagnostics.json"; },
      now: () => new Date("2026-09-27T06:20:00.000Z"),
      storage: { get: () => null, set: () => undefined } as never,
      random16: () => new Uint8Array(16),
      app: () => ({ uptimeMs: null, heapUsedBytes: null, heapTotalBytes: null }),
    });
    expect(bridgeEntry(text)).toMatchObject({ level: "warn", labels: { kind: "json" }, values: { total: after.answers, count: 2 } });
  });
});

/** The file's `bridge_transport` log entry, which must be the newest line. */
function bridgeEntry(text: string): Record<string, unknown> | undefined {
  const file = JSON.parse(text) as { sections: Array<{ k: string; lines?: Array<Record<string, unknown>> }> };
  const lines = file.sections.find((s) => s.k === "log")?.lines ?? [];
  const last = lines[lines.length - 1];
  return last?.event === "bridge_transport" ? last : undefined;
}

describe("selfCheckSentence — every arm against the catalogue", () => {
  const t = createTranslator({ locale: "en", messages: en as never, namespace: "mailboxes" }) as unknown as Parameters<typeof selfCheckSentence>[0];
  const say = (folders: unknown[]) => selfCheckSentence(t, readSelfCheck({ mailboxId: "m1", folders })!);

  it("states what was counted, in each shape", () => {
    expect(say([])).toBe("Nothing to compare yet: no folder of this mailbox has been read.");
    expect(say([{ folder: "INBOX", k: "in_step", server: 1, mirror: 1 }])).toBe("In step with your mail server.");
    expect(say([
      { folder: "INBOX", k: "server_more", server: 5, mirror: 2 },
      { folder: "Archive", k: "mirror_more", server: 1, mirror: 2 },
      { folder: "Old", k: "uidvalidity_changed", server: 1, mirror: 1 },
    ])).toBe("3 folders differ from your mail server: INBOX (3 more messages on the server), Archive (1 more message here), Old (renumbered by the server).");
    expect(say([
      { folder: "INBOX", k: "server_more", server: 2, mirror: 1 },
      { folder: "Drafts", k: "unreadable", error: "timeout" },
    ])).toBe("1 folder differs from your mail server: INBOX (1 more message on the server); 1 folder could not be read: Drafts.");
    expect(say([
      { folder: "INBOX", k: "in_step", server: 2, mirror: 2 },
      { folder: "Drafts", k: "unreadable", error: "refused" },
    ])).toBe("1 folder could not be read from your mail server: Drafts. The others are in step.");
  });

  it("a mailbox the server would not answer at all says why, by class", () => {
    const one = (error: string) => say([{ folder: "INBOX", k: "unreadable", error }]);
    expect(one("auth")).toBe("Could not check this mailbox: your mail server refused the sign-in.");
    expect(one("timeout")).toBe("Could not check this mailbox: your mail server did not answer in time.");
    expect(one("connect")).toBe("Could not check this mailbox: your mail server could not be reached.");
    expect(one("dropped")).toBe("Could not check this mailbox: your mail server could not be read.");
  });

  it("News' folder before the rename says where its letters are", () => {
    expect(say([
      { folder: "INBOX/Sent", k: "server_more", server: 9, mirror: 5 },
      { folder: "ohmail/Reads", k: "server_more", server: 28, mirror: 0, predecessorOf: "ohmail/News" },
    ])).toBe("2 folders differ from your mail server: INBOX/Sent (4 more messages on the server), "
      + "ohmail/Reads, News' folder before the rename (28 letters not moved into News yet).");
    expect(say([{ folder: "ohmail/Reads", k: "server_more", server: 1, mirror: 0, predecessorOf: "ohmail/News" }]))
      .toBe("1 folder differs from your mail server: ohmail/Reads, News' folder before the rename (1 letter not moved into News yet).");
  });

  it("a long list names six and counts the rest", () => {
    const s = say(Array.from({ length: 8 }, (_, i) => ({ folder: `box-${i}`, k: "server_more", server: 2, mirror: 1 })));
    expect(s.startsWith("8 folders differ from your mail server: box-0 (1 more message on the server)")).toBe(true);
    expect(s.endsWith("box-5 (1 more message on the server), and 2 more.")).toBe(true);
  });

  it("says the filings that still wait, beside a reading in step", () => {
    const check = readSelfCheck({ mailboxId: "m1", folders: [{ folder: "INBOX", k: "in_step", server: 1, mirror: 1 }] })!;
    expect(selfCheckPressSentence(t, { k: "read", check }, 6))
      .toBe("In step with your mail server. 6 messages are still waiting to be filed on your mail server.");
    expect(selfCheckPressSentence(t, { k: "read", check }, 0)).toBe("In step with your mail server.");
  });
});
