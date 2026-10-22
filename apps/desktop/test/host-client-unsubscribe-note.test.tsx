/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { BearerManager } from "../src/host-client/bearer.js";
import { HostGate } from "../src/host-client/HostGate.js";
import { setActiveCatalog } from "../../webapp/app/shell/locale.js";
import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";

/**
 * WHERE A SCREEN-OUT'S UNSUBSCRIBE LEAVES FROM, AS THE BROWSER A DESKTOP HOST SERVES SAYS IT.
 *
 * A phone or a tablet paired with the desktop app opens the page the host door serves: `HostGate`,
 * the same shared shell, over the bearer. A screen-out made there is sent by the host's own engine
 * (`depsForHost` in `apps/sidecar/src/engine.ts` wires the unsubscribe into the door's screener and
 * posts through `nodeOneClickPost`), so the list's endpoint sees that computer's network address and
 * no server of ours stands between. The gate handed the shell no `imagesFromComputer`, so the note
 * under the Settings switch read the Cloud sentence: from our servers, the address kept out of the
 * sender's log. Rendered as `host-client/main.tsx` renders the gate, at `#/settings/screener`, in
 * both languages. The sender sheet's confirm reads the same prop in the shell
 * (`test/desktop-unsubscribe-note.test.tsx` holds that wiring), so the switch's note stands for both.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

/* The artifact aliases `app/api-client` to a refusing stub, so `apiConfigured()` is false there. */
vi.mock("../../webapp/app/api-client", async () => {
  const real = await vi.importActual<typeof import("../../webapp/app/api-client")>("../../webapp/app/api-client");
  return { ...real, apiConfigured: () => false };
});

const EMPTY_PAGE = {
  changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "MA", hasMore: false,
  serverTime: "2026-01-01T00:00:00.000Z",
};
const EMPTY_SNAPSHOT = { asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } };
/** What the host's `GET /mailboxes` answers at a provider outside the table, now that it checks signatures. */
const MAILBOXES = {
  items: [{ id: "mbx-1", address: "someone@example.com", status: "connected", lastSyncAt: null, providerConfirms: true }],
};
/** The account's switch ON: a screen-out unsubscribes, so the note is the one a person reads before it does. */
const CONSENT = {
  seedConfirmedAt: "2026-01-01T00:00:00.000Z", screeningResetAt: null, dormancyDays: 90,
  screeningBaselineAt: null, autoSuggestAt: null, blockRemoteImagesAt: null, loadTrackingPixelsAt: null,
  blockAutoUnsubscribeAt: null, folderMailboxesOff: {}, signatures: {}, themeFace: null,
};
/** `GET /account/screening`, which the same pane reads for its Ohbox words. */
const SCREENING = { ohboxPolicy: null, ohboxBar: null, defaultBar: "People who write to me themselves.", screenerAutoApply: false };

function answer(url: string): unknown {
  const path = url.split("?")[0]!;
  if (path === "/consent") return CONSENT;
  if (path.startsWith("/mailboxes")) return MAILBOXES;
  if (path === "/account/screening") return SCREENING;
  if (path.startsWith("/sync/snapshot")) return EMPTY_SNAPSHOT;
  if (path === "/auth/refresh") return { tokens: { accessToken: "a2", refreshToken: "r2" } };
  return EMPTY_PAGE;
}

const CATALOGUES = { en, de } as const;
type Locale = keyof typeof CATALOGUES;
/** What only a server can say: the request goes from ours. */
const SERVERS = /our servers|unseren Servern/i;
/** …and what a computer of the person's own says instead: which machine, and what the sender sees. */
const YOUR_COMPUTER: Record<Locale, RegExp> = { en: /\byour computer\b/i, de: /\bdeinem Computer\b/ };
const ADDRESS: Record<Locale, RegExp> = { en: /network address/i, de: /Netzwerkadresse/ };

let root: Root | null = null;
let el: HTMLElement | null = null;
/** The paths the page asked the host for, said when a pane never draws. */
let asked: string[] = [];

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  el?.remove();
  root = null;
  el = null;
  window.location.hash = "";
  setActiveCatalog("en", null);
});

/** The gate on a live pairing at `hash`, and the Settings row labelled `title` once it is drawn. */
async function paneRow(hash: string, locale: Locale, title: string): Promise<HTMLElement> {
  window.localStorage.clear();
  asked = [];
  const bearer = new BearerManager({
    storage: window.localStorage,
    fetchImpl: (async (url: string) => {
      asked.push(url.split("?")[0]!);
      return new Response(JSON.stringify(answer(url)), { status: 200, headers: { "content-type": "application/json" } });
    }) as never,
  });
  bearer.adopt({ accessToken: "a1", refreshToken: "r1" }, { fresh: true });
  if (locale === "de") setActiveCatalog("de", de as never);
  window.location.hash = hash;
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => {
    root!.render(
      <IntlProvider locale={locale} messages={CATALOGUES[locale] as never} timeZone="UTC">
        <ThemeProvider storageKey="ohmail.theme"><ToastHost><HostGate bearer={bearer} /></ToastHost></ThemeProvider>
      </IntlProvider>,
    );
  });
  const row = (): HTMLElement | undefined =>
    [...el!.querySelectorAll<HTMLElement>(".set-row")].find((r) => r.querySelector("b")?.textContent === title);
  const t0 = Date.now();
  while (!row()) {
    if (Date.now() - t0 > 15_000) {
      throw new Error(`no "${title}" row at ${hash}; asked ${JSON.stringify([...new Set(asked)])}; it read: ${(el.textContent ?? "").slice(0, 300)}`);
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
  return row()!;
}

describe("the browser a desktop host serves says where a screen-out's unsubscribe leaves from", () => {
  for (const locale of ["en", "de"] as const) {
    it(`the Settings switch's note names your computer, never our servers (${locale})`, { timeout: 30_000 }, async () => {
      const row = await paneRow("#/settings/screener", locale, CATALOGUES[locale].settings.autoUnsub.title);
      const note = row.nextElementSibling;
      expect(note?.classList.contains("set-note-inline"), "the switch's note is not under its row").toBe(true);
      const text = note!.textContent ?? "";
      expect(text, `${locale}: the paired browser says the request goes from our servers`).not.toMatch(SERVERS);
      expect(text, `${locale}: the paired browser does not name your computer`).toMatch(YOUR_COMPUTER[locale]);
      expect(text, `${locale}: the paired browser does not say what the sender sees`).toMatch(ADDRESS[locale]);
    });
  }

  it("the picture rows stay withheld here, so the fact changes only the two unsubscribe notes", { timeout: 30_000 }, async () => {
    /* The gate hands the shell no image wire and this page's `api-client` is the refusing stub, so
       `useRemoteImages` hands back nothing and the General pane draws neither picture row. Anchored
       on a row that pane always draws. */
    await paneRow("#/settings/general", "en", en.settings.textSize);
    const titles = [...el!.querySelectorAll<HTMLElement>(".set-row b")].map((b) => b.textContent);
    expect(titles).not.toContain(en.settings.images.title);
    expect(titles).not.toContain(en.settings.pixels.title);
  });
});
