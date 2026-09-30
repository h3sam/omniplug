// Placement: which zone every widget lives in, and the one shell.json change
// that moves it somewhere else.
//
// Pure. Nothing here touches the host; the QML owner (Placement.qml) reads the
// config through a port, asks for a plan, and hands the plan to a write
// channel. The design lives in docs/design/m1-drawer.md; the words used here
// (zone, entry, carrier, board, intent) are defined in its glossary.
//
// The zones are the three bar sections plus the Drawer. Where each is stored:
//   left/center/right  bar.layout, exactly as the host keeps it
//   drawer             Omniplug's own entry: `drawer: [id, ...]`, in order
// and the two host lists that decide whether a stowed widget runs at all:
//   plugins[]          a carrier `{id, ...settings}` per stowed widget. It keeps
//                      a third-party widget enabled (PluginRegistry.isEnabled
//                      looks for an entry in the layout or plugins[]), and it
//                      is where the widget's own updateEntryInline saves land
//                      while it is off the bar
//   disabledPlugins    an id here is off. The host checks this list first, for
//                      first- and third-party widgets alike, so a stowed widget
//                      turned off keeps both its drawer spot and its carrier

var PLACEMENT_BAR_ZONES = ["left", "center", "right"]
var PLACEMENT_ZONES = ["left", "center", "right", "drawer"]
var PLACEMENT_TARGETS = ["left", "center", "right", "drawer", "off", "remove"]

var PLACEMENT_MAX_SECTION = 128
var PLACEMENT_MAX_DRAWER = 64
var PLACEMENT_MAX_LIST = 1024
var PLACEMENT_MAX_NODES = 32768
var PLACEMENT_MAX_UNITS = 1048576

// Where an unanchored bar insertion lands: after the widget that usually opens
// each section, else at its end. Today's popup section choice uses the same.
var PLACEMENT_ANCHORS = { left: "omarchy.workspaces", center: "omarchy.weather", right: "omarchy.tray" }

var PLACEMENT_NOTES = {
  stale: "The bar changed since this was shown. Nothing was moved.",
  busy: "Another change is still being saved. Nothing was moved.",
  invalid: "That move is not possible. Nothing was moved.",
  self: "Omniplug holds the drawer, so it cannot go in it.",
  notStowable: "Only plain bar widgets can go in the drawer. Nothing was moved.",
  lastBuiltin: "Keep one Omarchy widget on the bar: the drawer finds the bar through it.",
  duplicate: "This widget is on the bar more than once. Remove the extra copy first.",
  conflict: "This widget is both on the bar and in the drawer. Move one copy by hand first.",
  needsBarAccess: "The drawer cannot reach the bar right now, so it cannot take or return widgets.",
  untransportable: "This entry ID cannot be passed to omarchy-bar. Nothing was moved.",
  limits: "The shell config is too large to change safely. Nothing was moved.",
  unreadable: "The shell config or plugin list could not be read whole. Nothing was moved.",
  notStowed: "That widget is not in the drawer.",
  notPlaced: "That widget is not placed anywhere yet."
}

function placementIsObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

// Match PluginRegistry's ID rules. Size is bounded by the copy below.
function placementValidId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 256
    && id.indexOf("/") < 0 && id.indexOf("..") < 0
}

function placementEntryId(entry) {
  if (typeof entry === "string") return entry
  if (placementIsObject(entry) && entry.id !== undefined && entry.id !== null) return String(entry.id)
  return ""
}

function placementEntrySettings(entry) {
  var settings = {}
  if (!placementIsObject(entry)) return settings
  for (var key in entry) if (key !== "id") settings[key] = entry[key]
  return settings
}

// Custom command/QML modules are the bar's own; they have no plugin to carry.
function placementIsCustom(entry) {
  var settings = placementEntrySettings(entry)
  return !!(settings.type || settings.exec || settings.source)
}

