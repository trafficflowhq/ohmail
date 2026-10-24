### A forward can send only the files the person kept

The send route takes the list of the original's files a forward should carry, and the server sends exactly
those; without the list every file goes, as before. A file named in the list that is not one of the
original's own is refused and nothing is sent. `GET /hello` announces it as `features.forwardParts`, so
the apps can offer removing a forwarded file only where the server honours it. On your own server this
needs the server updated with the apps.
