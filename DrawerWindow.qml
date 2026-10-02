import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "Placement.js" as Placement

// The Drawer: what clicking Omniplug's bar icon opens, and where stacks are
// built (docs/design/m2-stacks.md). A strip of what is on the bar, then each
// stack with its cards as rows of chips. Drag a chip from the strip into a
// card or onto "+ New card", between cards, or back to the strip. Every drop
// and every button is one Placement intent, sent through `changeRequested`;
// this window never writes anything itself.
//
// The window placement is adapted from Bar Drawer's Shelf.qml
// (SykesTheLord/omarchy-bar-drawer, MIT, Copyright (c) 2026 Sykes): it spans
// from the screen edge across the bar to the far side of the card, and
// everything but the card is masked out, so the bar stays clickable.
PanelWindow {
  id: drawer

  property var port: null
  property string selfId: ""
  // Placement's board, read with the plugin list's facts when it has them.
  property var board: null
  // id → display name.
  property var labelFor: function(id) { return String(id) }
  property Item anchorItem: null
  property bool open: false
  // The last answer from Placement's owner, and whether a change is in flight.
  property var ticket: null
  property bool busy: false

  signal dismissed()
  signal manageRequested()
  signal changeRequested(var intent)

  readonly property var barWindow: anchorItem ? anchorItem.QsWindow.window : null
  readonly property string barPos: port ? String(port.position || "top") : "top"
  readonly property bool vertical: barPos === "left" || barPos === "right"
  readonly property real barExtent: barWindow ? (vertical ? barWindow.width : barWindow.height) : 0
  readonly property int gap: Style.gapsOut
  readonly property int margin: Style.gapsOut
  readonly property real contentWidth: Style.space(380)
  readonly property real maxContentHeight: drawer.screen ? Math.round(drawer.screen.height * 0.7) : Style.space(520)
  readonly property real cardWidth: Math.ceil(drawer.contentWidth + card.contentLeftInset + card.contentRightInset)
  readonly property real cardHeight: Math.ceil(content.height + card.contentTopInset + card.contentBottomInset)
  readonly property bool editable: !!drawer.board && drawer.board.canStow && !drawer.busy
  readonly property string fontFamily: drawer.port && drawer.port.fontFamily ? drawer.port.fontFamily : Style.font.family
  readonly property color text: Color.popups.text
  readonly property color muted: Util.alpha(Color.popups.text, 0.54)

  screen: barWindow ? barWindow.screen : null
  visible: open || card.opacity > 0
  color: "transparent"
  exclusionMode: ExclusionMode.Ignore

  WlrLayershell.namespace: "omniplug-drawer"
  WlrLayershell.layer: WlrLayer.Top
  WlrLayershell.keyboardFocus: drawer.open ? WlrKeyboardFocus.OnDemand : WlrKeyboardFocus.None

  anchors {
    top: barPos === "top" || vertical
    bottom: barPos === "bottom" || vertical
    left: barPos === "left" || !vertical
    right: barPos === "right" || !vertical
  }

  implicitWidth: vertical ? Math.max(1, barExtent + gap + cardWidth) : 0
  implicitHeight: vertical ? 0 : Math.max(1, barExtent + gap + cardHeight)

  mask: Region { item: card }

  HyprlandFocusGrab {
    active: drawer.open
    windows: drawer.barWindow ? [drawer, drawer.barWindow] : [drawer]
    onCleared: drawer.dismissed()
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

  // ---- Intents -----------------------------------------------------------

  function send(intent) {
    if (!drawer.editable) return
    drawer.changeRequested(intent)
  }

  // A chip dropped on a target. `source` is { id, from }; `target` is
  // { kind: "bar", zone } | { kind: "card", stack, card } and `gap` is the
  // slot it landed in, counted before the source is removed.
  function drop(source, target, gap) {
    if (!source || !target || !drawer.board) return
    var intent = { id: source.id, from: source.from, key: drawer.board.key }
    if (target.kind === "bar") {
      if (source.from.zone !== "stack") return // reordering the bar is Arrange's job
      intent.to = target.zone
      intent.gap = gap
    } else {
      intent.to = "stack"
      intent.stack = target.stack
      intent.card = target.card
      if (gap >= 0) intent.gap = gap
    }
    drawer.send(intent)
  }

  function stackTitle(stack) {
    return Placement.placementStackLabel(stack.sid) + (stack.zone ? " · " + stack.zone : "")
  }

  // ---- Dragging ------------------------------------------------------------

  // { id, from, label } while a chip is held past the start distance.
  property var held: null
  property point pointer: Qt.point(0, 0)
  property var hoverTarget: null
  property var dropTargets: []

  function registerTarget(item) { if (drawer.dropTargets.indexOf(item) < 0) drawer.dropTargets = drawer.dropTargets.concat([item]) }
  function unregisterTarget(item) { drawer.dropTargets = drawer.dropTargets.filter(function(t) { return t !== item }) }

  function targetAt(point) {
    for (var i = 0; i < drawer.dropTargets.length; i++) {
      var item = drawer.dropTargets[i]
      if (!item || !item.visible) continue
      var p = item.mapFromItem(dragLayer, point.x, point.y)
      if (p.x >= 0 && p.y >= 0 && p.x < item.width && p.y < item.height) return item
    }
    return null
  }

  // The insertion slot in a target's flow of chips, reading order: before
  // the first chip whose centre is past the pointer.
  function gapIn(item, point) {
    var flow = item.chipFlow
    if (!flow) return -1
    var p = flow.mapFromItem(dragLayer, point.x, point.y)
    var gap = 0
    for (var i = 0; i < flow.children.length; i++) {
      var chip = flow.children[i]
      if (!chip || chip.isChip !== true) continue
      var before = chip.y + chip.height < p.y || (p.y >= chip.y && chip.x + chip.width / 2 < p.x)
      if (before) gap = chip.chipIndex + 1
    }
    return gap
  }

  function cancelDrag() { drawer.held = null; drawer.hoverTarget = null }
  onOpenChanged: if (!open) cancelDrag()
  onBoardChanged: cancelDrag()

  // ---- Pieces --------------------------------------------------------------

  component Caption: Text {
    textFormat: Text.PlainText
    color: drawer.muted
    font.family: drawer.fontFamily
    font.pixelSize: Style.font.caption
    elide: Text.ElideRight
  }

  component Chip: Rectangle {
    id: chip
    required property var slot
    required property int chipIndex
    // What a drag of this chip moves, or null when it cannot be dragged.
    property var from: null
    readonly property bool isChip: true
    readonly property bool missing: chip.slot.state === "missing"
    readonly property bool off: chip.slot.state === "off"
    readonly property bool draggable: chip.from !== null && drawer.editable
    readonly property string label: drawer.labelFor(chip.slot.id)

    implicitWidth: chipRow.implicitWidth + Style.space(12)
    implicitHeight: chipRow.implicitHeight + Style.space(6)
    radius: Math.min(Style.cornerRadius, height / 2)
    color: Util.alpha(drawer.text, chip.draggable && chipMouse.containsMouse ? 0.16 : 0.08)
    border.color: Util.alpha(drawer.text, 0.18)
    opacity: drawer.held && drawer.held.chip === chip ? 0.35 : chip.off ? 0.6 : 1

    Row {
      id: chipRow
      anchors.centerIn: parent
      spacing: Style.space(4)
      Text {
        textFormat: Text.PlainText
        text: (chip.missing ? "⚠ " : "") + chip.label + (chip.off ? " (off)" : "")
        color: drawer.text
        font.family: drawer.fontFamily
        font.pixelSize: Style.font.caption
      }
      Text {
        id: removeMark
        visible: chip.missing && chip.from !== null && chip.from.zone === "stack"
        textFormat: Text.PlainText
        text: "✕"
        color: drawer.muted
        font.family: drawer.fontFamily
        font.pixelSize: Style.font.caption
      }
    }

    MouseArea {
      id: chipMouse
      anchors.fill: parent
      hoverEnabled: true
      preventStealing: true
      enabled: chip.from !== null
      cursorShape: chip.draggable ? Qt.OpenHandCursor : Qt.ArrowCursor
      property point pressPoint: Qt.point(0, 0)
      property bool armed: false

      onPressed: function(mouse) {
        armed = chip.draggable
        pressPoint = mapToItem(dragLayer, mouse.x, mouse.y)
      }
      onPositionChanged: function(mouse) {
        if (!armed) return
        var point = mapToItem(dragLayer, mouse.x, mouse.y)
        if (!drawer.held && Math.hypot(point.x - pressPoint.x, point.y - pressPoint.y) >= Qt.styleHints.startDragDistance)
          drawer.held = { chip: chip, id: chip.slot.id, from: chip.from, label: chip.label }
        if (drawer.held) {
          drawer.pointer = point
          drawer.hoverTarget = drawer.targetAt(point)
        }
      }
      onReleased: function(mouse) {
        var point = mapToItem(dragLayer, mouse.x, mouse.y)
        var held = drawer.held
        armed = false
        if (!held) {
          // A click on a placeholder in a stack removes it.
          if (removeMark.visible && drawer.editable)
            drawer.send({ id: chip.slot.id, to: "remove", from: chip.from, key: drawer.board.key })
          return
        }
        var target = drawer.targetAt(point)
        var gap = target ? drawer.gapIn(target, point) : -1
        drawer.cancelDrag()
        if (target) drawer.drop(held, target.dropInfo, gap)
      }
      onCanceled: { armed = false; drawer.cancelDrag() }
    }
  }

  // A row that takes drops: a bar section or a card.
  component DropRow: Rectangle {
    id: row
    property var dropInfo: null
    property alias chipFlow: flow
    property alias chips: chipRepeater.model
    property var fromFor: function(index) { return null }
    property string emptyText: ""
    readonly property bool hot: !!drawer.held && drawer.hoverTarget === row

    width: parent ? parent.width : 0
    implicitHeight: Math.max(flow.implicitHeight, emptyLabel.implicitHeight) + Style.space(10)
    radius: Style.cornerRadius / 2
    color: row.hot ? Util.alpha(Color.accent, 0.14) : Util.alpha(drawer.text, 0.04)
    border.color: row.hot ? Color.accent : Util.alpha(drawer.text, 0.12)

    Component.onCompleted: drawer.registerTarget(row)
    Component.onDestruction: drawer.unregisterTarget(row)

    Flow {
      id: flow
      x: Style.space(5)
      y: Style.space(5)
      width: row.width - Style.space(10)
      spacing: Style.space(4)
      Repeater {
        id: chipRepeater
        Chip {
          required property var modelData
          required property int index
          slot: modelData
          chipIndex: index
          from: row.fromFor(index)
        }
      }
    }
    Caption {
      id: emptyLabel
      anchors.centerIn: parent
      visible: chipRepeater.count === 0 && text !== ""
      text: row.emptyText
    }
  }

  // ---- The card ------------------------------------------------------------

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

    Item {
      id: dragLayer
      x: card.contentLeftInset
      y: card.contentTopInset
      width: drawer.contentWidth
      height: content.height
      focus: drawer.open
      Keys.onEscapePressed: function(event) {
        if (drawer.held) drawer.cancelDrag()
        else drawer.dismissed()
        event.accepted = true
      }

      Column {
        id: content
        visible: drawer.open || card.opacity > 0
        width: parent.width
        spacing: Style.space(8)

        Item {
          id: header
          width: parent.width
          height: Math.max(titleRow.implicitHeight, buttons.implicitHeight)

          Row {
            id: titleRow
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(6)
            Text {
              textFormat: Text.PlainText
              text: "󰐱"
              color: drawer.text
              font.family: drawer.fontFamily
              font.pixelSize: Style.font.body
            }
            Text {
              textFormat: Text.PlainText
              text: "Stacks"
              color: drawer.text
              font.family: drawer.fontFamily
              font.pixelSize: Style.font.body
              font.bold: true
            }
          }

          Row {
            id: buttons
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(4)
            Button {
              text: "New stack"
              iconText: "󰐕"
              tooltipText: "Add an empty stack at the end of the right section"
              enabled: drawer.editable
              opacity: enabled ? 1 : 0.5
              foreground: drawer.text
              fontFamily: drawer.fontFamily
              onClicked: drawer.send({ op: "newStack" })
            }
            Button {
              text: "Manage"
              iconText: "󰒓"
              tooltipText: "Install, update, and arrange plugins"
              foreground: drawer.text
              fontFamily: drawer.fontFamily
              onClicked: drawer.manageRequested()
            }
          }
        }

        Flickable {
          id: scroller
          width: parent.width
          height: Math.min(sections.implicitHeight, drawer.maxContentHeight)
          contentWidth: width
          contentHeight: sections.implicitHeight
          clip: true
          interactive: !drawer.held
          boundsBehavior: Flickable.StopAtBounds

          Column {
            id: sections
            width: scroller.width
            spacing: Style.space(10)

            Caption {
              width: parent.width
              text: "ON THE BAR"
              font.bold: true
            }

            Repeater {
              model: drawer.board ? ["left", "center", "right"] : []

              Column {
                id: section
                required property string modelData
                width: sections.width
                spacing: Style.space(3)
                // Only stackable entries can be dragged: not Omniplug or its
                // stacks, not custom modules.
                readonly property var slots: drawer.board.zones[section.modelData]
                Caption { text: section.modelData.toUpperCase() }
                DropRow {
                  dropInfo: ({ kind: "bar", zone: section.modelData })
                  chips: section.slots
                  emptyText: "Empty"
                  fromFor: function(index) {
                    var slot = section.slots[index]
                    if (!slot || slot.custom || slot.stack || slot.id === drawer.selfId) return null
                    return { zone: section.modelData, index: index }
                  }
                }
              }
            }

            Repeater {
              model: drawer.board ? drawer.board.stacks : []

              Column {
                id: stackBlock
                required property var modelData
                readonly property var stack: stackBlock.modelData
                width: sections.width
                spacing: Style.space(4)

                Item {
                  width: parent.width
                  height: Math.max(stackName.implicitHeight, stackButtons.implicitHeight)
                  Text {
                    id: stackName
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: drawer.stackTitle(stackBlock.stack)
                    color: drawer.text
                    font.family: drawer.fontFamily
                    font.pixelSize: Style.font.body
                    font.bold: true
                  }
                  Row {
                    id: stackButtons
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Style.space(2)
                    Button {
                      iconText: "󰍴"
                      tooltipText: "Narrower"
                      enabled: drawer.editable && stackBlock.stack.width > Placement.PLACEMENT_MIN_WIDTH
                      opacity: enabled ? 1 : 0.5
                      foreground: drawer.text
                      fontFamily: drawer.fontFamily
                      onClicked: drawer.send({ op: "stackSettings", stack: stackBlock.stack.sid,
                        width: stackBlock.stack.width - 20 })
                    }
                    Caption {
                      anchors.verticalCenter: parent.verticalCenter
                      text: stackBlock.stack.width + " px"
                      color: drawer.text
                    }
                    Button {
                      iconText: "󰐕"
                      tooltipText: "Wider"
                      enabled: drawer.editable && stackBlock.stack.width < Placement.PLACEMENT_MAX_WIDTH
                      opacity: enabled ? 1 : 0.5
                      foreground: drawer.text
                      fontFamily: drawer.fontFamily
                      onClicked: drawer.send({ op: "stackSettings", stack: stackBlock.stack.sid,
                        width: stackBlock.stack.width + 20 })
                    }
                    Button {
                      iconText: stackBlock.stack.dots ? "󰇘" : "󰇙"
                      tooltipText: stackBlock.stack.dots ? "Hide the card dots" : "Show the card dots"
                      enabled: drawer.editable
                      opacity: enabled ? 1 : 0.5
                      selected: stackBlock.stack.dots
                      foreground: drawer.text
                      fontFamily: drawer.fontFamily
                      onClicked: drawer.send({ op: "stackSettings", stack: stackBlock.stack.sid,
                        dots: !stackBlock.stack.dots })
                    }
                    Button {
                      iconText: "󰆴"
                      tooltipText: "Delete the stack and put its widgets back on the bar"
                      enabled: drawer.editable
                      opacity: enabled ? 1 : 0.5
                      foreground: drawer.text
                      fontFamily: drawer.fontFamily
                      onClicked: drawer.send({ op: "deleteStack", stack: stackBlock.stack.sid })
                    }
                  }
                }

                Repeater {
                  model: stackBlock.stack.cards

                  DropRow {
                    id: cardRow
                    required property var modelData
                    required property int index
                    dropInfo: ({ kind: "card", stack: stackBlock.stack.sid, card: cardRow.index })
                    chips: cardRow.modelData
                    fromFor: function(i) {
                      return { zone: "stack", stack: stackBlock.stack.sid, card: cardRow.index, index: i }
                    }
                  }
                }

                DropRow {
                  dropInfo: ({ kind: "card", stack: stackBlock.stack.sid, card: stackBlock.stack.cards.length })
                  chips: []
                  emptyText: stackBlock.stack.cards.length === 0
                    ? "Drop a widget here for the first card" : "+ New card"
                }
              }
            }

            Repeater {
              model: drawer.board ? drawer.board.orphans : []

              Item {
                id: orphan
                required property var modelData
                width: sections.width
                height: Math.max(orphanName.implicitHeight, orphanDelete.implicitHeight)
                Caption {
                  id: orphanName
                  anchors.left: parent.left
                  anchors.verticalCenter: parent.verticalCenter
                  width: parent.width - orphanDelete.width - Style.space(8)
                  text: Placement.placementStackLabel(orphan.modelData.sid) + " is not on the bar ("
                    + orphan.modelData.cards.length + " cards)"
                }
                Button {
                  id: orphanDelete
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  text: "Delete"
                  tooltipText: "Delete it and put its widgets at the end of the right section"
                  enabled: drawer.editable
                  foreground: drawer.text
                  fontFamily: drawer.fontFamily
                  onClicked: drawer.send({ op: "deleteStack", stack: orphan.modelData.sid })
                }
              }
            }
          }
        }

        Caption {
          id: status
          width: parent.width
          wrapMode: Text.Wrap
          elide: Text.ElideNone
          text: {
            if (!drawer.board) return "Omniplug cannot read the shell config right now."
            if (drawer.busy) return "Saving…"
            if (drawer.ticket && drawer.ticket.note) return drawer.ticket.note
            if (drawer.board.reason === "unreadable") return "Loading the plugin list…"
            if (drawer.board.reason === "needsBarAccess") return Placement.PLACEMENT_NOTES.needsBarAccess
            if (drawer.board.stacks.length === 0) return "Make a stack, then drag widgets from the bar into it."
            return "Drag widgets between the bar and the cards. Scroll over a stack on the bar to flip its cards."
          }
          color: drawer.ticket && drawer.ticket.ok === false ? Color.urgent : drawer.muted
        }
      }

      // The held chip, under the pointer.
      Rectangle {
        visible: !!drawer.held
        x: drawer.pointer.x + Style.space(6)
        y: drawer.pointer.y + Style.space(6)
        width: ghostLabel.implicitWidth + Style.space(12)
        height: ghostLabel.implicitHeight + Style.space(6)
        radius: Math.min(Style.cornerRadius, height / 2)
        color: Color.popups.background
        border.color: Color.accent
        Text {
          id: ghostLabel
          anchors.centerIn: parent
          textFormat: Text.PlainText
          text: drawer.held ? drawer.held.label : ""
          color: drawer.text
          font.family: drawer.fontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }
}
