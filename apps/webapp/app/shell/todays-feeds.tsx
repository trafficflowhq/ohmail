"use client";

/**
 * WHAT TODAY'S CHROME SAID, FED TO THE FRAME. The rail as a model, every strip as a notice in the one slot, the
 * mailbox's state as the frame's connection reading, and the first run's hold. The strips' own components stay
 * with their tests; a notice that lists many things ("Show") opens today's list, unchanged, in the kit's dialog.
 * Goes with today's views: each part leaves as the place that owns it registers.
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { useTranslations } from "next-intl";
import type { QueuedChange } from "@ohmail/client-engine";
import type { GapOffer, MailboxFacts, MailState, OrganizerNotice as OrganizerNoticeFact, OrganizerNoticeKind } from "@ohmail/app-logic/mail-state/mail-state";
import { flushBeforeRestart, putUpdateAway, restartHold, type UpdateOffer } from "@ohmail/app-logic/doors/app-update";
import { dismissDurabilityLost } from "@ohmail/app-logic/storage/durable";
import { usePersistedFlag, UI_KEYS } from "@ohmail/app-logic/storage/persisted-ui";
import { useStableCallback } from "@ohmail/app-logic/press/stable-callback";
import { useFrame, useNotice, useRailModel, type FrameNotice, type PlaceId, type RailEntryModel, type RailModel } from "@ohmail/app/frame";
import { Dialog } from "@ohmail/ui/base";
import { RailEntry } from "@ohmail/ui/mail";
import { TAG_HUES, TextField, type RailGroup, type RailItem } from "@ohmail/ui";
import type { IconName } from "@ohmail/ui/base";
import { useAbandoned, useEngine } from "./engine";
import { useDurabilityLost } from "./DurabilityNotice";
import { refusalOf, type OrganizerNoticeTransport } from "./OrganizerNotice";
import type { GapLettersTransport } from "./GapLettersNotice";
import type { MailSendApi, SendLineItem } from "./mail-send";
import type { PullBinding } from "./PullNewMail";
import { footLineSeen } from "./narrow";
import { go, goSettings, goTag, goTriage } from "./routing";
import { lineRows, SendingLine } from "./SendingLine";
import { ariaShortcut, useBinding, useModGlyph } from "./keymap";
import { COMPOSE_CHORD, SEARCH_CHORD, TRIAGE_PILE_OF_RAIL } from "./shell-keys";
import { useTodaysConnection } from "./todays-reasons";
import { UnsavedChanges } from "./UnsavedChanges";
import { useRestartHold, useUpdateOffer } from "./UpdateLine";

type T = ReturnType<typeof useTranslations>;
type RailTagCreate = NonNullable<NonNullable<RailGroup["tags"]>["create"]>;

/**
 * Where the "Get ohmail for desktop" offer may stand: the signed-in browser only. `desktop` is the shell's platform
 * tell (the desktop app hands in its own pane), and the demo is a shop window. Pure, so a test drives it as a value.
 */
export function showDesktopCta(opts: { demo: boolean; desktop: boolean }): boolean {
  return !opts.demo && !opts.desktop;
}

/** The offer's one-time dismissal: the stored value is `"1"`, kept under the key it always had. */
export const DESKTOP_CTA_DISMISSED = "ohmail.desktopCtaDismissed";

/**
 * Where the offer leads: the latest release page. `undefined` in the desktop window build (`NEXT_PUBLIC_DESKTOP` is
 * "1" there), which never shows it, so the address folds out of the binary.
 */
export const DESKTOP_DOWNLOAD_URL: string | undefined =
  process.env.NEXT_PUBLIC_DESKTOP === "1" ? undefined : "https://github.com/trafficflowhq/ohmail/releases/latest";

/** The sign each of today's rail rows draws where the rail is icons or a dock. */
const ICON_OF_RAIL: Readonly<Record<string, IconName>> = {
  ohbox: "ohbox", reads: "news", receipts: "receipts", screener: "screener", triage: "later",
  "triage-aside": "parked", "triage-resurface": "resurface", history: "history", search: "search",
  drafts: "drafts", settings: "settings", trash: "trash",
};

