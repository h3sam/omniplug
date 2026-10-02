import QtQuick
import qs.Commons
import "HostingModel.js" as HostingModel
import "Placement.js" as Placement
import "StackMemory.js" as StackMemory

// One stack on the bar: a fixed width showing one card (a row of widgets) at
// a time. The wheel flips to the next card, wrapping around; a card wider
// than the stack fans out while hovered, growing the stack and pushing its
// neighbours aside. See docs/design/m2-stacks.md.
//
// The stack lives in the bar's own window, so the widgets it hosts get the
// bar's clicks, tooltips and popup placement exactly as they would in their
// own slots. Hosting is the M1 HostStage with holdsPopout off: a stack never
// owns the bar's popout, it only shows widgets that may.
Item {
  id: stack

  // Omniplug's BarWidget for this entry: its `bar` is the facade, and its
  // window is where the port looks for the Bar root.
  required property Item owner
  // LiveBarPort in the shell; FakeBarPort in tests.
  required property var port
  // The whole shell config, from LiveShellConfig (null without the Bar root).
  property var config: null
  property string selfId: ""
  property string sid: ""
  property string screenName: ""

  readonly property var board: stack.config
    ? Placement.placementBoard(stack.config, { selfId: stack.selfId, plugins: null, canCross: true }) : null
  readonly property var definition: {
    var stacks = stack.board ? stack.board.stacks : []
    for (var i = 0; i < stacks.length; i++) if (stacks[i].sid === stack.sid) return stacks[i]
    return null
  }
  readonly property var cards: HostingModel.hostingStackCards(stack.definition)
  property int requested: StackMemory.get(stack.screenName, stack.sid)
  readonly property int current: HostingModel.hostingWrap(stack.requested, 0, stack.cards.length)
  readonly property var card: stack.cards.length > 0 ? stack.cards[stack.current] : []

  readonly property bool vertical: !!stack.port && stack.port.vertical
  readonly property int barSize: stack.port && stack.port.barSize > 0 ? stack.port.barSize : Style.bar.sizeHorizontal
  readonly property real fixedExtent: stack.definition ? stack.definition.width : Placement.PLACEMENT_DEFAULT_WIDTH
  readonly property real naturalExtent: stack.vertical ? row.implicitHeight : row.implicitWidth
  // The flip strip at the trailing end: room that is always the wheel's, and
  // the card indicator. On every stack with a card, so they all look alike;
  // a single circle says there is nothing to flip to.
  readonly property real handleExtent: stack.cards.length > 0 ? Style.space(12) : 0
  readonly property bool wide: stack.naturalExtent + stack.handleExtent > stack.fixedExtent
  property bool fanned: false
  readonly property real targetExtent: HostingModel.hostingStackExtent({
    hasCards: stack.cards.length > 0, fixed: stack.fixedExtent, natural: stack.naturalExtent,
    handle: stack.handleExtent, fanned: stack.fanned, emptyExtent: emptyIcon.implicitWidth + Style.space(8)
  })
  property real extent: stack.targetExtent
  Behavior on extent {
    NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
  }

  readonly property color foreground: stack.owner && stack.owner.bar && stack.owner.bar.barForeground !== undefined
    ? stack.owner.bar.barForeground : Color.foreground

  implicitWidth: stack.vertical ? stack.barSize : Math.ceil(stack.extent)
  implicitHeight: stack.vertical ? Math.ceil(stack.extent) : stack.barSize
  clip: true

  function flip(step) {
    if (stack.cards.length < 2 || step === 0) return
    stack.requested = HostingModel.hostingWrap(stack.current, step, stack.cards.length)
    StackMemory.set(stack.screenName, stack.sid, stack.requested)
    // The new card slides in a little from the side it came from.
    slideIn.from = step > 0 ? Style.space(10) : -Style.space(10)
    slideIn.restart()
    fadeIn.restart()
  }

  // Where the card sits along the bar during the slide, and how faded.
  property real slide: 0
  NumberAnimation { id: slideIn; target: stack; property: "slide"; to: 0; duration: 160; easing.type: Easing.OutCubic }
  NumberAnimation { id: fadeIn; target: viewport; property: "opacity"; from: 0.25; to: 1; duration: 160; easing.type: Easing.OutCubic }

  readonly property var stage: hostStage

  HostStage {
    id: hostStage
    owner: stack.owner
    port: stack.port
    selfId: stack.selfId
    entries: HostingModel.hostingStackEntries(stack.definition)
    shown: stack.visible
    holdsPopout: false
  }

  // Hovering fans a wide card out; it folds back a moment after the pointer
  // leaves, but never while one of its widgets has its popup open, so that
  // popup's anchor stays where it is.
  HoverHandler { id: hover }
  readonly property bool holding: hover.hovered || hostStage.childPanelOpen
  onHoldingChanged: {
    if (stack.holding) { collapse.stop(); stack.fanned = true }
    else collapse.restart()
  }
  Timer {
    id: collapse
    interval: 300
    onTriggered: stack.fanned = false
  }

  // Below the widgets: the wheel reaches it only when the widget under the
  // pointer does not use the wheel itself (a volume widget keeps its scroll).
  // Left clicks belong to the bar's own slot handler, which finds the hosted
  // widget's click target under the pointer.
  MouseArea {
    anchors.fill: parent
    acceptedButtons: Qt.NoButton
    property real rest: 0
    onWheel: function(wheel) {
      var delta = stack.vertical && wheel.angleDelta.y === 0 ? wheel.angleDelta.x : wheel.angleDelta.y
      if (delta === 0) delta = wheel.pixelDelta.y
      var result = HostingModel.hostingWheelStep(rest, delta)
      rest = result.rest
      stack.flip(result.step)
      wheel.accepted = true
    }
  }

  // The showing card. At rest a wide card starts at the stack's leading edge
  // and is clipped; a narrow one is centred in the fixed width.
  Item {
    id: viewport
    // Everything but the flip strip; a wide card is clipped here, not under it.
    x: 0
    y: 0
    width: stack.vertical ? stack.width : Math.max(0, stack.width - stack.handleExtent)
    height: stack.vertical ? Math.max(0, stack.height - stack.handleExtent) : stack.height
    clip: true

    Grid {
      id: row
      objectName: "card"
      // One line of at most PLACEMENT_MAX_CARD widgets, across or down.
      rows: stack.vertical ? Placement.PLACEMENT_MAX_CARD : 1
      columns: stack.vertical ? 1 : Placement.PLACEMENT_MAX_CARD
      flow: stack.vertical ? Grid.TopToBottom : Grid.LeftToRight
      spacing: 0
      x: stack.vertical ? Math.round((viewport.width - width) / 2)
        : Math.round(Math.max(0, (viewport.width - width) / 2) + stack.slide)
      y: stack.vertical ? Math.round(Math.max(0, (viewport.height - height) / 2) + stack.slide)
        : Math.round((viewport.height - height) / 2)

      Repeater {
        model: stack.card

        HostMount {
          required property var modelData
          // Not `stage: stage`: inside HostMount that binds the property to itself.
          stage: hostStage
          key: modelData.id + "#0"
          foreground: stack.foreground
          secondaryForeground: Util.alpha(stack.foreground, 0.54)
          fontFamily: stack.port && stack.port.fontFamily ? stack.port.fontFamily : Style.font.family
          fontSize: Style.font.body
        }
      }
    }
  }

  // An empty stack still shows something, so it can be found on the bar.
  Text {
    id: emptyIcon
    anchors.centerIn: parent
    visible: stack.cards.length === 0
    textFormat: Text.PlainText
    text: "󰆼"
    color: Util.alpha(stack.foreground, 0.4)
    font.family: stack.port && stack.port.fontFamily ? stack.port.fontFamily : Style.font.family
    font.pixelSize: Style.font.body
  }

  // The flip strip: one circle per card, stacked across the bar's thickness
  // at the trailing end, the showing card's drawn as a pill twice as long and
  // brightest, so it reads even while the strip is dim. Dim until hovered, so
  // it says "scroll here" without shouting.
  Item {
    id: handle
    objectName: "flipStrip"
    visible: stack.handleExtent > 0
    x: stack.vertical ? 0 : stack.width - width
    y: stack.vertical ? stack.height - height : 0
    width: stack.vertical ? stack.width : stack.handleExtent
    height: stack.vertical ? stack.handleExtent : stack.height

    HoverHandler { id: handleHover }
    // One extra circle's room for the pill.
    readonly property var metrics: HostingModel.hostingDotMetrics(stack.cards.length + 1,
      (stack.vertical ? handle.width : handle.height) - Style.space(6), Style.space(4), Style.space(3))
    opacity: handleHover.hovered ? 1 : 0.4
    Behavior on opacity {
      NumberAnimation { duration: 120; easing.type: Easing.OutCubic }
    }

    Grid {
      id: dots
      anchors.centerIn: parent
      columns: stack.vertical ? Placement.PLACEMENT_MAX_CARDS : 1
      rows: stack.vertical ? 1 : Placement.PLACEMENT_MAX_CARDS
      spacing: handle.metrics.spacing

      Repeater {
        model: handle.visible ? stack.cards.length : 0

        Rectangle {
          required property int index
          readonly property bool showing: index === stack.current
          readonly property real length: showing ? handle.metrics.size * 2 + handle.metrics.spacing : handle.metrics.size
          objectName: showing ? "currentCard" : "card"
          width: stack.vertical ? length : handle.metrics.size
          height: stack.vertical ? handle.metrics.size : length
          radius: handle.metrics.size / 2
          color: Util.alpha(stack.foreground, showing ? 1 : 0.35)
          Behavior on width { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
          Behavior on height { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
          Behavior on color { ColorAnimation { duration: 160 } }
        }
      }
    }
  }
}
