/**
 * One draft, read — and the two answers a held send can be given. The webapp
 * opens a draft in its editor; this app has none, so this card RECOVERS rather than edits: the
 * text in full and selectable, where the message goes to be finished, and — for a send this
 * server could not confirm — the pair of verbs that is the only way out of the held state.
 * Discard is two presses, the webapp `DraftsView`'s rule: `DELETE /drafts/:id` is a real delete
 * and the only copy of an unsent message is not something a mis-tap may take.
 */
import { useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { Copy } from "../copy";
import { useWorld } from "../state/world";
import { Button, Panel, Rule, Screen, Scroller, Txt } from "./base";
import { DetailBar } from "./chrome";

export function DraftReader({
  id,
  onGone,
  onClose,
}: {
  id: string;
  /** The row left Drafts (discarded, or answered "it arrived") — the pane closes behind it. */
  onGone?: (id: string) => void;
  onClose?: () => void;
}) {
  const w = useWorld();
  const row = w.drafts.find((d) => d.id === id);
  const [busy, setBusy] = useState(false);
  /** Pressed Discard once. One row, one confirm — the webapp's own ceremony. */
  const [confirming, setConfirming] = useState(false);
  /**
   * A DISCARD THE SERVER REFUSED BECAUSE THIS ROW HAS A SEND ON RECORD — the card turns to the
   * "Did this message arrive?" pair rather than reporting a fault with no way out. Held as state
   * and not derived, because it is a thing the SERVER said about a row whose mirror status may
   * still read `draft`: the lost-answer case the webapp answers with its own jar read.
   */
  const [askResolve, setAskResolve] = useState(false);

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

  const held = row.state !== "open" || askResolve;

  const leave = () => {
    onGone?.(row.id);
    onClose?.();
  };

  const discard = async () => {
    if (busy) return;
    setBusy(true);
    const outcome = await w.actions.draftDiscard(row.id);
    setConfirming(false);
    if (outcome === "discarded") { leave(); return; }
    // `held` is the server's answer, not a fault: the pair below is what it asks for.
    if (outcome === "held") setAskResolve(true);
    setBusy(false);
  };

  const resolve = async (outcome: "arrived" | "not_arrived") => {
    if (busy) return;
    setBusy(true);
    const ok = await w.actions.draftResolve(row.id, outcome);
    // "It arrived" writes `sent` and the row leaves the list; "It didn't arrive" leaves an
    // ordinary draft standing here, so only the first closes the card.
    if (ok && outcome === "arrived") { leave(); return; }
    if (ok) setAskResolve(false);
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

        {/* WHAT STATE THIS SEND IS IN, in the catalogue's own words. `held` and `interrupted` are
            two different facts about the same danger and each carries its own sentence. */}
        {row.state !== "open" ? (
          <Panel style={{ paddingVertical: 14, marginBottom: 12 }}>
            <Txt variant="note" tone="ink2" style={{ paddingHorizontal: 18 }}>
              {row.state === "held" ? Copy.draftsUnverifiedNote : Copy.draftsInterruptedNote}
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
              `bodyKnown` is the engine's one predicate and the distinction a recovery surface may
              not collapse — the text is selectable, because on a held row it is the only copy. */}
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
          {/* DID IT ARRIVE — the only way out of a held row, and the reason this screen exists on
              the phone. Offered for the two held states and for a row the server refused a
              discard on; never for an ordinary draft, which has no question to answer. */}
          {held ? (
            <View style={{ paddingHorizontal: 18, paddingVertical: 8, gap: 8 }}>
              <Txt variant="note">{Copy.draftsResolveWhat}</Txt>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <Button
                  label={Copy.draftsResolveArrived}
                  variant={busy ? "plain" : "quiet"}
                  onPress={busy ? undefined : () => void resolve("arrived")}
                />
                <Button
                  label={Copy.draftsResolveNotArrived}
                  variant={busy ? "plain" : "quiet"}
                  onPress={busy ? undefined : () => void resolve("not_arrived")}
                />
              </View>
            </View>
          ) : null}

          {/* OPEN THE CONVERSATION — offered only where `liveDrafts` measured the parent present
              in THIS mirror. Never a promise about a message this device may not hold. */}
          {row.repliesHere && row.inReplyToMessageId !== null ? (
            <>
              {held ? <Rule inset={18} /> : null}
              <View style={{ paddingHorizontal: 18, paddingVertical: 8 }}>
                <Button
                  label={Copy.draftsOpenConversation}
                  variant="quiet"
                  onPress={() => router.push(`/message/${row.inReplyToMessageId}`)}
                />
              </View>
            </>
          ) : null}

          {/* DISCARD — absent while a question is standing: the answer comes first, which is what
              the server's own refusal says. Two presses, and the confirm states what it takes. */}
          {!held ? (
            <>
              {row.repliesHere ? <Rule inset={18} /> : null}
              <View style={{ paddingHorizontal: 18, paddingVertical: 8, gap: 8 }}>
                {confirming ? (
                  <>
                    <Txt variant="note" tone="ink2">{Copy.draftsDiscardWhat}</Txt>
                    <View style={{ flexDirection: "row", gap: 10 }}>
                      <Button
                        label={Copy.draftsDiscardConfirm}
                        variant={busy ? "plain" : "quiet"}
                        onPress={busy ? undefined : () => void discard()}
                      />
                      <Button
                        label={Copy.draftsDiscardCancel}
                        variant="plain"
                        onPress={() => setConfirming(false)}
                      />
                    </View>
                  </>
                ) : (
                  <View style={{ flexDirection: "row" }}>
                    <Button
                      label={Copy.draftsDiscard}
                      variant="quiet"
                      onPress={() => setConfirming(true)}
                    />
                  </View>
                )}
              </View>
            </>
          ) : null}
        </Panel>

        {/* Where the message goes to be finished — `scheduledEditNote`'s twin, for its reason. */}
        <Txt variant="hint" tone="ink3" style={{ paddingHorizontal: 18, paddingBottom: 8 }}>
          {Copy.draftsEditNote}
        </Txt>
      </Scroller>
    </Screen>
  );
}
