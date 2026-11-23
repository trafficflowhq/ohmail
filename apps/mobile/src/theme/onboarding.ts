import { design } from "@ohmail/tokens/design";
import type { Theme } from "./index";

export const points = (value: string) => Number.parseFloat(value);

export function onboardingLook({ face, scheme }: Pick<Theme, "face" | "scheme">) {
  return { palette: design.faces[face][scheme], type: design.faces[face].touch };
}
