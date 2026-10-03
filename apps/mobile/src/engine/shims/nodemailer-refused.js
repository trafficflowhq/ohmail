/**
 * A nodemailer module this engine requires at load and never constructs, refused by name.
 * The six files beside this one name what each stands in for; `aliases.js` says why none is reached.
 */
"use strict";

module.exports = function refused(sentence) {
  return class NotAvailableInThisApp {
    constructor() {
      throw new Error(sentence);
    }
  };
};