/** A tag's stored hue name, as the degrees the kit's dot takes: its place on the wheel `TAG_HUES` keeps. */
const hueDegrees = (name: string): number => Math.max(0, TAG_HUES.indexOf(name as (typeof TAG_HUES)[number])) * (360 / TAG_HUES.length);

export interface TodaysFeedsInput {
  demo: boolean;
  t: T;
  facts: readonly MailboxFacts[] | null;
  mailState: MailState;
  /** When the copy on screen last finished a sync: the freshness the ladder judged (the host's copy-age read, else the engine's). */
  copyAsOf?: string | null;
  setupHref: string | null;
  mailSend: MailSendApi;
  /** The host brings the desktop's own pane: this is the desktop app. */
  desktopSection: boolean;
  railGroups: readonly RailGroup[];
  activeRailId: string | undefined;
  routeView: string;
  activeTagId: string | null;
  compose: () => void;
  pull: PullBinding;
  account: string | null;
  mailboxes: ReadonlyArray<{ address: string; name?: string }>;
  organizer: { changes: readonly OrganizerNoticeFact[]; acknowledge: OrganizerNoticeTransport; on: boolean };
  gap: { offers: readonly GapOffer[]; answer: GapLettersTransport; on: boolean };
  openNotSent: (item: SendLineItem) => boolean;
  /** The first run's stage stands over the app: the frame is held inert. */
  hold: boolean;
}

/** Today's chrome, fed to the frame. Returns the dialog a notice's "Show" opened, or nothing. */
export function useTodaysFeeds(input: TodaysFeedsInput): ReactNode {
  const { commands } = useFrame();
  const [shown, setShown] = useState<"unsaved" | "sending" | null>(null);
  useTodaysNotices(input, setShown);
  useTodaysConnection(input.mailState, input.setupHref, input.copyAsOf ?? null);
  useEffect(() => {
    commands.hold(input.hold);
    return () => commands.hold(false);
  }, [commands, input.hold]);
  return (
    <>
      <TodaysRail input={input} />
      <TodaysShown shown={shown} close={() => setShown(null)} input={input} />
    </>
  );
}

/** The rail's feed in a part of its own: the Tags fold's flag lives here, so a press renders the rail and not the shell. */
function TodaysRail({ input }: { input: TodaysFeedsInput }): null {
  useTodaysRail(input);
  return null;
}

/* ── the rail ─────────────────────────────────────────────────────────────────────────────────── */

/** Today's rail ids that are not the place's own: News is fed as `reads`. */
const PLACE_OF_RAIL: Readonly<Record<string, PlaceId>> = { reads: "news" };

function placeEntry(item: RailItem, current: boolean, press: (id: string) => void, shortcut?: string): RailEntryModel {
  return {
    id: item.id,
    ...(PLACE_OF_RAIL[item.id] ? { place: PLACE_OF_RAIL[item.id] } : {}),
    kind: "place",
    label: item.label,
    ...(ICON_OF_RAIL[item.id] ? { icon: ICON_OF_RAIL[item.id] } : {}),
    ...(item.count ? { count: String(item.count), countHot: item.hot === true } : {}),
    ...(item.kbdHint ?? item.navKey ? { keyHint: item.kbdHint ?? item.navKey } : {}),
    ...(item.title ? { title: item.title } : {}),
    ...(shortcut ? { shortcut } : {}),
    current,
    onPress: () => press(item.id),
  };
}

