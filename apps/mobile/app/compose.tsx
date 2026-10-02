/**
 * New mail — the phone could answer mail and not start any. This route is the reader's
 * own composer with no parent: the same editor, the same attachments, the same signature
 * block, the same Idempotency-Key and the same Send later, asking only the two facts a reply
 * already knows — who it goes to and what it is about. It opens with To focused. The sheet is
 * a Modal over whatever was on screen, so leaving it is the same act everywhere: closing goes
 * back, and over a queued send the close withdraws it first (`ComposeSheet.closeComposer`).
 */
import { useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { Copy } from "../src/copy";
import { useWorld } from "../src/state/world";
import { Button, Empty, Screen } from "../src/ui/base";
import { DetailBar } from "../src/ui/chrome";
import { Gated } from "../src/ui/Gated";
import { ComposeSheet, forwardAskSentence } from "../src/ui/MessageActions";
import { useLocale } from "../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../src/ui/ErrorBoundary";
import { emptyDraft, parseMailto } from "../src/ui/mailto";

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
  /* `?draft=<id>`: the Drafts card's Edit — the sheet opens bound to that row, or not at all. */
  const { draft: draftParam, mailto } = useLocalSearchParams<{ draft?: string; mailto?: string }>();
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
    const row = w.drafts.find((d) => d.id === draftParam);
    /* A row this phone cannot take whole is never opened as a fresh letter: that would be a second row. */
    if (!row || row.edit === null) {
      return (
        <Screen>
          <DetailBar title={Copy.draftsTitle} />
          <Empty title={Copy.draftsTitle} hint={Copy.draftsEditNote} />
        </Screen>
      );
    }
    /* A FORWARD DRAFT OPENS AS A FORWARD of its original, which the send reads from this
       mirror; one this phone does not hold is said, never opened as a plain mail. */
    const original = row.edit.forwardOf !== null ? w.message(row.edit.forwardOf) : undefined;
    if (row.edit.forwardOf !== null && !original) {
      return (
        <Screen>
          <DetailBar title={Copy.draftsTitle} />
          <Empty title={Copy.draftsTitle} hint={Copy.draftsForwardOriginalAbsent} />
        </Screen>
      );
    }
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
      <Screen>
        <DetailBar title={Copy.draftsTitle} />
        <ComposeSheet
          m={original ?? null} mode={original ? "forward" : "new"} forwardConfirmed={confirmed}
          draft={{ id: row.id, body: row.body, ...row.edit }} onClose={leave}
        />
      </Screen>
    );
  }
  return (
    <Screen>
      <DetailBar title={Copy.composeNew} />
      <ComposeSheet m={null} mode="new" onClose={leave} prefill={prefillOf(mailto)} />
    </Screen>
  );
}

/**
 * `?mailto=<link>`: a `mailto:` pressed in a message, read by the one parser. The phone's composer
 * has To, Subject and the body; a link's Cc and Bcc are not carried (filed, PHONE-MAILTO-CC-BCC).
 */
function prefillOf(raw: string | undefined): { to: string; subject: string; body: string } | undefined {
  const d = typeof raw === "string" ? parseMailto(raw) : null;
  if (d === null || emptyDraft(d)) return undefined;
  return { to: d.to.join(", "), subject: d.subject, body: d.body };
}
