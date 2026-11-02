### Desktop downloads always find a folder, Windows updates go in at the next start

On the desktop app, saving an attachment on a computer whose profile names no Downloads folder (a minimal
Linux install without xdg-user-dirs, for example) now saves into `Downloads` in your home folder, creating
it if needed, instead of refusing. The folder is looked up at each save, so a Downloads folder you set while
ohmail is open is used at once. A Downloads folder your profile names still comes first; the Flatpak keeps
refusing, since its home folder is not yours.

A desktop app signed in to your own server now lets one message carry up to 32 MiB of attachments, the
limit your server takes, instead of 3 MB. Such a send now has five minutes to upload, as a single file
does on the hosted service, and a send that runs out of time no longer pauses your other changes.

On Windows, an update downloaded while ohmail stays open, and not installed because Windows shut down with
ohmail running, now installs the next time you start ohmail, before its window opens. A start from a
`mailto:` or `ohmail://` link waits for the next plain start or quit. An installer that does not finish is
not tried again by itself.

Signing out on the desktop app now empties the saved sign-in and flushes its removal to disk before it says
you are signed out, so a power cut right after cannot bring the session back.
