import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "PopupBridge.js" as PopupBridge
import "Placement.js" as Placement

// Omniplug's bar entries. Most often the puzzle-piece icon, which opens the
// Drawer, where stacks are built, with Manage leading to the plugin manager
// (Panel.qml). An entry with a `stack` setting is a stack instead
// (StackWidget.qml), and is nothing else: no panel, no IPC, no Drawer.
// See docs/design/m1-drawer.md and docs/design/m2-stacks.md.
//
// For the icon, this file owns the bar slot and the open/close contract the
// bar routes summon/hide/toggle through.
BarWidget {
  id: root
  moduleName: "io.github.h3sam.omniplug"

  // The host injects `settings` a tick after the widget is made. Until then
  // this entry could be either, so it is neither: nothing heavy starts.
  readonly property string stackId: root.settings && typeof root.settings.stack === "string" ? root.settings.stack : ""
  readonly property bool isStack: root.stackId !== ""
  property bool modeKnown: false
  readonly property bool isIcon: root.modeKnown && !root.isStack
  Timer {
    interval: 250
    running: !root.modeKnown
    onTriggered: root.modeKnown = true
  }
  onIsIconChanged: if (root.isIcon) PopupBridge.register(root)

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
    if ("popupMoveOwner" in target) target.popupMoveOwner = root.popupMoveOwner
  }

  property var popupMoveOwner: null

  function setMoveOwner(owner) {
    popupMoveOwner = owner
    injectPanel()
  }

  function requestPopupMove(snapshot, fromSection, fromIndex, section, gap, origin) {
    return PopupBridge.requestMove(root, snapshot, fromSection, fromIndex, section, gap, origin)
  }

  function requestPopupPlacement(intent, view) {
    return PopupBridge.requestPlacement(root, intent, view)
  }

  function openPlacementView(origin, finalAttempt) {
    var target = panelLoader.item
    return !!target && typeof target.openPlacementView === "function"
      && target.openPlacementView(origin, finalAttempt) === true
  }

  function cancelPopupArrange() {
    PopupBridge.cancelArrange()
  }

  // Restore only when the local overlay is ready. Never recurse through the
  // host widget or open Expanded as a substitute.
  function openArrange() {
    var target = panelLoader.item
    return !!target && typeof target.openArrange === "function" && target.openArrange() === true
  }

  // ---- The drawer ---------------------------------------------------------

  property bool drawerOpen: false

  LiveBarPort {
    id: barPort
    owner: root
  }

  LiveShellConfig {
    id: shellConfig
    hostBar: barPort.barRoot
  }

  // What the plugin list knows (names, kinds, first-party), once the manager
  // has loaded it; until then the board treats every stowed id as installed
  // and Hosting finds out from the registry.
  readonly property var pluginFacts: {
    var rows = panelLoader.item && panelLoader.item.rows ? panelLoader.item.rows : []
    if (!rows.length) return null
    var facts = {}
    for (var i = 0; i < rows.length; i++)
      facts[rows[i].id] = { name: rows[i].name, kinds: rows[i].kinds, firstParty: rows[i].firstParty === true }
    return facts
  }

  // Read-only: the Drawer draws the board; Placement's owner (Expanded) writes.
  readonly property var board: shellConfig.config && root.isIcon
    ? Placement.placementBoard(shellConfig.config,
        { selfId: root.moduleName, plugins: root.pluginFacts, canCross: shellConfig.canCross })
    : null

  // Why there is no board, in words, for the Drawer: the bar not found yet,
  // a shell that cannot be written, or the exact entry shell.json is refused
  // for.
  readonly property string boardProblem: {
    if (root.board) return ""
    if (!barPort.attached)
      return barPort.searching ? "Looking for the bar…"
        : "Omniplug could not find the bar. Keep at least one Omarchy widget on it, then restart the shell."
    if (!shellConfig.config) return "The bar was found, but its shell cannot be changed from here."
    return "shell.json cannot be used: " + Placement.placementProblem(shellConfig.config, root.moduleName) + "."
  }

  // Placement's owner keeps its last ticket across the bar rebuild a change
  // can cause, so the reopened Drawer can still say what happened. Tickets
  // from before this opening are not news; drawerTicket is a refusal that
  // never reached the owner.
  readonly property var placementOwner: root.popupMoveOwner && root.popupMoveOwner.placement
    ? root.popupMoveOwner.placement : null
  property int noteAfter: -1
  property var drawerTicket: null
  readonly property var drawerNote: {
    if (root.drawerTicket) return root.drawerTicket
    var ticket = root.placementOwner ? root.placementOwner.ticket : null
    return ticket && ticket.serial > root.noteAfter ? ticket : null
  }

  // Every Drawer change goes to Placement's owner. One that changes the bar
  // layout rebuilds every bar widget, this one and its Drawer included, so
  // PopupBridge reopens the Drawer on the rebuilt icon for this output.
  function requestStackChange(intent) {
    var ticket = root.requestPopupPlacement(intent, "drawer")
    root.drawerTicket = ticket ? null : Object.freeze({ ok: false, phase: "refused", reason: "busy",
      note: "The manager is not ready yet. Try again in a moment." })
    return !!ticket && ticket.ok === true
  }

  // A window, so Quickshell's loader rather than QtQuick's.
  LazyLoader {
    id: drawerLoader
    active: root.isIcon
    component: DrawerWindow {
      port: barPort
      selfId: root.moduleName
      board: root.board
      problem: root.boardProblem
      labelFor: root.labelFor
      anchorItem: button
      open: root.drawerOpen
      ticket: root.drawerNote
      busy: !!root.placementOwner && root.placementOwner.busy
      onDismissed: root.closeDrawer()
      onManageRequested: root.openManager(true)
      onChangeRequested: function(intent) { root.requestStackChange(intent) }
    }
  }

  // A widget's name for the Drawer's chips: the plugin list's, else the
  // registry's, else its id.
  function labelFor(id) {
    var facts = root.pluginFacts
    if (facts && facts[id] && facts[id].name) return String(facts[id].name)
    return barPort.attached ? barPort.displayName(id) : String(id)
  }

  // keepNote: reopened by PopupBridge after a change rebuilt the bar, so the
  // change's note is still news.
  function openDrawer(keepNote) {
    // The shell may route a summon to any Omniplug entry; only the icon has
    // a Drawer.
    if (!root.isIcon) return false
    if (panelLoader.item && panelLoader.item.opened) panelLoader.item.close()
    drawerOpen = true
    drawerTicket = null
    if (keepNote !== true) noteAfter = root.placementOwner && root.placementOwner.ticket
      ? root.placementOwner.ticket.serial : -1
    // Placement needs the plugin list (kinds, built-in or not) to change
    // stacks, and nothing else may have loaded it yet.
    if (panelLoader.item && (!panelLoader.item.rows || panelLoader.item.rows.length === 0)
        && typeof panelLoader.item.reload === "function") panelLoader.item.reload()
    if (root.bar && typeof root.bar.requestPopout === "function") root.bar.requestPopout(root)
    return true
  }

  function closeDrawer() {
    if (!drawerOpen) return
    drawerOpen = false
    if (root.bar && typeof root.bar.releasePopout === "function") root.bar.releasePopout(root)
  }

  // Manage: today's manager popup, with a way back when it came from here.
  function openManager(fromDrawer) {
    closeDrawer()
    var target = panelLoader.item
    if (!target) return
    if ("fromDrawer" in target) target.fromDrawer = fromDrawer === true
    target.open()
  }

  // Hosted widgets register click targets too; the bar scans them last-first
  // and maps coordinates across windows, so keep our own icon last.
  function raiseOwnClickTargets() {
    if (root.isIcon && typeof button.syncClickRegistration === "function") button.syncClickRegistration()
  }

  // ---- Shape contract for shell.summon/hide/toggle routing:
  //      Bar.findPanelWidget requires open/close/opened on the bar-widget
  //      root, so these delegate to the drawer and the loaded panel.
  readonly property bool opened: drawerOpen || (panelLoader.item ? panelLoader.item.opened === true : false)
  // The loaded panel owns update evidence and the process that produces it.
  // Project its confirmed count instead of starting another check for the bar.
  readonly property int updateCount: panelLoader.item ? panelLoader.item.behindCount : 0

  // The output this bar instance draws on, so the expanded window can hand
  // back to the popup on the same monitor (see PopupBridge.js).
  readonly property string screenName: root.QsWindow.window && root.QsWindow.window.screen
    ? String(root.QsWindow.window.screen.name || "") : ""

  Component.onDestruction: PopupBridge.unregister(root)

  function open() {
    cancelPopupArrange()
    openDrawer()
  }

  function close() {
    cancelPopupArrange()
    closeDrawer()
    if (panelLoader.item) panelLoader.item.close()
  }

  // The icon: whichever of the drawer and the manager is open closes;
  // otherwise the drawer opens.
  function togglePanel() {
    if (!root.isIcon) return
    cancelPopupArrange()
    if (panelLoader.item && panelLoader.item.opened) panelLoader.item.close()
    else if (drawerOpen) closeDrawer()
    else openDrawer()
  }

  function refresh() {
    if (panelLoader.item && panelLoader.item.reload) panelLoader.item.reload()
  }

  // Forwarded so this widget can stand in for the panel as the bar's popout
  // identity: Bar.requestPopout prefers closeForPopoutSwitch over close, and
  // KeyboardPanel reads popoutSwitchClosing back off its owner.
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    cancelPopupArrange()
    closeDrawer()
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  implicitWidth: root.isStack ? (stackLoader.item ? stackLoader.item.implicitWidth : 0) : button.implicitWidth
  implicitHeight: root.isStack ? (stackLoader.item ? stackLoader.item.implicitHeight : 0) : button.implicitHeight

  Loader {
    id: stackLoader
    active: root.isStack
    anchors.fill: parent
    sourceComponent: StackWidget {
      owner: root
      port: barPort
      config: shellConfig.config
      selfId: root.moduleName
      sid: root.stackId
      screenName: root.screenName
    }
  }

  onBarChanged: injectPanel()
  onSettingsChanged: {
    root.modeKnown = true
    injectPanel()
  }

  Loader {
    id: panelLoader
    active: root.isIcon
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  IpcHandler {
    target: "io.github.h3sam.omniplug"
    enabled: root.isIcon

    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.togglePanel() }
    function refresh(): void { root.broadcast("refresh") }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    // Hidden, the bar's click scan skips it: a stack's clicks are its widgets'.
    visible: !root.isStack
    bar: root.bar
    text: "󰐱"
    tooltipText: root.updateCount > 0 ? "Plugins - " + root.updateCount + " to update" : "Plugins"

    // Middle click re-reads the list without opening anything — the same
    // "refresh in place" gesture the weather and clock widgets use.
    onPressed: function(b) {
      if (b === Qt.MiddleButton) root.refresh()
      else root.togglePanel()
    }
  }

  Rectangle {
    id: updateBadge
    enabled: false
    visible: root.isIcon && root.updateCount > 0
    z: button.z + 1
    anchors.right: button.right
    anchors.rightMargin: Style.space(3)
    anchors.top: button.top
    anchors.topMargin: Style.space(5)
    width: Style.space(6)
    height: width
    radius: width / 2
    color: Color.accent
  }
}
