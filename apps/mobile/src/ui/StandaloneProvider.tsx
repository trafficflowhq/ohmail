import { useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { PROTON, PROVIDERS, isProtonAddress, presetForAddress, type ProviderPreset } from "@ohmail/app-logic/mailboxes/connect/providers";
import { Copy } from "../copy";
import { onboardingType } from "../theme/type";
import { useTheme } from "../theme";
import { Txt } from "./base";
import { OnboardingButton, OnboardingPage, OnboardingTitle, useOnboardingLook } from "./OnboardingPage";

export function StandaloneProvider({ back, later, choose }: {
  back: () => void;
  later: () => void;
  choose: (preset: ProviderPreset, address: string) => void;
}) {
  const { palette } = useOnboardingLook();
  const t = useTheme();
  const [typed, setTyped] = useState("");
  const [bridge, setBridge] = useState(false);
  const email = typed.includes("@") ? typed.trim() : "";
  const query = email ? "" : typed.trim().toLowerCase();
  const manual = PROVIDERS.find((preset) => preset.manual);
  const visible = PROVIDERS.filter((preset) => (labelOf(preset) + " " + preset.label).toLowerCase().includes(query));
  const pickByText = () => {
    if (isProtonAddress(email)) {
      setBridge(true);
      return;
    }
    const preset = email ? presetForAddress(email) ?? manual : query ? visible[0] : undefined;
    if (preset) choose(preset, email);
  };

  if (bridge) {
    const pickAnother = () => setBridge(false);
    return (
      <OnboardingPage showUnsaved back={pickAnother}
        actions={<OnboardingButton label={Copy.phoneProviderPickAnother} onPress={pickAnother} />}
      >
        <OnboardingTitle text={shortProton} />
        <Txt variant="body" tone="ink2" style={{ marginTop: 16 }}>{Copy.phoneStandaloneBridge(PROTON.label)}</Txt>
      </OnboardingPage>
    );
  }
  return (
    <OnboardingPage showUnsaved back={back}
      actions={<OnboardingButton label={Copy.phoneProviderLater} kind="quiet" onPress={later} />}
    >
      <View style={styles.heading}>
        <OnboardingTitle text={Copy.phoneStandaloneProvider} end="none" />
        <View style={styles.blank}>
          <TextInput
            accessibilityLabel={Copy.phoneStandaloneProviderInput}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            keyboardAppearance={t.scheme}
            returnKeyType="next"
            value={typed}
            onChangeText={setTyped}
            onSubmitEditing={pickByText}
            maxFontSizeMultiplier={t.textCap}
            style={[styles.search, { color: palette.ink, borderColor: palette.ink }]}
          />
          <View style={[styles.dot, { backgroundColor: palette.hot }]} />
        </View>
      </View>
      <View style={styles.tiles}>
        {visible.map((preset) => (
          <View key={preset.id} style={styles.tile}>
            <OnboardingButton label={labelOf(preset)} kind="soft" onPress={() => choose(preset, email)} />
          </View>
        ))}
        {PROTON.label.toLowerCase().includes(query) ? (
          <View style={styles.tile}>
            <OnboardingButton label={shortProton} kind="soft" onPress={() => setBridge(true)} />
          </View>
        ) : null}
      </View>
    </OnboardingPage>
  );
}

const firstWord = (name: string): string => name.split(" ", 1)[0] ?? name;
const shortProton = firstWord(PROTON.label);
const labelOf = (preset: ProviderPreset): string => {
  if (preset.manual) return Copy.phoneStandaloneOther;
  return preset.account === undefined ? preset.label : firstWord(preset.label);
};

const styles = StyleSheet.create({
  heading: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: 4, marginBottom: 24 },
  blank: { flexDirection: "row", alignItems: "center", gap: 4, width: 92 },
  search: { flex: 1, minWidth: 72, minHeight: 44, borderBottomWidth: 2, borderStyle: "dotted", paddingVertical: 4, ...onboardingType.provider },
  dot: { width: 10, height: 10, borderRadius: 5 },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tile: { width: "48%", flexGrow: 1 },
});
