### The desktop log says how the window's process ended

When "ohmail's window stopped and was reloaded." shows on Linux, the app's log now gets a second line
a moment later. It says how the window's process ended: the signal that stopped it, and whether that
was a crash or a kill, or the exit code it left with. ohmail reads this from the system without
disturbing the process. What the window's libraries print to the error output just before they stop
was thrown away when ohmail was started from a launcher. It is now kept in `stderr.log` beside the
app's log, at most 256 KiB plus one older file, with a marker at each start and at each window process
that ended. The diagnostic file gets the new numbers and none of that text. Nothing leaves your
computer. Set `OHMAIL_STDERR_LOG=0` to keep the old behaviour; a terminal's output is never moved.
