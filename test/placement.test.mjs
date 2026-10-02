// Placement.js is loaded by QML, so it has no module system of its own; the
// tests evaluate the shipped source and exercise only its interface: the
// board it reads and the plans it makes.
import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const source = readFileSync(new URL("../Placement.js", import.meta.url), "utf8")
const P = Function(source + "; return { placementBoard, placementPlan, placementAssign, placementFactsFromRows, placementStackLabel }")()

const SELF = "io.github.h3sam.omniplug"
const plugin = (name, kinds = ["bar-widget"], firstParty = false) => ({ name, kinds, firstParty })
const PLUGINS = {
  [SELF]: plugin("Omniplug", ["bar-widget", "panel"]),
  "omarchy.clock": plugin("Clock", ["bar-widget"], true),
  "omarchy.workspaces": plugin("Workspaces", ["bar-widget"], true),
  "omarchy.tray": plugin("Tray", ["bar-widget"], true),
  "omarchy.battery": plugin("Battery", ["bar-widget"], true),
  "acme.vpn": plugin("VPN"),
  "acme.media": plugin("Media", ["bar-widget", "panel"]),
  "acme.service": plugin("Service", ["service"])
}
const facts = (over = {}) => ({ selfId: SELF, plugins: PLUGINS, canCross: true, ...over })

// A config as the host keeps it, with our icon on the right.
function config(over = {}) {
  return {
    version: 1,
    bar: {
      position: "top",
      layout: {
        left: ["omarchy.workspaces", { id: "acme.vpn", color: "red" }],
        center: [{ id: "omarchy.clock", format: "24h" }],
        right: ["omarchy.tray", { id: SELF, allowUnverifiedUpdates: true }]
      }
    },
    plugins: [],
    disabledPlugins: [],
    unrelated: { keep: true },
    ...over
  }
}

// A config with stacks: `stacks` is { sid: [[id, ...], ...] }, each shown by
// a bar entry at the end of the right section. Stacked widgets are off the
// bar by construction, so the fixture takes them out of the layout.
function withStacks(stacks, over = {}, settings = {}) {
  const c = config(over)
  const members = Object.values(stacks).flat(2)
  for (const section of ["left", "center", "right"])
    c.bar.layout[section] = c.bar.layout[section].filter(e => !members.includes(typeof e === "string" ? e : e.id))
  const defs = {}
  for (const sid of Object.keys(stacks)) {
    c.bar.layout.right.push({ id: SELF, stack: sid })
    defs[sid] = { width: 160, dots: true, cards: stacks[sid], ...(settings[sid] || {}) }
  }
  c.plugins = [{ id: SELF, stacks: defs }, ...(c.plugins || [])]
  return c
}
const storeOf = c => (c.plugins || []).find(e => e.id === SELF) || null
const cardsOf = (c, sid) => storeOf(c).stacks[sid].cards
const plan = (c, intent, f = facts()) => P.placementPlan(c, f, intent)

// ---- The board ---------------------------------------------------------

test("the board lists bar zones and stacks in order, with settings and states", () => {
  const c = withStacks({ s1: [["omarchy.battery", "acme.media"], ["gone.widget"]] }, {
    plugins: [{ id: "acme.media", volume: 3 }],
    disabledPlugins: ["omarchy.battery"]
  })
  const board = P.placementBoard(c, facts())
  assert.deepEqual(board.zones.left.map(s => s.id), ["omarchy.workspaces", "acme.vpn"])
  assert.equal(board.stacks.length, 1)
  const stack = board.stacks[0]
  assert.deepEqual([stack.sid, stack.zone, stack.index, stack.width, stack.dots], ["s1", "right", 2, 160, true])
  assert.deepEqual(stack.cards.map(card => card.map(s => [s.id, s.state])),
    [[["omarchy.battery", "off"], ["acme.media", "live"]], [["gone.widget", "missing"]]])
  assert.deepEqual(board.zones.right[2].stack, "s1", "the stack's bar entry says which stack it shows")
  assert.deepEqual(board.byId["acme.media"].settings, { volume: 3 })
  assert.deepEqual([board.byId["acme.media"].zone, board.byId["acme.media"].card, board.byId["acme.media"].index],
    ["stack", 0, 1])
  assert.equal(board.byId["omarchy.clock"].name, "Clock")
  assert.equal(board.canStow, true)
  assert.deepEqual(board.duplicates, [], "Omniplug's own id is on the bar more than once by design")
  assert.throws(() => { board.zones.left[1].settings.color = "blue" }, TypeError)
})

test("a stacked third-party widget with no carrier is off: it is not registered", () => {
  const extra = facts({ plugins: { ...PLUGINS, "acme.vpn2": plugin("VPN 2") } })
  const board = P.placementBoard(withStacks({ s1: [["acme.vpn2"]] }), extra)
  assert.equal(board.byId["acme.vpn2"].state, "off")
  const builtin = P.placementBoard(withStacks({ s1: [["omarchy.battery"]] }), facts())
  assert.equal(builtin.byId["omarchy.battery"].state, "live", "a built-in needs no carrier to load")
})

