/**
 * The pushed sender route — one pane's Screener detail. The rendering and the decision live
 * in `src/ui/SenderDetail.tsx`, which the Screener mounts beside its shelves on the
 * two-pane postures; this route is the phone's full-screen host for it. When the window
 * gains a second pane while this route is up, the open sender migrates to the Screener with
 * the selection in its `open` param (and the shelf in `seg`) — the same continuity rule the
 * message route follows.
 */
import { useEffect } from "react";
import { Platform } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import type { ScreenerSeg } from "../../../src/state/model";
import { Gated } from "../../../src/ui/Gated";
import { usePosture } from "../../../src/ui/posture";
import { scaffoldPlan } from "../../../src/ui/scaffold/plan";
import { SenderDetail } from "../../../src/ui/SenderDetail";
import { useLocale } from "../../../src/i18n/LocaleProvider";

/** Gated like the tabs — a deep-linked or restored route must not render the empty world. */
export default function SenderScreen() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  return (
    <Gated>
      <SenderRoute />
    </Gated>
  );
}

function SenderRoute() {
  const params = useLocalSearchParams<{ seg: string; id: string }>();
  const seg = (params.seg ?? "waiting") as ScreenerSeg;
  // `useLocalSearchParams` answers URI-DECODED values already — decoding again broke every
  // route key containing `%` (an address like foo%2Fbar@example.com decoded twice) and
  // could throw outright on a bare `%`. The push side still encodes; the hook decodes once.
  const id = params.id ?? "";

  // TWO PANES: this full-screen route yields to the Screener's list-detail pair.
  const posture = usePosture();
  const plan = scaffoldPlan(posture, Platform.OS === "ios" ? "ios" : "android");
  const twoPane = plan.panes === 2;
  useEffect(() => {
    if (twoPane && id !== "") {
      router.replace({ pathname: "/screener", params: { open: id, seg } });
    }
  }, [twoPane, id, seg]);

  return <SenderDetail seg={seg} routeKey={id} onClose={() => router.back()} />;
}
