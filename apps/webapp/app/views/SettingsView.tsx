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
 * This file is SHARED with `apps/desktop` and copied into a public AGPL mirror that does not
 * contain `app/api-client` at all (`scripts/publish-desktop.mjs` DENYs it), so it cannot
 * import "erase this account from the server". The Cloud client passes a node in
 * (`(product)/mailbox/AccountSection.tsx`). Nothing about account deletion is written down in
 * this file.
 *
 * ── AND "DESKTOP HAS NO ACCOUNT" IS A STATEMENT ABOUT A DOOR, NOT ABOUT A BUILD ─────────
 *
 * This paragraph used to end "Desktop passes nothing and the pane does not exist", which was
 * true of the app as a whole only while every install was standalone. An install on the
 * HOSTED door mirrors a real account and does pass a node — a door out to the browser, since
 * erasure is a step-up ceremony no desktop session can satisfy (`DesktopWebSection`). A
 * STANDALONE install still passes nothing, which is the invariant that was always the point:
 * no account, no pane, structurally rather than by remembering.
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
import { LanguageRow } from "../shell/LanguageRow";
import { ImageQualityRow } from "../shell/ImageQualityRow";
import { PANE_IDS, type PaneId } from "../shell/routing";
import { useZoneNav } from "../shell/zone-nav";
import { RulesView, type RuleOutcome } from "./RulesView";

/* Re-exported so every caller that LINKS to a pane keeps its import — `AppShell`, and through it
 * the Screener's "start a plan" offer. The list itself is the ROUTER's now: `#/settings/<pane>`
 * is a route segment, and two copies of what a URL may say is two lists one new pane apart from
 * disagreeing. A string union rather than a free `string`: `pane` selects a render branch, so a
 * name nothing matches is an empty settings screen. */
export { PANE_IDS, type PaneId } from "../shell/routing";

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
 *
 * SINCE SET-M1 the channel switches render ONLY where that same meta row exists — the demo.
 * On a live account they were five controls whose every position meant nothing: no permission
 * request, no service worker, no subscription, no sender behind `POST /push/subscriptions`.
 * The pane says so instead. This list therefore now describes the PROTOTYPE's channels, and
 * whichever slice ships real delivery inherits it as the starting vocabulary.
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

/**
 * WHICH PANE A DEEP LINK ASKS FOR — `?settings=<pane>` on the app URL, or `"general"`.
 *
 * It exists for one caller and one reason: the Microsoft consent ceremony's callback has to send the
 * browser somewhere that can render its outcome, and the outcome belongs on the Mailboxes pane.
 * `#/settings` (`shell/routing.ts`) already gets the SETTINGS VIEW open; nothing could ask for a
 * pane inside it, so the redirect landed on General and the sentence explaining what happened was
 * one click away and invisible.
 *
 * A hash segment exists NOW — `#/settings/<pane>` (`shell/routing.ts`), added when sections became
 * places of their own — and it OUTRANKS this parameter: an explicit segment controls the pane from
 * the shell, and this function only decides the BARE `#/settings` mounts. The parameter stays for
 * its one consumer (the ceremony's redirect predates the segment and keeps working), not as a
 * second spelling to hand out; new links say `#/settings/<pane>`.
 *
 * It is read ONCE, as the initial state, and never watched — which is the whole of why the parameter
 * is allowed to stay in the address bar. `MailboxSection` strips the CEREMONY parameters (`oauth`,
 * `state`, `code`, `reason`) because they are single-use, and deliberately leaves this one: a pane
 * name is not a credential, and a value that is only consulted at mount cannot drag a user back from
 * a pane they have since clicked to. On a reload it opens Mailboxes again, which is where somebody
 * reloading a page about their mailboxes wants to be.
 *
 * An unrecognised value is `"general"` — the same posture `parseHash` takes for an unknown view, and
 * the reason this validates against {@link PANE_IDS} rather than casting: `pane` selects a render
 * branch, and a value from a URL that matched none of them would render an empty settings screen.
 */
