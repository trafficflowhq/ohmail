/**
 * Which app this build makes: `app.json` is the ohmail app; `OHMAIL_VARIANT` names another row of `variants.json`
 * (`variant-config.js`). Read at each evaluation, never at load, so one process can resolve both apps.
 */
const { resolveVariant } = require("./variant-config");

module.exports = ({ config }) => resolveVariant(config, process.env.OHMAIL_VARIANT);
