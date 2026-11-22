/**
 * THE FIRST STEP: which way the calendar is with. One capsule a way our server offers and this build has a step for;
 * typing narrows them, Enter takes the first that fits. With none offered it says so in one line.
 */
import { useState, type ReactNode } from "react";
import { Blank, Button, Dot, EndDot, Page, Sentence } from "@ohmail/ui/base";
import type { SteppedWay } from "@ohmail/app-logic/calendar/setup";
import { useText } from "../text/index.js";

export interface WayStepProps {
  /** The ways offered; null while our server has not answered. */
  readonly offered: readonly SteppedWay[] | null;
  readonly leave: ReactNode;
  readonly pick: (way: SteppedWay) => void;
}

export function WayStep({ offered, leave, pick }: WayStepProps) {
  const t = useText("calsetup");
  const [typed, setTyped] = useState("");
  const words = typed.trim().toLowerCase();
  const fits = (way: SteppedWay) =>
    words === "" ||
    t(`way.${way}`)
      .toLowerCase()
      .split(/\s+/)
      .some((word) => word.startsWith(words));
  const shown = (offered ?? []).filter(fits);
  if (offered !== null && offered.length === 0) {
    return (
      <Page acts={leave}>
        <Sentence size="xl" level={1}>
          <EndDot kind="ink" product="cal">
            {t("way.none")}
          </EndDot>
        </Sentence>
      </Page>
    );
  }
  const first = shown[0];
  return (
    <Page
      acts={leave}
      stack
      material={
        offered === null ? undefined : (
          <div role="group" aria-label={t("way.group")}>
            {shown.map((way) => (
              <Button
                key={way}
                kind="two"
                size="l"
                keyHint={way === first ? "↵" : undefined}
                onPress={() => pick(way)}
              >
                {t(`way.${way}`)}
              </Button>
            ))}
          </div>
        )
      }
    >
      <Sentence size="xl" level={1}>
        {t.rich("way.sentence", {
          way: () => (
            <Blank
              key="way"
              label={t("way.label")}
              placeholder=""
              size={6}
              value={typed}
              onChange={setTyped}
              onEnter={() => first && pick(first)}
            />
          ),
        })}
        <Dot kind="hot" product="cal" />
      </Sentence>
    </Page>
  );
}
