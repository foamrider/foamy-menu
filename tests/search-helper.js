// The search helper the tests run: FOAMY_HELPER (a JSON argv prefix, e.g.
// '["bin/aarch64/foamy-menu-search"]'), else the plugin's own build. With
// FOAMY_HELPER set, a missing helper fails the tests instead of skipping them.
const fs = require("node:fs")
const path = require("node:path")

const root = path.join(__dirname, "..")
const fromEnv = process.env.FOAMY_HELPER ? JSON.parse(process.env.FOAMY_HELPER) : null
if (fromEnv !== null && (!Array.isArray(fromEnv) || fromEnv.length === 0 || !fromEnv.every(a => typeof a === "string")))
  throw new Error("FOAMY_HELPER must be a non-empty JSON array of strings")
const argv = fromEnv || [path.join(root, "bin/foamy-menu-search")]

module.exports = { argv, required: fromEnv !== null, skip: fromEnv === null && !fs.existsSync(argv[0]) }