// A bounded, frozen, key-sorted deep copy: the only shape of host data this
// file ever keeps. Throws on anything JSON cannot say or on runaway size.
function placementCopy(value) {
  var budget = { nodes: PLACEMENT_MAX_NODES, units: PLACEMENT_MAX_UNITS }
  function copy(item, depth) {
    if (--budget.nodes < 0 || depth > 16) throw new Error("limits")
    if (typeof item === "string") {
      budget.units -= item.length
      if (budget.units < 0) throw new Error("limits")
      return item
    }
    if (item === null || typeof item === "boolean") return item
    if (typeof item === "number" && isFinite(item)) return item
    var array = Array.isArray(item)
    if (!array && !placementIsObject(item)) throw new Error("invalid")
    var keys = Object.keys(item)
    if (array && keys.length !== item.length) throw new Error("invalid")
    if (!array) keys.sort()
    var result = array ? [] : {}
    for (var i = 0; i < keys.length; i++) {
      var key = array ? String(i) : keys[i]
      budget.units -= key.length
      if (budget.units < 0) throw new Error("limits")
      result[array ? i : key] = copy(item[key], depth + 1)
    }
    return Object.freeze(result)
  }
  return copy(value, 0)
}

function placementThaw(value) {
  return JSON.parse(JSON.stringify(value))
}

// ---- Reading -----------------------------------------------------------

// The parts of shell.json placement cares about, validated and frozen, or a
// thrown "invalid"/"limits". Omniplug's own entry is found wherever the host
// keeps it: every copy in the layout (updateEntryInline rewrites them all),
// else a plugins[] entry.
function placementRead(config, selfId) {
  if (!placementIsObject(config) || !placementIsObject(config.bar)
      || !placementIsObject(config.bar.layout)) throw new Error("invalid")
  var layoutKeys = Object.keys(config.bar.layout)
  if (layoutKeys.length !== 3) throw new Error("invalid")
  var layout = {}
  for (var s = 0; s < PLACEMENT_BAR_ZONES.length; s++) {
    var section = config.bar.layout[PLACEMENT_BAR_ZONES[s]]
    if (!Array.isArray(section) || section.length > PLACEMENT_MAX_SECTION) throw new Error("invalid")
    for (var i = 0; i < section.length; i++) {
      if (!placementValidId(placementEntryId(section[i]))) throw new Error("invalid")
    }
    layout[PLACEMENT_BAR_ZONES[s]] = section
  }
  var plugins = config.plugins === undefined ? [] : config.plugins
  var disabled = config.disabledPlugins === undefined ? [] : config.disabledPlugins
  if (!Array.isArray(plugins) || plugins.length > PLACEMENT_MAX_LIST) throw new Error("invalid")
  if (!Array.isArray(disabled) || disabled.length > PLACEMENT_MAX_LIST) throw new Error("invalid")

  var own = null
  for (var z = 0; z < PLACEMENT_BAR_ZONES.length && !own; z++) {
    var entries = layout[PLACEMENT_BAR_ZONES[z]]
    for (var j = 0; j < entries.length; j++) {
      if (placementEntryId(entries[j]) === selfId) { own = { where: "layout", entry: entries[j] }; break }
    }
  }
  if (!own) {
    for (var p = 0; p < plugins.length; p++) {
      if (placementIsObject(plugins[p]) && String(plugins[p].id) === selfId) {
        own = { where: "plugins", entry: plugins[p] }
        break
      }
    }
  }

  var drawer = []
  var ownSettings = own ? placementEntrySettings(own.entry) : {}
  if (ownSettings.drawer !== undefined) {
    if (!Array.isArray(ownSettings.drawer) || ownSettings.drawer.length > PLACEMENT_MAX_DRAWER)
      throw new Error("invalid")
    var seen = {}
    for (var d = 0; d < ownSettings.drawer.length; d++) {
      var stowed = ownSettings.drawer[d]
      // Exactly once, by construction; a hand edit that repeats an id is not
      // something to guess about.
      if (!placementValidId(stowed) || seen[stowed]) throw new Error("invalid")
      seen[stowed] = true
      drawer.push(stowed)
    }
  }

  return placementCopy({
    layout: layout,
    plugins: plugins,
    disabled: disabled,
    own: own,
    drawer: drawer
  })
}

function placementCarrier(read, id) {
  for (var i = 0; i < read.plugins.length; i++) {
    var entry = read.plugins[i]
    if (placementIsObject(entry) && String(entry.id) === id) return entry
  }
  return null
}

