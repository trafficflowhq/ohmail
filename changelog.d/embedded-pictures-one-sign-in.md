### Embedded pictures load without signing in again for each one

A letter with several pictures in its text no longer makes the server sign in to your mail server once per picture. The sign-in made for the first picture serves the next ones of the same mailbox for a few seconds, so a letter with eight pictures shows them in less than half the time, on the desktop and wherever the server runs as one long-lived process. A connection is only ever reused for the same mailbox and the same stored sign-in, and closes after ten seconds without use.
