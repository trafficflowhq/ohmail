### A send waits for a busy server instead of failing

Before a message is sent, ohmail saves it. When the server answered that save with "busy, try again in a few
seconds", a message with a Bcc was refused at once and the app said only "Sending didn't work". Nothing was sent
and nothing was lost, but the app did not say so, and pressing Send again a little later worked.

The send now waits as long as the server asked, ten seconds at most, and saves once more. If the save still
cannot be confirmed, the web and desktop apps say that the message was not sent because it could not be saved
first, instead of the general sentence.
