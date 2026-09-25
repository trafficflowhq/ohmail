/**
 * The reading view, as a component two hosts mount: the pushed `/message/[id]` route (one
 * pane) and the list-detail's reading pane (two panes — the iPad, the unfolded Duo, Android
 * expanded). Same facts, same verbs either way: why the message landed here (the routing
 * rationale chip), what was blocked (the spy-pixel count), what is protected (redaction dots,
 * nothing behind them). Opening marks read through the engine and asks the full body; the
 * verbs are `MessageActions`, which places itself by posture. The scroll position is written
 * to `pane-memory` per message, so a fold that remounts this tree resumes where the reader
 * was — continuity as data, not as tree position.
 */
import { useEffect, useRef, useState } from "react";
import { JUNK_REFILL_BOUND_MS } from "../state/live";
import { junkLeaving, withheldNote } from "./body-note";
import { ActivityIndicator, Platform, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { useWorld, type WorldMail } from "../state/world";
import { shareAttachmentBytes } from "../mail/open-attachment-native";
import { Chip, Panel, Screen, Scroller, Tap, Txt } from "./base";
import { DetailBar } from "./chrome";
import { Icon } from "./Icon";
import { MailBodyFrame } from "./MailBodyFrame";
import { MessageActions } from "./MessageActions";
import { usePosture } from "./posture";
import { readerVerbMode } from "./reader-verbs";
import { scaffoldPlan } from "./scaffold/plan";
import { paneScrollOf, recordPaneScroll } from "./pane-memory";

const platformName = Platform.OS === "ios" ? ("ios" as const) : ("android" as const);

export function MessageReader({
  id,
  inPane = false,
  onClose,
}: {
  id: string;
  /** Mounted beside its list — no back bar of its own; the pane or the rail carries Back. */
  inPane?: boolean;
  /** Leaves the reader: `router.back()` on the route, clearing the selection in a pane. */
  onClose?: () => void;
}) {
  const t = useTheme();
  const w = useWorld();
  const m = w.message(id);
  /* The rail carries Back where it carries the verbs (the closed Duo, the unfolded landscape):
     a detail bar above it would stand Back twice. */
  const railBack = readerVerbMode(scaffoldPlan(usePosture(), platformName)) === "rail";
  const bare = inPane || railBack;
  /** "Show as text" — this reading's own choice, per message; a new open renders rich again. */
  const [textFor, setTextFor] = useState<string | null>(null);

  // The open: mark read (watched — the engine owns the overlay and the rollback),
  // hydrate the full text + conversation + file list.
  //
  // KEYED ON THE WORLD, not just the id: `openMessage` is identity-stable by design (so
  // mirror versions cannot re-fire this), which means a route restored while the session is
  // still booting would otherwise open against the empty world's no-op and never re-run
  // when the session goes live — an unread message under an indefinitely loading snippet.
  const openMessage = w.actions.openMessage;
  const releaseAttachments = w.actions.releaseAttachments;
  const worldKey = w.worldKey;
  useEffect(() => {
    if (id) openMessage(id);
    // AND THE LEAVING RELEASES. The engine holds this message's file list, its inline pictures
    // and every Blob a tile press fetched until somebody drops them, and the phone mints no
    // object URL whose revocation would do it — so the reader owes the release the web seam's
    // cleanup owes, keyed on the same id it opened. Re-entering the message re-asks.
    return () => {
      if (id) releaseAttachments(id);
    };
  }, [id, openMessage, releaseAttachments, worldKey]);

  /* A VERDICT'S HUSK MOVED OUT OF JUNK: the mirror sheds it on the move's own changes, and the
     reader asks again then, once per husk seen; past the engine's bound it says the text could
     not be read. The web reader's rule (`useJunkRefill`), on this door's hydrate. */
  const hydrateMessage = w.actions.hydrateMessage;
  const leaving = m !== undefined && m !== null && junkLeaving(m);
  const shed = m?.bodyState === "snippet" || m?.bodyState === "loading";
  const [refillExpired, setRefillExpired] = useState(false);
  const owedFor = useRef<string | null>(null);
  useEffect(() => {
    setRefillExpired(false);
    if (!leaving) return;
    owedFor.current = id;
    const timer = setTimeout(() => setRefillExpired(true), JUNK_REFILL_BOUND_MS);
    return () => clearTimeout(timer);
  }, [id, leaving]);
  useEffect(() => {
    if (!shed || owedFor.current !== id) return;
    owedFor.current = null;
    hydrateMessage(id);
  }, [id, shed, hydrateMessage]);

  if (!m) {
    return (
      <Screen>
        {bare ? null : <DetailBar />}
        <Scroller>
          <Txt variant="note" tone="ink3" style={{ padding: 20 }}>
            {Copy.messageGone}
          </Txt>
        </Scroller>
      </Screen>
    );
  }

  // `withheld` is checked BEFORE the failure arm and never folded into it: the storage cap is an
  // answer the server gave, so "reopen to try again" would be false. See `Copy.liveBodyWithheld`.
  // Per MARKER, and a verdict's husk outside the spam pile is text on its way — `withheldNote`.
  const bodyNote =
    !m.protected && (m.bodyState === "snippet" || m.bodyState === "loading")
      ? Copy.liveBodyLoading
      : !m.protected && m.bodyState === "withheld"
        ? withheldNote(m, refillExpired)
        : !m.protected && m.bodyState === "failed"
          ? Copy.liveBodyFailed
          : null;

  /** Continuity: the offset survives the remounts a posture change forces (`pane-memory`). */
  const scrollKey = `msg:${m.id}`;
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) =>
    recordPaneScroll(scrollKey, e.nativeEvent.contentOffset.y);

  return (
    <Screen>
      {/* A message in one of the user's OWN folders is titled by that folder's leaf — the
          place-name fallback would say "Ohbox" about mail that is not there. A History message
          is titled History for the same reason: it presents in no pile, so `place` falls to the
          Ohbox default and would name a place this mail is not in. The row's own chip states
          where it actually is (`MailRow`, off `historyPlace`). Mail the server is HOLDING AT THE
          GATE is the third: `Place` has no Screener value, so it fell to the same Ohbox default
          over the very mail the reader is being asked to decide about (`gateHeld`). History
          first — a dormant sender's held mail is in both, and History is the surface it was
          opened from. In a PANE the list is beside this view, so the bar and its Back yield. */}
      {bare ? null : (
        <DetailBar
          title={m.historyPlace ? Copy.history : m.gateHeld ? Copy.screener : m.folderLeaf ?? placeName(m.place)}
        />
      )}
      {/* `.msg{padding:20px 20px 40px}` in the ≤900px block — the message needs
          air above the from-line, or the back bar reads as part of the mail. */}
      <Scroller
        key={scrollKey}
        contentStyle={{ paddingHorizontal: 0 }}
        contentOffset={{ x: 0, y: paneScrollOf(scrollKey) }}
        onScroll={onScroll}
        scrollEventThrottle={64}
      >
        <View style={{ paddingHorizontal: 20, paddingTop: 18 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 9 }}>
            <Txt variant="button" style={{ flexShrink: 1 }} numberOfLines={1}>
              {m.from.name}
            </Txt>
            <Txt variant="caption" tone="ink3" numberOfLines={1} style={{ flexShrink: 2 }}>
              {m.from.address}
            </Txt>
            <View style={{ flex: 1 }} />
            <Txt variant="caption" tone="ink3" tabular>
              {m.time}
            </Txt>
          </View>

          <Txt variant="h2" style={{ marginTop: 14, marginBottom: 14 }}>
            {m.subject}
          </Txt>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7, marginBottom: 20 }}>
            {m.rationale ? (
              <Chip icon="route" style={{ maxWidth: "100%" }}>
                {m.rationale}
              </Chip>
            ) : null}
            {m.trackerNote ? <Chip icon="shield">{m.trackerNote}</Chip> : null}
            {m.amount ? <Chip>{m.amount}</Chip> : null}
            {/* The delivery mailbox, in the reader's own chip grammar. A DELIVERY claim off
                `mailboxId`, never a To/Cc read — this screen shows no recipients at all. */}
            {m.mailboxLabel ? (
              <Chip icon="route" style={{ maxWidth: "100%" }}>
                {Copy.deliveredTo(m.mailboxLabel)}
              </Chip>
            ) : null}
          </View>

          {m.protected ? <ProtectedBlock label={m.protected.label} policy={m.protected.policy} /> : null}

          {!m.protected ? (
            <>
              {bodyNote ? (
                <Txt variant="caption" tone="ink3" style={{ marginBottom: 10 }}>
                  {bodyNote}
                </Txt>
              ) : null}
              {/* The html part renders in the frame (the web's rules, `MailBodyFrame`); the
                  text part is the fallback AND the reader's own "Show as text" choice. */}
              {m.html != null && m.html !== "" && textFor !== m.id ? (
                <MailBodyFrame m={m} onShowAsText={() => setTextFor(m.id)} />
              ) : (
                <>
                  {m.html != null && m.html !== "" ? (
                    <View style={{ flexDirection: "row", justifyContent: "flex-end", marginBottom: 10 }}>
                      <Txt variant="caption" tone="accent" onPress={() => setTextFor(null)} accessibilityRole="button">
                        {Copy.mailShowOriginal}
                      </Txt>
                    </View>
                  ) : null}
                  {/* THE READER'S SIZE, NOT THE PANE'S. On a phone the web has no reading column
                      (`AppShell.tsx`: below 900 it is hidden) — opening a message opens the READER
                      sheet at 16.5/1.78 (`reader.css:16`). This screen is that reader, so it reads
                      at `readerBody`. `msgBody` is the desktop pane's role and stays with it. */}
                  <Txt variant="readerBody" style={{ maxWidth: t.layout.proseMax }}>
                    {m.body}
                  </Txt>
                </>
              )}
            </>
          ) : null}

          <AttachmentTiles m={m} />

          {m.earlier.length > 0 ? (
            <View style={{ marginTop: 34, gap: 12 }}>
              <Txt variant="caption" tone="ink3">
                {Copy.earlierInThread(m.earlier.length + 1)}
              </Txt>
              {m.earlier.map((h) => (
                <Panel key={h.id} radius={t.radius.card} style={{ padding: 18 }}>
                  <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
                    <Txt variant="rowSubject" style={{ flexShrink: 1 }}>
                      {h.face ?? h.subject}
                    </Txt>
                    <View style={{ flex: 1 }} />
                    <Txt variant="caption" tone="ink3" tabular>
                      {h.time}
                    </Txt>
                  </View>
                  <Txt variant="streamBody" tone="ink2" style={{ marginTop: 10 }}>
                    {h.body}
                  </Txt>
                </Panel>
              ))}
            </View>
          ) : null}

        </View>
      </Scroller>
      {/* The verbs place themselves by posture (`MessageActions`): the compact glass bar at
          the thumb, the desktop ActionBar pinned at this pane's foot, or the right-edge rail.
          A confirmed delete leaves this reader at once: the tombstone already dropped the row,
          and "no longer here" over the reader's own act would read as a failure. */}
      <MessageActions m={m} onDeleted={onClose} onBack={onClose} />
    </Screen>
  );
}

