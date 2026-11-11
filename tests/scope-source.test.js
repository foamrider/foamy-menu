// ScopeSource's command runs: one completion per run whatever Quickshell
// reports (exited, running -> false without exited for a command that can't
// start, both), the watchdog, the output cap, and Scopes.bounded() against
// real processes (a hung `sh -c` and its children end at the deadline).
// The QML functions and handlers run as written, in a vm context.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const vm = require("node:vm")
const { spawnSync } = require("node:child_process")
const Scopes = require("../core/Scopes.js")
const FoamyNative = require("../kit/node-loader.cjs").load("FoamyNative")

const text = fs.readFileSync(path.join(__dirname, "../services/ScopeSource.qml"), "utf8")

// The block that starts at `signature` (after `anchor`, when given) and ends
// at the closing brace on its own line at `indentation`.
function block(signature, indentation, anchor) {
  const from = anchor ? text.indexOf(anchor) : 0
  assert.ok(from >= 0, anchor)
  const start = text.indexOf(signature, from)
  assert.ok(start >= 0, signature)
  const end = text.indexOf("\n" + " ".repeat(indentation) + "}", start) + indentation + 2
  assert.ok(end > start, signature)
  return text.slice(start, end)
}

function body(handler) {
  return handler.slice(handler.indexOf("{"))
}

function harness(scopes) {
  const later = []
  const messages = []
  const loads = []
  const signals = []
  const watchdog = { interval: 0, active: false, restart() { this.active = true }, stop() { this.active = false } }
  const proc = {
    running: false, scopeId: "", scopeCommand: [], timeoutMs: 0, startedAt: 0, lines: [],
    outputSize: 0, capped: false, stderrHead: "", command: [], starts: 0,
    signal(n) { signals.push(n) }
  }
  const source = {
    pluginDir: "/plugin", queue: [],
    scope: id => scopes.find(s => s.id === id) || null,
    message: (level, message, metadata) => messages.push(message),
    setItems: (id, list, failure) => loads.push({ id, list, failure })
  }
  const context = vm.createContext({
    source, proc, watchdog, Scopes, FoamyNative, Date,
    Qt: { callLater: fn => { if (!later.includes(fn)) later.push(fn) } }
  })
  for (const name of ["next", "finish", "keepLine", "keepStderr"]) {
    vm.runInContext(block("function " + name + "(", 2), context)
    source[name] = context[name]
  }
  const exited = block("onExited: function(exitCode, exitStatus)", 4, "id: proc")
  const runningChanged = block("onRunningChanged: {", 4, "id: proc")
  const triggered = block("onTriggered: {", 4, "id: watchdog")
  // Quickshell: a start sets running; the process ends with exited() and
  // then running -> false; a command that can't start gets only the latter.
  Object.defineProperty(proc, "running", {
    get() { return this._running || false },
    set(value) { if (value && !this._running) this.starts++; this._running = value }
  })
  return {
    source, proc, watchdog, messages, loads, signals,
    enqueue(...ids) { source.queue = source.queue.concat(ids); source.next() },
    flush() { while (later.length) later.shift()() },
    exit(code, status = 0) {
      proc._running = false
      vm.runInContext("(" + exited.slice(exited.indexOf("function")) + ")(" + code + ", " + status + ")", context)
    },
    stopped() {
      proc._running = false
      vm.runInContext("with (proc) (function() " + body(runningChanged) + ")()", context)
    },
    fire() { vm.runInContext("(function() " + body(triggered) + ")()", context) }
  }
}

const scope = (id, command, timeout = 10000) => ({ id, source: { type: "command", command, timeout } })

test("a command scope that can't start fails once and the queue goes on", () => {
  const h = harness([scope("broken", ["no-such-command"]), scope("hosts", ["printf", "a\\nb\\n"])])
  h.enqueue("broken", "hosts")
  assert.equal(h.proc.scopeId, "broken")
  assert.deepEqual(Array.from(h.proc.command), ["timeout", "--kill-after=1s", "10s", "no-such-command"])
  assert.equal(h.watchdog.interval, 10000 + Scopes.WATCHDOG_GRACE_MS)
  // Quickshell: no started, no exited; only running -> false.
  h.stopped()
  assert.deepEqual(h.loads, [{ id: "broken", list: null, failure: "couldn't start" }])
  assert.deepEqual(h.messages, ["scope broken: couldn't start"])
  assert.equal(h.proc.scopeId, "")
  assert.equal(h.watchdog.active, false)
  h.flush()
  assert.equal(h.proc.scopeId, "hosts")
  assert.equal(h.proc.starts, 2)
  h.proc.lines = ["a", "b"]
  h.exit(0)
  h.stopped()
  h.flush()
  assert.equal(h.loads.length, 2, "exited and running -> false finish the run once")
  assert.deepEqual(h.loads[1].list.map(i => i.title), ["a", "b"])
  assert.equal(h.loads[1].failure, "")
})

