"use client";

/**
 * Settings, grouped so the nav reads top-to-bottom as client basics -> mail plumbing -> account
 * administration -> facts: General (language + theme, wired to the ThemeProvider), Notifications
 * (only-what-matters defaults + VIP + the learned suggestion), Mailboxes (host-supplied on every
 * surface — see {@link mailboxSection}), Screener (the posture, the dormancy dial, the auto-suggest
 * opt-in, and the door back to the sent-mail review), Rules, Tags, Subscription, Security, Account,
 * and About (last).
 *
 * ── AND A FIFTH PANE THIS FILE DELIBERATELY KNOWS NOTHING ABOUT ─────────────────────────
 *
 * `accountSection` is the same seam `AppShell`'s `resolveOwner` is, for the same reason.
 * This file is SHARED with `apps/desktop` and copied into a public GPL mirror that does not
 * contain `app/api-client` at all (`scripts/publish-desktop.mjs` DENYs it), so it cannot
 * import "erase this account from the server" — and Desktop, which is standalone and has no
 * account, must not grow an Account pane by accident. The Cloud client passes a node in
 * (`(product)/mailbox/AccountSection.tsx`); Desktop passes nothing and the pane does not
 * exist. Nothing about account deletion is written down in this file.
 */
import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { Folder, RuleDTO, TagDTO } from "@ohmail/client-engine";
import {
  Button,
  SegmentedControl,
  SettingsNote,
  SettingsRow,
  SettingsSection,
  SettingsSubhead,
  Switch,
  TAG_HUES,
  TagDot,
  useTheme,
  useToast,
  VipChip,
  type TagHueName,
  type ThemePreference,
} from "@ohmail/ui";
import { hueOf } from "../shell/format";
import { RulesView, type RuleOutcome } from "./RulesView";

type PaneId = "general" | "notifications" | "mailboxes" | "screener" | "billing" | "tags" | "rules" | "about" | "security" | "account" | "desktop";

/**
 * The notification channels, and why this list is here rather than in the fixtures.
 *
 * It used to be `notificationSettings` from `@ohmail/fixtures`, rendered unconditionally, which
 * put two kinds of demo content on every live account's Settings screen. The
 * channel labels were merely MISFILED — they are ordinary product copy that a live account
 * legitimately sees, so they moved to `messages/en.json` and the ids below are their keys.
 *
 * The VIP list and the "you usually open Petra's mail within 5 minutes" suggestion were the
 * real defect: those are Mila's people, invented for the demo world, and a paying customer was
 * reading a learned pattern about someone who does not exist. They reach this view through the
 * MIRROR now ({@link NotificationsMeta}) rather than through an import.
 */
const NOTIFICATION_CHANNELS: Array<{ id: string; enabled: boolean }> = [
  { id: "people", enabled: true },
  { id: "known", enabled: true },
  { id: "reads", enabled: false },
  { id: "receipts", enabled: false },
  { id: "screener", enabled: false },
];

/**
 * The demo world's Notifications extras, as a `view_meta` row.
 *
 * `/sync` has no `view_meta` entity type in its change log, so a Cloud account
 * can never be sent one: absent ⇒ the VIP block does not render, structurally, with no boolean
 * for a view to forget. Only `FixturesAdapter` seeds it — the demo and Desktop.
 *
 * There is no VIP backend and no learning loop behind either control. In the demo that is what
 * it is — the Blanc prototype's screen, brought to life on invented mail. On a live account it
 * would be a claim, which is exactly what this row's absence prevents.
 */
export interface NotificationsMeta {
  vipLabel: string;
  vips: string[];
  learnedSuggestion: {
    text: string;
    target: string;
    acceptedToast: string;
    dismissedToast: string;
  };
}

/**
 * The MIRROR's `mailbox` entity shape. This pane no longer reads it — the Mailboxes pane is
 * host-supplied now (see {@link mailboxSection}) — but the shell still lists these for the rail
 * and the compose from-selector's fixture fallback, so the type stays here and `AppShell` imports
 * it. `"mailbox"` is not a `/sync` entity, so only the fixture world ever holds one.
 */
