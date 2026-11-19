// services/TodoistSource.qml: the Todoist input's helper runs. Its functions
// and handlers run as written, in a vm context with stand-ins for the
// Process, Timer and signals: one completion per run, one add at a time,
// replies for an earlier visit, the unknown outcome's second Enter, the rate
// limit, the deadline, and notify only when the launcher is closed (D12).
// The last tests run the real wrapper (timeout, the bash output cap,
// FoamyNative) against fake helpers.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const vm = require("node:vm")
const { spawnSync } = require("node:child_process")
const TodoistInput = require("../core/TodoistInput.js")
const FoamyNative = require("../kit/node-loader.cjs").load("FoamyNative")
const FoamyPrefs = require("../kit/node-loader.cjs").load("FoamyPrefs")

const text = fs.readFileSync(path.join(__dirname, "../services/TodoistSource.qml"), "utf8")

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

// A one-line handler: `onRunningChanged: if (!running)\n  statement`.
function line(signature, anchor) {
  const from = text.indexOf(anchor)
  const start = text.indexOf(signature, from)
  assert.ok(from >= 0 && start >= 0, signature)
  const lines = text.slice(start + signature.length).split("\n")
  return lines[0] + "\n" + lines[1]
}

const FUNCTIONS = ["enter", "leave", "refreshNames", "launcherShown", "add", "addDone", "resultText", "notify", "openTask", "openInbox", "openApp",
  "shell", "nextShell", "shellDone", "enqueue", "next", "finish", "namesDone", "killGroup"]

function harness() {
  const later = []
  const log = { messages: [], added: 0, earlier: [], signals: [], writes: [] }
  const watchdog = { active: false, restart() { this.active = true }, stop() { this.active = false } }
  const proc = { job: null, input: "", startedAt: 0, processId: 4242, stdinEnabled: false, command: [], starts: 0, write(t) { log.writes.push(t) }, signal(n) { log.signals.push(n) } }
  log.reaped = []
  const reaper = { command: [], startDetached() { log.reaped.push(Array.from(this.command)) } }
  const shellProc = { args: null, explicit: false, generation: 0, command: [], starts: 0 }
  log.opened = []
  for (const p of [proc, shellProc])
    Object.defineProperty(p, "running", {
      get() { return this._running || false },
      set(value) { if (value && !this._running) this.starts++; this._running = value }
    })
  const output = { text: "" }
  const source = {
    pluginDir: "/plugins/foamy.todoist", launcherOpen: true,
    availability: "checking", model: null, adding: false, addingText: "", result: null, confirming: false,
    retryUntil: 0, waiting: false, recent: [], lastTaskId: "", visit: 0, entered: false, revision: 0, queue: [], shellQueue: [], groupKill: [], openGeneration: 0,
    message: (level, message) => log.messages.push(level + ": " + message),
    textAdded: () => log.added++,
    openFinished: (ok) => log.opened.push(ok),
    earlierResult: (style, message) => log.earlier.push([style, message])
  }
  Object.defineProperty(source, "inputState", {
    get() {
      return { availability: this.availability, adding: this.adding, addingText: this.addingText, result: this.result, retryUntil: this.retryUntil, confirming: this.confirming }
    }
  })
  const manifest = { reloads: 0, reload() { this.reloads++ } }
  const FoamyI18n = { t: (key, values) => (values && values.length ? key.replace("%1", values[0]) : key) }
  const context = vm.createContext({
    source, proc, shellProc, watchdog, reaper, output, manifest, TodoistInput, FoamyNative, FoamyPrefs, FoamyI18n, Date, JSON, Object, Math,
    Qt: { callLater: (fn) => { if (!later.includes(fn)) later.push(fn) } }
  })
  for (const name of FUNCTIONS) {
    vm.runInContext(block("  function " + name + "(", 2), context)
    source[name] = context[name]
  }
  const exited = block("onExited: function (exitCode, exitStatus)", 4, "    id: proc\n")
  const started = block("onStarted: {", 4, "    id: proc\n")
  const stopped = line("onRunningChanged: ", "    id: proc\n")
  const triggered = block("onTriggered: {", 4, "id: watchdog")
  const destroyed = block("Component.onDestruction: {", 2)
  const shellExited = block("onExited: function (exitCode)", 4, "id: shellProc")
  const shellStopped = line("onRunningChanged: ", "id: shellProc")
  const run = (code) => vm.runInContext(code, context)
  return {
    source, proc, shellProc, watchdog, log,
    flush() { while (later.length) later.shift()() },
    // Quickshell: a start sets running and emits started; the process ends
    // with exited() and then running -> false. A start that fails gets only
    // the latter.
    start() { run("(function() " + started.slice(started.indexOf("{")) + ")()") },
    reply(reply, code = 0, status = 0) {
      output.text = typeof reply === "string" ? reply : JSON.stringify(reply) + "\n"
      proc._running = false
      run("(" + exited.slice(exited.indexOf("function")) + ")(" + code + ", " + status + ")")
      run("with (proc) (function() { " + stopped + " })()")
    },
    failStart() { proc._running = false; run("with (proc) (function() { " + stopped + " })()") },
    fire() { run("(function() " + triggered.slice(triggered.indexOf("{")) + ")()") },
    destroy() { run("(function() " + destroyed.slice(destroyed.indexOf("{")) + ")()") },
    shellExit(code) {
      shellProc._running = false
      run("(" + shellExited.slice(shellExited.indexOf("function")) + ")(" + code + ")")
      run("with (shellProc) (function() { " + shellStopped + " })()")
    }
  }
}