function useTodaysRail(input: TodaysFeedsInput): void {
  const { commands } = useFrame();
  const { t, railGroups, activeRailId, routeView, activeTagId, pull, account, mailboxes, facts } = input;
  const [tagsOpen, setTagsOpen] = usePersistedFlag(UI_KEYS.tagsOpen, true);
  const navigate = useStableCallback((id: string) => {
    commands.rail(false);
    const pile = TRIAGE_PILE_OF_RAIL[id];
    if (pile) goTriage(pile);
    else go(id as "ohbox");
  });
  const toTag = useStableCallback((id: string) => {
    commands.rail(false);
    goTag(id);
  });
  const compose = useStableCallback(() => {
    commands.rail(false);
    input.compose();
  });
  const pullNow = useStableCallback(() => pull.pull());
  const toMailboxes = useStableCallback(() => goSettings("mailboxes"));
  /* Compose's and Search's keys, said to a screen reader as 1.0's rail said them: read off the registry, so a key
     that is not bound here is said nowhere. */
  const mod = useModGlyph();
  const composeKey = useBinding(COMPOSE_CHORD);
  const searchKey = useBinding(SEARCH_CHORD);
  const writeShortcut = composeKey ? ariaShortcut(composeKey.chord, mod) : undefined;
  const searchShortcut = searchKey ? ariaShortcut(searchKey.chord, mod) : undefined;
  const model = useMemo((): RailModel => {
    const groups = railGroups.map((group, index) => {
      const entries: RailEntryModel[] = group.items.map((item) =>
        placeEntry(item, item.id === activeRailId, navigate, item.kbdHint === searchKey?.chord ? searchShortcut : undefined));
      const tags = group.tags;
      if (tags) {
        entries.push({ id: "tags", kind: "fold", label: tags.label, expanded: tagsOpen, onPress: () => setTagsOpen(!tagsOpen) });
        if (tagsOpen) {
          for (const tag of tags.items) {
            entries.push({
              id: tag.id,
              kind: "sub",
              label: tag.label,
              hue: hueDegrees(tag.hue),
              ...(tag.count ? { count: String(tag.count) } : {}),
              ...(tag.title ? { title: tag.title } : {}),
              current: routeView === "tag" && activeTagId === tag.id,
              onPress: () => toTag(tag.id),
            });
          }
        }
      }
      const node = tags?.create && tagsOpen ? <TagCreate create={tags.create} empty={tags.items.length === 0} /> : group.custom;
      return { id: tags ? "tags" : `group-${index}`, entries, ...(node ? { node } : {}) };
    });
    /* Who the foot names: the mailbox the shell holds the facts of, then the account, then the mirror's first mailbox. */
    const named = facts?.[0]?.address ?? account ?? mailboxes[0]?.address ?? null;
    return {
      groups,
      write: { label: t("rail.compose"), ...(writeShortcut ? { shortcut: writeShortcut } : {}), onPress: compose },
      account: named ? { name: named, address: named, note: "", title: t("rail.mailboxes"), onPress: toMailboxes } : null,
      /* Today's keys (`zone-nav`) find the rail by these, and enter it where it stands. */
      mark: "rail open",
      pull: pull.available ? { label: t(pull.pulling ? "sync.pulling" : "sync.pull"), busy: pull.pulling, onPress: pullNow } : null,
    };
  }, [railGroups, activeRailId, routeView, activeTagId, tagsOpen, setTagsOpen, account, mailboxes, facts, pull.available, pull.pulling,
    t, navigate, toTag, compose, pullNow, toMailboxes, writeShortcut, searchShortcut, searchKey?.chord]);
  useRailModel(model);
}

/** The rail's own "New tag": a quiet entry that turns into the name's field in place, as today's rail does. */
function TagCreate({ create, empty }: { create: RailTagCreate; empty: boolean }) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const typed = draft.trim();
  const taken = typed.length > 0 && create.duplicate?.taken(typed) === true;
  const cancel = () => {
    setCreating(false);
    setDraft("");
  };
  if (!creating) {
    return (
      <>
        {empty && create.emptyHint ? <p className="fr-tagempty">{create.emptyHint}</p> : null}
        <RailEntry kind="sub" icon="plus" quiet onPress={() => setCreating(true)}>{create.label}</RailEntry>
      </>
    );
  }
  return (
    <div className="fr-tagnew">
      <TextField
        shape="line"
        autoFocus
        value={draft}
        placeholder={create.placeholder}
        aria-label={create.label}
        aria-invalid={taken || undefined}
        maxLength={40}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (typed.length > 0 && !taken) {
              create.onCreate(typed);
              cancel();
            }
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancel();
          }
        }}
        onFocusLeft={() => {
          if (typed.length === 0) cancel();
        }}
      />
      {taken && create.duplicate ? <p className="fr-tagtaken" role="status">{create.duplicate.label(typed)}</p> : null}
    </div>
  );
}