export interface MailboxEntity {
  id: string;
  address: string;
  provider: string;
  protocol: string;
  status: string;
}

/**
 * ONE TAG, AND THE TWO THINGS THAT CAN BE DONE TO IT.
 *
 * A row with three states — resting, renaming, confirming a delete — held as a union rather
 * than two booleans, for the reason `MessagePane`'s `BarPanel` gives: two booleans can both
 * be true, which is a state there is no rendering for.
 *
 * ── THE DELETE STATES THE COUNT, AND THE COUNT IS A FLOOR ─────────────────────────────
 *
 * "Delete Invoices?" with no number is a question nobody can answer. The count comes from
 * `tagsCrossView` over the local mirror, so on an account whose mirror is still filling it
 * counts the messages this client has drained and not the account's total. It is therefore
 * worded as what it is — how many of YOUR messages carry it — rather than as an absolute,
 * and the sentence next to it says the messages themselves do not move, which is true
 * regardless of the number: `TagsService.remove` deletes the assignment rows and never
 * touches `folder_state`.
 */
type RowMode =
  | { kind: "rest" }
  | { kind: "rename"; draft: string }
  | { kind: "recolor" }
  | { kind: "confirm" };

/** The verbs the admin surface wires. `onCreate` lives on the pane, not the row; a row does the
 *  other three. See {@link SettingsView.tagAdmin}. */
interface TagAdminVerbs {
  onCreate: (name: string) => void;
  onRename: (tagId: string, name: string) => void;
  onRecolor: (tagId: string, hue: TagHueName) => void;
  onDelete: (tagId: string) => void;
}

function TagRow({
  tag,
  count,
  admin,
  t,
}: {
  tag: TagDTO;
  count: number;
  admin?: Pick<TagAdminVerbs, "onRename" | "onRecolor" | "onDelete">;
  t: ReturnType<typeof useTranslations<"settings">>;
}) {
  const [mode, setMode] = useState<RowMode>({ kind: "rest" });
  const hue = hueOf(tag);

  if (mode.kind === "rename") {
    const next = mode.draft.trim();
    // Unchanged or empty is not a rename. The server answers 400 on empty and would accept a
    // no-op PATCH, but a Save that does nothing is a control that lies about having acted.
    const canSave = next.length > 0 && next !== tag.name;
    const save = () => {
      if (!canSave) return;
      admin?.onRename(tag.id, next);
      setMode({ kind: "rest" });
    };
    return (
      <div className="set-row set-tag-edit">
        <TagDot hue={hueOf(tag)} />
        <input
          className="join-input set-tag-input"
          autoFocus
          value={mode.draft}
          aria-label={t("tagRename")}
          onChange={(e) => setMode({ kind: "rename", draft: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); save(); }
            // Escape belongs to this input while it is open. The shell's ladder never sees it,
            // which is correct: the innermost open thing is this field.
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setMode({ kind: "rest" }); }
          }}
        />
        <span className="set-tag-acts">
          <Button variant="primary" disabled={!canSave} onClick={save}>{t("tagSave")}</Button>
          <Button variant="ghost" onClick={() => setMode({ kind: "rest" })}>{t("tagCancel")}</Button>
        </span>
      </div>
    );
  }

  if (mode.kind === "recolor") {
    // The picker offers exactly the hues the Blanc system paints (`TAG_HUES`), so every swatch is
    // one the server accepts AND `chip.css` can draw — the reconciliation the recolour verb waited
    // on. Each swatch is a button (Tab/Enter reach it); the current hue is pressed and marked.
    return (
      <div className="set-row set-tag-edit">
        <TagDot hue={hue} />
        <div className="lab"><b>{tag.name}</b></div>
        <span className="set-tag-hues" role="group" aria-label={t("tagRecolorAria", { name: tag.name })}>
          {TAG_HUES.map((h) => (
            <button
              key={h}
              type="button"
              className={h === hue ? "set-hue on" : "set-hue"}
              aria-label={t(`hue_${h}`)}
              aria-pressed={h === hue}
              onClick={() => { admin?.onRecolor(tag.id, h); setMode({ kind: "rest" }); }}
            >
              <TagDot hue={h} />
            </button>
          ))}
          <Button variant="ghost" onClick={() => setMode({ kind: "rest" })}>{t("tagCancel")}</Button>
        </span>
      </div>
    );
  }

  if (mode.kind === "confirm") {
    return (
      <div className="set-row set-tag-edit">
        <TagDot hue={hue} />
        <div className="lab">
          <b>{t("tagDeleteAsk", { name: tag.name })}</b>
          <span>{t("tagDeleteWhat", { count })}</span>
        </div>
        <span className="set-tag-acts">
          <Button
            variant="primary"
            className="danger"
            onClick={() => { admin?.onDelete(tag.id); setMode({ kind: "rest" }); }}
          >
            {t("tagDelete")}
          </Button>
          <Button variant="ghost" onClick={() => setMode({ kind: "rest" })}>{t("tagCancel")}</Button>
        </span>
      </div>
    );
  }

  return (
    <SettingsRow
      leading={
        admin ? (
          // The coloured dot IS the recolour affordance — clicking it opens the swatches. A row
          // with Recolour/Rename/Delete as three text buttons does not fit 390px; the dot carries
          // the one whose meaning its own colour already states.
          <button
            type="button"
            className="set-tag-dot"
            aria-label={t("tagRecolor", { name: tag.name })}
            onClick={() => setMode({ kind: "recolor" })}
          >
            <TagDot hue={hue} />
          </button>
        ) : (
          <TagDot hue={hue} />
        )
      }
      label={tag.name}
      description={t("tagMessages", { count })}
      control={
        admin ? (
          <span className="set-tag-acts">
            <Button variant="ghost" onClick={() => setMode({ kind: "rename", draft: tag.name })}>
              {t("tagRename")}
            </Button>
            <Button variant="ghost" onClick={() => setMode({ kind: "confirm" })}>
              {t("tagDelete")}
            </Button>
          </span>
        ) : undefined
      }
    />
  );
}