test("a stack with no definition is empty, and a definition with no bar entry is an orphan", () => {
  const c = config()
  c.bar.layout.left.push({ id: SELF, stack: "s3" })
  c.plugins = [{ id: SELF, stacks: { s1: { width: 90, dots: false, cards: [["omarchy.battery"]] } } }]
  const board = P.placementBoard(c, facts())
  assert.deepEqual(board.stacks.map(s => [s.sid, s.zone, s.cards.length]), [["s3", "left", 0]])
  assert.deepEqual(board.orphans.map(s => [s.sid, s.zone, s.index, s.width, s.dots]), [["s1", "", -1, 90, false]])
  assert.equal(board.byId["omarchy.battery"].stack, "s1")
})

test("widths are clamped, empty cards are skipped, and garbage is refused rather than guessed", () => {
  const c = withStacks({ s1: [[], ["omarchy.battery"]] }, {}, { s1: { width: 5000 } })
  const board = P.placementBoard(c, facts())
  assert.equal(board.stacks[0].width, 1200)
  assert.equal(board.stacks[0].cards.length, 1)
  assert.equal(P.placementBoard(withStacks({ s1: [["a.b"], ["a.b"]] }), facts()), null, "an id in two cards")
  assert.equal(P.placementBoard(withStacks({ s1: [["a.b"]], s2: [["a.b"]] }), facts()), null, "an id in two stacks")
  assert.equal(P.placementBoard(withStacks({ s1: [["../x"]] }), facts()), null)
  assert.equal(P.placementBoard(withStacks({ s1: [[SELF]] }), facts()), null, "Omniplug inside a stack")
  const twice = withStacks({ s1: [] })
  twice.bar.layout.left.push({ id: SELF, stack: "s1" })
  assert.equal(P.placementBoard(twice, facts()), null, "two bar entries cannot show one stack")
  const badSid = config()
  badSid.bar.layout.left.push({ id: SELF, stack: "no spaces" })
  assert.equal(P.placementBoard(badSid, facts()), null)
})

test("the board says why it cannot change stacks, and refuses to read what it cannot trust", () => {
  assert.equal(P.placementBoard(config(), facts({ canCross: false })).reason, "needsBarAccess")
  assert.equal(P.placementBoard(config(), facts({ plugins: null })).reason, "unreadable")
  assert.equal(P.placementBoard(config(), facts({ plugins: null })).canStow, false)
  assert.equal(P.placementBoard(config(), facts({ partial: true })).canStow, false)
  assert.equal(P.placementBoard({ bar: { layout: { left: [] } } }, facts()), null)
  const huge = config()
  huge.plugins = [{ id: "big", blob: "x".repeat(1048577) }]
  assert.equal(P.placementBoard(huge, facts()), null)
})

test("the board key ignores settings and widths, so saving state mid-drag is not stale", () => {
  const a = P.placementBoard(withStacks({ s1: [["omarchy.battery"]] }), facts())
  const changed = withStacks({ s1: [["omarchy.battery"]] }, {}, { s1: { width: 300, dots: false } })
  changed.bar.layout.left[1].color = "blue"
  assert.equal(P.placementBoard(changed, facts()).key, a.key)
  const moved = withStacks({ s1: [[], ["omarchy.battery"]] })
  assert.equal(P.placementBoard(moved, facts()).key, a.key, "an empty card is not a position")
  const reordered = withStacks({ s1: [["omarchy.battery"], ["omarchy.clock"]] })
  const swapped = withStacks({ s1: [["omarchy.clock"], ["omarchy.battery"]] })
  assert.notEqual(P.placementBoard(reordered, facts()).key, P.placementBoard(swapped, facts()).key)
})

test("M1's drawer list is read as the legacy drawer", () => {
  const c = config()
  c.bar.layout.right[1].drawer = ["omarchy.battery", "acme.media"]
  assert.deepEqual(P.placementBoard(c, facts()).legacyDrawer, ["omarchy.battery", "acme.media"])
  c.bar.layout.right[1].drawer = ["a.b", "a.b"]
  assert.equal(P.placementBoard(c, facts()), null)
})

// ---- Into and out of stacks --------------------------------------------

test("a bar widget goes into a card at the gap, carrying its settings", () => {
  const c = withStacks({ s1: [["omarchy.battery"]] })
  const board = P.placementBoard(c, facts())
  const p = plan(c, { id: "acme.vpn", to: "stack", stack: "s1", card: 0, gap: 0,
    from: { zone: "left", index: 1 }, key: board.key })
  assert.equal(p.ok, true, p.reason)
  assert.equal(p.channel, "config")
  assert.deepEqual(p.next.bar.layout.left, ["omarchy.workspaces"])
  assert.deepEqual(cardsOf(p.next, "s1"), [["acme.vpn", "omarchy.battery"]])
  assert.deepEqual(p.next.plugins.find(e => e.id === "acme.vpn"), { id: "acme.vpn", color: "red" })
  assert.match(p.note, /Put VPN in a stack/)
  const after = P.placementBoard(p.next, facts())
  assert.equal(after.key, p.expectedKey)
  assert.equal(after.byId["acme.vpn"].zone, "stack")
  assert.equal(after.byId["acme.vpn"].state, "live")
  assert.deepEqual(after.byId["acme.vpn"].settings, { color: "red" })
})

