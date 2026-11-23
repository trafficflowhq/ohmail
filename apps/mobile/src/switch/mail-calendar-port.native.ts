import { AppState } from "react-native";
import * as Crypto from "expo-crypto";
import { handoffMinter, type ConnectedSession } from "../net/pairing";
import { pairingDigest } from "./digest";
import { switchNative } from "./switch-native";
import { switchSender } from "./sender";
import type { MailCalendarPort } from "./mail-calendar-port";

export function mailCalendarPort(session: ConnectedSession | null): MailCalendarPort | null {
  const native = switchNative();
  if (native === null) return null;
  return {
    native,
    sender: switchSender({
      app: "ohmail", native, now: Date.now, inFront: () => AppState.currentState === "active",
      digest: () => session && !session.standalone
        ? pairingDigest(
          (value) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value, { encoding: Crypto.CryptoEncoding.BASE64 }),
          session.profile.origin, session.profile.accountId,
        )
        : Promise.resolve(null),
      mint: session ? handoffMinter(session, "ohcal") : undefined,
    }),
  };
}
