/**
 * New mail — the phone could answer mail and not start any. This route is the reader's
 * own composer with no parent: the same editor, the same attachments, the same signature
 * block, the same Idempotency-Key and the same Send later, asking only the two facts a reply
 * already knows — who it goes to and what it is about. It opens with To focused. The sheet is
 * a Modal over whatever was on screen (the route is a transparent modal and draws no bar), so
 * leaving it is the same act everywhere: closing goes back, and over a queued send the close
 * withdraws it first (`ComposeSheet.closeComposer`).
 */
import { useRef, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { Copy } from "../src/copy";
import { useWorld } from "../src/state/world";
import { Button, Empty, Screen } from "../src/ui/base";
import { DetailBar } from "../src/ui/chrome";
import { Gated } from "../src/ui/Gated";
import { ComposeSheet, forwardAskSentence } from "../src/ui/MessageActions";
import { useLocale } from "../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../src/ui/ErrorBoundary";
import { mailtoPrefill } from "../src/ui/mailto";
import { composeDraftPlan, type ComposeDraftOpen } from "../src/ui/compose-route";

/** Gated like the tabs — a deep-linked route must not render the empty world. */
export default function ComposeScreen() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  return (
    <SurfaceBoundary surface="composer">
      <Gated>
        <ComposeBody />
      </Gated>
    </SurfaceBoundary>
  );
}

function ComposeBody() {
  const w = useWorld();
  /** A kept forward of a `no_forward` original: the ask the reader asks, answered once here. */
  const [confirmed, setConfirmed] = useState(false);
  /** The row the sheet opened on, held: the open is decided once (`compose-route.ts`). */
  const held = useRef<ComposeDraftOpen | null>(null);
  /* `?draft=<id>`: the Drafts card's Edit — the sheet opens bound to that row, or not at all. */
  const { draft: draftParam, mailto, diag } = useLocalSearchParams<{ draft?: string; mailto?: string; diag?: string }>();
  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };
  /* NOTHING TO SEND FROM is a screen, not a refused press: a phone that has mirrored no
     mailbox cannot open a composer that could only fail, and the sentence says which. */
  if (w.mailboxes.sendingId === null) {
    return (
      <Screen>
        <DetailBar title={Copy.composeNew} />
        <Empty title={Copy.composeNoMailbox} hint={Copy.composeNoMailboxHint} />
      </Screen>
    );
  }
  if (typeof draftParam === "string" && draftParam !== "") {
    const plan = composeDraftPlan(draftParam, held.current, w.drafts.find((d) => d.id === draftParam), (id) => w.message(id));
    /* A row this phone cannot take whole is never opened as a fresh letter: that would be a second row. */
    if (plan.kind !== "sheet") {
      return (
        <Screen>
          <DetailBar title={Copy.draftsTitle} />
          <Empty
            title={Copy.draftsTitle}
            hint={plan.kind === "notEditable" ? Copy.draftsEditNote
              : plan.kind === "gone" ? Copy.draftsRowGone : Copy.draftsForwardOriginalAbsent}
          />
        </Screen>
      );
    }
    held.current = plan.open;
    const { draft, original } = plan.open;
    if (original?.forwardAsk && !confirmed) {
      return (
        <Screen>
          <DetailBar title={Copy.draftsTitle} />
          <Empty title={Copy.forwardAskQuestion} hint={forwardAskSentence(original.forwardAsk)} />
          <Button label={Copy.actionForward} variant="solid" onPress={() => setConfirmed(true)} />
        </Screen>
      );
    }
    return (
      <ComposeSheet
        m={original} mode={original ? "forward" : "new"} forwardConfirmed={confirmed}
        draft={draft} onClose={leave}
      />
    );
  }
  /* THE SHEET IS THE PAGE: its own head is the one title, and the route is a transparent modal
     (`app/_layout.tsx`), so the screen it was opened over stands under it — the list and the rail
     on a two-pane posture, beside the detail pane the sheet rises over. */
  /* `?diag=`: Settings › Help & contact's block, already in the mailto's body. */
  const prefill = mailtoPrefill(mailto);
  const helpBlock = prefill && typeof diag === "string" && diag !== "" ? { diag } : {};
  return <ComposeSheet m={null} mode="new" onClose={leave} prefill={prefill} {...helpBlock} />;
}
