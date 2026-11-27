import { useState, type ReactNode } from "react";
import { View, useWindowDimensions, type TextLayoutEvent } from "react-native";
import { Txt } from "./base";

/** Measure only the title column, leaving the amount its own space. */
export function ReceiptTitle({ subject, children }: { subject: string; children: ReactNode }) {
  const [width, setWidth] = useState(0);
  const { fontScale } = useWindowDimensions();
  return (
    <View style={{ flex: 1, minWidth: 0 }} onLayout={(event) => setWidth(Math.floor(event.nativeEvent.layout.width))}>
      <BalancedTitle key={JSON.stringify([subject, width, fontScale])} width={width}>{children}</BalancedTitle>
    </View>
  );
}

type Fit = { lines: number; min: number; max: number };

/** Like the web's balance, narrow the measure while preserving the natural line count. */
function BalancedTitle({ width, children }: { width: number; children: ReactNode }) {
  const [fit, setFit] = useState<Fit | null>(null);
  const probe = fit && fit.max - fit.min > 2 ? Math.floor((fit.min + fit.max) / 2) : null;
  const measure = ({ nativeEvent: { lines } }: TextLayoutEvent) => {
    if (lines.length < 2 || lines.length > 6) {
      setFit({ lines: lines.length, min: width, max: width });
      return;
    }
    const widths = lines.map((line) => line.width);
    setFit({
      lines: lines.length,
      min: Math.min(width, Math.floor(widths.reduce((sum, line) => sum + line, 0) / lines.length)),
      max: Math.min(width, Math.ceil(Math.max(...widths))),
    });
  };
  return (
    <>
      <Txt variant="streamTitle" onTextLayout={width > 0 && fit === null ? measure : undefined}
        style={fit && probe === null && fit.max < width ? { width: fit.max } : undefined}>{children}</Txt>
      {fit && probe !== null ? (
        <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
          style={{ position: "absolute", top: 0, left: 0, opacity: 0 }}>
          <Txt key={probe} variant="streamTitle" style={{ width: probe }} onTextLayout={(event) => {
            setFit(event.nativeEvent.lines.length <= fit.lines ? { ...fit, max: probe } : { ...fit, min: probe });
          }}>{children}</Txt>
        </View>
      ) : null}
    </>
  );
}
