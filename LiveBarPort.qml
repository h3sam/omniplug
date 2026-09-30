import QtQuick
import Quickshell
import "HostingModel.js" as HostingModel
import "PopupBridge.js" as PopupBridge

// The Bar root, as Hosting sees it. This file and LiveShellConfig.qml are the
// only ones that name host members; test/host-contract.test.mjs checks every
// name against the Omarchy source so a host change shows up as a failing test
// rather than a drawer that quietly stops working. FakeBarPort.qml (tests)
// has the same members.
//
// Hosting only reads through this port and asks for facades; it never writes
// shell.json. Placement's writes go through LiveShellConfig.qml instead.
Item {
  id: port
  visible: false

  // Omniplug's own bar widget: its window is where the walk starts.
  property Item owner: null

  // The built-in bar has one root for every monitor, so any instance that
  // finds it shares it through PopupBridge and the others start from there.
  property var barRoot: null
  readonly property bool attached: barRoot !== null
  readonly property bool searching: barRoot === null && attempts < 40
  property int attempts: 0

  // Reading `widgets` is what makes bindings re-evaluate when a plugin is
  // enabled, disabled or reloaded.
  readonly property var widgets: {
    var registry = port.barRoot ? port.barRoot.barWidgetRegistry : null
    return registry && registry.widgets ? registry.widgets : ({})
  }
  readonly property bool scanning: {
    var shell = port.barRoot ? port.barRoot.shell : null
    var registry = shell ? shell.pluginRegistry : null
    return !!registry && registry.scanning === true
  }
  readonly property var activePopout: port.barRoot ? port.barRoot.activePopout : null
  readonly property var tooltipTarget: port.barRoot ? port.barRoot.tooltipTarget : null
  readonly property string tooltipText: port.barRoot ? String(port.barRoot.tooltipText || "") : ""
  readonly property bool tooltipShown: !!port.barRoot && port.barRoot.tooltipShown === true
  readonly property string position: port.barRoot ? String(port.barRoot.position || "top") : "top"
  readonly property bool vertical: position === "left" || position === "right"
  readonly property int barSize: port.barRoot && port.barRoot.barSize > 0 ? port.barRoot.barSize : 0
  readonly property string fontFamily: port.barRoot ? String(port.barRoot.fontFamily || "") : ""
  readonly property color barForeground: port.barRoot && port.barRoot.barForeground !== undefined
    ? port.barRoot.barForeground : "transparent"

  // The host rebuilt or pruned facades; hosted third-party widgets may be
  // holding a destroyed one and need theirs again.
  signal facadesChanged()

  function valid(candidate) {
    try { return HostingModel.hostingIsHostBar(candidate) } catch (error) { return false }
  }

  function locate() {
    if (port.valid(port.barRoot)) return
    var cached = PopupBridge.hostBar()
    if (port.valid(cached)) { port.barRoot = cached; return }
    port.barRoot = null
    var window = port.owner ? port.owner.QsWindow.window : null
    var found = window ? HostingModel.hostingFindHostBar(window.contentItem) : null
    if (port.valid(found)) {
      port.barRoot = found
      PopupBridge.offerHostBar(found)
      return
    }
    if (port.attempts < 40) {
      port.attempts++
      retry.restart()
    }
  }

  function componentFor(id) {
    var entry = port.widgets[String(id || "")]
    return entry && entry.component ? entry.component : null
  }

  function metadataFor(id) {
    var registry = port.barRoot ? port.barRoot.barWidgetRegistry : null
    if (registry && typeof registry.metadataFor === "function") return registry.metadataFor(String(id || ""))
    var entry = port.widgets[String(id || "")]
    return entry && entry.metadata ? entry.metadata : null
  }

  function firstParty(id) {
    var metadata = port.metadataFor(id)
    return !!metadata && metadata.firstParty === true
  }

  function displayName(id) {
    var metadata = port.metadataFor(id)
    return metadata && metadata.displayName ? String(metadata.displayName) : String(id || "")
  }

  // What the bar's own ModuleSlot injects as `bar`: the root for built-ins,
  // a service-capable facade for everything else.
  function barFor(id) {
    if (!port.barRoot) return null
    if (port.firstParty(id)) return port.barRoot
    try { return port.barRoot.pluginBarApiFor(String(id), String(id), true) } catch (error) { return null }
  }

  // A registered module slot keeps the host from pruning the widget's facade.
  function attachProxy(slot) {
    if (!port.barRoot || !slot) return false
    port.barRoot.registerModuleSlot(slot)
    return true
  }

  function detachProxy(slot, root) {
    var target = root || port.barRoot
    try {
      if (target && slot && typeof target.unregisterModuleSlot === "function") target.unregisterModuleSlot(slot)
    } catch (error) {}
  }

  onOwnerChanged: locate()
  Component.onCompleted: locate()

  Timer {
    id: retry
    interval: 250
    onTriggered: port.locate()
  }

  Connections {
    target: port.barRoot
    ignoreUnknownSignals: true
    function onPluginBarApisChanged() { port.facadesChanged() }
    function onModuleSlotsChanged() { Qt.callLater(port.facadesChanged) }
  }

  // A shell reload destroys the bar and every widget on it, this one
  // included, so a fresh port starts the search again; nothing to watch here.
}
