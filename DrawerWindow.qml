import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "HostingModel.js" as HostingModel

// The Drawer: what clicking Omniplug's bar icon opens. A row of the widgets
// you stowed, live, wrapping into a grid, with Manage in the header.
//
// Adapted from Bar Drawer's Shelf.qml (SykesTheLord/omarchy-bar-drawer, MIT,
// Copyright (c) 2026 Sykes). The window deliberately spans from the screen
// edge across the bar: most widget panels are KeyboardPanels, which place
// themselves using the height (or width) of their anchor's window as "the
// bar", so a stowed widget's panel opens beyond this card instead of on top
// of it. Everything but the card is masked out, so the bar stays clickable.
PanelWindow {
  id: drawer

  property var port: null
  property var stage: null
  property Item anchorItem: null
  property bool open: false

  readonly property var barWindow: anchorItem ? anchorItem.QsWindow.window : null
  readonly property string barPos: port ? String(port.position || "top") : "top"
  readonly property bool vertical: barPos === "left" || barPos === "right"
  readonly property real barExtent: barWindow ? (vertical ? barWindow.width : barWindow.height) : 0
  readonly property int gap: Style.gapsOut
  readonly property int margin: Style.gapsOut
  readonly property real maxContentExtent: Style.space(420)
  readonly property real cardWidth: Math.ceil(content.implicitWidth + card.contentLeftInset + card.contentRightInset)
  readonly property real cardHeight: Math.ceil(content.implicitHeight + card.contentTopInset + card.contentBottomInset)
  // Hovered placeholder, for the reason line.
  property var hoveredMount: null

  signal dismissed()
  signal manageRequested()

  screen: barWindow ? barWindow.screen : null
  visible: open || card.opacity > 0
  color: "transparent"
  exclusionMode: ExclusionMode.Ignore

  WlrLayershell.namespace: "omniplug-drawer"
  WlrLayershell.layer: WlrLayer.Top
  WlrLayershell.keyboardFocus: WlrKeyboardFocus.None

  anchors {
    top: barPos === "top" || vertical
    bottom: barPos === "bottom" || vertical
    left: barPos === "left" || !vertical
    right: barPos === "right" || !vertical
  }

  implicitWidth: vertical ? Math.max(1, barExtent + gap + cardWidth) : 0
  implicitHeight: vertical ? 0 : Math.max(1, barExtent + gap + cardHeight)

  mask: Region { item: card }

  function ownsTarget(target) {
    return !!target && HostingModel.hostingIsDescendant(target, content)
  }

  // An outside click closes the drawer, except while one of its widgets has
  // its own panel open: that panel takes the pointer, which is not "outside".
  HyprlandFocusGrab {
    active: drawer.open && !(drawer.stage && drawer.stage.childPanelOpen)
    windows: drawer.barWindow ? [drawer, drawer.barWindow] : [drawer]
    onCleared: if (!(drawer.stage && drawer.stage.childPanelOpen)) drawer.dismissed()
  }

  // mapToItem is a one-shot; the watcher keeps the card under the icon when
  // neighbouring widgets resize.
  TransformWatcher {
    id: anchorWatcher
    a: drawer.barWindow ? drawer.barWindow.contentItem : null
    b: drawer.anchorItem
  }

  readonly property point anchorPos: {
    anchorWatcher.transform
    if (!anchorItem || !barWindow) return Qt.point(0, 0)
    return anchorItem.mapToItem(barWindow.contentItem, 0, 0)
  }

  function clamp(value, low, high) { return Math.max(low, Math.min(high, value)) }

  BorderSurface {
    id: card

    width: drawer.cardWidth
    height: drawer.cardHeight
    x: {
      if (drawer.barPos === "left") return drawer.barExtent + drawer.gap
      if (drawer.barPos === "right") return 0
      var centred = drawer.anchorPos.x + (drawer.anchorItem ? drawer.anchorItem.width : 0) / 2 - width / 2
      return Math.round(drawer.clamp(centred, drawer.margin, Math.max(drawer.margin, drawer.width - width - drawer.margin)))
    }
    y: {
      if (drawer.barPos === "top") return drawer.barExtent + drawer.gap
      if (drawer.barPos === "bottom") return 0
      var centred = drawer.anchorPos.y + (drawer.anchorItem ? drawer.anchorItem.height : 0) / 2 - height / 2
      return Math.round(drawer.clamp(centred, drawer.margin, Math.max(drawer.margin, drawer.height - height - drawer.margin)))
    }
    color: Color.popups.background
    borderSpec: Border.surfaceSpec("popups", "border", Color.popups.border, Math.max(1, Style.space(2)))
    padding: Style.spacing.sm
    radius: Style.cornerRadius
    opacity: drawer.open ? 1 : 0

    Behavior on opacity {
      NumberAnimation { duration: 140; easing.type: Easing.OutCubic }
    }

    Column {
      id: content
      // Hidden children fail the bar's clickability check, so a closed drawer
      // can never swallow a click meant for the bar.
      visible: drawer.open || card.opacity > 0
      x: card.contentLeftInset
      y: card.contentTopInset
      spacing: Style.space(8)

      Item {
        id: header
        width: Math.max(implicitWidth, tiles.width)
        implicitWidth: titleRow.implicitWidth + Style.space(16) + manageButton.implicitWidth
        implicitHeight: Math.max(titleRow.implicitHeight, manageButton.implicitHeight)

        Row {
          id: titleRow
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(6)

          Text {
            textFormat: Text.PlainText
            text: "󰐱"
            color: Color.popups.text
            font.family: drawer.port && drawer.port.fontFamily ? drawer.port.fontFamily : Style.font.family
            font.pixelSize: Style.font.body
          }

          Text {
            textFormat: Text.PlainText
            text: "Drawer"
            color: Color.popups.text
            font.family: drawer.port && drawer.port.fontFamily ? drawer.port.fontFamily : Style.font.family
            font.pixelSize: Style.font.body
            font.bold: true
          }
        }

        Button {
          id: manageButton
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          text: "Manage"
          iconText: "󰒓"
          tooltipText: "Install, update, and arrange plugins"
          foreground: Color.popups.text
          fontFamily: drawer.port && drawer.port.fontFamily ? drawer.port.fontFamily : Style.font.family
          onClicked: drawer.manageRequested()
        }
      }

      Flow {
        id: tiles
        readonly property real naturalExtent: {
          var total = 0
          for (var i = 0; i < mounts.count; i++) {
            var mount = mounts.itemAt(i)
            if (mount) total += (drawer.vertical ? mount.implicitHeight : mount.implicitWidth) + spacing
          }
          return Math.max(0, total - spacing)
        }
        width: drawer.vertical ? implicitWidth : Math.min(drawer.maxContentExtent, Math.max(header.implicitWidth, naturalExtent))
        height: drawer.vertical ? Math.min(drawer.maxContentExtent, naturalExtent) : implicitHeight
        flow: drawer.vertical ? Flow.TopToBottom : Flow.LeftToRight
        spacing: Style.space(4)
        visible: mounts.count > 0

        Repeater {
          id: mounts
          model: drawer.stage ? drawer.stage.tiles : []

          HostMount {
            id: tileMount
            required property var modelData
            stage: drawer.stage
            key: modelData.key
            foreground: Color.popups.text
            secondaryForeground: Util.alpha(Color.popups.text, 0.54)
            fontFamily: drawer.port && drawer.port.fontFamily ? drawer.port.fontFamily : Style.font.family
            fontSize: Style.font.body
            onHoveredChanged: {
              if (tileMount.hovered && tileMount.placeholder) drawer.hoveredMount = tileMount
              else if (drawer.hoveredMount === tileMount) drawer.hoveredMount = null
            }
          }
        }
      }

      Text {
        id: note
        width: Math.max(header.width, tiles.width)
        wrapMode: Text.Wrap
        textFormat: Text.PlainText
        visible: text !== ""
        text: {
          if (drawer.hoveredMount && drawer.hoveredMount.reasonText) return drawer.hoveredMount.reasonText
          var problem = drawer.stage ? drawer.stage.hostProblem : ""
          if (mounts.count === 0) return "Nothing stowed yet. In Manage, open Arrange and drag widgets into the Drawer."
          if (problem === "searching") return "Looking for the bar…"
          if (problem !== "") return HostingModel.hostingReasonText("no-host")
            + (drawer.port && drawer.port.problem ? " " + drawer.port.problem : "")
          return ""
        }
        color: Util.alpha(Color.popups.text, 0.54)
        font.family: drawer.port && drawer.port.fontFamily ? drawer.port.fontFamily : Style.font.family
        font.pixelSize: Style.font.caption
      }
    }
  }

  // The bar only draws tooltips for targets in its own window, so widgets
  // living here get theirs from this copy of the bar's tooltip state.
  PopupWindow {
    id: tooltipWindow

    readonly property var target: drawer.port ? drawer.port.tooltipTarget : null
    readonly property string text: drawer.port ? drawer.port.tooltipText : ""

    visible: drawer.open && !!drawer.port && drawer.port.tooltipShown
      && text !== "" && drawer.ownsTarget(target)
    color: "transparent"
    implicitWidth: Math.ceil(bubble.implicitWidth)
    implicitHeight: Math.ceil(bubble.implicitHeight)

    onTargetChanged: if (visible) anchor.updateAnchor()
    onVisibleChanged: if (visible) anchor.updateAnchor()

    anchor {
      window: drawer
      adjustment: PopupAdjustment.Slide
      edges: Edges.Top | Edges.Left
      gravity: Edges.Bottom | Edges.Right
      rect.width: 1
      rect.height: 1

      onAnchoring: {
        var target = tooltipWindow.target
        if (!target || !drawer.contentItem) return
        var gapPx = Style.space(4)
        var point = target.mapToItem(drawer.contentItem, 0, 0)
        var x = point.x + target.width / 2 - tooltipWindow.implicitWidth / 2
        var y = point.y + target.height + gapPx
        if (drawer.barPos === "bottom") y = point.y - tooltipWindow.implicitHeight - gapPx
        if (drawer.barPos === "left") {
          x = point.x + target.width + gapPx
          y = point.y + target.height / 2 - tooltipWindow.implicitHeight / 2
        } else if (drawer.barPos === "right") {
          x = point.x - tooltipWindow.implicitWidth - gapPx
          y = point.y + target.height / 2 - tooltipWindow.implicitHeight / 2
        }
        tooltipWindow.anchor.rect.x = Math.round(x)
        tooltipWindow.anchor.rect.y = Math.round(y)
      }
    }

    Rectangle {
      id: bubble
      anchors.fill: parent
      implicitWidth: tooltipLabel.implicitWidth + Style.spacing.lg * 2
      implicitHeight: tooltipLabel.implicitHeight + Style.spacing.sm * 2
      color: Color.tooltip.background
      border.color: Color.tooltip.border
      border.width: 1
      radius: Style.cornerRadius

      Text {
        id: tooltipLabel
        anchors.centerIn: parent
        text: tooltipWindow.text
        color: Color.tooltip.text
        font.family: drawer.port && drawer.port.fontFamily ? drawer.port.fontFamily : Style.font.family
        font.pixelSize: Style.font.body
        textFormat: Text.PlainText
      }
    }
  }
}
