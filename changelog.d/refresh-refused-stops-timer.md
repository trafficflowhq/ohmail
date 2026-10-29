### A signed-out browser tab stops asking the server to renew its sign-in

A browser tab left open after its sign-in had ended, for example after a sign-out on another device, sent
the server a renewal request every five minutes for as long as it stayed open, and each one was refused. It
now asks nothing more until somebody signs in again in that browser; the tab then picks the new sign-in up
within five minutes, as before. A renewal that failed because the server was busy or out of reach is still
retried. On ohmail Cloud and on your own server.