function placementFirstParty(facts, id) {
  var plugin = facts && facts.plugins ? facts.plugins[id] : null
  if (plugin && typeof plugin.firstParty === "boolean") return plugin.firstParty
  return id.indexOf("omarchy.") === 0
}

function placementName(facts, id) {
  var plugin = facts && facts.plugins ? facts.plugins[id] : null
  return plugin && plugin.name ? String(plugin.name) : id
}

// The compare-and-swap key: ids and positions only. Settings are re-read from
// the live config when the change is applied, so a widget saving its own
// settings mid-drag does not make the user's move stale.
function placementKeyOf(read) {
  var layout = {}
  for (var s = 0; s < PLACEMENT_BAR_ZONES.length; s++) {
    layout[PLACEMENT_BAR_ZONES[s]] = read.layout[PLACEMENT_BAR_ZONES[s]].map(placementEntryId)
  }
  var carriers = []
  for (var i = 0; i < read.plugins.length; i++) {
    if (placementIsObject(read.plugins[i])) carriers.push(String(read.plugins[i].id))
  }
  return JSON.stringify({
    layout: layout,
    carriers: carriers.sort(),
    disabled: read.disabled.map(String).slice().sort(),
    drawer: read.drawer,
    own: read.own ? read.own.where + ":" + (typeof read.own.entry === "string" ? "bare" : "object") : ""
  })
}

// facts: { selfId, plugins: { id: { name, kinds, firstParty } } | null,
//          canCross: bool }. plugins is null until the plugin list has loaded.
function placementBoard(config, facts) {
  var selfId = facts && typeof facts.selfId === "string" ? facts.selfId : ""
  var read
  try { read = placementRead(config, selfId) } catch (error) { return null }

  var zones = { left: [], center: [], right: [], drawer: [] }
  var byId = {}
  var counts = {}
  var conflicts = []
  var known = !!(facts && facts.plugins)

  function slot(id, zone, index, settings, state, custom) {
    var result = Object.freeze({
      id: id, zone: zone, index: index, name: placementName(facts, id),
      settings: placementCopy(settings), state: state, custom: custom
    })
    zones[zone].push(result)
    if (!byId[id]) byId[id] = result
    return result
  }

  for (var s = 0; s < PLACEMENT_BAR_ZONES.length; s++) {
    var zone = PLACEMENT_BAR_ZONES[s]
    var entries = read.layout[zone]
    for (var i = 0; i < entries.length; i++) {
      var id = placementEntryId(entries[i])
      counts[id] = (counts[id] || 0) + 1
      var custom = placementIsCustom(entries[i])
      var missing = known && !custom && !facts.plugins[id]
      slot(id, zone, i, placementEntrySettings(entries[i]), missing ? "missing" : "live", custom)
    }
  }
  for (var d = 0; d < read.drawer.length; d++) {
    var stowed = read.drawer[d]
    if (counts[stowed]) conflicts.push(stowed)
    var carrier = placementCarrier(read, stowed)
    var state = "live"
    if (read.disabled.indexOf(stowed) >= 0) state = "off"
    else if (known && !facts.plugins[stowed]) state = "missing"
    // A third-party widget with no carrier is not registered: something (the
    // host's own `plugin disable`, a hand edit) dropped it. That is off.
    else if (!carrier && !placementFirstParty(facts, stowed)) state = "off"
    var stowedSlot = slot(stowed, "drawer", d, carrier ? placementEntrySettings(carrier) : {}, state, false)
    byId[stowed] = counts[stowed] ? byId[stowed] : stowedSlot
  }
  for (var z in zones) zones[z] = Object.freeze(zones[z])

  var canCross = !!(facts && facts.canCross)
  return Object.freeze({
    key: placementKeyOf(read),
    zones: Object.freeze(zones),
    byId: Object.freeze(byId),
    duplicates: Object.freeze(Object.keys(counts).filter(function(id) { return counts[id] > 1 })),
    conflicts: Object.freeze(conflicts),
    canStow: canCross && known,
    reason: !known ? "unreadable" : !canCross ? "needsBarAccess" : "",
    selfPlaced: !!read.own
  })
}

