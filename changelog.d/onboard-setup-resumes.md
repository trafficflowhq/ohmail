### Setup picks up where it stopped when no mailbox is connected yet

On the web (ohmail Cloud and your own server), an account that signed up but never connected a mailbox no
longer comes back to an empty mail client. Once per browser tab, opening ohmail takes it to the setup page,
which resumes at the mailbox step. "Do this later" on that page is respected for the rest of the tab. It never
happens over a link to a particular place in the app, or while a mailbox sign-in is finishing. A signed-in
account never sees the sign-up form there: the page waits until the server has said where setup stands, and
if the server cannot be reached it says so, with Try again.

An empty Ohbox with no mailbox now shows a "Connect your mailbox" card. Its button, and the link in the sync
bar, open the setup page on the web and Settings → Mailboxes in the desktop app. The setup dialog on the web
hands its first connect to the setup page, which can ask for your second factor in place. The ohmarchy theme
offer waits until a mailbox is connected, on every app.
