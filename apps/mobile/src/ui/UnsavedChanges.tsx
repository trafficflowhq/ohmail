/**
 * Changes the server would not take — the phone's half of the browser's "could not be saved"
 * strip. Parity is the rule: the engine gives up on a verb after a bounded number of
 * server-answered failures and moves it out of the replay set — shared code, so it applies
 * whether or not this file exists, and without it the phone would drop a person's work silently
 * while the browser explained it. The engine owns the rule; each platform owes the sentence. It
 * lives in the chrome (`TopBar` renders it) for the freshness label's reason: a view can only
 * speak about itself, and the next tab must get the sentence for free.
 */
import { useState } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import type { AbandonedMutation } from "../state/live";
import { Copy } from "../copy";
import { describeKind, reason } from "./unsaved-copy";
import { useTheme } from "../theme";
import { useWorld } from "../state/world";
import { Tap, Txt } from "./base";

export function UnsavedChanges() {
  const t = useTheme();
  const world = useWorld();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ id: string; message: string } | null>(null);
  const { width, height } = useWindowDimensions();
  /**
   * The actions wrap under a narrow screen rather than clipping.
   *
   * The reason first written here was German — "Erneut versuchen" beside "Verwerfen" in a 360 px
   * column — and that was a claim about a state this app cannot currently reach: `copy.ts` is a
   * single hard-coded English deck with no locale mechanism, so the phone cannot render those
   * words at all. The wrap is still needed, for reasons that ARE reachable: a 360 px device at a
   * large system text size, and the German deck when it lands. Stated as the measurement the test
   * actually makes — the controls stack below 380 px — rather than as a screenshot nobody can take.
   */
  const narrow = width < 380;

  const rows = world.abandoned;
  /**
   * NOTHING TO SAY, NOTHING ON SCREEN — except a result that has not been said yet.
   *
   * The retry's answer was rendered inside the row it belonged to, and a terminal retry REMOVES
   * that row. Retrying the last record and getting `send_unverified` back therefore hit this
   * return before the sentence could appear: no warning, no record, and a person free to send
   * again mail that may already have left. A pending sentence keeps the strip alive on its own,
   * because the outcome it carries is about work that no longer has a row. Parity with the
   * browser, which had the identical collision.
   */
  if (rows.length === 0 && said === null) return null;

  /**
   * For a verb `ownerSettled` covers, this row is the only thing waiting on the result, so a
   * terminal answer has to be said here or it is said nowhere — a retried send answering
   * `send_unverified` with nothing on screen leaves a person free to send again on mail that may
   * already have left.
   */
  const act = async (id: string, fn: (id: string) => Promise<{ error?: { code?: string | null; message?: string } | null }>) => {
    setBusy(id);
    try {
      const outcome = await fn(id);
      const code = outcome.error?.code ?? null;
      setSaid(code === null ? null : { id, message: outcome.error?.message ?? "" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={{ paddingHorizontal: 16, paddingBottom: 6, gap: 6 }}>
      {rows.length === 0 && said !== null ? (
        <Tap onPress={() => setSaid(null)} accessibilityRole="button">
          <Txt variant="meta" tone="ink3">
            {said.message || Copy.unsavedNoReason} · {Copy.unsavedDismiss}
          </Txt>
        </Tap>
      ) : null}
      {rows.length === 0 ? null : (
        <Tap onPress={() => setOpen((v) => !v)} accessibilityRole="button">
          <Txt variant="meta" tone="ink3">
            {Copy.unsavedCount(rows.length)} · {open ? Copy.unsavedHide : Copy.unsavedShow}
          </Txt>
        </Tap>
      )}

      {/* SCROLLABLE, AND BOUNDED. The expanded list was a plain `View` in the chrome, outside any
          scroller: with enough abandoned rows the later Retry/Discard controls sat below the
          viewport with no way to reach them — a recovery surface that cannot be operated. The
          cap is a third of the screen so the list can never swallow the mail behind it. */}
      {open
        ? (
          <ScrollView style={{ maxHeight: Math.round(height / 3) }} nestedScrollEnabled>
            {rows.map((m) => (
          <View
            key={m.id}
            style={{
              gap: 4,
              paddingTop: 6,
              borderTopWidth: 1,
              borderTopColor: t.c.hairSoft,
            }}
          >
            <Txt variant="meta">{describeKind(m)}</Txt>
            {/* The server's own sentence where it wrote one a person can act on; an honest
                statement where it did not. `reason` holds that rule, once, for both platforms'
                worth of copy. */}
            <Txt variant="meta" tone="ink3">
              {said?.id === m.id
                ? (said.message || Copy.unsavedNoReason)
                : m.superseded ? Copy.unsavedSuperseded : reason(m)}
            </Txt>
            <View style={{
              flexDirection: narrow ? "column" : "row",
              gap: narrow ? 6 : 16,
              paddingTop: 2,
            }}>
              {/* No Try again once a newer change to the same thing has been saved — replaying
                  would overwrite it with an older intent. Parity with the browser. */}
              {!m.retryable ? null : (
                <Tap
                  disabled={busy === m.id}
                  onPress={() => void act(m.id, world.actions.retryAbandoned)}
                  accessibilityRole="button"
                >
                  <Txt variant="meta" tone="accent">{Copy.unsavedRetry}</Txt>
                </Tap>
              )}
              <Tap
                disabled={busy === m.id}
                onPress={() => void act(m.id, async (id) => { await world.actions.discardAbandoned(id); return {}; })}
                accessibilityRole="button"
              >
                <Txt variant="meta" tone="ink3">{Copy.unsavedDiscard}</Txt>
              </Tap>
            </View>
              </View>
            ))}
          </ScrollView>
        )
        : null}
    </View>
  );
}
