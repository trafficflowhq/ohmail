### The address confirmation page removes a signed-out browser's mail as it opens

On the web app, on ohmail Cloud and on your own server, the page that confirms an email address asked whether
this browser's sign-in still held only when Confirm was pressed, so a browser signed out from another device kept
its copy of the mail while the page was open and after it was closed unconfirmed. It now asks as it opens, as the
sign-in and sign-up pages do, and starts removing that copy at once. A sign-out you asked for that the server
never confirmed is still finished first, without reading the session.