const names = { ok: true, contract: 1, state: "signed_in", inbox_project_id: "inbox1", projects: [{ id: "inbox1", name: "Inbox", inbox: true, shared: false }, { id: "home1", name: "Home", inbox: false, shared: false }], sections: [], labels: ["phone"], collaborators: [], project_collaborators: {}, truncated: false }
const added = (id = "t1", extra) => ({ ok: true, contract: 1, added: id, task: { id, content: "Buy milk", project_id: "home1", section_id: null, priority: 1, labels: [], due: null }, project: { id: "home1", name: "Home", inbox: false }, ...extra })
const command = (proc) => Array.from(proc.command)

// Enters the input and answers its names run.
function ready(h) {
  h.source.enter()
  h.flush()
  h.start()
  h.reply(names)
  h.flush()
}

test("entering the input runs names under the deadline and the output cap; the reply fills the suggestions", () => {
  const h = harness()
  h.source.enter()
  h.flush()
  assert.equal(h.proc.job.command, "names")
  assert.deepEqual(command(h.proc).slice(0, 8), ["timeout", "--kill-after=2s", "30s", "bash", "-c", TodoistInput.CAPPED_SCRIPT, "foamy-todoist", String(TodoistInput.MAX_NAMES_OUTPUT)])
  assert.deepEqual(command(h.proc).slice(8), Array.from(FoamyNative.command("/plugins/foamy.todoist", "foamy-todoist-helper", ["names"])))
  assert.ok(h.watchdog.active)
  h.start()
  assert.deepEqual(h.log.writes, [], "names has no input")
  assert.equal(h.proc.stdinEnabled, false, "stdin closed at once")
  h.reply(names)
  assert.equal(h.source.availability, "ready")
  assert.deepEqual(h.source.model.projectList.map((p) => p.name), ["Inbox", "Home"])
  assert.equal(h.proc.job, null)
  assert.equal(h.watchdog.active, false)
})

test("a names reply for an earlier visit is dropped", () => {
  const h = harness()
  h.source.enter()
  h.flush()
  h.start()
  h.source.leave()
  h.reply(names)
  assert.equal(h.source.model, null)
  assert.equal(h.source.availability, "checking")
  assert.ok(h.log.messages.some((m) => /earlier visit/.test(m)))
  h.source.enter()
  h.source.enter()
  h.flush()
  assert.equal(h.source.queue.length, 0, "one names run serves both visits")
  h.start()
  h.reply(names)
  assert.equal(h.source.availability, "ready", "the current visit's reply counts")
})

test("Enter adds once: the request on stdin, the field cleared, the task under Added from here, Foamy Todoist refreshed", () => {
  const h = harness()
  ready(h)
  assert.equal(h.source.add("  Buy milk #Home  "), true)
  assert.equal(h.source.add("Buy milk #Home"), false, "Enter during an add is ignored")
  assert.equal(h.source.add("Something else"), false)
  h.flush()
  assert.equal(h.proc.job.command, "add")
  assert.equal(command(h.proc).at(-1), "add")
  assert.ok(!command(h.proc).some((a) => a.includes("milk")), "the text never reaches argv")
  h.start()
  assert.deepEqual(h.log.writes.at(-1), '{"text":"Buy milk #Home","reply":"task"}\n')
  assert.equal(h.proc.input, "", "the request isn't kept once written")
  assert.equal(h.source.inputState.adding, true)
  h.reply(added())
  assert.equal(h.source.adding, false)
  assert.equal(h.source.result.kind, "added")
  assert.equal(h.log.added, 1)
  assert.deepEqual(h.source.recent.map((e) => [e.id, e.content, e.project]), [["t1", "Buy milk", "Home"]])
  assert.equal(h.source.lastTaskId, "t1")
  h.flush()
  assert.equal(h.proc.job.command, "names", "names again after an add")
  assert.deepEqual(command(h.shellProc), ["timeout", "--kill-after=1s", "10s", "omarchy-shell", "foamy.todoist", "refresh"])
  h.shellExit(1)
  assert.ok(h.log.messages.some((m) => /foamy.todoist refresh failed \(exit 1\)/.test(m)), "a refresh failure is logged only")
  assert.equal(h.shellProc.args, null)
  assert.equal(h.proc.starts, 3)
  assert.equal(h.log.writes.filter((w) => w.includes('"kind"')).length, 0, "no notification while the launcher is open")
})

