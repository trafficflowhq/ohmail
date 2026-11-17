/**
 * THE COMPOSITION, BARE: today's composer hook (`useShellCompose`) mounted alone over the drafts' engine double
 * (`_draft-shell.ts`), under the catalogue it reads, with no view. A case presses its doors and reads what reached
 * the wire, the stored buffer and the reports. The Reply Run's setters are no-ops: no run is open here.
 */
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import {
  MemoryMirrorStore,
  optionsFromFacts,
  type EngineDraft,
  type EngineMessage,
  type EngineMutation,
  type MirrorStore,
  type OhmailEngine,
} from "@ohmail/client-engine";
import { EngineContext } from "@ohmail/app-logic/engine";
import { SYNC_SETTLED } from "@ohmail/app-logic/session/sync-scheduler";
import type { ToastOptions } from "@ohmail/app-logic/press/report";
import type { SendState } from "@ohmail/app-logic/writing/mail-send";
import messages from "../../messages/en.json";
import { go, parseHash } from "../../app/shell/routing";
import { useShellCompose, type ShellCompose } from "@ohmail/app-logic/writing/shell-compose";
import type { DraftReplyWire } from "@ohmail/app-logic/writing/draft-reply";
import { TODAYS_COMPOSER_WORDS } from "../../app/shell/mail-send-text";
import { todaysWriteBeside, writingOf } from "../../app/shell/todays-write";
import { TextProvider } from "@ohmail/app/text";
import { WriteAbove, writeEntry, type WriteBeside } from "@ohmail/app/write";
import { KeymapProvider } from "@ohmail/app/keys";
import { ActionPanel } from "@ohmail/ui/mail";
import { plainEditor } from "@ohmail/app/write/plain";
import { act, engineOver, NOW, ROSTER, storeWith, type DraftShell } from "../_draft-shell.js";

const h = React.createElement;

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
  unmount(): Promise<void>;
}

const roots: Root[] = [];
/** The account with a second address beside the first. */
const TWO = [...ROSTER, { ...ROSTER[0]!, id: "mb2", address: "me2@example.invalid", createdAt: "2026-09-02T00:00:00.000Z" }];
const ENTRY = writeEntry({ editor: plainEditor });
const KNOWN: {
  readonly signatures: Readonly<Record<string, string>>;
  readonly signaturesHtml: Readonly<Record<string, string>>;
  readonly signaturesKnown: true;
} = { signatures: {}, signaturesHtml: {}, signaturesKnown: true };
const PLAN = {
  size: "expanded", short: false, pointer: "fine", device: "desktop", pose: null, rail: "words", columns: 2, handles: true,
} as const;

/** The reading sheet's one panel, as the reader draws it: the open reply's verbs while one stands. */
function Panel() {
  const t = useTranslations();
  const verbs = ENTRY.reply.useVerbs();
  return verbs === null ? null : h(ActionPanel, { label: t("write.verbs"), items: verbs });
}

function useView(): string {
  const subscribe = React.useCallback((changed: () => void) => {
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  return React.useSyncExternalStore(subscribe, () => parseHash(window.location.hash).view);
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
  sheet,
  draftWire,
  metered,
  noCredits,
}: {
  draftWire: DraftReplyWire | undefined;
  metered: boolean;
  noCredits: boolean;
  sheet: readonly string[] | undefined;
  send: SendState | undefined;
  roster: typeof ROSTER;
  pictures: WriteBeside["pictures"] | undefined;
  view: boolean;
  consent: typeof KNOWN;
  engine: OhmailEngine;
  scope: string;
  toast: (message: string, options?: ToastOptions) => void;
  seen: { current: ShellCompose | null; replyTo: string | null };
}) {
  const t = useTranslations();
  const subscribe = React.useCallback((cb: () => void) => engine.subscribe(cb), [engine]);
  React.useSyncExternalStore(subscribe, () => engine.read().version());
  const reader = engine.read();
  const routeView = useView();
  const [replyTo, setReplyTo] = React.useState<string | null>(null);
  seen.replyTo = replyTo;
  const drafts = reader.list<EngineDraft>("draft");
  const none = React.useCallback(() => undefined, []);
  seen.current = useShellCompose({
    engine,
    reader,
    t,
    words: TODAYS_COMPOSER_WORDS,
    toast,
    route: { view: routeView as never },
    go,
    consent: consent as never,
    facts: roster,
    mailboxes: roster.map((m) => ({ id: m.id, address: m.address })) as never,
    drafts,
    ownAddresses: roster.map((m) => m.address),
    fallbackMailboxId: roster[0]!.id,
    replyTo,
    setReplyTo,
    setReaderFor: none,
    fr: null,
    setFr: none,
    setFrDone: none,
    setFrValues: none,
    setOhboxSel: none,
    presented: reader,
    mutateAndReport: async (m) => (await engine.mutate(m)).status === "confirmed",
    toastWithUndo: (sentence) => toast(sentence),
    mailtoDraft: null,
    onMailtoDraftSeeded: undefined,
    scope,
    /* A case that names no wire mounts a host with no drafter: the composer then answers no control. */
    draftReplyWire: draftWire ?? "none",
  });
  // The shell's open of a reply draft's letter, as it stands when the letter is on this view: its reply opens.
  seen.current.openMessageRef.current = (m, o) => {
    if (o?.reply) setReplyTo(m.id);
  };
  if (!view && sheet === undefined) return null;
  const options = optionsFromFacts(roster);
  const derived = writingOf(seen.current, { engine, scope, replyTo, options, consent: consent as never, drafts, noCredits, t });
  const writing = send === undefined ? derived : { ...derived, composeSend: send };
  const route = { place: "write", sub: null, open: null, stage: null, words: {} } as const;
  return h(KeymapProvider, {
    children: h(WriteAbove, {
      writing,
      beside: { ...todaysWriteBeside(engine, scope, undefined, metered), ...(pictures ? { pictures } : {}) },
      children:
        sheet === undefined
          ? h(ENTRY.Letter, { route, plan: PLAN, keysHere: true })
          : h(React.Fragment, null, h(ENTRY.reply.Sheet, { letters: sheet }), h(Panel)),
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
    /** Draw the new letter over the composition (`write`'s Letter, the plain editor). */
    view?: boolean;
    /** The account's stored signatures by mailbox (the consent row, read). */
    signatures?: Readonly<Record<string, string>>;
    /** Their formatted halves by mailbox, beside `signatures`. */
    signaturesHtml?: Readonly<Record<string, string>>;
    /** The send state the letter is handed, in place of the composition's own. */
    send?: SendState;
    /** How pictures go, in place of the shell's (a case's own encoder). */
    pictures?: WriteBeside["pictures"];
    /** A second address on the account. */
    secondMailbox?: boolean;
    /** Draw the reply's sheet (the reader's slot) for these letters, in place of the new letter. */
    sheet?: readonly string[];
    /** The drafter's wire, in place of the hosted one. */
    draftWire?: DraftReplyWire;
    /** Drafting is charged (a price is said); default true. */
    metered?: boolean;
    /** The account's balance was last refused as empty; default false. */
    noCredits?: boolean;
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
  const seen: { current: ShellCompose | null; replyTo: string | null } = { current: null, replyTo: null };
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  const engineValue = { engine, demo: false, serverDemo: false, sync: SYNC_SETTLED };
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: NOW,
        children: h(EngineContext.Provider, {
          value: engineValue as never,
          children: h(TextProvider as never, {
            locale: "en",
            messages,
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
            sheet: o.sheet,
            draftWire: o.draftWire,
            metered: o.metered ?? true,
            noCredits: o.noCredits ?? false,
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
