"use strict";

module.exports = require("./nodemailer-refused.js")(
  "Pooled SMTP connections are not available in this app. It sends each message on its own SMTP connection.",
);
