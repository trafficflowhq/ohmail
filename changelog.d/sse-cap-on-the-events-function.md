### A device that reconnects is no longer refused live updates by its own earlier connection

When a page was reloaded or a tab reopened, the server could still be counting the connection the page
had just left, and after a few reloads the newest page was refused live updates for up to four and a half
minutes and fell back to polling. A device's new connection now takes the place of its own earlier one
when the account's limit is reached, so up to four devices keep live updates however often they
reconnect; only a fifth device with a connection of its own is refused. Every live connection is also
ended by the server within its lifetime, even when its first database read was slow. On Cloud and your
own server.
