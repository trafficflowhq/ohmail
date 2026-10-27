### Pictures in mail load a few at a time on the web

On the web app, the pictures of the messages on screen, background pictures included, are now fetched
through the image proxy at most six at a time instead of all at once. Opening a sender in the Screener with many picture-heavy newsletters sent
more than a thousand requests in a few seconds, and on 26 October that briefly took ohmail Cloud down for
everyone. Every picture still loads; pictures in the message you just opened go first. A picture address the
proxy would refuse on sight (not http or https, or longer than the proxy takes) is no longer asked for.
