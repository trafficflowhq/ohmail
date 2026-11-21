"use client";

/**
 * THE MAILBOXES' TWO NOTICES, for the notice slot: what changed about who organizes a mailbox and has not been
 * acknowledged, and the letters that arrived while nothing organized it. Both are derived from the mailbox facts and
 * answered through the shell's two wires; each is withheld where nothing can answer it, since it would stand for ever.
 * Held for the Mailboxes entry's `notice()`: the old shell's feeds of the same two kinds leave in the commit that
 * registers it, so that one kind is never drawn twice.
 */
import { useState } from "react";
import {
  gapOffers,
  organizerNotices,
  type GapOffer,
  type OrganizerNotice,
  type OrganizerNoticeKind,
} from "../../mail-state/mail-state.js";
import { NONE, type None } from "./calls.js";
import type { PaneSaid } from "./organizer.js";

type Facts = Parameters<typeof organizerNotices>[0];

export const MAX_NOTICE_MAILBOXES = 3;

export interface PaneNoticeAct {
  readonly label: PaneSaid;
  press(): void;
}

/** A notice as the slot shows it, its words still keys: the shell's own words fill them. */
export interface PaneNotice {
  readonly kind: "organizingStopped" | "organizedElsewhere" | "gap";
  readonly id?: string;
  /** The title; `markup` says it carries the catalogue's emphasis marks, drawn as plain words in the slot. */
  readonly title: PaneSaid & { readonly markup?: true };
  readonly hot?: true;
  readonly line?: PaneSaid;
  readonly mailboxes?: readonly OrganizerNotice[];
  readonly afterInspect?: PaneNoticeAct;
  readonly acts: readonly PaneNoticeAct[];
}

type Refused = "noticeDismissOffline" | "noticeDismissInactive" | "noticeDismissFailed";

/** The two codes that mean this install reached nothing; 402 is the account's own refusal; anything else is plain. */
const OFFLINE_CODES: ReadonlySet<unknown> = new Set(["offline_read_only", "network_unreachable"]);
export function noticeRefusalOf(err: unknown): Refused {
  const e = (err ?? {}) as { status?: unknown; code?: unknown };
  if (err instanceof TypeError || OFFLINE_CODES.has(e.code)) return "noticeDismissOffline";
  if (e.status === 402) return "noticeDismissInactive";
  return "noticeDismissFailed";
}

export interface OrganizerNoticesInput {
  readonly facts: Facts;
  /** Acknowledges one mailbox's change; `none`: the notice is withheld entirely. */
  readonly acknowledge: ((mailboxId: string) => Promise<unknown>) | None;
  /** The facts are read again on every answer, so the line leaves on it. */
  refresh(): void;
  /** To the full Mailboxes list, or none where this host has no list to open. */
  readonly open: (() => void) | None;
}

export function elsewhereNoticeTitle(one: OrganizerNotice) {
  const values: Record<string, string> = { address: one.address };
  if (one.name) {
    values.name = one.name;
    return { key: "noticeElsewhere" as const, values };
  }
  return { key: "noticeElsewhereUnknown" as const, values };
}

function titleOf(kind: OrganizerNoticeKind, rows: readonly OrganizerNotice[]): PaneNotice["title"] {
  const one = rows.length === 1 ? rows[0]! : null;
  if (one === null)
    return {
      key: kind === "stopped" ? "noticeStoppedMany" : "noticeElsewhereMany",
      values: { count: rows.length },
      markup: true,
    };
  if (kind === "stopped")
    return one.name
      ? { key: "noticeStopped", values: { name: one.name, address: one.address }, markup: true }
      : { key: "noticeStoppedUnknown", values: { address: one.address }, markup: true };
  return elsewhereNoticeTitle(one);
}

function changeKey(notice: OrganizerNotice): string {
  return `${notice.id}@${notice.at}`;
}