/**
 * MAKE A TAG FROM THE PANE — the create verb of the admin surface, inline like the rail's.
 *
 * Duplicate-checked here, case-insensitively, against the tags the mirror already holds: `POST
 * /tags`'s unique index is on `lower(name)`, so "Invoices" and "invoices" collide and the server
 * answers 409. Refusing before the write keeps the pane from minting a row it knows will bounce and
 * names the tag that already exists rather than reporting a bare failure. The new tag is `moss`,
 * which is what `POST /tags` defaults to — the leading dot says so before it is made.
 */
function TagCreateRow({
  tags,
  onCreate,
  t,
}: {
  tags: TagDTO[];
  onCreate: (name: string) => void;
  t: ReturnType<typeof useTranslations<"settings">>;
}) {
  const [draft, setDraft] = useState("");
  const name = draft.trim();
  const taken = name !== "" && tags.some((x) => x.name.toLowerCase() === name.toLowerCase());
  const canAdd = name !== "" && !taken;
  const add = () => {
    if (!canAdd) return;
    onCreate(name);
    setDraft("");
  };
  return (
    <>
      <div className="set-row set-tag-edit set-tag-new">
        <TagDot hue="moss" />
        <input
          className="join-input set-tag-input"
          value={draft}
          placeholder={t("tagNewPlaceholder")}
          aria-label={t("tagNew")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); add(); }
            // Escape clears the field and belongs to it, like the rename input's — the shell's
            // overlay ladder must not also act on it.
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDraft(""); }
          }}
        />
        <span className="set-tag-acts">
          <Button variant="primary" disabled={!canAdd} onClick={add}>{t("tagAdd")}</Button>
        </span>
      </div>
      {taken ? <p className="set-note-inline set-tag-taken" role="alert">{t("tagTaken", { name })}</p> : null}
    </>
  );
}

