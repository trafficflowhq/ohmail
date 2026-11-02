### Forged letters, disguised tracking pixels and mailing lists are caught in more places

With "Act on suggestions" on, a letter waiting in the Screener whose mail provider's sender check failed is
no longer let into the Ohbox with its sender's other mail: it waits for you, and the rest is filed as before.
A suggestion made about such a letter lets nothing in. Your own press still moves it. On every app.

A remote picture a letter's style names in a spelling the reader did not recognise, an escape ended by a
Windows line break or an escaped quote inside a picture set, is now counted among the blocked images and
taken out of the letter like every other spelling. It was never loaded: the reader's frame refused it.
Web, desktop and phone.

The phone app used on its own, without a paired server, now reads the size of each picture it fetches
once you allow pictures, as the server does for Cloud and your own server: a tracking pixel disguised as
an ordinary picture is not drawn and is counted with the blocked tracking pixels, and a picture whose
format it cannot read is not drawn. The help page no longer names the phone as the exception.

Before a letter goes to an AI model for a draft, ohmail checks whether its subject and text together carry
a sign-in code or a password, and refuses to send it if they do. A field between the two halves could hide
them from each other; its subject and text are now also read side by side, without the sender's address
between them.

A mailing list whose address is written in punycode in its List-Post header, as an internationalised domain
such as `xn--bcher-kva.example` is on the wire, is now recognised as the list its mail comes from. A company
name a member puts on that list's address waits in the Screener, as it does on every other list.

ohmail records the addresses mailing lists post as, from a header any sender can write. An account now
records at most 1,000 of them, plus any address you wrote to or allowed yourself, so forged headers cannot
grow that record without bound.
