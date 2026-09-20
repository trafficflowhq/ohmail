/**
 * New mail — the phone could answer mail and not start any. This route is the reader's
 * own composer with no parent: the same editor, the same attachments, the same signature
 * block, the same Idempotency-Key and the same Send later, asking only the two facts a reply
 * already knows — who it goes to and what it is about. It opens with To focused. The sheet is
 * a Modal over whatever was on screen, so leaving it is the same act everywhere: closing goes
 * back, and over a queued send the close withdraws it first (`ComposeSheet.closeComposer`).
 */
import { router } from "expo-router";
import { Copy } from "../src/copy";
import { useWorld } from "../src/state/world";
import { Empty, Screen } from "../src/ui/base";
import { DetailBar } from "../src/ui/chrome";
import { Gated } from "../src/ui/Gated";
import { ComposeSheet } from "../src/ui/MessageActions";
import { useLocale } from "../src/i18n/LocaleProvider";

/** Gated like the tabs — a deep-linked route must not render the empty world. */
export default function ComposeScreen() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  return (
    <Gated>
      <ComposeBody />
    </Gated>
  );
}

function ComposeBody() {
  const w = useWorld();
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
        <Empty glyph="✉️" title={Copy.composeNoMailbox} hint={Copy.composeNoMailboxHint} />
      </Screen>
    );
  }
  return (
    <Screen>
      <DetailBar title={Copy.composeNew} />
      <ComposeSheet m={null} mode="new" onClose={leave} />
    </Screen>
  );
}
