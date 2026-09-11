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
import { Button, Panel, Rule, Txt } from "./base";

export function PairConfirm({
  admission,
  busy,
  onConfirm,
  onCancel,
}: {
  admission: PairAdmission;
  /** The redeem is in flight — both controls go inert, and the primary says so. */
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <View>
      <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 14 }}>
        <Txt variant="h1">{Copy.pairConfirmTitle}</Txt>
        <Txt variant="hint" tone="ink3" style={{ marginTop: 6 }}>
          {Copy.pairConfirmLead}
        </Txt>
      </View>

      <Panel style={{ paddingTop: 4, paddingBottom: 16 }}>
        <Fact label={Copy.pairConfirmWhatLabel} value={Copy.pairConfirmWhat(admission.flavor)} />
        <Rule inset={20} />
        {/* The address VERBATIM and unabridged: it is what the person is being asked about, and a
            truncated host is the one shape a lookalike address hides in. */}
        <Fact label={Copy.pairConfirmAddressLabel} value={admission.origin} />
        <Rule inset={20} />
        {admission.pin === null ? (
          <View style={{ paddingHorizontal: 20, paddingVertical: 10 }}>
            <Txt variant="caption" tone="ink3">{Copy.pairConfirmNoKeyWhy}</Txt>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 20, paddingVertical: 10 }}>
            <Txt variant="caption" tone="ink3">{Copy.pairConfirmKeyLabel}</Txt>
            {/* `protectedCode` — the code preset, tabular, so twelve characters read as characters
                to be compared rather than as a word to be skimmed. */}
            <Txt variant="protectedCode" tabular style={{ marginTop: 4 }}>
              {shortPin(admission.pin)}
            </Txt>
            <Txt variant="caption" tone="ink3" style={{ marginTop: 6 }}>
              {Copy.pairConfirmKeyWhy}
            </Txt>
          </View>
        )}
      </Panel>

      {/* The refusal is a real control beside the verb, not the bar's back arrow: after reading
          three facts the way out belongs next to the decision. `quiet`, so the press that
          proceeds is the one that looks like the primary. */}
      <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 10 }}>
        <Button
          label={busy ? Copy.pairingBusy : Copy.pairConfirmGo}
          variant="solid"
          onPress={busy ? undefined : onConfirm}
        />
        <Button
          label={Copy.pairConfirmCancel}
          variant="quiet"
          onPress={busy ? undefined : onCancel}
        />
      </View>
    </View>
  );
}

/** One label-over-value row, the panel's own idiom (rows separated by a `Rule`, no ornament). */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ paddingHorizontal: 20, paddingVertical: 10 }}>
      <Txt variant="caption" tone="ink3">{label}</Txt>
      <Txt variant="body" style={{ marginTop: 4 }}>{value}</Txt>
    </View>
  );
}
