import QtQuick

// The test adapter for LiveBarPort.qml: the same members, backed by plain
// QML objects, recording what Hosting asks of the host.
Item {
  id: port
  visible: false

  property Item owner: null
  property var barRoot: rootStub
  property bool attached: true
  property bool searching: false
  // { id: { component, metadata: { firstParty, displayName } } }
  property var widgets: ({})
  property bool scanning: false
  property var activePopout: null
  property var tooltipTarget: null
  property string tooltipText: ""
  property bool tooltipShown: false
  property string position: "top"
  readonly property bool vertical: position === "left" || position === "right"
  property int barSize: 30
  property string fontFamily: ""
  property color barForeground: "white"

  // Recorded calls.
  property var attached_slots: []
  property var barForCalls: []
  property int facadeGeneration: 0

  signal facadesChanged()

  QtObject { id: rootStub; objectName: "barRoot" }

  function componentFor(id) {
    var entry = port.widgets[String(id || "")]
    return entry && entry.component ? entry.component : null
  }

  function metadataFor(id) {
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

  // A distinct facade object per id and generation, like the host rebuilding
  // a pruned one.
  property var facadeObjects: ({})
  function barFor(id) {
    port.barForCalls = port.barForCalls.concat([String(id)])
    if (port.firstParty(id)) return rootStub
    var key = String(id) + "@" + port.facadeGeneration
    if (!port.facadeObjects[key]) {
      var next = {}
      for (var k in port.facadeObjects) next[k] = port.facadeObjects[k]
      next[key] = facadeComponent.createObject(port, { pluginId: String(id), generation: port.facadeGeneration })
      port.facadeObjects = next
    }
    return port.facadeObjects[key]
  }

  function attachProxy(slot) {
    port.attached_slots = port.attached_slots.concat([slot])
    return true
  }

  function detachProxy(slot) {
    port.attached_slots = port.attached_slots.filter(function(item) { return item !== slot })
  }

  function pruneFacades() {
    port.facadeGeneration++
    port.facadesChanged()
  }

  Component {
    id: facadeComponent
    QtObject {
      property string pluginId: ""
      property int generation: 0
      property var requested: []
      function requestPopout(owner) { requested = requested.concat([owner]) }
    }
  }
}
