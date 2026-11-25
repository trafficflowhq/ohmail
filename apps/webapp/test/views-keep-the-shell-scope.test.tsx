/** @vitest-environment jsdom */
/**
 * TODAY'S VIEWS KEEP THEIR LOOKS UNDER THE SCOPE OF THE SHELL THEY ARE DRAWN IN: the search order, the after-verb
 * choice, the picture quality and a letter's original look are kept under the shell's account, whatever the storage
 * owner says while the views stand; the folder rail's opened branches and the sent-mail review put off are kept under
 * the scope the shell hands them. Drawn in no shell, a view keeps nothing: no key names nobody for want of a scope.
 */
import type { EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore, OhmailEngine, mutationEffects, type MirrorStore, type SyncChange,
} from "@ohmail/client-engine";
import { namesOwner, resetStorageOwnerForTest, setStorageOwner } from "@ohmail/app-logic/storage/storage-owner";
import { fireEvent, getByRole, queryByRole, within } from "@testing-library/react";
import { EngineContext } from "@ohmail/app-logic/engine";
import { ConsentContext, useConsentState } from "@ohmail/app-logic/consent";
import { KeymapContext, useKeymapStore } from "@ohmail/app-logic/keys/keymap";
import { useSearchList } from "@ohmail/app-logic/search";
import { NONE } from "@ohmail/app/host";
import { TextProvider } from "@ohmail/app/text";
import { FrameContext, type FrameInner } from "../../../packages/app/src/frame/commands.js";
import { SearchSort } from "../../../packages/app/src/search/SearchSort.js";
import { fakeHost, NO_ENGINE } from "../../../packages/app/test/support/fake-host.js";
import { WebGeneralPane } from "../app/(product)/mailbox/WebGeneralPane.js";
import { MAIL_BODY_COPY } from "@ohmail/letter-body";
import { WEB_PANE_PARTS } from "../app/(product)/mailbox/pane-parts.js";
import messages from "../messages/en.json";
import { act, consentTransport, msg, NOW, S, setup, teardown, waitFor } from "./_view-shell.js";

const A = "acc-A1";
const B = "acc-B2";
const LIGHT = '<body><table bgcolor="#ffffff" width="600"><tr><td>Newsletter</td></tr></table></body>';
const settings = messages.settings as unknown as {
  afterVerbChoice: Record<string, string>; imageQualityLevel: Record<string, string>;
};

/** Every stored key whose value is, or holds, this. */
const keysHolding = (value: string, whole = false): string[] =>
  Object.keys(window.localStorage).filter((k) => {
    const v = window.localStorage.getItem(k) ?? "";
    return whole ? v === value : v.includes(value);
  });
/** Which accounts the keys holding a value name. */
const whose = (keys: string[]): { a: number; b: number; none: number } => ({
  a: keys.filter((k) => namesOwner(k, A, true)).length,
  b: keys.filter((k) => namesOwner(k, B, true)).length,
  none: keys.filter((k) => !namesOwner(k, A, true) && !namesOwner(k, B, true)).length,
});
const settle = async (rounds = 10): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
};
const go = async (hash: string): Promise<void> => {
  window.location.hash = hash;
  await settle();
};
const press = async (el: Element | null | undefined, what: string): Promise<void> => {
  if (!el) throw new Error(`no ${what}`);
  await act(async () => { (el as HTMLElement).click(); });
  await settle(4);
};
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(() => { fireEvent.change(input, { target: { value } }); });
}

/** A mirror with one light HTML letter, and an engine whose body door answers it. */
async function engineWithLetter(): Promise<OhmailEngine> {
  const s: MirrorStore = new MemoryMirrorStore();
  await s.load();
  await s.applyChanges([
    { type: "message", op: "create", id: "m1", seq: 1, updatedAt: NOW.toISOString(), entity: msg("m1", { subject: "Heron notes" }) },
  ] as SyncChange[]);
  let seq = 1;
  return new OhmailEngine({
    store: s,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: s.getCursor(), hasMore: false,
        serverTime: NOW.toISOString(),
      }),
      mutate: async (m: EngineMutation) => {
        const changes = mutationEffects(s, m, { now: () => NOW, uuid: () => `id-${++seq}` }).map((e) => ({
          type: e.type, op: e.entity === null ? "delete" : e.move ? "move" : "update",
          id: e.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}),
        })) as SyncChange[];
        await s.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      fetchBody: async () => ({
        text: "Newsletter", html: LIGHT, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  } as never);
}

