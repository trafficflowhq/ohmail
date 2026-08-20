/**
 * Ohbox — mail from people you said Yes to.
 *
 * The list splits new / previously seen and never re-sorts under the reader.
 * The split is the engine's own `ohboxView` — new-for-you / earlier, plus the
 * resurfaced pin group above both (mail whose "show me this again" moment has
 * come).
 *
 * The screen renders what `useWorld()` answers and holds no logic of its own.
 * An empty mailbox renders an honest empty state, never sample mail.
 */
import { View } from "react-native";
import { router } from "expo-router";
import { Copy } from "../../src/copy";
import { useWorld, type WorldMail } from "../../src/state/world";
import { Empty, Panel, Screen, Scroller, Section, Tail, Txt } from "../../src/ui/base";
import { Doorbell, TopBar } from "../../src/ui/chrome";
import { MailRow } from "../../src/ui/MailRow";

export default function OhboxScreen() {
  const w = useWorld();
  const { resurfaced, fresh, seen, total, meta } = w.ohbox;

  const group = (rows: WorldMail[]) => (
    <View style={{ paddingHorizontal: 6 }}>
      {rows.map((m) => (
        <MailRow key={m.id} m={m} onPress={() => router.push(`/message/${m.id}`)} />
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
          {total === 0 ? (
            <Empty glyph="📭" title={Copy.ohboxEmptyTitle} hint={Copy.ohboxEmptyHint} />
          ) : (
            <>
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

              <Tail>{Copy.ohboxTail(total)}</Tail>
            </>
          )}
        </Panel>
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