test("an unknown outcome keeps the text and needs a second Enter; an edited text adds at once", () => {
  const h = harness()
  ready(h)
  h.source.add("Buy milk")
  h.flush()
  h.start()
  h.reply({ ok: false, contract: 1, code: "UNKNOWN_OUTCOME", error: "Todoist didn't answer. The task may have been added: check the list before adding it again." })
  assert.equal(h.source.result.kind, "unknown")
  assert.equal(h.source.result.text, "Buy milk")
  assert.equal(h.log.added, 0, "the text stays")
  assert.equal(h.source.add("Buy milk"), false, "the first Enter only arms")
  assert.equal(h.source.confirming, true)
  assert.equal(TodoistInput.card("Buy milk", null, h.source.inputState, Date.now()).status.text, "Press ↵ again to add it anyway.")
  assert.equal(h.source.add("Buy milk"), true, "the second adds")
  h.flush()
  h.start()
  h.reply({ ok: false, contract: 1, code: "UNKNOWN_OUTCOME", error: "x" })
  assert.equal(h.source.add("Buy oat milk"), true, "another text is a new task")
})

test("the menu's deadline and the watchdog count as unknown: the request may have gone out", () => {
  const h = harness()
  ready(h)
  h.source.add("Buy milk")
  h.flush()
  h.start()
  h.proc.startedAt = Date.now() - 31000
  h.reply("", 124)
  assert.equal(h.source.result.kind, "unknown")
  h.flush()
  h.source.result = null
  h.source.add("Buy bread")
  h.flush()
  h.proc.running = true
  h.fire()
  assert.deepEqual(h.log.signals, [9])
  assert.equal(h.source.result.kind, "unknown")
  assert.equal(h.source.adding, false)
  h.proc._running = false
  h.flush()
})

test("after the watchdog, the next job waits for the old process to exit; its late exit is not the next reply", () => {
  const h = harness()
  ready(h)
  h.source.add("Buy milk")
  h.flush()
  h.start()
  const starts = h.proc.starts
  // The watchdog gives up while the process still runs, and a names run waits.
  h.source.refreshNames()
  h.fire()
  h.flush()
  assert.equal(h.source.result.kind, "unknown")
  assert.equal(h.proc.starts, starts, "nothing starts while the old process runs")
  assert.equal(h.proc.job, null)
  // The old process's exit arrives later: no job takes it.
  h.reply(added("late"), 0, 0)
  assert.equal(h.source.lastTaskId, "")
  h.flush()
  assert.equal(h.proc.starts, starts + 1, "the queued names run starts after the exit")
  assert.equal(h.proc.job.command, "names")
})

test("the helper's process group is killed when a run is given up, stopped by a signal, or torn down mid-run; not after a normal exit", () => {
  const kill = Array.from(FoamyPrefs.killGroupCommand(4242))
  const h = harness()
  ready(h)
  assert.deepEqual(h.log.reaped, [], "a normal exit leaves no group")
  assert.deepEqual(Array.from(h.source.groupKill), [])
  h.source.add("Buy milk")
  h.flush()
  h.start()
  assert.deepEqual(Array.from(h.source.groupKill), kill)
  h.fire()
  assert.deepEqual(h.log.reaped, [kill], "the watchdog kills the group, not just timeout")
  h.reply("", 9, 1)
  h.flush()
  h.start()
  h.reply(names)
  h.flush()
  h.source.add("Buy bread")
  h.flush()
  h.start()
  h.reply("", 15, 1)
  assert.deepEqual(h.log.reaped, [kill, kill], "a run stopped by a signal: its children too")
  h.flush()
  h.start()
  h.reply(names)
  h.flush()
  h.source.add("Buy eggs")
  h.flush()
  h.start()
  h.destroy()
  assert.deepEqual(h.log.reaped, [kill, kill, kill], "torn down mid-add: the helper can't add the task unseen")
})

