### A preview build of the desktop app runs beside an installed ohmail

The Linux desktop app can be built as a preview of the next major version
(`npm run app:build:engine -- --distribution preview`). A preview is a different app to the system: it keeps its
own data and log folders and its own key, so it never opens or changes an installed ohmail's mail. It says
"Preview build" and its commit in a corner of every screen and in Settings → About, does not update itself, does
not offer to become the mail app, does not serve other devices, and signs in only to a server on the same
computer or on your tailnet. It is an AppImage only, and Linux only for now.
