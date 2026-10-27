### Pressing End in News no longer makes the Linux desktop window reload

In the Linux desktop app, pressing End in a long News or Receipts stream while a screen reader or another
accessibility tool was reading the window could crash the window's web process. The window then showed
"ohmail's window stopped and was reloaded." and you lost your place. The stream rebuilt its letters on every
frame of End's scroll animation. It now holds still while End, Home or a fast scrollbar drag moves it more
than a screen at a time, and shows the letters where the scroll stops. Scrolling with the mouse wheel or the
arrow keys loads letters as before. This applies to the desktop app and the web.
