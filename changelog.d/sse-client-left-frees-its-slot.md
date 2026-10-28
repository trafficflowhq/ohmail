### A closed tab no longer holds a live-update stream on ohmail Cloud

On ohmail Cloud, a browser tab that was closed or reloaded, or a desktop app that restarted, kept its
live-update stream for up to four and a half minutes after it left. With a tab and the desktop app open,
the next connection could be refused in that time, and new mail waited for the regular check instead of
arriving at once. Cloud now ends a stream within seconds of the app on the other side going away, which
frees its place for the next connection. Your own server already ended such streams at once and is
unchanged.
