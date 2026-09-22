/**
 * THE BOUNDARY, DRAWN. `SurfaceBoundary` wraps one surface — the shell root, a route, the reading
 * pane, the composer — and when a render inside it throws, the person sees the app's own sentence
 * with Retry instead of losing the process (`error-boundary.ts` has the rule and the class). Retry
 * remounts the guarded subtree. A route's own hooks stand ABOVE its boundary; a throw there reaches
 * the shell's, which is the net under everything the navigator draws.
 *
 * `frame` is where the fallback stands: a `screen` fills the surface; a `sheet` is the composer's
 * shape, so the reader behind it stays readable and the sheet primitive's own way out applies;
 * `inline` is a pane's. The fallback reads the deck at render and subscribes to the language.
 */
import type { ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Copy } from "../copy";
import type { EngineLogSink } from "../engine/engine-log";
import { useLocale } from "../i18n/LocaleProvider";
import { useTheme } from "../theme";
import { Button, Empty } from "./base";
import { ErrorBoundary, surfaceLabel, type FallbackProps, type Surface } from "./error-boundary";
import { Sheet } from "./Sheet";

type Frame = "screen" | "sheet" | "inline";

export function SurfaceBoundary({
  surface,
  frame = "screen",
  onClose,
  children,
  sink,
}: {
  surface: Surface;
  frame?: Frame;
  /** The sheet frame's way out; a sheet fallback without one falls back to Retry on dismiss. */
  onClose?: () => void;
  children: ReactNode;
  /** Injected by tests; the app's one sink otherwise (`engine-log.ts`). */
  sink?: EngineLogSink;
}) {
  return (
    <ErrorBoundary
      surface={surface}
      sink={sink}
      renderFallback={(p) => <RenderErrorFallback {...p} frame={frame} onClose={onClose} />}
    >
      {children}
    </ErrorBoundary>
  );
}

function RenderErrorFallback({
  surface,
  onRetry,
  frame,
  onClose,
}: FallbackProps & { frame: Frame; onClose?: () => void }) {
  useLocale();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const where = surfaceLabel(surface);
  const card = (
    <View accessibilityLiveRegion="polite" style={{ alignItems: "center", gap: 4, paddingBottom: 24 }}>
      <Empty title={Copy.renderErrorTitle} hint={Copy.renderErrorWhere(where)} />
      <Button label={Copy.renderErrorRetry} variant="solid" onPress={onRetry} />
    </View>
  );
  if (frame === "sheet") {
    return (
      <Sheet open onClose={onClose ?? onRetry} label={where}>
        {card}
      </Sheet>
    );
  }
  if (frame === "inline") return card;
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: t.c.canvas,
        justifyContent: "center",
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
      {card}
    </View>
  );
}
