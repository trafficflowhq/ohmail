### Dark letters read on the web and desktop

A letter that sets its own dark page and light text, such as `<body bgcolor=#000 text=#fff>`, is no longer drawn
in near-black text on that dark page; the reader now uses the letter's own text colour when it reads on that
dark page, and its usual dark text otherwise. A letter whose stylesheet
paints the page dark only for dark mode is no longer shown on that dark page in the light theme too, and in the
dark theme its dark-mode rules no longer stack with the reader's own inversion, which left such a letter grey on
grey. Web and desktop.
