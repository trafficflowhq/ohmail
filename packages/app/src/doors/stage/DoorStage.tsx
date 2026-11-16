"use client";

/**
 * THE DOORS' STAGE. A door stands before the app, in no frame: this is its `.oh-root`, and it stamps on the document's
 * element the attributes the new design's variants read (the same ones the frame stamps, from the same plan), takes
 * back what it wrote, and writes `data-face` only where none stands. Its markup never depends on the window: the
 * device is asked for in the browser only, after the first paint's markup is fixed.
 */
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Appearance, WindowFacts } from "../../host/device.js";
import type { Signal } from "../../host/signals.js";
import type { LayoutPlan } from "../../frame/contract.js";
import { layoutPlan } from "../../frame/layout-plan.js";
import { attributesOf, ROOT_ATTRIBUTES } from "../../frame/root-attributes.js";
/* The names both designs define, declared again under `.oh-root` with the new design's values: a door's page is an
   `.oh-root` on a document that loads today's tokens too, and stands in no frame that would bring this sheet. */
import "../../frame/seam.generated.css";
import "./placement.css";

/** The element whose attributes the design's variants read: the shell's document's own, in a browser. */
export interface DoorRoot {
  read(name: string): string | null;
  write(name: string, value: string | null): void;
}

/** What a door's page needs of the device: the window, the look the shell stands under, and the root it stamps. */
export interface DoorDevice {
  readonly window: Signal<WindowFacts>;
  readonly appearance: Signal<Appearance>;
  readonly root: DoorRoot;
}

const Plan = createContext<LayoutPlan | null>(null);

/** The plan the stage laid out: null on the server and on the first render in the browser. */
export function useDoorPlan(): LayoutPlan | null {
  return useContext(Plan);
}

const samePlan = (a: LayoutPlan | null, b: LayoutPlan): boolean =>
  a !== null &&
  a.device === b.device &&
  a.size === b.size &&
  a.pose === b.pose &&
  a.pointer === b.pointer &&
  a.short === b.short &&
  a.rail === b.rail &&
  a.columns === b.columns &&
  a.handles === b.handles;

export function DoorStage({
  device,
  children,
}: {
  device: () => DoorDevice;
  children: ReactNode;
}): ReactNode {
  const [plan, setPlan] = useState<LayoutPlan | null>(null);
  /* The shell's device is asked for once, in the browser: its window facts read `window`. */
  const asked = useRef(device);
  useLayoutEffect(() => {
    const made = asked.current();
    const { root } = made;
    const before = ROOT_ATTRIBUTES.map((name) => [name, root.read(name)] as const);
    const wroteFace = root.read("data-face") === null;
    const stamp = (): void => {
      const facts = made.window.read();
      const look = made.appearance.read();
      const next = layoutPlan(facts);
      const attributes = attributesOf(next, look, facts);
      for (const name of ROOT_ATTRIBUTES) root.write(name, attributes[name]);
      if (wroteFace) root.write("data-face", look.face);
      setPlan((was) => (samePlan(was, next) ? was : next));
    };
    stamp();
    const offWindow = made.window.subscribe(stamp);
    const offLook = made.appearance.subscribe(stamp);
    return () => {
      offWindow();
      offLook();
      for (const [name, value] of before) root.write(name, value);
      if (wroteFace) root.write("data-face", null);
    };
  }, []);
  return (
    <div className="oh-root way-stage">
      <Plan.Provider value={plan}>{children}</Plan.Provider>
    </div>
  );
}
