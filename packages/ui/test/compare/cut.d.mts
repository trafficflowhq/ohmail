import type { Page } from "@playwright/test";
import type { Scene, Variant } from "../../../../test/compare/scene.d.mts";

export function readAlone(
  page: Page,
  variant: Variant,
  where: { root: string; selector: string | null },
): Promise<Scene>;
export function cutScene(
  scene: Scene,
  target: [number, number, number, number],
  place: "cell" | "block" | "window",
  mine?: (box: number[]) => boolean,
): Scene;