// ---- Planning ----------------------------------------------------------

function placementRefuse(reason, id) {
  return Object.freeze({ ok: false, reason: reason, note: PLACEMENT_NOTES[reason] || PLACEMENT_NOTES.invalid,
    id: id || "", noOp: false, channel: "" })
}

function placementIsIndex(value, max) {
  return typeof value === "number" && isFinite(value) && Math.floor(value) === value
    && value >= 0 && value <= max
}

function placementAnchorGap(entries, zone) {
  for (var i = 0; i < entries.length; i++) {
    if (placementEntryId(entries[i]) === PLACEMENT_ANCHORS[zone]) return i + 1
  }
  return entries.length
}

// The canonical text of each region, to tell which ones a plan touched. Our
// own entry is its own region even though it sits inside the layout (or
// plugins[]): a change to it alone is what the public writer can make.
function placementRegions(read, selfId) {
  return {
    layout: JSON.stringify(placementStripOwn(read.layout, selfId)),
    plugins: JSON.stringify(read.plugins.map(function(entry) {
      return placementIsObject(entry) && String(entry.id) === selfId ? selfId : entry
    })),
    disabled: JSON.stringify(read.disabled),
    own: JSON.stringify(read.own ? read.own.entry : null)
  }
}

// Write the drawer list into every copy of Omniplug's own entry. A bare-string
// own entry becomes an object; updateEntryInline could not have reached it.
function placementWriteOwn(next, selfId, drawer) {
  var wrote = false
  for (var s = 0; s < PLACEMENT_BAR_ZONES.length; s++) {
    var entries = next.bar.layout[PLACEMENT_BAR_ZONES[s]]
    for (var i = 0; i < entries.length; i++) {
      if (placementEntryId(entries[i]) !== selfId) continue
      var entry = placementIsObject(entries[i]) ? entries[i] : { id: selfId }
      entry.drawer = drawer.slice()
      entries[i] = entry
      wrote = true
    }
  }
  if (wrote) return true
  for (var p = 0; p < next.plugins.length; p++) {
    if (placementIsObject(next.plugins[p]) && String(next.plugins[p].id) === selfId) {
      next.plugins[p].drawer = drawer.slice()
      return true
    }
  }
  return false
}

function placementSetDisabled(next, id, off) {
  var list = next.disabledPlugins.filter(function(item) { return item !== id })
  if (off) list.push(id)
  next.disabledPlugins = list
}

function placementFindCarrierIndex(next, id) {
  for (var i = 0; i < next.plugins.length; i++) {
    if (placementIsObject(next.plugins[i]) && String(next.plugins[i].id) === id) return i
  }
  return -1
}

function placementUpsertCarrier(next, id, settings) {
  var index = placementFindCarrierIndex(next, id)
  var carrier = { id: id }
  var base = index >= 0 ? placementEntrySettings(next.plugins[index]) : {}
  for (var key in base) carrier[key] = base[key]
  for (var over in settings) carrier[over] = settings[over]
  if (index >= 0) next.plugins[index] = carrier
  else next.plugins.push(carrier)
}

function placementDropCarrier(next, id, keepMarker) {
  var index = placementFindCarrierIndex(next, id)
  if (index < 0) return
  if (keepMarker) next.plugins[index] = { id: id }
  else next.plugins.splice(index, 1)
}

function placementOtherKinds(facts, id) {
  var plugin = facts && facts.plugins ? facts.plugins[id] : null
  var kinds = plugin && Array.isArray(plugin.kinds) ? plugin.kinds : []
  return kinds.some(function(kind) { return kind !== "bar-widget" })
}

function placementIsBarWidget(facts, id) {
  var plugin = facts && facts.plugins ? facts.plugins[id] : null
  return !!plugin && Array.isArray(plugin.kinds) && plugin.kinds.indexOf("bar-widget") >= 0
}

// Host-valid does not always mean argv-representable: NUL, unpaired UTF-16,
// and >=128 KiB UTF-8 arguments cannot safely traverse the omarchy-bar CLI.
function placementTransportable(id) {
  try {
    return id.indexOf("\u0000") < 0
      && encodeURIComponent(id).replace(/%[0-9A-F]{2}/g, "x").length < 131072
  } catch (error) { return false }
}

