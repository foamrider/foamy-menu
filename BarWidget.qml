import QtQuick
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "foamy.menu"
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: String(root.setting("icon", "󰣇"))
    fontFamily: String(root.setting("iconFont", "")) || (root.bar ? root.bar.fontFamily : Style.font.family)
    horizontalMargin: 7.5
    onPressed: function(button) {
      if (!root.bar) return
      if (button === Qt.RightButton) root.bar.run("xdg-terminal-exec")
      else root.bar.run("omarchy-shell shell toggle omarchy.menu '{\"menu\":\"root\"}'")
    }
  }
}
