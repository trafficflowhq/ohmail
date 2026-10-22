### Mail at providers other than Gmail and Microsoft can be confirmed by its sender's own signature

At a mailbox whose provider ohmail does not read a verdict from (every provider but Gmail and Microsoft),
ohmail now checks the DKIM signature the sender's own domain put on the message, for mail arriving from now
on: a letter from a company's own address, and a one-click newsletter while a screen-out may unsubscribe.
Where the signature holds, the sender counts as confirmed: the one-click unsubscribe a screen-out sends, and
acting on a confident suggestion for a company's own address, now happen there too, and the "Your mail
provider did not confirm that." line no longer shows on such a letter. A signature that is missing or does
not hold changes nothing; it never counts against a sender. The check looks up the signing key in DNS
through your system's resolver, and a sender whose name server does not answer holds up new mail by a
few seconds at most. This applies on the desktop, ohmail Cloud and your own server; a phone organizing
its own mail does not check signatures.

On the desktop the one-click unsubscribe a screen-out sends goes out from your own computer, so the list
sees the computer's network address; a screen-out made in a browser paired with the desktop app is sent
from that computer too. The note under the Settings switch and the fine print of the screen-out confirm
said it went from ohmail's servers, which is true on ohmail Cloud only; on the desktop, and in a browser
paired with it, they now say it goes from your computer, in English and German.