// config: the live shell config. intent: { id, to, gap?, from?: {zone, index},
// key? }. Returns a frozen plan:
//   { ok, reason, note, id, noOp, channel: "own" | "config" | "cli",
//     next, ownSettings, command, expectedKey, expectedLayout }
// `next` is the whole config after the change. Channel "own" means only
// Omniplug's own entry changed (write ownSettings with updateEntryInline);
// "config" needs the in-process writer; "cli" is a bar-only move for
// omarchy-bar when the writer cannot be reached.
function placementPlan(config, facts, intent) {
  var selfId = facts && typeof facts.selfId === "string" ? facts.selfId : ""
  if (!placementIsObject(intent) || !placementValidId(intent.id)
      || PLACEMENT_TARGETS.indexOf(intent.to) < 0) return placementRefuse("invalid")
  var id = intent.id
  // Omniplug moves around the bar like anything else; it just cannot hold
  // itself, be switched off from its own drawer, or be forgotten by it.
  if (id === selfId && PLACEMENT_BAR_ZONES.indexOf(intent.to) < 0) return placementRefuse("self", id)

  var read
  try { read = placementRead(config, selfId) }
  catch (error) { return placementRefuse(String(error.message) === "limits" ? "limits" : "unreadable", id) }
  if (!read.own) return placementRefuse("unreadable", id)
  var key = placementKeyOf(read)
  if (intent.key !== undefined && intent.key !== key) return placementRefuse("stale", id)

  var board = placementBoard(config, facts)
  if (!board) return placementRefuse("unreadable", id)
  if (board.conflicts.indexOf(id) >= 0) return placementRefuse("conflict", id)

  // Where the widget is now. A positional intent names the exact entry the
  // user dragged; a by-id intent takes the widget's one placement.
  var from = null
  if (intent.from !== undefined) {
    if (!placementIsObject(intent.from) || PLACEMENT_ZONES.indexOf(intent.from.zone) < 0)
      return placementRefuse("invalid", id)
    var zoneSlots = board.zones[intent.from.zone]
    if (!placementIsIndex(intent.from.index, zoneSlots.length - 1)
        || zoneSlots[intent.from.index].id !== id) return placementRefuse("stale", id)
    from = { zone: intent.from.zone, index: intent.from.index }
  } else if (board.byId[id]) {
    if (board.duplicates.indexOf(id) >= 0 && intent.to !== "drawer") return placementRefuse("duplicate", id)
    from = { zone: board.byId[id].zone, index: board.byId[id].index }
  }

  var to = intent.to
  var fromBar = !!from && from.zone !== "drawer"
  var fromDrawer = !!from && from.zone === "drawer"
  var toBar = PLACEMENT_BAR_ZONES.indexOf(to) >= 0

  if ((to === "off" || to === "remove") && !fromDrawer)
    return placementRefuse(from ? "notStowed" : "notPlaced", id)
  if (toBar && !from) return placementRefuse("notPlaced", id)

  var next = placementThaw({
    bar: { layout: read.layout },
    plugins: read.plugins,
    disabledPlugins: read.disabled
  })
  var drawer = read.drawer.slice()
  var destination = to === "drawer" ? drawer : toBar ? next.bar.layout[to] : null
  if (intent.gap !== undefined && (!destination || !placementIsIndex(intent.gap, destination.length)))
    return placementRefuse("invalid", id)

  var note = ""
  var cliIndex = -1
  if (fromBar && toBar) {
    var entries = next.bar.layout[from.zone]
    var gap = intent.gap !== undefined ? intent.gap
      : from.zone === to ? from.index : placementAnchorGap(next.bar.layout[to], to)
    var target = gap - (from.zone === to && gap > from.index ? 1 : 0)
    var moved = entries.splice(from.index, 1)[0]
    next.bar.layout[to].splice(target, 0, moved)
    cliIndex = target
    note = from.zone === to ? "Moved within the " + to + " section." : "Moved to the " + to + " section."
  } else if (fromBar && to === "drawer") {
    var entry = read.layout[from.zone][from.index]
    if (placementIsCustom(entry)) return placementRefuse("notStowable", id)
    if (board.duplicates.indexOf(id) >= 0) return placementRefuse("duplicate", id)
    if (facts && facts.plugins && facts.plugins[id] && !placementIsBarWidget(facts, id))
      return placementRefuse("notStowable", id)
    if (placementFirstParty(facts, id)) {
      var builtins = 0
      for (var s = 0; s < PLACEMENT_BAR_ZONES.length; s++) {
        var section = read.layout[PLACEMENT_BAR_ZONES[s]]
        for (var b = 0; b < section.length; b++) {
          var other = placementEntryId(section[b])
          if (other !== id && !placementIsCustom(section[b]) && placementFirstParty(facts, other)) builtins++
        }
      }
      if (builtins === 0) return placementRefuse("lastBuiltin", id)
    }
    next.bar.layout[from.zone].splice(from.index, 1)
    placementUpsertCarrier(next, id, placementEntrySettings(entry))
    placementSetDisabled(next, id, false)
    drawer.splice(intent.gap !== undefined ? intent.gap : drawer.length, 0, id)
    note = "Stowed " + placementName(facts, id) + " in the drawer."
  } else if (fromDrawer && toBar) {
    var carrier = placementCarrier(read, id)
    var settings = carrier ? placementEntrySettings(carrier) : {}
    var placed = { id: id }
    for (var k in settings) placed[k] = settings[k]
    var barGap = intent.gap !== undefined ? intent.gap : placementAnchorGap(next.bar.layout[to], to)
    next.bar.layout[to].splice(barGap, 0, placed)
    placementDropCarrier(next, id, placementOtherKinds(facts, id))
    placementSetDisabled(next, id, false)
    drawer.splice(from.index, 1)
    note = "Put " + placementName(facts, id) + " back in the " + to + " section."
  } else if (to === "drawer") {
    if (!from) {
      if (!placementIsBarWidget(facts, id)) return placementRefuse("notStowable", id)
      drawer.splice(intent.gap !== undefined ? intent.gap : drawer.length, 0, id)
      note = "Added " + placementName(facts, id) + " to the drawer."
    } else {
      // Already stowed: reorder, and turn it back on if it was off. A gap is
      // counted before removal, like every other drop.
      var drawerGap = intent.gap !== undefined ? intent.gap : from.index
      var drawerTarget = drawerGap - (drawerGap > from.index ? 1 : 0)
      drawer.splice(drawerTarget, 0, drawer.splice(from.index, 1)[0])
      note = drawerTarget === from.index ? "" : "Moved within the drawer."
    }
    // Turning on: a third-party widget only loads with a carrier. A built-in
    // loads regardless, so it gets none unless it already had one.
    if ((!from || board.byId[id].state === "off") && !placementFirstParty(facts, id)
        && placementFindCarrierIndex(next, id) < 0) next.plugins.push({ id: id })
    placementSetDisabled(next, id, false)
    if (from && board.byId[id].state === "off") note = "Turned " + placementName(facts, id) + " back on."
  } else if (to === "off") {
    placementSetDisabled(next, id, true)
    note = "Turned " + placementName(facts, id) + " off. It keeps its place in the drawer."
  } else if (to === "remove") {
    drawer.splice(from.index, 1)
    placementDropCarrier(next, id, placementOtherKinds(facts, id))
    note = "Removed " + placementName(facts, id) + " from the drawer."
  } else {
    return placementRefuse("invalid", id)
  }

  if (!placementWriteOwn(next, selfId, drawer)) return placementRefuse("unreadable", id)
  // Leave absent lists absent: a write should not add keys nobody asked for.
  if (config.plugins === undefined && next.plugins.length === 0) delete next.plugins
  if (config.disabledPlugins === undefined && next.disabledPlugins.length === 0) delete next.disabledPlugins

  var after
  try { after = placementRead(next, selfId) } catch (error) { return placementRefuse("limits", id) }
  var before = placementRegions(read, selfId)
  var changed = placementRegions(after, selfId)
  var touched = []
  for (var region in before) if (before[region] !== changed[region]) touched.push(region)
  var noOp = touched.length === 0

  // Whether a stowed widget runs is decided by plugins[] and disabledPlugins,
  // and changing those needs the plugin list (kinds, first-party) to be right.
  if (!noOp && !(facts && facts.plugins)
      && (touched.indexOf("plugins") >= 0 || touched.indexOf("disabled") >= 0))
    return placementRefuse("unreadable", id)

  // Least privilege: a change to our own object entry alone goes through the
  // public updateEntryInline; everything else needs the in-process writer; a
  // plain bar move can still use omarchy-bar when that writer is out of reach.
  var channel = ""
  var command = []
  if (noOp) channel = ""
  else if (touched.length === 1 && touched[0] === "own" && placementIsObject(read.own.entry)) channel = "own"
  else if (facts && facts.canCross) channel = "config"
  else if (touched.length === 1 && touched[0] === "layout" && fromBar && toBar) {
    if (!placementTransportable(id)) return placementRefuse("untransportable", id)
    channel = "cli"
    command = ["omarchy-bar", "move", id, "--from-section", from.zone, "--from-index", String(from.index),
      "--section", to, "--index", String(cliIndex)]
  } else return placementRefuse("needsBarAccess", id)

  var ownEntry = placementOwnEntryOf(next, selfId)
  return Object.freeze({
    ok: true, reason: "", note: noOp ? "" : note, id: id, noOp: noOp, channel: channel,
    touched: Object.freeze(touched),
    intent: placementCopy({ id: id, to: to, gap: intent.gap === undefined ? null : intent.gap,
      from: intent.from === undefined ? null : from }),
    baseKey: key,
    next: placementCopy(next),
    ownSettings: ownEntry ? placementCopy(placementEntrySettings(ownEntry)) : null,
    command: Object.freeze(command),
    expectedKey: placementKeyOf(after),
    expectedLayout: JSON.stringify(after.layout)
  })
}