/**
 * Today's views through the harness in a dark face; `scope` is what the host hands (absent: the storage owner),
 * `reads` what else its host answers.
 */
async function shellIn(scope?: string, reads: Record<string, unknown> = {}): Promise<HTMLElement> {
  const { MailShell } = await import("./_mail-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const engine = await engineWithLetter();
  S.engine = engine;
  window.location.hash = "#/ohbox";
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  S.roots.push(root);
  await act(async () => {
    root.render(React.createElement(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: React.createElement(ThemeProvider, {
        defaultPreference: "dark", storageKey: null,
        children: React.createElement(ToastHost, {
          children: React.createElement(MailShell, {
            ...(scope === undefined ? {} : { scope }), demo: false, engine, consentTransport,
            mailboxFacts: async () => [], general: WEB_PANE_PARTS.general, ...reads,
          } as never),
        }),
      }),
    } as never));
  });
  await settle();
  return container;
}

async function chooseOldest(el: HTMLElement): Promise<void> {
  await press(getByRole(el, "button", { name: /^Sorted by/ }), "Sort by");
  const sort = within(getByRole(el, "menu", { name: messages.search.sortLabel }));
  await press(sort.getByRole("menuitemradio", { name: messages.search.sort_date_asc }), "Oldest first");
}

async function chooseGeneralLooks(el: HTMLElement): Promise<void> {
  await press(getByRole(el, "button", { name: settings.afterVerbChoice.close }), "Close");
  await press(getByRole(el, "button", { name: settings.imageQualityLevel.low }), "Low");
}

/** The four looks the views keep, chosen through the shell; answers whose keys hold each choice. */
async function chooseTheLooks(el: HTMLElement): Promise<Record<string, { a: number; b: number; none: number }>> {
  await go("#/search");
  await waitFor(() => queryByRole(el, "textbox", { name: messages.search.aria }) !== null, "the search field");
  await typeInto(getByRole<HTMLInputElement>(el, "textbox", { name: messages.search.aria }), "heron");
  await chooseOldest(el);
  await go("#/settings/general");
  await waitFor(() => queryByRole(el, "button", { name: settings.afterVerbChoice.close }) !== null, "the after-verb row");
  await chooseGeneralLooks(el);
  await go("#/ohbox/m/m1");
  await waitFor(() => queryByRole(el, "button", { name: MAIL_BODY_COPY.darkOriginal }) !== null, "the original look's control", 5000);
  await press(getByRole(el, "button", { name: MAIL_BODY_COPY.darkOriginal }), "Original");
  return {
    order: whose(keysHolding("date_asc", true)),
    afterVerb: whose(keysHolding("close", true)),
    pictureQuality: whose(keysHolding("low", true)),
    originalLook: whose(keysHolding('"m1"').filter((k) => k.startsWith("ohmail.ui.mail.original."))),
  };
}

const UNDER_A = { a: 1, b: 0, none: 0 };

beforeEach(() => {
  setup();
  resetStorageOwnerForTest();
});
afterEach(async () => {
  await teardown();
  resetStorageOwnerForTest();
  window.localStorage.clear();
});

describe("today's views keep their looks under the shell's scope", () => {
  it("chosen after the storage owner moved, each look stands under the shell's account and none under the other", async () => {
    setStorageOwner(A);
    const el = await shellIn();
    /* Another tab signs in as B while A's views stand. */
    setStorageOwner(B);
    expect(await chooseTheLooks(el)).toEqual({
      order: UNDER_A, afterVerb: UNDER_A, pictureQuality: UNDER_A, originalLook: UNDER_A,
    });
  }, 30_000);

  it("handed A by their host while the storage owner names B, each look stands under A and none under B", async () => {
    setStorageOwner(B);
    const el = await shellIn(A);
    expect(await chooseTheLooks(el)).toEqual({
      order: UNDER_A, afterVerb: UNDER_A, pictureQuality: UNDER_A, originalLook: UNDER_A,
    });
  }, 30_000);
});

