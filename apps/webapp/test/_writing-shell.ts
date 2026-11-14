/** The writing controls reached through the mail shell, by the roles and names the frame exposes. */
import { act, messageRow, press, replyText, waitFor, type DraftShell } from "./_draft-shell.js";
import { settleEditor } from "./_first-paint.js";
import { reportSays } from "./ohbox/_finders.js";

export {
  actionIn, fillForward, forwardText, messageRow, openRegion, replyText, stubAnimate,
} from "./_draft-shell.js";
export { reportSays };

/** Keep reports that expire while a case waits for the server. */
export function listen(): { sayings: () => string[]; stop: () => void } {
  const heard: string[] = [];
  let last = "";
  const read = (): void => {
    const now = reportSays();
    if (now !== last && now !== "") heard.push(now);
    last = now;
  };
  const observer = new MutationObserver(read);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  return {
    sayings: () => { read(); return [...heard]; },
    stop: () => observer.disconnect(),
  };
}

/** Write's new letter and its parts. */
const LETTER = '[role="region"][aria-label="New message"]';
export const letter = (root: ParentNode = document): HTMLElement | null => root.querySelector<HTMLElement>(LETTER);
export const letterTo = (root: ParentNode = document): HTMLInputElement | null =>
  letter(root)?.querySelector<HTMLInputElement>('[role="combobox"][aria-label="To"]') ?? null;
export const letterSubject = (root: ParentNode = document): HTMLInputElement | HTMLTextAreaElement | null =>
  root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`${LETTER} input[aria-label="Subject"], ${LETTER} textarea[aria-label="Subject"]`);
export const letterText = (root: ParentNode = document): HTMLElement | null =>
  root.querySelector<HTMLElement>(`${LETTER} [role="textbox"][aria-label="Message"]`);
export const letterButton = (root: ParentNode, name: string): HTMLButtonElement | null =>
  [...root.querySelectorAll<HTMLButtonElement>(`${LETTER} button`)]
    .find((b) => b.getAttribute("aria-label") === name || (b.textContent ?? "").trim() === name) ?? null;
/** A key, where the keys are: the field or row that has the focus (the reply's text while it is written). */
export async function key(k: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    (document.activeElement ?? document).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await settleEditor();
}

/** Press the row of `id` at the Ohbox, then `r`: the reply's text under the letter. */
export async function openReplyOn(s: DraftShell, id = "m1"): Promise<void> {
  await waitFor(() => messageRow(s.el, id) != null, "the row");
  await press(messageRow(s.el, id), "the row");
  await key("r");
  await waitFor(() => replyText(s.el) != null, "the reply editor");
}