test("a card index one past the last makes a new card; no gap appends", () => {
  const c = withStacks({ s1: [["omarchy.battery"]] }, { disabledPlugins: ["acme.vpn"] })
  const p = plan(c, { id: "acme.vpn", to: "stack", stack: "s1", card: 1 })
  assert.deepEqual(cardsOf(p.next, "s1"), [["omarchy.battery"], ["acme.vpn"]])
  assert.deepEqual(p.next.disabledPlugins, [], "putting a widget in a stack turns it on")
  const append = plan(c, { id: "omarchy.clock", to: "stack", stack: "s1", card: 0 })
  assert.deepEqual(cardsOf(append.next, "s1"), [["omarchy.battery", "omarchy.clock"]])
  assert.equal(plan(c, { id: "acme.vpn", to: "stack", stack: "s1", card: 2 }).reason, "invalid")
  assert.equal(plan(c, { id: "acme.vpn", to: "stack", stack: "s1", card: 1, gap: 1 }).reason, "invalid")
  assert.equal(plan(c, { id: "acme.vpn", to: "stack", stack: "s9", card: 0 }).reason, "noStack")
})

test("an empty stack takes its first card", () => {
  const c = withStacks({ s1: [] })
  const p = plan(c, { id: "acme.vpn", to: "stack", stack: "s1", card: 0 })
  assert.deepEqual(cardsOf(p.next, "s1"), [["acme.vpn"]])
  const bare = config()
  bare.bar.layout.right.push({ id: SELF, stack: "s4" })
  const first = plan(bare, { id: "omarchy.clock", to: "stack", stack: "s4", card: 0 })
  assert.deepEqual(first.next.plugins, [{ id: "omarchy.clock", format: "24h" },
    { id: SELF, stacks: { s4: { width: 160, dots: true, cards: [["omarchy.clock"]] } } }],
    "the stack store is created when there is something to keep")
})

test("moving within and between cards counts gaps before removal and drops emptied cards", () => {
  const c = withStacks({ s1: [["omarchy.battery", "omarchy.clock", "acme.media"], ["acme.vpn"]], s2: [] },
    { plugins: [{ id: "acme.media" }, { id: "acme.vpn" }] })
  const down = plan(c, { id: "omarchy.battery", to: "stack", stack: "s1", card: 0, gap: 2,
    from: { zone: "stack", stack: "s1", card: 0, index: 0 } })
  assert.deepEqual(cardsOf(down.next, "s1")[0], ["omarchy.clock", "omarchy.battery", "acme.media"])
  assert.deepEqual(down.touched, ["plugins"], "only the stack store changed")
  assert.equal(plan(c, { id: "omarchy.clock", to: "stack", stack: "s1", card: 0, gap: 1 }).noOp, true)
  assert.equal(plan(c, { id: "omarchy.clock", to: "stack", stack: "s1", card: 0, gap: 2 }).noOp, true)

  const across = plan(c, { id: "acme.vpn", to: "stack", stack: "s1", card: 0, gap: 0 })
  assert.deepEqual(cardsOf(across.next, "s1"), [["acme.vpn", "omarchy.battery", "omarchy.clock", "acme.media"]],
    "the emptied card is gone")
  const toOther = plan(c, { id: "acme.vpn", to: "stack", stack: "s2", card: 0 })
  assert.deepEqual(cardsOf(toOther.next, "s1"), [["omarchy.battery", "omarchy.clock", "acme.media"]])
  assert.deepEqual(cardsOf(toOther.next, "s2"), [["acme.vpn"]])
  const ownCard = plan(c, { id: "acme.vpn", to: "stack", stack: "s1", card: 2 })
  assert.deepEqual(cardsOf(ownCard.next, "s1"), [["omarchy.battery", "omarchy.clock", "acme.media"], ["acme.vpn"]],
    "taking the only widget of a card into a new card ends where it started")
})

test("stacking refuses Omniplug, stacks, custom modules, duplicates, non-widgets and the last built-in", () => {
  const c = withStacks({ s1: [] })
  assert.equal(plan(c, { id: SELF, to: "stack", stack: "s1", card: 0 }).reason, "self")
  assert.equal(plan(c, { id: SELF, to: "off" }).reason, "self")
  const selfMove = plan(c, { id: SELF, to: "left", gap: 0, from: { zone: "right", index: 2 } })
  assert.equal(selfMove.ok, true, "a stack moves around the bar like anything else")
  assert.deepEqual(selfMove.next.bar.layout.left[0], { id: SELF, stack: "s1" })

  const custom = withStacks({ s1: [] })
  custom.bar.layout.left.push({ id: "my.script", exec: "date" })
  assert.equal(plan(custom, { id: "my.script", to: "stack", stack: "s1", card: 0 }).reason, "notStowable")

  const dup = withStacks({ s1: [] })
  dup.bar.layout.center.push("acme.vpn")
  assert.equal(plan(dup, { id: "acme.vpn", to: "stack", stack: "s1", card: 0, from: { zone: "left", index: 1 } }).reason,
    "duplicate")
  assert.equal(plan(dup, { id: "acme.vpn", to: "left" }).reason, "duplicate", "by id, a duplicate is ambiguous")

  const odd = withStacks({ s1: [] })
  odd.bar.layout.left.push("acme.service")
  assert.equal(plan(odd, { id: "acme.service", to: "stack", stack: "s1", card: 0 }).reason, "notStowable")
  assert.equal(plan(withStacks({ s1: [] }), { id: "unknown.id", to: "stack", stack: "s1", card: 0 }).reason, "notStowable")

  const lonely = withStacks({ s1: [] })
  lonely.bar.layout.left = ["acme.vpn"]
  lonely.bar.layout.right = [{ id: SELF }, { id: SELF, stack: "s1" }]
  assert.equal(plan(lonely, { id: "omarchy.clock", to: "stack", stack: "s1", card: 0 }).reason, "lastBuiltin")
  assert.match(plan(lonely, { id: "omarchy.clock", to: "stack", stack: "s1", card: 0 }).note, /Keep one Omarchy widget/)
})

