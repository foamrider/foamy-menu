const test = require("node:test")
const assert = require("node:assert/strict")
const Paths = require("../core/Paths.js")

const envOf = (vars) => (name) => vars[name] || ""

test("defaults follow the XDG base directory spec", () => {
  const p = Paths.resolve(envOf({ HOME: "/home/u", XDG_RUNTIME_DIR: "/run/user/1000" }))
  assert.equal(p.config, "/home/u/.config/foamy-menu")
  assert.equal(p.db, "/home/u/.local/share/foamy-menu/db")
  assert.equal(p.extensions, "/home/u/.local/share/foamy-menu/extensions")
  assert.equal(p.cache, "/home/u/.cache/foamy-menu")
  assert.equal(p.logs, "/home/u/.local/state/foamy-menu/logs")
  assert.equal(p.runtime, "/run/user/1000/foamy-menu")
  assert.equal(p.scriptCommands, "/home/u/.config/foamy-menu/script-commands")
  assert.equal(p.scopes, "/home/u/.config/foamy-menu/scopes")
})

test("absolute XDG overrides win, relative ones are ignored", () => {
  const p = Paths.resolve(envOf({
    HOME: "/home/u/",
    XDG_CONFIG_HOME: "/cfg/",
    XDG_DATA_HOME: "relative/data",
    XDG_STATE_HOME: "/st"
  }))
  assert.equal(p.config, "/cfg/foamy-menu")
  assert.equal(p.data, "/home/u/.local/share/foamy-menu")
  assert.equal(p.state, "/st/foamy-menu")
})

test("missing HOME is an error", () => {
  assert.throws(() => Paths.resolve(envOf({})), /HOME is not set/)
})

test("startup creates the persistent dirs and the runtime dir", () => {
  const p = Paths.resolve(envOf({ HOME: "/h", XDG_RUNTIME_DIR: "/r" }))
  assert.deepEqual(Paths.directoriesToCreate(p), [
    "/h/.config/foamy-menu", "/h/.config/foamy-menu/scopes", "/h/.local/share/foamy-menu/db", "/h/.cache/foamy-menu",
    "/h/.local/state/foamy-menu/logs", "/h/.local/state/foamy-menu/backups", "/r/foamy-menu"
  ])
})

