### A remote picture or an unsubscribe no longer hangs on a server that switches protocols

A server named in a letter could answer by switching to another protocol, and ohmail then waited on it
for good: the picture never loaded and held its request open until ohmail Cloud or the browser gave up,
and a one-click unsubscribe turned with no answer. On ohmail Cloud, your own server and the desktop app
both now give up at once: the picture shows as one that could not be loaded, and the unsubscribe says the
list could not take the request, so you can try again. On ohmail Cloud and your own server, the same
answer from one device's notification server no longer holds up the new-mail wakes of your other devices.
