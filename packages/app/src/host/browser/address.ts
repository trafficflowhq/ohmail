/**
 * THE ADDRESS BAR'S FRAGMENT: what a browser shell hands the frame as `device.address`. `#/reads/m/42` is read as
 * `#/reads/m/42`; a write pushes or replaces one history entry, and the frame hears every change of the fragment,
 * its own included, through one subscription.
 */
import type { HostAddress } from "../device.js";

export function fragmentAddress(win: Window): HostAddress {
  return {
    read: () => win.location.hash,
    // As the shell's own writers do (`routing.ts`): a push is an assignment, which the browser announces; a replace
    // fires no `hashchange`, so it is announced by hand.
    write(next, how) {
      if (win.location.hash === next) return;
      if (how === "push") {
        win.location.hash = next;
        return;
      }
      win.history.replaceState(win.history.state, "", next);
      win.dispatchEvent(new Event("hashchange"));
    },
    // Back and Forward between fragments fire `hashchange` too, so one event is every change.
    subscribe(changed) {
      win.addEventListener("hashchange", changed);
      return () => win.removeEventListener("hashchange", changed);
    },
  };
}
