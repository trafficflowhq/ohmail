/**
 * Search — the mirror's instant index on the phone, the webapp SearchView's contract in
 * the one-pane shape: results are the rows every list here renders, the SIMILAR tier stands
 * under its own heading and only when nothing matched exactly, and every answer states what it
 * is an answer over (subjects, senders, the first 200 characters — never body text, which is
 * the archive's). It reads the mirror, so it answers OFFLINE. An address-shaped query that
 * settles empty offers the address door — the web's own empty-state sentence — and the door
 * opens the device's address view: All · From them · To them, the engine's `messagesWith`.
 */
import { useEffect, useState } from "react";
import { TextInput, View } from "react-native";
import { router } from "expo-router";
import type { AddressDirection } from "@ohmail/client-engine";
import { Copy } from "../src/copy";
import { addressShaped } from "../src/state/live";
import { useWorld } from "../src/state/world";
import { useTheme } from "../src/theme";
import { Empty, Panel, Screen, Scroller, Section, Tap, Txt } from "../src/ui/base";
import { DetailBar } from "../src/ui/chrome";
import { Gated } from "../src/ui/Gated";
import { MailRow } from "../src/ui/MailRow";
import { Segmented } from "../src/ui/Segmented";
import { useLocale } from "../src/i18n/LocaleProvider";
import type { WorldMail } from "../src/state/world";

/** Gated like the tabs — a deep-linked route must not render the empty world. */
export default function SearchScreen() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  return (
    <Gated>
      <SearchBody />
    </Gated>
  );
}

function SearchBody() {
  const t = useTheme();
  const w = useWorld();
  const [q, setQ] = useState("");
  /** The address view this screen switched into — the empty state's door. Typing leaves it. */
  const [addr, setAddr] = useState<string | null>(null);
  const [dir, setDir] = useState<AddressDirection>("any");

  /* Build the index off the keystroke path, so the first characters meet one that is there. */
  const warm = w.search.warm;
  useEffect(() => {
    warm();
  }, [warm]);

  const trimmed = q.trim();
  const answer = addr === null ? w.search.query(q) : null;
  const around = addr !== null ? w.search.address(addr, dir) : null;
  const door = answer !== null ? addressShaped(trimmed) : null;

  const rows = (list: WorldMail[]) => (
    <View style={{ paddingHorizontal: 6 }}>
      {list.map((m) => (
        <MailRow key={m.id} m={m} onPress={() => router.push(`/message/${m.id}`)} />
      ))}
    </View>
  );

  return (
    <Screen>
      <DetailBar title={Copy.search} />
      <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
        <TextInput
          value={addr ?? q}
          onChangeText={(text) => {
            // Typing is a new question — it leaves the address view and asks the index.
            setAddr(null);
            setQ(text);
          }}
          autoFocus
          placeholder={Copy.searchPlaceholder}
          placeholderTextColor={t.c.ink3}
          accessibilityLabel={Copy.search}
          autoCapitalize="none"
          autoCorrect={false}
          style={[
            t.type.body,
            {
              color: t.c.ink,
              backgroundColor: t.c.tint2,
              borderRadius: t.radius.pill,
              paddingHorizontal: 14,
              paddingVertical: 9,
            },
          ]}
        />
      </View>
      <Scroller>
        {around !== null && addr !== null ? (
          /* ── THE ADDRESS VIEW — the device's half, three directions, all three counts ───── */
          <Panel style={{ paddingBottom: 8 }}>
            <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 4 }}>
              {/* The group carries the question; the three tabs carry the answers. */}
              <View accessibilityRole="tablist" accessibilityLabel={Copy.searchAddressToggleAria}>
                <Segmented
                  fill={false}
                  segments={[
                    { value: "any", label: Copy.searchAddressAll },
                    { value: "from", label: Copy.searchAddressFrom },
                    { value: "to", label: Copy.searchAddressTo },
                  ]}
                  value={dir}
                  onChange={setDir}
                />
              </View>
              {/* The three counts, always all three — the toggle can say what each holds. */}
              <Txt variant="meta" tone="ink3" tabular style={{ marginTop: 8 }}>
                {Copy.searchAddressCounts(around.counts.any, around.counts.from, around.counts.to)}
              </Txt>
            </View>
            {around.items.length === 0 ? (
              <Empty
                glyph="🔎"
                title={
                  dir === "from"
                    ? Copy.searchAddressEmptyFrom(addr)
                    : dir === "to"
                      ? Copy.searchAddressEmptyTo(addr)
                      : Copy.searchAddressEmptyAny(addr)
                }
                hint={Copy.searchScopeDevice}
              />
            ) : (
              rows(around.items)
            )}
          </Panel>
        ) : answer !== null && trimmed === "" ? (
          /* Resting: what a search HERE can answer, before any claim about the mailbox. */
          <Txt variant="note" tone="ink3" style={{ paddingHorizontal: 14, paddingTop: 8 }}>
            {Copy.searchScopeDevice}
          </Txt>
        ) : answer !== null ? (
          <Panel style={{ paddingBottom: 8 }}>
            {answer.items.length === 0 && answer.similar.length === 0 ? (
              answer.indexing ? (
                /* Not yet ≠ nothing: the index is still filling, and the two are different
                   sentences (`indexingResult`'s whole rule). */
                <Empty glyph="🔎" title={Copy.searchIndexing} hint={Copy.searchScopeDevice} />
              ) : (
                <>
                  <Empty glyph="🔎" title={Copy.searchEmptyTitle} hint={Copy.searchScopeDevice} />
                  {door !== null ? (
                    /* THE ADDRESS DOOR — the web's empty-state sentence, and here it IS the
                       door: the press opens the two scopes it names. */
                    <Tap
                      onPress={() => {
                        setAddr(door);
                        setDir("any");
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={Copy.searchEmptyAddressScopes(door)}
                      style={{ paddingHorizontal: 16, paddingVertical: 10 }}
                    >
                      <Txt variant="note" tone="accent">
                        {Copy.searchEmptyAddressScopes(door)}
                      </Txt>
                    </Tap>
                  ) : null}
                </>
              )
            ) : (
              <>
                <Section style={{ paddingTop: 14 }}>
                  {Copy.searchResultsHead(answer.items.length + answer.similar.length)}
                </Section>
                {rows(answer.items)}
                {answer.similar.length > 0 ? (
                  <>
                    <Section>{Copy.searchSimilarHead}</Section>
                    <Txt variant="caption" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
                      {Copy.searchSimilarHint}
                    </Txt>
                    {rows(answer.similar)}
                  </>
                ) : null}
              </>
            )}
          </Panel>
        ) : null}
      </Scroller>
    </Screen>
  );
}
