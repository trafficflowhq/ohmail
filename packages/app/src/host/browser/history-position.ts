/** The runtime's index, or a relative index shared only by entries this app can identify. */
export interface EntryPosition {
  readonly sequence: string;
  readonly index: number;
}

export function historyPosition(window: Window) {
  const history = window.history;
  const sequence = "frame:" + Math.random().toString(36).slice(2);
  const remembered = new WeakMap<object, EntryPosition>();
  let last: EntryPosition = { sequence, index: 0 };
  let size = history.length;

  function known(): EntryPosition | null {
    const navigation = (window as Window & { navigation?: { currentEntry?: { index: number } } }).navigation;
    const index = navigation?.currentEntry?.index;
    if (index !== undefined && Number.isSafeInteger(index) && index >= 0)
      return { sequence: "browser", index };
    const state = history.state;
    if (state == null || typeof state !== "object") return null;
    const entry = state.ohmailPosition;
    if (
      entry &&
      typeof entry.sequence === "string" &&
      entry.sequence.startsWith("frame:") &&
      Number.isSafeInteger(entry.index)
    )
      return { sequence: entry.sequence, index: entry.index };
    return remembered.get(state) ?? null;
  }

  function remember(position: EntryPosition): EntryPosition {
    last = position;
    size = history.length;
    if (position.sequence !== "browser" && Number.isFinite(size)) {
      if (history.state == null) history.replaceState({ ohmailPosition: position }, "", window.location.href);
      else if (typeof history.state === "object") remembered.set(history.state, position);
    }
    return position;
  }
  return {
    current: () => remember(known() ?? last),
    pushed: (from: EntryPosition) => remember(known() ?? { ...from, index: from.index + 1 }),
    returned: remember,
    arrived(): EntryPosition | null {
      const position = known() ?? (history.length > size ? { ...last, index: last.index + 1 } : null);
      return position && remember(position);
    },
  };
}
