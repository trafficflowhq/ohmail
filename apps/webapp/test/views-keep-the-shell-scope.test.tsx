/** @vitest-environment jsdom */
/**
 * TODAY'S VIEWS KEEP THEIR LOOKS UNDER THE SCOPE OF THE SHELL THEY ARE DRAWN IN: the search order, the after-verb
 * choice, the picture quality and a letter's original look are kept under the shell's account, whatever the storage
 * owner says while the views stand; the folder rail's opened branches and the sent-mail review put off are kept under
 * the scope the shell hands them. Drawn in no shell, a view keeps nothing: no key names nobody for want of a scope.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore, OhmailEngine, mutationEffects, type EngineMutation, type MirrorStore, type SyncChange,
} from "@ohmail/client-engine";
import type { FolderEntity } from "@ohmail/client-engine";
import { namesOwner, resetStorageOwnerForTest, setStorageOwner } from "@ohmail/app-logic/storage/storage-owner";
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
const buttonSaying = (root: ParentNode, words: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").trim() === words);
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
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

/** Today's views through the harness in a dark face; `scope` is what the host hands (absent: the storage owner). */
async function shellIn(scope?: string): Promise<HTMLElement> {
  const { AppShell } = await import("./_todays-shell.js");
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
          children: React.createElement(AppShell as never, {
            ...(scope === undefined ? {} : { scope }), demo: false, engine, consentTransport,
            mailboxFacts: async () => [],
          } as never),
        }),
      }),
    } as never));
  });
  await settle();
  return container;
}

/** The four looks the views keep, chosen through the shell; answers whose keys hold each choice. */
async function chooseTheLooks(el: HTMLElement): Promise<Record<string, { a: number; b: number; none: number }>> {
  await go("#/search");
  await waitFor(() => el.querySelector(".view-search input") != null, "the search field");
  await typeInto(el.querySelector<HTMLInputElement>(".view-search input")!, "heron");
  await waitFor(() => el.querySelector("#search-sort") != null, "the order");
  const order = el.querySelector<HTMLSelectElement>("#search-sort")!;
  await act(async () => {
    order.value = "date_asc";
    order.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await go("#/settings");
  await waitFor(() => el.querySelector(".afterverb-seg") != null, "the after-verb row");
  await press(buttonSaying(el.querySelector(".afterverb-seg")!, settings.afterVerbChoice.close!), "Close");
  await press(buttonSaying(el.querySelector(".quality-seg")!, settings.imageQualityLevel.low!), "Low");
  await go("#/ohbox/m/m1");
  const { COPY } = await import("../app/letter-body/MessageBody.js");
  await waitFor(() => buttonSaying(el, COPY.darkOriginal) != null, "the original look's control", 5000);
  await press(buttonSaying(el, COPY.darkOriginal), "Original");
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

describe("the rail and the review keep theirs under the scope the shell hands them", () => {
  let root: Root | null = null;
  afterEach(async () => {
    if (root) await act(async () => { root!.unmount(); });
    root = null;
  });
  const mountIn = async (node: React.ReactElement): Promise<HTMLElement> => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => {
      root!.render(React.createElement(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW, children: node,
      } as never));
    });
    return el;
  };

  it("a folder branch opened under A while the storage owner names B is A's", async () => {
    setStorageOwner(B);
    const { FoldersRailGroup } = await import("../app/shell/FoldersRailGroup");
    const folder = (name: string): FolderEntity => ({ id: `f-mb1-${name}`, name, mailboxId: "mb1", mailbox: "a@x.example" });
    const el = await mountIn(React.createElement(FoldersRailGroup, {
      scope: A, folders: [folder("Projects"), folder("Projects/Acme")], unread: new Map(), onNavigate: () => {},
    } as never));
    await press(el.querySelector("button.ftw"), "the branch's disclosure");
    expect(whose(keysHolding("mb1|Projects"))).toEqual(UNDER_A);
  });

  it("the sent-mail review put off under A while the storage owner names B is A's", async () => {
    setStorageOwner(B);
    const { useSeedOffer } = await import("../app/shell/seed-offer");
    let later: (() => void) | null = null;
    function Probe(): null {
      const offer = useSeedOffer({
        scope: A, demo: false, known: true, supported: true, seedConfirmedAt: null, hasMailbox: true,
      } as never);
      later = offer.later;
      return null;
    }
    await mountIn(React.createElement(Probe));
    await act(async () => { later!(); });
    expect(whose(keysHolding("1", true).filter((k) => k.startsWith("ohmail.ui.seed.notNow.")))).toEqual(UNDER_A);
  });
});

