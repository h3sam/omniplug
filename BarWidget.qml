import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "PopupBridge.js" as PopupBridge
import "Placement.js" as Placement

// Omniplug's one bar entry: a puzzle-piece icon that opens the Drawer, the
// widgets you stowed off the bar, with Manage leading to the plugin manager
// (Panel.qml). See docs/design/m1-drawer.md.
//
// This file owns the bar slot, the open/close contract the bar routes
// summon/hide/toggle through, and the drawer's HostStage (obligation O1): the
// stowed widgets live as long as this widget does, whatever window shows them.
BarWidget {
  id: root
  moduleName: "io.github.h3sam.omniplug"

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

  // Read-only: the drawer draws the board; Placement's owner (Expanded) writes.
  readonly property var board: shellConfig.config
    ? Placement.placementBoard(shellConfig.config,
        { selfId: root.moduleName, plugins: root.pluginFacts, canCross: shellConfig.canCross })
    : null

  // Without the Bar root there is no full config to read, but our own entry
  // still arrives as `settings`, so the drawer can at least say what is in it.
  readonly property var drawerEntries: {
    if (root.board) return root.board.zones.drawer
    var ids = root.settings && Array.isArray(root.settings.drawer) ? root.settings.drawer : []
    return ids.filter(function(id) { return typeof id === "string" }).map(function(id) { return { id: id } })
  }

  HostStage {
    id: stage
    owner: root
    port: barPort
    selfId: root.moduleName
    entries: root.drawerEntries
    shown: root.drawerOpen
    cardForeground: Color.popups.text
    onDismissRequested: root.closeDrawer()
  }

  DrawerWindow {
    id: drawerWindow
    port: barPort
    stage: stage
    anchorItem: button
    open: root.drawerOpen
    onDismissed: root.closeDrawer()
    onManageRequested: root.openManager(true)
  }

  function openDrawer() {
    if (panelLoader.item && panelLoader.item.opened) panelLoader.item.close()
    drawerOpen = true
    if (root.bar && typeof root.bar.requestPopout === "function") root.bar.requestPopout(root)
  }

  function closeDrawer() {
    if (!drawerOpen) return
    // O3: the stage hides (and closes a hosted widget's panel) first.
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
    if (typeof button.syncClickRegistration === "function") button.syncClickRegistration()
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

  Component.onCompleted: PopupBridge.register(root)
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
    // O2: the new popout may belong to a stowed widget; the stage decides.
    if (stage.deferPopoutSwitch()) return
    cancelPopupArrange()
    closeDrawer()
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  IpcHandler {
    target: "io.github.h3sam.omniplug"

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
    visible: root.updateCount > 0
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