export function useOrganizerNotices(input: OrganizerNoticesInput): PaneNotice[] {
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(() => new Set());
  const [refused, setRefused] = useState<ReadonlyMap<string, Refused>>(() => new Map());
  const { acknowledge, open } = input;
  const changes = organizerNotices(input.facts);
  if (acknowledge === NONE || changes.length === 0) return [];
  const live = changes.filter((n) => !acknowledged.has(changeKey(n)));
  const dismiss = (rows: readonly OrganizerNotice[]): void => {
    void Promise.all(
      rows.map((n) => {
        const key = changeKey(n);
        return acknowledge(n.id).then(
          () => {
            setAcknowledged((s) => new Set([...s, key]));
            return { key, why: null };
          },
          (err: unknown) => ({ key, why: noticeRefusalOf(err) }),
        );
      }),
    ).then((answers) => {
      input.refresh();
      setRefused((m) => {
        const next = new Map(m);
        for (const { key, why } of answers) {
          if (why === null) next.delete(key);
          else next.set(key, why);
        }
        return next;
      });
    });
  };
  return (["stopped", "elsewhere"] as const).flatMap((kind): PaneNotice[] => {
    const rows = live.filter((n) => n.kind === kind).sort((x, y) => x.order - y.order);
    if (rows.length === 0) return [];
    const why = rows.map((row) => refused.get(changeKey(row))).find((reason) => reason !== undefined);
    const acts: PaneNoticeAct[] = [];
    if (open !== NONE && rows.length === 1) {
      acts.push({ label: { key: "noticeOpenMailboxes" }, press: open });
    }
    const dismissAct: PaneNoticeAct = { label: { key: "noticeDismiss" }, press: () => dismiss(rows) };
    const needsInspection = open === NONE && rows.length > MAX_NOTICE_MAILBOXES;
    if (!needsInspection) acts.push(dismissAct);
    return [
      {
        kind: kind === "stopped" ? "organizingStopped" : "organizedElsewhere",
        title: titleOf(kind, rows),
        ...(kind === "stopped" ? { hot: true as const } : {}),
        ...(why ? { line: { key: why } } : {}),
        ...(rows.length > 1 ? { mailboxes: rows } : {}),
        ...(needsInspection ? { afterInspect: dismissAct } : {}),
        acts,
      },
    ];
  });
}

export interface GapNoticesInput {
  readonly facts: Facts;
  /** Answers one mailbox's offer; `none`: the offer is withheld. */
  readonly answer:
    | ((mailboxId: string, answer: { file: boolean; count: number; strangers: number }) => Promise<unknown>)
    | None;
  refresh(): void;
}

type GapSaid = "gapChanged" | "gapOffline" | "gapFailed";

export function useGapNotices(input: GapNoticesInput): PaneNotice[] {
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const [said, setSaid] = useState<GapSaid | null>(null);
  const { answer } = input;
  const offers = gapOffers(input.facts);
  if (answer === NONE || offers.length === 0) return [];
  const key = (o: GapOffer): string => `${o.id}@${o.count}+${o.strangers}`;
  const reply = (o: GapOffer, file: boolean): void => {
    void answer(o.id, { file, count: o.count, strangers: o.strangers })
      .then(
        () => {
          setSaid(null);
          setAnswered((s) => new Set([...s, key(o)]));
        },
        (err: unknown) =>
          setSaid(
            (err as { status?: unknown } | null)?.status === 409
              ? "gapChanged"
              : noticeRefusalOf(err) === "noticeDismissOffline"
                ? "gapOffline"
                : "gapFailed",
          ),
      )
      .finally(() => input.refresh());
  };
  return offers
    .filter((o) => !answered.has(key(o)))
    .map((o): PaneNotice => ({
      kind: "gap",
      id: o.id,
      title:
        o.strangers === 0
          ? { key: "gapLetters", values: { count: o.count, address: o.address } }
          : o.count === 0
            ? { key: "gapStrangers", values: { count: o.strangers, address: o.address } }
            : { key: "gapBoth", values: { letters: o.count, strangers: o.strangers, address: o.address } },
      ...(said ? { line: { key: said } } : {}),
      acts: [
        {
          label:
            o.count === 0
              ? { key: "gapScreen", values: { count: o.strangers } }
              : { key: "gapFile", values: { count: o.count + o.strangers } },
          press: () => reply(o, true),
        },
        {
          label: { key: "gapLeave", values: { count: o.count + o.strangers } },
          press: () => reply(o, false),
        },
      ],
    }));
}
