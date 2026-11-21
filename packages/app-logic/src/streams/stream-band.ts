import type { StreamItemBox, StreamLook } from "./stream-read-types.js";

const bandFoot = (look: StreamLook): number => look.scrollTop + look.viewHeight * 0.38;
const headInBand = (item: StreamItemBox, look: StreamLook): boolean =>
  item.height > 0 && item.top >= look.scrollTop - 0.5 && item.top < bandFoot(look);
const footInBand = (item: StreamItemBox, look: StreamLook): boolean =>
  item.top + item.height <= bandFoot(look) + 2;

/** Only a measured band or a continuous hand scroll can supply evidence for a card. */
export function createStreamBand() {
  let heads = new Set<string>();
  const crossed = new Set<string>();
  const sample = (look: StreamLook): void => {
    heads = new Set(look.items.filter((item) => headInBand(item, look)).map((item) => item.id));
  };
  const clear = (): void => {
    heads.clear();
    crossed.clear();
  };
  return {
    sample,
    clear,
    scroll(look: StreamLook, carriesUpward: boolean): void {
      if (!carriesUpward) clear();
      else {
        for (const item of look.items) {
          if (heads.has(item.id) && item.height > 0 && footInBand(item, look)) crossed.add(item.id);
        }
      }
      sample(look);
    },
    read(look: StreamLook, readable: (item: StreamItemBox) => boolean): string[] {
      sample(look);
      const read = look.items.filter(
        (item) =>
          (crossed.has(item.id) || (headInBand(item, look) && footInBand(item, look))) && readable(item),
      );
      crossed.clear();
      return read.map((item) => item.id);
    },
  };
}