// "the mail state asks the access window for the scope its host handed" (two cases over the new shell's door) moved
// word for word to `views-keep-the-shell-scope-ground.test.tsx`.

// The Folder scope case now mounts the registered rail. The sent-mail review remains in
// views-keep-the-shell-scope-ground.test.tsx over the first-run surface.

describe("drawn in no shell, a view keeps nothing", () => {
  const bare = async (node: React.ReactElement): Promise<HTMLElement> => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root: Root = createRoot(el);
    S.roots.push(root);
    const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
    await act(() => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC" now={NOW}>
          <ThemeProvider defaultPreference="dark" storageKey={null}>
            <TextProvider locale="en" messages={messages} timeZone="UTC"><ToastHost>{node}</ToastHost></TextProvider>
          </ThemeProvider>
        </NextIntlClientProvider>,
      );
    });
    await settle(4);
    return el;
  };
  const stored = (): string[] => Object.keys(window.localStorage).sort();

  it("the search order chosen on a search drawn alone is kept for the view and stored nowhere", async () => {
    const engine = await engineWithLetter();
    function Sort() {
      const model = useSearchList({
        engine, scope: false, query: "heron", onQuery: () => {}, onOpen: () => {}, onExit: NONE,
        boxRef: React.useRef(null), scrollerRef: React.useRef(null), t: (key) => key, searchBy: "words",
      });
      return <SearchSort model={model} />;
    }
    function StandaloneSearch() {
      return <KeymapContext.Provider value={useKeymapStore()}><Sort /></KeymapContext.Provider>;
    }
    const el = await bare(<StandaloneSearch />);
    const before = stored();
    await chooseOldest(el);
    expect({
      shown: queryByRole(el, "button", { name: "Sorted by Oldest first" }) !== null,
      stored: stored(),
    }).toEqual({ shown: true, stored: before });
  });

  // "a letter shown in its original look alone…" moved to `views-keep-the-shell-scope-alone.test.tsx`, over the body
  // the new reader mounts. "the attach dial moved alone…" (today's ComposeAttach) left with that part: Write's quality
  // is drawn only inside the frame, under its scope; a part drawn under no scope names no key, the frame's rule
  // (`packages/app/test/frame/scope.test.tsx`, "is none where no scope stands above…").

  it("the picture quality and the after-verb rows pressed alone store nothing", async () => {
    const { host } = fakeHost({ engine: NO_ENGINE, scope: null, service: "self" });
    const frame = { api: { host } } as FrameInner;
    function StandaloneGeneral() {
      const consent = useConsentState(false, null, NONE);
      return (
        <FrameContext.Provider value={frame}>
          <EngineContext.Provider value={{
            engine: NO_ENGINE, demo: false, serverDemo: false,
            sync: { bootstrapping: false, failures: 0, terminal: false, refused: false, ownerLost: false },
          }}>
            <ConsentContext.Provider value={consent}><WebGeneralPane /></ConsentContext.Provider>
          </EngineContext.Provider>
        </FrameContext.Provider>
      );
    }
    const el = await bare(<StandaloneGeneral />);
    const before = stored();
    await chooseGeneralLooks(el);
    expect(getByRole(el, "button", { name: settings.afterVerbChoice.close, pressed: true })).toBeTruthy();
    expect(getByRole(el, "button", { name: settings.imageQualityLevel.low, pressed: true })).toBeTruthy();
    expect(stored()).toEqual(before);
  });
});

// "the shell's mount of its scope is no second way to read it" read today's `todays-scope`, which leaves with today's
// shell: a part reads the frame's scope through `useScopeHere()` (`packages/app/test/frame/scope.test.tsx`).
