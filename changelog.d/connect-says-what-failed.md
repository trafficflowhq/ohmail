### Connecting a mailbox says which server failed, and why

Test connection on ohmail Cloud now checks the outgoing (SMTP) server as well and says what it found there. A
refusal from the outgoing server (a wrong password, no answer, a refused certificate or no encryption) is named
as the outgoing server's. When the incoming and outgoing servers are one machine on your own network, one
consent line covers both, and Test connection offers it too. The desktop app now asks for the outgoing server's consent instead of connecting a
mailbox that cannot send, and the phone app no longer quits when the outgoing server is refused.

On the desktop, Proton Mail Bridge can be connected: choose "Any other IMAP mailbox" and type 127.0.0.1 with
ports 1143 and 1025 and the password Bridge shows. ohmail shows the fingerprint of Bridge's own certificate and
connects only once you trust exactly that certificate; if it changes, ohmail stops and asks again. On the web,
the Proton note points to the desktop app.

The mailbox password fields on the phone and in the desktop app's first window no longer offer the saved ohmail
account password. Screens in German now say the server's refusals in German too, such as a refused sign-in, a
reached mailbox limit or a mailbox that is already connected.
