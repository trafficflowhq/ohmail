### Phone: a message sent without network still goes after you close the composer

On the phone, a message sent without network said it would go once the network was back, but closing the
composer (Back, a tap outside it, or Cancel) quietly cancelled it, and it never went. Closing the composer
now leaves the send waiting: it goes once when the network returns, also after the app was closed and
opened again, and the composer repeats that as it closes. A new reply or forward of the same message with
other words, other files or a later time is sent as a message of its own and does not replace the waiting
one. While a send waits, the composer offers Cancel send instead of Cancel, and that is the only way to
cancel it. It says the send was cancelled only when it was, and where the words were kept, that the
message is in Drafts. When Cancel send cannot reach the server, closing the composer keeps the words in
Drafts.

On a phone that runs its own mail engine, Discard in Drafts failed with "request body must be
application/json" and the draft stayed. The same error hit deleting a message, a rule, a tag or a folder,
cancelling a scheduled send, and downloading all of a message's attachments. They all work now. A new mail
that waited for the network now says "Sent." when it goes, not "Reply sent.".
