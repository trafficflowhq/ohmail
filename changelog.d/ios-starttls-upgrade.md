### The iPhone connects to a mail server that encrypts with STARTTLS

On iOS, connecting a mailbox to a server on a STARTTLS port (143, or another port with Implicit TLS
off) never got as far as encrypting the connection: the phone gave up after about a second and said
the server offered no encrypted connection. The switch to encryption now happens, and the server's
certificate is checked exactly as on port 993. If the switch itself fails, the phone now says so and
stops before sending the password, instead of claiming the server has no encryption.

On Android and iOS, anything that reaches the phone while the connection is being switched to
encryption is no longer read as though the server had sent it encrypted: the switch is refused and
the password is never sent.
