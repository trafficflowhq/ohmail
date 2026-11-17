### The mails ohmail sends have a new look, light and dark

Every mail ohmail sends you, from the address confirmation to the storage notices, is drawn in the new design:
the name at the top, one sheet, at most one button, and a dark version for mail apps set to dark. The words
are shorter and plainer, and German mails say Konto. Nothing in them is fetched from the internet, as before.

On your own server, the page an address other than your origin gets (the 421) and the Umbrel launcher's two
pages are drawn the same way, as plain pages that fetch nothing. The proxy now refuses to start, with one
sentence, when `OHMAIL_ORIGIN` holds anything other than an `http://` or `https://` origin.

The first-run setup block your server prints to its log reads more plainly; it keeps its shape, so the
guides' `grep` and any script that reads the token still find it.
