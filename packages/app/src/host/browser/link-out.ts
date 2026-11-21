/**
 * A BROWSER SHELL'S WAY TO AN ADDRESS THE APP ITSELF MAKES: what it hands the frame as `device.openLink`. A new tab,
 * with no way back to the page that opened it and no referrer sent. It is called inside the person's own press: a
 * browser opens a tab only then, and in the desktop's window the same call is the new-window request its shell opens
 * in the person's own browser, on a press alone.
 */
export function browserLinkOut(win: Window): (href: string) => void {
  return (href) => {
    win.open(href, "_blank", "noopener,noreferrer");
  };
}
