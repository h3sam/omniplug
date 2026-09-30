import QtQuick
import "HostingModel.js" as HostingModel

// shell.json, as Placement sees it. With LiveBarPort.qml, the only file that
// names host members; test/host-contract.test.mjs checks them.
//
// Two ways in, least privilege first:
//   writeOwn  the public, scoped updateEntryInline on Omniplug's own entry
//   mutate    ShellRoot.mutateShellConfig, reached through the built-in bar's
//             root. It deep-copies the config, runs the mutator, and persists
//             synchronously; a mutator that throws persists nothing.
// Without a Bar root there is no mutate and no full config here; Placement
// falls back to the store's own read of shell.json and to omarchy-bar.
Item {
  id: port
  visible: false

  // Omniplug's scoped shell facade (for updateEntryInline).
  property var facadeShell: null
  // The built-in bar's root, handed over through PopupBridge.
  property var hostBar: null

  readonly property var shellRoot: {
    var root = port.hostBar
    try { return root && HostingModel.hostingCanWrite(root) ? root.shell : null } catch (error) { return null }
  }
  readonly property bool canCross: port.shellRoot !== null
  // Why the writer is out of reach, in one sentence; "" when it is not.
  readonly property string problem: {
    try { return HostingModel.hostingWriterProblem(port.hostBar) } catch (error) { return String(error) }
  }
  // Bindings on this re-evaluate whenever the host assigns a new config.
  readonly property var config: port.shellRoot ? port.shellRoot.shellConfig : null

  function current() {
    try { return port.shellRoot ? port.shellRoot.shellConfig : null } catch (error) { return null }
  }

  function writeOwn(selfId, settings) {
    if (!port.facadeShell || typeof port.facadeShell.updateEntryInline !== "function")
      return { ok: false, error: "no-facade" }
    try {
      // false means "nothing changed", which is not a failure.
      port.facadeShell.updateEntryInline(String(selfId), settings)
      return { ok: true, error: "" }
    } catch (error) {
      return { ok: false, error: String(error && error.message || error) }
    }
  }

  function mutate(mutator) {
    if (!port.shellRoot) return { ok: false, error: "no-writer" }
    try {
      port.shellRoot.mutateShellConfig(mutator)
      return { ok: true, error: "" }
    } catch (error) {
      return { ok: false, error: String(error && error.message || error) }
    }
  }
}
