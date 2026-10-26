### The desktop log says why its window stopped

When "ohmail's window stopped and was reloaded." shows on Linux, the app's log line for it now also
carries how long the app had been running, how much memory the computer had left once the window's
process was gone, and how many of ohmail's own processes the system ended for lack of memory since the
window last stopped. Kills of other programs are not counted. That tells a crash in the window apart from
the system reclaiming ohmail's memory, which both looked the same before. On desktops that start each app
in its own systemd unit, a memory kill ends the whole app, so the message there means a crash. The numbers
stay in the log on your computer.
