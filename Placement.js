// Placement: which zone every widget lives in, and the one shell.json change
// that moves it somewhere else.
//
// Pure. Nothing here touches the host; the QML owner (PlacementOwner.qml)
// reads the config through a port, asks for a plan, and hands the plan to a
// write channel. The design lives in docs/design/m1-drawer.md and
// docs/design/m2-stacks.md; the words used here (zone, entry, carrier, board,
// intent, stack, card, stack store) are defined in their glossaries.
//
// The zones are the three bar sections plus stacks. Where each is stored:
//   left/center/right  bar.layout, exactly as the host keeps it
//   stack              a stack is an Omniplug bar entry `{id, stack: sid}`,
//                      written once and never changed (Omniplug's id is on the
//                      bar more than once, so any change to one of its entries
//                      rebuilds the whole bar). What it shows lives in the
//                      stack store, Omniplug's plugins[] entry:
//                      `{id, stacks: {sid: {width, dots, cards: [[id, ...]]}}}`
// and the two host lists that decide whether a stacked widget runs at all:
//   plugins[]          a carrier `{id, ...settings}` per stacked widget. It
//                      keeps a third-party widget enabled (PluginRegistry
//                      looks for an entry in the layout or plugins[]), and it
//                      is where the widget's own updateEntryInline saves land
//                      while it is off the bar
//   disabledPlugins    an id here is off. The host checks this list first, for
//                      first- and third-party widgets alike, so a stacked
//                      widget turned off keeps both its card spot and carrier
//
// M1 kept stowed widgets in `drawer: [id, ...]` on Omniplug's own (icon)
// entry. That list is read as `legacyDrawer`, and the migrateDrawer intent
// turns it into a stack.

var PLACEMENT_BAR_ZONES = ["left", "center", "right"]
var PLACEMENT_TARGETS = ["left", "center", "right", "stack", "off", "on", "remove", "none"]
var PLACEMENT_OPS = ["newStack", "deleteStack", "stackSettings", "migrateDrawer", "selfSetting"]

var PLACEMENT_MAX_SECTION = 128
var PLACEMENT_MAX_LEGACY = 64
var PLACEMENT_MAX_LIST = 1024
var PLACEMENT_MAX_NODES = 32768
var PLACEMENT_MAX_UNITS = 1048576
var PLACEMENT_MAX_STACKS = 32
var PLACEMENT_MAX_CARDS = 16
var PLACEMENT_MAX_CARD = 32
var PLACEMENT_MAX_STACKED = 64
var PLACEMENT_MIN_WIDTH = 24
var PLACEMENT_MAX_WIDTH = 1200
var PLACEMENT_DEFAULT_WIDTH = 160

// Where an unanchored bar insertion lands: after the widget that usually opens
// each section, else at its end. Today's popup section choice uses the same.
var PLACEMENT_ANCHORS = { left: "omarchy.workspaces", center: "omarchy.weather", right: "omarchy.tray" }