test("a rate limit blocks Enter until retry_after; signed out and failures keep the text", () => {
  const h = harness()
  ready(h)
  h.source.add("Buy milk")
  h.flush()
  h.start()
  h.reply({ ok: false, contract: 1, code: "RATE_LIMITED", error: "Todoist is limiting requests. Try again in %1 seconds.\u001f30", retry_after: 30 })
  assert.ok(h.source.retryUntil > Date.now() + 25000)
  assert.equal(h.source.waiting, true, "the card counts down")
  assert.equal(h.source.add("Buy milk"), false)
  h.source.retryUntil = 0
  h.flush()
  h.source.add("Buy milk")
  h.flush()
  h.start()
  h.reply({ ok: false, contract: 1, code: "SIGNED_OUT", error: "Not signed in to Todoist." })
  assert.equal(h.source.availability, "signedOut")
  assert.equal(h.source.result.kind, "signedOut")
  assert.equal(h.log.added, 0)
  assert.equal(h.source.add("Buy milk"), true, "Enter tries again after a sign-in")
})

test("a helper that can't start, or is missing for this CPU, ends the add", () => {
  const h = harness()
  ready(h)
  h.source.add("Buy milk")
  h.flush()
  h.failStart()
  assert.deepEqual([h.source.result.kind, h.source.result.message.key], ["refused", "The Todoist helper failed."])
  assert.equal(h.source.adding, false)
  h.flush()
  h.source.add("Buy milk")
  h.flush()
  h.start()
  h.reply("", 127)
  assert.equal(h.source.availability, "unavailable")
  assert.equal(h.source.add("Buy milk"), false)
})

test("names from a helper without contract 1 needs an update; an add queued behind it never runs", () => {
  const h = harness()
  h.source.enter()
  h.source.add("Buy milk")
  h.flush()
  h.start()
  h.reply({ ok: false, code: "INVALID_ARGUMENT", error: "The Todoist helper was called with the wrong arguments." })
  assert.equal(h.source.availability, "needsUpdate")
  h.flush()
  assert.equal(h.proc.job, null)
  assert.equal(h.proc.starts, 1, "the add did not start")
  assert.equal(h.source.result.kind, "needsUpdate")
  assert.equal(h.source.adding, false)
})

test("the launcher closed when the reply arrives: one notification, translated, for added, failed and unknown (D12)", () => {
  for (const [reply, kind, detail] of [
    [added(), "added", ""],
    [{ ok: false, contract: 1, code: "NETWORK", error: "Can't reach Todoist. Check your connection." }, "failed", "Can't reach Todoist. Check your connection."],
    [{ ok: false, contract: 1, code: "UNKNOWN_OUTCOME", error: "x" }, "unknown", "Check Todoist before you add it again."]
  ]) {
    const h = harness()
    ready(h)
    h.source.add("Buy milk")
    h.flush()
    h.start()
    h.source.launcherOpen = false
    h.reply(reply)
    h.flush()
    assert.equal(h.proc.job.command, "notify", kind)
    h.start()
    const request = JSON.parse(h.log.writes.at(-1))
    assert.equal(request.kind, kind)
    assert.equal(request.detail, detail)
    assert.equal(request.title, { added: "Added to Todoist", failed: "Could not add the task", unknown: "Todoist may have added the task" }[kind])
    assert.equal(request.open_label, kind === "added" ? "Open in Todoist" : "Open Inbox in Todoist")
    assert.equal(request.text, "Buy milk")
    assert.deepEqual(request.task, kind === "added" ? { id: "t1", content: "Buy milk", project: "Home", due: "", labels: [] } : null)
    h.reply({ ok: false, contract: 1, code: "NOTIFY_FAILED", error: "The notification can't be sent." }, 1)
    assert.ok(h.log.messages.some((m) => /notification failed/.test(m)), "a notify failure is logged only")
    assert.equal(h.source.result.kind, kind === "failed" ? "refused" : kind, "and doesn't change the result")
  }
})

test("an add whose visit ended: no card update, a toast while the launcher is open, the task still listed", () => {
  const h = harness()
  ready(h)
  h.source.add("Buy milk")
  h.flush()
  h.start()
  h.source.leave()
  h.reply(added())
  assert.equal(h.source.result, null)
  assert.equal(h.log.added, 0, "the next visit's field is left alone")
  assert.deepEqual(h.log.earlier, [["success", "Added to Todoist"]])
  assert.equal(h.source.recent.length, 1)
  h.flush()
  assert.equal(h.proc.job, null, "no notification while the launcher is open, no names outside the input")
})

