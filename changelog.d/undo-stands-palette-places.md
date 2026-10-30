### An Undo that waits to be sent says Undone, and the command palette reaches every place

On web and desktop, an Undo whose writes could not reach the server yet (a server that is down or
restarting) said "Nothing changed — that did not go through. Try it again." a few seconds later,
although the Undo stood and was sent once the server answered again. It now says "Undone.", as an
Undo the server took at once does.

The command palette (Ctrl+K, ⌘K on a Mac) now has a Go to row for Answer Later, Parked, Resurface,
Drafts and History, as it had for the Ohbox, News, Receipts and Trash, and Settings shows its `g ,`
key there too. Every word you type is matched on its own, so "go to ohbox" finds "Go to the Ohbox"
and "zu historie" finds "Zur Historie". The Screener's row reads "Go to the Screener" and the
Settings row "Go to Settings", as in the shortcut list.
