/**
 * THE SENTENCE IN FRONT OF THE SYSTEM PROMPT. Android's `POST_NOTIFICATIONS` dialog carries no
 * explanation of its own, and React Native shows its `rationale` only AFTER a refusal — which is
 * the one moment a first-time person will never see. So the deck's sentence goes here, on the
 * app's own sheet idiom, and the OS prompt follows a pressed Continue.
 *
 * Every rule about WHETHER to show it lives in `engine/notification-permission.ts`; this component
 * decides nothing.
 */
import { Copy } from "../copy";
import { Txt } from "./base";
import { Sheet, SheetRow } from "./Sheet";

export function NotifyPermission({
  open,
  onAnswer,
}: {
  open: boolean;
  /** `true` = show the system prompt now; `false` = dismissed. The ask is spent either way. */
  onAnswer: (go: boolean) => void;
}) {
  return (
    <Sheet open={open} onClose={() => onAnswer(false)} label={Copy.organizerNotifyTitle} cancel="own">
      <Txt variant="note" tone="ink2" style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
        {Copy.organizerNotifyWhy}
      </Txt>
      <SheetRow icon="check" label={Copy.organizerNotifyGo} onPress={() => onAnswer(true)} />
      <SheetRow icon="x" label={Copy.organizerNotifyNotNow} onPress={() => onAnswer(false)} />
    </Sheet>
  );
}
