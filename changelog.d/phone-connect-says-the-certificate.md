### The phone's Connect says when it cannot trust your mail server's certificate

On the phone, Connect now opens a mailbox only after it has signed in to your incoming server. If the
phone refuses the server's certificate, Connect says so in the desktop's words (not issued by a trusted
authority, expired, not valid yet, or for another host) and sends no password; if it cannot reach the
server, it says that. Either way nothing is saved. Before, Connect went on to an Ohbox that only said
"Connection lost. Reconnecting…". A mailbox that is already connected now names a refused certificate in
the Ohbox and in Settings instead of reconnecting for ever.
