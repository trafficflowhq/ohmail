"use client";

/**
 * THE GLOBAL KEYS, THE PALETTE AND THE RAIL — the top of the shell's graph.
 *
 * Everything here READS what the five hooks below it returned and declares nothing they need,
 * which is why it is called last: Escape's one ordered list, the global chord map, the layout
 * cycle and its two subscribed width facts, the command palette's list, the rail's groups and
 * their digit chords, and the switch mark that ends when the pressed-for view is on screen. The
 * nine effects keep their source order and every `useKeyBindings` registration keeps its phase
 * and its scope. Lifted out of `AppShell.tsx` unchanged (ARCH-022).
 */
import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { useTranslations } from "next-intl";
import {
  forwardOffered,
  sendAndDonePlanFor,
  type EngineMessage,
  type EntityReader,
  type OhmailEngine,
  type TriagePileEntry,
} from "@ohmail/client-engine";
import {
  Icon,
  type Command,
  type RailGroup,
  useCommandPalette,
  useTheme,
} from "@ohmail/ui";
import { replyAllRecipients } from "./compose-from";
import type { ConsentState } from "./consent-state";
import { deleteKeyBindings } from "./delete-undo";
import { FoldersRailGroup, type FolderVerbs } from "./FoldersRailGroup";
import { hueOf } from "./format";
import { useKeyBindings, type KeyBinding } from "./keymap";
import type { MailboxFacts } from "./mail-state";
import { isModalOpen } from "./modal-gate";
import { readColumnHidden, readColumnHiddenFor, watchNarrow, watchZeroPushTier, zeroPushTier } from "./narrow";
import type { PullBinding } from "./PullNewMail";
import { EMPTY_RICH, type RichValue } from "./rich-text";
import { go, goFolder, goScreener, goSettings, goTag, goTriage, switchKeyOf, type Route, type TriagePileId } from "./routing";
import type { ScreenerState } from "./screener-state";
import type { ShellCompose } from "./shell-compose";
import type { ShellDerivations } from "./shell-derivations";
import type { ShellDispatch } from "./shell-dispatch";
import type { ShellOpenState } from "./shell-open-state";
import type { ShellVerbs } from "./shell-verbs";
import { useStableCallback } from "./stable-callback";
import { useSwitchEnd } from "./ui-vitals";
import { currentZone, setRailSummon } from "./zone-nav";
import { settingsPanes, type WiredPanes } from "../views/settings-panes";

/**
 * The stable name of a Reply Run entry: the message it stands for, or its title when it has
 * none (fixture-only `triage_item` rows, which nothing can be sent in reply to).
 *
 * `TriageView` already keys its done-marks this way. Naming it once means the map of typed
 * replies, the done set and the pile row cannot drift apart over what counts as "this item".
 */
export const frKeyOf = (item: TriagePileEntry): string => item.messageId ?? item.title;

/**
 * THE RAIL ROW ↔ THE TRIAGE PILE, stated once.
 *
 * The rail's ids are historical (`triage`, `triage-aside`, `triage-resurface`) and the route's
 * are the piles' own names (`reply`, `aside`, `resurface`), so exactly one place converts. It
 * used to be `if (id.startsWith("triage")) go("triage")` — a conversion that threw the answer
 * away, which is the whole of the reported defect.
 */
export const TRIAGE_PILE_OF_RAIL: Record<string, TriagePileId> = {
  triage: "reply",
  "triage-aside": "aside",
  "triage-resurface": "resurface",
};
const RAIL_OF_TRIAGE_PILE: Record<TriagePileId, string> = {
  reply: "triage",
  aside: "triage-aside",
  resurface: "triage-resurface",
};

/**
 * The rail ids the number keys reach, and the ONLY hand-written part of that feature: which
 * rows are piles. The ORDER is not written here — it is read off `railGroups` — so this list
 * cannot put `3` on the wrong row, only include or exclude a row from being numbered.
 */
const PILE_IDS: string[] = ["ohbox", "reads", "receipts", "screener", ...Object.keys(TRIAGE_PILE_OF_RAIL)];
/** The `g` chord's label key per numbered rail row — one sentence for both chords to a place. */
const PILE_CHORD_LABEL: Record<string, "shortcuts.goOhbox" | "shortcuts.goReads" | "shortcuts.goReceipts" | "shortcuts.goScreener" | "shortcuts.goLater" | "shortcuts.goParked" | "shortcuts.goResurface"> = {
  ohbox: "shortcuts.goOhbox",
  reads: "shortcuts.goReads",
  receipts: "shortcuts.goReceipts",
  screener: "shortcuts.goScreener",
  triage: "shortcuts.goLater",
  "triage-aside": "shortcuts.goParked",
  "triage-resurface": "shortcuts.goResurface",
};

export interface ShellKeysInput {
  engine: OhmailEngine;
  /** The mirror as it is — `engine.read()` from the render, never re-read here. */
  reader: EntityReader;
  demo: boolean;
  t: ReturnType<typeof useTranslations>;
  /** Layout and scheme: `w` flips the first, the palette's three entries set the second. */
  theme: ReturnType<typeof useTheme>;
  route: Route;
  /** Only the three members Escape and `mod+k` touch — the list itself is `commands`. */
  palette: Pick<ReturnType<typeof useCommandPalette>, "open" | "closePalette" | "toggle">;
  /** Pull new mail, as the host offers it — `p`'s own gate and its palette row. */
  pullBinding: Pick<PullBinding, "available" | "pull" | "pulling">;
  /** The four flags the rail groups and the folder chords read (`consent-state.ts`). */
  consent: Pick<ConsentState, "foldersEnabled" | "foldersStorable" | "known" | "signaturesKnown">;
  /** Whether the first drain is still running — the folders group renders skeletons under it. */
  syncStatus: { bootstrapping: boolean };
  /** Has the mail state settled? Each view's switch mark ends on its own rows or on this. */
  mailState: { settled: boolean };
  /** `GET /mailboxes` as the roster reported it, or `null` for "we cannot see". */
  facts: MailboxFacts[] | null;
  /** Is the seed screen still owed? It TAKES the stage — `effectiveView` says so once. */
  seedOwed: boolean;
  /** The folder rail's own verbs (`folder-verbs.ts`), handed over on a live folders account. */
  folderVerbs: FolderVerbs;
  screener: Pick<ScreenerState, "queueSettled" | "waiting" | "waitingCount">;
  /** What the rail foot may say about the provider's Junk folder, or nothing. */
  junkSaid: { named: string } | "unnamed" | null;
  /** Can this build open that folder — the statement without the pointer where it cannot. */
  junkReadable: boolean;
  /** Whether the away responder exists on this host — its palette row and its `g` chord. */
  awaySupported: boolean;
  /** "New since you were here" per stream, for the rail's two counts. */
  readsNew: number;
  receiptsNew: number;
  /** The settings panes this surface offers — one list with the nav and with the palette. */
  accountSection: ReactNode | undefined;
  mailboxSection: ReactNode | undefined;
  aiSection: ReactNode | undefined;
  billingSection: ReactNode | undefined;
  invitesSection: ReactNode | undefined;
  securitySection: ReactNode | undefined;
  aboutSection: ReactNode | undefined;
  desktopSection: { label: string; node: ReactNode } | undefined;
  devicesSection: ReactNode | undefined;
  /** The host's unread sink, told what the Ohbox is carrying. */
  onUnread: ((unread: number) => void) | undefined;
  /** The one armed Undo, pressed by `mod+z` (`shell-dispatch.ts`). */
  runArmedUndo: ShellDispatch["runArmedUndo"];
  allOhbox: ShellDerivations["allOhbox"];
  /** The rail's own number — the three groups, never the surface (`shell-derivations.ts`). */
  ohboxCount: ShellDerivations["ohboxCount"];
  /** The projection the Send + Done rule is asked of, never the reader. */
  presented: ShellDerivations["presented"];
  /** The chord's door — the same send the button presses (`shell-compose.ts`). */
  pressSendAndDone: ShellCompose["pressSendAndDone"];
  drafts: ShellDerivations["drafts"];
  folderMailboxes: ShellDerivations["folderMailboxes"];
  folderMessages: ShellDerivations["folderMessages"];
  folderOlder: ShellDerivations["folderOlder"];
  folders: ShellDerivations["folders"];
  folderUnread: ShellDerivations["folderUnread"];
  history: ShellDerivations["history"];
  ohbox: ShellDerivations["ohbox"];
  openFolder: ShellDerivations["openFolder"];
  ownAddresses: ShellDerivations["ownAddresses"];
  partition: { fresh: EngineMessage[]; seen: EngineMessage[] };
  piles: ShellDerivations["piles"];
  receipts: ShellDerivations["receipts"];
  scheduled: ShellDerivations["scheduled"];
  tagGroups: ShellDerivations["tagGroups"];
  tags: ShellDerivations["tags"];
  trashPage: ShellDerivations["trashPage"];
  barPanel: ShellOpenState["barPanel"];
  /** The cursor. `null` is "no cursor", which is every message verb's own disabled reason. */
  focused: ShellOpenState["focused"];
  fr: { step: number; items: TriagePileEntry[] } | null;
  frValues: Record<string, RichValue>;
  mirrorHolds: ShellOpenState["mirrorHolds"];
  picker: ShellOpenState["picker"];
  railOpen: ShellOpenState["railOpen"];
  readerFor: ShellOpenState["readerFor"];
  readerMessage: ShellOpenState["readerMessage"];
  selectedOhbox: ShellOpenState["selectedOhbox"];
  senderAudit: ShellOpenState["senderAudit"];
  senderMenu: ShellOpenState["senderMenu"];
  setBarPanel: ShellOpenState["setBarPanel"];
  setFr: Dispatch<SetStateAction<{ step: number; items: TriagePileEntry[] } | null>>;
  setFrPending: ShellOpenState["setFrPending"];
  setPicker: ShellOpenState["setPicker"];
  setRailOpen: ShellOpenState["setRailOpen"];
  setReaderFor: ShellOpenState["setReaderFor"];
  setScreenerFull: ShellOpenState["setScreenerFull"];
  setSenderAudit: ShellOpenState["setSenderAudit"];
  setSenderMenu: ShellOpenState["setSenderMenu"];
  setShortcutsOpen: ShellOpenState["setShortcutsOpen"];
  setSubjectRule: ShellOpenState["setSubjectRule"];
  shortcutsOpen: ShellOpenState["shortcutsOpen"];
  startFR: ShellOpenState["startFR"];
  subjectRule: ShellOpenState["subjectRule"];
  mailSend: ShellCompose["mailSend"];
  openForward: ShellCompose["openForward"];
  sendReply: ShellCompose["sendReply"];
  toggleReply: ShellCompose["toggleReply"];
  createTagAlone: ShellVerbs["createTagAlone"];
  onMessageAction: ShellVerbs["onMessageAction"];
  onStreamAction: ShellVerbs["onStreamAction"];
  openSenderMenu: ShellVerbs["openSenderMenu"];
  toggleTag: ShellVerbs["toggleTag"];
  /** The inline reply's id and its setter — the shell's own state, read and closed here. */
  replyTo: string | null;
  setReplyTo: Dispatch<SetStateAction<string | null>>;
}

