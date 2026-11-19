import QtQuick
import Quickshell
import qs.Commons
import "../core/Scopes.js" as Scopes
import "../kit"

Item {
  id: row

  required property int index
  required property string rowKind
  required property string itemId
  required property string title
  required property string subtitle
  required property string glyph
  required property string glyphFont
  required property string iconName
  // A scope item's own icon (a file or an icon name) shows instead of the glyph.
  required property string image
  required property string typeLabel
  // A setting's value sits where other rows show their type, and reads as one.
  required property bool isSetting
  required property string alias
  required property bool checked
  required property bool disabled
  required property bool favorite
  required property string calcResult
  required property string calcContext
  // The Todoist card (TodoistInput.sections), as JSON.
  required property string card

  property bool selected: false
  property bool imageFailed: false
  onImageChanged: row.imageFailed = false
  property var look: null
  property var appLibrary: null
  property real zoom: 1

  signal hovered(int index, var item, var mouse)
  signal clicked(int index)

  readonly property bool isSection: row.rowKind === "section"
  readonly property bool isCalculator: row.rowKind === "calculator"
  readonly property bool isTodoist: row.rowKind === "todoist" || row.rowKind === "todoist-static"
  function px(v) {
    return Math.round(Style.space(v) * row.zoom)
  }

  width: ListView.view ? ListView.view.width : 0
  height: row.isSection ? (row.title ? px(30) : px(6)) : (row.isCalculator ? px(64) : row.isTodoist ? Math.max(px(100), todoistCard.implicitHeight + px(28)) : px(42))

  // The inline calculator, one line: the expression (or rate, zone, "in 3
  // days") on the left, aligned to the top of the line; the answer large on
  // the right, aligned to its bottom.
  Loader {
    active: row.isCalculator
    anchors.fill: parent
    sourceComponent: Rectangle {
      anchors.fill: parent
      radius: Math.max(Style.cornerRadius, row.px(6))
      color: row.selected ? row.look.selectedBackground : Util.alpha(row.look.foreground, 0.04)
      border.width: 1
      border.color: Util.alpha(row.look.foreground, row.selected ? 0 : 0.08)

      Text {
        id: calcAnswer
        anchors.right: parent.right
        anchors.rightMargin: row.px(16)
        anchors.bottom: parent.bottom
        anchors.bottomMargin: row.px(10)
        // At most two thirds of the card; a long answer shrinks to fit.
        width: Math.min(implicitWidth, (parent.width - row.px(32)) * 2 / 3)
        horizontalAlignment: Text.AlignRight
        textFormat: Text.PlainText
        text: row.calcResult
        color: row.selected ? row.look.accent : row.look.foreground
        font.family: row.look.fontFamily
        font.pixelSize: Math.round(Style.font.heading * 1.8 * row.zoom)
        font.weight: Font.DemiBold
        fontSizeMode: Text.HorizontalFit
        minimumPixelSize: Math.round(Style.font.body * row.zoom)
        elide: Text.ElideLeft
      }
      Text {
        visible: row.calcContext.length > 0
        anchors.left: parent.left
        anchors.right: calcAnswer.left
        anchors.leftMargin: row.px(16)
        anchors.rightMargin: row.px(16)
        anchors.top: parent.top
        anchors.topMargin: row.px(12)
        textFormat: Text.PlainText
        text: row.calcContext
        color: row.look.foreground
        opacity: 0.6
        font.family: row.look.fontFamily
        font.pixelSize: Math.round(Style.font.heading * row.zoom)
        elide: Text.ElideRight
      }
    }
  }

  // The Todoist input's card, like the calculator's: the task as Todoist
  // will read it (title large), one chip per Quick Add token, and a status
  // line (the date hint, Adding…, Added, why it failed). Plain text only.
  // Drawn in this item, not a Loader's component, and the chips get all
  // they show from their model, so every name here resolves where it is.
  readonly property var todoistInfo: {
    if (!row.isTodoist)
      return ({})
    try {
      return JSON.parse(row.card || "{}")
    } catch (e) {
      return ({})
    }
  }
  // The host's type scale is an untyped QtObject (Style.font): read once.
  readonly property var hostFont: Style.font
  // A title that is help or a problem, not a task: smaller, and red for a problem.
  readonly property bool todoistHelp: row.isTodoist && row.todoistInfo.literal !== true
  readonly property var todoistStatus: row.todoistInfo.status || null
  readonly property var todoistChips: (row.todoistInfo.chips || []).map(function (chip) {
    return {
      label: String(chip.label || ""),
      color: chip.unknown ? row.look.tones.muted : (row.look.tokens[chip.kind] || row.look.foreground),
      family: row.look.fontFamily,
      size: Math.round(row.hostFont.bodySmall * row.zoom),
      fill: Util.alpha(row.look.foreground, 0.05),
      edge: Util.alpha(row.look.foreground, 0.12),
      radius: Math.max(Style.cornerRadius, row.px(4)),
      padX: row.px(14),
      padY: row.px(5)
    }
  })

  Rectangle {
    visible: row.isTodoist
    anchors.fill: parent
    radius: Math.max(Style.cornerRadius, row.px(6))
    color: row.selected ? row.look.selectedBackground : Util.alpha(row.look.foreground, 0.04)
    border.width: 1
    border.color: Util.alpha(row.look.foreground, row.selected ? 0 : 0.08)

    Column {
      id: todoistCard
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.leftMargin: row.px(16)
      anchors.rightMargin: row.px(16)
      anchors.verticalCenter: parent.verticalCenter
      spacing: row.px(7)

      Text {
        width: parent.width
        textFormat: Text.PlainText
        text: row.todoistInfo.title || ""
        color: row.todoistHelp && row.todoistInfo.state !== "empty" ? row.look.tones.error : row.look.foreground
        opacity: row.todoistInfo.state === "empty" ? 0.6 : 1
        font.family: row.look.fontFamily
        font.pixelSize: Math.round((row.todoistHelp ? row.hostFont.title : row.hostFont.heading * 1.3) * row.zoom)
        font.weight: row.todoistHelp ? Font.Normal : Font.DemiBold
        elide: Text.ElideRight
      }

      // The chips wrap onto more lines in a narrow window; the card grows.
      // A chip wider than the card (a long project name) is cut with "…".
      Flow {
        visible: row.todoistChips.length > 0
        width: parent.width
        spacing: row.px(6)
        Repeater {
          model: row.todoistChips
          Rectangle {
            id: chip
            required property var modelData
            height: chipText.implicitHeight + chip.modelData.padY
            width: Math.min(chipText.implicitWidth + chip.modelData.padX, chip.parent ? chip.parent.width : 0)
            radius: chip.modelData.radius
            color: chip.modelData.fill
            border.width: 1
            border.color: chip.modelData.edge
            Text {
              id: chipText
              anchors.centerIn: parent
              width: Math.min(implicitWidth, chip.width - chip.modelData.padX)
              elide: Text.ElideRight
              textFormat: Text.PlainText
              text: chip.modelData.label
              color: chip.modelData.color
              font.family: chip.modelData.family
              font.pixelSize: chip.modelData.size
            }
          }
        }
      }

      Row {
        visible: row.todoistStatus !== null
        width: parent.width
        spacing: row.px(6)
        // Spins while adding, unless motion is reduced.
        Text {
          id: spinner
          visible: row.todoistStatus !== null && row.todoistStatus.spinner === true
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: "\uf110"
          color: row.look.tones.accent
          font.family: row.look.fontFamily
          font.pixelSize: Math.round(row.hostFont.bodySmall * row.zoom)
          NumberAnimation on rotation {
            running: spinner.visible && !FoamyMotion.reduceMotion
            from: 0
            to: 360
            loops: Animation.Infinite
            duration: FoamyMotion.duration(900)
          }
        }
        Text {
          width: parent.width - (spinner.visible ? spinner.width + parent.spacing : 0)
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: row.todoistStatus ? row.todoistStatus.text : ""
          color: row.todoistStatus ? (row.look.tones[row.todoistStatus.tone] || row.look.foreground) : row.look.foreground
          font.family: row.look.fontFamily
          font.pixelSize: Math.round(row.hostFont.bodySmall * row.zoom)
          elide: Text.ElideRight
        }
      }
    }
  }

  Text {
    visible: row.isSection && row.title.length > 0
    textFormat: Text.PlainText
    anchors.left: parent.left
    anchors.leftMargin: row.px(12)
    anchors.bottom: parent.bottom
    anchors.bottomMargin: row.px(6)
    text: row.title
    color: row.look.foreground
    opacity: 0.5
    font.family: row.look.fontFamily
    font.pixelSize: Math.round(Style.font.caption * row.zoom)
    font.weight: Font.DemiBold
  }

  Rectangle {
    visible: !row.isSection && !row.isCalculator && !row.isTodoist
    anchors.fill: parent
    radius: Math.max(Style.cornerRadius, row.px(6))
    color: row.selected ? row.look.selectedBackground : "transparent"
    opacity: row.disabled ? 0.45 : 1

    Item {
      id: iconBox
      width: row.px(22)
      height: row.px(22)
      anchors.left: parent.left
      anchors.leftMargin: row.px(12)
      anchors.verticalCenter: parent.verticalCenter

      Image {
        id: rowIcon
        readonly property bool ownImage: row.image.length > 0 && !row.imageFailed
        readonly property string name: ownImage ? row.image : row.iconName
        anchors.fill: parent
        visible: name.length > 0 && (row.glyph.length === 0 || ownImage)
        fillMode: Image.PreserveAspectFit
        asynchronous: true
        sourceSize.width: width * Screen.devicePixelRatio
        sourceSize.height: height * Screen.devicePixelRatio
        source: !visible ? "" : (Scopes.imageUrl(name) || (row.appLibrary ? row.appLibrary.iconSource(name) : Quickshell.iconPath(name, "application-x-executable")))
        onStatusChanged: if (status === Image.Error && ownImage)
          row.imageFailed = true
      }

      Text {
        anchors.centerIn: parent
        visible: row.glyph.length > 0 && !rowIcon.visible
        textFormat: Text.PlainText
        text: row.glyph
        color: row.selected ? row.look.accent : row.look.foreground
        font.family: row.glyphFont || row.look.fontFamily
        font.pixelSize: row.glyphFont === "omarchy" ? row.px(14) : row.px(17)
      }
    }

    Row {
      id: accessories
      anchors.right: parent.right
      anchors.rightMargin: row.px(12)
      anchors.verticalCenter: parent.verticalCenter
      spacing: row.px(10)

      Rectangle {
        visible: row.alias.length > 0
        anchors.verticalCenter: parent.verticalCenter
        height: aliasText.implicitHeight + row.px(4)
        width: aliasText.implicitWidth + row.px(12)
        radius: row.px(4)
        color: "transparent"
        border.width: 1
        border.color: Util.alpha(row.look.foreground, 0.3)
        Text {
          id: aliasText
          anchors.centerIn: parent
          textFormat: Text.PlainText
          text: row.alias
          color: row.look.foreground
          opacity: 0.7
          font.family: row.look.fontFamily
          font.pixelSize: Math.round(Style.font.caption * row.zoom)
        }
      }

      Text {
        visible: row.favorite
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: "\uf005"
        color: row.look.accent
        opacity: 0.8
        font.family: row.look.fontFamily
        font.pixelSize: Math.round(Style.font.caption * row.zoom)
      }

      Text {
        visible: row.checked
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: "✓"
        color: row.look.accent
        font.family: row.look.fontFamily
        font.pixelSize: Math.round(Style.font.body * row.zoom)
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: row.typeLabel
        color: row.isSetting && row.selected ? row.look.accent : row.look.foreground
        opacity: row.isSetting ? 0.85 : 0.45
        font.family: row.look.fontFamily
        font.pixelSize: Math.round((row.isSetting ? Style.font.body : Style.font.bodySmall) * row.zoom)
      }
    }

    Row {
      anchors.left: iconBox.right
      anchors.leftMargin: row.px(10)
      anchors.right: accessories.left
      anchors.rightMargin: row.px(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: row.px(8)
      clip: true

      Text {
        id: titleText
        textFormat: Text.PlainText
        text: row.title
        color: row.look.foreground
        font.family: row.look.fontFamily
        font.pixelSize: Math.round(Style.font.title * row.zoom)
        elide: Text.ElideRight
        width: Math.min(implicitWidth, parent.width)
      }

      Text {
        textFormat: Text.PlainText
        text: row.subtitle
        visible: text.length > 0
        color: row.look.foreground
        opacity: 0.5
        font.family: row.look.fontFamily
        font.pixelSize: Math.round(Style.font.body * row.zoom)
        anchors.baseline: titleText.baseline
        elide: Text.ElideRight
        width: Math.max(0, Math.min(implicitWidth, parent.width - titleText.width - parent.spacing))
      }
    }
  }

  MouseArea {
    anchors.fill: parent
    enabled: !row.isSection
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onPositionChanged: function (mouse) {
      row.hovered(row.index, row, mouse)
    }
    onClicked: row.clicked(row.index)
  }
}
