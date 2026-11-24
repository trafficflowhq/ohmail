/**
 * The pushed sender route — one pane's Screener detail. The rendering and the decision live
 * in `src/ui/SenderDetail.tsx`, which the Screener mounts beside its shelves on the
 * two-pane postures; this route is the phone's full-screen host for it. When the window
 * gains a second pane while this route is up, the open sender migrates to the Screener with
 * the selection in its `open` param (and the shelf in `seg`) — the same continuity rule the
 * message route follows.
 */
import { MailAppearance } from "../../../src/theme/mail";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import type { ScreenerSeg } from "../../../src/state/model";
import { Gated } from "../../../src/ui/Gated";
import { usePosture } from "../../../src/ui/posture";
import { scaffoldPlan } from "../../../src/ui/scaffold/plan";
import { SenderDetail } from "../../../src/ui/SenderDetail";
import { useLocale } from "../../../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../../../src/ui/ErrorBoundary";
import { usePaneMove } from "../../../src/ui/pane-move";
import { readerHeldNow, subscribeReaderHeld } from "../../../src/ui/reader-held";

/** Gated like the tabs — a deep-linked or restored route must not render the empty world. */
export default function SenderScreen() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  return (
    <SurfaceBoundary surface="screener">
      <MailAppearance>
        <Gated>
          <SenderRoute />
        </Gated>
      </MailAppearance>
    </SurfaceBoundary>
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
  const held = useSyncExternalStore(subscribeReaderHeld, readerHeldNow);
  /* The same door as the pushed reader's (`pane-move.ts`): an open sheet holds it, and from the
     move on this route draws nothing. */
  const leaving = usePaneMove(twoPane && id !== "" ? { pathname: "/screener", params: { open: id, seg } } : null, held);
  if (leaving !== null) return leaving;

  return <SenderDetail seg={seg} routeKey={id} onClose={() => router.back()} />;
}
