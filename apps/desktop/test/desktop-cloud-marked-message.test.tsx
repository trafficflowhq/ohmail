/** @vitest-environment jsdom */
import type { EngineMessage, MailboxDTO, MessageDTO, SnapshotResponse, SyncResponse } from "@ohmail/wire";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { materializeMessages } from "@trafficflow/services/mail";
import { letterPictures } from "@ohmail/app-logic/reader";
import { autoLoadsImages } from "@ohmail/app-logic/reader/remote-images";
import { openLocalDb, type OpenLocalDb } from "../../sidecar/src/db.js";
import { ensureLocalWorld } from "../../sidecar/src/identity.js";
import { createCloudMirror } from "../../sidecar/src/cloud-mirror.js";
import type { CloudAuth } from "../../sidecar/src/cloud-auth.js";
import { hostedMailbox } from "./fixtures/approval-server.js";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import { act, message as shellLetter, mountShell, stubDom, unmountAll } from "../../webapp/test/_draft-shell.js";
import { ohboxRow } from "../../webapp/test/ohbox/_finders.js";
import { mountPanel } from "../../webapp/test/_reader-1-panel.js";

/* jsdom's `Blob` has no `arrayBuffer()`, and the store this test opens in-process loads its search
   extensions as a Blob: shimmed through jsdom's own FileReader, as desktop-first-cloud-door does. */
if (typeof (Blob.prototype as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
  (Blob.prototype as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer =
    function (this: Blob) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as ArrayBuffer);
        fr.onerror = () => reject(fr.error);
        fr.readAsArrayBuffer(this);
      });
    };
}

/**
 * A MARKED MESSAGE ON THE CLOUD-MODE DESKTOP (mail 0148): Cloud's fact, mirrored and
 * re-read through the local door the desktop serves its window from, holds the message's pictures
 * for a press, draws the chip on its row and the sentence under the sender in the reader.
 *
 * RE-POINTED (share reader-1, the switch's older tests): the one case is split into its act and its two
 * surfaces, each over the new part. The act: the picture door's rule read from its home
 * (`@ohmail/app-logic/reader/remote-images`) and what the new reader hands the letter's body for its pictures
 * (`letterPictures`). The row: the seated Ohbox's, through the new shell's test door (`_draft-shell.ts`'s
 * `mountShell`), under the test door's one let-in address (the Ohbox lists only senders let in). The sentence: the
 * new reader's head, through the share's door (`_reader-1-panel.tsx`), found by its words. The new row draws no chip
 * and the new reader's head no check line: those two cases are red by their rows (`GAP`), each expectation as it
 * stood (the sentence the fact made, the chip's words).
 */

const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWN = "me@ohmail.test";
const PHISH = personalAt("fixture.kartenservice", "gmail.com");
const MAILBOXES: readonly MailboxDTO[] = [hostedMailbox(CLOUD_MAILBOX, OWN)];
const EMPTY: SnapshotResponse = { asOfSeq: 99, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } };
const iso = (): string => new Date().toISOString();
const json = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
/** The session half of the double: live, nothing scheduled, nothing to stop. */
const LIVE = { state: "live" as const, code: null, since: "2026-01-01T00:00:00.000Z" };

