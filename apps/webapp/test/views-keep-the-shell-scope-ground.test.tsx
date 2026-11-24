/** @vitest-environment jsdom */
/**
 * THE GROUND AND THE FIRST RUN KEEP THEIRS UNDER THE SCOPE THEIR HOST HANDS: the mail state asks the access window for
 * the scope its host handed (over the new shell's door), and the sent-mail review put off is kept under the scope it
 * is handed. Moved word for word from `views-keep-the-shell-scope.test.tsx`, whose other cases stand over today's
 * views until their places' mounts; the review is read off the first run's own module.
 */
import type { EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore, OhmailEngine, mutationEffects, type MirrorStore, type SyncChange,
} from "@ohmail/client-engine";
import { forgetOpenVerdict, markOpenVerdict } from "@ohmail/app-logic/session/access-window";
import { namesOwner, resetStorageOwnerForTest, setStorageOwner } from "@ohmail/app-logic/storage/storage-owner";
import messages from "../messages/en.json";
import { act, consentTransport, msg, NOW, S, setup, teardown, waitFor } from "./_view-shell.js";

const A = "acc-A1";
const B = "acc-B2";
const LIGHT = '<body><table bgcolor="#ffffff" width="600"><tr><td>Newsletter</td></tr></table></body>';
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
 * The new shell's door in a dark face; `scope` is what the host hands (absent: the storage owner),
 * `reads` what else its host answers.
 */
async function shellIn(scope?: string, reads: Record<string, unknown> = {}): Promise<HTMLElement> {
  const { MailShell: AppShell } = await import("./_mail-shell.js");
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
            mailboxFacts: async () => [], ...reads,
          } as never),
        }),
      }),
    } as never));
  });
  await settle();
  return container;
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

describe("the mail state asks the access window for the scope its host handed", () => {
  const behind = (messages as unknown as { frame: { connection: { behind: { title: string; asOf: string } } } })
    .frame.connection.behind;
  /* The catalogue's own words around the time of the dated sentence. */
  const [before, after] = behind.asOf.split(/\{[^}]*\}/) as [string, string];
  /* The copy on screen last finished a sync three days ago, as the host's copy-age read says it. */
  const asOf = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const staleCopy = { mirrorFreshness: async () => ({ state: "stale" as const, asOf }) };
  /** What the frame's notices say of a copy that is catching up: with its date, or without. */
  const catchingUp = (el: HTMLElement): string[] =>
    [...el.querySelectorAll<HTMLElement>('[role="status"]')].map((n) => (n.textContent ?? "").trim())
      .filter((said) => said.includes(behind.title) || (said.includes(before) && said.includes(after)));

  /* The service said open for B over a stored refusal a moment ago, and the storage owner has come to name B. */
  beforeEach(() => {
    setStorageOwner(B);
    markOpenVerdict(B, Date.now() - 20_000, true);
  });
  afterEach(() => { forgetOpenVerdict(); });

  it("another account's reopening withholds no date of the copy this shell shows", async () => {
    const el = await shellIn(A, staleCopy);
    await waitFor(() => catchingUp(el).length > 0, "the catching-up notice", 5000);
    expect(catchingUp(el).join(" | "), "B's reopening withheld the date of A's copy").toContain(before);
  }, 30_000);

  it("CONTROL: the reopening of the account its host named withholds the date from before it", async () => {
    const el = await shellIn(B, staleCopy);
    await waitFor(() => catchingUp(el).length > 0, "the catching-up notice", 5000);
    expect(catchingUp(el).join(" | ")).not.toContain(before);
    expect(catchingUp(el).join(" | ")).toContain(behind.title);
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

  it("the sent-mail review put off under A while the storage owner names B is A's", async () => {
    setStorageOwner(B);
    const { useSeedOffer } = await import("@ohmail/app-logic/mailboxes/first-run/seed-offer");
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
