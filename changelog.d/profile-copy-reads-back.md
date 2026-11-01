### The settings copy in the mailbox reads back when a stored value or the server's encoding changed it

ohmail keeps a copy of your settings in each mailbox, so a reconnect or another device finds them. For some
accounts every new copy was removed right after it was written, because a stored value read back otherwise: a
filing rule saved before 0.25.4 with a priority outside 0 to 1000, a contact address with a space around it,
or an empty tag name or notification. ohmail now writes such values as every device reads them, without
changing what is stored, and reads a copy the mail server stored as quoted-printable or base64. A copy the
server changes in any other way is sent again only when your settings change, or once a day. This applies to
ohmail Cloud, your own server, the desktop and the phone. When a mailbox the desktop app or the phone
organizes still cannot keep its copy, its row there says that the settings cannot be saved or read.
