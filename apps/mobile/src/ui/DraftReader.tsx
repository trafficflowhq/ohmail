/**
 * One draft, read — and what a person can do about a send this server could not confirm. The
 * webapp opens a draft in its editor; this app has none, so this card RECOVERS rather than edits:
 * the text in full and selectable, where the message goes to be finished, and — for a held send —
 * the sentence saying what is known with its two acts. What the card says is `draft-card.ts`'s;
 * this file lays it out. Discard asks in its own place: one sentence, Keep, Discard, back keeps.
 */
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, BackHandler, Platform, View } from "react-native";
import { router, useIsFocused } from "expo-router";
import { Copy } from "../copy";
import { refuse } from "../refusal";
import { queuedCaptionKey } from "../engine/send-waits";
import { useNetworkNow } from "../net/network-door";
import { useWorld, useWorldToast } from "../state/world";
import { Button, Panel, Rule, Screen, Scroller, Txt } from "./base";
import { BodyPages } from "./BodyPages";
import { DetailBar } from "./chrome";
import {
  backKeeps, discardDecision, draftCardPlan, refusalSentence, sendAgainQuestion, sendAgainSentence,
  type DraftDiscardRefusal, type DraftSendAgainRefusal,
} from "./draft-card";
import { cancelSendPress } from "./send-cancel";

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
  const toast = useWorldToast();
  const network = useNetworkNow();
  const row = w.drafts.find((d) => d.id === id);
  const [busy, setBusy] = useState(false);
  /** A Cancel send still being asked — `cancelSendPress`'s own latch. */
  const withdrawing = useRef(false);
  const [asking, setAsking] = useState<Asking>(null);
  /** The last refused discard, stamped so a second refusal is announced again. */
  const [refusal, setRefusal] = useState<{ why: DraftDiscardRefusal; at: number } | null>(null);
  /** The last Send again that did not send, stamped like the discard's. */
  const [sendRefusal, setSendRefusal] = useState<{ why: DraftSendAgainRefusal; at: number } | null>(null);

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
    if (asking === "discard") {
      AccessibilityInfo.announceForAccessibility(row?.waiting ? Copy.draftsDiscardWaitingWhat : Copy.draftsDiscardWhat);
    }
    if (asking === "sendAgain") AccessibilityInfo.announceForAccessibility(sendAgainQuestion());
  }, [asking]);
  useEffect(() => {
    if (Platform.OS !== "ios" || refusal === null) return;
    AccessibilityInfo.announceForAccessibility(refusalSentence(refusal.why));
    // `refusedAt` re-arms per press; the sentence is read off the value it stamps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refusedAt]);
  const sendRefusedAt = sendRefusal?.at ?? null;
  useEffect(() => {
    if (Platform.OS !== "ios" || sendRefusal === null) return;
    AccessibilityInfo.announceForAccessibility(sendAgainSentence(sendRefusal.why));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendRefusedAt]);

  /* A ROW THAT LEFT AFTER ITS EDIT went with the composer (its send said so): once this card is shown
     again, it leaves for the list instead of standing on the gone sentence. */
  const shown = useIsFocused();
  const edited = useRef(false);
  useEffect(() => {
    if (row !== undefined || !edited.current || !shown) return;
    edited.current = false;
    onGone?.(id);
    onClose?.();
  }, [row, shown, id, onGone, onClose]);

  if (!row) {
    /* Discarded, answered, or drained away while this route was open. The honest gone sentence,
       never an empty card that reads as a draft with nothing in it. */
    return (
      <Screen>
        <DetailBar title={Copy.draftsTitle} />
        <Scroller>
          <Txt variant="note" tone="ink3" style={{ padding: 20 }}>
            {Copy.draftsRowGone}
          </Txt>
        </Scroller>
      </Screen>
    );
  }

  const waiting = row.waiting;
  const settlement = waiting === null ? null : w.sendSettlement(waiting.key);
  const plan = draftCardPlan(row, {
    confirming: asking === "discard",
    confirmingSendAgain: asking === "sendAgain",
    refusal: refusal?.why ?? null,
    sendRefusal: sendRefusal?.why ?? null,
    queued: queuedCaptionKey(network, settlement?.accepted === true, settlement?.rearmed === true),
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
    // A send with no row leaves the list once its Cancel is owed: said as the card goes.
    if (outcome === "cancelUnknown" && row.waiting?.rowless === true) {
      toast.say(refuse("replyCancelUnreachable"));
      leave();
      return;
    }
    if (outcome === "stillSending" || outcome === "alreadySent" || outcome === "cancelUnknown") {
      setRefusal({ why: outcome, at: Date.now() });
    }
    setBusy(false);
  };

  /* CANCEL SEND — the composer's press over the waiting send; its words stay a draft. A send with
     no row comes back under a new one, so this card closes behind it, owed Cancel or not. */
  const cancelSend = async () => {
    if (busy || waiting === null) return;
    setAsking(null);
    setRefusal(null);
    const key = waiting.key;
    const got = { kept: null as "kept" | "notKept" | null };
    const end = await cancelSendPress({
      asking: withdrawing,
      withdraw: async () => {
        const r = await w.actions.cancelWaitingSend(key);
        got.kept = r.kept;
        return r.said;
      },
      verdict: () => w.sendOutcome(key),
      standalone: w.standalone, bound: true,
    });
    if (end === null) return;
    // Words that could not be kept were said by the action; they are in no Drafts row.
    if (end.said === "close") {
      if (end.say !== null && got.kept !== "notKept") toast.say(end.say);
      if (waiting.rowless) leave();
      return;
    }
    // A send with no row leaves the list once its Cancel is owed, so the card goes with it.
    if (end.said === "unknown" && waiting.rowless) {
      if (got.kept !== "notKept") toast.say(refuse(got.kept === "kept" ? "replyCancelUnreachableKept" : "replyCancelUnreachable"));
      leave();
      return;
    }
    setRefusal({ why: end.said === "already_sent" ? "alreadySent" : "cancelUnknown", at: Date.now() });
  };

  /* IT WAS SENT — the ledger records the delivery and the row leaves Drafts. */
  const dismissAsSent = async () => {
    if (busy) return;
    setBusy(true);
    if (await w.actions.draftResolve(row.id, "arrived")) { leave(); return; }
    setBusy(false);
  };

  /* MAKE IT A DRAFT AGAIN — answered not arrived, the row an ordinary draft to edit and send as new. */
  const notArrived = async () => {
    if (busy) return;
    setBusy(true);
    if (await w.actions.draftResolve(row.id, "not_arrived")) setSendRefusal(null);
    setBusy(false);
  };

  const sendAgain = async () => {
    if (busy) return;
    setAsking(null);
    setBusy(true);
    const outcome = await w.actions.draftSendAgain(row.id);
    // `superseded`: a newer press of this row carries it and says its sentence.
    if (outcome === "sent" || outcome === "alreadySent" || outcome === "superseded") { leave(); return; }
    setSendRefusal({ why: outcome, at: Date.now() });
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

        {/* A SEND WAITING TO GO says so, with the one way to stop it; its refusals are said here. */}
        {plan.waiting !== null ? (
          <Panel style={{ paddingVertical: 14, marginBottom: 12, gap: 8 }}>
            <View style={{ paddingHorizontal: 18, gap: 4 }}>
              <Txt variant="note" tone="ink">{plan.waiting.line}</Txt>
              <Txt variant="note" tone="ink2">{plan.waiting.caption}</Txt>
            </View>
            <View style={{ paddingHorizontal: 18, flexDirection: "row" }}>
              <Button label={plan.waiting.cancelSend} variant="quiet" disabled={busy} onPress={() => void cancelSend()} />
            </View>
            {plan.refusal !== null ? (
              <Txt variant="note" tone="ink" accessibilityLiveRegion="polite" style={{ paddingHorizontal: 18 }}>
                {plan.refusal}
              </Txt>
            ) : null}
          </Panel>
        ) : null}

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
          <BodyPages
            variant="body"
            tone={row.bodyKnown && row.body !== "" ? "ink" : "ink3"}
            selectable
            style={{ paddingHorizontal: 18 }}
            text={!row.bodyKnown
              ? Copy.draftsBodyUnavailable
              : row.body === "" ? Copy.draftsTextEmpty : row.body}
          />
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
                    onPress={() => { setRefusal(null); setSendRefusal(null); setAsking("sendAgain"); }}
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

          {/* A SEND AGAIN THAT DID NOT SEND, in the row — after a failed send the row is an ordinary
              draft again and the acts are gone, so the sentence stands on its own. */}
          {plan.sendRefusal !== null ? (
            <Txt
              variant="note"
              tone="ink"
              accessibilityLiveRegion="polite"
              style={{ paddingHorizontal: 18, paddingVertical: 8 }}
            >
              {plan.sendRefusal}
            </Txt>
          ) : null}
          {plan.notArrived !== null ? (
            <View style={{ paddingHorizontal: 18, paddingVertical: 8 }}>
              <Button label={plan.notArrived} variant="quiet" disabled={busy} onPress={() => void notArrived()} />
            </View>
          ) : null}

          {/* EDIT — the composer bound to this row: what is typed is saved into it, and Send sends it. */}
          {row.edit !== null ? (
            <View style={{ paddingHorizontal: 18, paddingVertical: 8 }}>
              <Button
                label={Copy.draftsEdit}
                variant="quiet"
                disabled={busy}
                onPress={() => { edited.current = true; router.push({ pathname: "/compose", params: { draft: row.id } }); }}
              />
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
                  onPress={() => { setRefusal(null); setSendRefusal(null); setAsking("discard"); }}
                />
              </View>
            )}
            {plan.refusal !== null && plan.waiting === null ? (
              <Txt variant="note" tone="ink" accessibilityLiveRegion="polite">
                {plan.refusal}
              </Txt>
            ) : null}
          </View>
        </Panel>

        {/* Where a draft this phone cannot take whole goes to be finished; standalone, there is no elsewhere. */}
        {row.edit === null ? (
          waiting === null ? (
            <Txt variant="hint" tone="ink3" style={{ paddingHorizontal: 18, paddingBottom: 8 }}>
              {!w.standalone ? Copy.draftsEditNote : plan.held !== null ? Copy.draftsEditNoteHeldHere : Copy.draftsEditNoteHere}
            </Txt>
          ) : null
        ) : null}
      </Scroller>
    </Screen>
  );
}
