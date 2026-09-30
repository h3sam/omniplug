import QtQuick
import QtQml
import "HostingModel.js" as HostingModel

// Owns every stowed widget instance for one Omniplug bar widget (so one per
// monitor, like the bar's own slots). See docs/design/m1-drawer.md, Hosting.
//
// Instances live here, parked and invisible, for as long as their entry is in
// `entries`; a HostMount in a view borrows one by re-parenting it, so opening
// Manage and coming back, or reordering the drawer, never restarts a widget.
// Stowed widgets keep running while the drawer is shut, exactly as they did on
// the bar, which is what keeps their IPC handlers and broadcast() peers alive.
//
// The loading and injection follow the bar's own ModuleSlot
// (plugins/bar/Bar.qml), and the proxy slot and card repaint follow Groups
// (kristofferR/omarchy-groups, MIT) and Bar Drawer (SykesTheLord, MIT).
//
// Caller obligations:
//   O1  create the stage in BarWidget.qml, not inside a view
//   O2  BarWidget.closeForPopoutSwitch() calls deferPopoutSwitch() first and
//       returns if it answers true
//   O3  `shown` goes false no later than the moment the drawer starts hiding
//   O4  mounts live in the drawer window (edge-spanning, masked to its card)
Item {
  id: stage
  visible: false
  width: 0
  height: 0

  // Omniplug's bar widget: the popout identity, and its `bar` is our facade.
  property Item owner: null
  // LiveBarPort in the shell; FakeBarPort in tests.
  property var port: null
  property string selfId: ""
  // Placement's drawer slots, in order.
  property var entries: []
  // Hosted content is on screen and may take input.
  property bool shown: false
  // The colour hosted widgets should draw with on the drawer card; widgets
  // still using the bar's (for a transparent bar) are rebound to it.
  property color cardForeground: "transparent"

  readonly property var tiles: stage._tiles
  readonly property bool childPanelOpen: {
    var active = stage.port ? stage.port.activePopout : null
    stage._revision
    return !!active && active !== stage.owner && stage.ownsPopout(active)
  }
  readonly property string hostProblem: !stage.port ? "no-builtin-widget"
    : stage.port.attached ? "" : stage.port.searching ? "searching" : "no-builtin-widget"

  // A popout outside this stage took over: close the drawer.
  signal dismissRequested()

  property var _tiles: []
  property var _tileByKey: ({})
  property var _instances: ({})
  property int _revision: 0
  property bool _graceOver: false
  // How long a tile may wait for the bar and the registry before it admits
  // it is missing; long enough that a shell start shows no ⚠ flashes.
  property int graceInterval: 10000

  // ---- Interface ---------------------------------------------------------

  // Bar.requestPopout calls the current owner's closeForPopoutSwitch before
  // handing the popout over, and the new owner may be one of our own
  // widgets. Answer "don't close yet" and decide once the popout settles.
  function deferPopoutSwitch() {
    if (!stage.shown) return false
    Qt.callLater(stage.reconcilePopout)
    return true
  }

  function instanceFor(key) {
    stage._revision
    return stage._instances[String(key)] || null
  }

  function tileFor(key) {
    stage._revision
    return stage._tileByKey[String(key)] || null
  }

  function mount(key, point) {
    var instance = stage._instances[String(key)]
    if (!instance || !point) return false
    // One mount per key: a second asker stays empty until the first leaves.
    if (instance.mountPoint && instance.mountPoint !== point) return false
    instance.mountPoint = point
    return true
  }

  function unmount(key, point) {
    var instance = stage._instances[String(key)]
    if (instance && instance.mountPoint === point) instance.mountPoint = null
  }

  // ---- Popout ------------------------------------------------------------

  function ownsPopout(target) {
    if (!target) return false
    var anchor = null
    try { anchor = target.anchorItem } catch (error) { anchor = null }
    for (var key in stage._instances) {
      var instance = stage._instances[key]
      if (!instance) continue
      if (instance.item === target) return true
      if (anchor && HostingModel.hostingIsDescendant(anchor, instance)) return true
      if (HostingModel.hostingIsDescendant(target, instance)) return true
    }
    return false
  }

  function reconcilePopout() {
    if (!stage.port) return
    var active = stage.port.activePopout
    var verdict = HostingModel.hostingPopoutVerdict({
      shown: stage.shown, active: active, owner: stage.owner, ownsActive: stage.ownsPopout(active)
    })
    if (verdict === "reclaim") Qt.callLater(stage.reclaimPopout)
    else if (verdict === "dismiss") stage.dismissRequested()
  }

  // A hosted widget closed its panel. Take the popout back so the next panel
  // opened elsewhere on the bar closes the drawer, as any popup would.
  function reclaimPopout() {
    var facade = stage.owner ? stage.owner.bar : null
    if (stage.shown && stage.port && stage.port.activePopout === null
        && facade && typeof facade.requestPopout === "function") facade.requestPopout(stage.owner)
  }

  // Before the drawer hides, close a hosted widget's open panel with it.
  function closeChildPanel() {
    var active = stage.port ? stage.port.activePopout : null
    if (active && active !== stage.owner && stage.ownsPopout(active) && typeof active.close === "function")
      active.close()
  }

  onShownChanged: if (!shown) closeChildPanel()

  Connections {
    target: stage.port
    ignoreUnknownSignals: true
    function onActivePopoutChanged() { if (stage.shown) Qt.callLater(stage.reconcilePopout) }
  }

  // ---- Instances ---------------------------------------------------------

  // A ListModel keyed by tile key, synced in place: inserts, removes and moves
  // keep every other delegate (and the widget inside it) alive.
  ListModel { id: tileModel }

  function syncModel() {
    var desired = HostingModel.hostingTiles(stage.entries, stage.selfId)
    var byKey = {}
    for (var i = 0; i < desired.length; i++) byKey[desired[i].key] = desired[i]
    for (var r = tileModel.count - 1; r >= 0; r--) {
      if (!byKey[tileModel.get(r).key]) tileModel.remove(r)
    }
    for (var d = 0; d < desired.length; d++) {
      var at = -1
      for (var m = 0; m < tileModel.count; m++) if (tileModel.get(m).key === desired[d].key) { at = m; break }
      if (at < 0) tileModel.insert(d, { key: desired[d].key, widgetId: desired[d].id })
      else if (at !== d) tileModel.move(at, d, 1)
    }
    stage._tileByKey = byKey
    stage._revision++
    stage.refreshTiles()
  }

  function refreshTiles() {
    var desired = HostingModel.hostingTiles(stage.entries, stage.selfId)
    var out = []
    for (var i = 0; i < desired.length; i++) {
      var instance = stage._instances[desired[i].key]
      out.push(Object.freeze({
        key: desired[i].key,
        id: desired[i].id,
        name: stage.port && stage.port.attached && desired[i].name === desired[i].id
          ? stage.port.displayName(desired[i].id) : desired[i].name,
        state: instance ? instance.tileState : "waiting",
        reason: instance ? instance.tileReason : ""
      }))
    }
    // Only a real change reaches the views, so their mounts are not rebuilt
    // for nothing.
    if (JSON.stringify(out) !== JSON.stringify(stage._tiles)) stage._tiles = Object.freeze(out)
  }

  onEntriesChanged: syncModel()
  onSelfIdChanged: syncModel()
  Component.onCompleted: syncModel()

  Timer {
    interval: stage.graceInterval
    running: true
    onTriggered: { stage._graceOver = true; stage.refreshTiles() }
  }

  // An Instantiator, not a Repeater: instances are handed to other windows
  // and a Repeater would keep trying to restack them among its siblings.
  Instantiator {
    model: tileModel

    delegate: Item {
      id: instance

      required property string key
      required property string widgetId

      readonly property var tile: stage.tileFor(key)
      // Set by HostMount; the instance is drawn wherever its mount is. Set
      // imperatively: the Repeater parents its delegates itself.
      property Item mountPoint: null
      onMountPointChanged: instance.parent = instance.mountPoint ? instance.mountPoint : stage
      // Hidden means inert: the bar's click and tooltip checks skip items
      // that are not visible, so a parked widget can never take a bar click.
      visible: stage.shown && mountPoint !== null

      readonly property var component: {
        var port = stage.port
        if (!port || !port.attached || !tile || tile.self || tile.placement !== "live") return null
        port.widgets
        return port.componentFor(widgetId)
      }
      readonly property var item: loader.item
      property string loadError: ""
      readonly property var verdict: HostingModel.hostingTileState({
        self: !!tile && tile.self,
        placement: tile ? tile.placement : "live",
        attached: !!stage.port && stage.port.attached,
        searching: !!stage.port && stage.port.searching,
        scanning: !!stage.port && stage.port.scanning,
        graceOver: stage._graceOver,
        hasComponent: component !== null,
        loadError: loadError
      })
      readonly property string tileState: verdict.state
      readonly property string tileReason: verdict.reason
      property string _settingsKey: ""

      implicitWidth: item && item.visible
        ? (stage.port && stage.port.vertical && stage.port.barSize > 0 ? stage.port.barSize : item.implicitWidth) : 0
      implicitHeight: item && item.visible ? item.implicitHeight : 0
      width: implicitWidth
      height: implicitHeight

      onTileStateChanged: Qt.callLater(stage.refreshTiles)
      onTileReasonChanged: Qt.callLater(stage.refreshTiles)

      Component.onCompleted: {
        instance.parent = instance.mountPoint ? instance.mountPoint : stage
        var next = {}
        for (var k in stage._instances) next[k] = stage._instances[k]
        next[key] = instance
        stage._instances = next
        stage._revision++
      }
      Component.onDestruction: {
        if (stage._instances[key] === instance) {
          var next = {}
          for (var k in stage._instances) if (k !== key) next[k] = stage._instances[k]
          stage._instances = next
          stage._revision++
        }
      }

      // What the bar's ModuleSlot injects, in its order, and only what the
      // widget declares. Settings are re-sent only when they change.
      function inject() {
        var target = loader.item
        if (!target || !stage.port) return
        proxy.attach()
        if ("bar" in target) {
          var bar = stage.port.barFor(widgetId)
          if (bar && target.bar !== bar) target.bar = bar
        }
        if ("moduleName" in target) target.moduleName = widgetId
        var settings = tile ? HostingModel.hostingSettings({}, tile.settings) : {}
        var settingsKey = HostingModel.hostingSettingsKey(settings)
        if ("settings" in target && settingsKey !== instance._settingsKey) {
          instance._settingsKey = settingsKey
          target.settings = settings
        }
      }

      onTileChanged: inject()

      Connections {
        target: stage.port
        ignoreUnknownSignals: true
        function onFacadesChanged() { instance.inject() }
      }

      // The drawer card is not the bar. When the bar is transparent its
      // foreground is picked for the wallpaper; rebind widgets still using it
      // to the card's colour. Qt.binding, so it follows the theme. A widget
      // that chose its own colour is left alone.
      function paintForTheCard(item) {
        if (!item || !stage.port || stage.cardForeground.a === 0) return
        if (Qt.colorEqual(stage.port.barForeground, stage.cardForeground)) return
        if ("foreground" in item) {
          try {
            if (Qt.colorEqual(item.foreground, stage.port.barForeground))
              item.foreground = Qt.binding(function() { return stage.cardForeground })
          } catch (error) {}
        }
        var kids = item.children
        for (var i = 0; kids && i < kids.length; i++) instance.paintForTheCard(kids[i])
      }

      Loader {
        id: loader
        anchors.fill: parent
        active: instance.component !== null
        sourceComponent: instance.component
        onLoaded: {
          instance.loadError = ""
          instance._settingsKey = ""
          instance.inject()
          Qt.callLater(instance.inject)
          Qt.callLater(function() { instance.paintForTheCard(loader.item) })
          if (stage.owner && typeof stage.owner.raiseOwnClickTargets === "function")
            Qt.callLater(stage.owner.raiseOwnClickTargets)
        }
        onStatusChanged: if (status === Loader.Error) instance.loadError = "the widget failed to load"
      }

      // Lets the host's id-to-widget lookups, and its facade pruning, see an
      // instance that owns no layout entry. The region is ours alone, so the
      // bar's drop targets, tab order and settings patches never match it.
      Item {
        id: proxy
        visible: false
        width: 0
        height: 0

        readonly property var entry: ({ id: instance.widgetId })
        readonly property string region: "omniplug"
        readonly property string moduleName: instance.widgetId
        readonly property string pluginApiId: instance.widgetId
        readonly property var moduleSettings: instance.tile ? instance.tile.settings : ({})
        readonly property string customType: ""
        readonly property bool qmlCustom: false
        readonly property bool commandCustom: false
        readonly property bool registered: true
        readonly property var registryComponent: instance.component
        // Only while the drawer is shown, so summon routing never opens a
        // widget nobody can see.
        readonly property var activeItem: stage.shown ? loader.item : null
        readonly property bool hovered: false
        readonly property bool dragSource: false
        readonly property bool panelOpen: !!stage.port && !!loader.item && stage.port.activePopout === loader.item
        readonly property real panelIndicatorExtent: 0

        property var registeredWith: null

        // Registered before the first facade is asked for, so the host never
        // prunes the facade the widget is about to receive.
        function attach() {
          var root = stage.port && stage.port.attached ? stage.port.barRoot : null
          if (root === registeredWith) return
          detach()
          if (root && stage.port.attachProxy(proxy)) registeredWith = root
        }

        function detach() {
          if (registeredWith && stage.port) stage.port.detachProxy(proxy, registeredWith)
          registeredWith = null
        }

        Component.onDestruction: detach()
      }
    }
  }
}
