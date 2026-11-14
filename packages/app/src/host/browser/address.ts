/** The browser's fragment is the frame address on web, desktop, paired and phone. */
import type { HostAddress } from "../device.js";
import { historyPosition, type EntryPosition } from "./history-position.js";
import { leaveHold } from "../leave-hold.js";

/** Write the address and preserve the browser entry's position and frame state. */
function writeFragment(
  window: Window,
  position: ReturnType<typeof historyPosition>,
  next: string,
  how: "push" | "replace",
  mark?: "closed" | "open-dialog" | "dismiss-dialog",
): EntryPosition {
  if (how === "push") {
    const previous = position.current();
    window.location.hash = next;
    const current = position.pushed(previous);
    if (mark === "closed" || mark === "open-dialog") {
      const flag = mark === "closed" ? { ohmailReaderClosed: true } : { ohmailOpenedDialog: true };
      window.history.replaceState({ ...window.history.state, ...flag }, "");
      position.returned(current);
    }
    return current;
  }
  const current = position.current();
  const state = window.history.state;
  if (mark === "closed" || state?.ohmailReaderClosed || state?.ohmailOpenedDialog) {
    const { ohmailReaderClosed: _reader, ohmailOpenedDialog: _dialog, ...rest } = state ?? {};
    if (mark === "closed") rest.ohmailReaderClosed = true;
    window.history.replaceState(rest, "", next);
  } else window.history.replaceState(state, "", next);
  position.returned(current);
  return current;
}

function subscribeToFragment(window: Window, read: () => string, changed: () => void) {
  let last = read();
  const notify = () => {
    const selected = read();
    if (selected === last) return;
    last = selected;
    changed();
  };
  window.addEventListener("hashchange", notify);
  window.addEventListener("popstate", notify);
  return () => {
    window.removeEventListener("hashchange", notify);
    window.removeEventListener("popstate", notify);
  };
}

export function fragmentAddress(window: Window): HostAddress {
  const position = historyPosition(window);
  let standing = window.location.hash;
  let origin: EntryPosition | null = null;
  let parked: string | null = null;
  const href = () => window.location.href ?? window.location.hash;
  let returning: { delta: number; approved: boolean } | null = null;
  let holding = false;
  const dismissDialog = dialogBack(window);
  const hold = leaveHold((held) => {
    holding = held;
    if (held) {
      standing = window.location.hash;
      origin = position.current();
      window.addEventListener("beforeunload", beforeUnload);
      window.addEventListener("hashchange", external, true);
      window.addEventListener("popstate", external, true);
    } else {
      window.removeEventListener("beforeunload", beforeUnload);
      if (!returning) stopWatching();
      if (parked !== null) {
        parked = null;
        queueMicrotask(() => window.dispatchEvent(new Event("hashchange")));
      }
    }
  });

  const { heldBefore } = hold;

  function beforeUnload(event: BeforeUnloadEvent) {
    event.preventDefault();
    event.returnValue = "";
  }

  function stopWatching() {
    window.removeEventListener("popstate", external, true);
    window.removeEventListener("hashchange", external, true);
  }

  function external() {
    const next = window.location.hash;
    if (returning && next === standing) {
      const visit = returning;
      returning = null;
      if (origin) position.returned(origin);
      if (!holding) stopWatching();
      if (visit.approved) window.history.go(visit.delta);
      return;
    }
    if (returning || !holding || parked === href()) return;
    if (next === standing) {
      parked = null;
      return;
    }
    const index = position.arrived();
    if (!hold.leaving(next)) {
      standing = next;
      origin = index;
      return;
    }
    if (!index || !origin || index.sequence !== origin.sequence) {
      // This traversal predates our history and the browser gives no direction. Keep the editor alive at the
      // selected URL. Its terminal answer releases the real destination without rewriting either entry.
      parked = href();
      heldBefore(next, () => {});
      return;
    }
    const visit = { delta: index.index - origin.index, approved: false };
    // Go back to the edit without rewriting the entry the person visited. A confirmed leave replays the traversal.
    if (visit.delta !== 0) {
      returning = visit;
      window.history.go(-visit.delta);
      heldBefore(next, () => {
        if (returning === visit) visit.approved = true;
        else window.history.go(visit.delta);
      });
    } else {
      // A host replaced this same history entry; there is no traversal to replay.
      window.history.replaceState(
        window.history.state,
        "",
        standing || window.location.pathname + window.location.search,
      );
      heldBefore(next, () => write(next, "replace"));
    }
  }

  function write(next: string, how: "push" | "replace", mark?: "closed" | "open-dialog" | "dismiss-dialog") {
    if (heldBefore(next, () => write(next, how, mark))) return;
    if (mark === "dismiss-dialog" && dismissDialog()) return;
    if (window.location.hash === next) return;
    if (holding) standing = next;
    const current = writeFragment(window, position, next, how, mark);
    if (holding && how === "push") origin = current;
    // A frame press has already written the selected fragment. Draw it in the same turn.
    window.dispatchEvent(new Event("hashchange"));
  }

  // A render between an external traversal and its events must still see the held pane.
  function read() {
    return returning || parked !== null || (holding && hold.leaving(window.location.hash))
      ? standing
      : window.location.hash;
  }

  return {
    read,
    write,
    readerClosed: () => window.history.state?.ohmailReaderClosed === true,
    holdLeave: hold.holdLeave,
    heldBefore,
    subscribe: (changed) => subscribeToFragment(window, read, changed),
  };
}

/** A fragment pushed to open a dialog should be unwound once, even across repeated presses. */
function dialogBack(window: Window): () => boolean {
  let pending = false;
  return () => {
    if (window.history.state?.ohmailOpenedDialog !== true || window.history.length <= 1) return false;
    if (!pending) {
      pending = true;
      window.addEventListener(
        "popstate",
        () => {
          pending = false;
        },
        { once: true },
      );
      window.history.back();
    }
    return true;
  };
}