test("stacks have limits", () => {
  const many = Array.from({ length: 32 }, (_, i) => "acme.w" + i)
  const full = withStacks({ s1: [many] })
  const extra = facts({ plugins: { ...PLUGINS, ...Object.fromEntries(many.map(id => [id, plugin(id)])) } })
  assert.equal(plan(full, { id: "acme.vpn", to: "stack", stack: "s1", card: 0 }, extra).reason, "full")
  assert.equal(plan(full, { id: "acme.vpn", to: "stack", stack: "s1", card: 1 }, extra).ok, true)
  const cards = withStacks({ s1: Array.from({ length: 16 }, (_, i) => ["acme.c" + i]) })
  const extraCards = facts({ plugins: { ...PLUGINS, ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => ["acme.c" + i, plugin("c")])) } })
  assert.equal(plan(cards, { id: "acme.vpn", to: "stack", stack: "s1", card: 16 }, extraCards).reason, "full")
})

test("a stacked widget goes back to the bar with its settings, at the gap or after the anchor", () => {
  const c = withStacks({ s1: [["acme.vpn", "acme.media"]] }, {
    plugins: [{ id: "acme.vpn", color: "red" }, { id: "acme.media", volume: 3 }, { id: "other.thing" }],
    disabledPlugins: ["acme.vpn"]
  })
  c.bar.layout.left = ["omarchy.workspaces", "x.y"]
  const anchored = plan(c, { id: "acme.vpn", to: "left" })
  assert.deepEqual(anchored.next.bar.layout.left, ["omarchy.workspaces", { id: "acme.vpn", color: "red" }, "x.y"])
  assert.deepEqual(anchored.next.plugins.filter(e => e.id !== SELF), [{ id: "acme.media", volume: 3 }, { id: "other.thing" }],
    "a widget-only plugin needs no carrier once it is on the bar")
  assert.deepEqual(anchored.next.disabledPlugins, [], "placing a widget turns it on")
  assert.deepEqual(cardsOf(anchored.next, "s1"), [["acme.media"]])

  const gapped = plan(c, { id: "acme.media", to: "right", gap: 0, from: { zone: "stack", stack: "s1", card: 0, index: 1 } })
  assert.deepEqual(gapped.next.bar.layout.right[0], { id: "acme.media", volume: 3 })
  assert.deepEqual(gapped.next.plugins.find(e => e.id === "acme.media"), { id: "acme.media" },
    "a plugin with a panel keeps a bare marker so the panel stays enabled")

  const last = plan(withStacks({ s1: [["omarchy.battery"]] }), { id: "omarchy.battery", to: "center", gap: 0 })
  assert.deepEqual(last.next.bar.layout.center[0], "omarchy.battery", "no settings, a bare entry")
  assert.deepEqual(cardsOf(last.next, "s1"), [], "the stack stays, empty")
})

test("positional intents must still match the board the user dragged on", () => {
  const c = withStacks({ s1: [["omarchy.battery"]] })
  const board = P.placementBoard(c, facts())
  assert.equal(plan(c, { id: "acme.vpn", to: "stack", stack: "s1", card: 0, key: "old" }).reason, "stale")
  assert.equal(plan(c, { id: "acme.vpn", to: "stack", stack: "s1", card: 0, from: { zone: "left", index: 0 }, key: board.key }).reason, "stale")
  assert.equal(plan(c, { id: "acme.vpn", to: "stack", stack: "s1", card: 0, from: { zone: "left", index: 9 } }).reason, "stale")
  assert.equal(plan(c, { id: "omarchy.battery", to: "left", from: { zone: "stack", stack: "s1", card: 0, index: 1 } }).reason, "stale")
  assert.equal(plan(c, { id: "omarchy.battery", to: "left", from: { zone: "stack", stack: "s2", card: 0, index: 0 } }).reason, "stale")
  assert.equal(plan(c, { id: "omarchy.battery", to: "left", from: { zone: "drawer", index: 0 } }).reason, "invalid")
  assert.equal(plan(c, { id: "acme.vpn", to: "stack", stack: "s1", card: 0, gap: 5 }).reason, "invalid")
  assert.equal(plan(c, { id: "acme.vpn", to: "stack", stack: "s1", card: 0.5 }).reason, "invalid")
  assert.equal(plan(c, { id: "acme.vpn", to: "drawer" }).reason, "invalid", "M1's drawer target is gone")
  assert.equal(plan(c, { id: "", to: "stack" }).reason, "invalid")
  assert.equal(plan(c, null).reason, "invalid")
  assert.equal(plan(c, { op: "explode" }).reason, "invalid")
})

