### Live mail with a browser tab and the desktop app open together

On ohmail Cloud, a browser tab and the paired desktop app open at the same time could use up the
account's live-update streams: each time the tab came back to the front or the desktop app reconnected,
the stream it left kept its place for minutes, and after a few switches the next one was refused, so
new mail waited for the regular check instead of arriving at once. A reconnecting tab or desktop app
now ends the stream it left, so both keep their live stream.
