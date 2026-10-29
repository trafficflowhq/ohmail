### A browser that crashes right after renewing your sign-in stays signed in

The web app renews your sign-in in the background while you use it. If the browser crashed, was
force-quit or lost power shortly after a renewal, before it had saved the renewed sign-in to disk, it came
back with the one it had already used, and the server ended the session in that browser as if its sign-in
had been copied. The browser now writes down which renewal it sent before the request leaves, and keeps
that note until the next renewal, so after a restart the server sees the same browser finishing its own
renewal and the sign-in continues. An older copy of a sign-in is still refused, as before. On ohmail Cloud
and on your own server.
