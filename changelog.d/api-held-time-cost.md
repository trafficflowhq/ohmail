### ohmail Cloud no longer holds a connection open for every open window

On ohmail Cloud, an open web tab or desktop app used to keep a request to the server open around the
clock to hear about new mail, and every answer kept its server instance awake for 22 seconds after it was
sent. Cloud's host bills each second an instance is awake, so a handful of open windows kept about ten
instances busy all day. The Cloud server now holds nothing open: new mail reaches an open web tab on its
regular check, within about 8 seconds, and the desktop app within 20 seconds. An instance stays awake about
a second after its last answer. Your own server still pushes new mail at once, as before.
