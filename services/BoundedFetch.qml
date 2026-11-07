import QtQuick
import Quickshell.Io
import "../core/Fetch.js" as Fetch

// One HTTPS GET at a time through curl, at most maxBytes and timeoutSeconds
// (core/Fetch.js says why this is not XMLHttpRequest). get() while a request
// runs replaces it: the running one is stopped and its reply dropped.
// finished(tag, text, failure) reports each request that was not replaced;
// failure is "" when text is the whole reply.
Item {
  id: fetch

  property int maxBytes: Fetch.MAX_BYTES
  property int timeoutSeconds: 15
  readonly property bool busy: proc.running || fetch.next !== null
  property var next: null           // { url, tag } waiting to start

  signal finished(var tag, string text, string failure)

  function get(url, tag) {
    fetch.next = { url: String(url), tag: tag }
    if (!proc.running) Qt.callLater(fetch.start)
    else if (proc.job) { proc.job = null; proc.signal(15) }   // onExited starts the next
  }

  function start() {
    if (proc.running || !fetch.next) return
    var job = fetch.next
    fetch.next = null
    var input = Fetch.config(job.url, Qt.locale().uiLanguages)
    if (!input) { fetch.finished(job.tag, "", "not an https URL"); return }
    proc.job = job
    proc.input = input
    proc.didStart = false
    proc.command = Fetch.argv(fetch.maxBytes, fetch.timeoutSeconds)
    proc.stdinEnabled = true
    proc.running = true
  }

  function done(job, text, failure) {
    if (job) fetch.finished(job.tag, failure ? "" : text, failure)
    Qt.callLater(fetch.start)
  }

  Process {
    id: proc
    property var job: null
    property string input: ""
    property bool didStart: false
    stdout: StdioCollector { id: out }
    stderr: StdioCollector { id: err }
    onStarted: {
      proc.didStart = true
      write(proc.input)
      proc.input = ""
      proc.stdinEnabled = false
    }
    onExited: function(exitCode) {
      var job = proc.job
      proc.job = null
      var text = String(out.text || "")
      fetch.done(job, text, Fetch.failure(exitCode, err.text, text, fetch.maxBytes))
    }
    // A command that cannot start reports no exit.
    onRunningChanged: {
      if (proc.running || proc.didStart || !proc.job) return
      var job = proc.job
      proc.job = null
      fetch.done(job, "", "curl did not start")
    }
  }
}
