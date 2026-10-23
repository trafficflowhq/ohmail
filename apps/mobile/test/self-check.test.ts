/**
 * CHECK THIS MAILBOX, on the phone. The press asks the engine in this process for its reading of
 * `/mailboxes/:id/self-check`, the card then says one sentence — the desktop's shape, this phone's
 * words — and the diagnostic file carries the reading as hashes and classes. There is no React
 * Native renderer in this workspace, so the sentences are driven through `selfCheckRowSaid` and the
 * card's wiring is read from the screen's source for the CALLS it makes, the house pattern.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { checkMailbox, selfChecksThisSession, type MailboxCheck } from "../src/net/mailboxes";
import { selfCheckRowSaid } from "../src/ui/self-check-said";
import { writePhoneDiagnostics } from "../src/engine/diagnostics";
import type { ConnectedSession } from "../src/net/pairing";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const code = (rel: string): string => withoutComments(readFileSync(join(APP, rel), "utf8"));

const ID = "3f1c2b9a-0d4e-4c55-9a7b-1b2c3d4e5f60";
const FOLDER = "Rechnungen/Bergen 2026";
const reading = (folders: unknown[], mailboxId = ID) => ({ mailboxId, checkedAt: "2026-09-27T06:00:00.000Z", elapsedMs: 120, verdict: "x", folders });

function session(answer: { status: number; body: unknown }): { s: ConnectedSession; asked: string[] } {
  const asked: string[] = [];
  const s = {
    profile: { origin: "http://127.0.0.1:0", apiBase: null },
    fetch: async (url: string, init?: RequestInit) => {
      asked.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
    },
  } as unknown as ConnectedSession;
  return { s, asked };
}

afterEach(() => { resetLocaleRegisterForTests(); });

describe("the card's sentence, per press", () => {
  it("at rest and while asking it says only the verb", () => {
    expect(selfCheckRowSaid({ k: "rest" })).toEqual({ sentence: null, action: "Check this mailbox", busy: false });
    expect(selfCheckRowSaid({ k: "busy" })).toEqual({ sentence: null, action: "Checking…", busy: true });
  });

  /** What the card says for a reading the engine answered, through the one narrowing door. */
  const answer = async (folders: unknown[], mailboxId = ID): Promise<MailboxCheck> =>
    checkMailbox(session({ status: 200, body: reading(folders, mailboxId) }).s, ID);
  const say = async (folders: unknown[]) => selfCheckRowSaid({ k: "done", check: await answer(folders) }).sentence;

  it("a reading says in step, or names each differing folder with its count", async () => {
    expect(await say([{ folder: "INBOX", k: "in_step", server: 3, mirror: 3 }])).toBe("In step with your mail server.");
    expect(await say([
      { folder: "INBOX", k: "server_more", server: 3, mirror: 1 },
      { folder: "Archive", k: "mirror_more", server: 1, mirror: 2 },
      { folder: "Old", k: "uidvalidity_changed", server: 1, mirror: 1 },
    ])).toBe("3 folders differ from your mail server: INBOX (2 more messages on the server), Archive (1 more message here), Old (renumbered by the server).");
    expect(await say([{ folder: "INBOX", k: "unreadable", error: "auth" }])).toBe("Could not check this mailbox: your mail server refused the sign-in.");
    expect(await say([])).toBe("Nothing to compare yet: no folder of this mailbox has been read.");
    const many = await say(Array.from({ length: 8 }, (_, i) => ({ folder: `box-${i}`, k: "server_more", server: 2, mirror: 1 })));
    expect(many?.endsWith("box-5 (1 more message on the server), and 2 more.")).toBe(true);
  });

  it("News' folder before the rename says where its letters are, in both languages", async () => {
    const before = [{ folder: "ohmail/Reads", k: "server_more", server: 28, mirror: 0, predecessorOf: "ohmail/News" }];
    expect(await say(before)).toBe("1 folder differs from your mail server: ohmail/Reads, News' folder before the rename (28 letters not moved into News yet).");
    setActiveLocale("de");
    expect(await say(before)).toBe("1 Ordner weicht von deinem Mailserver ab: ohmail/Reads, der Ordner von News vor der Umbenennung (28 Nachrichten noch nicht nach News verschoben).");
    resetLocaleRegisterForTests();
  });

  it("in German too, and a reading for another mailbox is refused, not shown", async () => {
    setActiveLocale("de");
    expect(await say([{ folder: "INBOX", k: "in_step", server: 1, mirror: 1 }])).toBe("Stimmt mit deinem Mailserver überein.");
    expect(await say([{ folder: "A", k: "server_more", server: 2, mirror: 1 }]))
      .toBe("1 Ordner weicht von deinem Mailserver ab: A (1 Nachricht mehr auf dem Server).");
    resetLocaleRegisterForTests();
    const foreign = await answer([], "another");
    expect(foreign).toEqual({ k: "refused" });
    expect(selfCheckRowSaid({ k: "done", check: foreign }).sentence).toBe("The check could not run. Nothing was changed.");
    expect(selfCheckRowSaid({ k: "failed" }).sentence).toBe("The check could not run. Nothing was changed.");
  });
});

