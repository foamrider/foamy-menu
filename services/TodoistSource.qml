import QtQuick
import Quickshell.Io
import "../core/TodoistInput.js" as TodoistInput
import "../kit/FoamyNative.js" as FoamyNative
import "../kit/FoamyPrefs.js" as FoamyPrefs
import "../kit"

// The Todoist input's side of Foamy Todoist: it runs that plugin's helper
// (never its keyring or cache) and `omarchy-shell foamy.todoist …`.
//
// - `names` (the projects, sections, labels and people the suggestions
//   match, and the open tasks the search matches) runs when the input is
//   entered, when the launcher opens on it and after each add; nothing per
//   keystroke.
// - `add` runs on Enter, one at a time, and `notify` once after an add whose
//   reply arrives while the launcher is closed (D12).
// - Helper runs go one at a time, each under `timeout` (the whole process
//   group ends at the deadline) behind a fixed `head -c` cap on stdout
//   (TodoistInput.cappedCommand), with a watchdog behind both.
// - `visit` counts the times the input was entered or left: a names reply
//   for an earlier visit is dropped, and an add's reply only updates the card
//   of the visit it was made in. It still counts after that: it decides the
//   notification, and the task joins "Added from here".
Item {
  id: source

  // Foamy Todoist's plugin directory (Paths.todoistPlugin).
  property string pluginDir: ""
  // Whether the launcher is on screen, as the add reply arrives (D12).
  property bool launcherOpen: false
  readonly property bool installed: manifest.found

  // ---- the input's state (TodoistInput.card reads it) ------------------
  // checking (no names reply yet), ready, signedOut, needsUpdate (not
  // contract 1), unavailable (no helper for this CPU).
  property string availability: "checking"
  // TodoistInput.readNames' model, or null until names answers.
  property var model: null
  property bool adding: false
  property string addingText: ""
  // The last add of this visit: {kind, text, message, task, warning}.
  property var result: null
  // An unknown outcome for the same text was answered with Enter once: the
  // next Enter adds (no silent duplicate).
  property bool confirming: false
  // Todoist asked to wait until then (ms); Enter adds nothing before.
  property double retryUntil: 0
  // "Added from here": this shell session's adds, newest first.
  property var recent: []
  property string lastTaskId: ""
  property int visit: 0
  property bool entered: false
  // Bumped on every change the list shows.
  property int revision: 0

  readonly property var inputState: ({
      availability: source.availability,
      adding: source.adding,
      addingText: source.addingText,
      result: source.result,
      retryUntil: source.retryUntil,
      confirming: source.confirming
    })

  signal message(string level, string text, var metadata)
  // The add of the current visit is done: the field empties.
  signal textAdded
  // An add of an earlier visit ended while the launcher is open: a toast
  // says how, since its card is gone.
  signal earlierResult(string style, string text)
  // An open the user asked for (a task, the Inbox, the panel) went through
  // Foamy Todoist's IPC, or failed: its target exists only while Foamy
  // Todoist is on the bar.
  signal openFinished(bool ok)

  // ---- visits ---------------------------------------------------------

  function enter() {
    source.visit++
    source.openGeneration++
    source.entered = true
    source.result = null
    source.confirming = false
    source.refreshNames()
    source.revision++
  }

  function leave() {
    if (!source.entered)
      return
    source.visit++
    source.openGeneration++
    source.entered = false
    source.result = null
    source.confirming = false
    source.revision++
  }

  // A names run for the current visit; one queued run serves every request.
  function refreshNames() {
    if (!source.entered)
      return
    var queued = source.queue.filter(function (job) {
      return job.command === "names"
    })[0]
    if (queued)
      queued.visit = source.visit
    else
      source.enqueue({
        command: "names",
        input: "",
        visit: source.visit
      })
  }

  // The launcher opened: Foamy Todoist may have been installed or removed,
  // or signed in, since.
  function launcherShown() {
    source.openGeneration++
    manifest.reload()
    source.refreshNames()
  }

  // ---- adding ---------------------------------------------------------

  // Enter: adds the text, or says why not (false). An unknown outcome for
  // the same text needs a second Enter first.
  function add(text) {
    var request = TodoistInput.addRequest(text)
    if (!TodoistInput.canAdd(text, source.inputState, Date.now()) || !request)
      return false
    if (source.result && source.result.kind === "unknown" && source.result.text === request.text && !source.confirming) {
      source.confirming = true
      source.revision++
      return false
    }
    source.adding = true
    source.addingText = request.text
    source.confirming = false
    source.result = null
    source.enqueue({
      command: "add",
      input: JSON.stringify(request) + "\n",
      visit: source.visit,
      text: request.text
    })
    source.revision++
    return true
  }

  function addDone(job, outcome) {
    var now = Date.now()
    source.adding = false
    source.addingText = ""
    if (outcome.retryAfter > 0) {
      source.retryUntil = Math.max(source.retryUntil, now + outcome.retryAfter * 1000)
      source.waiting = true
    }
    if (outcome.kind === "signedOut" || outcome.kind === "needsUpdate" || outcome.kind === "unavailable")
      source.availability = outcome.kind
    if (outcome.kind === "added") {
      if (source.availability === "signedOut" || source.availability === "checking")
        source.availability = "ready"
      source.recent = TodoistInput.pushRecent(source.recent, TodoistInput.recentEntry(outcome.task, job.text, now))
      source.lastTaskId = outcome.task.id
    }
    var current = job.visit === source.visit
    if (current)
      source.result = Object.assign({
        text: job.text
      }, outcome)
    source.message(outcome.kind === "added" ? "info" : "warning", "todoist add: " + outcome.kind + (outcome.code ? " (" + outcome.code + ")" : ""), null)
    if (!source.launcherOpen)
      source.notify(outcome, job.text)
    else if (!current)
      source.earlierResult(outcome.kind === "added" ? "success" : "failure", source.resultText(outcome))
    if (outcome.kind === "added") {
      if (current)
        source.textAdded()
      source.refreshNames()
      source.shell(["refresh"])
    }
    source.revision++
  }

  function resultText(outcome) {
    if (outcome.kind === "added")
      return FoamyI18n.t("Added to Todoist")
    if (outcome.kind === "unknown")
      return FoamyI18n.t("Todoist may have added the task")
    return FoamyI18n.t(outcome.message.key, outcome.message.values)
  }

  // The helper's notification for an add whose reply came while the
  // launcher was closed; texts translated here (the helper has no catalog).
  // No helper to run, or one too old: logged only.
  function notify(outcome, text) {
    if (outcome.kind === "needsUpdate" || outcome.kind === "unavailable") {
      source.message("warning", "todoist: no notification, the helper can't send one (" + outcome.kind + ")", null)
      return
    }
    var kind = outcome.kind === "added" ? "added" : outcome.kind === "unknown" ? "unknown" : "failed"
    var texts = kind === "added" ? {
      title: FoamyI18n.t("Added to Todoist"),
      detail: "",
      open: FoamyI18n.t("Open in Todoist")
    } : {
      title: FoamyI18n.t(kind === "unknown" ? "Todoist may have added the task" : "Could not add the task"),
      detail: kind === "unknown" ? FoamyI18n.t("Check Todoist before you add it again.") : FoamyI18n.t(outcome.message.key, outcome.message.values),
      open: FoamyI18n.t("Open Inbox in Todoist")
    }
    source.enqueue({
      command: "notify",
      input: TodoistInput.notifyRequest(kind, texts, text, outcome.task || null) + "\n",
      visit: source.visit
    })
  }

  // The card counts the wait down once a second, only while it is on screen.
  property bool waiting: false
  Timer {
    interval: 1000
    repeat: true
    running: source.waiting && source.launcherOpen && source.entered
    onTriggered: {
      if (Date.now() >= source.retryUntil)
        source.waiting = false
      source.revision++
    }
  }

  // ---- Foamy Todoist's IPC --------------------------------------------

  // Opens a task, the Inbox or the panel through Foamy Todoist (its open
  // command, its links); refresh after an add updates its bar and panel.
  function openTask(id) {
    if (!TodoistInput.validId(id))
      return false
    source.shell(["openTask", id], true)
    return true
  }
  function openInbox() {
    source.shell(["openInbox"], true)
  }
  function openApp() {
    source.shell(["toggle"], true)
  }

  // `omarchy-shell foamy.todoist <args>`, one at a time, each within 10 s.
  // A refresh that fails is only logged; an open the user asked for
  // (`explicit`) reports through openFinished, so the launcher closes only
  // once it worked and says why when it didn't.
  property var shellQueue: []
  // Bumped when the input is entered or left and when the launcher shows or
  // hides: an open's answer for an earlier one must not close or toast the
  // launcher the user is in now.
  property int openGeneration: 0
  onLauncherOpenChanged: if (!launcherOpen)
    source.openGeneration++
  function shell(args, explicit) {
    if (source.shellQueue.length >= 8) {
      source.message("warning", "todoist: dropped omarchy-shell foamy.todoist " + args[0] + ": too many waiting", null)
      if (explicit)
        Qt.callLater(function () {
          source.openFinished(false)
        })
      return
    }
    source.shellQueue = source.shellQueue.concat([
      {
        args: args,
        explicit: !!explicit,
        generation: source.openGeneration
      }
    ])
    Qt.callLater(source.nextShell)
  }
  function nextShell() {
    if (shellProc.args || !source.shellQueue.length)
      return
    shellProc.args = source.shellQueue[0].args
    shellProc.explicit = source.shellQueue[0].explicit
    shellProc.generation = source.shellQueue[0].generation
    source.shellQueue = source.shellQueue.slice(1)
    shellProc.command = ["timeout", "--kill-after=1s", "10s", "omarchy-shell", "foamy.todoist"].concat(shellProc.args)
    shellProc.running = true
  }
  // The one end of a shell call: its exit, or -1 when it never started.
  function shellDone(code) {
    var args = shellProc.args
    if (!args)
      return
    shellProc.args = null
    if (code !== 0)
      source.message("warning", "todoist: omarchy-shell foamy.todoist " + args[0] + " failed (exit " + code + ")", null)
    if (shellProc.explicit && shellProc.generation === source.openGeneration && source.launcherOpen)
      source.openFinished(code === 0)
    else if (shellProc.explicit)
      source.message("debug", "todoist: dropped the answer to an open from an earlier launcher session", null)
    Qt.callLater(source.nextShell)
  }
  Process {
    id: shellProc
    property var args: null
    property bool explicit: false
    property int generation: 0
    onExited: function (exitCode) {
      source.shellDone(exitCode)
    }
    onRunningChanged: if (!running)
      source.shellDone(-1)
  }

  // ---- helper runs ----------------------------------------------------

  // At most a names run, an add and its notification wait (names is shared,
  // an add waits for the one before it to end).
  property var queue: []
  function enqueue(job) {
    if (source.queue.length >= 4) {
      source.message("warning", "todoist: dropped a " + job.command + " run: too many waiting", null)
      if (job.command === "add")
        Qt.callLater(function () {
          source.addDone(job, {
            kind: "refused",
            message: {
              key: "Another Todoist update is still running. Try again.",
              values: []
            }
          })
        })
      return
    }
    source.queue = source.queue.concat([job])
    Qt.callLater(source.next)
  }

  function next() {
    // proc.running too: after the watchdog gave up on a run, its process may
    // not have exited yet, and a start now would be a no-op whose late exit
    // would be read as the next job's reply.
    if (proc.job || proc.running || !source.queue.length)
      return
    var job = source.queue[0]
    source.queue = source.queue.slice(1)
    // An add queued behind a names run that found a helper this menu can't
    // use never starts.
    if (job.command === "add" && (source.availability === "needsUpdate" || source.availability === "unavailable")) {
      source.addDone(job, {
        kind: source.availability,
        message: {
          key: source.availability === "unavailable" ? "Foamy Todoist isn't available on this computer" : "Foamy Todoist needs an update",
          values: []
        }
      })
      Qt.callLater(source.next)
      return
    }
    proc.job = job
    proc.input = job.input
    proc.startedAt = Date.now()
    // Always a pipe, closed once the input (maybe none) is written: the
    // helper reads its request to the end of standard input.
    proc.stdinEnabled = true
    proc.command = TodoistInput.cappedCommand(FoamyNative.command(source.pluginDir, "foamy-todoist-helper", [job.command]), job.command === "names" ? TodoistInput.MAX_NAMES_OUTPUT : TodoistInput.MAX_REPLY_OUTPUT)
    proc.running = true
    watchdog.restart()
  }

  // The one way a helper run ends: its exit, a start that failed (exit
  // null), or the watchdog. Later calls for the same run find no job; the
  // last of them (running -> false) lets the queue go on.
  function finish(exitCode, exitStatus, output, gaveUp) {
    var job = proc.job
    if (!job) {
      Qt.callLater(source.next)
      return
    }
    proc.job = null
    proc.input = ""
    watchdog.stop()
    // A run that exited normally left no group behind; one stopped by a
    // signal (or given up on) may have: its children are killed first.
    if (gaveUp || (exitCode !== null && exitStatus !== 0))
      source.killGroup()
    source.groupKill = []
    Qt.callLater(source.next)
    var started = exitCode !== null
    var run = {
      exitCode: started ? exitCode : -1,
      exitStatus: started ? exitStatus : 1,
      output: started ? output : "",
      capped: started && TodoistInput.wasCapped(exitCode, exitStatus),
      timedOut: gaveUp || (started && TodoistInput.timedOut(exitCode, exitStatus, Date.now() - proc.startedAt)),
      unavailable: started && !gaveUp && FoamyNative.unavailable(exitCode)
    }
    if (job.command === "names")
      source.namesDone(job, run, started)
    else if (job.command === "add")
      source.addDone(job, started || gaveUp ? TodoistInput.addOutcome(run) : {
        kind: "refused",
        message: {
          key: "The Todoist helper failed.",
          values: []
        }
      })
    else if (!started || run.exitCode !== 0)
      source.message("warning", "todoist: the notification failed: " + (started ? TodoistInput.messageParts((TodoistInput.parseReply(output) || {}).error).key : "couldn't start"), null)
  }

  function namesDone(job, run, started) {
    if (job.visit !== source.visit) {
      source.message("debug", "todoist: dropped a names reply for an earlier visit", null)
      return
    }
    var outcome = started ? TodoistInput.namesOutcome(run) : {
      kind: "failed",
      detail: "couldn't start"
    }
    if (outcome.kind === "failed") {
      // Only the suggestions are missing: adding still works.
      source.message("warning", "todoist: names failed: " + outcome.detail, null)
      return
    }
    if (outcome.kind === "needsUpdate")
      source.message("warning", "todoist: Foamy Todoist's helper does not speak contract " + TodoistInput.CONTRACT, null)
    source.availability = outcome.kind
    source.model = outcome.model || null
    source.revision++
  }

  // Backstop: `timeout` normally ends the run at its deadline. If no exit
  // came by WATCHDOG_GRACE_MS later, SIGKILL what's left and settle the run.
  // Kills the running helper's process group (`timeout` leads it, so the
  // helper and anything it started go too); [] when nothing runs. Kept
  // ready for Component.onDestruction, as foamy-kit's FoamyPrefsQueue does.
  property var groupKill: []
  function killGroup() {
    if (!source.groupKill.length)
      return
    reaper.command = source.groupKill
    reaper.startDetached()
  }

  // Destroyed mid-run (a shell or plugin reload): Quickshell kills only the
  // group leader, so the helper could still add the task with nobody to
  // read the reply. Kill the whole group.
  Component.onDestruction: {
    watchdog.stop()
    if (proc.job)
      source.killGroup()
    source.groupKill = []
  }

  Process {
    id: reaper
  }

  Timer {
    id: watchdog
    interval: TodoistInput.DEADLINE_MS + TodoistInput.WATCHDOG_GRACE_MS
    onTriggered: {
      if (proc.running)
        proc.signal(9)
      source.finish(proc.running ? 9 : null, 1, "", proc.running)
    }
  }

  Process {
    id: proc
    property var job: null
    // What the run writes to the helper's standard input, cleared once written.
    property string input: ""
    property double startedAt: 0
    onStarted: {
      source.groupKill = FoamyPrefs.killGroupCommand(proc.processId)
      if (proc.input !== "")
        proc.write(proc.input)
      proc.stdinEnabled = false
      proc.input = ""
    }
    stdout: StdioCollector {
      id: output
      waitForEnd: true
    }
    onExited: function (exitCode, exitStatus) {
      source.finish(exitCode, exitStatus, output.text, false)
    }
    // After exited() this finds no job; without exited() the run never started.
    onRunningChanged: if (!running)
      source.finish(null, 1, "", false)
  }

  // ---- whether Foamy Todoist is installed (D5) ------------------------

  // Its manifest.json in the plugin folder, naming foamy.todoist. Omarchy
  // reads the same file whole when it scans plugins; a manifest over 64 KiB
  // is not one.
  FileView {
    id: manifest
    property bool found: false
    path: source.pluginDir ? source.pluginDir + "/manifest.json" : ""
    printErrors: false
    watchChanges: true
    onFileChanged: reload()
    onLoaded: {
      var text = manifest.text()
      var parsed = null
      try {
        parsed = text.length <= 65536 ? JSON.parse(text) : null
      } catch (e) {
        parsed = null
      }
      manifest.found = !!parsed && parsed.id === "foamy.todoist"
    }
    onLoadFailed: manifest.found = false
  }
}
