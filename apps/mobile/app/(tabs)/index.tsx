/**
 * Ohbox — mail from people you said Yes to.
 *
 * The list splits new / previously seen and never re-sorts under the reader:
 * opening a message in the DEMO Ohbox is non-destructive, so a row cannot cross
 * the boundary by being read. On a live account the split is the engine's own
 * `ohboxView` — new-for-you / earlier, plus the resurfaced pin group above both
 * (mail whose "show me this again" moment has come).
 *
 * The screen renders whichever world `useWorld()` answers and holds no logic of
 * its own; the demo world's lists are still the `derived.ts` selectors the
 * no-collapse manifest is asserted over.
 */
import { View } from "react-native";
import { router } from "expo-router";
import { Copy } from "../../src/copy";
import { useWorld, type WorldMail } from "../../src/state/world";
import { Panel, Screen, Scroller, Section, Tail, Txt } from "../../src/ui/base";
import { Doorbell, TopBar } from "../../src/ui/chrome";
import { MailRow } from "../../src/ui/MailRow";

export default function OhboxScreen() {
  const w = useWorld();
  const { resurfaced, fresh, seen, total, meta } = w.ohbox;

  const group = (rows: WorldMail[]) => (
    <View style={{ paddingHorizontal: 6 }}>
      {rows.map((m) => (
        <MailRow
          key={m.id}
          m={m}
          tags={w.tagsOf(m.id)}
          onPress={() => router.push(`/message/${m.id}`)}
        />
      ))}
    </View>
  );

  return (
    <Screen>
      <TopBar />
      <Scroller>
        <ViewHeadOhbox meta={meta} />
        <Doorbell initials={w.doorbell.initials} count={w.doorbell.count} />

        <Panel style={{ paddingBottom: 4 }}>
          {resurfaced.length > 0 ? (
            <>
              <Section style={{ paddingTop: 18 }}>{Copy.groupResurfaced}</Section>
              {group(resurfaced)}
            </>
          ) : null}

          {fresh.length > 0 ? (
            <>
              <Section style={resurfaced.length === 0 ? { paddingTop: 18 } : undefined}>
                {Copy.groupNew}
              </Section>
              {group(fresh)}
            </>
          ) : null}

          {seen.length > 0 ? (
            <>
              <Section>{Copy.groupSeen}</Section>
              {group(seen)}
            </>
          ) : null}

          <Tail>{Copy.ohboxTail(total, w.live)}</Tail>
        </Panel>

        <PreviewNote />
      </Scroller>
    </Screen>
  );
}

function ViewHeadOhbox({ meta }: { meta: string }) {
  return (
    <View style={{ paddingHorizontal: 10, paddingTop: 8, paddingBottom: 14 }}>
      <Txt variant="h1">{Copy.ohbox}</Txt>
      <Txt variant="meta" tone="ink3" tabular style={{ marginTop: 4 }}>
        {meta}
      </Txt>
    </View>
  );
}

/**
 * The status the demo depends on, stated on the first screen rather than buried
 * in a README: this is fixtures, and nothing leaves the device. On a LIVE
 * session the sentence would be false, so it renders nothing — claims are
 * contracts, and this one belongs to the demo world alone.
 */
export function PreviewNote() {
  const w = useWorld();
  if (w.live) return null;
  return (
    <View style={{ paddingHorizontal: 20, paddingTop: 20, gap: 3 }}>
      <Txt variant="caption" tone="ink2">
        {Copy.previewTitle}
      </Txt>
      <Txt variant="caption" tone="ink3" style={{ lineHeight: 16 }}>
        {Copy.previewNote}
      </Txt>
    </View>
  );
}
