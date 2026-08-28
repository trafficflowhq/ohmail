/**
 * THE OPEN MESSAGE'S VERBS — the webapp action bar, in the phone's idiom.
 *
 * The webapp's reading pane offers Reply, Reply all, Later / Park / Resurface (with the horizon
 * chooser), Tag, Screening, Move, the read switch (Mark unread / Mark as read / Done on a
 * resurfaced pin) and, per message, Forward. This screen used to offer three of those. The
 * verbs here are THE SAME VERBS — same names (`src/copy.ts` mirrors the webapp catalogue;
 * `test/action-parity.test.ts` derives the list from the webapp's source and holds it), same
 * engine mutations behind them (`src/state/live.ts`, the arms mirrored from
 * `AppShell.onMessageAction`) — arranged for a thumb instead of a cursor:
 *
 *   · the BAR pins to the bottom (where the Screener's decision bar already lives): the accent
 *     Reply, then the three "not now" horizons the webapp groups as one segment, then More;
 *   · everything else stands in the MORE SHEET, a bottom sheet rather than an anchored menu,
 *     because a popover has nowhere honest to anchor on a phone;
 *   · the two verbs that ask a question — Resurface ("when?") and Move ("where?") — open their
 *     own sheets, the same two ceremonies the webapp swaps its bar row for;
 *   · Tag and Screening open theirs; Reply / Reply all / Forward open the composer.
 *
 * The same absence rules as the webapp: Reply all renders only where `replyAllRecipients`
 * admitted an envelope (`m.canReplyAll` — the send resolves the same call again), Forward never
 * renders on a `no_forward` message, and the read slot holds exactly one of its three faces.
 * The AI drafter ("Draft reply") is not here at all — its offer/price/consent machinery is a
 * webapp shell machine with no engine verb; an absent control, never a dead one.
 */
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { destLabel, DESTINATIONS, domainOf, type Destination, type Scope } from "../state/model";
import {
  dayNine,
  effectiveSignature,
  moveTargetsFor,
  moveTargetLabel,
  nextWeekNine,
  parseRecipients,
  SIG_FOLLOWING,
  tomorrowNine,
  type SignatureState,
  type WorldMail,
  type WorldTag,
} from "../state/live";
import { useWorld } from "../state/world";
import { Button, Rule, Tap, Txt } from "./base";
import { Icon, type IconName } from "./Icon";
import { Segmented } from "./Segmented";
import { CancelRow, Sheet, SheetRow } from "./Sheet";

/** Which surface is up. One at a time — a union, so two sheets cannot stack. */
type Open =
  | null
  | "more"
  | "resurface"
  | "pick"
  | "move"
  | "tag"
  | "screening"
  | "delete"
  | { compose: "reply" | "replyAll" | "forward" };

