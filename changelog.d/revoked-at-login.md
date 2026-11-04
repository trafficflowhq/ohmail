### The sign-in page removes the mail of a browser signed out from another device

On the web app, on ohmail Cloud and on your own server, a browser whose sign-in was ended from another device
kept its copy of the mail when it was opened straight on the sign-in page (a bookmark, a typed address), until
it next reached the mailbox. The sign-in page now removes that copy as soon as it learns the sign-in was ended,
with any changes that had not yet reached the server, as Sign out does, and a sign-in started meanwhile waits
for it. A sign-in that expired still keeps the copy, and a sign-in made meanwhile, in that tab or another,
keeps its own.
