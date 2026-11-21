/**
 * A BROWSER SHELL's CLIPBOARD: what it hands the frame as `device.clipboard`. The text as it is handed (an address in
 * its stored form: a decoded domain pasted into another client resolves nowhere). `true` only once the clipboard took
 * it; a refused write (no permission, no focus, an insecure page, no clipboard at all) is `false`, never a throw.
 */
export function browserClipboard(win: Window): (text: string) => Promise<boolean> {
  return async (text) => {
    const clipboard = win.navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) return false;
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  };
}
