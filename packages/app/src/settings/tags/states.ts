/** Tags' registered states, as models (`screen=settings&sec=tags`, `&state=rename`, `&state=taken`). */
import { TAG_COLOURS } from "../../tags/colours.js";
import type { TagsModel } from "./model.js";

const still = () => undefined;

export function tagsState(): TagsModel {
  return {
    tags: [
      { id: "t1", name: "Pottery Project", colour: "moss", hue: 150, count: 4 },
      { id: "t2", name: "Paperwork", colour: "ochre", hue: 78, count: 12 },
      { id: "t3", name: "Travel", colour: "denim", hue: 214, count: 3 },
    ],
    colours: TAG_COLOURS,
    newHue: 150,
    notOnServer: "",
    verbs: { create: still, rename: still, recolour: still, remove: still },
  };
}

/**
 * The registry's Tags states. `rename` and `taken` are the pane's own moments (a field open, a name refused), which a
 * person reaches by pressing: the states page opens them through the pane's states-only `at` (`TAGS_PRESSES`).
 */
export const TAGS_STATES: Readonly<Record<string, () => TagsModel>> = {
  "": tagsState,
  rename: tagsState,
  taken: tagsState,
};
export const TAGS_PRESSES: Readonly<Record<string, { readonly rename?: string; readonly typeNew?: string }>> =
  {
    rename: { rename: "t1" },
    taken: { typeNew: "paperwork" },
  };
