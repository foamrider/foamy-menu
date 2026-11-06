import QtQuick
import Quickshell
import qs.Commons

// One app in the Apps grid: a large icon over its name, as in Omarchy's own
// app grid. The selection marks the name, not the whole cell.
Item {
  id: cell

  required property int index
  required property string title
  required property string iconName
  required property bool favorite

  property bool selected: false
  property var look: null
  property var appLibrary: null
  property real zoom: 1

  signal hovered(int index, var item, var mouse)
  signal clicked(int index)

  function px(v) { return Math.round(Style.space(v) * cell.zoom) }
  readonly property int iconSize: cell.px(52)

  Image {
    id: icon
    anchors.horizontalCenter: parent.horizontalCenter
    y: cell.px(12)
    width: cell.iconSize
    height: cell.iconSize
    sourceSize: Qt.size(cell.iconSize * 2, cell.iconSize * 2)
    source: cell.appLibrary ? cell.appLibrary.iconSource(cell.iconName) : Quickshell.iconPath(cell.iconName, "application-x-executable")
    fillMode: Image.PreserveAspectFit
    asynchronous: true
    smooth: true
    mipmap: true
  }

  Text {
    visible: cell.favorite
    anchors.right: icon.right
    anchors.top: icon.top
    anchors.rightMargin: -cell.px(6)
    anchors.topMargin: -cell.px(4)
    textFormat: Text.PlainText
    text: "★"
    color: cell.look.accent
    font.pixelSize: Math.round(Style.font.bodySmall * cell.zoom)
  }

  Rectangle {
    anchors.centerIn: label
    width: Math.min(cell.width - cell.px(8), label.contentWidth + cell.px(16))
    height: label.contentHeight + cell.px(6)
    radius: Math.max(Style.cornerRadius, cell.px(6))
    color: cell.selected ? cell.look.selectedBackground : "transparent"
  }

  Text {
    id: label
    anchors.top: icon.bottom
    anchors.topMargin: cell.px(10)
    anchors.horizontalCenter: parent.horizontalCenter
    width: parent.width - cell.px(20)
    textFormat: Text.PlainText
    text: cell.title
    color: cell.selected ? cell.look.accent : cell.look.foreground
    font.family: cell.look.fontFamily
    font.pixelSize: Math.round(Style.font.body * cell.zoom)
    horizontalAlignment: Text.AlignHCenter
    wrapMode: Text.Wrap
    maximumLineCount: 2
    elide: Text.ElideRight
  }

  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onPositionChanged: function(mouse) { cell.hovered(cell.index, cell, mouse) }
    onClicked: cell.clicked(cell.index)
  }
}