export function initialPaneFromUrl(): PaneId {
  if (typeof window === "undefined") return "general";
  const asked = new URLSearchParams(window.location.search).get("settings");
  return PANE_IDS.includes(asked as PaneId) ? (asked as PaneId) : "general";
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
  invitesSection,
  securitySection,
  aboutSection,
  autoSuggestSection,
  screeningSection,
  dormancySection,
  remoteImagesSection,
  autoUnsubscribeSection,
  awaySection,
  foldersSection,
  signaturesSection,
  desktopSection,
  devicesSection,
  defaultMailSection,
  initialPane,
  pane: routePane,
  onSelectPane,
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
   * every real account — the built-tested-unreachable branch this change deletes rather than
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
   * THE INVITES PANE — invite a user onto the server, list the open invites, revoke one.
   * Self-host only, and the gate lives in the HOST, not here: the mint routes (`/pair*`) are
   * mounted on the self-host composition alone, so `CloudShell` injects this node only on the
   * self-host BUILD with `/hello` announcing `features.pairing`
   * (`InvitesSection.useUserInvites`). The managed deployment and the desktop's doors pass
   * nothing and get no nav entry — absent ⇒ withheld structurally, the same seam as
   * {@link securitySection}.
   */
  invitesSection?: ReactNode;
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
   * AUTO-UNSUBSCRIBE ON SCREEN-OUT, injected — the Screener pane's fourth control.
   *
   * It belongs to the SCREENER and not to General, unlike {@link remoteImagesSection} directly
   * above: what it governs is a consequence of a screening decision, so the place somebody looks
   * for it is the pane where they set what screening does.
   *
   * It renders LAST of the pane's behaviour controls, after {@link autoSuggestSection}, which is
   * an escalation rather than an accident: the two above it change what the Screener shows and
   * what it may spend, and this one makes a request to a stranger. A control whose consequence
   * leaves the building sits below every control whose does not.
   *
   * It stays in this pane rather than following {@link awaySection} into one of its own, and the
   * difference is what the control is ABOUT. The responder is a feature you go and configure; this
   * is a consequence of a decision made here, and the sentence it governs is the one the Screener's
   * own toasts print. Somebody looking for it is looking for where screening is set up.
   *
   * The same injection seam as {@link autoSuggestSection}: it writes `PATCH /consent/settings`
   * through `app/api-client` and through the shell's `useConsentState` (so the sender sheet and the
   * Screener stop disclosing a request that will no longer be made), neither of which this shared,
   * desktop-mirrored file may name. Absent ⇒ no row, which is the honest state on a standalone
   * install: its engine wires no unsubscribe service at all, so there is nothing there to switch
   * off.
   */
  autoUnsubscribeSection?: ReactNode;
  /**
   * THE AWAY RESPONDER, injected — and the only injected node whose feature SENDS MAIL.
   *
   * The same seam as {@link autoSuggestSection}: it reads and writes `GET/PUT /away-responder`
   * through `app/api-client`, which this shared, desktop-mirrored file may not name.
   *
   * Absent is the RIGHT default here in a way it is not for the reading preferences above, and the
   * reason is the product rather than the plumbing: the responder is Cloud-only (the sender is a
   * pass in the hosted worker), so a standalone install has nothing that could send a reply. A
   * control drawn there would store a configuration and answer nobody — which is the exact
   * built-and-unreachable shape this whole slice exists to remove, reintroduced one layer up.
   *
   * ── IT HAS ITS OWN PANE, AND IT USED TO BE THE SCREENER PANE'S LAST ROW ─────────────────────
   *
   * The old filing had a real argument behind it — the responder's one live decision is whether a
   * sender the Screener is still holding gets answered, so it sat beside the posture that decides
   * who is held. What that argument left out is that this is the only control in the product that
   * makes the app SEND MAIL, and "where do I turn that off" is a question people ask of a menu.
   * Buried as the fifth block of a pane about who reaches the Ohbox, it was findable only by
   * somebody who already knew where it was.
   *
   * So it is its own section, immediately after the Screener — the neighbour it argues with, not
   * the pane it hides in. The node is the WHOLE pane here, not a row inside a shared one, which is
   * why an absent node removes the nav entry rather than leaving an empty pane behind: see the
   * `panes` list below.
   */
  awaySection?: ReactNode;
  /**
   * THE FOLDERS PANE — "Use folders", the master toggle of the optional folders feature
   * (FOLDERS-SPEC.md §6). This node IS the pane's content: absent ⇒ no pane and no nav entry.
   *
   * The same injection seam as {@link autoSuggestSection}: it writes `PATCH /consent/settings`
   * through the shell's `useConsentState`, because the rail's Folders group and the folder
   * views are gated on the SAME hook's answer — a pane with its own fetch would flip a switch
   * the rail could not see. Listed on both surfaces the same way the neighbouring panes are: a
   * LOCAL install organizes the same real IMAP folders, so wherever the shell can reach a
   * consent row (the Cloud client, the desktop's hosted door) the pane exists; where it cannot
   * (a standalone install, the demo) there is no entry rather than a dead switch.
   */
  foldersSection?: ReactNode;
  /**
   * THE SIGNATURES PANE — the per-mailbox signature editors (mail 0075). This node IS the
   * pane's content: absent ⇒ no pane and no nav entry.
   *
   * The same injection seam as {@link foldersSection} and for the same reason: it writes
   * `PATCH /consent/settings` through the shell's `useConsentState`, because every compose
   * surface's signature block reads the SAME hook's map — a pane with its own fetch would save
   * a signature an open composer could not see. Present wherever the shell can reach a consent
   * row (the Cloud client, the desktop's hosted door); absent on the demo and on a standalone
   * install, structurally, rather than as editors that cannot store.
   */
  signaturesSection?: ReactNode;
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
  /**
   * ONE ROW AT THE FOOT OF GENERAL — which app this COMPUTER opens mail links with, and the
   * platform's own way to change it. Only a host that is an app the OS can prefer supplies one
   * (the desktop's `DesktopDefaultMail.tsx`; every read and verb in it is a shell command), so a
   * browser tab passes nothing and General simply ends at the row above. On General rather than
   * a pane of its own because it is one row about the computer, beside language and appearance —
   * where somebody thinking "mail links open the wrong app" would look first.
   */
  defaultMailSection?: ReactNode;
  /**
   * THE DEVICES PANE — pairing this account's mail onto other devices, in whichever shape the
   * surface behind it has: on the desktop it is host mode (serve THIS install's mail over the
   * user's own network — tailscale probes, the arm/disarm ceremony, the stdio mint), and on the
   * Cloud client it is the server-side ceremony (`POST /pair` device-pair mint → QR, the
   * `GET /devices` list, the revoke).
   *
   * The same injected-node seam as {@link invitesSection}, and it has to be one from both
   * directions: the desktop node's every verb is a call to the native shell, the Cloud node's
   * every verb goes through `app/api-client` — and neither may be named by this shared file.
   * Absent ⇒ no nav entry and no pane, structurally — a desktop install on the hosted door has
   * nothing local to serve, a browser tab against a server whose `/hello` does not announce
   * `features.pairing` has nothing to mint, and each is withheld rather than offered dead.
   */
  devicesSection?: ReactNode;
  /**
   * WHICH PANE TO OPEN ON, when the caller that sent the user here knows where they are going.
   *
   * The deep link ({@link initialPaneFromUrl}) answers the same question for a REDIRECT arriving
   * from outside the app. This answers it for a link INSIDE it — the Screener's "start a plan"
   * offer, which is a promise about a specific pane and would be a broken one if it landed on
   * General and left the person to find Subscription themselves.
   *
   * Read once, as the initial state, exactly as the URL is, and for the same reason: this is where
   * somebody STARTS, not where they are pinned. Clicking another pane must work, and a watched
   * prop would drag them back.
   */
  initialPane?: PaneId;
  /**
   * THE ROUTE'S PANE — `#/settings/<pane>` resolved by the shell, or absent for the bare hash.
   * Present, it CONTROLS which pane shows (a section is a place now: loadable directly, walkable
   * with Back/Forward), and {@link onSelectPane} is where a nav click goes — the shell writes the
   * hash and the hash comes back around as this prop. Absent — the bare `#/settings`, every
   * pre-existing link, and any harness that mounts this view without a router — the view falls
   * back to its own deep-link logic exactly as before.
   */
  pane?: PaneId;
  /** Where a nav click goes when the route controls the pane — `goSettings` behind the shell. */
  onSelectPane?: (pane: PaneId) => void;
}) {
  const t = useTranslations("settings");
  /** The `tag` namespace owns what a tag IS; `settings` owns this pane's chrome. */
  const tg = useTranslations("tag");
  /** The zone keys' shared vocabulary — the same words the rail's arrows carry. */
  const tz = useTranslations("shortcuts");
  const toast = useToast();
  const { preference, setTheme } = useTheme();
  // The caller's request wins over the URL's, and both are read ONCE. A caller that says nothing
  // leaves the deep link in charge, which is every mount but the one the Screener's offer causes.
  // The ROUTE outranks both — but only when it actually names a pane (see the `pane` prop).
  const [localPane, setPane] = useState<PaneId>(() => initialPane ?? initialPaneFromUrl());
  const pane = routePane ?? localPane;
  const [channels, setChannels] = useState(NOTIFICATION_CHANNELS);
  const [vips, setVips] = useState<string[] | null>(null);
  const [learned, setLearned] = useState<"open" | "accepted" | "dismissed">("open");
  /** The mirror's list until the user changes it; `null` (and absent) on a live account. */
  const vipList = vips ?? notifications?.vips ?? [];

  // THE NAV ORDER, grouped: client basics (General, Notifications) -> mail plumbing (Mailboxes,
  // Screener, Rules, Tags) -> account administration (Subscription, Security, Account) -> facts
  // (About). Each group moves from what the app IS to the user, through what it DOES with their
  // mail, to what governs the account, and ends on facts that are not controls at all.
  /* `awaySection` is NOT one of these any more — it has a pane of its own below. It was in this
     list for as long as it was a row inside the Screener pane, and leaving it here after the move
     would summon an EMPTY Screener pane on any surface that wires the responder and nothing else. */
  const screenerPane = Boolean(
    screeningSection || dormancySection || autoSuggestSection || autoUnsubscribeSection
      || seedSection,
  );
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
    // THE AWAY RESPONDER, immediately after the Screener and before Rules. It is the one control
    // in the product that makes the app SEND MAIL on its own, so it gets a name in the menu rather
    // than a row at the foot of a neighbouring pane — and it stands next to the Screener because
    // its one live decision is about the senders the Screener is holding. Present IFF the shell
    // wired the node, which is the whole of the Cloud-only rule: a standalone install has no hosted
    // worker to send the reply, so there is no entry rather than an entry onto a dead control.
    ...(awaySection ? [["away", t("away")] as [PaneId, string]] : []),
    // BEFORE Tags. A tag is something the user chose to make; a rule is something the
    // product made on their behalf while they were deciding about a sender, and that is the
    // one that has to be findable. Present only where the shell wired it — a nav entry
    // leading to an empty list on an account that HAS rules is the defect, not the fix.
    ...(rules ? [["rules", t("rules")] as [PaneId, string]] : []),
    ["tags", t("tags")],
    // FOLDERS — directly after Tags, as in the rail (the feature's whole placement argument:
    // under Tags, subordinate, optional). Present IFF the shell wired the node.
    ...(foldersSection ? [["folders", t("folders.nav")] as [PaneId, string]] : []),
    // SIGNATURES — with the mail-plumbing group, after Folders: per-mailbox text every outgoing
    // message offers. Present IFF the shell wired the node (a consent row it can reach).
    ...(signaturesSection ? [["signatures", t("signatures.nav")] as [PaneId, string]] : []),
    // THIS INSTALL. Present only in a build that has a native shell behind it, which is the
    // desktop app — a browser tab passes no node and gets no entry. It opens the account
    // administration group because on that surface it IS the account: the door, the mailbox
    // and the sign-out live here rather than in the three panes below, which need a server.
    ...(desktopSection ? [["desktop", desktopSection.label] as [PaneId, string]] : []),
    // DEVICES — pairing and the signed-in device list, in the account-administration group. On
    // the desktop it sits directly after the install it serves from (host mode); on the Cloud
    // client `desktopSection` is absent and it opens the group instead. Present IFF the shell
    // wired it — the desktop's standalone door, or a Cloud client whose server announces
    // `features.pairing`. See {@link devicesSection}.
    ...(devicesSection ? [["devices", t("devices")] as [PaneId, string]] : []),
    // Account administration. Only where there is something to bill: Desktop is free and standalone,
    // and a Subscription pane there would offer to sell what the tier already gives away.
    ...(billingSection ? [["billing", t("billing")] as [PaneId, string]] : []),
    // INVITES — who else may join this server. Opens the account-administration group there,
    // exactly where Subscription sits on managed: both answer "who else is on this server /
    // this plan". Present IFF the host wired it, which only the self-host Cloud client does.
    ...(invitesSection ? [["invites", t("invites")] as [PaneId, string]] : []),
    // Only where there is an account to act on. Security before Account, and both after the panes
    // that organise mail: a destructive control belongs near the bottom, where a mis-click is not
    // one row away from a mail setting.
    ...(securitySection ? [["security", t("security")] as [PaneId, string]] : []),
    ...(accountSection ? [["account", t("account")] as [PaneId, string]] : []),
    // LAST. Facts about the running build and who publishes it — nothing here is a control, so it
    // is the safe place to end. About-below-Account is harmless: unlike Account it acts on nothing.
    ...(aboutSection ? [["about", t("about")] as [PaneId, string]] : []),
  ];

  /* WHICH PANE ACTUALLY RENDERS — the request, clamped to what THIS surface offers.
     `initialPaneFromUrl` validates `?settings=<pane>` against the GLOBAL id list, but which panes
     exist is a per-surface fact: `devices` only where a shell wired one (the desktop's standalone
     door, or a Cloud client whose server pairs), `desktop` never in a browser tab, `invites` only
     behind the self-host gate. A request for an unoffered pane
     used to render an empty content column — a blank settings screen with no pane lit. Clamped at
     RENDER rather than in state, deliberately: panes can arrive a beat after mount (Invites
     appears once `/hello` answers), and a state clamp would strand a deep link that was about to
     become valid. */
  const shown: PaneId = panes.some(([id]) => id === pane) ? pane : "general";

  /**
   * "ONE COULD EVEN DIVE INTO THE SETTINGS LIKE THIS" — the zone model, inside Settings
   * (`zone-nav.tsx`). The settings NAV is this view's list zone: ↓/↑ rove real focus over
   * its buttons (they are real `<button>`s, so Enter is the browser's own activation and the
   * `?` sheet's "Enter = the click" stays literally true), → or Enter dives into the pane
   * column, Escape/← walk back — nav, then rail. The pane column is the reader zone: a
   * labelled, focusable region; ↓/↑ scroll the view's one scroller.
   */
  const navButtons = (): HTMLElement[] =>
    [...document.querySelectorAll<HTMLElement>(".view-settings .set-nav button")];
  const roveNav = (dir: 1 | -1): void => {
    const items = navButtons();
    const cur = document.activeElement;
    const at = cur instanceof HTMLElement ? items.indexOf(cur) : -1;
    if (at < 0) {
      // Entry: land on the pane the reader is already in, the rail's own entry rule.
      (items.find((b) => b.classList.contains("on")) ?? items[0])?.focus();
      return;
    }
    items[Math.min(Math.max(at + dir, 0), items.length - 1)]?.focus();
  };
  useZoneNav({
    list: {
      up: { disabled: false, run: () => roveNav(-1), label: tz("zoneMenuUp") },
      down: { disabled: false, run: () => roveNav(1), label: tz("zoneMenuDown") },
    },
    reader: {
      selector: ".view-settings .set-pane-col",
      scrollSelector: ".view-settings .scroller",
      disabled: false,
    },
    listFocusSelector: ".view-settings .set-nav button.on",
  });

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
                className={shown === id ? "on" : undefined}
                /* Route-controlled, a click WRITES THE HASH (`goSettings` behind `onSelectPane`)
                   and the pane follows the route back down — one source, and each section lands
                   in history so Back walks them. Uncontrolled, the local state it always was. */
                onClick={() => (onSelectPane ? onSelectPane(id) : setPane(id))}
              >
                {label}
              </button>
            ))}
          </nav>

          {/* ── ONE GRID ITEM FOR THE WHOLE CONTENT COLUMN, AND THE ACCOUNT PANE IS WHY ───────
              `.set-layout` is a two-column grid: nav | content. Every pane below renders ONE
              `SettingsSection` into it except Account, which renders TWO (the sign-out card and
              the delete card). While each section was its own GRID ITEM, the second one was
              auto-placed into grid ROW 2 — and row 1's height is the tallest item in it, which is
              the NAV. So on the Account pane the delete card began below the bottom of a
              ten-entry nav, leaving roughly a nav's worth of blank canvas between the two cards
              and above "Delete your account". Nothing was hidden and no rule was wrong; the
              second card was simply obeying a row the nav had sized.

              An earlier fix pinned every direct `.set-pane` to `grid-column: 2`, which cured the
              other half of the same mechanism (the second card had been landing in the NAV's
              170px column) and could not cure this half: a column pin does not stop a second item
              from taking a second row. This wrapper does, by leaving the grid exactly two items
              wide — nav, content — and stacking a pane's sections inside it with a flex gap that
              owes the nav nothing. Pinned by `test/settings-account-layout.test.tsx`. */}
          <div
            className="set-pane-col"
            /* The reader zone of the settings dive (`useZoneNav` above): → lands real focus
               here, announced as a named region, ringed by the global `:focus-visible`. */
            role="region"
            aria-label={t("title")}
            tabIndex={-1}
          >
          {shown === "general" ? (
            <SettingsSection>
              {/* THE LANGUAGE, and the one control in this pane that is NOT injected as a node.
                  Every other host-specific row here arrives as a `ReactNode` because it needs a
                  server; this one is drawn by the shared file because BOTH surfaces have a
                  language — a standalone install has no account but it still reads words, so a
                  node injected by the Cloud host would leave the desktop with no selector. What
                  differs is only where the choice is STORED, and that arrives through
                  `LocaleContext`. Absent context (the demo, a bare pane in a test) ⇒ no row. */}
              <LanguageRow />
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
              {/* WHAT LEAVES THIS BROWSER WHEN A PICTURE IS ATTACHED. Drawn by the shared file
                  rather than injected, like the language above and unlike everything below: the
                  level is kept in this browser and no host has to supply anything, so a standalone
                  install gets the same dial. See `ImageQualityRow`. */}
              <ImageQualityRow />
              {/* HOW AN OPENED MESSAGE IS DRAWN — the same class of question as the theme above
                  it, which is why it is here and not in the Screener pane. Absent on the demo and
                  on a standalone install; see {@link remoteImagesSection}. */}
              {remoteImagesSection}
              {/* WHICH APP THIS COMPUTER OPENS MAIL LINKS WITH — the desktop's row, injected
                  because every read and verb in it is a shell command (see `AppShell`'s
                  `defaultMailSection`). A browser tab passes nothing and no row exists. Last,
                  because it is about the computer around the app rather than the app itself. */}
              {defaultMailSection}
            </SettingsSection>
          ) : null}

          {shown === "notifications" ? (
            <SettingsSection>
              {/* THE HONEST STATE FOR EVERY REAL ACCOUNT (SET-M1). Nothing in the product
                  delivers a notification: the client never asks the browser for permission,
                  registers no service worker and creates no push subscription, and the one
                  server piece that exists (`POST /push/subscriptions`) stores registrations
                  no sender ever reads. The switches that used to render here — two of them
                  ON — were controls whose every position meant nothing, which is the
                  built-and-dead shape this file's other panes are structured to avoid
                  (see {@link mailboxSection}: absent ⇒ withheld, never offered dead). So a
                  live account gets one factual sentence and no switch. `notifications` (the
                  mirror's `view_meta` row) exists only in the fixture world — `/sync` has no
                  such entity — so gating the prototype screen on it keeps the DEMO's
                  Notifications pane exactly as designed, framed by the demo ribbon.
                  Guarded by test/notifications-honest-state.test.tsx; the consumer that replaces
                  this sentence is the change that ships real permission + subscription +
                  delivery. */}
              {!notifications ? (
                <p className="set-note-inline">{t("notificationsUnavailable")}</p>
              ) : null}
              {notifications ? (
                <>
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
                  {/* The content-free-payload sentence describes how a DELIVERED notification
                      behaves, so it renders only with the prototype's switches — on a live
                      account it would be a promise about a feature that does not exist. */}
                  <SettingsNote>{t("notificationPrivacy")}</SettingsNote>
                </>
              ) : null}
            </SettingsSection>
          ) : null}

          {/* MAILBOXES — the host-supplied node, verbatim. No mirror fallback: the old one drew
              `reader.list("mailbox")`, which `/sync` never fills, so it was empty for every real
              account (the built-tested-unreachable branch). The node names its own mode; the nav
              entry above is present only when it is wired. See {@link mailboxSection}. */}
          {shown === "mailboxes" ? mailboxSection : null}

          {shown === "billing" ? billingSection : null}

          {/* INVITES — the node brings its own `SettingsSection`, like Security below. */}
          {shown === "invites" ? invitesSection : null}

          {/* DEVICES — the desktop host pane; the node brings its own `SettingsSection` too. */}
          {shown === "devices" ? devicesSection : null}

          {shown === "rules" && rules ? (
            <RulesView rules={rules.items} onRevoke={rules.onRevoke} onRetarget={rules.onRetarget} />
          ) : null}

          {shown === "tags" ? (
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
              and neither spends), then the auto-suggest opt-in (because it is the one that can cost
              money), then auto-unsubscribe (because it is the one whose consequence leaves the
              building), and the door back to the sent-mail review at the foot. Each node is absent
              on Desktop and the demo — the pane itself is withheld from the nav when all five are.
              The seed section renders its own copy under its own subhead; its `node` brings no
              `SettingsSection` of its own, because this one wraps the whole pane.

              THE AWAY RESPONDER IS NO LONGER HERE. It was the last row of this section; it has its
              own pane below. Anything that puts it back has to remove it from there in the same
              edit — two live controls over one `PUT /away-responder` each hold their own draft, and
              whichever is saved second silently overwrites the other with a stale one. */}
          {shown === "screener" ? (
            <SettingsSection>
              {screeningSection}
              {dormancySection}
              {autoSuggestSection}
              {/* Auto-unsubscribe, below the two that change what the Screener SHOWS and the one
                  that can spend, because it is the only one left in this pane whose consequence
                  leaves the building — a request to a stranger, with no undo once it has gone.

                  It stays in the Screener pane rather than following the away responder into a
                  pane of its own, and the difference is what the control is ABOUT. The responder
                  is a feature you configure; this is a consequence of a decision made here, and
                  the sentence it governs is the one the Screener's own toasts print. Somebody
                  looking for it is looking for where screening is set up. */}
              {autoUnsubscribeSection}
              {seedSection ? (
                <>
                  <SettingsSubhead>{seedSection.label}</SettingsSubhead>
                  {seedSection.node}
                </>
              ) : null}
            </SettingsSection>
          ) : null}
          {/* THE AWAY RESPONDER'S OWN PANE. One injected node, wrapped like every other list here —
              the node is a set of `SettingsRow`s and brings no section of its own. */}
          {shown === "away" ? <SettingsSection>{awaySection}</SettingsSection> : null}
          {/* THE FOLDERS PANE — the honest intro first (these are the real folders on the mail
              server, not a copy; off unless turned on), then the master toggle. Everything the
              spec lists BELOW the toggle arrives in later stages and renders only while it is on;
              the foundation ships the toggle alone. */}
          {shown === "folders" ? (
            <SettingsSection>
              <p className="set-note-inline">{t("folders.intro")}</p>
              {foldersSection}
            </SettingsSection>
          ) : null}
          {/* THE SIGNATURES PANE — one editor per mailbox, the intro first. */}
          {shown === "signatures" ? (
            <SettingsSection>
              <p className="set-note-inline">{t("signatures.intro")}</p>
              {signaturesSection}
            </SettingsSection>
          ) : null}
          {shown === "about" ? aboutSection : null}
          {shown === "security" ? securitySection : null}
          {shown === "account" ? accountSection : null}
          {/* No `SettingsSection` wrapper here: the node brings its own, because it renders
              several sections (the connection, then the actions) rather than one list. */}
          {shown === "desktop" ? desktopSection?.node : null}
          </div>
        </div>
      </div>
    </section>
  );
}
