import { startTransition, useEffect, useState } from "react";
import { HELD_OPENING } from "@ohmail/app-logic/lists/held-window";
import { afterPaint, whenQuiet } from "@ohmail/app-logic/lists/visit";
import { viewSender } from "@ohmail/app-logic/screener";
import { Rows } from "@ohmail/ui/mail";
import { useFrameElement } from "../frame/FrameRoot.js";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";
import { type ScreenerSegment, useScreener, useScreenerBeside } from "./contract.js";
import { HeldLetter } from "./held/HeldLetter.js";
import { SenderRow } from "./list/Rows.js";
import "./screener.css";

const SEGMENTS = ["waiting", "screened", "spam"] as const;
const PIECES = SEGMENTS.flatMap(
  (segment) =>
    [
      [segment, "list"],
      [segment, "reading"],
    ] as const,
);
const QUIET_MS = 400;
const idle = () => {};

/** Give the browser one hidden frame with the real row and letter-head shapes. */
export function ScreenerPrimer({ active }: { active: ScreenerSegment | null }) {
  const t = useText("screener");
  const frame = useFrameElement();
  const model = useScreener();
  const { junk } = useScreenerBeside();
  const [visited, setVisited] = useState(active !== null);
  const [step, setStep] = useState(-1);
  const [others, setOthers] = useState<"waiting" | "drawing" | "done">("waiting");
  if (active !== null && !visited) setVisited(true);

  const first = {
    waiting: model.waiting[0],
    screened: model.screenedOut[0],
    spam: junk === NONE && model.spam[0] ? viewSender(model.spam[0]) : undefined,
  };
  const beforeVisit = active === null && !visited;
  const drawing = step >= 0 && step % 2 === 0;
  const warm =
    beforeVisit &&
    model.queueSettled &&
    step < PIECES.length * 2 - 1 &&
    (step >= 0 || SEGMENTS.some((segment) => first[segment]));
  useEffect(() => {
    const body = frame?.current?.ownerDocument.body;
    if (!warm || !body || body.getClientRects().length === 0) return;
    const next = () => startTransition(() => setStep(step + 1));
    let cancelQuiet: (() => void) | undefined;
    const cancelPaint = afterPaint(
      body,
      drawing
        ? next
        : () => {
            cancelQuiet = whenQuiet(QUIET_MS, next);
          },
    );
    return () => {
      cancelPaint();
      cancelQuiet?.();
    };
  }, [frame, warm, step, drawing]);

  const inactive = SEGMENTS.filter(
    (segment) => segment !== "waiting" && segment !== active && first[segment],
  );
  const canPrime = active !== null && model.queueSettled && inactive.length > 0;
  useEffect(() => {
    const body = frame?.current?.ownerDocument.body;
    if (
      active === null ||
      others === "done" ||
      (others === "waiting" && !canPrime) ||
      !body ||
      body.getClientRects().length === 0
    )
      return;
    return afterPaint(body, () =>
      startTransition(() => {
        setOthers(others === "waiting" ? "drawing" : "done");
      }),
    );
  }, [active, canPrime, others, frame]);

  const piece = beforeVisit && drawing ? PIECES[step / 2] : undefined;
  const segments = piece ? [piece[0]] : active !== null && others === "drawing" ? inactive : [];
  if (segments.length === 0) return null;
  return (
    <div className="sc-primer" aria-hidden="true" inert>
      {segments.map((segment) => {
        const sender = first[segment];
        if (!sender) return null;
        return (
          <div key={segment}>
            {piece?.[1] !== "reading" ? (
              <Rows label={t("title")}>
                <SenderRow sender={sender} open={false} stop={false} onOpen={idle} />
              </Rows>
            ) : null}
            {piece?.[1] !== "list"
              ? sender.held
                  .slice(-HELD_OPENING)
                  .map((letter) => (
                    <HeldLetter
                      key={letter.id}
                      letter={letter}
                      from={sender.from}
                      checked={sender.checked}
                      segment={segment}
                      invites={false}
                      showBody={false}
                      onPerson={idle}
                      onRetry={idle}
                    />
                  ))
              : null}
          </div>
        );
      })}
    </div>
  );
}
