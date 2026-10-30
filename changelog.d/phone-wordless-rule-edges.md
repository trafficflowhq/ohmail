### A picture-only letter with invisible preheader filler no longer reads as words on the phone

On the phone, an older letter in a conversation whose html holds only pictures, a hidden preheader
(`display:none`) and zero-width filler characters was drawn as a blank card and turned read after the
pause, although nothing of it had been on screen. It now counts as a letter without words, like one of
pictures alone: its card shows its files and the line that opens it, and it turns read only by that open.
