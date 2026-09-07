/** `path`, refused by name. See `node-absent.js` for why it throws on CALL and not on read. */
"use strict";
module.exports = require("./node-absent.js")("path");