test("exit failures: deadline, helper missing, stderr, timeout's own report", () => {
  const native = Scopes.BUILTINS.find(s => s.id === "ssh")
  const h = harness([scope("slow", ["sleep", "60"], 500), { id: "ssh", source: native.source }, scope("bad", ["false"])])
  h.enqueue("slow")
  h.proc.startedAt = Date.now() - 600
  h.exit(124)
  h.flush()
  h.enqueue("ssh")
  assert.ok(Scopes.isNativeCommand(h.proc.scopeCommand))
  h.exit(127)
  h.flush()
  h.enqueue("bad")
  h.source.keepStderr("\ntimeout: failed to run command 'nope': No such file or directory\n")
  h.exit(127)
  assert.deepEqual(h.loads.map(l => l.failure), ["timed out", FoamyNative.UNAVAILABLE_TEXT, "failed to run command 'nope': No such file or directory"])
  // A command's own early exit 124 is no timeout.
  h.flush()
  h.enqueue("bad")
  h.exit(124)
  assert.equal(h.loads[3].failure, "exited with code 124")
})

test("the watchdog ends a run whose exit never comes, or whose start was lost", () => {
  const h = harness([scope("hung", ["sleep", "60"], 500), scope("next", ["true"])])
  h.enqueue("hung", "next")
  h.proc.running = true
  h.fire()
  assert.deepEqual(h.signals, [9])
  assert.equal(h.loads[0].failure, "timed out")
  h.flush()
  assert.equal(h.proc.scopeId, "", "the next run waits for the killed one to exit")
  h.exit(9, 1)
  h.stopped()
  assert.equal(h.loads.length, 1, "the late exit of a given-up run is ignored")
  h.flush()
  assert.equal(h.proc.scopeId, "next")
  // Not running at all when the watchdog fires: the start was lost.
  h.proc._running = false
  h.fire()
  assert.equal(h.loads[1].failure, "couldn't start")
  assert.deepEqual(h.signals, [9])
})

test("output past MAX_OUTPUT stops the command and keeps the lines before it", () => {
  const h = harness([scope("flood", ["yes"])])
  h.enqueue("flood")
  h.proc.running = true
  // 1024 characters a line with its newline: an id, then a long subtitle.
  const line = i => (i + "\t\t").padEnd(1023, "x")
  const fit = Scopes.MAX_OUTPUT / 1024
  for (let i = 0; i < fit + 50; i++) h.source.keepLine(line(i))
  assert.equal(h.proc.capped, true)
  assert.equal(h.proc.lines.length, fit)
  assert.deepEqual(h.signals, [15], "stopped once")
  // timeout passes the SIGTERM on and dies of it: a crash, not a failure.
  h.exit(15, 1)
  assert.equal(h.loads[0].failure, "")
  assert.equal(h.loads[0].list.length, Scopes.MAX_ITEMS)
  assert.ok(h.messages[0].includes("output is over"))
  // At most MAX_STDERR of stderr is kept.
  h.flush()
  h.enqueue("flood")
  for (let i = 0; i < 10; i++) h.source.keepStderr("e".repeat(1000))
  assert.equal(h.proc.stderrHead.length, Scopes.MAX_STDERR)
})

// Real processes under Scopes.bounded(): the pid file lists every process
// the command started; none may be left after it ends.
function runBounded(t, script, ms) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foamy-menu-bounded-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const pids = path.join(dir, "pids")
  const [cmd, ...args] = Scopes.bounded(["sh", "-c", script, "probe", pids], ms)
  const started = Date.now()
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 15000 })
  const elapsed = Date.now() - started
  const listed = fs.readFileSync(pids, "utf8").trim().split(/\s+/).filter(Boolean)
  // A killed orphan is a zombie until its new parent reaps it: that's gone.
  const running = pid => {
    try { return !/^\d+ \(.*\) Z /.test(fs.readFileSync("/proc/" + pid + "/stat", "utf8")) } catch (e) { return false }
  }
  let alive = listed.filter(running)
  for (let i = 0; i < 20 && alive.length; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    alive = alive.filter(running)
  }
  assert.equal(listed.length, 2, "both pids recorded")
  return { result, elapsed, alive }
}

test("a hung sh -c and its children end at the deadline", (t) => {
  const r = runBounded(t, 'sleep 300 & echo $! >> "$1"; echo $$ >> "$1"; sleep 300', 300)
  assert.ok(r.elapsed >= 300 && r.elapsed < 1200, "ended at the deadline: " + r.elapsed)
  assert.equal(r.result.status, 124)
  assert.ok(Scopes.timedOut(r.result.status, 0, r.elapsed, 300))
  assert.deepEqual(r.alive, [])
})

test("a command that ignores SIGTERM is SIGKILLed a second later, children too", (t) => {
  const r = runBounded(t, 'trap "" TERM; sh -c \'trap "" TERM; sleep 300\' & echo $! >> "$1"; echo $$ >> "$1"; sleep 300', 300)
  assert.ok(r.elapsed >= 1300 && r.elapsed < 3000, "killed after the grace: " + r.elapsed)
  // timeout SIGKILLs its own group, itself included (Quickshell: crash, code 9).
  assert.equal(r.result.signal, "SIGKILL")
  assert.ok(Scopes.timedOut(9, 1, r.elapsed, 300))
  assert.deepEqual(r.alive, [])
})