describe("drawn in no shell, a view keeps nothing", () => {
  let root: Root | null = null;
  afterEach(async () => {
    if (root) await act(async () => { root!.unmount(); });
    root = null;
  });
  const bare = async (node: React.ReactElement): Promise<HTMLElement> => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    const { ThemeProvider } = await import("@ohmail/ui");
    const { KeymapProvider } = await import("@ohmail/app/keys");
    await act(async () => {
      root!.render(React.createElement(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: React.createElement(ThemeProvider, {
          defaultPreference: "dark", storageKey: null,
          children: React.createElement(KeymapProvider, null, node),
        }),
      } as never));
    });
    await settle(4);
    return el;
  };
  const stored = (): string[] => Object.keys(window.localStorage).sort();

  it("the search order chosen on a search drawn alone is kept for the view and stored nowhere", async () => {
    const { SearchView } = await import("../app/views/SearchView");
    const engine = await engineWithLetter();
    const el = await bare(React.createElement(SearchView, {
      engine, version: 1, now: NOW, query: "heron", onQuery: () => {}, onOpen: () => {},
    } as never));
    const before = stored();
    const order = el.querySelector<HTMLSelectElement>("#search-sort")!;
    await act(async () => {
      order.value = "date_asc";
      order.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect({ shown: order.value, stored: stored() }).toEqual({ shown: "date_asc", stored: before });
  });

  it("a letter shown in its original look alone keeps the choice for itself and stores nothing", async () => {
    const { COPY, MessageBody } = await import("../app/letter-body/MessageBody.js");
    const el = await bare(React.createElement(MessageBody, { text: "Newsletter", html: LIGHT, messageId: "m-1" } as never));
    const before = stored();
    await press(buttonSaying(el, COPY.darkOriginal), "Original");
    expect({ shown: buttonSaying(el, COPY.darkAdapt) != null, stored: stored() }).toEqual({ shown: true, stored: before });
  });

  it("the attach dial moved alone shows the move and stores nothing", async () => {
    const { ComposeAttach } = await import("../app/components/ComposeAttach");
    const zone = { current: document.createElement("div") };
    const el = await bare(React.createElement(ComposeAttach, { attachments: [], onChange: () => {}, dropZone: zone } as never));
    const before = stored();
    const dial = el.querySelector<HTMLSelectElement>(".compose-attach-level select")!;
    await act(async () => {
      dial.value = "low";
      dial.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect({ shown: dial.value, stored: stored() }).toEqual({ shown: "low", stored: before });
  });

  it("the picture quality and the after-verb rows pressed alone store nothing", async () => {
    const { ImageQualityRow } = await import("../app/shell/ImageQualityRow");
    const { AfterVerbRow } = await import("../app/shell/AfterVerbRow");
    const el = await bare(React.createElement(React.Fragment, null,
      React.createElement(ImageQualityRow), React.createElement(AfterVerbRow)));
    const before = stored();
    await press(buttonSaying(el.querySelector(".quality-seg")!, settings.imageQualityLevel.low!), "Low");
    await press(buttonSaying(el.querySelector(".afterverb-seg")!, settings.afterVerbChoice.close!), "Close");
    expect(stored()).toEqual(before);
  });
});

describe("the shell's mount of its scope is no second way to read it", () => {
  it("a part that holds the provider reads nothing through it, while the scope's own hook reads the shell's", async () => {
    const { TodaysScopeProvider, useTodaysScope } = await import("../app/shell/todays-scope");
    const read: { throughTheProvider: unknown; throughTheHook: unknown } = { throughTheProvider: "not drawn", throughTheHook: "not drawn" };
    function Outsider(): null {
      /* Every file may import the provider; were it the context itself, this would be the shell's scope. */
      read.throughTheProvider = React.useContext(TodaysScopeProvider as unknown as React.Context<string | null>);
      return null;
    }
    function Reader(): null {
      read.throughTheHook = useTodaysScope();
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(React.createElement(TodaysScopeProvider, { value: "acc-A" },
        React.createElement(Outsider), React.createElement(Reader)));
    });
    await act(async () => { root.unmount(); });
    expect(read).toEqual({ throughTheProvider: undefined, throughTheHook: "acc-A" });
  });
});