/* ── the notices ──────────────────────────────────────────────────────────────────────────────── */

const NO_QUEUED: readonly QueuedChange[] = [];

function useQueued(): readonly QueuedChange[] {
  const engine = useEngine();
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => engine.queuedChanges(),
    () => NO_QUEUED,
  );
}

type Refusal = "noticeDismissOffline" | "noticeDismissInactive" | "noticeDismissFailed";
type GapSaid = "gapChanged" | "gapOffline" | "gapFailed";

function useOrganizerNotices({ t, organizer }: TodaysFeedsInput): FrameNotice[] {
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(() => new Set());
  const [refused, setRefused] = useState<ReadonlyMap<OrganizerNoticeKind, Refusal>>(() => new Map());
  if (!organizer.on) return [];
  const live = organizer.changes.filter((n) => !acknowledged.has(`${n.id}@${n.at}`));
  const acknowledge = (kind: OrganizerNoticeKind, rows: readonly OrganizerNoticeFact[]): void => {
    void Promise.all(rows.map((n) => organizer.acknowledge(n.id).then(
      () => { setAcknowledged((s) => new Set([...s, `${n.id}@${n.at}`])); return null; },
      (err: unknown) => refusalOf(err),
    ))).then((all) => {
      const why = all.find((a): a is Refusal => a !== null) ?? null;
      setRefused((m) => {
        const next = new Map(m);
        if (why === null) next.delete(kind);
        else next.set(kind, why);
        return next;
      });
    });
  };
  const plain = { b: (chunks: string) => chunks, c: (chunks: string) => chunks };
  return (["stopped", "elsewhere"] as const).flatMap((kind): FrameNotice[] => {
    const rows = live.filter((n) => n.kind === kind).sort((x, y) => x.order - y.order);
    if (rows.length === 0) return [];
    const one = rows.length === 1 ? rows[0]! : null;
    const title = one
      ? kind === "stopped"
        ? one.name
          ? t.markup("mailboxes.noticeStopped", { ...plain, name: one.name, address: one.address })
          : t.markup("mailboxes.noticeStoppedUnknown", { ...plain, address: one.address })
        : one.name
          ? t("mailboxes.noticeElsewhere", { name: one.name, address: one.address })
          : t("mailboxes.noticeElsewhereUnknown", { address: one.address })
      : t.markup(kind === "stopped" ? "mailboxes.noticeStoppedMany" : "mailboxes.noticeElsewhereMany", { ...plain, count: rows.length });
    const dismiss = { label: t("mailboxes.noticeDismiss"), onPress: () => acknowledge(kind, rows) };
    const why = refused.get(kind);
    return [{
      kind: kind === "stopped" ? "organizingStopped" : "organizedElsewhere",
      title,
      ...(kind === "stopped" ? { hot: true } : {}),
      ...(why ? { line: t(`mailboxes.${why}`) } : {}),
      acts: kind === "stopped" ? [{ label: t("mailboxes.noticeOpenMailboxes"), onPress: () => goSettings("mailboxes") }, dismiss] : [dismiss],
    }];
  });
}

function useGapNotices({ t, gap }: TodaysFeedsInput): FrameNotice[] {
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const [said, setSaid] = useState<GapSaid | null>(null);
  if (!gap.on) return [];
  const key = (o: GapOffer): string => `${o.id}@${o.count}+${o.strangers}`;
  const answer = (o: GapOffer, file: boolean): void => {
    void gap.answer(o.id, { file, count: o.count, strangers: o.strangers }).then(
      () => { setSaid(null); setAnswered((s) => new Set([...s, key(o)])); },
      (err: unknown) => setSaid((err as { status?: unknown } | null)?.status === 409 ? "gapChanged"
        : refusalOf(err) === "noticeDismissOffline" ? "gapOffline" : "gapFailed"),
    );
  };
  return gap.offers.filter((o) => !answered.has(key(o))).map((o): FrameNotice => ({
    kind: "gap",
    id: o.id,
    title: o.strangers === 0 ? t("mailboxes.gapLetters", { count: o.count, address: o.address })
      : o.count === 0 ? t("mailboxes.gapStrangers", { count: o.strangers, address: o.address })
        : t("mailboxes.gapBoth", { letters: o.count, strangers: o.strangers, address: o.address }),
    ...(said ? { line: t(`mailboxes.${said}`) } : {}),
    acts: [
      {
        label: o.count === 0 ? t("mailboxes.gapScreen", { count: o.strangers }) : t("mailboxes.gapFile", { count: o.count + o.strangers }),
        onPress: () => answer(o, true),
      },
      { label: t("mailboxes.gapLeave", { count: o.count + o.strangers }), onPress: () => answer(o, false) },
    ],
  }));
}

