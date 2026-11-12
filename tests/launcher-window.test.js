// The launcher draws in the host's overlay window under its own layer
// namespace, which AppFocuser waits on before it focuses an app's window.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8")

test("the launcher is the host's OverlayWindow in the foamy-menu layer namespace", () => {
  const window = read("ui/LauncherWindow.qml")
  assert.match(window, /^import qs\.Ui$/m)
  assert.match(window, /^OverlayWindow \{$/m, "the root type is qs.Ui.OverlayWindow")
  assert.doesNotMatch(window, /\bPanelWindow\b/, "no window of its own")
  // OverlayWindow owns these; setting them again here would fight its reveal.
  for (const owned of [/^  property bool shown\b/m, /^  visible:/m, /^  anchors \{/m, /WlrLayershell\.(layer|keyboardFocus):/])
    assert.doesNotMatch(window, owned)
  assert.match(window, /^  WlrLayershell\.namespace: "foamy-menu"$/m)
  assert.match(read("services/AppFocuser.qml"), /"namespace": \*"foamy-menu"/, "AppFocuser waits for the same namespace")
})
