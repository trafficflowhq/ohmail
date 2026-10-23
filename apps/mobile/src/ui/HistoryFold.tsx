/**
 * THE QUOTED HISTORY, FOLDED ON THE PHONE — the web's toggle (`BodyText`'s `HistoryToggle`), natively.
 * `HistoryFold` scopes a body: a `BodyPages` under it reads its text with the shared detector
 * (`quotedHistoryOfText`) and draws the new words, its end marker, a {@link HistoryRow}, and the
 * history only once opened. Collapsed by default, open per message, never mounted while folded.
 */
import { createContext, useMemo, type ReactNode } from "react";
import { StyleSheet } from "react-native";
import { Copy } from "../copy";
import { htmlHistoryVerdict, type QuotedVerdict } from "../mail/quoted-tree";
import { useTheme } from "../theme";
import { Tap, Txt } from "./base";

export interface FoldScope {
  /** The message: the open state belongs to it. */
  foldKey: string;
  /** The reader's end marker (a height-0 View), drawn where the message's own words end, above the row. */
  end?: ReactNode;
  /** The html part's own reading: the text folds only where it folds. Absent with no html part. */
  verdict?: QuotedVerdict;
}

export const FoldContext = createContext<FoldScope | null>(null);

/** `html`: the message's html part, whose reading of its history the text part's fold follows. */
export function HistoryFold({ foldKey, end, html, children }: Omit<FoldScope, "verdict"> & { html?: string | null; children: ReactNode }) {
  const verdict = useMemo(() => (html ? htmlHistoryVerdict(html) : undefined), [html]);
  const scope = useMemo(() => ({ foldKey, end, verdict }), [foldKey, end, verdict]);
  return <FoldContext.Provider value={scope}>{children}</FoldContext.Provider>;
}

/** One quiet line: the row's label says what a press does; the dots are ornament. */
export function HistoryRow({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const t = useTheme();
  const label = open ? Copy.bodyHistoryHide : Copy.bodyHistoryShow;
  return (
    <Tap
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: open }}
      style={{
        minHeight: 44, flexDirection: "row", alignItems: "center", gap: 7, alignSelf: "flex-start", marginVertical: 4,
        paddingHorizontal: 12, borderRadius: t.radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: t.c.hairSoft,
      }}
    >
      <Txt variant="caption" tone="ink3" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        ···
      </Txt>
      <Txt variant="caption" tone="ink3">{label}</Txt>
    </Tap>
  );
}
