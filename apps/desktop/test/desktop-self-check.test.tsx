/** @vitest-environment jsdom */
/**
 * SETTINGS → MAILBOXES → CHECK THIS MAILBOX, rendered on the local door. The press goes down the
 * bridge as one GET of `/mailboxes/:id/self-check`, the engine's reading comes back, and the row
 * says one sentence: in step, or which folders differ and by how much, or why nothing could be
 * read. The reading is kept for the session and the diagnostic file carries it without a name.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { readSelfCheck } from "@trafficflow/core/diagnostics";
import { selfCheckPressSentence, selfCheckSentence } from "@ohmail/app-logic/mailboxes/moved";

import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";
import { checkMailboxHere, selfChecksThisSession } from "../src/local-self-check.js";
import { writeDesktopDiagnostics } from "../src/local-diagnostics.js";
import { cleanInstallPane, encodeDesktopAnswer, mountInstallPane, type DesktopPaneRequest } from "./_install-pane.js";

const FACTS = [
  { id: "m1", address: "ann@example.test", displayName: null, status: "connected", lastSyncAt: "2026-09-27T05:00:00.000Z" },
  { id: "m2", address: "old@example.test", displayName: null, status: "disabled", lastSyncAt: null },
];

const reading = (folders: unknown[]) =>
  ({ mailboxId: "m1", checkedAt: "2026-09-27T06:00:00.000Z", elapsedMs: 90, verdict: "x", folders });
type Reply = (request: DesktopPaneRequest) => { status: number; body: unknown };
let asked: Array<{ method: unknown; url: unknown }> = [];
let onCheck: Reply;

function engine(status: number, body: unknown): void {
  asked = [];
  onCheck = () => ({ status, body });
}

async function openMailboxes(locale: "en" | "de", options: { filing?: unknown; onFilings?: Reply } = {}): Promise<HTMLElement> {
  return mountInstallPane({
    status: {
      state: "serving", mode: "local", localDoorVersion: 1, credentialState: "ready",
      mailboxId: FACTS[0]!.id, address: FACTS[0]!.address,
    },
    section: "mailboxes",
    locale,
    answer: (request) => {
      const { method, path, url } = request;
      if (path === "/mailboxes") {
        return { body: { items: FACTS.map((row) => row.id === "m1" ? { ...row, filing: options.filing } : row) } };
      }
      if (path.endsWith("/self-check")) {
        asked.push({ method, url });
        return onCheck(request);
      }
      if (path.includes("/filings")) {
        asked.push({ method, url });
        return options.onFilings?.(request) ?? { status: 404, body: {} };
      }
      if (path === "/local/mailboxes/connections" || path === "/local/search-index") return { body: { items: [] } };
      if (path.endsWith("/profile-import")) return { status: 404, body: {} };
      if (path === "/consent") return { body: { dormancyDays: 60, seedConfirmedAt: "2026-09-27T05:00:00.000Z" } };
      return undefined;
    },
  });
}

async function render(locale: "en" | "de"): Promise<HTMLElement> {
  const pane = await openMailboxes(locale);
  return waitFor(() => {
    const title = (locale === "de" ? de : en).mailboxes.selfCheckTitle;
    const node = within(pane).getByRole("heading", { name: title }).closest<HTMLElement>(".oh-settingssheet");
    if (!node) throw new Error("the local Mailboxes screen did not render Self Check");
    return node;
  });
}

async function press(node: HTMLElement, locale: "en" | "de" = "en"): Promise<void> {
  const label = (locale === "de" ? de : en).mailboxes.selfCheckAction;
  fireEvent.click(within(node).getByRole("button", { name: label }));
  await waitFor(() => expect(within(node).getByRole("button", { name: label })).toHaveProperty("disabled", false));
}

afterEach(cleanInstallPane);

describe("Check this mailbox — the desktop's local door", () => {
  it("one row per live mailbox, one GET down the bridge, and the differing folder named with its count", async () => {
    engine(200, reading([
      { folder: "INBOX", k: "in_step", server: 4, mirror: 4 },
      { folder: "Archive", k: "server_more", server: 3, mirror: 2 },
    ]));
    const node = await render("en");
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
    const node = await render("de");
    await press(node, "de");
    expect(node.textContent).toContain("Stimmt mit deinem Mailserver überein.");
  });

  it("an engine that refuses the request says the check could not run, and claims nothing about the mail", async () => {
    engine(500, { error: { message: "boom" } });
    const node = await render("en");
    await press(node);
    expect(node.textContent).toContain("The check could not run. Nothing was changed.");
    expect(node.textContent).not.toContain("In step");

    // A well-formed answer for another row also cannot become this mailbox's reading.
    onCheck = () => ({
      status: 200,
      body: { ...reading([{ folder: "INBOX", k: "in_step", server: 4, mirror: 4 }]), mailboxId: "m2" },
    });
    await press(node);
    expect(node.textContent).toContain("The check could not run. Nothing was changed.");
    expect(node.textContent).not.toContain("In step");
    expect(asked).toEqual([
      { method: "GET", url: "/mailboxes/m1/self-check" },
      { method: "GET", url: "/mailboxes/m1/self-check" },
    ]);
  });

  it("the session's reading reaches the diagnostic file as classes and counts, never the folder's name", async () => {
    engine(200, reading([{ folder: "Kundenakten Wexford", k: "mirror_more", server: 1, mirror: 3 }]));
    await press(await render("en"));
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
    const frame = encodeDesktopAnswer({ body: reading([]) });
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke: async () => Array.from(frame) });
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

/* FOLDER-MISSING-FILINGS: the desktop drew no filings block, so "Settings → Mailboxes" under the
   strip led nowhere. The shared block now renders over the bridge on every door. */
