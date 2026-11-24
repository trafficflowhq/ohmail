import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Answered, MailboxId } from "@ohmail/app-logic/mailboxes/connect/types";
import type { MailboxRow } from "@ohmail/app-logic/mailboxes/pane/types";
import { NONE, type ConnectWire, type MailboxesWire, type None } from "../../../src/host/index.js";
import type { FactorSlot } from "../../../src/mailboxes/connect/contract.js";
import { MailboxesPane, type MailboxesPaneProps } from "../../../src/mailboxes/index.js";
import { TextProvider } from "../../../src/text/index.js";
import account from "../../../messages/account.en.json" with { type: "json" };
import doors from "../../../messages/doors.en.json" with { type: "json" };
import frame from "../../../messages/frame.en.json" with { type: "json" };
import mailboxes from "../../../messages/mailboxes.en.json" with { type: "json" };
import shared from "../../../messages/shared.en.json" with { type: "json" };
import { factorButtons, id, refusal } from "../connect/support.js";

export { factorButtons, id, refusal };

/** The words the pane reads, from the places that hold them. */
export const WORDS = { ...account, ...doors, ...frame, ...mailboxes, ...shared };
export const M = mailboxes.mailboxes;
export const D = account.devices;

export const NOW = Date.parse("2026-11-16T09:00:00.000Z");
export const A = "anna@lichtgrat.example";
export const B = "post@berghof.example";

/** One mailbox of the account, healthy unless the case says otherwise. */
export function row(raw: string, address: string, over: Partial<MailboxRow> = {}): MailboxRow {
  return {
    id: id(raw),
    address,
    provider: "generic",
    status: "connected",
    errorCode: null,
    disabledReason: null,
    syncBlockedReason: null,
    syncBlockedSince: null,
    lastSyncAt: "2026-11-16T08:58:00.000Z",
    createdAt: "2026-11-01T08:00:00.000Z",
    organizerRole: "organizer",
    organizeConsentedAt: "2026-11-01T08:05:00.000Z",
    authKind: "password",
    ...over,
  };
}

export const ok = <T,>(value: T): Answered<T> => ({ ok: true, value });
export const WINDOW_CLOSED: Answered<never> = { ok: false, refusal: refusal("step_up_required", {}, 403) };

type Later<T> = T | Promise<T>;
export interface PaneScript {
  list?: Later<Answered<readonly MailboxRow[]>>[];
  allowance?: Later<
    Answered<{
      emailVerified: boolean | null;
      access: { canAddMailbox: boolean; mailboxes: number | null } | null;
    }>
  >[];
  resync?: Later<Answered<null>>[];
  remove?: Later<Answered<null>>[];
  erase?: Later<
    Answered<{
      erasing: boolean;
      mailboxId: MailboxId;
      messages: number;
      drafts: number;
      draftsUnanchored: number;
    }>
  >[];
  organizer?: Later<Answered<{ state: "none" | "held" | "stopped"; holders: never[]; unreadable: number }>>[];
  organizeHere?: Later<Answered<{ outcome: "authorized" | "already_organizing" | "disconnected" }>>[];
  stopOrganizing?: Later<Answered<{ outcome: "requested" | "not_organizing" | "disconnected" }>>[];
  dismiss?: Later<Answered<MailboxRow>>[];
  selfCheck?: Later<Answered<unknown>>[];
  /** Members this shell cannot offer. */
  none?: readonly (
    | "allowance"
    | "remove"
    | "erase"
    | "organizer"
    | "organizeHere"
    | "stopOrganizing"
    | "dismissForwardingNotice"
    | "selfCheck"
    | "filings"
    | "out"
  )[];
}

export interface PaneCall {
  readonly verb: string;
  readonly args: readonly unknown[];
}

