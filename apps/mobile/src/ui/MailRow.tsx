/**
 * One mail row — the prototype's `.row`, at thumb scale.
 *
 * Four lines at most, and the fourth only when the mail has something true to
 * say about itself (an attachment, a blocked tracker, a protected class, a
 * tag). Blanc's row hierarchy survives the narrower column intact: weight
 * carries unread, colour carries seen, and the dot is the only mark.
 */
import { View } from "react-native";
import type { TagId } from "@ohmail/fixtures";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { threadCount } from "../state/derived";
import type { Mail } from "../state/model";
import { world } from "../state/model";
import { Badge, TagChip, TapRow, Txt } from "./base";

export function MailRow({
  m,
  tags,
  place,
  onPress,
}: {
  m: Mail;
  tags: TagId[];
  /**
   * Shown only where the row has left its own list — the tag view, which has to
   * prove a tag is not a folder. Everywhere else the place is the screen.
   */
  place?: string;
  onPress: () => void;
}) {
  const t = useTheme();
  const seen = !m.unread;
  const thread = threadCount(m);
  const preview = m.protected ? Copy.protectedPreview : (m.snippet ?? firstLine(m.body));
  const badges =
    !!place || tags.length > 0 || !!m.attachment || !!m.protected || !!m.trackerNote || thread > 1;

  return (
    <TapRow
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${m.from.name}. ${m.subject}. ${m.time}.${m.unread ? " Unread." : ""}`}
      style={{ paddingHorizontal: 14, paddingVertical: 12 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {m.unread ? (
          <View
            style={{
              width: 5,
              height: 5,
              borderRadius: 3,
              backgroundColor: t.c.accent,
            }}
          />
        ) : null}
        <Txt
          variant={seen ? "rowSenderSeen" : "rowSender"}
          tone={seen ? "ink2" : "ink"}
          numberOfLines={1}
          style={{ flexShrink: 1 }}
        >
          {m.from.name}
        </Txt>
        <View style={{ flex: 1 }} />
        <Txt variant="caption" tone="ink3" tabular>
          {m.time}
        </Txt>
      </View>

      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10, marginTop: 2 }}>
        <Txt
          variant={seen ? "rowSubjectSeen" : "rowSubject"}
          tone={seen ? "ink2" : "ink"}
          numberOfLines={1}
          style={{ flexShrink: 1 }}
        >
          {m.subject}
        </Txt>
        {m.amount ? (
          <Txt variant="button" tone={seen ? "ink2" : "ink"} tabular style={{ marginLeft: "auto" }}>
            {m.amount}
          </Txt>
        ) : null}
      </View>

      {preview ? (
        <Txt variant="meta" tone="ink3" numberOfLines={1} style={{ marginTop: 1 }}>
          {preview}
        </Txt>
      ) : null}

      {badges ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 7 }}>
          {place ? <Badge tone="place">{place}</Badge> : null}
          {m.protected ? (
            <Badge icon="shield" tone="accent">
              {Copy.protectedLead}
            </Badge>
          ) : null}
          {m.attachment ? <Badge icon="clip">{m.attachment.size}</Badge> : null}
          {thread > 1 ? <Badge>{thread}</Badge> : null}
          {m.trackerNote ? <Badge icon="shield">{trackerShort(m.trackerNote)}</Badge> : null}
          {tags.map((id) => {
            const tag = world.tags.find((x) => x.id === id);
            if (!tag) return null;
            const hue = t.c.tag[tag.hue];
            return <TagChip key={id} name={tag.name} ink={hue.ink} bg={hue.bg} />;
          })}
        </View>
      ) : null}
    </TapRow>
  );
}

/** "1 spy pixel blocked (open-tracker)" → "1 spy pixel blocked". */
function trackerShort(note: string): string {
  return note.replace(/\s*\([^)]*\)\s*$/, "");
}

function firstLine(body: string): string {
  return body.split("\n").find((l) => l.trim().length > 0) ?? "";
}
