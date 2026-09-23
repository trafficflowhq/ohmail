/**
 * One draft, read — and what a person can do about a send this server could not confirm. The
 * webapp opens a draft in its editor; this app has none, so this card RECOVERS rather than edits:
 * the text in full and selectable, where the message goes to be finished, and — for a held send —
 * the sentence saying what is known with its two acts. What the card says is `draft-card.ts`'s;
 * this file lays it out. Discard asks in its own place: one sentence, Keep, Discard, back keeps.
 */
import { useEffect, useState } from "react";
import { AccessibilityInfo, BackHandler, Platform, View } from "react-native";
import { router } from "expo-router";
import { Copy } from "../copy";
import { useWorld } from "../state/world";
import { Button, Panel, Rule, Screen, Scroller, Txt } from "./base";
import { DetailBar } from "./chrome";
import {
  backKeeps, discardDecision, draftCardPlan, refusalSentence, type DraftDiscardRefusal,
} from "./draft-card";

/** Which question stands on the card — one at a time, a card of open questions is noise. */
type Asking = "discard" | "sendAgain" | null;

export function DraftReader({
  id,
  onGone,
  onClose,
}: {
  id: string;
  /** The row left Drafts (discarded, dismissed as sent, or sent again) — the pane closes behind it. */
  onGone?: (id: string) => void;
  onClose?: () => void;
}) {
  const w = useWorld();
  const row = w.drafts.find((d) => d.id === id);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<Asking>(null);
  /** The last refused discard, stamped so a second refusal is announced again. */
  const [refusal, setRefusal] = useState<{ why: DraftDiscardRefusal; at: number } | null>(null);

  /* BACK KEEPS. Registered only while a question stands, so it runs before the navigator's own
     listener (RN calls the newest first) and the press closes the question, not the screen. */
  useEffect(() => {
    if (asking === null) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!backKeeps(true)) return false;
      setAsking(null);
      return true;
    });
    return () => sub.remove();
  }, [asking]);

  /* SPOKEN, not only drawn: Android reads the live regions below; iOS has none, so the question
     and the refusal go through the announcement door — the toast's own two doors. */
  const refusedAt = refusal?.at ?? null;
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    if (asking === "discard") AccessibilityInfo.announceForAccessibility(Copy.draftsDiscardWhat);
    if (asking === "sendAgain") AccessibilityInfo.announceForAccessibility(Copy.draftsSendAgainWhat);
  }, [asking]);
  useEffect(() => {
    if (Platform.OS !== "ios" || refusal === null) return;
    AccessibilityInfo.announceForAccessibility(refusalSentence(refusal.why));
    // `refusedAt` re-arms per press; the sentence is read off the value it stamps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refusedAt]);

  if (!row) {
    /* Discarded, answered, or drained away while this route was open. The honest gone sentence,
       never an empty card that reads as a draft with nothing in it. */
    return (
      <Screen>
        <DetailBar title={Copy.draftsTitle} />
        <Scroller>
          <Txt variant="note" tone="ink3" style={{ padding: 20 }}>
            {Copy.trashRowGone}
          </Txt>
        </Scroller>
      </Screen>
    );
  }

  const plan = draftCardPlan(row, {
    confirming: asking === "discard",
    confirmingSendAgain: asking === "sendAgain",
    refusal: refusal?.why ?? null,
  });

  const leave = () => {
    onGone?.(row.id);
    onClose?.();
  };

  const discard = async () => {
    if (busy) return;
    setAsking(null);
    const decided = discardDecision(row);
    if (decided !== "wire") { setRefusal({ why: decided, at: Date.now() }); return; }
    setBusy(true);
    const outcome = await w.actions.draftDiscard(row.id);
    if (outcome === "discarded") { leave(); return; }
    if (outcome === "stillSending") setRefusal({ why: "stillSending", at: Date.now() });
    setBusy(false);
  };

  /* IT WAS SENT — the ledger records the delivery and the row leaves Drafts. */
  const dismissAsSent = async () => {
    if (busy) return;
    setBusy(true);
    if (await w.actions.draftResolve(row.id, "arrived")) { leave(); return; }
    setBusy(false);
  };

  const sendAgain = async () => {
    if (busy) return;
    setAsking(null);
    setBusy(true);
    const outcome = await w.actions.draftSendAgain(row.id);
    if (outcome === "sent") { leave(); return; }
    setBusy(false);
  };

  return (
    <Screen>
      <DetailBar title={Copy.draftsTitle} />
      <Scroller bounded>
        <View style={{ paddingHorizontal: 18, paddingTop: 8, paddingBottom: 12, gap: 4 }}>
          <Txt variant="h1" numberOfLines={3}>{row.subject}</Txt>
          <Txt variant="meta" tone="ink3" numberOfLines={2}>
            {row.to === "" ? Copy.scheduledNoRecipient : row.to}
          </Txt>
          <Txt variant="caption" tone="ink3" tabular>{row.when}</Txt>
        </View>

        {/* WHAT IS KNOWN about this send, in the catalogue's own words — never a claim either way. */}
        {plan.held !== null ? (
          <Panel style={{ paddingVertical: 14, marginBottom: 12 }}>
            <Txt variant="note" tone="ink2" style={{ paddingHorizontal: 18 }}>
              {plan.held}
            </Txt>
          </Panel>
        ) : null}

        {/* The server's own sentence from an appointment it could not keep, quoted verbatim. */}
        {row.failure !== null ? (
          <Panel style={{ paddingVertical: 14, marginBottom: 12 }}>
            <Txt variant="note" tone="ink" style={{ paddingHorizontal: 18 }}>
              {Copy.scheduleFailedNote(row.failure)}
            </Txt>
          </Panel>
        ) : null}

        <Panel style={{ paddingVertical: 12, marginBottom: 12 }}>
          <Txt variant="meta" tone="ink3" style={{ paddingHorizontal: 18, paddingBottom: 6 }}>
            {Copy.draftsTextHeading}
          </Txt>
          {/* THREE STATES, NEVER TWO: a body this mirror never received is not an empty message.
              The text is selectable, because on a held row it is the only copy. */}
          <Txt
            variant="body"
            tone={row.bodyKnown && row.body !== "" ? "ink" : "ink3"}
            selectable
            style={{ paddingHorizontal: 18 }}
          >
            {!row.bodyKnown
              ? Copy.draftsBodyUnavailable
              : row.body === "" ? Copy.draftsTextEmpty : row.body}
          </Txt>
        </Panel>

        <Panel style={{ paddingVertical: 8, marginBottom: 12 }}>
          {/* THE HELD SEND'S TWO ACTS, labelled by the sentence above so a screen reader hears
              the same words. Send again asks in place like Discard; the row wraps on a narrow card. */}
          {plan.acts !== null ? (
            <View
              accessibilityLabel={plan.held ?? undefined}
              style={{ paddingHorizontal: 18, paddingVertical: 8, gap: 8 }}
            >
              {plan.acts.kind === "confirm" ? (
                <View
                  accessibilityLiveRegion="polite"
                  onAccessibilityEscape={() => setAsking(null)}
                  style={{ gap: 8 }}
                >
                  <Txt variant="note" tone="ink2">{plan.acts.what}</Txt>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
                    <Button label={plan.acts.keep} variant="plain" onPress={() => setAsking(null)} />
                    <Button
                      label={plan.acts.sendAgain}
                      variant="solid"
                      disabled={busy}
                      onPress={() => void sendAgain()}
                    />
                  </View>
                </View>
              ) : (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
                  <Button
                    label={plan.acts.sendAgain}
                    variant="quiet"
                    disabled={busy || !row.bodyKnown}
                    onPress={() => { setRefusal(null); setAsking("sendAgain"); }}
                  />
                  <Button
                    label={plan.acts.itWasSent}
                    variant="quiet"
                    disabled={busy}
                    onPress={() => void dismissAsSent()}
                  />
                </View>
              )}
            </View>
          ) : null}

          {/* OPEN THE CONVERSATION — offered only where `liveDrafts` measured the parent present
              in THIS mirror. Never a promise about a message this device may not hold. */}
          {row.repliesHere && row.inReplyToMessageId !== null ? (
            <>
              {plan.acts !== null ? <Rule inset={18} /> : null}
              <View style={{ paddingHorizontal: 18, paddingVertical: 8 }}>
                <Button
                  label={Copy.draftsOpenConversation}
                  variant="quiet"
                  onPress={() => router.push(`/message/${row.inReplyToMessageId}`)}
                />
              </View>
            </>
          ) : null}

          {/* DISCARD, on every row — held ones included: the server admits an unverified discard.
              Pressed once, the question stands IN ITS PLACE, and a refusal is said right under it. */}
          {plan.acts !== null || row.repliesHere ? <Rule inset={18} /> : null}
          <View style={{ paddingHorizontal: 18, paddingVertical: 8, gap: 8 }}>
            {plan.discard.kind === "confirm" ? (
              <View
                accessibilityLiveRegion="polite"
                onAccessibilityEscape={() => setAsking(null)}
                style={{ gap: 8 }}
              >
                <Txt variant="note" tone="ink2">{plan.discard.what}</Txt>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
                  <Button label={plan.discard.keep} variant="plain" onPress={() => setAsking(null)} />
                  <Button
                    label={plan.discard.discard}
                    variant="solid"
                    disabled={busy}
                    onPress={() => void discard()}
                  />
                </View>
              </View>
            ) : (
              <View style={{ flexDirection: "row" }}>
                <Button
                  label={plan.discard.label}
                  variant="quiet"
                  disabled={busy}
                  onPress={() => { setRefusal(null); setAsking("discard"); }}
                />
              </View>
            )}
            {plan.refusal !== null ? (
              <Txt variant="note" tone="ink" accessibilityLiveRegion="polite">
                {plan.refusal}
              </Txt>
            ) : null}
          </View>
        </Panel>

        {/* Where the message goes to be finished — `scheduledEditNote`'s twin, for its reason. */}
        <Txt variant="hint" tone="ink3" style={{ paddingHorizontal: 18, paddingBottom: 8 }}>
          {Copy.draftsEditNote}
        </Txt>
      </Scroller>
    </Screen>
  );
}
