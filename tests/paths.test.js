const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
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
    cache: "/home/u/.cache/foamy-menu"
  })
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

// Backend.qml's directory setup: directoriesDone() and the handlers of the
// mkdirs Process run as written, in a vm context with a fake backend.
const backendText = fs.readFileSync(path.join(__dirname, "../Backend.qml"), "utf8")

function qmlBlock(signature, indentation, from) {
  const start = backendText.indexOf(signature, from ? backendText.indexOf(from) : 0)
  assert.ok(start >= 0, signature)
  const end = backendText.indexOf("\n" + " ".repeat(indentation) + "}", start) + indentation + 2
  assert.ok(end > start, signature)
  return backendText.slice(start, end)
}

// A handler of one statement: its first line and the deeper lines after it.
function qmlHandler(name, from) {
  const start = backendText.indexOf(name + ": ", backendText.indexOf(from))
  assert.ok(start >= 0, name)
  const indent = start - (backendText.lastIndexOf("\n", start) + 1)
  const lines = backendText.slice(start + name.length + 2).split("\n")
  const body = [lines[0]]
  for (const line of lines.slice(1)) {
    if (line.length - line.trimStart().length <= indent) break
    body.push(line)
  }
  return body.join("\n")
}

function directorySetup() {
  const logs = []
  const backend = { directoriesReady: false, log: (...args) => logs.push(args) }
  const mkdirs = { running: true }
  const context = vm.createContext({ backend, mkdirs })
  vm.runInContext(qmlBlock("function directoriesDone(", 2), context)
  backend.directoriesDone = context.directoriesDone
  const exited = qmlBlock("onExited: function (exitCode) {", 4, "id: mkdirs")
  const runningChanged = qmlHandler("onRunningChanged", "id: mkdirs")
  return {
    backend, logs,
    // Quickshell: the setup ends with exited(), then running -> false.
    exit(code) {
      mkdirs.running = false
      vm.runInContext("(" + exited.slice(exited.indexOf("function")) + ")(" + code + ")", context)
    },
    // Alone, for a setup that could not start.
    stopped() {
      mkdirs.running = false
      vm.runInContext("(function(running) { " + runningChanged + " })(false)", context)
    }
  }
}

test("the launcher becomes ready whatever the directory setup did", () => {
  for (const [name, end, errors] of [
    ["exit 0", (h) => { h.exit(0); h.stopped() }, 0],
    ["exit 1", (h) => { h.exit(1); h.stopped() }, 1],
    ["exit 124 at the deadline", (h) => { h.exit(124); h.stopped() }, 1],
    ["could not start: running -> false alone", (h) => h.stopped(), 1]
  ]) {
    const h = directorySetup()
    end(h)
    assert.equal(h.backend.directoriesReady, true, name)
    assert.equal(h.logs.length, errors, name + ": " + JSON.stringify(h.logs))
    for (const entry of h.logs) assert.deepEqual(entry.slice(0, 2), ["error", "paths"], name)
  }
})
