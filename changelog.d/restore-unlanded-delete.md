### Restoring a letter before its delete reached the server brings it back

Deleting a letter and pressing Restore in Trash before the mail server had moved it (an offline
or slow organizer) could leave it in no view at all, while the server still held it in its folder,
and a second Restore was refused. Restore now cancels a delete that has not reached the server:
the letter is back in its folder at once and nothing is sent. A delete that already reached the
server restores as before. On the web app, Cloud and the desktop app.