export function MessageActions({
  m,
  onDeleted,
}: {
  m: WorldMail;
  /**
   * Called the moment a CONFIRMED delete is dispatched — the optimistic tombstone has already
   * dropped the row from every view, so the screen behind this bar is about to say "no longer
   * here" over a message the reader just acted on. The caller navigates away instead; a
   * rollback re-lists the row where it was, under the failure toast.
   */
  onDeleted?: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const w = useWorld();
  const [open, setOpen] = useState<Open>(null);

  // A message swap must not leave a sheet open over a different message's verbs — the same
  // reset the webapp's pane applies to its panels.
  useEffect(() => setOpen(null), [m.id]);

  const a = w.actions;
  const close = () => setOpen(null);

  return (
    <>
      <View
        style={[
          {
            backgroundColor: t.c.float,
            borderTopLeftRadius: t.radius.panel,
            borderTopRightRadius: t.radius.panel,
            paddingHorizontal: 12,
            // Six points of each vertical pad live INSIDE the scroller (below), not here: RN
            // clips `hitSlop` at parent bounds, and a content-sized horizontal ScrollView
            // measuring exactly the capsules' 38pt would cut their touch targets under the
            // 44pt contract `Tap` documents. Same visual bar, uncut hit rectangles.
            paddingTop: 4,
            paddingBottom: 2 + insets.bottom,
            flexDirection: "row",
            alignItems: "center",
            gap: 7,
          },
          t.liftUp("l3"),
          t.liftUp("barEdge"),
        ]}
      >
        {/* ONE ROW, NEVER TWO. The verbs ride a horizontal scroller and More is pinned outside
            it, because a wrapping bar puts More alone on a second line as a stray glyph — the
            first release-binary walk produced exactly that. A narrow phone scrolls the verbs;
            the disclosure stays where a thumb expects it. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 1, flexShrink: 1 }}
          contentContainerStyle={{ flexDirection: "row", alignItems: "center", gap: 7, paddingRight: 4, paddingVertical: 6 }}
        >
          <Button
            label={Copy.actionReply}
            icon="pen"
            variant="solid"
            onPress={() => setOpen({ compose: "reply" })}
          />
          {/* The three horizons — toggles, with the pile that holds the message shown pressed. */}
          <BarToggle
            label={Copy.actionLater}
            icon="clock"
            on={m.pile === "reply_later"}
            onPress={() => a.pileToggle(m.id, "replyLater")}
          />
          <BarToggle
            label={Copy.actionSetAside}
            icon="pause"
            on={m.pile === "set_aside"}
            onPress={() => a.pileToggle(m.id, "setAside")}
          />
          {/* Resurface asks "when?" — except on a message already scheduled, where the press is
              the webapp's horizon-less toggle: it clears the booking rather than re-dating it. */}
          <BarToggle
            label={Copy.actionResurface}
            icon="up"
            on={m.pile === "bubbled_up"}
            onPress={() => (m.pile === "bubbled_up" ? a.resurfaceToggle(m.id) : setOpen("resurface"))}
          />
        </ScrollView>
        <Tap
          onPress={() => setOpen("more")}
          accessibilityRole="button"
          accessibilityLabel={Copy.actionMore}
          style={{ padding: 10 }}
        >
          <Icon name="more" size={16} color={t.c.ink2} />
        </Tap>
      </View>

      {/* ── More: the rest of the bar, one verb per row ─────────────────────────────────── */}
      <Sheet open={open === "more"} onClose={close} label={Copy.actionMore}>
        {m.canReplyAll ? (
          <SheetRow icon="pen" label={Copy.actionReplyAll} onPress={() => setOpen({ compose: "replyAll" })} />
        ) : null}
        {!m.noForward ? (
          <SheetRow icon="open" label={Copy.actionForward} onPress={() => setOpen({ compose: "forward" })} />
        ) : null}
        <SheetRow icon="tag" label={Copy.actionTag} onPress={() => setOpen("tag")} />
        <SheetRow icon="door" label={Copy.actionScreening} onPress={() => setOpen("screening")} />
        <SheetRow icon="ohbox" label={Copy.actionMove} onPress={() => setOpen("move")} />
        <Rule inset={14} />
        {/* One slot, three faces — the webapp's read switch, never empty and never two. */}
        {m.pile === "resurfaced" ? (
          <SheetRow icon="check" label={Copy.actionDone} onPress={() => { close(); a.resurfaceDone(m.id); }} />
        ) : m.unread ? (
          <SheetRow icon="check" label={Copy.actionMarkRead} onPress={() => { close(); a.markSeen(m.id, false); }} />
        ) : (
          <SheetRow icon="x" label={Copy.actionMarkUnread} onPress={() => { close(); a.markSeen(m.id, true); }} />
        )}
        {/* Delete stands LAST and opens its own confirm — a destructive verb never fires off a
            scrolled thumb. Move-to-Trash on the server, never an expunge (mail 0065); there is
            no un-delete on the wire, so the ceremony is a confirm rather than an undo the
            product could not honour. GATED ON THE FOUNDATION FLAG with the confirm sheet below:
            the reader Delete verb ships behind "Use folders" (FOLDERS-SPEC.md §16.3/§16.7 —
            flag-off is the pre-feature reader, "no Delete verb", byte for byte), so with the
            flag off neither the row nor a stale confirm can dispatch. */}
        {w.folders.enabled ? (
          <>
            <Rule inset={14} />
            <SheetRow icon="trash" label={Copy.actionDelete} onPress={() => setOpen("delete")} />
          </>
        ) : null}
      </Sheet>

      {/* ── Delete: the one destructive verb, behind its own stated confirm ─────────────── */}
      {w.folders.enabled ? (
        <Sheet open={open === "delete"} onClose={close} label={Copy.deleteAsk}>
          <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
            {Copy.deleteAsk}
          </Txt>
          <Txt variant="note" tone="ink2" style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
            {Copy.deleteNote}
          </Txt>
          <SheetRow
            icon="trash"
            label={Copy.actionDelete}
            onPress={() => { close(); a.deleteMessage(m.id); onDeleted?.(); }}
          />
          <CancelRow onPress={close} />
        </Sheet>
      ) : null}

      {/* ── Resurface: the horizon chooser — Now / Tomorrow / Next week / Pick a date ────── */}
      <Sheet open={open === "resurface" || open === "pick"} onClose={close} label={Copy.resurfaceWhen}>
        <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
          {Copy.resurfaceWhen}
        </Txt>
        {open === "resurface" ? (
          <>
            <SheetRow label={Copy.resurfaceNow} onPress={() => { close(); a.resurfaceNow(m.id); }} />
            <SheetRow
              label={Copy.resurfaceTomorrow}
              onPress={() => { close(); a.resurfaceAt(m.id, tomorrowNine(new Date()).toISOString()); }}
            />
            <SheetRow
              label={Copy.resurfaceNextWeek}
              onPress={() => { close(); a.resurfaceAt(m.id, nextWeekNine(new Date()).toISOString()); }}
            />
            <SheetRow icon="chev" label={Copy.resurfacePick} onPress={() => setOpen("pick")} />
          </>
        ) : (
          // The picked day, as rows — the native idiom for the webapp's date input, floored at
          // tomorrow so the chooser cannot name a horizon in the past.
          <ScrollView style={{ maxHeight: 320 }}>
            {/* Ninety days of rows — the webapp's date input takes any future day; a list is
                the phone's idiom, and a quarter ahead covers the horizons people actually
                book. A fortnight did not, and was an exclusion nothing on screen admitted. */}
            {Array.from({ length: 90 }, (_, i) => {
              const day = dayNine(new Date(), i + 1);
              return (
                <SheetRow
                  key={day.toISOString()}
                  label={dayLabel(day)}
                  onPress={() => { close(); a.resurfaceAt(m.id, day.toISOString()); }}
                />
              );
            })}
          </ScrollView>
        )}
        <CancelRow onPress={close} />
      </Sheet>

      {/* ── Move: this message, relocated — every place except where it is ───────────────── */}
      <Sheet open={open === "move"} onClose={close} label={Copy.actionMove}>
        <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
          {Copy.moveLabel}
        </Txt>
        {moveTargetsFor(m.folder).map((target) => (
          <SheetRow
            key={target}
            label={`→ ${moveTargetLabel(target)}`}
            onPress={() => { close(); a.move(m.id, target); }}
          />
        ))}
        <CancelRow onPress={close} />
      </Sheet>

      {open === "tag" ? <TagSheet m={m} tags={w.tags} onClose={close} /> : null}
      {open === "screening" ? <ScreeningSheet m={m} onClose={close} /> : null}
      {open !== null && typeof open === "object" ? (
        <ComposeSheet m={m} mode={open.compose} onClose={close} />
      ) : null}
    </>
  );
}

/* ── the tag sheet — the webapp picker: filter, toggle, create what does not exist ─────────── */

function TagSheet({ m, tags, onClose }: { m: WorldMail; tags: WorldTag[]; onClose: () => void }) {
  const t = useTheme();
  const w = useWorld();
  const [query, setQuery] = useState("");
  const typed = query.trim();
  const list = tags.filter((tag) => tag.name.toLowerCase().includes(typed.toLowerCase()));
  // Against the WHOLE set, case-folded — the unique index is on `lower(name)`, so offering to
  // create "Invoices" while "invoices" exists would promise a tag the server answers 409 for.
  const canCreate = typed.length > 0 && !tags.some((tag) => tag.name.toLowerCase() === typed.toLowerCase());
  return (
    <Sheet open onClose={onClose} label={Copy.actionTag}>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={Copy.tagPlaceholder}
        placeholderTextColor={t.c.ink3}
        autoCapitalize="none"
        autoCorrect={false}
        style={[
          t.type.body,
          {
            color: t.c.ink,
            backgroundColor: t.c.tint2,
            borderRadius: t.radius.pill,
            paddingHorizontal: 14,
            paddingVertical: 9,
            marginHorizontal: 14,
            marginBottom: 8,
          },
        ]}
      />
      <ScrollView style={{ maxHeight: 300 }}>
        {list.map((tag) => {
          const on = m.labels.includes(tag.id);
          return (
            <SheetRow
              key={tag.id}
              label={tag.name}
              on={on}
              onPress={() => { onClose(); w.actions.tagToggle(m.id, tag, !on); }}
            />
          );
        })}
        {list.length === 0 && !canCreate ? (
          <Txt variant="note" tone="ink3" style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
            {Copy.tagNone}
          </Txt>
        ) : null}
        {canCreate ? (
          <SheetRow icon="plus" label={Copy.tagCreate(typed)} onPress={() => { onClose(); w.actions.tagCreate(m.id, typed); }} />
        ) : null}
      </ScrollView>
      {/* The honest sentence, at the point of creation — the webapp picker's own footnote. */}
      <Txt variant="caption" tone="ink3" style={{ paddingHorizontal: 14, paddingTop: 8 }}>
        {Copy.tagNotOnServer}
      </Txt>
    </Sheet>
  );
}

/* ── the screening sheet — where THIS SENDER's mail goes, and at what scope ────────────────── */

function ScreeningSheet({ m, onClose }: { m: WorldMail; onClose: () => void }) {
  const w = useWorld();
  const [scope, setScope] = useState<Scope>("sender");
  const domain = domainOf(m.from.address);
  const hasDomain = m.from.address.includes("@") && domain !== "";
  const target = scope === "domain" ? `@${domain}` : m.from.address;
  return (
    <Sheet open onClose={onClose} label={Copy.actionScreening}>
      <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 8 }}>
        {Copy.screeningFor(m.from.name)}
      </Txt>
      {hasDomain ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
          <Segmented
            fill={false}
            segments={[
              { value: "sender", label: Copy.scopeSender },
              { value: "domain", label: Copy.scopeDomain },
            ]}
            value={scope}
            onChange={setScope}
          />
        </View>
      ) : null}
      {DESTINATIONS.map((dest: Destination) => (
        <SheetRow
          key={dest}
          label={`→ ${destLabel(dest)}`}
          onPress={() => { onClose(); w.actions.screenSender(m.id, dest, scope); }}
        />
      ))}
      <Txt variant="caption" tone="ink3" style={{ paddingHorizontal: 14, paddingTop: 8 }}>
        {Copy.screeningNote(target)}
      </Txt>
    </Sheet>
  );
}

