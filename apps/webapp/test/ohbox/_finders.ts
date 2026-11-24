/**
 * FINDERS FOR THE SEATED OHBOX AS IT IS DRAWN, one file for every test that walks it: the list (a row by its letter,
 * the rows of a group, the open row, the cursor row, the picked rows, the selection's count, the head's unread count)
 * and the reading column beside it (the open letter's region and its letters, the action panel's verbs by their names,
 * the items of the menu a verb opened, the read slot, the reply's editor, what the column says with nothing open, what
 * the frame's report says and offers). Each finds
 * its part by role and accessible name, or by the mark the read rule and the list themselves find it by (`data-id`,
 * `data-conv-id`). Two parts carry neither and are found by the box that holds them, here and nowhere else in a
 * test: the reading sheet's scrolling box (as the reader's own `read-dom.ts` finds it, until the kit hands it out)
 * and the frame's report slot. They read the page only and import nothing of the shell, so a test that stands its
 * own clock before it loads the shell can take them at its top. The names are the English catalogue's.
 */
/** The frame's two sections at a place of columns (`frame.landmark.list`, `frame.landmark.reading`). */
const LIST = 'section[aria-label="Messages"]';
const READING = 'section[aria-label="Reading"]';
/** The reading sheet with a letter in it (`reader.pane`), and its action panel (`reader.panel`). */
const OPEN_LETTER = '[role="region"][aria-label="Open message"]';
const PANEL = '[role="toolbar"][aria-label="Actions"]';

/** The seated list's column: the frame's list section, with the list's head, rows and foot. */
export const seatedList = (root: ParentNode): HTMLElement | null => root.querySelector<HTMLElement>(LIST);

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

/** The open row: the row of the letter the address names, or null. */
export const openRow = (root: ParentNode): HTMLElement | null => root.querySelector<HTMLElement>('[role="option"][data-open]');

/** The cursor row: the row the keys are on. Where the list marks none of its own, it is the open row. */
export const cursorRow = (root: ParentNode): HTMLElement | null =>
  root.querySelector<HTMLElement>('[role="option"][data-cursor]') ?? openRow(root);

/** The rows picked for a set, top to bottom. */
export const pickedRows = (root: ParentNode): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[role="option"][data-picked]')];

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

/** The reading column: the frame's reading section, with a letter in it or none; null where one column shows the list. */
export const readingColumn = (root: ParentNode): HTMLElement | null => root.querySelector<HTMLElement>(READING);

/** The open letter's region (the reading sheet named Open message), or null with nothing open. */
export const openLetter = (root: ParentNode): HTMLElement | null => root.querySelector<HTMLElement>(`${READING} ${OPEN_LETTER}`);

/** One letter the open conversation draws, by its id (the panel the read rule reads), or null. */
export const letterShown = (root: ParentNode, id: string): HTMLElement | null =>
  openLetter(root)?.querySelector<HTMLElement>(`[data-conv-id="${id}"]`) ?? null;

/** The ids of the letters the open conversation draws, oldest first. */
export const lettersShown = (root: ParentNode): string[] =>
  [...(openLetter(root)?.querySelectorAll<HTMLElement>("[data-conv-id]") ?? [])].map((el) => el.dataset.convId!);

/** The open letter's subject, as its head says it; "" with nothing open. */
export const openSubject = (root: ParentNode): string => openLetter(root)?.querySelector("h2")?.textContent?.trim() ?? "";

/** A verb on the open letter's action panel by its name ("Reply", "Forward", "Later", "Park", "Resurface", "Tag"). */
export const barVerb = (root: ParentNode, name: string): HTMLButtonElement | null =>
  /* The name is compared, not put into the selector: jsdom's selector engine matches no value that holds " + ". */
  [...root.querySelectorAll<HTMLButtonElement>(`${READING} ${PANEL} button[aria-label]`)].find(
    (b) => b.getAttribute("aria-label") === name,
  ) ?? null;

/**
 * The read slot on the panel: Mark read or Mark unread, whichever it offers now; null where it stands behind More.
 * Found by its place (the kit's verb `read`), not by its name: over a conversation of several unread letters its name
 * says how many it marks ("Mark 2 unread messages as read"), its word stays "Mark read".
 */
export const readSlot = (root: ParentNode): HTMLButtonElement | null =>
  root.querySelector<HTMLButtonElement>(`${READING} ${PANEL} button[data-id="read"]`);

/** What the read slot offers now: "Mark read", "Mark unread", or "" where no letter is open or it stands behind More. */
export const readSlotSays = (root: ParentNode): string => readSlot(root)?.getAttribute("aria-label") ?? "";

/** More's button on the panel. */
export const moreButton = (root: ParentNode): HTMLButtonElement | null => barVerb(root, "More");

/**
 * The items of the menu that is open now: More's, Resurface's, Tag's, Move's, a letter's own. A menu is drawn over
 * the page (a sheet at the foot under 700 wide), so its items are looked for in the whole document.
 */
export const menuItems = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')];

/** An item of the open menu by the name it starts with ("Move", "Delete", "Tomorrow", a tag's name), or null. */
export const menuItem = (name: string): HTMLElement | null =>
  menuItems().find((item) => (item.textContent ?? "").trim().startsWith(name)) ?? null;

/** The open letter's scrolling box: what the read rule observes and where `l` puts the keyboard. */
export const readingScroller = (root: ParentNode): HTMLElement | null =>
  openLetter(root)?.querySelector<HTMLElement>(".oh-sheet-scroll") ?? null;

/** The reply's or the forward's editor under the open letter (today's box in the reading sheet), or null. */
export const replyEditor = (root: ParentNode): HTMLElement | null =>
  root.querySelector<HTMLElement>(`${READING} [role="textbox"]:is([aria-label="Reply body"], [aria-label="Forward body"])`);

/** What the reading column says with nothing open (the list's count, "All read"); null where a letter is open or it says nothing. */
export const blankSays = (root: ParentNode): string | null => {
  const column = readingColumn(root);
  if (column === null || openLetter(root) !== null) return null;
  const said = (column.textContent ?? "").trim();
  return said === "" ? null : said;
};

/** What the frame's report says at the foot (a verb's answer at a seated place stands here, never in today's capsule). */
export const reportSays = (): string =>
  [...document.querySelectorAll('.fr-report [role="status"]')].map((el) => el.textContent ?? "").join(" ").trim();

/** The press the frame's report offers (Undo, or a refusal's own way on), or null where it offers none. */
export const reportPress = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>('.fr-report [role="status"] button');