test("changing stacks needs the in-process writer, the full config, and the plugin list", () => {
  const c = withStacks({ s1: [["acme.media"]] }, { plugins: [{ id: "acme.media" }] })
  assert.equal(plan(c, { id: "acme.vpn", to: "stack", stack: "s1", card: 0 }, facts({ canCross: false })).reason, "needsBarAccess")
  assert.equal(plan(c, { id: "acme.vpn", to: "stack", stack: "s1", card: 0 }, facts({ plugins: null })).reason, "unreadable")
  assert.equal(plan(c, { id: "acme.media", to: "left" }, facts({ canCross: false })).reason, "needsBarAccess")
  assert.equal(plan(c, { op: "newStack" }, facts({ canCross: false, partial: true })).reason, "needsBarAccess")
  assert.equal(plan(c, { op: "stackSettings", stack: "s1", width: 200 }, facts({ plugins: null })).ok, true,
    "a stack's own settings need no plugin facts")
})

// ---- On, off, remove ---------------------------------------------------

test("off keeps the card spot and the carrier; on turns it back on in place", () => {
  const c = withStacks({ s1: [["acme.vpn", "acme.media"]] }, { plugins: [{ id: "acme.vpn", color: "red" }, { id: "acme.media" }] })
  const off = plan(c, { id: "acme.vpn", to: "off" })
  assert.equal(off.channel, "config")
  assert.deepEqual(off.next.disabledPlugins, ["acme.vpn"])
  assert.deepEqual(cardsOf(off.next, "s1"), [["acme.vpn", "acme.media"]])
  assert.deepEqual(off.next.plugins.find(e => e.id === "acme.vpn"), { id: "acme.vpn", color: "red" })
  assert.match(off.note, /keeps its place/)
  assert.equal(P.placementBoard(off.next, facts()).byId["acme.vpn"].state, "off")
  assert.equal(plan(off.next, { id: "acme.vpn", to: "off" }).noOp, true)

  const on = plan(off.next, { id: "acme.vpn", to: "on" })
  assert.deepEqual(on.next.disabledPlugins, [])
  assert.deepEqual(cardsOf(on.next, "s1"), [["acme.vpn", "acme.media"]], "same spot")
  assert.match(on.note, /back on/)
  assert.equal(P.placementBoard(on.next, facts()).byId["acme.vpn"].state, "live")
})

test("off, on and remove only apply to stacked widgets", () => {
  assert.equal(plan(config(), { id: "acme.vpn", to: "off" }).reason, "notStowed")
  assert.equal(plan(config(), { id: "acme.vpn", to: "on" }).reason, "notStowed")
  assert.equal(plan(config(), { id: "acme.nothing", to: "off" }).reason, "notPlaced")
  assert.equal(plan(config(), { id: "acme.vpn", to: "remove" }).reason, "notStowed")
  assert.equal(plan(config(), { id: "acme.nothing", to: "left" }).reason, "notPlaced", "not a known bar widget")
})

test("remove forgets a placeholder and its carrier, and drops its card if emptied", () => {
  const gone = withStacks({ s1: [["gone.widget"], ["acme.vpn"]] }, { plugins: [{ id: "gone.widget" }, { id: "acme.vpn", color: "red" }] })
  const p = plan(gone, { id: "gone.widget", to: "remove" })
  assert.deepEqual(cardsOf(p.next, "s1"), [["acme.vpn"]])
  assert.deepEqual(p.next.plugins.filter(e => e.id !== SELF), [{ id: "acme.vpn", color: "red" }])
})

test("the host's own enable and disable leave stacks consistent", () => {
  // `omarchy plugin disable acme.vpn` on a stacked third-party widget drops
  // its carrier (PluginRegistry.setEnabled); the board shows it off, in place.
  const stacked = withStacks({ s1: [["acme.vpn"]] }, { plugins: [{ id: "acme.vpn", color: "red" }] })
  const hostDisabled = JSON.parse(JSON.stringify(stacked))
  hostDisabled.plugins = hostDisabled.plugins.filter(e => e.id !== "acme.vpn")
  assert.equal(P.placementBoard(hostDisabled, facts()).byId["acme.vpn"].state, "off")
  const on = plan(hostDisabled, { id: "acme.vpn", to: "on" })
  assert.deepEqual(on.next.plugins.find(e => e.id === "acme.vpn"), { id: "acme.vpn" }, "turning it on recreates the carrier")

  // `omarchy plugin enable acme.vpn` after our off: the host removes it from
  // disabledPlugins and finds the carrier, so it comes back in its card.
  const off = plan(stacked, { id: "acme.vpn", to: "off" }).next
  const hostEnabled = JSON.parse(JSON.stringify(off))
  hostEnabled.disabledPlugins = []
  const again = P.placementBoard(hostEnabled, facts())
  assert.equal(again.byId["acme.vpn"].zone, "stack")
  assert.equal(again.byId["acme.vpn"].state, "live")
})

