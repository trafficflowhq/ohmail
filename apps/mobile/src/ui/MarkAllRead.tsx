/**
 * The list header's "mark all read" — the webapp component's rule in this idiom
 * (`apps/webapp/app/components/MarkAllRead.tsx`): it renders NOTHING when the view shows
 * nothing to clear, because a control pressable against an already-cleared list lies about
 * what it does. Two counts feed it — `unreadCount` is the mailbox's own read state, the same
 * field the rows render; `freshCount` is a stream's waterline "new since you were here",
 * which can stand above zero unread — and the spoken name carries whichever the press is
 * about. The press itself is the caller's (`actions.markAllSeen`).
 */
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { Tap, Txt } from "./base";

export function MarkAllRead({
  unreadCount,
  freshCount = 0,
  onPress,
}: {
  unreadCount: number;
  /** The fresh side of the view's waterline, for the streams. Absent ⇒ unread alone decides. */
  freshCount?: number;
  onPress: () => void;
}) {
  const t = useTheme();
  if (unreadCount <= 0 && freshCount <= 0) return null;
  return (
    <Tap
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        unreadCount > 0 ? Copy.markAllAria(unreadCount) : Copy.markAllAriaFresh(freshCount)
      }
      style={({ pressed }) => ({
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: t.radius.pill,
        backgroundColor: pressed ? t.c.tint : "transparent",
      })}
    >
      <Txt variant="caption" tone="ink3">
        {Copy.markAll}
      </Txt>
    </Tap>
  );
}
