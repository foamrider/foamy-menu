const test = require("node:test")
const assert = require("node:assert/strict")
const Paths = require("../core/Paths.js")

const envOf = (vars) => (name) => vars[name] || ""

test("defaults follow the XDG base directory spec", () => {
  const p = Paths.resolve(envOf({ HOME: "/home/u", XDG_RUNTIME_DIR: "/run/user/1000" }))
  // Only the paths the launcher uses (system.getPaths reports these).
  assert.deepEqual(p, {
    home: "/home/u",
    config: "/home/u/.config/foamy-menu",
    scopes: "/home/u/.config/foamy-menu/scopes",
    data: "/home/u/.local/share/foamy-menu",
    db: "/home/u/.local/share/foamy-menu/db",
    cache: "/home/u/.cache/foamy-menu",
    todoistPlugin: "/home/u/.config/omarchy/plugins/foamy.todoist"
  })
})

test("Foamy Todoist is looked for where Omarchy installs plugins, by HOME, unless a test names one", () => {
  // The host's PluginRegistry: $HOME/.config/omarchy/plugins, whatever XDG_CONFIG_HOME says.
  assert.equal(Paths.resolve(envOf({ HOME: "/home/u", XDG_CONFIG_HOME: "/cfg" })).todoistPlugin, "/home/u/.config/omarchy/plugins/foamy.todoist")
  assert.equal(Paths.resolve(envOf({ HOME: "/home/u", FOAMY_TODOIST_PLUGIN_DIR: "/t/foamy.todoist/" })).todoistPlugin, "/t/foamy.todoist")
  assert.equal(Paths.resolve(envOf({ HOME: "/home/u", FOAMY_TODOIST_PLUGIN_DIR: "relative" })).todoistPlugin, "/home/u/.config/omarchy/plugins/foamy.todoist")
  const p = Paths.resolve(envOf({ HOME: "/home/u" }))
  assert.ok(![...Paths.directoriesToCreate(p), ...Paths.privateRoots(p), ...Paths.privateTrees(p)].some((d) => d.includes("omarchy")), "never created or changed")
})

test("absolute XDG overrides win, relative ones are ignored", () => {
  const p = Paths.resolve(envOf({
    HOME: "/home/u/",
    XDG_CONFIG_HOME: "/cfg/",
    XDG_DATA_HOME: "relative/data",
    XDG_CACHE_HOME: "/c"
  }))
  assert.equal(p.config, "/cfg/foamy-menu")
  assert.equal(p.data, "/home/u/.local/share/foamy-menu")
  assert.equal(p.cache, "/c/foamy-menu")
})

test("missing HOME is an error", () => {
  assert.throws(() => Paths.resolve(envOf({})), /HOME is not set/)
})

test("startup creates only the dirs the launcher uses, and makes them private", () => {
  const p = Paths.resolve(envOf({ HOME: "/h", XDG_RUNTIME_DIR: "/r" }))
  assert.deepEqual(Paths.directoriesToCreate(p), [
    "/h/.config/foamy-menu", "/h/.config/foamy-menu/scopes", "/h/.local/share/foamy-menu/db", "/h/.cache/foamy-menu"
  ])
  assert.deepEqual(Paths.privateRoots(p), ["/h/.config/foamy-menu", "/h/.local/share/foamy-menu", "/h/.cache/foamy-menu"])
  assert.deepEqual(Paths.privateTrees(p), ["/h/.config/foamy-menu", "/h/.local/share/foamy-menu"])
})