test("a widget both on the bar and in a stack is shown, never silently repaired", () => {
  const c = withStacks({ s1: [["acme.vpn"]] })
  c.bar.layout.left.push("acme.vpn")
  const board = P.placementBoard(c, facts())
  assert.deepEqual(board.conflicts, ["acme.vpn"])
  assert.equal(board.byId["acme.vpn"].zone, "left")
  assert.equal(plan(c, { id: "acme.vpn", to: "stack", stack: "s1", card: 0 }).reason, "conflict")
})

// ---- Stack intents -----------------------------------------------------

test("newStack adds an empty stack at the end of a section with the lowest free id", () => {
  const c = withStacks({ s1: [], s3: [] })
  const p = plan(c, { op: "newStack" })
  assert.equal(p.ok, true, p.reason)
  assert.deepEqual(p.next.bar.layout.right.at(-1), { id: SELF, stack: "s2" })
  assert.deepEqual(storeOf(p.next).stacks.s2, { width: 160, dots: true, cards: [] })
  assert.match(p.note, /Added a stack to the right section/)
  const left = plan(config(), { op: "newStack", section: "left" })
  assert.deepEqual(left.next.bar.layout.left.at(-1), { id: SELF, stack: "s1" })
  assert.deepEqual(left.next.plugins, [{ id: SELF, stacks: { s1: { width: 160, dots: true, cards: [] } } }])
  assert.equal(plan(config(), { op: "newStack", section: "drawer" }).reason, "invalid")
  const after = P.placementBoard(left.next, facts())
  assert.equal(after.key, left.expectedKey)
  assert.deepEqual(after.stacks.map(s => s.sid), ["s1"])
})

test("deleteStack puts its widgets back on the bar where it was, in card order", () => {
  const c = withStacks({ s1: [["acme.vpn", "omarchy.battery"], ["acme.media"]] }, {
    plugins: [{ id: "acme.vpn", color: "red" }, { id: "acme.media" }], disabledPlugins: ["acme.media"]
  })
  // Put the stack between the tray and the icon.
  c.bar.layout.right = ["omarchy.tray", { id: SELF, stack: "s1" }, { id: SELF, allowUnverifiedUpdates: true }]
  const p = plan(c, { op: "deleteStack", stack: "s1" })
  assert.equal(p.ok, true, p.reason)
  assert.deepEqual(p.next.bar.layout.right, ["omarchy.tray", { id: "acme.vpn", color: "red" }, "omarchy.battery",
    "acme.media", { id: SELF, allowUnverifiedUpdates: true }])
  assert.deepEqual(p.next.plugins, [{ id: SELF }, { id: "acme.media" }],
    "the store keeps its {id}; a panel plugin keeps its marker")
  assert.deepEqual(p.next.disabledPlugins, [])
  assert.match(p.note, /put its widgets back/)
  assert.equal(plan(c, { op: "deleteStack", stack: "s7" }).reason, "noStack")
})

test("deleting an orphan returns its widgets to the end of the right section", () => {
  const c = config()
  c.plugins = [{ id: SELF, stacks: { s5: { cards: [["omarchy.battery"]] } } }]
  const p = plan(c, { op: "deleteStack", stack: "s5" })
  assert.deepEqual(p.next.bar.layout.right.at(-1), "omarchy.battery")
  assert.deepEqual(p.next.plugins, [{ id: SELF }])
})

test("stackSettings changes only the stack store, so the bar is not rebuilt", () => {
  const c = withStacks({ s1: [["omarchy.battery"]] })
  const p = plan(c, { op: "stackSettings", stack: "s1", width: 233.4, dots: false })
  assert.deepEqual(p.touched, ["plugins"])
  assert.deepEqual(storeOf(p.next).stacks.s1, { width: 233, dots: false, cards: [["omarchy.battery"]] })
  assert.equal(plan(c, { op: "stackSettings", stack: "s1", width: 1 }).next.plugins[0].stacks.s1.width, 24)
  assert.equal(plan(c, { op: "stackSettings", stack: "s1", width: "wide" }).reason, "invalid")
  assert.equal(plan(c, { op: "stackSettings", stack: "s1", dots: "yes" }).reason, "invalid")
  assert.equal(plan(c, { op: "stackSettings", stack: "s1", width: 160, dots: true }).noOp, true)
  const empty = config()
  empty.bar.layout.left.push({ id: SELF, stack: "s2" })
  const created = plan(empty, { op: "stackSettings", stack: "s2", width: 90 })
  assert.deepEqual(created.next.plugins, [{ id: SELF, stacks: { s2: { width: 90, dots: true, cards: [] } } }])
})

