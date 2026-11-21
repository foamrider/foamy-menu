// The search helper the tests run: FOAMY_HELPER (a JSON argv prefix, e.g.
// '["bin/aarch64/foamy-menu-search"]'), else the plugin's bundled binary for
// this CPU, launched the way NativeSearch.qml launches it (FoamyNative.command).
// The helper tests skip only on a CPU the plugin ships no helper for: on
// x86_64 and aarch64 a missing binary fails them, as it does with FOAMY_HELPER.
const path = require("node:path")
const FoamyNative = require("../kit/node-loader.cjs").load("FoamyNative")

const root = path.join(__dirname, "..")
const NAME = "foamy-menu-search"
const SHIPPED = ["x86_64", "aarch64"]
const ARCH = { x64: "x86_64", arm64: "aarch64" }[process.arch] || process.arch
const fromEnv = process.env.FOAMY_HELPER ? JSON.parse(process.env.FOAMY_HELPER) : null
if (fromEnv !== null && (!Array.isArray(fromEnv) || fromEnv.length === 0 || !fromEnv.every(a => typeof a === "string")))
  throw new Error("FOAMY_HELPER must be a non-empty JSON array of strings")
const argv = fromEnv || Array.from(FoamyNative.command(root, NAME, []))

module.exports = {
  argv,
  required: fromEnv !== null,
  skip: fromEnv === null && !SHIPPED.includes(ARCH)
}