var PLACEMENT_NOTES = {
  stale: "The bar changed since this was shown. Nothing was moved.",
  busy: "Another change is still being saved. Nothing was moved.",
  invalid: "That move is not possible. Nothing was moved.",
  self: "Omniplug and its stacks cannot go inside a stack.",
  notStowable: "Only plain bar widgets can go in a stack or come off the bar here. Nothing was moved.",
  lastBuiltin: "Keep one Omarchy widget on the bar: stacks find the bar through it.",
  duplicate: "This widget is on the bar more than once. Remove the extra copy first.",
  conflict: "This widget is both on the bar and in a stack. Move one copy by hand first.",
  needsBarAccess: "Omniplug cannot reach the bar right now, so it cannot change stacks.",
  untransportable: "This entry ID cannot be passed to omarchy-bar. Nothing was moved.",
  limits: "The shell config is too large to change safely. Nothing was moved.",
  unreadable: "The shell config or plugin list could not be read whole. Nothing was moved.",
  notStowed: "That widget is not in a stack.",
  notPlaced: "That widget is not placed anywhere yet.",
  noStack: "That stack does not exist any more. Nothing was moved.",
  full: "That stack is full. Nothing was moved.",
  noLegacy: "There is nothing left from the old drawer to move."
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

function placementValidSid(sid) {
  return typeof sid === "string" && /^[A-Za-z0-9_-]{1,16}$/.test(sid)
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

// The stack an entry is, or "": only Omniplug's own entries can be stacks.
function placementStackOf(entry, selfId) {
  if (!placementIsObject(entry) || placementEntryId(entry) !== selfId) return ""
  return typeof entry.stack === "string" ? entry.stack : ""
}

// A bounded, frozen deep copy: the only shape of host data this file ever
// keeps. Keys are sorted, so two reads compare by content, unless keepOrder
// is set: a config written back to shell.json keeps the order people and the
// host gave it ("id" first). Throws on anything JSON cannot say or on runaway
// size.
function placementCopy(value, keepOrder) {
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
    if (!array && !keepOrder) keys.sort()
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

function placementWidth(value) {
  return typeof value === "number" && isFinite(value)
    ? Math.round(Math.max(PLACEMENT_MIN_WIDTH, Math.min(PLACEMENT_MAX_WIDTH, value))) : PLACEMENT_DEFAULT_WIDTH
}

// ---- Reading -----------------------------------------------------------

// The parts of shell.json placement cares about, validated and frozen, or a
// thrown "invalid"/"limits". Omniplug's own entry (the icon) is its first
// layout entry that is not a stack.
function placementRead(config, selfId) {
  if (!placementIsObject(config) || !placementIsObject(config.bar)
      || !placementIsObject(config.bar.layout)) throw new Error("invalid")
  var layoutKeys = Object.keys(config.bar.layout)
  if (layoutKeys.length !== 3) throw new Error("invalid")
  var layout = {}
  var stackEntries = []
  var seenSid = {}
  var own = null
  for (var s = 0; s < PLACEMENT_BAR_ZONES.length; s++) {
    var zone = PLACEMENT_BAR_ZONES[s]
    var section = config.bar.layout[zone]
    if (!Array.isArray(section) || section.length > PLACEMENT_MAX_SECTION) throw new Error("invalid")
    for (var i = 0; i < section.length; i++) {
      var id = placementEntryId(section[i])
      if (!placementValidId(id)) throw new Error("invalid")
      if (id !== selfId) continue
      if (placementIsObject(section[i]) && section[i].stack !== undefined) {
        var sid = section[i].stack
        // Two bar entries showing one stack would host its widgets twice.
        if (!placementValidSid(sid) || seenSid[sid]) throw new Error("invalid")
        seenSid[sid] = true
        stackEntries.push({ sid: sid, zone: zone, index: i })
      } else if (!own) {
        own = { where: "layout", entry: section[i] }
      }
    }
    layout[zone] = section
  }
  var plugins = config.plugins === undefined ? [] : config.plugins
  var disabled = config.disabledPlugins === undefined ? [] : config.disabledPlugins
  if (!Array.isArray(plugins) || plugins.length > PLACEMENT_MAX_LIST) throw new Error("invalid")
  if (!Array.isArray(disabled) || disabled.length > PLACEMENT_MAX_LIST) throw new Error("invalid")

  var store = null
  for (var p = 0; p < plugins.length; p++) {
    if (placementIsObject(plugins[p]) && String(plugins[p].id) === selfId) { store = plugins[p]; break }
  }

  // M1's drawer list, on the icon or (when Omniplug was not on the bar) on
  // its plugins[] entry.
  var legacy = []
  var legacySource = own ? placementEntrySettings(own.entry) : store ? placementEntrySettings(store) : {}
  if (legacySource.drawer !== undefined) {
    if (!Array.isArray(legacySource.drawer) || legacySource.drawer.length > PLACEMENT_MAX_LEGACY)
      throw new Error("invalid")
    var seenLegacy = {}
    for (var d = 0; d < legacySource.drawer.length; d++) {
      var stowed = legacySource.drawer[d]
      if (!placementValidId(stowed) || seenLegacy[stowed]) throw new Error("invalid")
      seenLegacy[stowed] = true
      legacy.push(stowed)
    }
  }

  // Stack definitions. An id is in at most one card of one stack; a hand edit
  // that repeats one is not something to guess about. Empty cards are skipped.
  var stacks = {}
  var stacked = {}
  var total = 0
  var defs = store && store.stacks !== undefined ? store.stacks : {}
  if (!placementIsObject(defs)) throw new Error("invalid")
  var sids = Object.keys(defs)
  if (sids.length > PLACEMENT_MAX_STACKS * 2) throw new Error("invalid")
  for (var k = 0; k < sids.length; k++) {
    var def = defs[sids[k]]
    if (!placementValidSid(sids[k]) || !placementIsObject(def)) throw new Error("invalid")
    var rawCards = def.cards === undefined ? [] : def.cards
    if (!Array.isArray(rawCards) || rawCards.length > PLACEMENT_MAX_CARDS) throw new Error("invalid")
    var cards = []
    for (var c = 0; c < rawCards.length; c++) {
      var card = rawCards[c]
      if (!Array.isArray(card) || card.length > PLACEMENT_MAX_CARD) throw new Error("invalid")
      for (var w = 0; w < card.length; w++) {
        if (!placementValidId(card[w]) || stacked[card[w]] || card[w] === selfId) throw new Error("invalid")
        stacked[card[w]] = true
      }
      total += card.length
      if (card.length > 0) cards.push(card)
    }
    if (total > PLACEMENT_MAX_STACKED) throw new Error("invalid")
    stacks[sids[k]] = { width: placementWidth(def.width), dots: def.dots !== false, cards: cards }
  }

  return placementCopy({
    layout: layout,
    plugins: plugins,
    disabled: disabled,
    own: own,
    store: store,
    stackEntries: stackEntries,
    stacks: stacks,
    legacy: legacy
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

// The compare-and-swap key: ids and positions only. Settings (a widget's own,
// a stack's width) are re-read from the live config when the change is
// applied, so a widget saving its own state mid-drag does not make the user's
// move stale.
function placementKeyOf(read, selfId) {
  var layout = {}
  for (var s = 0; s < PLACEMENT_BAR_ZONES.length; s++) {
    layout[PLACEMENT_BAR_ZONES[s]] = read.layout[PLACEMENT_BAR_ZONES[s]].map(function(entry) {
      var sid = placementStackOf(entry, selfId)
      return sid ? placementEntryId(entry) + "#" + sid : placementEntryId(entry)
    })
  }
  var carriers = []
  for (var i = 0; i < read.plugins.length; i++) {
    if (placementIsObject(read.plugins[i])) carriers.push(String(read.plugins[i].id))
  }
  var cards = {}
  for (var sid in read.stacks) cards[sid] = read.stacks[sid].cards
  return JSON.stringify({
    layout: layout,
    carriers: carriers.sort(),
    disabled: read.disabled.map(String).slice().sort(),
    stacks: cards,
    legacy: read.legacy,
    own: read.own ? (typeof read.own.entry === "string" ? "bare" : "object") : ""
  })
}

// The stacks in bar order, then the definitions no bar entry shows (orphans).
function placementStackOrder(read) {
  var onBar = read.stackEntries.map(function(entry) { return entry.sid })
  var orphans = Object.keys(read.stacks).filter(function(sid) { return onBar.indexOf(sid) < 0 }).sort()
  return { onBar: onBar, orphans: orphans }
}

// facts: { selfId, plugins: { id: { name, kinds, firstParty } } | null,
//          canCross: bool, partial: bool }. plugins is null until the plugin
// list has loaded. partial means `config` holds only what the scoped facade
// can see (the bar), so plugins[], disabledPlugins and the stack store are
// unknown, not empty.
function placementBoard(config, facts) {
  var selfId = facts && typeof facts.selfId === "string" ? facts.selfId : ""
  var read
  try { read = placementRead(config, selfId) } catch (error) { return null }

  var zones = { left: [], center: [], right: [] }
  var byId = {}
  var counts = {}
  var conflicts = []
  var known = !!(facts && facts.plugins)
  var partial = !!(facts && facts.partial)

  function freezeSlot(fields) {
    fields.name = placementName(facts, fields.id)
    fields.settings = placementCopy(fields.settings)
    return Object.freeze(fields)
  }

  for (var s = 0; s < PLACEMENT_BAR_ZONES.length; s++) {
    var zone = PLACEMENT_BAR_ZONES[s]
    var entries = read.layout[zone]
    for (var i = 0; i < entries.length; i++) {
      var id = placementEntryId(entries[i])
      var sid = placementStackOf(entries[i], selfId)
      counts[id] = (counts[id] || 0) + 1
      var custom = placementIsCustom(entries[i])
      var missing = known && !custom && !facts.plugins[id]
      var slot = freezeSlot({ id: id, zone: zone, index: i, settings: placementEntrySettings(entries[i]),
        state: missing ? "missing" : "live", custom: custom, stack: sid })
      zones[zone].push(slot)
      if (!byId[id]) byId[id] = slot
    }
  }

  function stackOf(sid, zone, index) {
    var def = read.stacks[sid] || { width: PLACEMENT_DEFAULT_WIDTH, dots: true, cards: [] }
    var cards = def.cards.map(function(card, c) {
      return Object.freeze(card.map(function(member, w) {
        var carrier = placementCarrier(read, member)
        var state = "live"
        if (read.disabled.indexOf(member) >= 0) state = "off"
        else if (known && !facts.plugins[member]) state = "missing"
        // A third-party widget with no carrier is not registered: something
        // (the host's own `plugin disable`, a hand edit) dropped it. That is off.
        else if (!partial && !carrier && !placementFirstParty(facts, member)) state = "off"
        if (counts[member] && conflicts.indexOf(member) < 0) conflicts.push(member)
        var slot = freezeSlot({ id: member, zone: "stack", index: w, stack: sid, card: c,
          settings: carrier ? placementEntrySettings(carrier) : {}, state: state, custom: false })
        if (!counts[member]) byId[member] = slot
        return slot
      }))
    })
    return Object.freeze({ sid: sid, zone: zone, index: index, width: def.width, dots: def.dots,
      cards: Object.freeze(cards) })
  }

  var stacks = read.stackEntries.map(function(entry) { return stackOf(entry.sid, entry.zone, entry.index) })
  var order = placementStackOrder(read)
  var orphans = order.orphans.map(function(sid) { return stackOf(sid, "", -1) })
  for (var z in zones) zones[z] = Object.freeze(zones[z])

  // Bar widgets placed nowhere: neither on the bar nor in a stack. Some are
  // simply off; others still have a plugins[] entry (a carrier, or one that
  // keeps another kind of theirs enabled), which the host's own enable reads
  // as "already placed" and so cannot bring back. Only Placement can.
  var unplaced = []
  if (known) {
    for (var pid in facts.plugins) {
      var kinds = facts.plugins[pid] && Array.isArray(facts.plugins[pid].kinds) ? facts.plugins[pid].kinds : []
      if (pid === selfId || byId[pid] || kinds.indexOf("bar-widget") < 0 || kinds.indexOf("bar") >= 0) continue
      if (!placementValidId(pid)) continue
      var held = partial ? null : placementCarrier(read, pid)
      unplaced.push(freezeSlot({ id: pid, zone: "none", index: -1, stack: "", custom: false,
        settings: held ? placementEntrySettings(held) : {}, carried: !!held,
        state: read.disabled.indexOf(pid) >= 0 ? "off" : "live" }))
    }
    unplaced.sort(function(a, b) { return a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1) })
  }

  var canCross = !!(facts && facts.canCross)
  return Object.freeze({
    key: placementKeyOf(read, selfId),
    zones: Object.freeze(zones),
    stacks: Object.freeze(stacks),
    orphans: Object.freeze(orphans),
    byId: Object.freeze(byId),
    duplicates: Object.freeze(Object.keys(counts).filter(function(id) {
      return counts[id] > 1 && id !== selfId
    })),
    conflicts: Object.freeze(conflicts),
    unplaced: Object.freeze(unplaced),
    legacyDrawer: read.legacy,
    canStow: canCross && known && !partial,
    reason: !known ? "unreadable" : !canCross || partial ? "needsBarAccess" : "",
    selfPlaced: !!read.own
  })
}

// The board's stack (on the bar or orphaned) with this sid, or null.
function placementFindStack(board, sid) {
  for (var i = 0; i < board.stacks.length; i++) if (board.stacks[i].sid === sid) return board.stacks[i]
  for (var j = 0; j < board.orphans.length; j++) if (board.orphans[j].sid === sid) return board.orphans[j]
  return null
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

// The canonical text of each region, to tell which ones a plan touched.
function placementRegions(read) {
  return {
    layout: JSON.stringify(read.layout),
    plugins: JSON.stringify(read.plugins),
    disabled: JSON.stringify(read.disabled)
  }
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

// The lowest unused stack id, counting both bar entries and definitions.
function placementNewSid(read) {
  var used = {}
  for (var i = 0; i < read.stackEntries.length; i++) used[read.stackEntries[i].sid] = true
  for (var sid in read.stacks) used[sid] = true
  for (var n = 1; n <= PLACEMENT_MAX_STACKS * 2 + 1; n++) if (!used["s" + n]) return "s" + n
  return ""
}

// Write the working stack definitions into the stack store, creating it only
// when there is something to keep. An emptied store keeps its `{id}`: it may
// be what keeps Omniplug enabled when it is not on the bar.
function placementWriteStore(next, selfId, stacks, dropLegacy) {
  var index = placementFindCarrierIndex(next, selfId)
  var sids = Object.keys(stacks).sort()
  if (index < 0 && sids.length === 0) return
  var entry = index >= 0 ? next.plugins[index] : { id: selfId }
  if (dropLegacy) delete entry.drawer
  if (sids.length === 0) delete entry.stacks
  else {
    var out = {}
    for (var i = 0; i < sids.length; i++) {
      var def = stacks[sids[i]]
      out[sids[i]] = { width: def.width, dots: def.dots,
        cards: def.cards.filter(function(card) { return card.length > 0 }) }
    }
    entry.stacks = out
  }
  if (index < 0) next.plugins.push(entry)
}

// Every icon entry (Omniplug's own entries that are not stacks).
function placementEachIcon(next, selfId, fn) {
  for (var s = 0; s < PLACEMENT_BAR_ZONES.length; s++) {
    var entries = next.bar.layout[PLACEMENT_BAR_ZONES[s]]
    for (var i = 0; i < entries.length; i++) {
      if (placementEntryId(entries[i]) !== selfId || placementStackOf(entries[i], selfId)) continue
      var entry = placementIsObject(entries[i]) ? entries[i] : { id: selfId }
      fn(entry)
      entries[i] = entry
    }
  }
}

function placementCountStacked(stacks) {
  var total = 0
  for (var sid in stacks) for (var c = 0; c < stacks[sid].cards.length; c++) total += stacks[sid].cards[c].length
  return total
}

// A bar entry may go into a stack: the checks M1 made for stowing.
function placementStowRefusal(read, board, facts, id, entry) {
  if (placementIsCustom(entry)) return "notStowable"
  if (board.duplicates.indexOf(id) >= 0) return "duplicate"
  if (facts && facts.plugins && facts.plugins[id] && !placementIsBarWidget(facts, id)) return "notStowable"
  if (placementFirstParty(facts, id)) {
    var builtins = 0
    for (var s = 0; s < PLACEMENT_BAR_ZONES.length; s++) {
      var section = read.layout[PLACEMENT_BAR_ZONES[s]]
      for (var b = 0; b < section.length; b++) {
        var other = placementEntryId(section[b])
        if (other !== id && !placementIsCustom(section[b]) && placementFirstParty(facts, other)) builtins++
      }
    }
    if (builtins === 0) return "lastBuiltin"
  }
  return ""
}

// config: the live shell config. intent: a widget intent
//   { id, to, stack?, card?, gap?, from?, key? }
// or a stack intent { op, ... } (see docs/design/m2-stacks.md). Returns a
// frozen plan:
//   { ok, reason, note, id, noOp, channel: "config" | "cli", touched,
//     intent, baseKey, next, command, expectedKey, expectedLayout }
// `next` is the whole config after the change. "config" needs the in-process
// writer; "cli" is a bar-only move for omarchy-bar when the writer cannot be
// reached.
function placementPlan(config, facts, intent) {
  var selfId = facts && typeof facts.selfId === "string" ? facts.selfId : ""
  if (!placementIsObject(intent)) return placementRefuse("invalid")
  var isOp = intent.op !== undefined
  if (isOp ? PLACEMENT_OPS.indexOf(intent.op) < 0
      : !placementValidId(intent.id) || PLACEMENT_TARGETS.indexOf(intent.to) < 0) return placementRefuse("invalid")
  var id = isOp ? "" : intent.id
  // Omniplug moves around the bar like anything else (its icon and its
  // stacks alike); it just cannot go into a stack or be switched off there.
  if (!isOp && id === selfId && PLACEMENT_BAR_ZONES.indexOf(intent.to) < 0) return placementRefuse("self", id)

  var read
  try { read = placementRead(config, selfId) }
  catch (error) { return placementRefuse(String(error.message) === "limits" ? "limits" : "unreadable", id) }
  var key = placementKeyOf(read, selfId)
  if (intent.key !== undefined && intent.key !== key) return placementRefuse("stale", id)

  var board = placementBoard(config, facts)
  if (!board) return placementRefuse("unreadable", id)
  var partial = !!(facts && facts.partial)

  var next = placementThaw({
    bar: { layout: read.layout },
    plugins: read.plugins,
    disabledPlugins: read.disabled
  })
  var stacks = placementThaw(read.stacks)
  var dropLegacy = false
  var note = ""
  var cliIndex = -1
  var from = null
  var to = isOp ? "" : intent.to
  var normalized = null

  if (isOp) {
    var op = intent.op
    // The stack store is invisible to a partial read.
    if (partial) return placementRefuse("needsBarAccess")
    normalized = { op: op }
    if (op === "newStack" || op === "migrateDrawer") {
      var section = intent.section === undefined ? "right" : intent.section
      if (PLACEMENT_BAR_ZONES.indexOf(section) < 0) return placementRefuse("invalid")
      if (op === "migrateDrawer" && read.legacy.length === 0) return placementRefuse("noLegacy")
      if (read.stackEntries.length >= PLACEMENT_MAX_STACKS) return placementRefuse("full")
      var sid = placementNewSid(read)
      if (!sid) return placementRefuse("full")
      var def = { width: PLACEMENT_DEFAULT_WIDTH, dots: true, cards: [] }
      var makeStack = true
      if (op === "migrateDrawer") {
        // A widget already on the bar or in a stack stays where it is: a
        // conflict is never guessed about. When every one of them is placed
        // already, the old list goes and no empty stack is made.
        var moving = read.legacy.filter(function(member) { return !board.byId[member] && member !== selfId })
        for (var m = 0; m < moving.length; m += PLACEMENT_MAX_CARD)
          def.cards.push(moving.slice(m, m + PLACEMENT_MAX_CARD))
        if (placementCountStacked(stacks) + moving.length > PLACEMENT_MAX_STACKED) return placementRefuse("full")
        placementEachIcon(next, selfId, function(entry) { delete entry.drawer })
        dropLegacy = true
        makeStack = moving.length > 0
        note = makeStack ? "Moved the old drawer's widgets into a new stack."
          : "The old drawer's widgets are already placed; its list is gone."
      } else {
        note = "Added a stack to the " + section + " section. Move it in Arrange."
      }
      if (makeStack) {
        next.bar.layout[section].push({ id: selfId, stack: sid })
        stacks[sid] = def
      }
      normalized.section = section
    } else if (op === "deleteStack" || op === "stackSettings") {
      if (!placementValidSid(intent.stack)) return placementRefuse("invalid")
      var target = placementFindStack(board, intent.stack)
      if (!target) return placementRefuse("noStack")
      normalized.stack = intent.stack
      if (op === "stackSettings") {
        if (!stacks[intent.stack]) stacks[intent.stack] = { width: target.width, dots: target.dots, cards: [] }
        if (intent.width !== undefined) {
          if (typeof intent.width !== "number" || !isFinite(intent.width)) return placementRefuse("invalid")
          stacks[intent.stack].width = placementWidth(intent.width)
          normalized.width = stacks[intent.stack].width
        }
        if (intent.dots !== undefined) {
          if (typeof intent.dots !== "boolean") return placementRefuse("invalid")
          stacks[intent.stack].dots = intent.dots
          normalized.dots = intent.dots
        }
      } else {
        // Its widgets go back to the bar where the stack was, in card order;
        // an orphan's go to the end of the right section.
        var where = target.zone || "right"
        var at = target.zone ? target.index : next.bar.layout.right.length
        if (target.zone) next.bar.layout[where].splice(at, 1)
        var returning = []
        for (var c = 0; c < target.cards.length; c++) {
          for (var w = 0; w < target.cards[c].length; w++) {
            var member = target.cards[c][w].id
            var carried = placementCarrier(read, member)
            var placed = { id: member }
            var settings = carried ? placementEntrySettings(carried) : {}
            for (var k in settings) placed[k] = settings[k]
            returning.push(Object.keys(settings).length ? placed : member)
            placementDropCarrier(next, member, placementOtherKinds(facts, member))
            placementSetDisabled(next, member, false)
          }
        }
        Array.prototype.splice.apply(next.bar.layout[where], [at, 0].concat(returning))
        delete stacks[intent.stack]
        note = returning.length ? "Deleted the stack and put its widgets back on the bar." : "Deleted the stack."
      }
    } else if (op === "selfSetting") {
      if (typeof intent.name !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(intent.name)
          || ["id", "stack", "drawer", "stacks"].indexOf(intent.name) >= 0
          || (typeof intent.value !== "boolean" && typeof intent.value !== "string" && typeof intent.value !== "number"))
        return placementRefuse("invalid")
      if (!read.own) return placementRefuse("unreadable")
      placementEachIcon(next, selfId, function(entry) { entry[intent.name] = intent.value })
      normalized.name = intent.name
      normalized.value = intent.value
    }
  } else {
    if (board.conflicts.indexOf(id) >= 0) return placementRefuse("conflict", id)

    // Where the widget is now. A positional intent names the exact entry the
    // user dragged; a by-id intent takes the widget's one placement.
    if (intent.from !== undefined) {
      if (!placementIsObject(intent.from)) return placementRefuse("invalid", id)
      var fz = intent.from.zone
      var fromSlot = null
      if (PLACEMENT_BAR_ZONES.indexOf(fz) >= 0) {
        if (!placementIsIndex(intent.from.index, board.zones[fz].length - 1)) return placementRefuse("stale", id)
        fromSlot = board.zones[fz][intent.from.index]
      } else if (fz === "stack") {
        var fromStack = placementValidSid(intent.from.stack) ? placementFindStack(board, intent.from.stack) : null
        if (!fromStack) return placementRefuse("stale", id)
        if (!placementIsIndex(intent.from.card, fromStack.cards.length - 1)) return placementRefuse("stale", id)
        var fromCard = fromStack.cards[intent.from.card]
        if (!placementIsIndex(intent.from.index, fromCard.length - 1)) return placementRefuse("stale", id)
        fromSlot = fromCard[intent.from.index]
      } else return placementRefuse("invalid", id)
      if (fromSlot.id !== id) return placementRefuse("stale", id)
      from = fz === "stack"
        ? { zone: "stack", stack: intent.from.stack, card: intent.from.card, index: intent.from.index }
        : { zone: fz, index: intent.from.index }
    } else if (board.byId[id]) {
      var known = board.byId[id]
      if (known.zone !== "stack" && board.duplicates.indexOf(id) >= 0) return placementRefuse("duplicate", id)
      from = known.zone === "stack"
        ? { zone: "stack", stack: known.stack, card: known.card, index: known.index }
        : { zone: known.zone, index: known.index }
    }

    var fromBar = !!from && from.zone !== "stack"
    var fromStacked = !!from && from.zone === "stack"
    var toBar = PLACEMENT_BAR_ZONES.indexOf(to) >= 0
    // A stack's own bar entry moves around the bar, never into a stack.
    if (fromBar && to === "stack" && board.zones[from.zone][from.index].stack) return placementRefuse("self", id)

    if ((to === "off" || to === "on" || to === "remove") && !fromStacked)
      return placementRefuse(from ? "notStowed" : "notPlaced", id)
    if (to === "none" && !from) return placementRefuse("notPlaced", id)
    // A stack's own bar entry is deleted with the stack, not taken off.
    if (to === "none" && fromBar && board.zones[from.zone][from.index].stack) return placementRefuse("self", id)
    // A widget placed nowhere can go on the bar if it is a bar widget.
    if (toBar && !from && !placementIsBarWidget(facts, id)) return placementRefuse("notPlaced", id)
    // Anything that changes a stack reads and writes the stack store, and
    // placing an unplaced widget moves its plugins[] entry; a partial read
    // cannot see either.
    if (partial && (to === "stack" || fromStacked || (toBar && !from) || to === "none"))
      return placementRefuse("needsBarAccess", id)

    // The card a "stack" intent lands in, and where.
    var destCard = null
    var destStack = null
    if (to === "stack") {
      if (!placementValidSid(intent.stack)) return placementRefuse("invalid", id)
      var onBar = null
      for (var b = 0; b < board.stacks.length; b++) if (board.stacks[b].sid === intent.stack) onBar = board.stacks[b]
      if (!onBar) return placementRefuse("noStack", id)
      if (!stacks[intent.stack]) stacks[intent.stack] = { width: onBar.width, dots: onBar.dots, cards: [] }
      destStack = stacks[intent.stack]
      if (!placementIsIndex(intent.card, destStack.cards.length)) return placementRefuse("invalid", id)
      var newCard = intent.card === destStack.cards.length
      if (newCard && destStack.cards.length >= PLACEMENT_MAX_CARDS) return placementRefuse("full", id)
      var length = newCard ? 0 : destStack.cards[intent.card].length
      if (intent.gap !== undefined && !placementIsIndex(intent.gap, length)) return placementRefuse("invalid", id)
      var sameCard = fromStacked && from.stack === intent.stack && from.card === intent.card
      if (!sameCard && length >= PLACEMENT_MAX_CARD) return placementRefuse("full", id)
      if (!fromStacked && placementCountStacked(stacks) >= PLACEMENT_MAX_STACKED) return placementRefuse("full", id)
      destCard = { card: intent.card, gap: intent.gap !== undefined ? intent.gap : length, newCard: newCard }
    } else if (toBar && intent.gap !== undefined && !placementIsIndex(intent.gap, next.bar.layout[to].length)) {
      return placementRefuse("invalid", id)
    }

    // Take the widget out of its card, leaving the (possibly empty) card in
    // place so the destination's indices still hold; empty cards go when the
    // store is written.
    function takeFromCard() {
      stacks[from.stack].cards[from.card].splice(from.index, 1)
    }

    if (fromBar && toBar) {
      var entries = next.bar.layout[from.zone]
      var gap = intent.gap !== undefined ? intent.gap
        : from.zone === to ? from.index : placementAnchorGap(next.bar.layout[to], to)
      var landing = gap - (from.zone === to && gap > from.index ? 1 : 0)
      var moved = entries.splice(from.index, 1)[0]
      next.bar.layout[to].splice(landing, 0, moved)
      cliIndex = landing
      note = from.zone === to ? "Moved within the " + to + " section." : "Moved to the " + to + " section."
    } else if (to === "stack" && !fromStacked) {
      if (fromBar) {
        var entry = read.layout[from.zone][from.index]
        var refusal = placementStowRefusal(read, board, facts, id, entry)
        if (refusal) return placementRefuse(refusal, id)
        next.bar.layout[from.zone].splice(from.index, 1)
        placementUpsertCarrier(next, id, placementEntrySettings(entry))
      } else {
        if (!placementIsBarWidget(facts, id)) return placementRefuse("notStowable", id)
        // A built-in loads without a carrier; a third-party widget needs one.
        if (!placementFirstParty(facts, id) && placementFindCarrierIndex(next, id) < 0) next.plugins.push({ id: id })
      }
      placementSetDisabled(next, id, false)
      if (destCard.newCard) destStack.cards.push([id])
      else destStack.cards[destCard.card].splice(destCard.gap, 0, id)
      note = "Put " + placementName(facts, id) + " in a stack."
    } else if (to === "stack") {
      var sameCardMove = from.stack === intent.stack && from.card === intent.card
      var cardGap = destCard.gap - (sameCardMove && destCard.gap > from.index ? 1 : 0)
      takeFromCard()
      if (destCard.newCard) destStack.cards.push([id])
      else destStack.cards[destCard.card].splice(cardGap, 0, id)
      note = sameCardMove ? "Moved within the card." : "Moved to another card."
    } else if ((fromStacked || !from) && toBar) {
      var carrier = placementCarrier(read, id)
      var carriedSettings = carrier ? placementEntrySettings(carrier) : {}
      var restored = { id: id }
      for (var key2 in carriedSettings) restored[key2] = carriedSettings[key2]
      var barGap = intent.gap !== undefined ? intent.gap : placementAnchorGap(next.bar.layout[to], to)
      next.bar.layout[to].splice(barGap, 0, Object.keys(carriedSettings).length ? restored : id)
      placementDropCarrier(next, id, placementOtherKinds(facts, id))
      placementSetDisabled(next, id, false)
      if (fromStacked) takeFromCard()
      note = "Put " + placementName(facts, id) + (fromStacked ? " back" : "") + " in the " + to + " section."
    } else if (to === "none" && fromBar) {
      // Off the bar, into "Not on the bar". Its settings, and an entry that
      // keeps its other kinds (a service, a panel) enabled, wait in plugins[]
      // for it to come back; Placement can place it again from there.
      var leaving = read.layout[from.zone][from.index]
      var leavingRefusal = placementStowRefusal(read, board, facts, id, leaving)
      if (leavingRefusal) return placementRefuse(leavingRefusal, id)
      next.bar.layout[from.zone].splice(from.index, 1)
      var kept = placementEntrySettings(leaving)
      if (Object.keys(kept).length > 0 || placementOtherKinds(facts, id)) placementUpsertCarrier(next, id, kept)
      note = "Took " + placementName(facts, id) + " off the bar."
    } else if (to === "none") {
      // Out of its card; its carrier keeps its settings.
      takeFromCard()
      note = "Took " + placementName(facts, id) + " out of its stack."
    } else if (to === "off") {
      placementSetDisabled(next, id, true)
      note = "Turned " + placementName(facts, id) + " off. It keeps its place in the stack."
    } else if (to === "on") {
      // A third-party widget only loads with a carrier. A built-in loads
      // regardless, so it gets none unless it already had one.
      if (!placementFirstParty(facts, id) && placementFindCarrierIndex(next, id) < 0) next.plugins.push({ id: id })
      placementSetDisabled(next, id, false)
      note = "Turned " + placementName(facts, id) + " back on."
    } else if (to === "remove") {
      takeFromCard()
      placementDropCarrier(next, id, placementOtherKinds(facts, id))
      note = "Removed " + placementName(facts, id) + " from its stack."
    } else {
      return placementRefuse("invalid", id)
    }
    normalized = { id: id, to: to, gap: intent.gap === undefined ? null : intent.gap, from: from,
      stack: to === "stack" ? intent.stack : null, card: to === "stack" ? intent.card : null }
  }

  if (!partial) placementWriteStore(next, selfId, stacks, dropLegacy)
  // Leave absent lists absent: a write should not add keys nobody asked for.
  if (config.plugins === undefined && next.plugins.length === 0) delete next.plugins
  if (config.disabledPlugins === undefined && next.disabledPlugins.length === 0) delete next.disabledPlugins

  var after
  try { after = placementRead(next, selfId) } catch (error) { return placementRefuse("limits", id) }
  var before = placementRegions(read)
  var changed = placementRegions(after)
  var touched = []
  for (var region in before) if (before[region] !== changed[region]) touched.push(region)
  var noOp = touched.length === 0

  // Whether a stacked widget runs is decided by plugins[] and disabledPlugins,
  // and changing those needs the plugin list (kinds, first-party) to be right.
  // Our own stack store is in plugins[] too, but needs no facts.
  var factsNeeded = touched.indexOf("disabled") >= 0
    || (touched.indexOf("plugins") >= 0 && !(isOp && (intent.op === "stackSettings" || intent.op === "newStack")))
  if (!noOp && !(facts && facts.plugins) && factsNeeded) return placementRefuse("unreadable", id)

  // The in-process writer for everything; a plain bar move can still use
  // omarchy-bar when that writer is out of reach.
  var channel = ""
  var command = []
  if (noOp) channel = ""
  else if (facts && facts.canCross && !partial) channel = "config"
  else if (!isOp && touched.length === 1 && touched[0] === "layout" && from && from.zone !== "stack"
      && PLACEMENT_BAR_ZONES.indexOf(to) >= 0) {
    if (!placementTransportable(id)) return placementRefuse("untransportable", id)
    channel = "cli"
    command = ["omarchy-bar", "move", id, "--from-section", from.zone, "--from-index", String(from.index),
      "--section", to, "--index", String(cliIndex)]
  } else return placementRefuse("needsBarAccess", id)

  return Object.freeze({
    ok: true, reason: "", note: noOp ? "" : note, id: id, noOp: noOp, channel: channel,
    touched: Object.freeze(touched),
    intent: placementCopy(normalized),
    baseKey: key,
    next: placementCopy(next, true),
    command: Object.freeze(command),
    expectedKey: placementKeyOf(after, selfId),
    expectedLayout: JSON.stringify(after.layout)
  })
}

// For the in-process writer's mutator: plan the same intent again against the
// host's own mutable copy and write placement's regions into it, leaving every
// key placement does not own untouched. Re-planning means settings a widget
// saved after the first plan are carried, not overwritten (the key ignores
// settings). Throws, so the host persists nothing, unless the copy still has
// the ids and positions the plan was made from. Returns the fresh plan.
function placementAssign(copy, plan, facts) {
  if (!plan || !plan.ok || !plan.intent) throw new Error("stale")
  var intent = { key: plan.baseKey }
  for (var field in plan.intent) {
    var value = plan.intent[field]
    if (value === null) continue
    intent[field] = value && typeof value === "object" ? placementThaw(value) : value
  }
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

// The plugin list's rows, as the facts Placement needs.
function placementFactsFromRows(rows) {
  if (!rows || !rows.length) return null
  var facts = {}
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    if (!row || typeof row.id !== "string") continue
    facts[row.id] = { name: String(row.name || row.id), kinds: row.kinds || [], firstParty: row.firstParty === true }
  }
  return facts
}

// A stack's label wherever it is listed: "Stack 2" for sid "s2".
function placementStackLabel(sid) {
  var match = /^s([0-9]+)$/.exec(String(sid || ""))
  return match ? "Stack " + match[1] : "Stack " + String(sid || "")
}