test("migrateDrawer turns M1's drawer into one stack and clears the old list", () => {
  const c = config({ plugins: [{ id: "acme.media", volume: 3 }], disabledPlugins: ["omarchy.battery"] })
  c.bar.layout.right[1].drawer = ["omarchy.battery", "acme.media", "acme.vpn"]
  const p = plan(c, { op: "migrateDrawer" })
  assert.equal(p.ok, true, p.reason)
  assert.deepEqual(p.next.bar.layout.right, ["omarchy.tray", { id: SELF, allowUnverifiedUpdates: true }, { id: SELF, stack: "s1" }])
  assert.deepEqual(cardsOf(p.next, "s1"), [["omarchy.battery", "acme.media"]], "acme.vpn is on the bar, so it stays there")
  assert.deepEqual(p.next.disabledPlugins, ["omarchy.battery"], "an off widget stays off")
  const after = P.placementBoard(p.next, facts())
  assert.deepEqual(after.legacyDrawer, [])
  assert.equal(after.byId["acme.media"].state, "live")
  assert.equal(plan(p.next, { op: "migrateDrawer" }).reason, "noLegacy")
})

test("selfSetting writes the icon's settings without touching any stack", () => {
  const c = withStacks({ s1: [["omarchy.battery"]] })
  const p = plan(c, { op: "selfSetting", name: "tiledExpandedPanel", value: true })
  assert.deepEqual(p.next.bar.layout.right, ["omarchy.tray", { id: SELF, allowUnverifiedUpdates: true, tiledExpandedPanel: true },
    { id: SELF, stack: "s1" }])
  assert.deepEqual(p.touched, ["layout"])
  assert.equal(plan(c, { op: "selfSetting", name: "stack", value: "s2" }).reason, "invalid")
  assert.equal(plan(c, { op: "selfSetting", name: "x", value: {} }).reason, "invalid")
})

// ---- Widgets placed nowhere --------------------------------------------

// What a lost M1 drawer leaves behind: carriers for widgets that are neither
// on the bar nor in a stack, which `omarchy plugin enable` reads as placed.
function stranded() {
  const c = withStacks({ s1: [] }, { plugins: [{ id: "acme.vpn", color: "red" }, { id: "acme.media" }],
    disabledPlugins: ["omarchy.battery"] })
  c.bar.layout.left = ["omarchy.workspaces"]
  return c
}

test("the board lists bar widgets placed nowhere, and whether each still has a plugins[] entry", () => {
  const board = P.placementBoard(stranded(), facts())
  assert.deepEqual(board.unplaced.map(s => [s.id, s.state, s.carried]),
    [["omarchy.battery", "off", false], ["acme.media", "live", true], ["acme.vpn", "live", true]])
  assert.deepEqual(board.unplaced.find(s => s.id === "acme.vpn").settings, { color: "red" })
  assert.deepEqual(P.placementBoard(stranded(), facts({ plugins: null })).unplaced, [], "unknown without the plugin list")
})

test("a widget placed nowhere goes onto the bar with its settings, or into a card", () => {
  const onBar = plan(stranded(), { id: "acme.vpn", to: "right", gap: 0 })
  assert.equal(onBar.ok, true, onBar.reason)
  assert.deepEqual(onBar.next.bar.layout.right[0], { id: "acme.vpn", color: "red" })
  assert.equal(onBar.next.plugins.some(e => e.id === "acme.vpn"), false, "the carrier moves onto the bar")
  assert.match(onBar.note, /Put VPN in the right section/)
  const media = plan(stranded(), { id: "acme.media", to: "left" })
  assert.deepEqual(media.next.bar.layout.left, ["omarchy.workspaces", "acme.media"])
  assert.deepEqual(media.next.plugins.find(e => e.id === "acme.media"), { id: "acme.media" }, "its panel stays enabled")
  const builtin = plan(stranded(), { id: "omarchy.battery", to: "center", gap: 1 })
  assert.deepEqual(builtin.next.bar.layout.center, [{ id: "omarchy.clock", format: "24h" }, "omarchy.battery"])
  assert.deepEqual(builtin.next.disabledPlugins, [], "placing it turns it on")
  const card = plan(stranded(), { id: "acme.vpn", to: "stack", stack: "s1", card: 0 })
  assert.deepEqual(cardsOf(card.next, "s1"), [["acme.vpn"]])
  assert.equal(plan(stranded(), { id: "acme.service", to: "left" }).reason, "notPlaced", "only bar widgets")
  assert.equal(plan(stranded(), { id: "acme.vpn", to: "left" }, facts({ canCross: false, partial: true })).reason,
    "needsBarAccess")
})

test("migrating a drawer whose widgets are all placed already makes no empty stack", () => {
  const c = config()
  c.bar.layout.right[1].drawer = ["acme.vpn"]
  const p = plan(c, { op: "migrateDrawer" })
  assert.equal(p.ok, true, p.reason)
  assert.deepEqual(p.next.bar.layout.right, ["omarchy.tray", { id: SELF, allowUnverifiedUpdates: true }])
  assert.match(p.note, /already placed/)
  assert.equal("plugins" in p.next && p.next.plugins.some(e => e.id === SELF), false)
})

// ---- Bar moves and the writer ------------------------------------------

