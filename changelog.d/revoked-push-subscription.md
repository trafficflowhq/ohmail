### A browser signed out from elsewhere no longer gets new-mail notifications

On Cloud and your own server, a browser signed out from another place (Devices, "Sign out all other web
sessions", "Sign out everywhere", a password change, removing an authenticator, or another sign-in in the
same browser) kept receiving new-mail notifications, even if it was never opened again. A browser's
notification registration now belongs to the sign-in that made it and ends with it; the other signed-in
browsers and phones keep theirs. Browsers that had notifications on before this release get none while
closed until their next visit to ohmail, which turns them back on by itself.