/** The Ohbox's one let-in sender (the test door's rule). */
const LET_IN = "colleague@example.invalid";

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
beforeEach(() => {
  stubDom();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(async () => {
  cleanup();
  await unmountAll();
  for (const o of opens.splice(0)) await o.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function marked(id: string): MessageDTO {
  return {
    id, accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", mailboxId: CLOUD_MAILBOX, threadId: null,
    messageIdHeader: `${id}@gmail.com`, subject: "Bitte bestätigen: Reaktivierung Ihrer PostFinance Karte erforderlich",
    from: { name: "PostFinance", address: PHISH }, to: [{ name: null, address: OWN }], cc: [],
    arrivedAt: "2026-10-07T08:00:00.000Z", date: "2026-10-07T08:00:00.000Z", folder: "INBOX",
    snippet: "", unread: true, lastReadAt: null, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-10-07T08:00:00.000Z",
    senderCheck: { reason: "impersonation", brand: "PostFinance", domainShared: true },
  };
}

function cloud(m: MessageDTO): CloudAuth {
  let served = false;
  const none = { creates: [], updates: [], moves: [], deletes: [] };
  const sync: SyncResponse = {
    changes: { ...none, creates: [{ type: "message", op: "create", id: m.id, seq: 1, updatedAt: iso(), entity: m }] },
    cursor: "c1", hasMore: false, serverTime: iso(),
  };
  return {
    authedFetch: async (path: string) => {
      if (path.startsWith("/mailboxes")) return json({ items: MAILBOXES });
      if (path.startsWith("/sync/snapshot")) return json(EMPTY);
      if (path.startsWith("/sync") && new URLSearchParams(path.split("?")[1] ?? "").get("types") === "rule") {
        return json({ ...sync, changes: none, cursor: "0" });
      }
      if (path.startsWith("/sync")) {
        if (served) return json({ ...sync, changes: none, cursor: "end" });
        served = true;
        return json(sync);
      }
      if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    session: () => LIVE, renewNow: async () => LIVE, stop: () => undefined,
  };
}

/** The message as the Cloud-mode desktop's door serves it: mirrored, then re-read. */
async function served(): Promise<MessageDTO> {
  const dataDir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-desktop-marked-"));
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: OWN, now: new Date() });
  const m = marked(randomUUID());
  const mirror = createCloudMirror({
    db: opened.db, world, cursorPath: join(dataDir, "cloud-cursor.json"), now: () => new Date(), auth: cloud(m),
  });
  await mirror.pullOnce();
  await mirror.stop();
  const got = (await materializeMessages(opened.db, world.accountId, [m.id])).get(m.id);
  if (got === undefined) throw new Error("the mirrored message did not come back through the door");
  return got;
}

/** The sentence the served fact makes for its sender's address (a shared provider: anyone can register there). */
const SENTENCE = "This message claims to be from PostFinance, but anyone can register a gmail.com address.";

/** The picture door of an account that loads pictures on open; nothing consented yet. */
const AUTO = {
  proxyFor: () => (url: string) => url, consented: () => false, consent: () => {}, auto: true, loadPixels: false,
  resolvedFor: () => new Map<string, string>(), needRemote: () => {},
};

/** Each case: a PGlite store opened cold, a mirror pass and a render, no wait of its own: up to 4.0 s on the CI VMs,
    145 s under 10% of a CPU. */
const COLD = 240_000;

describe("a marked message on the Cloud-mode desktop", () => {
  it("holds its pictures for a press", async () => {
    const m = await served();
    expect(autoLoadsImages({ auto: true }, m)).toBe(false);
    /* What the reader hands the letter's body: nothing loaded, and the press that loads them. */
    const handed = letterPictures(m, false, AUTO, "none", true, true);
    expect(handed.remoteLoaded).toBe(false);
    expect(handed.onLoadRemote).toBeTypeOf("function");
  }, COLD);

  it("draws the chip on its row (its identity half)", async () => {
    const m = await served();
    await mountShell("#/ohbox", [shellLetter("m1", {
      from: { name: m.from.name, address: LET_IN }, subject: m.subject, senderCheck: m.senderCheck,
    } as Partial<EngineMessage>)]);
    const deadline = Date.now() + 10_000;
    while (ohboxRow(document, "m1") === null) {
      if (Date.now() > deadline) throw new Error("the Ohbox never listed its letter");
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    }
    expect(within(ohboxRow(document, "m1")!).queryByText("Not PostFinance")?.textContent).toBe("Not PostFinance");
  }, COLD);

  it("says the sentence in the reader (its identity half)", async () => {
    const m = await served();
    mountPanel({
      subject: m.subject, from: m.from, to: m.to, senderCheck: m.senderCheck, authVerdict: null,
    } as Partial<EngineMessage>);
    expect(screen.queryAllByText(m.subject).length, "control: the reader opened the letter").toBeGreaterThan(0);
    const line = screen.queryAllByText(/^(This message (claims|says)|Your mail provider checked)/)[0] ?? null;
    expect(line?.textContent ?? "").toContain("PostFinance");
    expect(line?.textContent).toBe(SENTENCE);
  }, COLD);
});