/** A pane wire that answers as the case says and records every call. An unscripted call never answers. */
export function fakePane(script: PaneScript = {}) {
  const calls: PaneCall[] = [];
  const next = <T,>(queue: Later<T>[] | undefined): Promise<T> => {
    const answer = queue?.shift();
    return answer === undefined ? new Promise<T>(() => {}) : Promise.resolve(answer);
  };
  const note = (verb: string, ...args: unknown[]): void => void calls.push({ verb, args });
  const withheld = new Set(script.none ?? []);
  const member = <F,>(name: NonNullable<PaneScript["none"]>[number], f: F): F | None =>
    withheld.has(name) ? NONE : f;
  const outs: number[] = [];
  const wire: MailboxesWire = {
    list: (o) => (note("list", o), next(script.list)),
    allowance: member("allowance", () => (note("allowance"), next(script.allowance))),
    resync: (mailboxId) => (note("resync", mailboxId), next(script.resync)),
    remove: member("remove", (mailboxId: MailboxId) => (note("remove", mailboxId), next(script.remove))),
    erase: member(
      "erase",
      (mailboxId: MailboxId, typed: string) => (note("erase", mailboxId, typed), next(script.erase)),
    ),
    organizer: member(
      "organizer",
      (mailboxId: MailboxId) => (note("organizer", mailboxId), next(script.organizer)),
    ),
    organizeHere: member(
      "organizeHere",
      (mailboxId: MailboxId, o: { password?: unknown }) => (
        note("organizeHere", mailboxId, o),
        next(script.organizeHere)
      ),
    ),
    stopOrganizing: member(
      "stopOrganizing",
      (mailboxId: MailboxId) => (note("stopOrganizing", mailboxId), next(script.stopOrganizing)),
    ),
    dismissForwardingNotice: member(
      "dismissForwardingNotice",
      (mailboxId: MailboxId) => (note("dismiss", mailboxId), next(script.dismiss)),
    ),
    selfCheck: member(
      "selfCheck",
      (mailboxId: MailboxId) => (note("selfCheck", mailboxId), next(script.selfCheck)),
    ),
    filings: member("filings", {
      read: (mailboxId: MailboxId) => (note("filings.read", mailboxId), next<Answered<unknown>>(undefined)),
      retry: (mailboxId: MailboxId, folder: string) => (
        note("filings.retry", mailboxId, folder),
        next<Answered<{ reset: number; skipped: number }>>(undefined)
      ),
      leave: (mailboxId: MailboxId, folder: string, through: string) => (
        note("filings.leave", mailboxId, folder, through),
        next<Answered<{ settled: number; remaining: number }>>(undefined)
      ),
    }),
    out: member("out", () => void outs.push(1)),
  };
  return {
    wire,
    calls,
    outs,
    of: (verb: string) => calls.filter((c) => c.verb === verb),
    /** Every call that writes, in order. */
    writes: () =>
      calls.filter((c) => !["list", "allowance", "organizer", "filings.read", "selfCheck"].includes(c.verb)),
  };
}

export interface PaneDrawn extends RenderResult {
  readonly went: ("add" | "again")[];
  readonly drained: string[];
  redraw(over?: Partial<MailboxesPaneProps>): void;
}

/** The pane over a fake wire, with every slot a case does not name answered as a shell that has none. */
export function drawPane(
  wire: MailboxesWire | None,
  over: Partial<MailboxesPaneProps> & { connect?: ConnectWire | None; factor?: FactorSlot | None } = {},
  around?: (pane: ReactNode) => ReactNode,
): PaneDrawn {
  const went: ("add" | "again")[] = [];
  const drained: string[] = [];
  const props = (more: Partial<MailboxesPaneProps> = {}): MailboxesPaneProps => ({
    wire,
    connect: NONE,
    capability: "here",
    service: "managed",
    factor: NONE,
    calendar: NONE,
    opened: null,
    stage: true,
    subscriptionPane: false,
    go: (run) => void went.push(run),
    ground: {
      importing: false,
      refresh: () => void drained.push("refresh"),
      sync: () => void drained.push("sync"),
    },
    hidden: () => false,
    ...over,
    ...more,
  });
  const tree = (more?: Partial<MailboxesPaneProps>): ReactNode => {
    const pane = <MailboxesPane {...props(more)} />;
    return (
      <TextProvider locale="en" messages={WORDS as never} timeZone="UTC">
        {around ? around(pane) : pane}
      </TextProvider>
    );
  };
  const view = render(tree());
  return { ...view, went, drained, redraw: (more) => view.rerender(tree(more)) };
}
