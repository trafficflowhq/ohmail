/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { MemoryMirrorStore, type EngineMessage, type SyncChange } from "@ohmail/client-engine";
import en from "../apps/webapp/messages/en.json";
import de from "../apps/webapp/messages/de.json";
import { AutoUnsubscribeRow } from "../apps/webapp/app/shell/AutoUnsubscribeRow";
import { SenderMenu } from "../apps/webapp/app/shell/SenderMenu";
import { senderScreening } from "../apps/webapp/app/shell/sender-screening";
import { ROOT } from "./support/public-root.mjs";

/**
 * WHERE A SCREEN-OUT'S UNSUBSCRIBE LEAVES FROM, SAID WHERE THE PERSON AGREES TO IT. The two notes
 * a person reads before the request goes out are the Settings switch's note and the fine print of
 * the sender sheet's confirm. On Cloud the hosted worker sends the request, and both say it goes
 * from our servers, so the sender's log never holds the person's address. On the desktop the
 * engine on the person's own computer sends it (the local engine, or the paired host's), so the
 * list's endpoint sees that computer's network address: there the notes name the computer and that
 * address, in both languages, the way the picture rows already do. `test/desktop-egress-disclosed`
 * holds the published accounts of the same egress; this holds the app's own.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

const CATALOGUES = { en, de } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = ["en", "de"] as const;

/** What only a server can say: the request goes from ours. */
const SERVERS = /our servers|unseren Servern/i;
/** …and what a computer of the person's own must say instead: which machine, and what it shows. */
const COMPUTER: Record<Locale, RegExp> = { en: /\bcomputer\b/i, de: /\bComputer\b/ };
const ADDRESS: Record<Locale, RegExp> = { en: /network address/i, de: /Netzwerkadresse/ };

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(locale: Locale, node: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: CATALOGUES[locale] as never, timeZone: "UTC", children: node,
    }));
  });
  return host;
}

/** The Settings switch's note, read off the row whose label is the switch's title. */
async function switchNote(locale: Locale, fromComputer: boolean): Promise<string> {
  const el = await mount(locale, h(AutoUnsubscribeRow, {
    on: true, setBlockAutoUnsubscribe: async () => false, fromComputer,
  }));
  const title = CATALOGUES[locale].settings.autoUnsub.title;
  const row = [...el.querySelectorAll<HTMLElement>(".set-row")].find((r) => r.querySelector("b")?.textContent === title);
  const note = row?.nextElementSibling;
  expect(note?.classList.contains("set-note-inline"), `${locale}: the switch's note is not under its row`).toBe(true);
  return note!.textContent ?? "";
}

const HELD: EngineMessage = {
  id: "a", accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
  subject: "Weekly offers", from: { name: null, address: "news@shop.example" }, to: [], cc: [],
  date: "2026-08-01T09:00:00.000Z", folder: "ohmail/Screener", snippet: "s", unread: false,
  hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-01T09:00:00.000Z",
};

/** The confirm's fine print, after a screen-out press on a held one-click letter its sender signed. */
async function confirmNote(locale: Locale, fromComputer: boolean): Promise<string> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([{ type: "message", op: "create", id: HELD.id, seq: 1, updatedAt: HELD.updatedAt, entity: HELD } as SyncChange]);
  const el = await mount(locale, h(SenderMenu, {
    state: { messageId: HELD.id, x: 0, y: 0 },
    sender: senderScreening(store, HELD.id)!,
    onChoose: () => {}, onOpenDetail: () => {}, onClose: () => {},
    lettersFor: () => [{ posture: "one_click", authVerdict: "pass" }],
    fromComputer,
  }));
  const screenOut = el.querySelector('li[data-dest="screened"]');
  expect(screenOut, `${locale}: the sheet offers no screen-out`).toBeTruthy();
  await act(async () => { screenOut!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  const fine = el.querySelector(".sm-confirm .sm-confirm-fine .infonote-more");
  expect(fine, `${locale}: the screen-out opened no confirm carrying the fine print`).toBeTruthy();
  return fine!.textContent ?? "";
}

describe("a computer of the person's own says the unsubscribe leaves from it", () => {
  for (const locale of LOCALES) {
    it(`the Settings switch's note, in ${locale}`, async () => {
      const note = await switchNote(locale, true);
      expect(note, `${locale}: the desktop's note says the request goes from our servers`).not.toMatch(SERVERS);
      expect(note, `${locale}: the desktop's note does not name the computer`).toMatch(COMPUTER[locale]);
      expect(note, `${locale}: the desktop's note does not say what the sender sees`).toMatch(ADDRESS[locale]);
    });

    it(`the sender sheet's confirm, in ${locale}`, async () => {
      const note = await confirmNote(locale, true);
      expect(note, `${locale}: the desktop's confirm says the request goes from our servers`).not.toMatch(SERVERS);
      expect(note, `${locale}: the desktop's confirm does not name the computer`).toMatch(COMPUTER[locale]);
      expect(note, `${locale}: the desktop's confirm does not say what the sender sees`).toMatch(ADDRESS[locale]);
    });
  }
});

describe("CONTROL: the Cloud face keeps the server sentence, which is true there", () => {
  for (const locale of LOCALES) {
    it(`the Settings switch's note, in ${locale}`, async () => {
      const note = await switchNote(locale, false);
      expect(note).toBe(CATALOGUES[locale].settings.autoUnsub.microcopy);
      expect(note).toMatch(SERVERS);
    });

    it(`the sender sheet's confirm, in ${locale}`, async () => {
      const note = await confirmNote(locale, false);
      expect(note).toBe(CATALOGUES[locale].screening.unsubFineMore);
      expect(note).toMatch(SERVERS);
    });
  }
});

describe("the shell hands both notes the door's own fact", () => {
  const shell = readFileSync(join(ROOT, "apps/webapp/app/shell/AppShell.tsx"), "utf8");
  /** One JSX mount, from its tag to the self-closing end after the anchor that closes its props. */
  const mountOf = (tag: string, last: string): string => {
    const at = shell.indexOf(`<${tag}`);
    expect(at, `the shell no longer mounts ${tag}`).toBeGreaterThan(-1);
    const end = shell.indexOf("/>", shell.indexOf(last, at));
    expect(end, `no end found for the ${tag} mount`).toBeGreaterThan(at);
    return shell.slice(at, end);
  };

  it("the switch and the sheet read the same fact the picture rows read", () => {
    expect(mountOf("AutoUnsubscribeRow", "setBlockAutoUnsubscribe="))
      .toContain("fromComputer={imagesFromComputer === true}");
    expect(mountOf("SenderMenu", "onClose={() => setSenderMenu(null)}"))
      .toContain("fromComputer={imagesFromComputer === true}");
    expect(mountOf("RemoteImagesRow", "setBlockRemoteImages="), "control: the picture row's own wiring")
      .toContain("fromComputer={imagesFromComputer === true}");
  });
});
