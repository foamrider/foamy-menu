import QtQuick
import Quickshell

// Offscreen stand-in for the PanelWindow the stock menu draws in (offscreen
// Qt has no layer shell). tests/runtime.py loads the host's real menu with
// `PanelWindow` swapped for this, `anchors { … }` turned into
// `windowAnchors { … }` and the WlrLayershell lines dropped. Like a layer
// surface, a window anchored to two opposite edges spans the screen.
FloatingWindow {
  id: window
  property int exclusionMode: 0
  property int exclusiveZone: 0
  readonly property FakeMenuEdges windowAnchors: FakeMenuEdges {}
  readonly property var shownScreen: screen || (Quickshell.screens.length ? Quickshell.screens[0] : null)

  implicitWidth: windowAnchors.left && windowAnchors.right && shownScreen ? shownScreen.width : 1
  implicitHeight: windowAnchors.top && windowAnchors.bottom && shownScreen ? shownScreen.height : 1
}
