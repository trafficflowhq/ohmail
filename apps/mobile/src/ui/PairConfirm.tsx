/**
 * The confirmation before a pairing code is spent — the person in the middle of the ceremony. The desktop's Devices
 * pane promises "a device pairing over your network shows these characters before it pairs"; this screen is that
 * sentence being true, and the twelve characters come from `shortPin` on the shared pairing-link module — two ends of
 * a comparison computed by two rules compare nothing. A component, not a route: the app registers `ohmail` as a
 * browsable deep link, and a route would put the token and address in route parameters — the attack `net/pairing.ts`
 * documents. Everything shown is measured, from the {@link PairAdmission} a credential-free probe produced;
 * deliberately no display name (a name in the QR is the attacker's to choose). The key row renders only where a pin
 * is in play — a row inviting comparison against a value nothing shows is a check that cannot be performed.
 */
import { View } from "react-native";
/* `shortPin` through the pairing seam, not through the engine barrel: this app's network census
   refuses a UI file that imports the engine package at all, and `net/pairing.ts` re-exports the
   symbol for the same reason it re-exports the link parser — the screens keep one import. */
import { Copy } from "../copy";
import { shortPin, type PairAdmission } from "../net/pairing";
import { Button, Txt } from "./base";
import { OnboardingButton, OnboardingPage, OnboardingTitle, useOnboardingLook, useOnboardingButton } from "./OnboardingPage";

export function PairConfirm({
  admission,
  busy,
  onConfirm,
  onCancel,
  back,
}: {
  admission: PairAdmission;
  /** The redeem is in flight — both controls go inert, and the primary says so. */
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  back: (() => void) | undefined;
}) {
  const { palette } = useOnboardingLook();
  const onboardingButton = useOnboardingButton();
  return (
    <OnboardingPage
      showUnsaved
      back={back}
      actions={
        <>
          <Button appearance={onboardingButton} label={busy ? Copy.pairingBusy : Copy.pairConfirmGo} disabled={busy} onPress={onConfirm} />
          {!busy ? <OnboardingButton label={Copy.pairConfirmCancel} kind="quiet" onPress={onCancel} /> : null}
        </>
      }
    >
      <OnboardingTitle text={Copy.pairConfirmTitle} compact />
      <View style={{ backgroundColor: palette.sheet, borderRadius: 20, padding: 16, marginTop: 16, gap: 12 }}>
        <Fact label={Copy.pairConfirmWhatLabel} value={Copy.pairConfirmWhat(admission.flavor)} />
        <Fact label={Copy.pairConfirmAddressLabel} value={admission.origin} />
        {admission.pin === null ? null : (
          <Fact label={Copy.pairConfirmKeyLabel} value={shortPin(admission.pin)} code />
        )}
        <Txt variant="note" style={{ color: palette.ink2 }}>
          {admission.pin === null ? Copy.pairConfirmNoKeyWhy : Copy.pairConfirmKeyWhy}
        </Txt>
      </View>
      <Txt variant="body" style={{ marginTop: 16, color: palette.ink, fontWeight: "700" }}>{Copy.pairConfirmLead}</Txt>
    </OnboardingPage>
  );
}

function Fact({ label, value, code }: { label: string; value: string; code?: boolean }) {
  const { palette } = useOnboardingLook();
  return (
    <View style={{ gap: 4 }}>
      <Txt variant="caption" style={{ color: palette.ink2 }}>{label}</Txt>
      <Txt variant={code ? "protectedCode" : "body"} tabular={code} style={{ color: palette.ink }}>{value}</Txt>
    </View>
  );
}
