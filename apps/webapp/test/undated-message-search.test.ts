/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { setActiveFormatZone } from "../app/shell/locale";

/**
 * "Ohbox ·": A SEARCH HIT FOR A MESSAGE WITH NO `Date:` HEADER says where it is and stops. Moved word for word out of
 * `undated-message.test.ts` (whose reader cases now stand over the new reader): it mounts today's Search view and
 * waits for the Search place's mount, which re-points it. The why of the rule: that file's header.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-04T12:00:00.000Z");
let seq = 0;

/** A real-shaped row. `date: null` is the whole point and is the DEFAULT here. */
function msg(over: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${over.id}`,
    from: { name: null, address: `${over.id}@spam.invalid` },
    to: [], cc: [], date: null, folder: "INBOX",
    snippet: "no date header on this one", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
    ...over,
  } as EngineMessage;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setActiveFormatZone("UTC");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  setActiveFormatZone(null);
  host.remove();
});

const render = async (children: React.ReactNode): Promise<void> => {
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW, children,
      }),
    );
  });
};

describe("the separator is never printed without a value on both sides", () => {
  it("a search hit for an undated message says where it is and stops", async () => {
    const { SearchView } = await import("../app/views/SearchView.js");
    const { KeymapProvider } = await import("../../../test/support/keymap-provider");

    const store = new MemoryMirrorStore();
    await store.load();
    const row = msg({ id: "nodate", subject: "Kingfisher invoice", folder: "INBOX" });
    await store.applyChanges([
      { type: "message", op: "create", id: row.id, seq: ++seq, updatedAt: row.updatedAt, entity: row },
    ]);
    const engine = new OhmailEngine({
      store,
      now: () => NOW,
      adapter: {
        sync: async () => ({
          changes: { creates: [], updates: [], moves: [], deletes: [] },
          cursor: "0", hasMore: false, serverTime: NOW.toISOString(),
        }),
        mutate: async () => ({ changes: [], seq: null }),
        fetchBody: async () => null,
      } as unknown as EngineAdapter,
    });

    await render(
      h(KeymapProvider, {
        children: h(SearchView as never, {
          engine, version: 1, now: NOW, query: "kingfisher",
          onQuery: () => {}, onOpen: () => {},
        } as never),
      }),
    );

    const where = host.querySelector(".hit .where");
    expect(where, "the premise: the hit rendered").not.toBeNull();
    // The walked string, exactly.
    expect(where!.textContent).not.toBe("Ohbox · ");
    expect(where!.textContent).toBe("Ohbox");
  });
});