test("bar moves use the writer when it is reachable and omarchy-bar when it is not", () => {
  const board = P.placementBoard(config(), facts())
  const intent = { id: "acme.vpn", to: "right", gap: 0, from: { zone: "left", index: 1 }, key: board.key }
  const direct = plan(config(), intent)
  assert.equal(direct.channel, "config")
  assert.deepEqual(direct.next.bar.layout.right[0], { id: "acme.vpn", color: "red" })

  const cli = plan(config(), intent, facts({ canCross: false }))
  assert.equal(cli.channel, "cli")
  assert.deepEqual(cli.command, ["omarchy-bar", "move", "acme.vpn", "--from-section", "left",
    "--from-index", "1", "--section", "right", "--index", "0"])
  const down = plan(config(), { id: "omarchy.workspaces", to: "left", gap: 2, from: { zone: "left", index: 0 } },
    facts({ canCross: false }))
  assert.deepEqual(down.command.slice(-2), ["--index", "1"], "gaps are counted before removal")
  assert.deepEqual(down.next.bar.layout.left, [{ id: "acme.vpn", color: "red" }, "omarchy.workspaces"])
  assert.equal(plan(config(), { id: "omarchy.workspaces", to: "left", gap: 1, from: { zone: "left", index: 0 } }).noOp, true)
})

test("the writer's mutator replays the intent, applies only placement's regions, and refuses a changed config", () => {
  const c = withStacks({ s1: [["omarchy.battery"]] })
  const p = plan(c, { id: "acme.vpn", to: "stack", stack: "s1", card: 1 })
  const copy = JSON.parse(JSON.stringify(c))
  P.placementAssign(copy, p, facts())
  assert.deepEqual(copy.unrelated, { keep: true })
  assert.equal(copy.bar.position, "top")
  assert.deepEqual(cardsOf(copy, "s1"), [["omarchy.battery"], ["acme.vpn"]])
  assert.equal(P.placementBoard(copy, facts()).key, p.expectedKey)

  const saved = JSON.parse(JSON.stringify(c))
  saved.bar.layout.left[1].color = "saved-after-planning"
  P.placementAssign(saved, p, facts())
  assert.deepEqual(saved.plugins.find(e => e.id === "acme.vpn"), { id: "acme.vpn", color: "saved-after-planning" },
    "settings written after the plan are carried, not overwritten")

  const moved = JSON.parse(JSON.stringify(c))
  moved.bar.layout.left.reverse()
  assert.throws(() => P.placementAssign(moved, p, facts()), /stale/)
  assert.throws(() => P.placementAssign(JSON.parse(JSON.stringify(c)), { ok: false }, facts()), /stale/)

  for (const intent of [{ op: "newStack" }, { op: "deleteStack", stack: "s1" },
    { op: "stackSettings", stack: "s1", width: 300 }, { op: "selfSetting", name: "a", value: true }]) {
    const opPlan = plan(c, intent)
    const opCopy = JSON.parse(JSON.stringify(c))
    P.placementAssign(opCopy, opPlan, facts())
    assert.deepEqual(opCopy.bar.layout, JSON.parse(JSON.stringify(opPlan.next.bar.layout)), intent.op)
    assert.deepEqual(opCopy.plugins, JSON.parse(JSON.stringify(opPlan.next.plugins)), intent.op)
  }
})

test("plans leave absent host lists absent", () => {
  const c = config()
  delete c.plugins
  delete c.disabledPlugins
  const reorder = plan(c, { id: "omarchy.clock", to: "right", gap: 0 })
  assert.equal("plugins" in reorder.next, false)
  assert.equal("disabledPlugins" in reorder.next, false)
  c.bar.layout.right.push({ id: SELF, stack: "s1" })
  const stack = plan(c, { id: "acme.vpn", to: "stack", stack: "s1", card: 0 })
  assert.deepEqual(stack.next.plugins, [{ id: "acme.vpn", color: "red" },
    { id: SELF, stacks: { s1: { width: 160, dots: true, cards: [["acme.vpn"]] } } }])
  assert.equal("disabledPlugins" in stack.next, false)
})

test("a partial read (bar only) can still move bar entries but never touches stacks", () => {
  const c = withStacks({ s1: [["acme.vpn"]] })
  delete c.disabledPlugins
  const bar = { version: 1, bar: c.bar }
  const partial = facts({ canCross: false, partial: true })
  const board = P.placementBoard(bar, partial)
  assert.deepEqual(board.stacks.map(s => [s.sid, s.cards.length]), [["s1", 0]], "the store is invisible, not empty")
  assert.equal(plan(bar, { id: "omarchy.workspaces", to: "center", gap: 0 }, partial).channel, "cli")
  assert.equal(plan(bar, { id: "omarchy.clock", to: "stack", stack: "s1", card: 0 }, partial).reason, "needsBarAccess")
})

test("facts come from the plugin list's rows, and stacks are labelled by number", () => {
  assert.equal(P.placementFactsFromRows([]), null)
  assert.deepEqual(P.placementFactsFromRows([{ id: "a", name: "A", kinds: ["bar-widget"], firstParty: true }, null]),
    { a: { name: "A", kinds: ["bar-widget"], firstParty: true } })
  assert.equal(P.placementStackLabel("s2"), "Stack 2")
  assert.equal(P.placementStackLabel("x"), "Stack x")
})