/** The update line's sentence and its press, as today's `UpdateLine` says them. */
function updateNotice(t: T, offer: UpdateOffer, hold: ReturnType<typeof useRestartHold>): FrameNotice {
  const holds = offer.kind === "ready" || offer.kind === "reload";
  const held = holds && hold !== null;
  const reload = offer.kind === "reload";
  const version = offer.version ?? "";
  const title =
    offer.kind === "reload" ? t("update.lineReload")
      : offer.kind === "downloading" ? t("update.lineDownloading", { version })
        : offer.kind === "failed" ? t(offer.failed === "install" ? "update.lineInstallFailed" : "update.lineCheckFailed")
          : offer.kind === "tooOld" ? t("update.lineTooOld")
            : offer.kind === "serverUpdating" ? t("update.lineServerUpdating")
              : t("update.lineReady", { version });
  const verb =
    offer.kind === "reload" ? t("update.lineReloadAction")
      : offer.kind === "tooOld" ? t(offer.verb === "update" ? "update.lineUpdateAction" : "update.lineReloadAction")
        : offer.kind === "failed" ? t("update.lineRetry")
          : t("update.lineRestart");
  const act = offer.act;
  const later = { label: t("update.lineLater"), onPress: putUpdateAway };
  /* An open editor's unsaved words are written first; a hold that began meanwhile stops the press. */
  const press = async (): Promise<void> => {
    await flushBeforeRestart();
    if (holds && restartHold() !== null) return;
    act?.();
  };
  return {
    kind: "update",
    title,
    ...(held ? { line: t(hold === "files" ? "update.lineAfterFiles" : "update.lineAfterSend") } : {}),
    acts: act && !held && offer.kind !== "downloading" ? [{ label: verb, onPress: () => void press() }, later] : [later],
    ...(reload && !held ? { hot: true } : {}),
  };
}

/** Which message an outcome is about, as the sending line names it. */
function aboutOf(t: T, item: SendLineItem): string | null {
  return item.to !== null && item.subject !== null ? t("sendingLine.aboutBoth", { name: item.to, subject: item.subject })
    : item.to !== null ? t("sendingLine.aboutTo", { name: item.to })
      : item.subject !== null ? t("sendingLine.aboutSubject", { subject: item.subject }) : null;
}

function sendingNotice(t: T, items: readonly SendLineItem[], show: () => void): FrameNotice | null {
  const rows = lineRows(items);
  const row = rows[0];
  if (!row) return null;
  const one = row.items.length === 1 ? row.items[0]! : null;
  const showAct = { label: t("sendingLine.open"), onPress: show };
  if (row.kind === "ended") {
    return {
      kind: "notSent",
      hot: true,
      title: one ? aboutOf(t, one) ?? t("reply.statusFailed") : t("compose.notSentMany", { count: row.items.length }),
      acts: [showAct],
    };
  }
  const title = row.kind === "queued"
    ? (one ? aboutOf(t, one) : null) ?? t("compose.statusQueued")
    : row.kind === "sending"
      ? one === null ? t("sendingLine.sendingMany", { count: row.items.length })
        : one.to !== null ? t("sendingLine.sending", { name: one.to }) : t("sendingLine.sendingUnnamed")
      : one === null || one.to === null ? t("sendingLine.sent")
        : one.subject !== null ? t("sendingLine.sentToAbout", { name: one.to, subject: one.subject })
          : t("sendingLine.sentTo", { name: one.to });
  return { kind: "sending", title, acts: [showAct] };
}

