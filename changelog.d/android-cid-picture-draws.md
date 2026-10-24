### Embedded pictures draw from servers that answer nested parts' headers wrongly

A picture embedded in a message, such as a signature logo or a pasted screenshot, was refused as
"could not be verified" and drawn as an empty box when the mail server answered the headers of a
nested part with its parent's. GreenMail does this. The picture's bytes then arrived still encoded.
They are now decoded by the encoding the server's own message structure declares, and served only
when they match the file stored at sync, on every app. On the phone the reader also redraws as soon
as an embedded picture arrives. Pictures from the web still wait for Show images.