test("opening goes through Foamy Todoist's IPC, ids checked; calls wait their turn, at most eight", () => {
  const h = harness()
  assert.equal(h.source.openTask("bad id; rm"), false)
  assert.equal(h.source.openTask("t1"), true)
  h.source.openInbox()
  h.flush()
  assert.deepEqual(command(h.shellProc).slice(3), ["omarchy-shell", "foamy.todoist", "openTask", "t1"])
  h.shellExit(0)
  h.flush()
  assert.deepEqual(command(h.shellProc).slice(3), ["omarchy-shell", "foamy.todoist", "openInbox"])
  // Foamy Todoist off the bar: no IPC target, the open fails and says so.
  h.shellExit(1)
  assert.deepEqual(h.log.opened, [true, false], "an open the user asked for reports how it went")
  h.flush()
  // A refresh after an add is only logged.
  h.source.shell(["refresh"])
  h.flush()
  h.shellExit(1)
  assert.deepEqual(h.log.opened, [true, false])
  h.flush()
  for (let i = 0; i < 10; i++) h.source.openApp()
  assert.equal(h.source.shellQueue.length, 8)
  assert.ok(h.log.messages.some((m) => /too many waiting/.test(m)))
  h.flush()
  assert.ok(h.log.opened.slice(2).includes(false), "a dropped open fails too")
})

test("an open answered after the user left the input or reopened the launcher closes nothing and shows nothing", () => {
  const h = harness()
  ready(h)
  h.source.openInbox()
  h.flush()
  h.source.leave()
  h.shellExit(0)
  assert.deepEqual(h.log.opened, [], "left the input meanwhile")
  h.flush()
  h.source.enter()
  h.flush()
  h.start()
  h.reply(names)
  h.flush()
  h.source.openInbox()
  h.flush()
  h.source.launcherShown()
  h.shellExit(1)
  assert.deepEqual(h.log.opened, [], "the launcher showed again meanwhile")
  h.flush()
  h.source.openInbox()
  h.flush()
  h.source.launcherOpen = false
  h.shellExit(0)
  assert.deepEqual(h.log.opened, [], "the launcher is closed")
  h.source.launcherOpen = true
  h.flush()
  h.source.openInbox()
  h.flush()
  h.shellExit(0)
  assert.deepEqual(h.log.opened, [true], "the current session's open still closes the launcher")
})

test("reopening the launcher checks the install again and refreshes names in the input", () => {
  const h = harness()
  h.source.launcherShown()
  h.flush()
  assert.equal(h.proc.job, null, "outside the input nothing runs")
  ready(h)
  h.source.launcherShown()
  h.flush()
  assert.equal(h.proc.job.command, "names")
  assert.equal(h.source.visit, 1, "the same visit")
})

// ---- the real wrapper ---------------------------------------------------------

function fakePlugin(t, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foamy-menu-todoist-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const arch of ["x86_64", "aarch64"]) {
    fs.mkdirSync(path.join(dir, "bin", arch), { recursive: true })
    fs.writeFileSync(path.join(dir, "bin", arch, "foamy-todoist-helper"), "#!/bin/bash\n" + script, { mode: 0o755 })
  }
  return dir
}

function runReal(dir, args, input, cap) {
  const [cmd, ...rest] = TodoistInput.cappedCommand(FoamyNative.command(dir, "foamy-todoist-helper", args), cap || TodoistInput.MAX_REPLY_OUTPUT)
  return spawnSync(cmd, rest, { input: input || "", encoding: "utf8", timeout: 20000 })
}

test("the real wrapper passes stdin through and the reply back; argv holds only the command", (t) => {
  const dir = fakePlugin(t, 'printf \'{"ok":true,"contract":1,"argv":"%s","stdin":%s}\\n\' "$*" "$(cat)"\n')
  const r = runReal(dir, ["add"], '{"text":"Buy milk","reply":"task"}\n')
  assert.equal(r.status, 0, r.stderr)
  const reply = TodoistInput.parseReply(r.stdout)
  assert.equal(reply.argv, "add")
  assert.deepEqual(reply.stdin, { text: "Buy milk", reply: "task" })
})

test("the real wrapper cuts a flood at the cap (exit 141) and reports a missing helper as 127", (t) => {
  const dir = fakePlugin(t, "yes '{}'\n")
  const r = runReal(dir, ["names"], "", 4096)
  assert.ok(TodoistInput.wasCapped(r.status, 0), String(r.status))
  assert.equal(Buffer.byteLength(r.stdout), 4096)
  const missing = runReal(path.join(dir, "nowhere"), ["names"], "")
  assert.ok(FoamyNative.unavailable(missing.status), String(missing.status))
})