/** What could not be saved, or has not gone through yet, in today's words; null when nothing waits. */
function unsavedTitle(t: T, abandoned: number, queued: number): string | null {
  if (abandoned > 0) return t("sync.unsavedCount", { count: abandoned });
  return queued > 0 ? t("sync.unsavedPendingCount", { count: queued }) : null;
}

function useTodaysNotices(input: TodaysFeedsInput, setShown: (shown: "unsaved" | "sending") => void): void {
  const { t, mailSend } = input;
  const organizer = useOrganizerNotices(input);
  const gap = useGapNotices(input);
  const lost = useDurabilityLost();
  const offer = useUpdateOffer();
  const hold = useRestartHold();
  const abandoned = useAbandoned();
  const queued = useQueued();
  /* The slot says a send's ending where today's two lines were seen (the rail's foot, or the narrow-width pill), by
     today's own rule; where neither was (a narrow window with the reader sheet up), the ending is a report, as today. */
  useEffect(() => mailSend.mountLine(() => footLineSeen("rail") || footLineSeen("shell")), [mailSend.mountLine]);
  useSyncExternalStore(mailSend.subscribeLine, mailSend.lineVersion, mailSend.lineVersion);
  const [ctaDismissed, dismissCta] = usePersistedFlag(DESKTOP_CTA_DISMISSED, false);
  const offerDesktop = showDesktopCta({ demo: input.demo, desktop: input.desktopSection }) && !ctaDismissed
    && DESKTOP_DOWNLOAD_URL !== undefined;

  const notices: FrameNotice[] = [...organizer, ...gap];
  if (lost) {
    notices.push({ kind: "notKept", title: t("session.storageRefused"), acts: [{ label: t("session.storageRefusedDismiss"), onPress: dismissDurabilityLost }] });
  }
  if (offer !== null) notices.push(updateNotice(t, offer, hold));
  const unsaved = unsavedTitle(t, abandoned.length, queued.length);
  if (unsaved !== null) {
    notices.push({ kind: "unsaved", hot: abandoned.length > 0, title: unsaved, acts: [{ label: t("sync.unsavedShow"), onPress: () => setShown("unsaved") }] });
  }
  const sending = sendingNotice(t, mailSend.line(), () => setShown("sending"));
  if (sending) notices.push(sending);
  if (offerDesktop && DESKTOP_DOWNLOAD_URL !== undefined) {
    const url = DESKTOP_DOWNLOAD_URL;
    notices.push({
      kind: "desktopOffer",
      title: t("rail.getDesktop"),
      acts: [
        { label: t("rail.getDesktopOpen"), onPress: () => void window.open(url, "_blank", "noopener,noreferrer") },
        { label: t("rail.getDesktopDismiss"), onPress: () => dismissCta(true) },
      ],
    });
  }
  useNotice(notices);
}

/** What "Show" opened: today's own list, unchanged, inside the kit's dialog. It closes itself when the list empties. */
function TodaysShown({ shown, close, input }: { shown: "unsaved" | "sending" | null; close: () => void; input: TodaysFeedsInput }) {
  const { t, mailSend, facts } = input;
  const abandoned = useAbandoned();
  const queued = useQueued();
  useSyncExternalStore(mailSend.subscribeLine, mailSend.lineVersion, mailSend.lineVersion);
  /* The dialog says what the notice said: the same sentence over the list it opened. */
  const title = shown === "unsaved" ? unsavedTitle(t, abandoned.length, queued.length)
    : shown === "sending" ? sendingNotice(t, mailSend.line(), () => undefined)?.title ?? null : null;
  useEffect(() => {
    if (shown !== null && title === null) close();
  }, [shown, title, close]);
  if (shown === null || title === null) return null;
  return (
    <Dialog
      open
      onClose={close}
      title={title}
      cancel={{ label: t("sync.unsavedHide") }}
      list
    >
      {shown === "unsaved"
        ? <UnsavedChanges variant="rail" mailboxes={facts} shown />
        : <SendingLine api={mailSend} variant="rail" onOpen={(item) => { const opened = input.openNotSent(item); if (opened) close(); return opened; }} onOpenMany={() => { close(); go("drafts"); }} />}
    </Dialog>
  );
}
