### The desktop app asks about an update in its own window

When the desktop app has downloaded and verified an update, it now asks inside the ohmail window, with the
update strip and its Restart button, instead of opening a separate dialog. That dialog had no parent window on
Linux, so on a tiling desktop such as Omarchy (Hyprland) it opened on whatever workspace was in front rather than
where ohmail runs. "Later" still leaves the update ready, and the strip asks again at most once a day, or at once when
Check for Updates or Try again finds the update ready.