function placementStripOwn(layout, selfId) {
  var result = {}
  for (var s = 0; s < PLACEMENT_BAR_ZONES.length; s++) {
    result[PLACEMENT_BAR_ZONES[s]] = layout[PLACEMENT_BAR_ZONES[s]].map(function(entry) {
      return placementEntryId(entry) === selfId ? selfId : entry
    })
  }
  return result
}

function placementOwnEntryOf(config, selfId) {
  for (var s = 0; s < PLACEMENT_BAR_ZONES.length; s++) {
    var entries = config.bar.layout[PLACEMENT_BAR_ZONES[s]]
    for (var i = 0; i < entries.length; i++) {
      if (placementEntryId(entries[i]) === selfId) return placementIsObject(entries[i]) ? entries[i] : { id: selfId }
    }
  }
  var plugins = config.plugins || []
  for (var p = 0; p < plugins.length; p++) {
    if (placementIsObject(plugins[p]) && String(plugins[p].id) === selfId) return plugins[p]
  }
  return null
}

// For the in-process writer's mutator: plan the same intent again against the
// host's own mutable copy and write placement's regions into it, leaving every
// key placement does not own untouched. Re-planning means settings a widget
// saved after the first plan are carried, not overwritten (the key ignores
// settings). Throws, so the host persists nothing, unless the copy still has
// the ids and positions the plan was made from. Returns the fresh plan.
function placementAssign(copy, plan, facts) {
  if (!plan || !plan.ok || !plan.intent) throw new Error("stale")
  var intent = { id: plan.intent.id, to: plan.intent.to, key: plan.baseKey }
  if (plan.intent.gap !== null) intent.gap = plan.intent.gap
  if (plan.intent.from !== null) intent.from = { zone: plan.intent.from.zone, index: plan.intent.from.index }
  var fresh = placementPlan(copy, facts, intent)
  if (!fresh.ok) throw new Error(fresh.reason === "stale" ? "stale" : "refused: " + fresh.reason)
  if (fresh.expectedKey !== plan.expectedKey) throw new Error("stale")
  var next = placementThaw(fresh.next)
  copy.bar.layout = next.bar.layout
  if (next.plugins !== undefined) copy.plugins = next.plugins
  else delete copy.plugins
  if (next.disabledPlugins !== undefined) copy.disabledPlugins = next.disabledPlugins
  else delete copy.disabledPlugins
  return fresh
}
