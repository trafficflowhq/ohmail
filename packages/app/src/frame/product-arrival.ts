import { motionEase, motionMs, motionReduced, motionShape } from "@ohmail/ui/base";
import { useLayoutEffect, useRef, type RefObject } from "react";
import type { LayoutPlan, Product } from "./contract.js";

function playKnob(rail: HTMLElement): Animation | undefined {
  if (motionReduced(rail)) return;
  const knob = rail.querySelector<HTMLElement>(".oh-switcher-knob");
  const previous = rail.querySelector<HTMLElement>(".oh-switcher-half:not([aria-current])");
  if (!knob || !previous || !knob.offsetWidth) return;

  // The incoming rail has a new switcher. Its inactive half is where the ink stood before the switch.
  const distance = previous.offsetLeft - knob.offsetLeft;
  const scale = previous.offsetWidth / knob.offsetWidth;
  const easing = motionEase(knob, "--e-knob");
  const frames: Keyframe[] = [
    { transform: `translateX(${distance}px) scaleX(${scale})`, easing },
    { transform: "none" },
  ];
  if (scale === 1) {
    const stretch = getComputedStyle(knob).getPropertyValue("--x-swi-s").trim() || "1";
    frames.splice(1, 0, {
      transform: `translateX(${distance / 2}px) scaleX(${stretch})`,
      offset: 0.5,
      easing,
    });
  }
  return knob.animate(frames, { duration: motionMs(knob, "--d-knob") });
}

function settleOnActivation(shell: HTMLElement, animations: Animation[]): () => void {
  const listeners = new AbortController();
  const settle = () => {
    listeners.abort();
    for (const animation of animations) animation.cancel();
  };
  const options = { capture: true, signal: listeners.signal };
  const doc = shell.ownerDocument;
  // Release the translated containing block before a control measures a fixed overlay's anchor.
  doc.addEventListener("pointerdown", settle, options);
  doc.addEventListener("contextmenu", settle, options);
  doc.addEventListener("click", settle, options);
  doc.addEventListener("keydown", settle, options);
  void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => listeners.abort());
  return settle;
}

function playArrival(shell: HTMLElement, device: LayoutPlan["device"], switching: boolean): () => void {
  const easing = motionEase(shell, "--e-arrive");
  const arrive = (el: Element, transform: string, duration: number, delay = 0) =>
    el.animate(
      transform === "none"
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { transform, opacity: 0 },
            { transform: "none", opacity: 1 },
          ],
      { duration, easing, delay, fill: "backwards" },
    );

  if (device !== "desktop") {
    const animation = arrive(shell, motionShape(shell, "--x-app-open"), motionMs(shell, "--d-slide"));
    return settleOnActivation(shell, [animation]);
  }

  const rail = shell.querySelector<HTMLElement>(".oh-rail");
  const knob = switching && rail ? playKnob(rail) : undefined;
  const transform = motionShape(shell, "--x-in");
  const duration = motionMs(shell, "--d-in");
  const stagger = motionMs(shell, "--d-product-stagger");
  const animations: Animation[] = knob ? [knob] : [];
  for (const group of rail?.querySelectorAll(".oh-rail-group:not(:empty), :scope > .oh-rail-scroll ~ *") ??
    []) {
    animations.push(arrive(group, transform, duration));
  }
  const columns = shell.querySelectorAll(".fr-main > :is(.fr-list, .fr-reading, .fr-wide)");
  columns.forEach((column, index) => {
    // On the first Mail paint the opening frame has already drawn the sheet and the empty
    // reader. Leave those surfaces in place and bring in the contents. A switch still moves
    // the incoming columns as a whole.
    const passive = !switching && column.matches(".fr-list, .fr-reading");
    const parts = passive ? (column.firstElementChild?.children ?? []) : [column];
    for (const part of parts) {
      // The saved mail list is already on screen. Its live replacement keeps the same position.
      if (!switching && part.hasAttribute("data-restored-viewport")) continue;
      animations.push(arrive(part, transform, duration, stagger * (index + 1)));
    }
  });
  return settleOnActivation(shell, animations);
}

/** The first desktop Mail open moves its contents. Later product switches move the columns. */
export function useProductArrival(
  frame: RefObject<HTMLDivElement | null>,
  device: LayoutPlan["device"],
  product: Product,
  staged: boolean,
): void {
  const previous = useRef<Product | null>(null);
  useLayoutEffect(() => {
    if (staged || previous.current === product) return;
    const shell = frame.current;
    if (!shell || typeof shell.animate !== "function") return;

    if (previous.current === null && product === "mail" && device === "desktop") {
      const view = shell.ownerDocument.defaultView;
      if (!view) return;
      // The root stamps its appearance and reduced-motion attributes after its children commit.
      let stop: (() => void) | undefined;
      const start = view.requestAnimationFrame(() => {
        previous.current = product;
        if (!motionReduced(shell)) stop = playArrival(shell, device, false);
      });
      return () => {
        view.cancelAnimationFrame(start);
        stop?.();
      };
    }

    const switching = previous.current !== null;
    previous.current = product;
    if (switching) return playArrival(shell, device, true);
  }, [device, frame, product, staged]);
}
