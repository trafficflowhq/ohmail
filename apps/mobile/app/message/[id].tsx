/**
 * The pushed message route — one pane's reading view. The rendering and the verbs live in
 * `src/ui/MessageReader.tsx`, which the two-pane surfaces mount beside their lists; this
 * route is the phone's full-screen host for it. When the window GAINS a second pane while
 * this route is up (the Duo unfolds mid-read, the iPad rotates onto a deep link), the open
 * message migrates to the surface whose list belongs beside it (`paneRouteFor` + the `open`
 * param the list-detail screens read) — the id survives the move and `pane-memory` restores
 * the scroll, which is the continuity rule: a posture change never loses the open message.
 */
import { useEffect } from "react";
import { Platform } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useWorld } from "../../src/state/world";
import { Gated } from "../../src/ui/Gated";
import { ReaderRailHost } from "../../src/ui/list-detail";
import { MessageReader } from "../../src/ui/MessageReader";
import { paneRouteFor } from "../../src/ui/pane-routes";
import { usePosture } from "../../src/ui/posture";
import { scaffoldPlan } from "../../src/ui/scaffold/plan";
import { useLocale } from "../../src/i18n/LocaleProvider";

/**
 * Gated like the tabs: a deep link (`ohmail://message/<id>`) can mount this route with the
 * tabs layout never focusing, and without the gate an unpaired phone would land on the
 * empty world's "no longer here" with no way out.
 */
export default function MessageScreen() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  return (
    <Gated>
      <MessageRoute />
    </Gated>
  );
}

function MessageRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const w = useWorld();
  const posture = usePosture();
  const plan = scaffoldPlan(posture, Platform.OS === "ios" ? "ios" : "android");
  const m = w.message(id ?? "");

  // TWO PANES: this full-screen route yields to the list-detail surface that owns the pair.
  // `replace`, not push — the reader is the same reading, moved, and Back must still leave it.
  const target = plan.panes === 2 && m ? paneRouteFor(m) : null;
  const targetPath = target?.pathname ?? null;
  useEffect(() => {
    if (targetPath !== null && target !== null) {
      router.replace({ pathname: targetPath, params: target.params });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetPath, target?.params.open]);

  return (
    <>
      <MessageReader id={id ?? ""} onClose={() => router.back()} />
      {/* Gate-held and folder mail keep the full-screen reader on the unfolded-landscape Duo
          (`paneRouteFor` answers null there) — the rail's claim still needs a renderer. */}
      <ReaderRailHost />
    </>
  );
}
