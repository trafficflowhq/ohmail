/**
 * WHAT THE PHONE'S PAGE HANDS THE FRAME: the places it mounts, the address, the window and the look. The page is a
 * browser's page, so the address is its fragment and the window its own; each change of the fragment is also told to
 * native, which keeps it to bring a page whose process ended back to the same place. The places come from the app the
 * page is built for (`mounted.<app>.ts`, chosen by the page's build): no place is mounted on the phone yet, and until
 * a place task mounts one in its app's file the frame stands with nothing in it.
 */
import { PLACE_IDS, STAGE_IDS, type FramePlaces, type FrameStages } from "@ohmail/app/frame/contract";
import { NONE, type Appearance, type FrameSupplies, type HostAddress, type Signal } from "@ohmail/app/host";
import { browserWindowFacts, fragmentAddress } from "@ohmail/app/host/browser";

/** What an app mounts: its places and stages. One file per app answers it (`./mounted`, the page's build picks it). */
export interface Mounted {
  readonly places: FramePlaces;
  readonly stages: FrameStages;
}

/** Every place and stage none: the frame with its dock and nothing in it. */
export function nothingMounted(): Mounted {
  return {
    places: Object.fromEntries(PLACE_IDS.map((id) => [id, NONE])) as unknown as FramePlaces,
    stages: Object.fromEntries(STAGE_IDS.map((id) => [id, NONE])) as unknown as FrameStages,
  };
}

/** The address the frame reads and writes; every change of it, the frame's or back's, is told to `kept` for the page's life. */
export function keptAddress(inner: HostAddress, kept: (fragment: string) => void): HostAddress {
  let told = inner.read();
  inner.subscribe(() => {
    const now = inner.read();
    if (now === told) return;
    told = now;
    kept(now);
  });
  return inner;
}

const DARK = "(prefers-color-scheme: dark)";

/** The look the system asks for: the phone's face is paper, its scheme the system's. One object while nothing moved. */
export function systemAppearance(win: Window = window): Signal<Appearance> {
  const query = win.matchMedia?.(DARK) ?? null;
  let held: Appearance = { face: "paper", scheme: query?.matches ? "dark" : "light" };
  return {
    read() {
      const scheme = query?.matches ? "dark" : "light";
      if (scheme !== held.scheme) held = { face: "paper", scheme };
      return held;
    },
    subscribe(changed) {
      query?.addEventListener("change", changed);
      return () => query?.removeEventListener("change", changed);
    },
  };
}

/**
 * The page's supplies. `place` is where native says the last page stood; the address is put back there before the
 * frame first reads it. Signing in again is native's (the connection layer leaves the shell on a refusal), so the
 * frame is offered no control of its own: `recover` is `none`.
 */
export function phoneFrameSupplies(
  mounted: Mounted, place: string | null, kept: (fragment: string) => void, win: Window = window,
): FrameSupplies {
  const address = fragmentAddress(win);
  if (place !== null && place !== "" && address.read() !== place) address.write(place, "replace");
  return {
    places: mounted.places,
    stages: mounted.stages,
    /* No old shell stands on the phone: nothing above the panes. */
    above: NONE,
    // A phone shell holds no keyboard registry, so it hands no over.
    overs: { palette: NONE, keys: NONE },
    address: keptAddress(address, kept),
    window: browserWindowFacts(win),
    appearance: systemAppearance(win),
    // No calendar is seated yet: its entry is handed in by the seating step.
    calendar: NONE,
    recover: NONE,
  };
}