describe("the request and what the file keeps", () => {
  it("one GET of the self-check route, the reading kept for the session", async () => {
    const { s, asked } = session({ status: 200, body: reading([{ folder: FOLDER, k: "server_more", server: 2, mirror: 1 }]) });
    expect(await checkMailbox(s, ID)).toMatchObject({ k: "said", said: { k: "differs", differCount: 1 } });
    expect(asked).toEqual([`GET http://127.0.0.1:0/mailboxes/${ID}/self-check`]);
    expect(selfChecksThisSession()[ID]).toMatchObject({ mailboxId: ID, folders: [{ folder: FOLDER }] });
  });

  it("a refused request is `refused`, so the card says it could not run, and nothing is kept", async () => {
    const { s } = session({ status: 503, body: { error: { message: "no" } } });
    expect(await checkMailbox(s, "other-id")).toEqual({ k: "refused" });
    expect(selfChecksThisSession()["other-id"]).toBeUndefined();
  });

  it("the diagnostic file carries the reading under a mailbox the roster lacks, and never the folder's name", async () => {
    let text = "";
    await writePhoneDiagnostics(
      { reader: null, mailboxes: [], selfChecks: { [ID]: reading([{ folder: FOLDER, k: "server_more", server: 2, mirror: 1 }]) } },
      {
        kv: undefined, now: () => new Date("2026-09-27T06:10:00.000Z"), random16: () => new Uint8Array(16),
        platform: { os: "android", osVersion: 35 }, build: { version: "0.26.0", commit: "dev" }, lines: () => [],
        write: async (t) => { text = t; return "file:///data/ohmail-diagnostics.json"; },
      },
    );
    const file = JSON.parse(text) as { sections: Array<{ k: string; selfCheck?: unknown }> };
    expect(file.sections.filter((s) => s.k === "mailbox").map((s) => s.selfCheck)).toMatchObject([
      { verdict: "server_more", folders: [{ k: "server_more", server: 2, mirror: 1, error: null }] },
    ]);
    expect(text).not.toContain("Rechnungen");
    expect(text).not.toContain("Bergen");
    expect(text).not.toContain(ID);
  });
});

describe("the card's wiring, read for its calls", () => {
  it("Settings offers the press on this phone's own card, over the live session, and the file takes the readings", () => {
    const screen = code("app/settings.tsx");
    expect(screen).toMatch(/checkMailbox\(at, id\)/);
    expect(screen).toMatch(/row\.key === HERE_CARD && here !== null \? \(\(\) => \{\s*const check = selfCheckRowSaid\(checkPress\)/);
    expect(screen).toMatch(/selfChecks: selfChecksThisSession\(\)/);
  });
});
