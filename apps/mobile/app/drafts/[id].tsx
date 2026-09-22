/**
 * One draft, pushed — the one-pane route behind the list's selection. The card is the same
 * component the two-pane posture renders beside the list (`src/ui/DraftReader.tsx`), so the
 * verbs and the sentences cannot drift between the two shapes.
 */
import { router, useLocalSearchParams } from "expo-router";
import { DraftReader } from "../../src/ui/DraftReader";
import { Gated } from "../../src/ui/Gated";
import { useLocale } from "../../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../../src/ui/ErrorBoundary";

export default function DraftScreen() {
  useLocale();
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <SurfaceBoundary surface="drafts">
      <Gated>
        <DraftReader id={String(id)} onClose={() => router.back()} />
      </Gated>
    </SurfaceBoundary>
  );
}
