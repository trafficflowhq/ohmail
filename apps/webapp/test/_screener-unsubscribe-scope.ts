import { within } from "@testing-library/react";
import type { EngineMessage } from "@ohmail/wire";
import { vi } from "vitest";
import { message } from "./_draft-shell.js";
import { selectScreenerRow } from "./fixtures/live-screener.js";
import {
  ISO, act, answerSyncWith, goTo, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell.js";

const brand = "PostFinance";
const claim = { reason: "impersonation", brand, domainShared: false, list: true } as const;

export async function unmountUnsubscribe(): Promise<void> {
  await teardownShellEnv();
  vi.unstubAllGlobals();
}

export async function mountUnsubscribe(addresses: readonly string[], checked?: { claimsOnly: boolean }) {
  installShellEnv();
  vi.stubGlobal("innerWidth", 1280);
  const letters = addresses.map((address, index) => message(String(index + 1), {
    accountId: "acct_live_1",
    mailboxId: "mb_1",
    folder: "ohmail/Screener",
    from: { name: checked ? brand : null, address },
    authVerdict: "pass",
    ...(checked ? { senderCheck: claim } : {}),
  }));
  function changes(letter: EngineMessage, index: number) {
    return [
      { type: "message", op: "create", id: letter.id, seq: index * 2 + 1, updatedAt: ISO, entity: letter },
      {
        type: "message_body", op: "create", id: letter.id, seq: index * 2 + 2, updatedAt: ISO,
        entity: {
          messageId: letter.id, state: "ready", text: "Held letter", html: null, loadedRemoteContent: false,
          unsubscribe: "one_click", unsubscribeUrl: null, withheld: null,
        },
      },
    ];
  }
  answerSyncWith(() => Response.json({
    changes: { creates: letters.flatMap(changes), updates: [], moves: [], deletes: [] },
    cursor: String(letters.length * 2), hasMore: false, serverTime: ISO,
  }));
  const writes: unknown[] = [];
  const fetchShell = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === "/api/screener" && checked && (!init?.method || init.method === "GET")) {
      return Response.json({
        items: letters.map((letter) => ({
          id: letter.id, messageId: letter.id, threadId: null, mailboxId: "mb_1",
          sender: letter.from, subject: letter.subject, snippet: "", receivedAt: letter.date,
          aiSuggestion: null, updatedAt: ISO, checked: { ...claim, ...checked },
        })),
        nextCursor: null, total: letters.length, pendingDecisions: [], gone: [],
      });
    }
    if (init?.method === "POST" && path.startsWith("/api/screener/")) {
      const body = JSON.parse(String(init.body));
      writes.push({ path, body });
      return Response.json({ messageId: path.split("/").at(-1), appliedFolder: "ohmail/Screened" });
    }
    return fetchShell(input, init);
  };
  const shell = await mountShell([mailbox({ id: "mb_1", lastSyncAt: ISO, providerConfirms: true })], {
    suggestWire: "none", junkWire: "none",
  });
  await goTo("screener");
  await tick(50);
  await selectScreenerRow(shell, "1");
  return { shell, writes };
}

export const clickUnsubscribe = (target: HTMLElement): Promise<void> => act(async () => { target.click(); });
export const unsubscribeActions = (shell: HTMLElement) => within(within(shell).getByRole("toolbar", { name: "Actions" }));
export const unsubscribeQuestion = () => within(document.body).queryByRole("dialog", { name: "Screen out and unsubscribe" });
