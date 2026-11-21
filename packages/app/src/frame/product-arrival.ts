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

/** A committed product change plays on the mounted shell, including switches made with keys or browser history. */
export function useProductArrival(
  frame: RefObject<HTMLDivElement | null>,
  device: LayoutPlan["device"],
  product: Product,
): void {
  const previous = useRef(product);
  useLayoutEffect(() => {
    if (previous.current === product) return;
    previous.current = product;
    const shell = frame.current;
    if (!shell || typeof shell.animate !== "function") return;

    const easing = motionEase(shell, "--e-arrive");
    const arrive = (el: Element, transform: string, duration: number, delay = 0) =>
      el.animate(
        [
          { transform, opacity: 0 },
          { transform: "none", opacity: 1 },
        ],
        {
          duration,
          easing,
          delay,
          fill: "backwards",
        },
      );

    if (device !== "desktop") {
      const animation = arrive(shell, motionShape(shell, "--x-app-open"), motionMs(shell, "--d-slide"));
      return () => animation.cancel();
    }

    const transform = motionShape(shell, "--x-in");
    const duration = motionMs(shell, "--d-in");
    const stagger = motionMs(shell, "--d-product-stagger");
    const animations: Animation[] = [];
    const rail = shell.querySelector<HTMLElement>(".oh-rail");
    if (rail) {
      const knob = playKnob(rail);
      if (knob) animations.push(knob);
      for (const group of rail.querySelectorAll(".oh-rail-group:not(:empty), :scope > .oh-rail-scroll ~ *")) {
        animations.push(arrive(group, transform, duration));
      }
    }
    const columns = shell.querySelectorAll(".fr-main > :is(.fr-list, .fr-reading, .fr-wide)");
    columns.forEach((column, index) => {
      animations.push(arrive(column, transform, duration, stagger * (index + 1)));
    });
    return () => animations.forEach((animation) => animation.cancel());
  }, [device, frame, product]);
}
