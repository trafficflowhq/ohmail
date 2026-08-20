/**
 * The reading view.
 *
 * Three things this screen states as fact rather than decoration:
 *
 *  · **Why it landed here.** Every message carries its routing rationale as a
 *    chip — the rule that filed it, or the Yes you gave the sender. Nothing is
 *    sorted invisibly. (A live row that has no recorded rationale shows none.)
 *  · **What was blocked.** The spy-pixel chip names the count, on the message
 *    it belongs to.
 *  · **What is protected.** A verification mail has no body to show, because
 *    none was stored. The block says so and shows redaction dots — it is not a
 *    hidden field with a reveal button, because there is nothing behind it.
 *    (Structural, not policy: never sent to AI, never forwarded, stored
 *    redacted.)
 *
 * The whole conversation renders. `earlier` is listed in full under the
 * message, never summarised into a badge. Opening the message marks it read
 * through the engine (the optimistic overlay; a rejection rolls back with a
 * sentence), asks for the full body — the pane says honestly when it is still
 * showing the preview — and the attachment strip carries the engine's own
 * names, nameless-ICS fallback included. The triage buttons file through
 * `engine.mutate`. Compose/reply and tags arrive with later updates, so no
 * control for them renders — a screen offers no control it cannot perform.
 */
import { useEffect } from "react";
import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Copy } from "../../src/copy";
import { useTheme } from "../../src/theme";
import { useWorld, type WorldMail } from "../../src/state/world";
import { Button, Chip, Panel, Screen, Scroller, Txt } from "../../src/ui/base";
import { DetailBar } from "../../src/ui/chrome";
import { Gated } from "../../src/ui/Gated";
import { Icon } from "../../src/ui/Icon";

/**
 * Gated like the tabs: a deep link (`ohmail://message/<id>`) can mount this route with the
 * tabs layout never focusing, and without the gate an unpaired phone would land on the
 * empty world's "no longer here" with no way out.
 */
export default function MessageScreen() {
  return (
    <Gated>
      <MessageBody />
    </Gated>
  );
}

function MessageBody() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const w = useWorld();
  const m = w.message(id ?? "");

  // The open: mark read (watched — the engine owns the overlay and the rollback),
  // hydrate the full text + conversation + file list.
  //
  // KEYED ON THE WORLD, not just the id: `openMessage` is identity-stable by design (so
  // mirror versions cannot re-fire this), which means a route restored while the session is
  // still booting would otherwise open against the empty world's no-op and never re-run
  // when the session goes live — an unread message under an indefinitely loading snippet.
  const openMessage = w.actions.openMessage;
  const worldKey = w.worldKey;
  useEffect(() => {
    if (id) openMessage(id);
  }, [id, openMessage, worldKey]);

  if (!m) {
    return (
      <Screen>
        <DetailBar />
        <Scroller>
          <Txt variant="note" tone="ink3" style={{ padding: 20 }}>
            That message is no longer here.
          </Txt>
        </Scroller>
      </Screen>
    );
  }

  const bodyNote =
    !m.protected && (m.bodyState === "snippet" || m.bodyState === "loading")
      ? Copy.liveBodyLoading
      : !m.protected && m.bodyState === "failed"
        ? Copy.liveBodyFailed
        : null;

  return (
    <Screen>
      <DetailBar title={placeName(m.place)} />
      {/* `.msg{padding:20px 20px 40px}` in the ≤900px block — the message needs
          air above the from-line, or the back bar reads as part of the mail. */}
      <Scroller contentStyle={{ paddingHorizontal: 0 }}>
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
          </View>

          {m.protected ? <ProtectedBlock label={m.protected.label} policy={m.protected.policy} /> : null}

          {!m.protected ? (
            <>
              {bodyNote ? (
                <Txt variant="caption" tone="ink3" style={{ marginBottom: 10 }}>
                  {bodyNote}
                </Txt>
              ) : null}
              <Txt variant="msgBody" style={{ maxWidth: t.layout.proseMax }}>
                {m.body}
              </Txt>
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
                      {h.subject}
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

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 34 }}>
            <Button
              label={Copy.replyLater}
              icon="clock"
              onPress={() =>
                w.actions.addToPile("replyLater", {
                  id: m.id,
                  messageId: m.id,
                  title: m.from.name,
                  subtitle: m.subject,
                  preview: m.snippet,
                })
              }
            />
            <Button
              label={Copy.park}
              icon="pause"
              onPress={() =>
                w.actions.addToPile("setAside", { id: m.id, messageId: m.id, title: m.from.name, subtitle: m.subject })
              }
            />
            <Button
              label={Copy.resurface}
              icon="up"
              onPress={() =>
                w.actions.addToPile("resurface", {
                  id: m.id,
                  messageId: m.id,
                  title: m.subject,
                  resurfaceAt: "Fri 09:00",
                })
              }
            />
          </View>
        </View>
      </Scroller>
    </Screen>
  );
}

/**
 * The attachment strip — the engine's own items, every name already through the
 * nameless-part fallback: a calendar invite that arrived unnamed reads
 * `invite.ics`, the same name its download would carry, never an empty label.
 * Opening the bytes is not supported yet; these tiles state what the mail
 * carries.
 */
function AttachmentTiles({ m }: { m: WorldMail }) {
  const t = useTheme();
  // Only ever the world's list — a raw `m.attachment.filename` here would be the empty-label
  // bug this component exists to close (the world resolves every name through the fallback).
  const tiles = m.attachments ?? [];
  if (tiles.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 20 }}>
      {tiles.map((a) => (
        <View
          key={a.id}
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
          <Icon name="clip" size={13} color={t.c.ink2} />
          <Txt variant="button">{a.filename}</Txt>
          {a.size ? (
            <Txt variant="caption" tone="ink3">
              {a.size}
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
