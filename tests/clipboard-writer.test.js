// Every copy and paste of the launcher goes through ClipboardWriter.qml. Its
// functions and the handlers of its Process run as written, in a vm context
// with a fake process; tests/privacy.test.js runs the two scripts for real.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const text = fs.readFileSync(path.join(__dirname, "../services/ClipboardWriter.qml"), "utf8")
const FAILED = "Could not copy to the clipboard"

// The block that starts at `signature` (the first one after `from`) and ends
// at the closing brace on its own line at `indentation`.
function block(signature, indentation, from) {
  const start = text.indexOf(signature, from ? text.indexOf(from) : 0)
  assert.ok(start >= 0, signature)
  const end = text.indexOf("\n" + " ".repeat(indentation) + "}", start) + indentation + 2
  assert.ok(end > start, signature)
  return text.slice(start, end)
}

const body = (source) => source.slice(source.indexOf("{"))

// A handler of one statement: its first line and the deeper lines after it.
function handler(name, from) {
  const start = text.indexOf(name + ": ", text.indexOf(from))
  assert.ok(start >= 0, name)
  const indent = start - (text.lastIndexOf("\n", start) + 1)
  const lines = text.slice(start + name.length + 2).split("\n")
  const out = [lines[0]]
  for (const line of lines.slice(1)) {
    if (line.length - line.trimStart().length <= indent) break
    out.push(line)
  }
  return out.join("\n")
}

function property(name) {
  const line = text.split("\n").find((l) => l.trim().startsWith("readonly property string " + name + ": "))
  assert.ok(line, name)
  return line.slice(line.indexOf(": ") + 2)
}

function harness() {
  const failures = []
  const writes = []
  // Every start of the process: its command and the text it will write.
  const starts = []
  const proc = {
    text: "", exitSeen: true, command: [], stdinEnabled: false,
    write: (data) => writes.push(data)
  }
  Object.defineProperty(proc, "running", {
    get() { return this._running || false },
    set(value) {
      if (value && !this._running) starts.push({ command: Array.from(this.command), text: this.text })
      this._running = value
    }
  })
  const writer = { queued: null, failed: (message) => failures.push(message) }
  const context = vm.createContext({ writer, proc })
  writer.copyScript = vm.runInContext(property("copyScript"), context)
  writer.pasteScript = vm.runInContext(property("pasteScript"), context)
  for (const name of ["copy", "paste", "send", "finish"]) {
    vm.runInContext(block("function " + name + "(", 2), context)
    writer[name] = context[name]
  }
  const started = body(block("onStarted: {", 4, "id: proc"))
  const exited = block("onExited: function (exitCode) {", 4, "id: proc")
  const runningChanged = handler("onRunningChanged", "id: proc")
  // The running change sees the value running has then: a copy started from
  // exited() is running again.
  const changed = () => vm.runInContext("(function(running) { " + runningChanged + " })(proc.running)", context)
  return {
    writer, proc, failures, writes, starts, changed,
    // Quickshell: the process starts; `write` inside the handler is the
    // Process's own.
    start() { vm.runInContext("with (proc) (function() " + started + ")()", context) },
    // Quickshell: a run ends with exited(), then running -> false.
    end(code) {
      proc._running = false
      vm.runInContext("(" + exited.slice(exited.indexOf("function")) + ")(" + code + ")", context)
      changed()
    },
    // A command that can't start gets only running -> false.
    lost() {
      proc._running = false
      changed()
    }
  }
}

test("a copy runs a constant command and sends the text on stdin only", () => {
  for (const kind of ["copy", "paste"]) {
    const h = harness()
    const secret = "1234 * 5678 = 7006652 my private question"
    h.writer[kind](secret)
    assert.equal(h.starts.length, 1, kind)
    const command = h.starts[0].command
    assert.deepEqual(command, ["timeout", "--kill-after=1s", "5s", "bash", "-c", kind === "copy" ? h.writer.copyScript : h.writer.pasteScript], kind)
    for (const arg of command) assert.ok(!arg.includes("private"), kind + ": the text reached argv: " + arg)
    assert.equal(h.proc.stdinEnabled, true, kind)
    h.start()
    assert.deepEqual(h.writes, [secret], kind)
    // The text is not kept once it is written.
    assert.equal(h.proc.text, "", kind)
    assert.equal(h.proc.stdinEnabled, false, kind)
    h.end(0)
    assert.deepEqual(h.failures, [], kind)
  }
})

test("a failed copy reports once and the waiting copy still runs", () => {
  for (const [name, startsFirst, fail] of [
    ["exit 1", true, (h) => h.end(1)],
    ["exit 124 at the deadline", true, (h) => h.end(124)],
    ["could not start: running -> false alone", false, (h) => h.lost()]
  ]) {
    const h = harness()
    h.writer.copy("first")
    if (startsFirst) h.start()
    h.writer.copy("second")
    assert.equal(h.starts.length, 1, name + ": a copy waits while one runs")
    fail(h)
    assert.deepEqual(h.failures, [FAILED], name)
    assert.equal(h.starts.length, 2, name + ": the waiting copy starts")
    assert.equal(h.starts[1].command.at(-1), h.writer.copyScript, name)
    h.start()
    assert.deepEqual(h.writes, startsFirst ? ["first", "second"] : ["second"], name)
    h.end(0)
    // A late running -> false for the finished run changes nothing.
    h.lost()
    assert.deepEqual(h.failures, [FAILED], name)
    assert.equal(h.starts.length, 2, name)
  }
})

test("a copy that ends well reports nothing and starts the waiting copy", () => {
  const h = harness()
  h.writer.copy("first")
  h.start()
  h.writer.paste("second")
  h.end(0)
  assert.deepEqual(h.failures, [])
  assert.equal(h.starts.length, 2)
  assert.equal(h.starts[1].command.at(-1), h.writer.pasteScript)
  h.start()
  h.end(0)
  assert.deepEqual(h.writes, ["first", "second"])
  assert.deepEqual(h.failures, [])
  assert.equal(h.proc.running, false)
})
