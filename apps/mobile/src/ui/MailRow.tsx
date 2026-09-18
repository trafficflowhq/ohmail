/**
 * One mail row — the prototype's `.row`, at thumb scale.
 *
 * Four lines at most, and the fourth only when the mail has something true to
 * say about itself (a blocked tracker, a protected class, a conversation).
 * Blanc's row hierarchy survives the narrower column intact: weight carries
 * unread, colour carries seen, and the dot is the only mark.
 */
import { View } from "react-native";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import type { Mail } from "../state/model";
import { Badge, TapRow, Txt } from "./base";
import { mailRowSpoken, threadOfRow, trackerShort } from "./row-spoken";

export function MailRow({ m, onPress }: { m: Mail; onPress: () => void }) {
  const t = useTheme();
  const seen = !m.unread;
  const thread = threadOfRow(m);
  const preview = m.protected ? Copy.protectedPreview : (m.snippet ?? firstLine(m.body));
  /* EVERY BADGE INSIDE THE STRIP DECIDES WHETHER THE STRIP IS DRAWN. `newSince` was missing, and
     a Resurfaced row wears nothing else in a list — so the chip saying somebody wrote since this
     came back rendered for no row on this phone. `test/mail-row-badges-spoken.test.ts` reads
     this condition against the badges below rather than trusting the next person to remember. */
  const badges = !!m.protected || !!m.trackerNote || thread > 1 || !!m.historyPlace || !!m.newSince;

  return (
    <TapRow
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={mailRowSpoken(m)}
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
          {m.protected ? (
            <Badge icon="shield" tone="accent">
              {Copy.protectedLead}
            </Badge>
          ) : null}
          {thread > 1 ? <Badge>{thread}</Badge> : null}
          {/* NEW SINCE YOU ASKED TO SEE THIS AGAIN — a resurfaced conversation that has been
              written to. Not the unread dot: the dot says "not read", this says the conversation
              moved on while it was waiting, and a row can have either without the other. */}
          {m.newSince ? <Badge tone="new">{Copy.newSinceResurfaced(m.newSince)}</Badge> : null}
          {/* WHERE IT ACTUALLY IS — a History row only. Not a pile label: History is not a
              folder, and the only honest badge is the server's own (the webapp row's `place`). */}
          {m.historyPlace ? <Badge tone="place">{m.historyPlace}</Badge> : null}
          {m.trackerNote ? <Badge icon="shield">{trackerShort(m.trackerNote)}</Badge> : null}
        </View>
      ) : null}
    </TapRow>
  );
}

function firstLine(body: string): string {
  return body.split("\n").find((l) => l.trim().length > 0) ?? "";
}
