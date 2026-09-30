import QtQuick

// The test adapter for LiveShellConfig.qml: the same members over an
// in-memory config, with the host's write semantics (updateEntryInline
// rewrites every object entry with the id; mutateShellConfig runs the
// mutator on a deep copy and persists only if it returns).
Item {
  id: port
  visible: false

  property var facadeShell: null
  property var hostBar: null
  // null means "no in-process writer": the owner falls back to barConfig.
  property var config: null
  property bool canCross: config !== null
  property string problem: config !== null ? "" : "Omniplug has not found the bar yet."
  // Hold writes until flush(), like a host that shows them late.
  property bool delayed: false
  // Something the host does to its copy just before running the mutator.
  property var beforeMutate: null
  property var pending: null
  property var writes: []

  function current() { return port.config }

  function apply(next) {
    if (port.delayed) port.pending = next
    else port.config = next
  }

  function flush() {
    if (port.pending) { port.config = port.pending; port.pending = null }
  }

  function writeOwn(selfId, settings) {
    port.writes = port.writes.concat(["own"])
    var copy = JSON.parse(JSON.stringify(port.config || { bar: port.facadeShell.barConfig }))
    var sections = ["left", "center", "right"]
    for (var s = 0; s < sections.length; s++) {
      var entries = copy.bar.layout[sections[s]]
      for (var i = 0; i < entries.length; i++) {
        if (entries[i] && entries[i].id === selfId) {
          var next = { id: selfId }
          for (var key in settings) next[key] = settings[key]
          entries[i] = next
        }
      }
    }
    if (port.config) port.apply(copy)
    else port.facadeShell.barConfig = copy.bar
    return { ok: true, error: "" }
  }

  function mutate(mutator) {
    port.writes = port.writes.concat(["config"])
    if (!port.config) return { ok: false, error: "no-writer" }
    var copy = JSON.parse(JSON.stringify(port.config))
    if (port.beforeMutate) port.beforeMutate(copy)
    try {
      mutator(copy)
    } catch (error) {
      return { ok: false, error: String(error && error.message || error) }
    }
    port.apply(copy)
    return { ok: true, error: "" }
  }
}
