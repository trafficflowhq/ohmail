/**
 * The pushed Trash reading route — one pane's host for `TrashReader`, exactly as
 * `message/[id].tsx` hosts `MessageReader`. The row comes from `state/trash-hold.ts` (the
 * rows are off-mirror, so an id alone has no reader to ask); a restore pops back to the
 * list. No pane migration on unfold: the trash list re-pairs a selection made ON two panes,
 * and a full-screen reading survives the posture change — the folder route's own rule
 * (`MOBILE-FOLDER-AND-GATE-HELD-READER-STAYS-FULL-SCREEN-ON-UNFOLD`), same class, stated.
 */
import { router, useLocalSearchParams } from "expo-router";
import { Gated } from "../../src/ui/Gated";
import { TrashReader } from "../../src/ui/TrashReader";
import { useLocale } from "../../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../../src/ui/ErrorBoundary";

/** Gated like the tabs: a deep link can mount this route with the tabs layout never focusing. */
export default function TrashMessageScreen() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  return (
    <SurfaceBoundary surface="trash">
      <Gated>
        <TrashMessageRoute />
      </Gated>
    </SurfaceBoundary>
  );
}

function TrashMessageRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <TrashReader
      id={id ?? ""}
      onRestored={() => {
        if (router.canGoBack()) router.back();
      }}
    />
  );
}
