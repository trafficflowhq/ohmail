### Shorter pauses while the desktop app stores a first sync

While the desktop app stores its very first sync, its local database no longer fills each new
log file with zeroes. That was disk work on the same thread that answers the window, so
opening a message waited behind it. Nothing is written to disk less safely than before. The app's
diagnostics now also record how long the engine was held during a sync and how much of that was
the local database syncing to disk (desktop).