/**
 * The attachment strip — the engine's own items, every name already through the
 * nameless-part fallback (`invite.ics`, never an empty label), real files first and the
 * body's own pictures after them wearing the "embedded" tag (the world sorts). A tile press
 * OPENS the bytes: one engine fetch under the server's ceiling, then the platform share
 * sheet — viewer, save and send are the platform's own routes. Each refusal renders a
 * sentence on the tile it belongs to; a silent failure here is a person pressing a dead tile.
 */
function AttachmentTiles({ m }: { m: WorldMail }) {
  const t = useTheme();
  const w = useWorld();
  const [busy, setBusy] = useState<string | null>(null);
  // The REFUSAL, not its sentence: a deck read held in state freezes in the language it was
  // read in; the kind is stored and the sentence resolves where it renders.
  const [note, setNote] = useState<{ id: string; kind: "too_large" | "failed" | "share" } | null>(null);
  // Only ever the world's list — a raw `m.attachment.filename` here would be the empty-label
  // bug this component exists to close (the world resolves every name through the fallback).
  const tiles = m.attachments ?? [];
  if (tiles.length === 0) return null;

  const open = async (id: string): Promise<void> => {
    if (busy !== null) return;
    setBusy(id);
    setNote(null);
    const got = await w.actions.openAttachmentBytes(m.id, id);
    setBusy(null);
    if (got.state === "ready") {
      const shared = await shareAttachmentBytes(got.base64, got.mime, got.filename);
      if (!shared) setNote({ id, kind: "share" });
      return;
    }
    setNote({ id, kind: got.state === "too_large" ? "too_large" : "failed" });
  };

  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 20 }}>
      {tiles.map((a) => (
        <View key={a.id}>
          <Tap
            accessibilityRole="button"
            accessibilityLabel={a.inline ? Copy.attachmentEmbeddedLabel(a.filename) : a.filename}
            disabled={busy !== null}
            onPress={() => void open(a.id)}
            style={[
              {
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                borderRadius: t.radius.pill,
                backgroundColor: t.c.panel,
                paddingHorizontal: 15,
                paddingVertical: 9,
              },
              t.lift("l0"),
            ]}
          >
            {busy === a.id ? (
              <ActivityIndicator size="small" color={t.c.ink2} />
            ) : (
              <Icon name="clip" size={13} color={t.c.ink2} />
            )}
            <Txt variant="button">{a.filename}</Txt>
            {a.size ? (
              <Txt variant="caption" tone="ink3">
                {a.size}
              </Txt>
            ) : null}
            {a.inline ? (
              <Txt variant="caption" tone="ink3">
                {Copy.attachmentEmbedded}
              </Txt>
            ) : null}
          </Tap>
          {note?.id === a.id ? (
            <Txt variant="caption" tone="ink3" accessibilityRole="alert" style={{ marginTop: 4 }}>
              {note.kind === "too_large"
                ? Copy.attachmentTooLarge
                : note.kind === "share"
                  ? Copy.attachmentShareRefused
                  : Copy.attachmentOpenFailed}
            </Txt>
          ) : null}
        </View>
      ))}
    </View>
  );
}

/**
 * The protected block: a tinted pool of light, no frame. Redaction dots stand
 * where a code would be, and the policy sentence is the product promise
 * verbatim — not a tooltip, not a settings row.
 */
function ProtectedBlock({ label, policy }: { label: string; policy: string }) {
  const t = useTheme();
  return (
    <View
      style={{
        borderRadius: t.radius.panel,
        backgroundColor: t.c.accentSoft,
        padding: 22,
        marginBottom: 8,
        maxWidth: 460,
      }}
    >
      <Icon name="shield" size={17} color={t.c.accentInk} />
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, marginVertical: 12 }}>
        <Txt variant="protectedCode">{Copy.protectedRedacted}</Txt>
        <Txt variant="caption" tone="ink3">
          {label}
        </Txt>
      </View>
      <Txt variant="note" tone="ink2">
        <Txt variant="settingsLabel">{Copy.protectedLead}</Txt>
        {policy.replace(/^Protected/, "")}
      </Txt>
    </View>
  );
}

function placeName(place: "ohbox" | "reads" | "receipts"): string {
  return place === "ohbox" ? Copy.ohbox : place === "reads" ? Copy.reads : Copy.receipts;
}
