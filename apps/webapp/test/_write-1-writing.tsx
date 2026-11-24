/**
 * THE COMPOSITION UNDER WRITE, AS THE MAIL GROUND STANDS IT (share write-1 of the older tests' sorting): the
 * composer hook (`useShellCompose`) over the drafts' engine double (`_draft-shell.ts`), read into Write's port by
 * `writingOf` and drawn by Write's own parts (`@ohmail/app/write`), exactly as `packages/app/src/mail/ground/
 * WritingMount.tsx` does it: the send machine's words as the ground hands them (`_write-1-send-text.ts`), the keys'
 * registry as the frame stands it (`KeymapContext` over `useKeymapStore`), Write's rich editor of the ground's
 * entry (`write/rich-entry.ts`). `write/writing-world.tsx` is the same world
 * over today's composer words and today's KeymapProvider, which leave with the switch.
 *
 * A case may hand the send machine's state for the open reply (`replySend`), and the row a reply holds
 * (`heldReply`): both are handed where the composition reads them (`replySendState`, `heldReplyRow`), so Write's
 * own derivation (`writingOf`: the refusal, the hold) runs over them as it runs over the machine's.
 */
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  optionsFromFacts,
  type MirrorStore,
  type OhmailEngine,
} from "@ohmail/client-engine";
import type { EngineDraft, EngineMessage, EngineMutation } from "@ohmail/wire";
import { EngineContext } from "@ohmail/app-logic/engine";
import { KeymapContext, useKeymapStore } from "@ohmail/app-logic/keys";
import { SYNC_SETTLED } from "@ohmail/app-logic/session/sync-scheduler";
import type { ToastOptions } from "@ohmail/app-logic/press/report";
import type { SendState } from "@ohmail/app-logic/writing/mail-send";
import messages from "../messages/en.json";
import messagesDe from "../messages/de.json";
import { go, parseHash } from "../app/shell/routing";
import { useShellCompose, type ShellCompose } from "@ohmail/app-logic/writing/shell-compose";
import type { DraftReplyWire } from "@ohmail/app-logic/writing/draft-reply";
import { fileSize } from "../../../packages/app/src/mail/ground/writing-words.js";
import { writeBesideOf, writingOf } from "@ohmail/app-logic/writing/writing-of";
import { TextProvider } from "@ohmail/app/text";
import { WriteAbove, type WriteBeside } from "@ohmail/app/write";
import { ActionPanel } from "@ohmail/ui/mail";
import { WRITE } from "../../../packages/app/src/write/rich-entry.js";
import { COMPOSER_WORDS, GROUND_CATALOGUE } from "./_write-1-send-text.js";
import { act, engineOver, NOW, ROSTER, storeWith, type DraftShell } from "./_draft-shell.js";

const h = React.createElement;
/** The device's network fact, read at the press as the composer's mount reads it. */
const ONLINE = (): boolean => window.navigator.onLine !== false;

export interface Report {
  readonly message: string;
  readonly options: ToastOptions | undefined;
}

export interface WritingWorld {
  readonly el: HTMLElement;
  readonly engine: OhmailEngine;
  readonly store: MirrorStore;
  /** Every verb that reached the wire, in order. */
  readonly sent: EngineMutation[];
  readonly reports: Report[];
  readonly offline: DraftShell["offline"];
  readonly refuseSend: DraftShell["refuseSend"];
  readonly sendGate: DraftShell["sendGate"];
  /** The composition as it stands after the last render. */
  now(): ShellCompose;
  /** The open reply's letter: the shell's state beside the composition. */
  replyTo(): string | null;
  /** What the composition asked of its host, in order: `go <place>`, `go <place> open:null`, `show <letter>`, `open-with-reply <letter>`. */
  readonly asked: string[];
  /** The held send's answers Write reported (`<row>:<outcome>`), where a case handed `heldReply`. */
  readonly resolved: string[];
  unmount(): Promise<void>;
}

const roots: Root[] = [];
/** The account with a second address beside the first. */
const TWO = [...ROSTER, { ...ROSTER[0]!, id: "mb2", address: "me2@example.invalid", createdAt: "2026-09-02T00:00:00.000Z" }];
const KNOWN: {
  readonly signatures: Readonly<Record<string, string>>;
  readonly signaturesHtml: Readonly<Record<string, string>>;
  readonly signaturesKnown: true;
} = { signatures: {}, signaturesHtml: {}, signaturesKnown: true };
const PLAN = {
  size: "expanded", short: false, pointer: "fine", device: "desktop", pose: null, rail: "words", columns: 2, handles: true,
} as const;

