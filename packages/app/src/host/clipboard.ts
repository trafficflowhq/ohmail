/** Copy exactly the text handed over and report whether the window accepted the write. */
export async function copyText(win: Window, text: string): Promise<boolean> {
  const clipboard = win.navigator.clipboard as Clipboard | undefined;
  if (clipboard === undefined) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
