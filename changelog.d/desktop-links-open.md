### Links on Linux open through the desktop portal, and a link that does not open says why

On Linux, the desktop app now hands a link to the desktop portal first, the route Wayland desktops such
as Hyprland and sandboxed installs honour, then to `xdg-open`, then to `gio open`, and says that a link
was not opened only when every one of them refused. The app's log names what each route answered, never
the address. macOS and Windows open links as before.

The sentence that says a link was not opened now says whose refusal it was: "ohmail could not open this
link" when the app itself held it back (an address it does not open, or a press it did not count as
yours), and that this computer would not open a browser only when the computer's own opener refused. Both
have a Copy address button, which copies the whole address so it can be pasted into a browser by hand.

On the desktop, a link in a letter set in ohmail's own type whose text names a different site from the one
it opens now asks before it opens, as it already did in a designed letter; before, it opened with only the
real site's name beside it. Links whose query or fragment carries a backslash or a backtick now open, and
so do the links of a view that puts a very large number of messages on screen at once.