describe("the filings that wait — the desktop's block over the bridge", () => {
  const waiting = { due: 0, deferred: 0, stuck: 2, stuckSince: "2026-10-24T04:02:00.000Z", stuckRefusalClass: "no_such_folder",
    oldestPendingAt: "2026-10-24T04:02:00.000Z", nextAttemptAt: null, attempts: 3, lastRefusalClass: "no_such_folder",
    asOf: "2026-10-24T04:46:00.000Z", lastCycleAt: null };
  const filings = { mailboxId: "m1", asOf: "2026-10-24T04:46:00.000Z", more: false, groups: [{
    folder: "ohmail/Screened", count: 2, deferred: 0, stuck: 2, deletes: 0, since: "2026-10-24T04:02:00.000Z",
    through: "2026-10-24T04:06:00.000Z", nextAttemptAt: null, at: "INBOX", reasons: [{ reason: "no_such_folder", count: 2 }],
  }] };
  function engineBy(answer: (method: string, url: string, body: unknown) => [number, unknown]): Reply {
    asked = [];
    return ({ method, url, body }) => {
      const raw = body as string | ArrayLike<number> | undefined;
      const text = typeof raw === "string" ? raw : raw ? new TextDecoder().decode(new Uint8Array(raw)) : "";
      const [status, response] = answer(String(method), String(url), text === "" ? undefined : JSON.parse(text));
      return { status, body: response };
    };
  }

  async function renderFilings(onFilings: Reply): Promise<HTMLElement> {
    const pane = await openMailboxes("en", { filing: waiting, onFilings });
    return waitFor(() => {
      const heading = within(pane).getByRole("heading", { name: /^Waiting to be filed/ });
      const node = heading.closest<HTMLElement>(".oh-settingssheet");
      if (!node) throw new Error("the local Mailboxes screen did not render pending filings");
      within(node).getByRole("button", { name: en.mailboxFilings.retry });
      return node;
    });
  }

  it("names the folder, the reason and where the letters are, and both presses go down the bridge", async () => {
    const posted: unknown[] = [];
    const node = await renderFilings(engineBy((method, url, body) => {
      if (method === "GET") return [200, filings];
      posted.push({ url, body });
      return url.endsWith("/retry") ? [202, { reset: 2, skipped: 0 }] : [200, { settled: 2, remaining: 0 }];
    }));
    expect(asked[0]).toEqual({ method: "GET", url: "/mailboxes/m1/filings" });
    const group = within(node).getByRole("group", { name: en.mailboxFilings.waiting });
    expect(within(group).getByRole("status").textContent).toBe("2 for Screened out");
    expect(node.textContent).toMatch(/Waiting since [^—.]+/);
    expect(node.textContent).toContain("Why: the folder is not there");
    expect(node.textContent).toContain("They are in Ohbox on your mail server.");
    fireEvent.click(within(node).getByRole("button", { name: "Try again now" }));
    await waitFor(() => expect(node.textContent).toContain("2 messages will be tried again on the next pass."));
    fireEvent.click(within(node).getByRole("button", { name: "Leave them where they are" }));
    await waitFor(() => expect(node.textContent).toContain("2 messages stay where they are."));
    expect(posted).toEqual([
      { url: "/mailboxes/m1/filings/retry", body: { folder: "ohmail/Screened" } },
      { url: "/mailboxes/m1/filings/leave", body: { folder: "ohmail/Screened", through: "2026-10-24T04:06:00.000Z" } },
    ]);
  });

  it("a 409 says another install organizes it now", async () => {
    const node = await renderFilings(engineBy((method) =>
      method === "GET" ? [200, filings] : [409, { error: { code: "conflict", message: "x" } }],
    ));
    fireEvent.click(within(node).getByRole("button", { name: "Try again now" }));
    await waitFor(() => expect(node.textContent).toContain("Another install organizes this mailbox now. Nothing was changed."));
    expect(asked.filter(({ method }) => method === "POST")).toEqual([
      { method: "POST", url: "/mailboxes/m1/filings/retry" },
    ]);
  });

  it("nothing waits: no block and no request", async () => {
    const pane = await openMailboxes("en", { onFilings: engineBy(() => [200, filings]) });
    await waitFor(() => within(pane).getByRole("button", { name: en.mailboxes.selfCheckAction }));
    expect(within(pane).queryByRole("heading", { name: /^Waiting to be filed/ })).toBeNull();
    expect(asked).toEqual([]);
  });
});

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
