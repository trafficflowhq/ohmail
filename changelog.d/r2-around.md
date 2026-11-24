### The mails ohmail sends have a new look, light and dark

Every mail ohmail sends you, from the address confirmation to the storage notices, is drawn in the new design:
the name at the top, one sheet, at most one button, and a dark version for mail apps set to dark. The words
are shorter and plainer, and German mails say Konto. Nothing in them is fetched from the internet, as before.

On your own server, the page shown to anyone arriving from an address other than the server's own, and the Umbrel launcher's two
pages, are drawn the same way, as plain pages that fetch nothing. The server now refuses to start, with one
sentence, when `OHMAIL_ORIGIN` holds anything other than an address starting with `http://` or `https://`.

The first-run setup lines your server prints to its log read more plainly; they keep their shape, so the
guides' search commands and any script that reads the setup token still find them.
