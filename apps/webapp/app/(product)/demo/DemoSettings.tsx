"use client";

import { useState } from "react";
import { useReport } from "@ohmail/app/frame";
import { AboutPane } from "@ohmail/app/settings/about";
import { useText } from "@ohmail/app/text";
import { useMirror } from "@ohmail/app-logic/reader";
import { Button } from "@ohmail/ui/base";
import { SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";

interface DemoNotificationSettings {
  channels: { id: string; enabled: boolean }[];
  vipLabel: string;
  vips: string[];
  learnedSuggestion: {
    text: string;
    target: string;
    acceptedToast: string;
    dismissedToast: string;
  };
}

function DemoAboutPane() {
  return <AboutPane demo />;
}

export const DEMO_ABOUT = { name: "about", render: DemoAboutPane } as const;

export function DemoNotificationsPane() {
  const { mirror } = useMirror();
  const fixture = mirror?.get<DemoNotificationSettings>("view_meta", "notifications");
  return fixture ? <DemoNotificationChoices fixture={fixture} /> : null;
}

/** The demo's old preview choices stay with the pane and ask no operating system or server. */
function DemoNotificationChoices({ fixture }: { readonly fixture: DemoNotificationSettings }) {
  const t = useText("settings");
  const report = useReport();
  const [channels, setChannels] = useState(fixture.channels);
  const [choice, setChoice] = useState<"open" | "accepted" | "dismissed">("open");
  const suggestion = fixture.learnedSuggestion;
  const people = choice === "accepted" && !fixture.vips.includes(suggestion.target)
    ? [...fixture.vips, suggestion.target]
    : fixture.vips;

  return (
    <>
      <SettingsSheet>
        {channels.map((channel) => (
          <SettingLine
            key={channel.id}
            label={t(`channel.${channel.id}.label`)}
            value={t(`channel.${channel.id}.description`)}
            toggle={{
              on: channel.enabled,
              onChange: (enabled) => setChannels((current) => current.map((item) =>
                item.id === channel.id ? { ...item, enabled } : item)),
            }}
          />
        ))}
        <SettingNote>{t("notificationPrivacy")}</SettingNote>
      </SettingsSheet>
      <SettingsSheet title={fixture.vipLabel}>
        {people.map((person) => <SettingLine key={person} label={person} />)}
        {choice === "open" ? (
          <>
            <SettingNote>{suggestion.text}</SettingNote>
            <Button kind="ink" size="s" onPress={() => {
              setChoice("accepted");
              report(suggestion.acceptedToast);
            }}>{t("learnedYes")}</Button>
            <Button kind="quiet" size="s" onPress={() => {
              setChoice("dismissed");
              report(suggestion.dismissedToast);
            }}>{t("learnedNo")}</Button>
          </>
        ) : null}
      </SettingsSheet>
    </>
  );
}
