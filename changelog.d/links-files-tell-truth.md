### Look-alike link text gets its note, and a web PDF preview only ever opens in its worker

On the web app, ohmail Cloud and the desktop, a link whose text names a site in look-alike letters now gets
the note that it goes elsewhere, as one naming another site in plain letters already did: math-bold or
full-width letters, letters of another script (Cyrillic `раураl.com`), full-width or ideographic full stops,
and a site name glued to text of another script without a space. The text is read the way a browser reads an
address, so an honest address in another script that leads where it says (`bücher.example`) stays quiet.
Words of another script joined by a dot (`1.查看详情`, `ул.Тверская`) name no site unless they end in a real
top-level domain such as `.рф` or in letters drawn as Latin ones. Dots of other shapes, such as a middle dot or a one dot leader, can still hide an address.

Hovering a link in a letter always shows where it goes: a title the sender put on anything inside the link no
longer replaces it. A picture inside a link keeps that text as its description.

Spam, Junk and Screened-out previews no longer say that a mail is a meeting invitation sent as an Outlook
link. Mail set aside there is the place a look-alike would come from, and ohmail no longer vouches for it.

The web app's PDF preview reads the file only in its own worker. A browser that cannot start the worker
shows "Can't show this PDF here" with a Download, instead of reading the file on the page that holds your
session.
