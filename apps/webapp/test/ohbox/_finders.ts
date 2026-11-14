/**
 * FINDERS FOR THE OHBOX'S LIST AS IT IS DRAWN: a row by its letter, the rows of a group, the open row, the
 * selection's count and the head's unread count. They read the page only and import nothing of the shell, so a test
 * that stands its own clock before it loads the shell can take them at its top.
 */
/** A row of the Ohbox's list by its letter, wherever it stands. */
export const ohboxRow = (root: ParentNode, id: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[role="option"][data-id="${id}"]`);

/** Every row of the Ohbox's list, top to bottom. */
export const ohboxRows = (root: ParentNode): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[role="option"][data-id]')];

/** The ids of the rows a group's listbox holds ("New", "Earlier", "Resurfaced"). */
export const groupIds = (root: ParentNode, name: string): string[] => {
  const box = root.querySelector(`[role="listbox"][aria-label="${name}"]`);
  return box ? [...box.querySelectorAll<HTMLElement>('[role="option"][data-id]')].map((r) => r.dataset.id!) : [];
};

/** The row the cursor is on (the open row), or null. */
export const openRow = (root: ParentNode): HTMLElement | null => root.querySelector<HTMLElement>('[role="option"][data-open]');

/** The selection's count, as its clearing control says it ("3 selected — clear the selection"); null with no pick. */
export const pickedCount = (root: ParentNode): string | null => {
  const said = [...root.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? "").find((l) => / selected — /.test(l));
  return said ? (/^(\d+) selected/.exec(said)?.[1] ?? null) : null;
};

/** The unread count the list's head states (Mark all read names it); null where the head states none. */
export const headCount = (root: ParentNode): string | null => {
  const said = [...root.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? "")
    .find((l) => /^Mark (all \d+ unread messages|the 1 unread message) read$/.test(l));
  if (!said) return null;
  return /^Mark the 1 /.test(said) ? "1" : (/all (\d+) unread/.exec(said)?.[1] ?? null);
};
