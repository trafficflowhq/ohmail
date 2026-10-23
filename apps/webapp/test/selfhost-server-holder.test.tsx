/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import en from "../messages/en.json";
import de from "../messages/de.json";
import { filingElsewhereKey, holderSentence } from "../app/shell/reader-holder";
import { ManagedServiceContext } from "../app/shell/managed-service";
import type { MailState } from "../app/shell/mail-state";

/**
 * A SERVER HOLDER IS OHMAIL CLOUD ONLY ON A MANAGED HOST. A self-hosted server's worker writes the
 * lease kind `cloud` too, so on a self-hosted build, the standalone desktop and a paired computer
 * the rail said "ohmail Cloud files this mailbox" about somebody's own server. Read off the rail's
 * rendered title in both languages; the managed build keeps its Cloud sentences (the control).
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

type Cat = { sync: Record<string, string>; mailboxes: Record<string, string> };
const CATS = { en: en as unknown as Cat, de: de as unknown as Cat } as const;

const QUIET: MailState = {
  key: "quiet", clock: false, count: 0, total: null, reason: null, errorCode: null, asOf: null,
  address: null, minutes: null, slow: false, screenerCandidate: false, pending: 0, filing: null,
  continuesAtFolder: null, settled: true, owed: false,
};

let railState: MailState = QUIET;
vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: railState, refresh: () => {} }),
}));

const heldByServer = (name: string | null): MailState => ({
  ...QUIET, key: "filing", count: 2, address: "someone@example.com",
  filing: {
    arm: "elsewhere", count: 2, deferred: 0, reason: null, nextAttemptAt: null, waitedMinutes: null,
    lastPassSeconds: null, asOf: null, mailboxes: 1, first: null, reasonsDiffer: false,
    who: { kind: "cloud", name, stopped: false, mailboxId: "mbx-1", since: null },
  },
});
const blockedByServer: MailState = {
  ...QUIET, key: "blocked", reason: "organized_elsewhere_cloud", address: "someone@example.com", minutes: 3,
};

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => { for (const r of roots.splice(0)) r.unmount(); });
  document.body.innerHTML = "";
});

async function railTitle(state: MailState, locale: "en" | "de", managed?: boolean): Promise<string> {
  railState = state;
  const { SyncBar } = await import("../app/shell/SyncBar.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const bar = h(SyncBar, { variant: "rail" });
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale, messages: CATS[locale] as never, timeZone: "UTC",
      children: managed === undefined ? bar : h(ManagedServiceContext.Provider, { value: managed, children: bar }),
    }));
  });
  return (container.querySelector(".rs-line b")?.textContent ?? "").trim();
}

const CLOUD = /\bCloud\b/;

describe("the rail names a server holder by the host it runs on", () => {
  it("CONTROL — a managed host still says ohmail Cloud files the mailbox, and that it claimed it", async () => {
    expect(await railTitle(heldByServer("ohmail Cloud"), "en")).toBe(CATS.en.sync.filingElsewhereCloudHow);
    expect(await railTitle(blockedByServer, "en", true)).toBe(CATS.en.sync.blocked_organized_elsewhere_cloud);
  });

  it.each(["en", "de"] as const)("%s: an unmanaged host names another ohmail server, never Cloud", async (locale) => {
    for (const name of [null, "ohmail Cloud", "mail.example.com"]) {
      const said = await railTitle(heldByServer(name), locale, false);
      expect(said).toBe(CATS[locale].sync.filingElsewhereServerHow);
      expect(said).not.toMatch(CLOUD);
    }
    const blocked = await railTitle(blockedByServer, locale, false);
    expect(blocked).toBe(CATS[locale].sync.blockedClaimedByServer);
    expect(blocked).not.toMatch(CLOUD);
  });
});

describe("the holder tables answer the server key off a managed host", () => {
  it("the rail's table and the reader row's table", () => {
    expect(filingElsewhereKey({ kind: "cloud" }, "takeover")).toBe("filingElsewhereCloudHow");
    expect(filingElsewhereKey({ kind: "cloud" }, "takeover", false)).toBe("filingElsewhereServerHow");
    expect(filingElsewhereKey({ kind: "cloud" }, "none", false)).toBe("filingElsewhereServer");
    const who = { kind: "cloud", name: null, since: "2026-09-01" };
    expect(holderSentence({ who, verb: "reclaim" }).key).toBe("readerSinceCloudHow");
    expect(holderSentence({ who, verb: "reclaim", managed: false }).key).toBe("readerSinceServerHow");
    expect(holderSentence({ who, verb: "none", managed: false }).key).toBe("readerSinceServer");
    // A computer and a phone are named as they were: the fact moves only the server arm.
    expect(filingElsewhereKey({ kind: "local", name: "omarchy" }, "none", false)).toBe("filingElsewhereLocal");
  });

  it.each(["en", "de"] as const)("%s: every server twin names no Cloud; every Cloud one does", (locale) => {
    const { sync, mailboxes } = CATS[locale];
    for (const said of [sync.filingElsewhereServer, sync.filingElsewhereServerHow, sync.blockedClaimedByServer,
      mailboxes.readerSinceServer, mailboxes.readerSinceServerHow, mailboxes.readerHolderServer]) {
      expect(said).toBeTypeOf("string");
      expect(said).not.toMatch(CLOUD);
    }
    for (const said of [sync.filingElsewhereCloud, sync.filingElsewhereCloudHow, mailboxes.readerSinceCloud]) {
      expect(said).toMatch(CLOUD);
    }
  });
});
