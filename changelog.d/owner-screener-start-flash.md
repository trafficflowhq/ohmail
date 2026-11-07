### The Screener no longer flashes a waiting count at start when nothing is waiting

On the desktop app, the Ohbox showed a Screener strip such as "7 waiting" for a moment after every start and then
dropped it, while the Screener itself was empty. The strip, the sidebar's Screener count and the Screener now wait
until ohmail has checked who is really waiting, and show only those senders. The Ohbox's unread count waits for
that check too, so it no longer changes a moment after the start.