/** The reading sheet's one panel, as the reader draws it: the open reply's verbs while one stands. */
function Panel({ entry }: { entry: typeof WRITE }) {
  const verbs = entry.reply.useVerbs();
  return verbs === null ? null : h(ActionPanel, { label: GROUND_CATALOGUE("write.verbs"), items: verbs });
}

function useView(): string {
  const subscribe = React.useCallback((changed: () => void) => {
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  return React.useSyncExternalStore(subscribe, () => parseHash(window.location.hash).view);
}

/** The keys' registry as the frame stands it. */
function Keys({ children }: { children: React.ReactNode }) {
  return h(KeymapContext.Provider, { value: useKeymapStore(), children });
}

function Bare({
  engine,
  scope,
  toast,
  seen,
  view,
  consent,
  pictures,
  roster,
  send,
  replySend,
  heldReply,
  sheet,
  draftWire,
  metered,
  noCredits,
  entry,
}: {
  draftWire: DraftReplyWire | undefined;
  metered: boolean;
  noCredits: boolean;
  sheet: readonly string[] | undefined;
  send: SendState | undefined;
  replySend: SendState | undefined;
  heldReply: string | undefined;
  roster: typeof ROSTER;
  pictures: WriteBeside["pictures"] | undefined;
  view: boolean;
  consent: typeof KNOWN;
  engine: OhmailEngine;
  scope: string;
  toast: (message: string, options?: ToastOptions) => void;
  seen: { current: ShellCompose | null; replyTo: string | null; asked: string[]; resolved: string[] };
  entry: typeof WRITE;
}) {
  const t = GROUND_CATALOGUE;
  const subscribe = React.useCallback((cb: () => void) => engine.subscribe(cb), [engine]);
  React.useSyncExternalStore(subscribe, () => engine.read().version());
  const reader = engine.read();
  const routeView = useView();
  const [replyTo, setReplyTo] = React.useState<string | null>(null);
  seen.replyTo = replyTo;
  const drafts = reader.list<EngineDraft>("draft");
  const none = React.useCallback(() => undefined, []);
  const goTo = React.useCallback((to: Parameters<typeof go>[0], how?: { readonly open: null }) => {
    seen.asked.push(how === undefined ? `go ${to}` : `go ${to} open:null`);
    go(to);
  }, [seen]);
  const showLetter = React.useCallback((letter: string) => void seen.asked.push(`show ${letter}`), [seen]);
  const openWithReply = React.useCallback((m: EngineMessage) => {
    seen.asked.push(`open-with-reply ${m.id}`);
    setReplyTo(m.id);
  }, [seen]);
  seen.current = useShellCompose({
    engine,
    reader,
    t,
    words: COMPOSER_WORDS,
    toast,
    route: { view: routeView as never },
    go: goTo,
    showLetter,
    openWithReply,
    consent: consent as never,
    facts: roster,
    mailboxes: roster.map((m) => ({ id: m.id, address: m.address })) as never,
    drafts,
    ownAddresses: roster.map((m) => m.address),
    fallbackMailboxId: roster[0]!.id,
    replyTo,
    setReplyTo,
    fr: null,
    setFr: none,
    setFrDone: none,
    setFrValues: none,
    presented: reader,
    mutateAndReport: async (m: EngineMutation) => (await engine.mutate(m)).status === "confirmed",
    toastWithUndo: (sentence: string) => toast(sentence),
    mailtoDraft: null,
    onMailtoDraftSeeded: undefined,
    scope,
    draftReplyWire: draftWire ?? "none",
  } as never);
  if (!view && sheet === undefined) return null;
  const options = optionsFromFacts(roster);
  /* The send machine's state for the open reply and the row it holds, handed where the composition reads them. */
  const compose: ShellCompose =
    replySend === undefined && heldReply === undefined
      ? seen.current
      : {
          ...seen.current,
          ...(replySend === undefined ? {} : { replySendState: () => replySend }),
          ...(heldReply === undefined
            ? {}
            : {
                heldReplyRow: () => heldReply,
                resolveHeldSend: (id: string, outcome: string) => void seen.resolved.push(`${id}:${outcome}`),
              }),
        } as ShellCompose;
  const derived = writingOf(compose, { engine, scope, replyTo, options, consent: consent as never, drafts, noCredits, t, presented: reader });
  const writing = send === undefined ? derived : { ...derived, composeSend: send };
  const route = { place: "write", sub: null, open: null, stage: null, words: {} } as const;
  return h(Keys, {
    children: h(WriteAbove, {
      writing: writing as never,
      beside: { ...writeBesideOf(engine, scope, "strict", metered, fileSize, ONLINE), ...(pictures ? { pictures } : {}) },
      children:
        sheet === undefined
          ? h(entry.Letter, { route, plan: PLAN, keysHere: true } as never)
          : h(React.Fragment, null, h(entry.reply.Sheet, { letters: sheet }), h(Panel, { entry })),
    }),
  });
}

/** Mount the composition over these letters and drafts, under `scope` (the account's storage scope). */
export async function mountWriting(
  o: {
    messages?: EngineMessage[];
    drafts?: EngineDraft[];
    scope?: string;
    hash?: string;
    store?: MirrorStore;
    /** Draw the new letter over the composition (`write`'s Letter). */
    view?: boolean;
    signatures?: Readonly<Record<string, string>>;
    signaturesHtml?: Readonly<Record<string, string>>;
    /** The send state the letter is handed, in place of the composition's own. */
    send?: SendState;
    /** The send machine's state for the open reply, in place of the machine's own. */
    replySend?: SendState;
    /** The row the open reply holds (a held send's row); its two answers are recorded in `resolved`. */
    heldReply?: string;
    pictures?: WriteBeside["pictures"];
    secondMailbox?: boolean;
    /** Draw the reply's sheet (the reader's slot) for these letters, in place of the new letter. */
    sheet?: readonly string[];
    draftWire?: DraftReplyWire;
    metered?: boolean;
    noCredits?: boolean;
    /** The language the screen is in (Write's words read in it; the composition's own words stay the ground's English). */
    locale?: "en" | "de";
  } = {},
): Promise<WritingWorld> {
  window.location.hash = o.hash ?? "#/compose";
  const store = o.store ?? (await storeWith(o.messages ?? [], o.drafts ?? [], new MemoryMirrorStore()));
  const sent: EngineMutation[] = [];
  const refuseSend: DraftShell["refuseSend"] = { on: false };
  const offline: DraftShell["offline"] = { on: false };
  const sendGate: DraftShell["sendGate"] = { wait: null };
  const engine = engineOver(store, sent, refuseSend, { wait: null }, [], offline, sendGate);
  const reports: Report[] = [];
  const seen: { current: ShellCompose | null; replyTo: string | null; asked: string[]; resolved: string[] } = {
    current: null, replyTo: null, asked: [], resolved: [],
  };
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  const engineValue = { engine, demo: false, serverDemo: false, sync: SYNC_SETTLED };
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: o.locale ?? "en",
        messages: o.locale === "de" ? messagesDe : messages,
        timeZone: "UTC",
        now: NOW,
        children: h(EngineContext.Provider, {
          value: engineValue as never,
          children: h(TextProvider as never, {
            locale: o.locale ?? "en",
            messages: o.locale === "de" ? messagesDe : messages,
            timeZone: "UTC",
            children: h(Bare, {
              view: o.view === true,
              engine,
              scope: o.scope ?? "acc-1",
              toast: (message, options) => void reports.push({ message, options }),
              seen,
              consent:
                o.signatures === undefined
                  ? KNOWN
                  : { ...KNOWN, signatures: o.signatures, signaturesHtml: o.signaturesHtml ?? {} },
              pictures: o.pictures,
              roster: o.secondMailbox === true ? TWO : ROSTER,
              send: o.send,
              replySend: o.replySend,
              heldReply: o.heldReply,
              sheet: o.sheet,
              draftWire: o.draftWire,
              metered: o.metered ?? true,
              noCredits: o.noCredits ?? false,
              entry: WRITE,
            }),
          }),
        }),
      }),
    );
  });
  return {
    el,
    engine,
    store,
    sent,
    reports,
    offline,
    refuseSend,
    sendGate,
    now: () => {
      if (seen.current === null) throw new Error("the composition never rendered");
      return seen.current;
    },
    replyTo: () => seen.replyTo,
    asked: seen.asked,
    resolved: seen.resolved,
    unmount: async () => {
      await act(async () => root.unmount());
      el.remove();
    },
  };
}

/** Rounds of one short macrotask each, so the composition's timers and answers can land between. */
export async function rounds(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await act(async () => new Promise((r) => setTimeout(r, 5)));
}

export async function unmountWritings(): Promise<void> {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
}
