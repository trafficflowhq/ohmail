/**
 * THE SCAN. Native's camera stands over the page where the page's square is: the square's rectangle is told when the
 * step starts and whenever it moves, and the camera is put away when the step ends. A code never reaches the page:
 * native measures it and hands a one-use ticket with what answered, which the next step confirms. Without the camera
 * the square says so, with Allow; by hand, the whole link goes into a blank that is a password's and is gone from it
 * at the press.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, CameraSquare, Page } from "@ohmail/ui/base";
import { DoorForm } from "../doors/stage/DoorForm.js";
import { SaidWith } from "../doors/stage/Said.js";
import { SentenceBlank } from "../doors/stage/SentenceBlank.js";
import { handedOf, sendCode, useLive } from "./answers.js";
import type { PhoneCamera, PhoneRect, SaidRefusal } from "./contract.js";
import { useDoorWords } from "./namespace.js";
import type { StepProps } from "./states.js";

/** The square's place in CSS px of the page's window, whole and never negative, as the door's guard takes it. */
function rectOf(el: Element): PhoneRect {
  const r = el.getBoundingClientRect();
  const whole = (n: number): number => Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  return { x: whole(r.x), y: whole(r.y), w: whole(r.width), h: whole(r.height) };
}

/** A camera's answer read by its shape: anything but `on` is off. */
const cameraOf = (a: PhoneCamera | null | undefined): "on" | "off" => (a?.camera === "on" ? "on" : "off");

export function Scan(props: StepProps): ReactNode {
  return props.seed.phase === "byHand" ? <ByLink {...props} /> : <Camera {...props} />;
}

function Camera({ door, seed, to, back }: StepProps): ReactNode {
  const { t, say } = useDoorWords();
  const square = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState<"on" | "off">(seed.phase === "cameraOff" ? "off" : "on");
  /* What the camera read that was no pairing: a frame that was no code, or a code that was refused. */
  const [heard, setHeard] = useState<string | null>(null);
  const live = useLive();
  const start = useCallback(() => {
    const el = square.current;
    if (!el) return;
    door.scan.start(rectOf(el)).then(
      (a) => live.current && setCamera(cameraOf(a)),
      () => live.current && setCamera("off"),
    );
  }, [door, live]);
  useEffect(() => {
    const el = square.current;
    start();
    const watch =
      el && typeof ResizeObserver === "function"
        ? new ResizeObserver(() => void door.scan.move(rectOf(el)).catch(() => {}))
        : null;
    if (el) watch?.observe(el);
    const stop = door.scan.listen((scan) => {
      const handed = scan.k === "notACode" ? null : handedOf(scan);
      if (handed === null) setHeard(t("scan.notACode"));
      else if (handed.k === "offers") to({ step: "confirm", offer: handed.offer });
      else {
        /* Native put the camera away for what it measured: it stands again for the next code. */
        setHeard(say(handed.said));
        start();
      }
    });
    return () => {
      watch?.disconnect();
      stop();
      door.scan.stop();
    };
  }, [door, start, to, t, say]);
  const allow = (): void => {
    door.scan.allow().then(
      (a) => {
        if (!live.current) return;
        setCamera(cameraOf(a));
        if (cameraOf(a) === "on") start();
      },
      () => {},
    );
  };
  return (
    <Page
      back={<Button kind="quiet" icon="back" label={t("back")} onPress={back} />}
      refusal={heard === null ? undefined : [heard]}
      line={[{ tag: t("scan.where") }]}
      acts={
        <>
          {camera === "off" ? (
            <Button size="l" keyHint="↵" onPress={allow}>
              {t("scan.allow")}
            </Button>
          ) : null}
          <Button size="l" kind="two" onPress={() => to({ step: "scan", phase: "byHand" })}>
            {t("scan.byHand")}
          </Button>
        </>
      }
    >
      {/* Where native's camera stands: the square's own box, which the page measures and tells native. */}
      <CameraSquare
        state={camera === "off" ? "off" : "live"}
        label={camera === "off" ? t("scan.cameraOff") : t("scan.camera")}
        boxRef={square}
      />
    </Page>
  );
}

function ByLink({ door, seed, to, back }: StepProps): ReactNode {
  const { t, say } = useDoorWords();
  const [refused, setRefused] = useState<SaidRefusal | null | undefined>(seed.said);
  const [busy, setBusy] = useState(false);
  const link = useRef<HTMLInputElement>(null);
  const live = useLive();
  const press = (): void => {
    if (busy) return;
    setBusy(true);
    /* No address: the link names its own, and native reads it. */
    void sendCode(door, null, link).then((handed) => {
      if (!live.current) {
        if (handed.k === "offers") door.dismiss(handed.offer.ticket);
        return;
      }
      setBusy(false);
      if (handed.k === "offers") to({ step: "confirm", offer: handed.offer });
      else setRefused(handed.said);
    });
  };
  return (
    <DoorForm onSubmit={press}>
      <Page
        smaller
        back={<Button kind="quiet" icon="back" label={t("back")} onPress={back} />}
        refusal={refused === undefined ? undefined : [say(refused)]}
        acts={
          <Button type="submit" size="l" keyHint="↵" disabled={busy}>
            {t("scan.pair")}
          </Button>
        }
      >
        <SaidWith
          parts={t.rich("scan.linkIs", {
            blank: () => (
              <SentenceBlank
                ref={link}
                type="password"
                label={t("scan.linkLabel")}
                placeholder={t("scan.linkBlank")}
                size={t("scan.linkBlank").length}
                refused={refused !== undefined}
              />
            ),
          })}
        />
      </Page>
    </DoorForm>
  );
}
