### A letter deleted on the server leaves no preview behind, and a delete whose answer was lost stays in Trash

On Cloud, your own server, the desktop app and the phone, a letter deleted on the mail server or in another
mail app kept its preview, the words search found it by, the line saying why it was filed and the addresses
of the trackers found in it until you removed the mailbox or deleted your account. Nothing showed them. From
this release, a letter that leaves takes them with its text; ohmail keeps its headers, the names of its files,
how it was filed and which trackers were found in it. Letters that left before this release keep their preview
and search words for now. A letter that comes back gets its preview and search words back.

A delete whose move reached the server's Trash while ohmail lost the answer (a crash, a dropped connection,
a slow server) emptied the letter and left it out of ohmail's Trash, where Restore could not reach it.
ohmail now finds the letter in Trash by its own bytes and keeps it there with its text, restorable; a letter
it cannot prove stays in Trash with its text. An Undo pressed in that moment brings the letter back instead
of losing it. A delete whose move read the letter as gone while the server still held it (a server throttling
ohmail's reads) no longer empties it: the move is tried again.
