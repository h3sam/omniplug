// Hosting rules: how a stowed widget is keyed, configured, labelled and kept
// out of the way. Pure; HostStage.qml applies these, and LiveBarPort.qml is
// the only file that touches the host. See docs/design/m1-drawer.md.
//
// The host-finding functions follow Bar Drawer's DrawerModel.js
// (SykesTheLord/omarchy-bar-drawer, MIT): third-party widgets are handed a
// scoped facade, but built-in widgets on the same bar window are handed the
// Bar root itself, so a bounded walk of the window's items finds it.

var HOSTING_MAX_ENTRIES = 64
var HOSTING_MAX_SCAN_NODES = 8000

// A Bar root the way the built-in bar builds one: it hands out facades, owns
// the popout, and holds the widget registry. `shell` must be the real
// ShellRoot (it has the config writer) for Placement to use it; a replacement
// bar gets a facade there and can still host, but not write.
function hostingIsHostBar(candidate) {
  return !!candidate
    && typeof candidate.pluginBarApiFor === "function"
    && typeof candidate.requestPopout === "function"
    && typeof candidate.registerModuleSlot === "function"
    && !!candidate.barWidgetRegistry
}

function hostingCanWrite(barRoot) {
  var shell = null
  try { shell = barRoot ? barRoot.shell : null } catch (error) { shell = null }
  return !!shell && typeof shell.mutateShellConfig === "function" && !!shell.shellConfig
}

function hostingFindHostBar(rootItem, maxNodes) {
  if (!rootItem) return null
  var limit = typeof maxNodes === "number" ? maxNodes : HOSTING_MAX_SCAN_NODES
  var stack = [rootItem]
  var visited = 0
  while (stack.length > 0 && visited < limit) {
    var node = stack.pop()
    visited++
    if (!node) continue
    var candidate = null
    try { candidate = node.bar } catch (error) { candidate = null }
    if (hostingIsHostBar(candidate)) return candidate
    var kids = null
    try { kids = node.children } catch (error) { kids = null }
    if (!kids) continue
    for (var i = 0; i < kids.length; i++) stack.push(kids[i])
  }
  return null
}

function hostingIsDescendant(item, ancestor) {
  var node = item
  for (var guard = 0; node && guard < 256; guard++) {
    if (node === ancestor) return true
    try { node = node.parent } catch (error) { return false }
  }
  return false
}

// Tiles from Placement's drawer slots (or bare entries): a stable key per
// instance, `id#n` where n counts earlier copies of the same id, so reorders
// and settings edits never rebuild a widget. At most HOSTING_MAX_ENTRIES.
function hostingTiles(entries, selfId) {
  var list = Array.isArray(entries) ? entries.slice(0, HOSTING_MAX_ENTRIES) : []
  var seen = {}
  var tiles = []
  for (var i = 0; i < list.length; i++) {
    var entry = list[i]
    var id = typeof entry === "string" ? entry : entry && typeof entry.id === "string" ? entry.id : ""
    if (!id) continue
    var n = seen[id] || 0
    seen[id] = n + 1
    tiles.push(Object.freeze({
      key: id + "#" + n,
      id: id,
      name: entry && typeof entry.name === "string" && entry.name ? entry.name : id,
      settings: entry && entry.settings && typeof entry.settings === "object" ? entry.settings : {},
      placement: entry && typeof entry.state === "string" ? entry.state : "live",
      self: id === selfId
    }))
  }
  return Object.freeze(tiles)
}

// What the widget receives as `settings`: its entry's inline keys with the
// carrier on top, because a stowed widget's own updateEntryInline lands in
// the carrier. Never the id.
function hostingSettings(entrySettings, carrierSettings) {
  var merged = {}
  var parts = [entrySettings, carrierSettings]
  for (var p = 0; p < parts.length; p++) {
    var part = parts[p]
    if (!part || typeof part !== "object") continue
    for (var key in part) if (key !== "id") merged[key] = part[key]
  }
  return merged
}

function hostingSettingsKey(settings) {
  try { return JSON.stringify(settings || {}) } catch (error) { return "" }
}

// One tile's state and why, from what the stage knows:
//   { self, placement ("live"|"off"|"missing"), attached, searching,
//     scanning, graceOver, hasComponent, loadError }
// waiting   still looking for the Bar root, or the registry is scanning, and
//           the grace period has not run out (no ⚠ flashes at shell start)
// live      the widget is running
// missing   not-installed / disabled / not-registered
// failed    the Loader reported an error
// refused   self / no-host
function hostingTileState(facts) {
  var f = facts || {}
  if (f.self) return { state: "refused", reason: "self" }
  if (f.placement === "missing") return { state: "missing", reason: "not-installed" }
  if (f.placement === "off") return { state: "missing", reason: "disabled" }
  if (!f.attached) {
    if (f.searching && !f.graceOver) return { state: "waiting", reason: "" }
    return { state: "refused", reason: "no-host" }
  }
  if (f.loadError) return { state: "failed", reason: String(f.loadError) }
  if (f.hasComponent) return { state: "live", reason: "" }
  if (f.scanning || !f.graceOver) return { state: "waiting", reason: "" }
  return { state: "missing", reason: "not-registered" }
}

var HOSTING_REASONS = {
  "not-installed": "This plugin is not installed any more. Remove it in Arrange.",
  "disabled": "Switched off. Turn it back on in Manage.",
  "not-registered": "The shell has not loaded this widget.",
  "no-host": "The drawer could not reach the bar. Keep at least one Omarchy widget on it.",
  "self": "Omniplug cannot hold itself."
}

function hostingReasonText(reason) {
  return HOSTING_REASONS[reason] || (reason ? "Could not load: " + reason : "")
}

// What to do when the bar's single popout changes while the drawer is shown.
//   { shown, active, owner, ownsActive }
// keep     the drawer or one of its hosted widgets holds the popout
// reclaim  nobody holds it (a hosted child just closed its panel): take it
//          back so the next popout elsewhere closes the drawer
// dismiss  something outside the drawer took it: close the drawer
function hostingPopoutVerdict(facts) {
  var f = facts || {}
  if (!f.shown) return "keep"
  if (f.active === null || f.active === undefined) return "reclaim"
  if (f.active === f.owner || f.ownsActive) return "keep"
  return "dismiss"
}