/* ── the composer — reply, reply all, forward; plain text, sent through the engine. The
   sending mailbox's stored signature stands below the writing area as a distinct block —
   removable, editable, serialized exactly as shown (SIG-MOB; `signature.ts` is the shared
   model, `SignatureBlock.tsx` the webapp reference). ─────────────────────────────────────── */

function ComposeSheet({
  m,
  mode,
  onClose,
}: {
  m: WorldMail;
  mode: "reply" | "replyAll" | "forward";
  onClose: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const w = useWorld();
  const [body, setBody] = useState("");
  const [to, setTo] = useState("");
  /**
   * The composer's send phase. `queued` is TERMINAL for this composer: the text stands on
   * the engine's retry queue under its Idempotency-Key (the reconnect flush retries it, the
   * same key every time), so Send stays locked — a second press would be a second key, which
   * is the double-delivery the send contract forbids. The sentence under the editor says
   * what is true; closing discards only this screen's copy of text the queue already holds.
   */
  const [phase, setPhase] = useState<"idle" | "sending" | "queued" | "unverified">("idle");
  /** The queued send's Idempotency-Key — what the settle effect follows through the ledger. */
  const [queuedKey, setQueuedKey] = useState<string | null>(null);
  /**
   * THE SIGNATURE BLOCK'S STATE (`signature.ts`, shared with the webapp composer): `following`
   * until the user speaks, then their edit or their strike stands for THIS message. The sheet
   * is mounted per compose and unmounts on close, so the state's lifetime IS the message's —
   * the one-removal-one-message rule by construction.
   */
  const [sig, setSig] = useState<SignatureState>(SIG_FOLLOWING);
  const forward = mode === "forward";

  /**
   * THE LOCKED COMPOSER SETTLES ITSELF. A queued send is retried by the world layer's
   * reconnect flush; when the ledger answers for THIS key, the composer follows: confirmed
   * closes it with the sent toast it was owed, a terminal rollback re-arms it (the queued
   * copy is gone, so a fresh Send cannot double-deliver). `w` re-derives on every flush
   * settle (`outcomeSeq`), which is what fires this without a mirror change.
   */
  useEffect(() => {
    if (phase !== "queued" || queuedKey === null) return;
    const settled = w.sendOutcome(queuedKey);
    // Confirmed: the flush already announced the send (kind-aware toast); this just closes.
    if (settled === "confirmed") onClose();
    else if (settled === "rolled_back") {
      // The queued copy is gone with the rollback — a fresh Send cannot double-deliver.
      setQueuedKey(null);
      setPhase("idle");
    }
    else if (settled === "unverified") setPhase("unverified");
    // `unverified` stays locked: the server could not say whether the message left, so the
    // only honest controls are the check-Sent sentence (in place and toasted) and Cancel.
  }, [phase, queuedKey, w, onClose]);
  // EVERY typed entry must parse, or nothing sends. A filter that dropped the malformed
  // entry silently narrowed the audience — "alice@x, bob.x" sent to Alice alone with nobody
  // told — so an invalid entry LOCKS Send rather than shrinking the list. Entries split on
  // commas/semicolons (never bare spaces: `Alice <alice@x.org>` is ONE entry), and a
  // display-named entry is validated on the address its angle brackets carry.
  const recipients = forward ? parseRecipients(to) : [];
  // A signature never lights Send up on its own — `canSend` reads the body alone, deliberately.
  const canSend =
    phase === "idle" && (forward ? recipients !== null && recipients.length > 0 : body.trim() !== "");

  /**
   * WHAT THE BLOCK SHOWS — and exactly what the send appends (`effectiveSignature`, one
   * derivation, two consumers). The sending mailbox is the row's own `mailboxId`: the mailbox
   * the message arrived in, which is what `Engine.enrich` puts on a reply's wire and what the
   * forward arm passes explicitly — this sheet has no From selector, so the resolution is the
   * mutation's, made visible. `w.signatures === null` (not yet server-confirmed) renders no
   * block and appends nothing: a signature is never drawn or serialized from a guess.
   */
  const sigText = w.signatures === null ? null : effectiveSignature(sig, w.signatures, m.mailboxId);

  const send = async () => {
    setPhase("sending");
    const result = forward
      ? await w.actions.sendForward(m.id, recipients ?? [], body, sigText)
      : await w.actions.sendReply(m.id, body, mode === "replyAll", sigText);
    if (result.outcome === "sent") {
      onClose();
      return;
    }
    if (result.outcome === "queued") {
      setQueuedKey(result.key ?? null);
      setPhase("queued");
      return;
    }
    // `unverified` LOCKS the composer exactly like queued, for the opposite reason: the
    // server could not say whether the message left, so a fresh-key re-send is the
    // duplicate-delivery door. Only a plain failure re-arms Send.
    setPhase(result.outcome === "unverified" ? "unverified" : "idle");
  };

  return (
    <Modal transparent animationType={t.reduceMotion ? "none" : "slide"} visible onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1, justifyContent: "flex-end" }}
      >
        <Pressable style={{ flex: 1 }} accessibilityLabel={Copy.replyCancel} onPress={onClose} />
        <View
          style={[
            {
              backgroundColor: t.c.float,
              borderTopLeftRadius: t.radius.panel,
              borderTopRightRadius: t.radius.panel,
              paddingHorizontal: 16,
              paddingTop: 16,
              paddingBottom: 12 + insets.bottom,
              gap: 10,
            },
            t.liftUp("l3"),
          ]}
        >
          {/* The head states the audience — the same statement the webapp editor opens with,
              and for reply-all the same envelope the send will carry, every name on it. */}
          <Txt variant="settingsLabel">
            {forward
              ? Copy.forwardHead
              : mode === "replyAll" && m.replyAllHead
                ? Copy.replyToAll(m.replyAllHead.to)
                : Copy.replyTo(m.from.name)}
          </Txt>
          {mode === "replyAll" && m.replyAllHead && m.replyAllHead.cc !== "" ? (
            <Txt variant="caption" tone="ink3">
              {Copy.replyCcLine(m.replyAllHead.cc)}
            </Txt>
          ) : null}
          {forward ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Txt variant="caption" tone="ink3">
                {Copy.forwardTo}
              </Txt>
              <TextInput
                value={to}
                onChangeText={setTo}
                editable={phase === "idle"}
                placeholder={Copy.forwardToPlaceholder}
                placeholderTextColor={t.c.ink3}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                style={[
                  t.type.body,
                  {
                    flex: 1,
                    color: t.c.ink,
                    backgroundColor: t.c.tint2,
                    borderRadius: t.radius.pill,
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                  },
                ]}
              />
            </View>
          ) : null}
          {/* Frozen the moment Send is pressed: the dispatch captured the fields at the
              press, and an editable field over a sending/queued/unverified state would
              display words the wire will not carry. */}
          <TextInput
            value={body}
            onChangeText={setBody}
            editable={phase === "idle"}
            placeholder={forward ? Copy.forwardNotePlaceholder : Copy.replyPlaceholder}
            placeholderTextColor={t.c.ink3}
            multiline
            autoFocus
            accessibilityLabel={forward ? Copy.forwardNotePlaceholder : Copy.replyPlaceholder}
            style={[
              t.type.body,
              {
                color: t.c.ink,
                backgroundColor: t.c.tint2,
                borderRadius: t.radius.card,
                paddingHorizontal: 14,
                paddingVertical: 10,
                minHeight: 120,
                textAlignVertical: "top",
              },
            ]}
          />
          {/* THE SIGNATURE BLOCK — a DISTINCT, REMOVABLE element below the writing area
              (`SignatureBlock.tsx` is the webapp reference; `signature.ts` owns the model).
              Nothing renders when there is nothing to show — struck, edited to blank, the
              sender stores nothing, or the map is not yet server-confirmed: absence is the
              resting state, never a collapsed control. × strikes it for THIS message only;
              typing edits it (the user's text stands whatever the resolution later says). */}
          {sigText !== null ? (
            <View
              accessibilityLabel={Copy.sigLabel}
              style={{
                backgroundColor: t.c.tint2,
                borderRadius: t.radius.card,
                paddingHorizontal: 14,
                paddingTop: 6,
                paddingBottom: 10,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Txt variant="caption" tone="ink3">
                  {Copy.sigLabel}
                </Txt>
                <View style={{ flex: 1 }} />
                <Tap
                  onPress={phase === "idle" ? () => setSig({ kind: "removed" }) : undefined}
                  accessibilityRole="button"
                  accessibilityLabel={Copy.sigRemove}
                  style={{ padding: 8, marginRight: -8 }}
                >
                  <Icon name="x" size={13} color={t.c.ink3} />
                </Tap>
              </View>
              {/* BOUNDED: a stored signature may run thousands of characters, and an
                  unbounded content-measured input would grow the panel past the viewport and
                  bury Send under the keyboard (codex round 1). Capped, it scrolls inside the
                  block — the webapp's own 8-row ceiling, in points. */}
              <TextInput
                value={sigText}
                onChangeText={(text) => setSig({ kind: "edited", text })}
                editable={phase === "idle"}
                multiline
                accessibilityLabel={Copy.sigAria}
                style={[t.type.body, { color: t.c.ink2, paddingVertical: 0, maxHeight: 144 }]}
              />
            </View>
          ) : null}
          {phase === "queued" || phase === "unverified" ? (
            <Txt variant="caption" tone="ink3">
              {phase === "queued" ? Copy.replyQueued : Copy.replyUnverified}
            </Txt>
          ) : null}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <Button label={Copy.replyCancel} variant="quiet" onPress={onClose} />
            <Button
              label={phase === "sending" ? Copy.replySending : Copy.replySend}
              variant={canSend ? "solid" : "plain"}
              onPress={canSend ? send : undefined}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}



/* ── primitives ────────────────────────────────────────────────────────────────────────────── */

/** A bar capsule with a pressed face — the webapp button's `aria-pressed`, in RN vocabulary. */
function BarToggle({
  label,
  icon,
  on,
  onPress,
}: {
  label: string;
  icon: IconName;
  on: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Tap
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          minHeight: 38,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: t.radius.pill,
          backgroundColor: on ? t.c.accentSoft : t.c.panel,
          opacity: pressed ? 0.86 : 1,
        },
        t.lift("l0"),
      ]}
    >
      <Icon name={icon} size={13} color={on ? t.c.accentInk : t.c.ink} />
      <Txt variant="button" tone={on ? "accent" : "ink"}>
        {label}
      </Txt>
    </Tap>
  );
}

/** "Mon 1 Sep" for the picked-day rows — weekday, day, month, in the reader's locale defaults. */
function dayLabel(day: Date): string {
  try {
    return new Intl.DateTimeFormat("en", { weekday: "short", day: "numeric", month: "short" }).format(day);
  } catch {
    return day.toDateString();
  }
}
