### The desktop app's log says when its last run ended without closing

When ohmail on the desktop vanished without closing, for example after a crash in the system's
window toolkit, its log said nothing about it. The next start now writes one line saying the previous
run ended uncleanly, how long ago that run started and which process it was, so a crash report can be
matched to it. A normal quit, an update's restart, and logging out or shutting down leave no such
line: on Linux, ohmail now quits the same way as from its menu when the session ends. The line
carries no file paths and no account data.
