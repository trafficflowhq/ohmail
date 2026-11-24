/**
 * THE MAILBOXES PANE'S STATES, for the states page and the comparison: each with its address in the registry, the
 * rows a stand-in wire answers, the row the route opens and, where the state is a press, the control pressed by its
 * role and name. The world is the reference's own: two mailboxes of a design studio, on the managed service.
 */
import { mailboxIdOfAnswer } from "@ohmail/app-logic/mailboxes/connect/subject";
import type { MailboxId } from "@ohmail/app-logic/mailboxes/connect/types";
import type { ConnectAllowance, MailboxRow } from "@ohmail/app-logic/mailboxes/pane/types";

export interface MailboxesPaneState {
  /** The registry's key, `screen=settings&sec=mailboxes…`. */
  readonly address: string;
  readonly rows: readonly MailboxRow[];
  /** The route's word: the row that stands open. */
  readonly opened: string | null;
  readonly allowance: ConnectAllowance;
  /** A press the state is reached by, by the control's role and its name's catalogue key in `mailboxes`. */
  readonly press?: { readonly role: "button"; readonly key: string };
}

const STUDIO = "mila@lichtgrat.example";
const PERSONAL = "hello@milabrunner.example";
const ALLOWED: ConnectAllowance = { emailVerified: true, access: { canAddMailbox: true, mailboxes: 5 } };

/** A state's rows are a stand-in wire's answer: their ids are minted where every answer's are, never by a cast. */
function idOf(raw: string): MailboxId {
  const id = mailboxIdOfAnswer(raw);
  if (id === null) throw new TypeError("a state's row names no id");
  return id;
}

/** The world at `now`: the studio's mailbox and a personal one, both connected, synced a minute ago. */
export function mailboxesStates(now: number) {
  const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString();
  const row = (id: string, address: string, over: Partial<MailboxRow> = {}): MailboxRow => ({
    id: idOf(id),
    address,
    provider: "generic",
    status: "connected",
    errorCode: null,
    disabledReason: null,
    syncBlockedReason: null,
    syncBlockedSince: null,
    lastSyncAt: ago(1),
    createdAt: ago(60 * 24 * 6),
    organizerRole: "organizer",
    organizeConsentedAt: ago(60 * 24 * 6),
    authKind: "password",
    messageCount: 1284,
    ...over,
  });
  const studio = row("studio", STUDIO);
  const personal = row("personal", PERSONAL, { messageCount: 412 });
  const state = (
    address: string,
    rows: readonly MailboxRow[],
    more: Partial<Omit<MailboxesPaneState, "address" | "rows">> = {},
  ): MailboxesPaneState => ({ address, rows, opened: null, allowance: ALLOWED, ...more });
  const base = "screen=settings&sec=mailboxes";
  return {
    rest: state(base, [
      studio,
      row("personal", PERSONAL, { status: "error", errorCode: "storage", messageCount: 412 }),
    ]),
    open: state(`${base}&state=open`, [studio, personal], { opened: "studio" }),
    five: state(`${base}&state=five`, [
      studio,
      personal,
      row("shop", "shop@lichtgrat.example", { messageCount: 96 }),
      row("bench", "bench@lichtgrat.example", { messageCount: 31 }),
      row("archive", "archive@milabrunner.example", { lastSyncAt: null, messageCount: 0 }),
    ]),
    refused: state(
      `${base}&state=refused`,
      [studio, row("personal", PERSONAL, { status: "error", errorCode: "auth" })],
      {
        opened: "personal",
      },
    ),
    importing: state(`${base}&state=importing`, [
      studio,
      row("personal", PERSONAL, { lastSyncAt: null, messageCount: 412 }),
    ]),
    reader: state(
      `${base}&state=reader`,
      [
        studio,
        row("personal", PERSONAL, {
          organizerRole: "reader",
          organizedBy: { kind: "local", name: "Mila's MacBook", since: ago(60 * 24) },
          organizerState: "held",
        }),
      ],
      { opened: "personal" },
    ),
    idle: state(
      `${base}&state=idle`,
      [
        studio,
        row("personal", PERSONAL, {
          organizerRole: "reader",
          organizedBy: null,
          organizerReleasedAt: ago(60 * 24 * 2),
        }),
      ],
      { opened: "personal" },
    ),
    edit: state(`${base}&state=edit`, [studio, personal], {
      opened: "studio",
      press: { role: "button", key: "edit" },
    }),
  } as const satisfies Record<string, MailboxesPaneState>;
}
