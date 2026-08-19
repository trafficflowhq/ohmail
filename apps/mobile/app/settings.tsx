/**
 * Settings — appearance, notifications, mailboxes, tags.
 *
 * Every switch here is real state in the store, and every claim is one this
 * build can keep. The notification privacy note is the product promise
 * verbatim; the mailbox list says the mail stays in real folders on those
 * servers, which is the whole thesis; and the About block states what this
 * build is instead of implying an account exists.
 *
 * ON A LIVE SESSION THIS SCREEN IS STILL THE DEMO'S: appearance is real, but
 * the notification switches, mailboxes and tags below are the fixture world's,
 * and the banner at the top says exactly that. The pairing itself is managed
 * on the Servers screen, which is real.
 */
import { Switch, View } from "react-native";
import { Copy } from "../src/copy";
import { useTheme, type ThemePref } from "../src/theme";
import { taggedMail } from "../src/state/derived";
import { world } from "../src/state/model";
import { useStore } from "../src/state/store";
import { useWorld } from "../src/state/world";
import { Badge, Chip, Panel, Rule, Screen, Scroller, Section, Txt } from "../src/ui/base";
import { DetailBar } from "../src/ui/chrome";
import { Segmented } from "../src/ui/Segmented";

export default function SettingsScreen() {
  const t = useTheme();
  const w = useWorld();
  const { s, setTheme, toggleNotification, resolveVipSuggestion } = useStore();
  const sug = world.notificationSettings.learnedSuggestion;

  return (
    <Screen>
      <DetailBar title={Copy.settings} />
      <Scroller>
        <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 16 }}>
          <Txt variant="h1">{Copy.settings}</Txt>
          {w.live ? (
            <Txt variant="caption" tone="ink2" style={{ marginTop: 8, lineHeight: 16 }}>
              {Copy.settingsDemoOnly}
            </Txt>
          ) : null}
        </View>

        {/* appearance */}
        <Panel style={{ paddingBottom: 16, marginBottom: 14 }}>
          <Section style={{ paddingTop: 16 }}>{Copy.theme}</Section>
          <View style={{ paddingHorizontal: 16 }}>
            <Segmented<ThemePref>
              value={s.themePref}
              onChange={setTheme}
              segments={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
            <Txt variant="caption" tone="ink3" style={{ marginTop: 10 }}>
              {Copy.themeNote}
            </Txt>
          </View>
        </Panel>

        {/* notifications */}
        <Panel style={{ paddingBottom: 16, marginBottom: 14 }}>
          <Section style={{ paddingTop: 16 }}>{Copy.notifications}</Section>
          {world.notificationSettings.channels.map((c, i) => (
            <View key={c.id}>
              {i > 0 ? <Rule inset={20} /> : null}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 14,
                  paddingHorizontal: 20,
                  paddingVertical: 12,
                  minHeight: 56,
                }}
              >
                <View style={{ flex: 1 }}>
                  <Txt variant="settingsLabel">{c.label}</Txt>
                  <Txt variant="caption" tone="ink3" style={{ marginTop: 2 }}>
                    {c.description}
                  </Txt>
                </View>
                <Switch
                  value={s.notifications[c.id]}
                  onValueChange={() => toggleNotification(c.id)}
                  accessibilityLabel={c.label}
                  trackColor={{ true: t.c.accent, false: t.c.tint2 }}
                  ios_backgroundColor={t.c.tint2}
                />
              </View>
            </View>
          ))}

          <View style={{ paddingHorizontal: 20, paddingTop: 14, gap: 8 }}>
            <Txt variant="caption" tone="ink3">
              {Copy.vipHeading}
            </Txt>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {s.vips.map((v) => (
                <Badge key={v} tone="place">
                  {v}
                </Badge>
              ))}
            </View>

            {s.vipSuggestion === "open" ? (
              <View style={{ gap: 8, marginTop: 6 }}>
                <Chip icon="spark" variant="pending">
                  {sug.text}
                </Chip>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Chip onPress={() => resolveVipSuggestion(true)}>Add to VIP</Chip>
                  <Chip onPress={() => resolveVipSuggestion(false)}>No thanks</Chip>
                </View>
              </View>
            ) : null}

            <Txt variant="caption" tone="ink3" style={{ marginTop: 8, lineHeight: 16 }}>
              {world.notificationSettings.privacyNote}
            </Txt>
          </View>
        </Panel>

        {/* mailboxes */}
        <Panel style={{ paddingBottom: 16, marginBottom: 14 }}>
          <Section style={{ paddingTop: 16 }}>{Copy.mailboxes}</Section>
          {world.mailboxes.map((mb, i) => (
            <View key={mb.id}>
              {i > 0 ? <Rule inset={20} /> : null}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  paddingHorizontal: 20,
                  paddingVertical: 12,
                }}
              >
                <View style={{ flex: 1 }}>
                  <Txt variant="settingsLabel">{mb.name}</Txt>
                  <Txt variant="caption" tone="ink3" style={{ marginTop: 2 }}>
                    {mb.address}
                  </Txt>
                </View>
                <Badge>{mb.railHint}</Badge>
                <Badge tone="accent">{mb.status}</Badge>
              </View>
            </View>
          ))}
          <Txt variant="caption" tone="ink3" style={{ paddingHorizontal: 20, paddingTop: 12, lineHeight: 16 }}>
            {Copy.mailboxesNote}
          </Txt>
        </Panel>

        {/* tags */}
        <Panel style={{ paddingBottom: 16, marginBottom: 14 }}>
          <Section style={{ paddingTop: 16 }}>{Copy.tags}</Section>
          {world.tags.map((tag) => {
            const hue = t.c.tag[tag.hue];
            return (
              <View
                key={tag.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  paddingHorizontal: 20,
                  paddingVertical: 10,
                }}
              >
                <View style={{ width: 8, height: 8, borderRadius: t.radius.dot, backgroundColor: hue.ink }} />
                <Txt variant="settingsLabel">{tag.name}</Txt>
                <View style={{ flex: 1 }} />
                <Txt variant="caption" tone="ink3" tabular>
                  {taggedMail(s, tag.id).length}
                </Txt>
              </View>
            );
          })}
          <Txt variant="caption" tone="ink3" style={{ paddingHorizontal: 20, paddingTop: 8, lineHeight: 16 }}>
            {Copy.tagsNote}
          </Txt>
        </Panel>

        {/* about — one sentence per world, each true of the session on screen */}
        <Panel style={{ paddingVertical: 18, marginBottom: 10 }}>
          <View style={{ paddingHorizontal: 20, gap: 6 }}>
            <Txt variant="settingsLabel">{Copy.about}</Txt>
            <Txt variant="note" tone="ink2">
              {w.live ? Copy.aboutLive(w.account.name) : Copy.previewNote}
            </Txt>
          </View>
        </Panel>
      </Scroller>
    </Screen>
  );
}