export function SettingsView({
  notifications,
  tags,
  tagCounts,
  rules,
  tagAdmin,
  accountSection,
  mailboxSection,
  seedSection,
  billingSection,
  securitySection,
  aboutSection,
  autoSuggestSection,
  screeningSection,
  dormancySection,
  remoteImagesSection,
  desktopSection,
}: {
  /** The demo world's VIP block, or `null` on any account — see {@link NotificationsMeta}. */
  notifications: NotificationsMeta | null;
  tags: TagDTO[];
  tagCounts: Record<string, number>;
  /**
   * THE RULES PANE — ONE PROP, ALL THREE PARTS, OR NO PANE AT ALL.
   *
   * ── WHY IT IS NOT A `ReactNode` SEAM ────────────────────────────────────────────────────
   *
   * Account, Mailboxes, Subscription and Security are all injected nodes because each one
   * needs `app/api-client`, which `scripts/publish-desktop.mjs` DENYs from this shared file.
   * Rules needs nothing of the sort: `rule` is a real `/sync` entity, so the list comes from
   * the mirror via `rulesList(reader)`, and both verbs are engine mutations on the same wire
   * `tag_assign` uses. Desktop and `?demo=1` are therefore correct without a special case —
   * the FixturesAdapter serves `rule_delete` and `rule_update` out of `mutationEffects` like
   * every other verb.
   *
   * ── WHY IT IS ONE OBJECT AND NOT THREE PROPS ────────────────────────────────────────────
   *
   * Three optional props can be half-supplied: a shell that passes the list and forgets a
   * callback yields a pane whose buttons throw, which is the shape this gap is about. As one
   * object the state space is two — wired, or absent — and `undefined` means "this shell has
   * not wired rules yet", which removes the pane from the nav entirely rather than offering
   * an empty list on an account that has four. An EMPTY `items` array is the other thing
   * altogether: a real account that has decided nothing yet, and it renders as such.
   */
  rules?: {
    /** Newest first — `rulesList(reader)`. */
    items: RuleDTO[];
    /** `engine.mutate({ kind: "rule_delete", ruleId })` — the RESULT decides what is said. */
    onRevoke: (ruleId: string) => Promise<RuleOutcome>;
    onRetarget: (ruleId: string, destination: Folder) => Promise<RuleOutcome>;
  };
  /**
   * CREATE / RENAME / RECOLOUR / DELETE — one object, or a read-only list.
   *
   * The same rule as {@link rules} and for the same reason: four optional callbacks can be
   * half-supplied, and a pane that renders a verb without its handler is exactly the shape this
   * is fixing. What shipped originally was worse than half-supplied — Rename and Delete both
   * called `toast("Renaming and deleting tags isn't wired up yet.")`, controls whose only
   * function was to say they had none.
   *
   * All four are ordinary engine mutations on the same wire `tag_assign` uses (`tag_create`,
   * `tag_rename`, `tag_recolor`, `tag_delete`), so the demo and the desktop shell get them too —
   * `FixturesAdapter` serves whatever `mutationEffects` produces. Absent ⇒ the list renders with
   * no verbs and no create row, which is right for a shell that has not wired them.
   */
  tagAdmin?: TagAdminVerbs;
  /** The Cloud client's Account pane, or absent — see the header. */
  accountSection?: ReactNode;
  /**
   * THE MAILBOXES PANE — HOST-SUPPLIED, ON EVERY SURFACE, and it names its own mode.
   *
   * There is no mirror fallback any more. This pane used to fall back to
   * `reader.list<MailboxEntity>("mailbox")`, but `"mailbox"` is not one of the entity types the
   * `/sync` change feed carries, so `/sync` never emits one and the list was empty for
   * every real account — the built-tested-unreachable branch this slice deletes rather than
   * layers over. Both surfaces now bring the real list from `GET /mailboxes`: the Cloud client
   * from `(product)/mailbox/MailboxSection` through `app/api-client`, the desktop shell from the
   * sidecar's mounted API over its bridge. Each pane HEADS itself with the mode it is showing —
   * "Cloud mailboxes" or "Local mailboxes on this computer" — because an install is one or the
   * other, never both in parallel.
   *
   * Absent ⇒ NO pane and no nav entry (the demo, and a desktop window with no engine yet): a
   * settings pane that connects a mailbox needs a server this surface is not talking to, so it is
   * withheld structurally rather than offered dead. Same seam as {@link accountSection}, which
   * `scripts/publish-desktop.mjs` keeps out of the shared file.
   */
  mailboxSection?: ReactNode;
  /**
   * THE WAY BACK TO THE SENT-MAIL REVIEW — the bottom section of the Screener pane.
   *
   * The review is offered when an account has never answered it and takes the whole stage
   * while it is owed, and "Not now" makes it go away. Without an entry here, "Not now" and
   * "answered it once, two years ago" were both dead ends: a mailbox connected afterwards
   * brings a whole second address book of people the user has written to, and there was no
   * door back to the screen that consents to them.
   *
   * It carries its own `label` rather than reading one from the `settings` namespace because
   * the words belong to the consent vocabulary, which this shared file does not own — the
   * review's own screen has to say the same thing, and one wording in one place is how the two
   * stay the same sentence. The `label` is rendered as a {@link SettingsSubhead} over the `node`
   * at the foot of the Screener pane; the `node` carries the review's own copy and its button and
   * must NOT wrap itself in a `SettingsSection`, because the pane already provides one.
   */
  seedSection?: { label: string; node: ReactNode };
  /** The Cloud client's Subscription pane — plan, the AI switch, and Stripe's portal. */
  billingSection?: ReactNode;
  /**
   * The Cloud client's Security pane — recovery codes and the authenticator.
   *
   * Same seam and same reason as {@link accountSection}: every control in it is a step-up
   * ceremony against `auth`, which the Desktop mirror does not have and `?demo=1` must never
   * reach. Absent ⇒ the pane is not offered at all, rather than offered and dead.
   */
  securitySection?: ReactNode;
  /**
   * "About ohmail" — who publishes this, which build is running, where the privacy and
   * subprocessor pages are.
   *
   * The same injected-node seam as the four above, and it has to be one for the same
   * reason twice over. The live body reads `GET /mailboxes` through `app/api-client`, which
   * `scripts/publish-desktop.mjs` DENYs from this shared file; and the publisher named in it
   * is the operator of the HOSTED service, which is not who is running a standalone Desktop
   * install. Absent ⇒ no pane, rather than a pane naming the wrong company.
   *
   * This is where the (i) dock panel's content went. It was an overlay over the mail holding
   * three facts nobody can find anywhere else; facts belong in settings.
   */
  aboutSection?: ReactNode;
  /**
   * THE AUTO-WORK OPT-IN, injected — the Screener pane's one row that can spend money.
   *
   * The same seam as {@link accountSection} and for the same two reasons at once. It needs
   * `app/api-client` (a `dryRun` quote and a consent write), which `scripts/publish-desktop.mjs`
   * DENYs from this shared file; and there is nothing for it to buy on a standalone Desktop
   * install, which has no account, no credits and a local model. Absent ⇒ the row does not
   * exist, so the setting is structurally unreachable wherever it could not work — rather than
   * present and refusing, which is a control that cost something to discover.
   *
   * It is a node and not a `{ label, node }` like {@link seedSection} because it belongs INSIDE the
   * Screener pane's section rather than owning one. It renders LAST of the three Screener behaviour
   * controls (posture, then the dormancy dial, then this), because it is the only one that spends —
   * a control with a cost sits below the ones without.
   */
  autoSuggestSection?: ReactNode;
  /**
   * THE EDITABLE OHBOX PREFERENCE, injected — "what deserves my Ohbox". The FIRST section of the
   * Screener pane (the posture switch and the free-text bar).
   *
   * The same seam as {@link autoSuggestSection}: it reads and writes `GET/PATCH /account/screening`
   * through `app/api-client`, which `scripts/publish-desktop.mjs` DENYs from this shared file. A
   * standalone Desktop install runs the SAME engine and posture, so it can carry its own writer, but
   * this shared view must not name the client — so the live control is injected. Absent ⇒ the
   * section does not render (the demo, or a surface with no account).
   */
  screeningSection?: ReactNode;
  /**
   * THE DORMANCY DIAL, injected — the Screener pane's second control, between the posture
   * ({@link screeningSection}) and the auto-suggest opt-in ({@link autoSuggestSection}).
   *
   * The same seam as {@link autoSuggestSection}: it writes `PATCH /consent/settings` through
   * `app/api-client` AND through the shell's `useConsentState` hook (so the mirror re-partitions on
   * the same render), neither of which this shared, desktop-mirrored file may name. It is pure
   * VISIBILITY — it changes which undecided senders the Screener SHOWS, moves no mail and spends
   * nothing — so it sits above the auto-suggest row. Absent ⇒ no dial (the demo, or a surface with
   * no account).
   */
  dormancySection?: ReactNode;
  /**
   * REMOTE IMAGES — the reading preference, injected, and it belongs to GENERAL rather than to any
   * of the Screener's controls.
   *
   * Everything in the Screener pane is about which mail is SHOWN to you and when. This is about how
   * a message you have already opened is drawn, which is the same class of question as the theme
   * it sits under. Filing it with the Screener would put a reading preference behind a pane a
   * reader only visits to deal with strangers.
   *
   * The same injection seam as {@link autoSuggestSection}: it writes `PATCH /consent/settings`
   * through `app/api-client` and through the shell's `useConsentState` (so the open message
   * re-renders in the new mode), neither of which this shared, desktop-mirrored file may name.
   * Absent ⇒ no row — the demo, and a standalone install, which has no server to store the
   * preference on and therefore keeps the per-message flow.
   */
  remoteImagesSection?: ReactNode;
  /**
   * WHICH DOOR THIS INSTALL CAME IN BY — the desktop app's own pane, injected.
   *
   * The mirror image of {@link accountSection}. That one is absent on the desktop because a
   * standalone install has no account; this one is absent everywhere else because a browser
   * tab has no native shell to ask. Every control in it — sign out, switch door, sign in
   * again — is a call to that shell, so the node is built where the shell is and this file
   * names none of it.
   *
   * It carries its own `label`, like {@link seedSection}, and for the same reason: the words
   * ("On this Mac", "ohmail Cloud") belong to the desktop's vocabulary, which the shared
   * `settings` namespace does not own. Absent ⇒ no nav entry and no pane, structurally.
   */
  desktopSection?: { label: string; node: ReactNode };
}) {
  const t = useTranslations("settings");
  /** The `tag` namespace owns what a tag IS; `settings` owns this pane's chrome. */
  const tg = useTranslations("tag");
  const toast = useToast();
  const { preference, setTheme } = useTheme();
  const [pane, setPane] = useState<PaneId>("general");
  const [channels, setChannels] = useState(NOTIFICATION_CHANNELS);
  const [vips, setVips] = useState<string[] | null>(null);
  const [learned, setLearned] = useState<"open" | "accepted" | "dismissed">("open");
  /** The mirror's list until the user changes it; `null` (and absent) on a live account. */
  const vipList = vips ?? notifications?.vips ?? [];

  // THE NAV ORDER, grouped: client basics (General, Notifications) -> mail plumbing (Mailboxes,
  // Screener, Rules, Tags) -> account administration (Subscription, Security, Account) -> facts
  // (About). Each group moves from what the app IS to the user, through what it DOES with their
  // mail, to what governs the account, and ends on facts that are not controls at all.
  const screenerPane = Boolean(screeningSection || dormancySection || autoSuggestSection || seedSection);
  const panes: Array<[PaneId, string]> = [
    ["general", t("general")],
    ["notifications", t("notifications")],
    // MAILBOXES — the connections this install opens. Host-supplied on every surface and named
    // for its mode inside the pane; present IFF the shell wired the node. There is no mirror
    // fallback: a surface with no host source gets no pane rather than the empty one the mirror
    // list always was for a real account. See {@link mailboxSection}.
    ...(mailboxSection ? [["mailboxes", t("mailboxes")] as [PaneId, string]] : []),
    // Directly after Mailboxes, because everything in it — the posture, the dormancy dial, the
    // auto-suggest opt-in and the door back to the sent-mail review — is about the mail a connected
    // mailbox brings. Present IFF the shell wired any of its nodes; the demo passes none, so the
    // pane does not exist there, structurally, rather than rendering empty.
    ...(screenerPane ? [["screener", t("screener")] as [PaneId, string]] : []),
    // BEFORE Tags. A tag is something the user chose to make; a rule is something the
    // product made on their behalf while they were deciding about a sender, and that is the
    // one that has to be findable. Present only where the shell wired it — a nav entry
    // leading to an empty list on an account that HAS rules is the defect, not the fix.
    ...(rules ? [["rules", t("rules")] as [PaneId, string]] : []),
    ["tags", t("tags")],
    // THIS INSTALL. Present only in a build that has a native shell behind it, which is the
    // desktop app — a browser tab passes no node and gets no entry. It opens the account
    // administration group because on that surface it IS the account: the door, the mailbox
    // and the sign-out live here rather than in the three panes below, which need a server.
    ...(desktopSection ? [["desktop", desktopSection.label] as [PaneId, string]] : []),
    // Account administration. Only where there is something to bill: Desktop is free and standalone,
    // and a Subscription pane there would offer to sell what the tier already gives away.
    ...(billingSection ? [["billing", t("billing")] as [PaneId, string]] : []),
    // Only where there is an account to act on. Security before Account, and both after the panes
    // that organise mail: a destructive control belongs near the bottom, where a mis-click is not
    // one row away from a mail setting.
    ...(securitySection ? [["security", t("security")] as [PaneId, string]] : []),
    ...(accountSection ? [["account", t("account")] as [PaneId, string]] : []),
    // LAST. Facts about the running build and who publishes it — nothing here is a control, so it
    // is the safe place to end. About-below-Account is harmless: unlike Account it acts on nothing.
    ...(aboutSection ? [["about", t("about")] as [PaneId, string]] : []),
  ];

  return (
    <section className="view col view-settings">
      <div className="vhead">
        <h1>{t("title")}</h1>
      </div>
      <div className="scroller">
        <div className="set-layout">
          <nav className="set-nav" aria-label={t("navAria")}>
            {panes.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={pane === id ? "on" : undefined}
                onClick={() => setPane(id)}
              >
                {label}
              </button>
            ))}
          </nav>

          {pane === "general" ? (
            <SettingsSection>
              <SettingsRow
                label={t("language")}
                description={t("languageHint")}
                value={t("languageValue")}
              />
              <SettingsRow
                label={t("theme")}
                description={t("themeHint")}
                control={
                  <SegmentedControl<ThemePreference>
                    ariaLabel={t("themeAria")}
                    value={preference}
                    onChange={setTheme}
                    className="theme-seg"
                    options={[
                      { id: "light", label: t("themeLight") },
                      { id: "system", label: t("themeSystem") },
                      { id: "dark", label: t("themeDark") },
                    ]}
                  />
                }
              />
              {/* HOW AN OPENED MESSAGE IS DRAWN — the same class of question as the theme above
                  it, which is why it is here and not in the Screener pane. Absent on the demo and
                  on a standalone install; see {@link remoteImagesSection}. */}
              {remoteImagesSection}
            </SettingsSection>
          ) : null}

          {pane === "notifications" ? (
            <SettingsSection>
              {channels.map((c, i) => (
                <SettingsRow
                  key={c.id}
                  label={t(`channel.${c.id}.label`)}
                  description={t(`channel.${c.id}.description`)}
                  control={
                    <Switch
                      checked={c.enabled}
                      ariaLabel={t(`channel.${c.id}.label`)}
                      onChange={(v) =>
                        setChannels((cur) =>
                          cur.map((x, xi) => (xi === i ? { ...x, enabled: v } : x)),
                        )
                      }
                    />
                  }
                />
              ))}
              {/* THE DEMO'S VIP BLOCK. Present only where the mirror carries the row,
                  which `/sync` can never do — see `NotificationsMeta`. */}
              {notifications ? (
                <>
                  <SettingsSubhead>{notifications.vipLabel}</SettingsSubhead>
                  <div className="viplist">
                    {vipList.map((v) => (
                      <VipChip
                        key={v}
                        pulse={learned === "accepted" && v === notifications.learnedSuggestion.target}
                      >
                        {v}
                      </VipChip>
                    ))}
                  </div>
                  {learned === "open" ? (
                    <div className="learned">
                      <p>{notifications.learnedSuggestion.text}</p>
                      <div style={{ display: "flex", gap: 7 }}>
                        <Button
                          variant="primary"
                          onClick={() => {
                            setLearned("accepted");
                            const target = notifications.learnedSuggestion.target;
                            setVips(vipList.includes(target) ? vipList : [...vipList, target]);
                            toast(notifications.learnedSuggestion.acceptedToast);
                          }}
                        >
                          {t("learnedYes")}
                        </Button>
                        <Button
                          onClick={() => {
                            setLearned("dismissed");
                            toast(notifications.learnedSuggestion.dismissedToast);
                          }}
                        >
                          {t("learnedNo")}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : null}
              <SettingsNote>{t("notificationPrivacy")}</SettingsNote>
            </SettingsSection>
          ) : null}

          {/* MAILBOXES — the host-supplied node, verbatim. No mirror fallback: the old one drew
              `reader.list("mailbox")`, which `/sync` never fills, so it was empty for every real
              account (the built-tested-unreachable branch). The node names its own mode; the nav
              entry above is present only when it is wired. See {@link mailboxSection}. */}
          {pane === "mailboxes" ? mailboxSection : null}

          {pane === "billing" ? billingSection : null}

          {pane === "rules" && rules ? (
            <RulesView rules={rules.items} onRevoke={rules.onRevoke} onRetarget={rules.onRetarget} />
          ) : null}

          {pane === "tags" ? (
            <SettingsSection>
              {tags.length === 0 ? <p className="set-note-inline">{t("tagsEmpty")}</p> : null}
              {tags.map((tag) => (
                <TagRow
                  key={tag.id}
                  tag={tag}
                  count={tagCounts[tag.id] ?? 0}
                  admin={tagAdmin}
                  t={t}
                />
              ))}
              {/* CREATE — the pane's own inline mint, offered only where the verbs are wired (a
                  read-only shell gets the list and no create row). The rail can make a tag too;
                  this is the same verb, where somebody managing the whole set would look for it. */}
              {tagAdmin ? <TagCreateRow tags={tags} onCreate={tagAdmin.onCreate} t={t} /> : null}
              <p className="set-note-inline">{t("tagNote")}</p>
              {/* THE OWNERSHIP SENTENCE, SAID ONCE, WHERE THE VERBS ARE.
                  A tag is a row in ohmail's database keyed by message — never an IMAP folder
                  — so it is the one thing on this screen that does not live in the user's own
                  mailbox. Somebody about to name and organise a taxonomy is entitled to know
                  that before they build one. It is `tag.notOnServer` verbatim rather than a
                  second wording: the picker already says it, and two copies of a claim about
                  what survives leaving is how one of them ends up false. */}
              <p className="set-note-inline">{tg("notOnServer")}</p>
            </SettingsSection>
          ) : null}

          {/* THE SCREENER PANE — every control about the mail a connected mailbox brings, in one
              section: the posture first, then the dormancy dial (both about what the Screener SHOWS
              and neither spends), then the auto-suggest opt-in (LAST, because it is the one that can
              cost money), and the door back to the sent-mail review at the foot. Each node is absent
              on Desktop and the demo — the pane itself is withheld from the nav when all four are.
              The seed section renders its own copy under its own subhead; its `node` brings no
              `SettingsSection` of its own, because this one wraps the whole pane. */}
          {pane === "screener" ? (
            <SettingsSection>
              {screeningSection}
              {dormancySection}
              {autoSuggestSection}
              {seedSection ? (
                <>
                  <SettingsSubhead>{seedSection.label}</SettingsSubhead>
                  {seedSection.node}
                </>
              ) : null}
            </SettingsSection>
          ) : null}
          {pane === "about" ? aboutSection : null}
          {pane === "security" ? securitySection : null}
          {pane === "account" ? accountSection : null}
          {/* No `SettingsSection` wrapper here: the node brings its own, because it renders
              several sections (the connection, then the actions) rather than one list. */}
          {pane === "desktop" ? desktopSection?.node : null}
        </div>
      </div>
    </section>
  );
}
