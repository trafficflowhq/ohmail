/**
 * The network door's platform reader — the `*-native.ts` twin the node suite never imports. The
 * native half is the two readers on `modules/ohmail-posture`: Android's default-network callback,
 * iOS's path monitor, each answering "online" or "offline". A binary without them (an older build,
 * Expo Go) answers null, and the door stays `unknown`.
 */
import { requireOptionalNativeModule } from "expo";

import type { NetworkReader } from "./network-door";

interface PostureNetwork {
  getNetwork?(): string;
  addListener?(event: "onNetworkChanged", listener: (payload: { state?: string }) => void): { remove(): void };
}

export function nativeNetworkReader(): NetworkReader | null {
  const mod = requireOptionalNativeModule<PostureNetwork>("OhmailPosture");
  if (mod === null || typeof mod.getNetwork !== "function") return null;
  return {
    read: () => mod.getNetwork!(),
    subscribe: (listener) => {
      const sub = mod.addListener?.("onNetworkChanged", (p) => listener(p?.state));
      return () => { sub?.remove(); };
    },
  };
}
