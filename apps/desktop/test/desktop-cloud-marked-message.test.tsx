/** @vitest-environment jsdom */
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { MessageRow, ThemeProvider } from "@ohmail/ui";
import { materializeMessages } from "@trafficflow/services/mail";
import type { MailboxDTO, MessageDTO, SnapshotResponse, SyncResponse } from "@trafficflow/services/mail";
import en from "../../webapp/messages/en.json";
import { autoLoadsImages } from "../../webapp/app/shell/remote-images.js";
import { senderCheckFact, senderCheckSentence } from "../../webapp/app/shell/sender-check.js";
import { openLocalDb, type OpenLocalDb } from "../../sidecar/src/db.js";
import { ensureLocalWorld } from "../../sidecar/src/identity.js";
import { createCloudMirror } from "../../sidecar/src/cloud-mirror.js";
import type { CloudAuth } from "../../sidecar/src/cloud-auth.js";
import { hostedMailbox } from "./fixtures/approval-server.js";

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
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWN = "me@ohmail.test";
const PHISH = "karten.reaktivierung@gmail.com";
const MAILBOXES: readonly MailboxDTO[] = [hostedMailbox(CLOUD_MAILBOX, OWN)];
const EMPTY: SnapshotResponse = { asOfSeq: 99, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } };
const iso = (): string => new Date().toISOString();
const json = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
/** The session half of the double: live, nothing scheduled, nothing to stop. */
const LIVE = { state: "live" as const, code: null, since: "2026-01-01T00:00:00.000Z" };

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
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

const words = (key: string, v: Record<string, string> = {}): string => ({
  "senderCheck.impersonation": `This message claims to be from ${v.brand}, but ${v.domain} isn't one of ${v.brand}'s addresses.`,
  "senderCheck.impersonationShared": `This message claims to be from ${v.brand}, but anyone can register a ${v.domain} address.`,
} as Record<string, string>)[key] ?? key;

describe("a marked message on the Cloud-mode desktop", () => {
  it("holds its pictures for a press, draws the chip and says the sentence in the reader", async () => {
    const m = await served();
    expect(autoLoadsImages({ auto: true }, m)).toBe(false);
    const fact = senderCheckFact(m as never);
    expect(fact).toEqual({ brand: "PostFinance", domainShared: true, domain: "gmail.com" });
    expect(senderCheckSentence(words, fact!)).toBe("This message claims to be from PostFinance, but anyone can register a gmail.com address.");

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(React.createElement(ThemeProvider, {
        storageKey: null,
        children: React.createElement(MessageRow, {
          id: m.id, from: "PostFinance", subject: m.subject,
          senderCheckLabel: `Not ${fact!.brand}`, senderCheckTitle: senderCheckSentence(words, fact!),
        } as never),
      }));
    });
    expect(host.querySelector(".bdg-check")?.textContent).toBe("Not PostFinance");
    await act(async () => { root!.unmount(); });
    host.remove();

    process.env.NEXT_PUBLIC_API_BASE ??= "/api";
    const { MessagePane } = await import("../../webapp/app/shell/MessagePane.js");
    const { MessageChromeProvider } = await import("../../webapp/app/shell/message-chrome.js");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(React.createElement(NextIntlClientProvider, {
        locale: "en", messages: en, timeZone: "UTC", now: new Date("2026-10-07T12:00:00.000Z"),
        children: React.createElement(MessageChromeProvider as never, {
          value: {
            ownAddresses: [], replyTo: null, replyBody: { text: "", html: "" }, onReplyBody: () => {},
            closeReply: () => {}, sendReply: () => {}, replySendState: () => ({ phase: "idle" }),
            openSenderMenu: () => {}, conversationOf: () => [], hydrateBody: () => {}, hydrateThread: () => {},
            bodyOf: () => ({ text: "", state: "snippet", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
          },
          children: React.createElement(MessagePane as never, {
            message: m, tags: [], now: new Date("2026-10-07T12:00:00.000Z"),
            onAction: () => {}, onAddTag: () => {}, onAttachment: () => {},
          }),
        }),
      }));
    });
    expect(host.querySelector('.msg-from > .msg-from-check[data-reason="identity"]')?.textContent ?? "")
      .toContain("PostFinance");
  });
});
