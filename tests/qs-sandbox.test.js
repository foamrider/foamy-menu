const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const { isolatedQs } = require("./qs-sandbox.js")

// From inside a qs started with isolatedQs()'s env: a session bus call, the
// display variables qs sees, where the omarchy commands resolve, and what
// running one does.
const PROBE = `import QtQuick
import Quickshell
import Quickshell.Io
ShellRoot {
  id: probe
  property var report: ({})
  Process {
    id: bus
    command: ["dbus-send", "--session", "--print-reply", "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.GetId"]
    onExited: function (code) {
      probe.report.bus = code
      host.running = true
    }
  }
  Process {
    id: host
    command: ["sh", "-c", 'for c in omarchy omarchy-shell; do command -v "$c" || echo "none $c"; done; omarchy-shell shell summon omarchy.menu 2>/dev/null; echo "status $?"']
    stdout: StdioCollector { id: hostOut }
    onExited: {
      probe.report.host = hostOut.text.trim().split("\\n")
      console.log("FOAMY_SANDBOX " + JSON.stringify(probe.report))
      Qt.quit()
    }
  }
  Component.onCompleted: {
    report.display = ["WAYLAND_DISPLAY", "DISPLAY", "HYPRLAND_INSTANCE_SIGNATURE"].filter(function (name) {
      return String(Quickshell.env(name) || "") !== ""
    })
    bus.running = true
  }
}
`

function sandbox(t) {
  const parent = fs.realpathSync(os.tmpdir())
  const root = fs.mkdtempSync(path.join(parent, "foamy-menu-qs-sandbox-"))
  t.after(() => {
    assert.equal(path.dirname(root), parent)
    assert.ok(path.basename(root).startsWith("foamy-menu-qs-sandbox-"))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

function probe(root, env, argv) {
  const config = path.join(root, "shell.qml")
  fs.writeFileSync(config, PROBE)
  const result = spawnSync(argv[0], [...argv.slice(1), "-p", config], { cwd: root, env, encoding: "utf8", timeout: 15000, killSignal: "SIGKILL" })
  assert.ifError(result.error)
  const output = result.stdout + result.stderr
  assert.equal(result.status, 0, output)
  const line = output.split("\n").find(l => l.includes("FOAMY_SANDBOX "))
  assert.ok(line, output)
  return JSON.parse(line.slice(line.indexOf("FOAMY_SANDBOX ") + "FOAMY_SANDBOX ".length))
}

test("a test qs reaches no session bus, display or Omarchy command", { skip: !process.env.OMACAST_QML_RUNNER }, t => {
  const root = sandbox(t)
  const { env, hostBin, hostCommands } = isolatedQs(root)
  const report = probe(root, env, [process.env.OMACAST_QML_RUNNER])
  assert.notEqual(report.bus, 0, "dbus-send reached a session bus")
  assert.deepEqual(report.display, [])
  // Each omarchy command is either gone or the logging stub.
  for (const name of ["omarchy", "omarchy-shell"]) {
    const found = report.host.find(l => l === "none " + name || l.endsWith("/" + name))
    assert.ok(found === "none " + name || found === path.join(hostBin, name), name + " resolves to " + found)
  }
  assert.equal(report.host[report.host.length - 1], "status 127")
  const stubbed = fs.existsSync(path.join(hostBin, "omarchy-shell"))
  assert.deepEqual(hostCommands(), stubbed ? ["omarchy-shell shell summon omarchy.menu"] : [])
})

// The control: the same probe does see a bus when it has one.
test("the bus probe sees a private session bus", { skip: !process.env.OMACAST_QML_RUNNER }, t => {
  const runner = spawnSync("sh", ["-c", "command -v dbus-run-session"], { encoding: "utf8" })
  if (runner.status !== 0) return t.skip("no dbus-run-session")
  const root = sandbox(t)
  const { env } = isolatedQs(root)
  delete env.DBUS_SESSION_BUS_ADDRESS
  const report = probe(root, env, [runner.stdout.trim(), "--", process.env.OMACAST_QML_RUNNER])
  assert.equal(report.bus, 0)
})
