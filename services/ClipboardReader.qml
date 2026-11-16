import QtQuick
import Quickshell.Io

// Reads the clipboard's text for a paste without letting Qt read it. Qt's
// paste() reads the whole offer on the UI thread, with no byte cap and no
// total deadline, so a clipboard owner that keeps sending can fill the
// shell's memory or hold its UI. kit/clipboard.sh (foamy-kit's
// FoamyClipboard) reads it in its own process instead: at most 16 KiB of
// text without NUL, line breaks as spaces, killed with its producer at 2 s.
//
//   ClipboardReader {
//     pluginDir: backend.pluginDir
//     onRead: function (text) { … }
//     onFailed: function (message) { … }   // English, for the UI to translate
//   }
//   reader.start()    // false while a read runs
//   reader.cancel()   // stops it; neither signal follows
Item {
  id: reader

  required property string pluginDir
  // Busy until a stopped read has also exited: running = false only sends
  // TERM, and a start before the exit would be a no-op whose result is the
  // stopped read's exit.
  readonly property bool busy: proc.pending || proc.running

  signal read(string text)
  signal failed(string message)

  function start() {
    if (reader.busy)
      return false
    proc.pending = true
    proc.command = ["bash", reader.pluginDir + "/kit/clipboard.sh", "clipboard"]
    proc.running = true
    return true
  }

  function cancel() {
    proc.pending = false
    proc.running = false
  }

  // The one way a read ends: exited, or couldn't start (then Quickshell
  // emits no exited(), only running -> false). A cancelled read ends here
  // too, with nothing pending, and reports nothing.
  function finish(code, output) {
    if (!proc.pending)
      return
    proc.pending = false
    if (code === 124 || code === 137) {
      reader.failed("Clipboard paste timed out. Copy the text again.")
      return
    }
    if (code === 5) {
      reader.failed("Clipboard text is too large or contains invalid characters.")
      return
    }
    // clipboard.sh leaves "" on stdout when wl-paste fails, so the text
    // counts only after exit 0.
    var text = null
    if (code === 0) {
      try {
        text = JSON.parse(output)
      } catch (e) {
        text = null
      }
    }
    if (typeof text !== "string" || text.length > 16384) {
      reader.failed("Could not paste clipboard text. Copy plain text and try again.")
      return
    }
    reader.read(text)
  }

  Component.onDestruction: reader.cancel()

  Process {
    id: proc
    property bool pending: false
    stdout: StdioCollector {
      id: output
    }
    onExited: function (exitCode) {
      reader.finish(exitCode, output.text)
    }
    onRunningChanged: if (!running)
      reader.finish(-1, "")
  }
}