/** The record the shell composes with. Consumers destructure it: a memo may not depend on it. */
export type ShellKeys = ReturnType<typeof useShellKeys>;

export function useShellKeys({
  engine, reader, demo, t, theme, route, palette, pullBinding, consent, syncStatus, mailState,
  facts, seedOwed, folderVerbs, screener, junkSaid, junkReadable, awaySupported, readsNew,
  receiptsNew,
  accountSection, mailboxSection, aiSection, billingSection, invitesSection, securitySection,
  aboutSection, desktopSection, devicesSection, onUnread,
  runArmedUndo,
  allOhbox, ohboxCount, presented, pressSendAndDone, drafts, folderMailboxes, folderMessages, folderOlder, folders, folderUnread, history,
  ohbox, openFolder, ownAddresses, partition, piles, receipts, scheduled, tagGroups, tags,
  trashPage,
  barPanel, focused, fr, frValues, picker, railOpen, readerFor, readerMessage,
  selectedOhbox, senderAudit, senderMenu, setBarPanel, setFr, setFrPending, setPicker, setRailOpen,
  setReaderFor, setScreenerFull, setSenderAudit, setSenderMenu, setShortcutsOpen, setSubjectRule,
  shortcutsOpen, startFR, subjectRule,
  mailSend, openForward, sendReply, toggleReply,
  createTagAlone, onMessageAction, onStreamAction, openSenderMenu, toggleTag,
  replyTo, setReplyTo,
}: ShellKeysInput) {
  /**
   * Escape has one owner, and this ordered list is it. Before the registry, Escape was handled by `Reader` (close),
   * `AppShell` (the (i) panel), `OhboxView` (clear the selection), `ScreenerView` (leave the mobile preview) and the
   * palette input — five listeners with no agreed order, why the reply editor could not simply add a sixth. `Reader`
   * takes `closeOnEscape={false}` and this closes the innermost thing that is open. It used to be TWO lists — an
   * `if/else if` cascade deciding WHAT Escape closes and a parallel boolean deciding WHETHER it was live — two
   * enumerations of the same eight overlays, a drift the type system cannot see. One array answers both: `find` gives
   * the innermost open overlay, and its absence IS "nothing is open"; forgetting a new overlay makes Escape inert for
   * it, visible on first use rather than subtly wrong. Order is innermost-first, the list's own order.
   */

  /**
   * It is not the destructive-key gate, which it briefly was: Backspace/Delete read this array
   * for one revision, reasoning that the one list of what Escape closes is the one list of what
   * is open. False premise — this enumerates the overlays THE SHELL OWNS: first run was never
   * in it (Escape is not how you leave first run) while a message More menu CANNOT be (its open
   * state lives inside the component, below the shell); both were reachable, and Delete fired
   * under them. The gate asks the DOM instead (`modal-gate.ts#isModalOpen`) — the only form of
   * the question a surface added later answers without anybody editing a list. This array is
   * Escape's, and only Escape's.
   */
  const escapeLayers: Array<[open: boolean, close: () => void]> = [
    [palette.open, palette.closePalette],
    [shortcutsOpen, () => setShortcutsOpen(false)],
    // Above the popover: the audit panel is opened FROM the sheet and replaces it, so it is
    // the innermost thing on screen whenever it exists.
    [senderAudit != null, () => setSenderAudit(null)],
    // Above the sender popover for the same reason the audit panel is: the subject sheet is opened
    // FROM it and replaces it, so whenever both flags could be true the subject sheet is the thing
    // on screen. (It closes the popover on open, so in practice they are never both set — the
    // ordering is here so that stays a property of this list rather than of one callback.)
    [subjectRule != null, () => setSubjectRule(null)],
    [senderMenu != null, () => setSenderMenu(null)],
    [picker != null, () => setPicker(null)],
    [fr != null, () => setFr(null)],
    // The 390px navigation drawer. It sits over the deck and intercepts every press until it
    // is dismissed, so while it is open it is the innermost thing a keyboard user is looking
    // at that is not one of the anchored popovers above — Escape closed everything else in
    // this list and left exactly this one standing (the backdrop tap was the only way out).
    [railOpen, () => setRailOpen(false)],
    // The action bar's open destination strip (Move / Resurface / the delete confirm). Above
    // the reply editor and the reader because it stands OVER the bar inside them — a strip
    // opened by `m` or `d` is the innermost question on screen, and Escape answering it must
    // not close the editor or the sheet underneath instead.
    [barPanel != null, () => setBarPanel(null)],
    [replyTo != null, () => setReplyTo(null)],
    [readerFor != null, () => setReaderFor(null)],
  ];
  const closeInnermost = escapeLayers.find(([open]) => open)?.[1] ?? null;

  /**
   * An open overlay owns Escape while it is open. The Ohbox's "clear the selection" is a VIEW binding and Escape's
   * cascade was a GLOBAL one, so a picked set outranked the cascade unconditionally: with two rows selected, Escape
   * cleared the selection instead of closing the `?` sheet, the ⌘K palette or the screening popover the user was
   * looking at. It had been patched once, for the reply editor only, by teaching the Ohbox's binding to stand down
   * when `chrome.replyTo != null` — a predicate in a view naming one shell overlay out of eight, the shape that rots.
   * The rule: a third scope, ABOVE view layers (`keymap.tsx`), holding exactly one binding — Escape, live only while
   * something is open.
   */

  /**
   * Nothing open ⇒ disabled, the registry falls through and Escape clears the selection as before; anything open ⇒
   * this wins over every view binding there will ever be, closes the innermost overlay, and the selection survives.
   * It cannot rot the way the per-case predicate did: no view names an overlay and this binding names none — it is
   * gated by `escapeLayers`, the same single list that decides what Escape closes, so an overlay Escape can close
   * outranks a selection by construction.
   */
  useKeyBindings(
    [
      {
        chord: "Escape",
        group: "app",
        label: t("shortcuts.escape"),
        inInput: true,
        disabled: closeInnermost == null,
        run: () => closeInnermost?.(),
      },
    ],
    "overlay",
  );

  /**
   * THE LAYOUT CYCLE — `w` flips classic ⇄ Zero (OHMARCHY-PLAN §3b), registered like every other chord so the `?`
   * sheet and the palette document it from the one registry. FACE-INDEPENDENT, BY DECISION (lane E close-out): layout
   * is the contract's own second axis, orthogonal to the face by construction — the zero stylesheet speaks only in
   * tokens, so paper resolves the same arrangement through its calm values — and §4's acceptance criterion runs the
   * keyboard walkthrough in BOTH layouts, which would be a test of a hidden state under a face gate. The DEFAULT
   * stays classic on every face and every platform; zero is only ever this device's explicit choice (`ohmail.layout`
   * — the contract gives layout no account wire, and none is added here).
   */
  const cycleLayout = useStableCallback(() => {
    theme.setLayout(theme.layout === "zero" ? "classic" : "zero");
  });

  /**
   * The Zero drawer summon (zone-nav's module seam): under zero the sub-900px rail is a
   * docked icon ribbon (off canvas under 392px), and `h`/← toward it means "summon the full
   * drawer" — §12's one meaning for `h`; the ribbon itself never auto-floats. Registered
   * ONLY while zero is active, so classic's keyboard behavior does not move.
   */
  useEffect(() => {
    if (theme.layout !== "zero") return;
    setRailSummon(() => setRailOpen(true));
    return () => setRailSummon(null);
  }, [theme.layout]);

  /**
   * The layout-cycle reconcile (review, rounds 1–3). The narrow-only surfaces — the reader sheet, the Screener's full
   * preview — exist because the column they duplicate is off screen; a layout change that brings the column back
   * would leave them standing fixed over the very split they duplicate. Asked with the NEW layout's own answer
   * (`readColumnHiddenFor`), because the attribute stamp lands in the provider's effect, which runs after this one.
   * On the TRANSITION only (round 2): a sheet can stand at a wide width by design — `openMessage` raises it for a
   * message no standing column can show — and a wide→wide cycle must not take the only visible copy of a message
   * away; the clear fires exactly when this cycle turns a hidden column into a standing one.
   */

  /**
   * Both answers at the CURRENT width (round 3). What is remembered across cycles is the previous LAYOUT, never its
   * answer: this effect re-runs only when the layout changes, so a remembered boolean describes the viewport as it
   * was at the last cycle, and any resize since makes it a lie. The measured hole: mount classic at 1280 (column
   * standing, `false` remembered), resize to 800 where classic hides the column and a sheet legitimately opens, press
   * `w` — Zero at 800 stands both tiles, but the stale `false` reads the cycle as standing→standing and skips the
   * clear, leaving the sheet fixed over the very column it duplicates. Asking `readColumnHiddenFor` for BOTH layouts
   * evaluates both against the width the visitor is actually at (the function matches its media query at call time),
   * removing the time dependency that produced the bug.
   */
  const prevCycleLayout = useRef<"classic" | "zero" | null>(null);
  useEffect(() => {
    const before = prevCycleLayout.current;
    prevCycleLayout.current = theme.layout;
    if (before === null || before === theme.layout) return;
    if (readColumnHiddenFor(before) && !readColumnHiddenFor(theme.layout)) {
      setReaderFor(null);
      setScreenerFull(false);
    }
  }, [theme.layout]);

  /**
   * The Zero PUSH TIER, subscribed (review finding, round 2): the sheet's ARIA claim and the
   * lateral-exit gate below both follow this fact, and a render-time read goes stale when
   * `w` restamps the layout with the sheet still open, or a resize crosses 391/392.
   */
  const [pushTier, setPushTier] = useState(false);
  useEffect(() => {
    setPushTier(zeroPushTier());
    return watchZeroPushTier(setPushTier);
  }, []);

  /**
   * NARROW, SUBSCRIBED, for the reader's ARIA claim: the sheet is a full-page modal
   * only where the layout's reading column is off screen. At desktop widths it stands over
   * a place-view (folder, tag, history, triage, trash) with the rail operable beside it —
   * `aria-modal` there tells assistive tech that reachable chrome is unreachable.
   */
  const [narrowNow, setNarrowNow] = useState(false);
  useEffect(() => {
    setNarrowNow(readColumnHidden());
    return watchNarrow(setNarrowNow);
  }, []);

  /**
   * FOCUS LEAVES THE DRAWER WITH THE DRAWER (review finding, round 2): a summoned drawer can
   * hold real focus, and closing it (Escape, scrim, ≡) merely translates the rail off
   * canvas — focus would stay in invisible navigation and the zone would keep reporting
   * "rail". The selected row is where the walk came from; failing that, a blur releases
   * focus to the body, which IS the list zone by derivation.
   */
  const prevRailOpen = useRef(railOpen);
  useEffect(() => {
    const was = prevRailOpen.current;
    prevRailOpen.current = railOpen;
    if (!was || railOpen) return;
    const rail = document.querySelector(".rail");
    const el = document.activeElement;
    if (rail && el instanceof HTMLElement && rail.contains(el)) {
      const row = document.querySelector<HTMLElement>(".view .row.sel");
      if (row) row.focus();
      else el.blur();
    }
  }, [railOpen]);

  /* The Zero sheet's lateral-exit gate: the PUSH tier only (review finding, round 2) — at
     the floating tier (≤391) Zero stands on classic's full-screen modal, whose one exit is
     Escape. `pushTier` is the subscribed fact above, so the gate follows `w` and resizes. */
  const zeroSheetUp = pushTier && readerFor != null;

  /**
   * NO CURSOR IS ITS OWN REASON — spread into every `message` binding below whose `disabled` begins `focused ==
   * null`. See `keymap.tsx#DisabledReason` and `placeCursor` above. EMPTY when a cursor exists, so a verb resting for
   * its own reason keeps falling through: `⇧R` on a message with nobody else on it, `⇧F` on a `no_forward` one or a
   * row the mirror does not hold, `d` with the folders foundation off. Placing a cursor for one of those would show a
   * sentence promising a second press that cannot work. NOT on `f`, `mod+Enter` or the two Zero exits: none of them
   * rests on a cursor (an empty Answer Later pile, no run in flight, no reply open, no sheet up), and `p` is an `app`
   * verb — the dispatcher's rule is scoped to `message` for exactly that reason.
   */
  const noCursor = focused == null ? ({ disabledReason: "no_cursor" } as const) : {};

  /* ── the global key map. Views declare their own; see `keymap.tsx` for precedence. ── */
  const globalKeys: KeyBinding[] = [
    { chord: "g o", group: "navigate", label: t("shortcuts.goOhbox"), run: () => go("ohbox") },
    { chord: "g r", group: "navigate", label: t("shortcuts.goReads"), run: () => go("reads") },
    { chord: "g e", group: "navigate", label: t("shortcuts.goReceipts"), run: () => go("receipts") },
    { chord: "g s", group: "navigate", label: t("shortcuts.goScreener"), run: () => go("screener") },
    /* ── THE REST OF THE `g` LEADER (the ohmarchy keymap, Phase 1) ──────────────────────
       The prototype's grammar reaches every place through `g`; the shipping leader stopped
       at five. The three triage horizons take the pile's own initial (Later / Parked /
       resurface-Back — the prototype's letters), and the three app places take theirs
       (`g ,` for Settings is the editor convention the prototype adopted). Two prototype
       rows are deliberately NOT here: `g c` said Receipts, but `g e` shipped first and c
       is Compose everywhere else in the app — the shipping key wins; and `g /` duplicated
       `/`, which is already global — a second spelling would be sheet noise, not grammar. */
    { chord: "g l", group: "navigate", label: t("shortcuts.goLater"), run: () => goTriage("reply") },
    { chord: "g p", group: "navigate", label: t("shortcuts.goParked"), run: () => goTriage("aside") },
    { chord: "g b", group: "navigate", label: t("shortcuts.goResurface"), run: () => goTriage("resurface") },
    { chord: "g d", group: "navigate", label: t("shortcuts.goDrafts"), run: () => go("drafts") },
    { chord: "g h", group: "navigate", label: t("shortcuts.goHistory"), run: () => go("history") },
    /* `g t` — the destination-row rule: ONE message for the chord, the palette row and the `?`
       sheet, so the three lists of the same instruction cannot drift by a word. `disabled` where
       the client has no Trash transport (the demo), which keeps the sheet LISTING it — "a
       shortcut that vanishes from the documentation when the list is empty is a shortcut nobody
       learns" — with the reason on the row. */
    {
      chord: "g t",
      group: "navigate",
      label: t("shortcuts.goTrash"),
      disabled: !engine.trashAvailable(),
      disabledReason: "trash_unavailable",
      run: () => go("trash"),
    },
    { chord: "g ,", group: "navigate", label: t("shortcuts.goSettings"), run: () => go("settings") },
    { chord: "/", group: "navigate", label: t("shortcuts.search"), run: () => go("search") },
    {
      /* Pull new mail — the doorbell's own verb, from the keyboard. The SAME single-flight
         `pull` the two PullNewMail buttons press, so the latch, the settle watch and the
         honest toast apply identically; `available` is the binding's own gate (demo and
         cloudless builds render no doorbell, and the key disappears with the button). */
      chord: "p",
      group: "app",
      label: t("shortcuts.pull"),
      disabled: !pullBinding.available || pullBinding.pulling,
      run: () => pullBinding.pull(),
    },
    { chord: "c", group: "app", label: t("shortcuts.compose"), run: () => go("compose") },
    {
      chord: "f",
      group: "message",
      label: t("shortcuts.replyRun"),
      disabled: piles.replyLater.length === 0,
      run: () => {
        setFrPending(true);
        go("triage");
      },
    },
    {
      chord: "r",
      group: "message",
      label: t("shortcuts.reply"),
      /**
       * LIVE WHEREVER THE PILL THAT ADVERTISES IT IS — which is `focused`'s whole contract. This was `route.view !==
       * "ohbox" || selectedOhbox == null`, so a message opened out of Search rendered a Reply pill printing `r` (the
       * pill reads this registry, and a disabled binding still owns its chord) over a key that did nothing. The
       * reader sheet IS a message pane; a verb pressed while it is open acts on the message being read — the rule
       * `focused` already states. On the two skim streams the key takes the card button's own path
       * (`onStreamAction`), which raises the reader first so the editor has a pane to land in. A TOGGLE, as before:
       * `r` on the open editor closes it.
       */
      disabled: focused == null,
      ...noCursor,
      run: () => {
        if (!focused) return;
        if (readerMessage != null || route.view === "ohbox") toggleReply(focused.id);
        else onStreamAction("reply", focused);
      },
    },
    {
      // `shift+r` — the shifted variant of the verb it widens, the convention `shift+u`
      // already set. Inert wherever `r` is, and ADDITIONALLY on a message whose audience is
      // the sender alone: `replyAllRecipients` is the bar's own visibility predicate, so the
      // key and the button appear and disappear together.
      chord: "shift+r",
      group: "message",
      label: t("shortcuts.replyAll"),
      disabled: focused == null || replyAllRecipients(focused, ownAddresses) === null,
      ...noCursor,
      run: () => {
        if (!focused) return;
        if (readerMessage != null || route.view === "ohbox") toggleReply(focused.id, true);
        else onStreamAction("reply_all", focused);
      },
    },
    {
      /**
       * Forward — `⇧F`, and not the `f` a mail client usually gives it: `f` is taken, by the Reply Run over the
       * Answer Later pile, and moving a shipped chord is the more expensive change. `⇧F` is the shifted variant of a
       * bare letter that already means something adjacent — the convention `⇧R` and `⇧U` set — and the `?` sheet
       * prints it beside `r` and `⇧R`. Its `disabled` reads the ONE predicate the bar's button reads
       * (`forwardOffered`), so key and control cannot disagree; a `no_forward` message asks and an off-mirror row
       * fetches its body inside `openForward`. Not a toggle — a second-press-closes verb would swallow the ask.
       */

      /**
       * Where it is live: `focused` is the reader (over any view), the Ohbox, Reads and
       * Receipts. On a wide split in Triage, Folder, Tag or History the message on screen is
       * that view's own local cursor, which the shell cannot see — so this binding is inert
       * there while the pill still prints the keycap. Not specific to Forward: `r`, `⇧R`, `a`,
       * `e`, `b`, `s`, `t`, `m` and `d` are all inert on those views for the same reason, and
       * `TriageView` already fixes it by declaring its own bindings over `shown`; Forward joins
       * that list THERE. Folder, Tag and History declare no message verbs at all — a
       * pre-existing gap across every verb, not this one's to close.
       */
      chord: "shift+f",
      group: "message",
      label: t("shortcuts.forward"),
      disabled: !forwardOffered(focused),
      ...noCursor,
      run: () => {
        if (!focused) return;
        if (readerMessage != null || route.view === "ohbox") openForward(focused.id, focused);
        else onStreamAction("forward", focused);
      },
    },
    {
      /* SEND, INSIDE THE REPLY RUN. The overlay's Done button and this chord are one path —
         the run below mirrors `onDone` (AppShell's FocusReplyOverlay wiring) verbatim, so
         the no-message refusal and the shared scratch buffer behave identically. Declared
         BEFORE the inline reply's `mod+Enter` because the run's overlay stands over
         everything while it is open; both are `disabled`-gated on disjoint states, so the
         dispatcher's first-enabled rule is what actually decides. `inInput` for the same
         reason as the reply's: the run's editor holds focus, which is the whole use case. */
      chord: "mod+Enter",
      group: "message",
      label: t("shortcuts.frSend"),
      inInput: true,
      disabled: fr == null || fr.step >= fr.items.length,
      run: () => {
        if (!fr || fr.step >= fr.items.length) return;
        const item = fr.items[fr.step]!;
        if (!item.messageId) return;
        const v = frValues[frKeyOf(item)] ?? EMPTY_RICH;
        mailSend.send({
          kind: "mail_send",
          inReplyTo: item.messageId,
          body: v.text,
          ...(v.html ? { html: v.html } : {}),
        });
      },
    },
    {
      // SENDING FROM THE KEYBOARD. `inInput` is not optional: the editor takes focus the moment it opens, so without
      // it the one place the shortcut is for is the one place it would not fire — the same reasoning Escape's binding
      // already carries. `mod+Enter` and not bare `Enter`, because the field is a multi-line editor where Enter is a
      // new paragraph. The four views bind bare `Enter` as "open the row" and none of them sets `inInput`, so the
      // typing guard already keeps them out of this editor (`isTypingTarget` answers true for a `contenteditable` as
      // it did for the textarea); this chord does not collide with any of them. The rich editor does not swallow it.

      // TipTap binds `Mod-Enter` to a line break, and `RichEditor` skips that binding for this chord, so the event is not
      // consumed and reaches the document listener this registry hangs on — which is why the chord stays here rather
      // than being reimplemented inside the editor's own `onKeyDown`. It calls the same `sendReply` the button does,
      // so the send lock, the empty-body guard and the whole failure surface apply identically — there is no second
      // path to SMTP.
      chord: "mod+Enter",
      group: "message",
      label: t("shortcuts.sendReply"),
      inInput: true,
      disabled: replyTo == null,
      run: () => replyTo && sendReply(replyTo),
    },
    {
      /* SEND + DONE from the keyboard — the shifted variant of the verb it widens, the
         convention `shift+r` and `shift+f` already follow. `inInput` for `mod+Enter`'s reason:
         the editor holds focus. DISABLED where the second action is not offered, so the chord
         cannot reach a release the button is not showing — one rule, two doors. */
      chord: "mod+shift+Enter",
      group: "message",
      label: t("shortcuts.sendReplyAndDone"),
      inInput: true,
      disabled: replyTo == null || sendAndDonePlanFor(presented, replyTo) === null,
      run: () => replyTo && pressSendAndDone(replyTo),
    },
    {
      chord: "s",
      group: "message",
      label: t("shortcuts.screen"),
      disabled: focused == null,
      ...noCursor,
      run: () => {
        if (!focused) return;
        openSenderMenu(
          focused.id,
          document.querySelector<HTMLElement>(`.view .row[data-id="${CSS.escape(focused.id)}"]`),
        );
      },
    },
    {
      // `f` starts a Reply Run over the Answer Later pile, and until this binding there
      // was NO keyboard way to put anything INTO that pile — `later` was reachable only from
      // the reader's action menu. A keyboard user could start a run they could not fill, and
      // `f` sat permanently `disabled` for them. Found while writing the guard for it, which is
      // blocked on exactly this.
      //
      // `a` for Answer, next to the pile's own name. Free: the bound set was
      // ? / b c e f r s, `g`-prefixed jumps, mod+k and Escape.
      chord: "a",
      group: "message",
      label: t("shortcuts.answerLater"),
      disabled: focused == null,
      ...noCursor,
      run: () => focused && onMessageAction("later", focused),
    },
    {
      chord: "e",
      group: "message",
      // ohmail has no Archive: "out of the way, still here" is the Park pile. Naming it
      // Park rather than Archive is the honest mapping, not a missing feature.
      label: t("shortcuts.park"),
      disabled: focused == null,
      ...noCursor,
      run: () => focused && onMessageAction("aside", focused),
    },
    {
      chord: "b",
      group: "message",
      label: t("shortcuts.resurface"),
      disabled: focused == null,
      ...noCursor,
      run: () => focused && onMessageAction("resurface", focused),
    },
    {
      /* MOVE — opens the bar's destination strip on the focused message (`barPanel`, the
         chrome-held state every mount of that bar renders), where the pane lands focus on
         the first destination so `m` then ↵ files. A toggle, the `r` convention. Declared
         HERE, not in the bar, so the sheet documents it even while nothing is open. */
      chord: "m",
      group: "message",
      label: t("shortcuts.move"),
      disabled: focused == null,
      ...noCursor,
      run: () => {
        if (!focused) return;
        setBarPanel((p) =>
          p?.panel === "move" && p.messageId === focused.id
            ? null
            : { messageId: focused.id, panel: "move" },
        );
      },
    },
    {
      /**
       * DELETE — the prototype's two-press ceremony: the first `d` ASKS (the same confirm strip the ⋯ menu opens,
       * focus landing on Cancel), the second CONFIRMS by clicking the strip's own danger button — the ONE dispatch
       * site of `"delete"` stays that button, so a gate closing under the ask cannot ghost-delete (gate gone ⇒ strip
       * gone ⇒ nothing to click). The gate is the strip's own render gate (the mirror holds the row), so the sheet
       * never advertises a delete the bar would refuse to draw. THIS `disabled` IS WHAT THE `?` SHEET PRINTS, so it
       * is half the defect and not a mirror of it: with "Use folders" off the sheet drew this row greyed and the
       * strip could not be opened at all, while the same verb over a selection worked. It reads the verb reader alone
       * now, exactly like `canDeleteMessage` above and the strip itself.
       */
      chord: "d",
      group: "message",
      label:
        barPanel?.panel === "delete" ? t("shortcuts.deleteConfirm") : t("shortcuts.deleteAsk"),
      disabled:
        focused == null
        || engine.verbRead().get<EngineMessage>("message", focused.id) == null,
      ...noCursor,
      /* A HELD KEY IS ONE PRESS. Key auto-repeat would otherwise walk the whole ceremony on
         its own — the first repeat opens the ask, a later repeat confirms it — turning a
         finger resting on `d` into an un-undoable delete (review finding, round 1). The
         second press of the ceremony must be a second PHYSICAL press. */
      when: (e) => !e.repeat,
      run: () => {
        if (!focused) return;
        if (barPanel?.panel === "delete" && barPanel.messageId === focused.id) {
          document.querySelector<HTMLButtonElement>(".abar-delete .abar-danger")?.click();
        } else {
          setBarPanel({ messageId: focused.id, panel: "delete" });
        }
      },
    },
    /**
     * BACKSPACE AND DELETE — the keys the mail apps everybody arrives from already use, filing the focused message to
     * Trash in one press with Undo in the toast. They are not a second delete: both run `onMessageAction("delete",
     * …)`, the ONE dispatch site `d`'s confirm button also reaches, so there is one ceremony, one refusal and one
     * sentence. WHY THEY DO NOT ASK FIRST, WHILE `d` DOES. `d`'s two-press ceremony exists because a delete used to
     * be unrecoverable the instant it dispatched. It is not any more — the press opens an undo window
     * (`delete-undo.ts`) — so a key whose whole point is one press does not need a strip in front of it. `d` keeps
     * its ask because a keycap on a bar button that deletes on a single press is a different promise; both now land
     * in the same window.
     */

    /**
     * The gate is `d`'s own, deliberately: the sheet must not advertise on one row a delete the row beside it would
     * refuse to draw. It is the verb reader holding the row and nothing else — see `canDeleteMessage` for why "Use
     * folders" stopped being a term.
     */
    ...deleteKeyBindings({
      focused,
      label: t("shortcuts.deleteKey"),
      canDelete:
        focused != null
        && engine.verbRead().get<EngineMessage>("message", focused.id) != null
        /* NOT IN TRASH. The message is already there, so ⌫ has nothing to move it to, and
           deleting twice is not a thing this product can do — it never erases mail. Refused as
           `disabled` (with the reason, which the `?` sheet prints on the row) rather than by
           withholding the binding: withholding it would let the key fall through to whatever is
           behind, and would take the two keycaps out of the documentation exactly where a reader
           is most likely to reach for them. */
        && route.view !== "trash",
      disabledReason: "no_erase",
      run: (m) => onMessageAction("delete", m),
    }),
    /* ⇧⌫ — RESTORE, and only in Trash. The mirror image of ⌫: the key that removes mail from a
       pile is the key that brings it back from the bin, one modifier apart, so the two are one
       gesture to learn. Listed at every route so the sheet documents it (the rule above), inert
       everywhere else with no reason attached — a key that is simply not applicable here needs
       no sentence, where one that CANNOT EVER work does. */
    {
      chord: "shift+Backspace",
      group: "message",
      label: t("trash.restoreKey"),
      disabled: route.view !== "trash" || focused == null,
      /* A HELD KEY IS ONE PRESS, and a question on screen owns the key — `deleteKeyBindings`'
         own two `when` conditions, for its own two measured reasons: Backspace repeats faster
         than any key somebody leans on, and `isModalOpen` is a DOM read that cannot be a
         `disabled` flag because the More menu opens without the shell re-rendering. */
      when: (e) => !e.repeat && !isModalOpen(e.view?.document ?? document),
      run: () => {
        if (focused) onMessageAction("restore", focused);
      },
    },
    {
      chord: "mod+k",
      group: "app",
      label: t("shortcuts.palette"),
      inInput: true,
      run: () => palette.toggle(),
    },
    /* LEAVE-THE-READER, the Zero sheet's lateral exit (review finding, round 1): under zero the
       sheet is the one-tile bands' reading SLOT, and `h`/← toward the list must mean "put
       the list back" — §12's one meaning, where classic's sheet (a true modal) rightly
       cedes ← and keeps Escape. Registered here because closing the sheet is shell state;
       zone-nav's own ← stays gated by `noReaderOverlay` and these win the dispatch first.
       Escape is unchanged (the overlay ladder already closes the sheet). */
    {
      chord: "ArrowLeft",
      group: "navigate",
      label: t("shortcuts.zoneList"),
      disabled: !zeroSheetUp,
      // The drawer outranks the sheet while it holds focus (review finding, round 2): with
      // both standing, ← belongs to the drawer walk, not to closing the reader behind it.
      when: () => currentZone() !== "rail",
      run: () => setReaderFor(null),
    },
    {
      chord: "h",
      group: "navigate",
      label: t("shortcuts.zoneList"),
      disabled: !zeroSheetUp,
      when: () => currentZone() !== "rail",
      run: () => setReaderFor(null),
    },
    {
      chord: "w",
      group: "app",
      label: t("shortcuts.layout"),
      run: cycleLayout,
    },
    /* ONE UNDO KEY FOR EVERY VERB (the 0.20 review): presses the live toast's own offer — the same
       consumed-once arm the button fires — and does nothing once the window has closed, because
       claiming an undo that did not happen is the Screener's own forbidden shape. */
    {
      chord: "z",
      group: "app",
      label: t("shortcuts.undo"),
      run: () => { runArmedUndo(); },
    },
    {
      chord: "?",
      group: "app",
      label: t("shortcuts.sheet"),
      inWriting: true, // the sheet moves no mail, and it is where Compose's own chords are documented
      run: () => setShortcutsOpen((o) => !o),
    },
    /* Escape is NOT here. It is registered above, in the `overlay` scope, because an open
       overlay has to outrank a view's bindings and a global one does not. */
  ];
  useKeyBindings(globalKeys, "global");

  /* ── which settings panes this surface offers — one list with the nav (`settings-panes.ts`).
     The flags mirror the `SettingsView` section props below (search `mailboxSection=`): a node
     the props withhold is a pane the palette must not name. `WiredPanes` is total, so a pane
     added to `settingsPanes` refuses to compile here until this record answers for it. ── */
  const settingsWired: WiredPanes = useMemo(() => ({
    mailboxes: !demo && mailboxSection != null,
    // Non-demo always: the pane's default node is built into the props (`?? <ScreeningSection />`).
    screener: !demo,
    ai: !demo && aiSection != null,
    away: !demo && awaySupported,
    // The rules prop is always handed over (engine mutations, demo included) — the pane always exists.
    rules: true,
    folders: !demo && consent.known && consent.foldersStorable,
    signatures: !demo && consent.signaturesKnown && facts != null && facts.length > 0,
    desktop: desktopSection ? desktopSection.label : null,
    devices: !demo && devicesSection != null,
    billing: !demo && billingSection != null,
    invites: !demo && invitesSection != null,
    security: !demo && securitySection != null,
    account: !demo && accountSection != null,
    // The demo gets its own About node (two true sentences about the fixture world).
    about: demo || aboutSection != null,
  }), [demo, mailboxSection, aiSection, awaySupported, consent.known, consent.foldersStorable, consent.signaturesKnown, facts, desktopSection, devicesSection, billingSection, invitesSection, securitySection, accountSection, aboutSection]);

  /* ── the palette command map (every command from the prototype) ── */
  const commands: Command[] = useMemo(() => {
    const list: Command[] = [
      /* THE DESTINATION ROWS READ THE REGISTRY'S OWN WORDING (`shortcuts.*`), not a second copy
         of it. The palette and the `?` sheet are two lists of the same instruction, and while
         each had its own message they drifted: the palette said "Go to Ohbox" and the sheet said
         "Go to the Ohbox", one word apart, reported as the two lists disagreeing. Reads and
         Receipts were byte-identical twins waiting to do the same thing. One message per
         destination, in the namespace the binding labels live in. */
      { id: "go-ohbox", label: t("shortcuts.goOhbox"), keys: ["g", "o"], run: () => go("ohbox") },
      { id: "go-reads", label: t("shortcuts.goReads"), keys: ["g", "r"], run: () => go("reads") },
      { id: "go-receipts", label: t("shortcuts.goReceipts"), keys: ["g", "e"], run: () => go("receipts") },
      { id: "go-screener", label: t("palette.openScreener"), keys: ["g", "s"], run: () => go("screener") },
      { id: "scn-screened", label: t("palette.screenerScreened"), run: () => goScreener("screened") },
      { id: "scn-spam", label: t("palette.screenerSpam"), run: () => goScreener("spam") },
      {
        id: "fr",
        label: t("palette.startFR"),
        keys: ["f"],
        run: () => {
          setFrPending(true);
          go("triage");
        },
      },
      { id: "search", label: t("palette.search"), keys: ["/"], run: () => go("search") },
      { id: "compose", label: t("palette.newMessage"), keys: ["c"], run: () => go("compose") },
      {
        /* THE DESTINATION ROW, reading the registry's own wording (`shortcuts.goTrash`) exactly
           as the four rows above it do — one message per destination, in the namespace the
           binding labels live in. Declared `disabled` where the client has no Trash transport
           rather than silently absent: a row that is missing teaches nothing, and a row that
           says why is how somebody learns the demo has no mailbox behind it. */
        id: "go-trash",
        label: t("shortcuts.goTrash"),
        keys: ["g", "t"],
        disabled: !engine.trashAvailable(),
        run: () => go("trash"),
      },
      { id: "settings", label: t("palette.openSettings"), run: () => go("settings") },
      /* EVERY SETTINGS TAB, from the settings' own list — a new pane added to `settingsPanes`
         reaches the palette by construction (see `settingsWired` above). The fastest path to
         any setting becomes typed, and only panes this surface offers are named: a row onto a
         pane that would clamp away is a false affordance, not a shortcut. */
      ...settingsPanes(settingsWired, (key) => t(`settings.${key}`)).map(
        ([paneId, name]): Command => ({
          id: `set-${paneId}`,
          label: t("palette.settingsPane", { name }),
          run: () => goSettings(paneId),
        }),
      ),
    ];
    /* THE TWO ROWS THAT ACT ON THE OPEN MESSAGE, and they say so when there is none.
       Both bodies were already `if (selectedOhbox)`, so with nothing open the row ran and
       nothing happened — a command that answers a click with silence. The keyboard twins
       have always declared it (`t` in `OhboxView`, `b` below, both `disabled` on an absent
       selection); these are the same commands reached the other way, so they carry the same
       declaration rather than a second opinion about when they work. */
    tags.forEach((tag, i) => {
      list.push({
        id: `tag-${tag.id}`,
        label: t("palette.tagToggle", { name: tag.name }),
        icon: "tag",
        ...(i === 0 ? { keys: ["t"] } : {}),
        disabled: selectedOhbox == null,
        run: () => {
          if (selectedOhbox) {
            toggleTag(selectedOhbox.id, tag.id, !selectedOhbox.labels.includes(tag.id));
          }
        },
      });
    });
    for (const tag of tags) {
      list.push({
        id: `goto-tag-${tag.id}`,
        label: t("palette.goTag", { name: tag.name }),
        icon: "tag",
        run: () => goTag(tag.id),
      });
    }
    /* Three direct entries, not one cycling verb: "Toggle light / dark" would lie with three
       states, and a palette entry is where somebody goes to reach a state by name. */
    list.push({ id: "theme-light", label: t("palette.themeLight"), run: () => theme.setTheme("light") });
    list.push({ id: "theme-dark", label: t("palette.themeDark"), run: () => theme.setTheme("dark") });
    list.push({ id: "theme-auto", label: t("palette.themeAuto"), run: () => theme.setTheme("system") });
    /* The demo's own ruling for layout controls: "palette and hotkeys only" — no rail
       button, no Settings row (named in the 3b close-out). */
    list.push({ id: "layout", label: t("palette.cycleLayout"), keys: ["w"], run: cycleLayout });
    list.push({
      id: "resurface",
      label: t("palette.resurfaceSel"),
      keys: ["b"],
      disabled: selectedOhbox == null,
      run: () => {
        if (selectedOhbox) onMessageAction("resurface", selectedOhbox);
      },
    });
    return list;
  }, [t, tags, selectedOhbox, toggleTag, theme, onMessageAction, startFR, engine, settingsWired, goSettings]);

  /**
   * THE ONE NUMBER A NATIVE SHELL IS TOLD — see `AppShell`'s `onUnread`.
   *
   * Published from the same value the Ohbox's rail row renders, so the dock icon and the rail
   * can never disagree about how much is waiting. In an effect rather than during render because
   * the consumer is outside React: it puts a badge on a window, and doing that while rendering is
   * a side effect in the middle of one.
   */
  useEffect(() => {
    onUnread?.(ohbox.newForYou.length);
  }, [onUnread, ohbox.newForYou.length]);

  /* ── the rail ── */
  const railGroups: RailGroup[] = useMemo(
    () => [
      {
        items: [
          {
            id: "ohbox",
            label: t("rail.ohbox"),
            count: ohbox.newForYou.length,
            hot: true,
            title: t("rail.ohboxTitle", {
              unread: ohbox.newForYou.length,
              total: ohboxCount,
            }),
          },
          /* The streams count "new since last visit" — the fresh side of each view's own
             waterline — never unread. See the `readsNew` derivation for the whole argument. */
          {
            id: "reads",
            label: t("rail.reads"),
            count: readsNew,
            title: t("rail.readsTitle", { count: readsNew }),
          },
          {
            id: "receipts",
            label: t("rail.receipts"),
            count: receiptsNew,
            title: t("rail.readsTitle", { count: receiptsNew }),
          },
        ],
      },
      {
        items: [
          {
            id: "screener",
            label: t("rail.screener"),
            count: screener.waitingCount,
            hot: true,
            title: t("rail.screenerTitle", { count: screener.waitingCount }),
          },
        ],
      },
      {
        /* NO HEADING over the three horizons — owner decision, 2026-08-22 (FOLDERS-SPEC.md
           §16.4): the group's spacing differentiates it, exactly as it does for the Ohbox and
           Screener groups above. The `rail.triage` KEY is deliberately still in both catalogues —
           `viewTitles` below titles the mobile view with it, so the locale files keep their
           shape. */
        items: [
          { id: "triage", label: t("rail.replyLater"), count: piles.replyLater.length },
          { id: "triage-aside", label: t("rail.setAside"), count: piles.setAside.length },
          { id: "triage-resurface", label: t("rail.resurface"), count: piles.resurface.length },
        ],
      },
      // TAGS ARE THEIR OWN GROUP, not a sub-item of Triage. They were nested under it, which
      // said the wrong thing about what they are: triage piles are three fixed places a
      // message can sit, and tags are a cross-cutting dimension over every view. Filing the
      // second under the first made tags read as a fourth pile. Own group, own label, and it
      // stands even when empty — a collapsed group with a count of zero is how someone learns
      // the feature exists. (This comment used to quote "Tags (never folders)"; that invariant
      // was deliberately relaxed on 2026-08-22 — tags stay cross-cutting, and the mailbox's own
      // FOLDERS became an optional, off-by-default sibling group directly below.)
      {
        // No group label: `TagsGroup` renders its own heading, so setting both printed
        // "Tags" twice in the rail. Caught in the live walkthrough.
        items: [],
        tags: {
          label: t("rail.tags"),
          defaultOpen: true,
          // `open` / `onOpenChange` are injected by `ShellRail`, which owns the persisted collapse
          // flag. They are deliberately NOT here: this object is memoized without `tagsOpen` in its
          // deps, so a value read here would freeze — the stale-`open` half of the ~5s bug. Keeping
          // them out also keeps the flag off this top-level component, so a toggle never re-renders
          // the view. `RailNav` stays uncontrolled-by-default for the Desktop, which has no storage.
          items: tagGroups.map((g) => ({
            id: g.tag.id,
            label: g.tag.name,
            hue: hueOf(g.tag),
            count: g.messages.length,
          })),
          /* "New tag" is a first-class inline affordance now, not a data row and not a dialog:
             `RailNav` owns a `+ New tag` trigger that swaps for an input IN PLACE, plus an
             empty-state invite when there are no tags yet. The duplicate check stays HERE
             because the server's unique index is on `lower(name)` — offering a name that already
             exists would promise a tag the server answers 409 for — and it runs against the
             WHOLE tag set (`tags`), so a tag that sits on no message still blocks its own name.
             `createTagAlone` is the standalone `tag_create` verb: no message, unlike the picker's
             tag-or-create, which is exactly the thing the sidebar does not have to hand. */
          create: {
            label: t("rail.tagNew"),
            placeholder: t("tag.newPlaceholder"),
            emptyHint: t("rail.tagEmpty"),
            onCreate: createTagAlone,
            duplicate: {
              taken: (name: string) =>
                tags.some((tg) => tg.name.toLowerCase() === name.toLowerCase()),
              label: (name: string) => t("tag.newTaken", { name }),
            },
          },
        },
      },
      /* FOLDERS — the mailbox's own folders, DIRECTLY BELOW TAGS, collapsible, unnumbered
         (FOLDERS-SPEC.md §3 "the rail"; owner decision 3). Rendered ONLY while "Use folders"
         is on: spread conditionally rather than as an empty group, so a flag-off rail is
         BYTE-IDENTICAL to the pre-feature rail — no extra `.rgroup`, nothing — which is the
         parity claim `test/folders-rail.test.tsx` pins. The group is a host-authored subtree
         (`RailGroup.custom`) because its shape — a tree with an opened-set, roll-up counts,
         mailbox sections, a filter past twelve roots — is this feature's, not the design
         system's; it renders in the rail's own vocabulary. `numberNav` reads `items`, so the
         group contributes nothing to the number keys, exactly as Tags does. */
      ...(consent.foldersEnabled
        ? [{
            items: [],
            custom: (
              <FoldersRailGroup
                folders={folders}
                unread={folderUnread}
                verbs={demo ? undefined : folderVerbs}
                accountMailboxes={demo ? undefined : folderMailboxes}
                /* What this list does NOT hold, and where that mail is (JUNK-INVISIBLE). */
                junkSaid={junkSaid}
                junkReadable={junkReadable}
                /* The third render (the folder-delivery review): with the flag ON and ZERO
                   entities, "no folders on your server" and "the first drain has not finished"
                   are different sentences — `bootstrapping` is exactly that window, and
                   `consent.known` false is the same window for the flag itself (a cache-painted
                   boot). Unsettled renders the skeleton; settled-and-empty renders the honest
                   empty line. The flag-OFF render stays the spread above: no group at all. */
                settled={consent.known && !syncStatus.bootstrapping}
                /* The ACCOUNT's mailbox count, not the entity-derived one: two connected
                   mailboxes where only one has folders still section, or the lone tree is
                   ambiguous (spec §14). `facts` is the host's probe; null (demo, standalone)
                   falls back to what the entities show. */
                mailboxCount={facts?.length}
                activeFolderId={route.view === "folder" ? (route.folderId ?? undefined) : undefined}
                onNavigate={(id) => {
                  setRailOpen(false);
                  goFolder(id);
                }}
              />
            ),
          }]
        : []),
      /**
       * TRASH, WHILE YOU ARE IN IT: A `custom` group spread into the rail ONLY while Trash is the route, positioned
       * after the Folders group (after Tags when folders are off) and before the dock — the rail's lower part. It
       * disappears the moment the route leaves, because the memo's deps carry `route.view` and the group is a
       * conditional spread rather than a hidden node: outside Trash the rail is BYTE-IDENTICAL to today, no extra
       * `.rgroup`, nothing — the parity shape `test/folders-rail.test.tsx` already pins for the Folders group, pinned
       * again for this one. `items: []`, so `numberNav` reads nothing here and the digits are unchanged. A place
       * reached by ⌘K and `g t` does not earn a number, and taking one would renumber every pile below it while
       * somebody is standing in Trash.
       */
      ...(route.view === "trash"
        ? [{
            items: [],
            custom: (
              <div className="rgroup rsub trash-rail" data-testid="rail-trash">
                <div className="frow">
                  {/* The twisty column as an empty SPACER, exactly as a leaf folder row uses
                      it: it is what makes this label align with the folder labels above rather
                      than sitting 14px to their left. */}
                  <span className="ftw" />
                  <button
                    type="button"
                    className="ritem on"
                    aria-current="page"
                    data-rail-id="trash"
                    title={t("rail.trashTitle")}
                    onClick={() => {
                      setRailOpen(false);
                      go("trash");
                    }}
                  >
                    <Icon name="folder" className="fglyph" />
                    <span className="flabel">{t("rail.trash")}</span>
                    {/* THE PAGE'S ROW COUNT, and never "hot": nothing in Trash is new for
                        anybody, and an accent number here would read as a demand. Empty while
                        the first page is in flight — a `0` would claim the bin is empty before
                        the server has answered. */}
                    <span className="cnt num">
                      {trashPage.items.length > 0 ? trashPage.items.length : ""}
                    </span>
                  </button>
                </div>
              </div>
            ),
          }]
        : []),
      {
        items: [
          /**
           * HISTORY CARRIES NO COUNT, AND THAT IS A PROPERTY RATHER THAN A STYLE CHOICE. A sender with ANY unread
           * mail is active whatever its age, so nothing unread can reach History — the engine's cutline guarantees it
           * by construction. A place that cannot contain anything unread has nothing to demand, so a badge here would
           * be a number that is always the size of the past and never a call to act. `count` is therefore ABSENT
           * rather than zero: `RailNav` renders an absent count as nothing at all, and a literal `0` would draw a
           * badge saying nothing is there. `rail-history.test.tsx` asserts the key is missing, because a future edit
           * adding `count: history.length` would look like an improvement.
           */
          { id: "history", label: t("rail.history"), title: t("rail.historySubtitle") },
          { id: "search", label: t("rail.search"), kbdHint: "/" },
          /* DRAFTS CARRIES A COUNT and History deliberately does not, and the difference is what
             the number would mean. History's count would be the size of the past — always there,
             never a call to act. A draft is an unfinished thing this account started, so the
             count is exactly a call to act, and zero of them is a row worth having anyway: it is
             how somebody learns their half-written mail is on the account rather than in one
             browser. `count` is therefore present even at zero, unlike History's absent key. */
          { id: "drafts", label: t("rail.drafts"), count: drafts.length },
          { id: "settings", label: t("rail.settings") },
        ],
      },
    ],
    [
      t, ohbox.newForYou.length, ohboxCount, readsNew, receiptsNew, screener.waitingCount, piles,
      tagGroups, tags, createTagAlone, consent.foldersEnabled, consent.known, folders,
      folderUnread, folderVerbs, folderMailboxes, demo, syncStatus.bootstrapping, route.view,
      route.folderId, facts,
      /* The junk note at the folders group's foot — `facts` above is its SOURCE, not its value:
         the derivation collapses many rows to one answer, so the memo must watch the answer. */
      junkSaid, junkReadable,
      /* The count the transient entry renders. `route.view` is already here (the spread's own
         condition), so this is the only new dependency the entry needs. */
      trashPage.items.length,
    ],
  );

  /**
   * THE NUMBER KEYS: `1`…`N` reach the piles in the order the rail lists them. Requested as navigation that does not
   * need the mouse and does not need a two-key sequence — `g o` / `g r` / `g e` / `g s` already exist but only cover
   * four destinations and none of the triage horizons. DERIVED FROM THE RAIL, NOT WRITTEN OUT BESIDE IT: The numbers
   * ARE the menu order, so they are read off `railGroups` rather than declared in a parallel list. A hand-written
   * table would be a second enumeration of the nav — the shape the (i) panel's hand-typed key list had, and the one
   * the `?` sheet is generated to avoid — and it would go wrong the first time a group gained an item. Only the PILES
   * are numbered: the three streams, the Screener and the three triage horizons. Tags is a collapsible group whose
   * contents are the user's own and change; Search has `/` and Settings is not somewhere you flick to.
   */

  /**
   * `slice(0, 9)` because there is no key `10` — a tenth pile would simply not be numbered rather than silently
   * shifting the rest.
   */
  const numberNav = useMemo(
    () =>
      railGroups
        .flatMap((g) => g.items)
        .filter((item) => PILE_IDS.includes(item.id))
        .slice(0, 9),
    [railGroups],
  );

  /**
   * Discoverability, without a badge on every row and without a message. A shortcut nobody knows about is not a
   * feature, and a badge on every row forever is clutter charged to every user so a few learn something once. Two
   * layers, both quiet: the `?` sheet lists them, free, because the bindings declare their own labels and the sheet
   * is generated from the registry; and the row shows its keycap ON HOVER AND ON KEYBOARD FOCUS — `navKey` rides on
   * every numbered row, `RailNav` reveals it only under pointer or focus (and clears the reveal on click, so a tap
   * does not leave a keycap standing where a touch device has no pointer-leave to come). The `?` sheet also paints
   * every keycap at once while open (`kbdHint`, which wins over the per-row reveal — see `RailItem`): the moment
   * somebody asks "what are the keys", the answer belongs on the things as well as in the list.
   */

  /**
   * There used to be a third layer — a one-time dismissible strip after a handful of rail clicks — removed: a line of
   * chrome telling you a faster way exists is louder than the thing it points at, and the hover/focus keycap teaches
   * the same fact without a message.
   */
  const railGroupsWithHints = useMemo(
    () =>
      railGroups.map((g) => ({
        ...g,
        items: g.items.map((item) => {
          const n = numberNav.findIndex((x) => x.id === item.id);
          if (n < 0) return item;
          const key = String(n + 1);
          // `navKey` is the always-attached hover/focus reveal; `kbdHint` is the louder
          // all-at-once reveal the `?` sheet asks for. Both name the same key.
          return shortcutsOpen ? { ...item, navKey: key, kbdHint: key } : { ...item, navKey: key };
        }),
      })),
    [railGroups, numberNav, shortcutsOpen],
  );

  useKeyBindings(
    numberNav.map((item, i) => ({
      chord: String(i + 1),
      group: "navigate" as const,
      // THE SAME SENTENCE THE `g` CHORD USES for this place, so the sheet folds the two chords
      // into one row ("1 · g o  Go to the Ohbox") instead of listing every destination twice
      // under two spellings. A rail row with no `g` chord (a tag, a folder) keeps the generic
      // "Go to {pile}" over the rail's own label.
      label: PILE_CHORD_LABEL[item.id] ? t(PILE_CHORD_LABEL[item.id]!) : t("shortcuts.goPile", { pile: item.label }),
      /* A HELD DIGIT IS ONE NAVIGATION. Auto-repeat re-running a jump is never wanted — and
         it was exploitable across a boundary: hold `1` with compose's send-later picker
         open, the first press schedules and CLOSES the picker, and the repeats then fell
         through to THIS binding and navigated away from the message being scheduled
         (review finding, round 2). A repeat falls through to nothing (no digit is a
         sequence prefix), so it simply does not fire. */
      when: (e: KeyboardEvent) => !e.repeat,
      run: () => {
        // The SAME conversion the rail handler uses, from the same table. A `startsWith`
        // test here would be a second opinion about which rows are triage rows.
        const pile = TRIAGE_PILE_OF_RAIL[item.id];
        if (pile) goTriage(pile);
        else go(item.id as "ohbox");
      },
    })),
    "global",
  );

  const activeRailId =
    route.view === "folder"
      // A folder URL whose entity is missing (feature off, folder gone) renders the Ohbox —
      // so the rail highlights the Ohbox too, and the chrome never claims a view that is not
      // on screen. With the entity present the folder row itself carries the highlight.
      ? (openFolder ? undefined : "ohbox")
      : route.view === "tag"
      ? undefined
      : route.view === "triage"
        // The row for the pile that is actually open. Hard-coded to `"triage"` before, which
        // is why the rail lit Answer Later however you arrived.
        ? RAIL_OF_TRIAGE_PILE[route.triagePile]
        : route.view === "compose"
          ? undefined
          : route.view;

  const viewTitles: Record<string, string> = {
    ohbox: t("rail.ohbox"),
    reads: t("rail.reads"),
    receipts: t("rail.receipts"),
    screener: t("rail.screener"),
    triage: t("rail.triage"),
    history: t("rail.history"),
    search: t("rail.search"),
    compose: t("rail.compose"),
    drafts: t("rail.drafts"),
    settings: t("rail.settings"),
  };
  const mobileTitle =
    route.view === "tag"
      ? (tagGroups.find((g) => g.tag.id === route.tagId)?.tag.name ?? t("rail.tags"))
      : route.view === "folder"
        // The missing-folder fallback renders the Ohbox, so the title says Ohbox — the same
        // one-answer rule the rail highlight follows.
        ? (openFolder?.name ?? t("rail.ohbox"))
        : (viewTitles[route.view] ?? t("rail.ohbox"));

  /* ── views ── */
  const tagGroup =
    route.view === "tag" ? tagGroups.find((g) => g.tag.id === route.tagId) : undefined;
  /**
   * `"seed"` matches no view below, which is how the review screen TAKES the stage instead of
   * appearing above a pile. Stated here rather than by guarding each of the ten renders: a
   * condition repeated ten times is nine chances to forget it, and the tenth view added later
   * would render underneath the screen with nobody noticing.
   */
  const effectiveView = seedOwed
    ? "seed"
    : route.view === "tag" && !tagGroup
      ? "ohbox"
      : route.view === "folder" && !openFolder
        ? "ohbox"
        : route.view;

  /**
   * THE SWITCH MARK ENDS AT THE VIEW THE PRESS ASKED FOR, ON SCREEN — the other end of
   * `beginSwitch`, which the six navigation verbs start (`routing.ts`). It used to end two frames
   * after the press, which is the paint of the frame the press landed in: the view somebody was
   * LEAVING. `null` while the target still shows a placeholder, so a spinner never ends a switch;
   * each arm below is the condition its own view branches on — its rows, or `settled`, which is
   * what makes an empty list that view's answer rather than a list that has not arrived.
   */
  const viewOnScreen =
    effectiveView === "ohbox"
      ? mailState.settled
        || ohbox.resurfaced.length + ohbox.newForYou.length + ohbox.previouslySeen.length > 0
      : effectiveView === "reads"
        ? mailState.settled || partition.fresh.length + partition.seen.length > 0
      : effectiveView === "receipts" ? mailState.settled || receipts.length > 0
      /* The screener's settled is TWO facts since the first-derivation deferral: the mirror's,
         and the queue's own — a skeleton over an underived queue is not the pressed-for view. */
      : effectiveView === "screener"
        ? (mailState.settled && screener.queueSettled) || screener.waiting.length > 0
      : effectiveView === "triage"
        ? mailState.settled
          || piles.replyLater.length + piles.setAside.length + piles.resurface.length > 0
      : effectiveView === "tag" ? mailState.settled || (tagGroup?.messages.length ?? 0) > 0
      : effectiveView === "history" ? mailState.settled || history.length > 0
      : effectiveView === "drafts" ? mailState.settled || drafts.length + scheduled.length > 0
      /* The two views whose rows come off the SERVER rather than out of the mirror answer in
         their own vocabulary — `FolderView`'s empty gate and `TrashView`'s: rows, rows fetched
         past the window, or nothing more coming. `settled` says nothing about either. */
      : effectiveView === "folder"
        ? folderMessages.length > 0 || folderOlder.items.length > 0
          || folderOlder.exhausted || !folderOlder.available
      : effectiveView === "trash"
        ? trashPage.items.length > 0 || trashPage.exhausted || trashPage.error !== null
          || !trashPage.available
      /* search · address · compose · settings · seed · first-run: the view IS its content, and
         Search's results are the SEARCH mark's subject — ending a switch on them would charge
         one wait to two budgets. */
      : true;
  useSwitchEnd(viewOnScreen ? switchKeyOf(route) : null);

  return {
    activeRailId,
    commands,
    effectiveView,
    mobileTitle,
    narrowNow,
    pushTier,
    railGroupsWithHints,
    tagGroup,
  };
}
