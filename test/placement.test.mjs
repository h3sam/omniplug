// Placement.js is loaded by QML, so it has no module system of its own; the
// tests evaluate the shipped source and exercise only its interface: the
// board it reads and the plans it makes.
import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const source = readFileSync(new URL("../Placement.js", import.meta.url), "utf8")
const P = Function(source + "; return { placementBoard, placementPlan, placementAssign }")()

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

// A config as the host keeps it, with our own entry on the right.
function config(over = {}) {
  return {
    version: 1,
    bar: {
      position: "top",
      layout: {
        left: ["omarchy.workspaces", { id: "acme.vpn", color: "red" }],
        center: [{ id: "omarchy.clock", format: "24h" }],
        right: ["omarchy.tray", { id: SELF, allowUnverifiedUpdates: true, drawer: [] }]
      }
    },
    plugins: [],
    disabledPlugins: [],
    unrelated: { keep: true },
    ...over
  }
}
// Stowed widgets are off the bar by construction, so the fixture takes them
// out of the layout it starts from.
const withDrawer = (drawer, over = {}) => {
  const c = config(over)
  for (const section of ["left", "center", "right"])
    c.bar.layout[section] = c.bar.layout[section].filter(e => !drawer.includes(typeof e === "string" ? e : e.id))
  c.bar.layout.right.find(e => e.id === SELF).drawer = drawer
  return c
}
const drawerOf = c => (c.bar.layout.right.find(e => e.id === SELF) || {}).drawer
const plan = (c, intent, f = facts()) => P.placementPlan(c, f, intent)

test("the board lists every zone in order, with settings, states and one slot per id", () => {
  const c = withDrawer(["omarchy.battery", "acme.media", "gone.widget"], {
    plugins: [{ id: "acme.media", volume: 3 }],
    disabledPlugins: ["omarchy.battery"]
  })
  const board = P.placementBoard(c, facts())
  assert.deepEqual(board.zones.left.map(s => s.id), ["omarchy.workspaces", "acme.vpn"])
  assert.deepEqual(board.zones.drawer.map(s => [s.id, s.state]),
    [["omarchy.battery", "off"], ["acme.media", "live"], ["gone.widget", "missing"]])
  assert.deepEqual(board.zones.left[1].settings, { color: "red" })
  assert.deepEqual(board.byId["acme.media"].settings, { volume: 3 })
  assert.equal(board.byId["acme.vpn"].zone, "left")
  assert.equal(board.byId["omarchy.clock"].name, "Clock")
  assert.equal(board.canStow, true)
  assert.throws(() => { board.zones.left[1].settings.color = "blue" }, TypeError)
})

test("a stowed third-party widget with no carrier is off: it is not registered", () => {
  const board = P.placementBoard(withDrawer(["acme.vpn2"]), facts({ plugins: { ...PLUGINS, "acme.vpn2": plugin("VPN 2") } }))
  assert.equal(board.byId["acme.vpn2"].state, "off")
  const builtin = P.placementBoard(withDrawer(["omarchy.battery"]), facts())
  assert.equal(builtin.byId["omarchy.battery"].state, "live", "a built-in needs no carrier to load")
})

test("the board says why stowing is unavailable, and refuses to read what it cannot trust", () => {
  assert.equal(P.placementBoard(config(), facts({ canCross: false })).reason, "needsBarAccess")
  assert.equal(P.placementBoard(config(), facts({ plugins: null })).reason, "unreadable")
  assert.equal(P.placementBoard(config(), facts({ plugins: null })).canStow, false)
  assert.equal(P.placementBoard({ bar: { layout: { left: [] } } }, facts()), null)
  assert.equal(P.placementBoard(withDrawer(["a.b", "a.b"]), facts()), null, "repeated drawer ids")
  assert.equal(P.placementBoard(withDrawer("a.b"), facts()), null)
  assert.equal(P.placementBoard(withDrawer(["../x"]), facts()), null)
  const huge = config()
  huge.plugins = [{ id: "big", blob: "x".repeat(1048577) }]
  assert.equal(P.placementBoard(huge, facts()), null)
})

test("the board key ignores settings, so a widget saving its own state mid-drag is not stale", () => {
  const a = P.placementBoard(config(), facts())
  const changed = config()
  changed.bar.layout.left[1].color = "blue"
  changed.bar.layout.center[0].format = "12h"
  assert.equal(P.placementBoard(changed, facts()).key, a.key)
  const moved = config()
  moved.bar.layout.left.reverse()
  assert.notEqual(P.placementBoard(moved, facts()).key, a.key)
})

test("stowing takes the entry off the bar, carries its settings, and inserts at the gap", () => {
  const c = withDrawer(["omarchy.battery"])
  const board = P.placementBoard(c, facts())
  const p = plan(c, { id: "acme.vpn", to: "drawer", gap: 0, from: { zone: "left", index: 1 }, key: board.key })
  assert.equal(p.ok, true)
  assert.equal(p.channel, "config")
  assert.deepEqual(p.next.bar.layout.left, ["omarchy.workspaces"])
  assert.deepEqual(p.next.plugins, [{ id: "acme.vpn", color: "red" }])
  assert.deepEqual(drawerOf(p.next), ["acme.vpn", "omarchy.battery"])
  assert.equal(drawerOf(p.next).length, 2)
  assert.match(p.note, /Stowed VPN/)
  const after = P.placementBoard(p.next, facts())
  assert.equal(after.key, p.expectedKey)
  assert.equal(after.byId["acme.vpn"].zone, "drawer")
  assert.equal(after.byId["acme.vpn"].state, "live")
  assert.deepEqual(after.byId["acme.vpn"].settings, { color: "red" })
})

test("stowing without a gap appends, merges over an old carrier, and turns the widget on", () => {
  const c = withDrawer(["omarchy.battery"], { plugins: [{ id: "acme.vpn", color: "old", width: 3 }],
    disabledPlugins: ["acme.vpn"] })
  const p = plan(c, { id: "acme.vpn", to: "drawer" })
  assert.deepEqual(drawerOf(p.next), ["omarchy.battery", "acme.vpn"])
  assert.deepEqual(p.next.plugins, [{ id: "acme.vpn", color: "red", width: 3 }])
  assert.deepEqual(p.next.disabledPlugins, [])
})

test("stowing refuses Omniplug, custom modules, duplicates, non-widgets and the last built-in", () => {
  assert.equal(plan(config(), { id: SELF, to: "drawer" }).reason, "self")
  assert.equal(plan(config(), { id: SELF, to: "off" }).reason, "self")
  const selfMove = plan(config(), { id: SELF, to: "left", gap: 0 })
  assert.equal(selfMove.ok, true, "Omniplug can still be moved around the bar")
  assert.deepEqual(selfMove.next.bar.layout.left[0], { id: SELF, allowUnverifiedUpdates: true, drawer: [] })
  assert.equal(selfMove.channel, "config")

  const custom = config()
  custom.bar.layout.left.push({ id: "my.script", exec: "date" })
  assert.equal(plan(custom, { id: "my.script", to: "drawer" }).reason, "notStowable")

  const dup = config()
  dup.bar.layout.center.push("acme.vpn")
  assert.equal(plan(dup, { id: "acme.vpn", to: "drawer", from: { zone: "left", index: 1 } }).reason, "duplicate")
  assert.equal(plan(dup, { id: "acme.vpn", to: "left" }).reason, "duplicate", "by id, a duplicate is ambiguous")

  const odd = config()
  odd.bar.layout.left.push("acme.service")
  assert.equal(plan(odd, { id: "acme.service", to: "drawer" }).reason, "notStowable")

  const lonely = config()
  lonely.bar.layout.left = ["acme.vpn"]
  lonely.bar.layout.right = [{ id: SELF }]
  assert.equal(plan(lonely, { id: "omarchy.clock", to: "drawer" }).reason, "lastBuiltin")
  assert.match(plan(lonely, { id: "omarchy.clock", to: "drawer" }).note, /Keep one Omarchy widget/)
  assert.equal(plan(config(), { id: "omarchy.clock", to: "drawer" }).ok, true, "workspaces and tray remain")
})

test("positional intents must still match the board the user dragged on", () => {
  const board = P.placementBoard(config(), facts())
  assert.equal(plan(config(), { id: "acme.vpn", to: "drawer", key: "old" }).reason, "stale")
  assert.equal(plan(config(), { id: "acme.vpn", to: "drawer", from: { zone: "left", index: 0 }, key: board.key }).reason, "stale")
  assert.equal(plan(config(), { id: "acme.vpn", to: "drawer", from: { zone: "left", index: 9 } }).reason, "stale")
  assert.equal(plan(config(), { id: "acme.vpn", to: "drawer", gap: 5 }).reason, "invalid")
  assert.equal(plan(config(), { id: "acme.vpn", to: "drawer", gap: 0.5 }).reason, "invalid")
  assert.equal(plan(config(), { id: "acme.vpn", to: "sideways" }).reason, "invalid")
  assert.equal(plan(config(), { id: "", to: "drawer" }).reason, "invalid")
  assert.equal(plan(config(), null).reason, "invalid")
})

test("moves that cross the bar need the in-process writer and the plugin list", () => {
  assert.equal(plan(config(), { id: "acme.vpn", to: "drawer" }, facts({ canCross: false })).reason, "needsBarAccess")
  assert.equal(plan(config(), { id: "acme.vpn", to: "drawer" }, facts({ plugins: null })).reason, "unreadable")
  const stowed = withDrawer(["acme.media"], { plugins: [{ id: "acme.media" }] })
  assert.equal(plan(stowed, { id: "acme.media", to: "left" }, facts({ canCross: false })).reason, "needsBarAccess")
})

test("unstowing restores the entry with its settings, at the gap or after the section's anchor", () => {
  const c = withDrawer(["acme.vpn", "acme.media"], {
    plugins: [{ id: "acme.vpn", color: "red" }, { id: "acme.media", volume: 3 }, { id: "other.thing" }],
    disabledPlugins: ["acme.vpn"]
  })
  c.bar.layout.left = ["omarchy.workspaces", "x.y"]
  const anchored = plan(c, { id: "acme.vpn", to: "left" })
  assert.deepEqual(anchored.next.bar.layout.left, ["omarchy.workspaces", { id: "acme.vpn", color: "red" }, "x.y"])
  assert.deepEqual(anchored.next.plugins, [{ id: "acme.media", volume: 3 }, { id: "other.thing" }],
    "a widget-only plugin needs no carrier once it is in the bar")
  assert.deepEqual(anchored.next.disabledPlugins, [], "placing a widget turns it on")
  assert.deepEqual(drawerOf(anchored.next), ["acme.media"])

  const gapped = plan(c, { id: "acme.media", to: "right", gap: 0, from: { zone: "drawer", index: 1 } })
  assert.deepEqual(gapped.next.bar.layout.right[0], { id: "acme.media", volume: 3 })
  assert.deepEqual(gapped.next.plugins.find(e => e.id === "acme.media"), { id: "acme.media" },
    "a plugin with a panel keeps a bare marker so the panel stays enabled")
})

test("reordering the drawer touches only our own entry, so it goes through updateEntryInline", () => {
  const c = withDrawer(["omarchy.battery", "acme.media", "acme.vpn2"], { plugins: [{ id: "acme.media" }] })
  const p = plan(c, { id: "omarchy.battery", to: "drawer", gap: 3, from: { zone: "drawer", index: 0 } })
  assert.equal(p.channel, "own")
  assert.deepEqual(p.touched, ["own"])
  assert.deepEqual(p.ownSettings, { allowUnverifiedUpdates: true, drawer: ["acme.media", "acme.vpn2", "omarchy.battery"] })
  assert.equal(plan(c, { id: "acme.media", to: "drawer", gap: 1, from: { zone: "drawer", index: 1 } }).noOp, true)
  assert.equal(plan(c, { id: "acme.media", to: "drawer", gap: 2, from: { zone: "drawer", index: 1 } }).noOp, true)
  assert.equal(plan(c, { id: "acme.media", to: "drawer", gap: 2 }, facts({ canCross: false })).noOp, true)
})

test("a bare-string own entry is unreachable by updateEntryInline, so a reorder takes the writer", () => {
  const c = config()
  c.bar.layout.right[1] = SELF
  c.plugins = [{ id: "acme.media" }]
  const stow = plan(c, { id: "acme.vpn", to: "drawer" })
  assert.equal(stow.channel, "config")
  assert.deepEqual(stow.next.bar.layout.right[1], { id: SELF, drawer: ["acme.vpn"] })
})

test("off keeps the drawer spot and the carrier; on is a drawer intent with no gap", () => {
  const c = withDrawer(["acme.vpn", "acme.media"], { plugins: [{ id: "acme.vpn", color: "red" }, { id: "acme.media" }] })
  const off = plan(c, { id: "acme.vpn", to: "off" })
  assert.equal(off.channel, "config")
  assert.deepEqual(off.next.disabledPlugins, ["acme.vpn"])
  assert.deepEqual(drawerOf(off.next), ["acme.vpn", "acme.media"])
  assert.deepEqual(off.next.plugins[0], { id: "acme.vpn", color: "red" })
  assert.match(off.note, /keeps its place/)
  assert.equal(P.placementBoard(off.next, facts()).byId["acme.vpn"].state, "off")
  assert.equal(plan(off.next, { id: "acme.vpn", to: "off" }).noOp, true)

  const on = plan(off.next, { id: "acme.vpn", to: "drawer" })
  assert.deepEqual(on.next.disabledPlugins, [])
  assert.deepEqual(drawerOf(on.next), ["acme.vpn", "acme.media"], "same spot")
  assert.match(on.note, /back on/)
  assert.equal(P.placementBoard(on.next, facts()).byId["acme.vpn"].state, "live")
})

test("off and remove only apply to stowed widgets", () => {
  assert.equal(plan(config(), { id: "acme.vpn", to: "off" }).reason, "notStowed")
  assert.equal(plan(config(), { id: "acme.nothing", to: "off" }).reason, "notPlaced")
  assert.equal(plan(config(), { id: "acme.vpn", to: "remove" }).reason, "notStowed")
  assert.equal(plan(config(), { id: "acme.nothing", to: "left" }).reason, "notPlaced")
})

test("remove forgets a placeholder; with no carrier left it needs only our own entry", () => {
  const gone = withDrawer(["gone.widget", "acme.media"], { plugins: [{ id: "acme.media" }] })
  const p = plan(gone, { id: "gone.widget", to: "remove" }, facts({ canCross: false }))
  assert.equal(p.channel, "own")
  assert.deepEqual(p.ownSettings.drawer, ["acme.media"])

  const carried = withDrawer(["acme.vpn"], { plugins: [{ id: "acme.vpn", color: "red" }] })
  const drop = plan(carried, { id: "acme.vpn", to: "remove" })
  assert.equal(drop.channel, "config")
  assert.deepEqual(drop.next.plugins, [])
  assert.deepEqual(drawerOf(drop.next), [])
})

test("an unplaced widget can go straight into the drawer, if it is a bar widget", () => {
  const p = plan(config(), { id: "omarchy.battery", to: "drawer" })
  assert.deepEqual(drawerOf(p.next), ["omarchy.battery"])
  assert.equal(p.channel, "own", "a built-in loads without a carrier")
  const third = plan(config(), { id: "acme.media", to: "drawer" })
  assert.deepEqual(third.next.plugins, [{ id: "acme.media" }])
  assert.equal(third.channel, "config")
  assert.equal(plan(config(), { id: "acme.service", to: "drawer" }).reason, "notStowable")
  assert.equal(plan(config(), { id: "unknown.id", to: "drawer" }).reason, "notStowable")
})

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

test("the writer's mutator applies only placement's regions and refuses a changed config", () => {
  const c = config()
  const p = plan(c, { id: "acme.vpn", to: "drawer" })
  const copy = JSON.parse(JSON.stringify(c))
  P.placementAssign(copy, p, facts())
  assert.deepEqual(copy.unrelated, { keep: true })
  assert.equal(copy.bar.position, "top")
  assert.deepEqual(drawerOf(copy), ["acme.vpn"])
  assert.equal(P.placementBoard(copy, facts()).key, p.expectedKey)

  const saved = JSON.parse(JSON.stringify(c))
  saved.bar.layout.left[1].color = "saved-after-planning"
  P.placementAssign(saved, p, facts())
  assert.deepEqual(saved.plugins, [{ id: "acme.vpn", color: "saved-after-planning" }],
    "settings written after the plan are carried, not overwritten")

  const moved = JSON.parse(JSON.stringify(c))
  moved.bar.layout.left.reverse()
  assert.throws(() => P.placementAssign(moved, p, facts()), /stale/)
  assert.throws(() => P.placementAssign(JSON.parse(JSON.stringify(c)), { ok: false }, facts()), /stale/)
})

test("the host's own enable and disable leave the drawer consistent", () => {
  // `omarchy plugin disable acme.vpn` on a stowed third-party widget drops its
  // carrier (PluginRegistry.setEnabled); the board shows it off, in place.
  const stowed = withDrawer(["acme.vpn"], { plugins: [{ id: "acme.vpn", color: "red" }] })
  const hostDisabled = JSON.parse(JSON.stringify(stowed))
  hostDisabled.plugins = []
  const board = P.placementBoard(hostDisabled, facts())
  assert.equal(board.byId["acme.vpn"].state, "off")
  const on = plan(hostDisabled, { id: "acme.vpn", to: "drawer" })
  assert.deepEqual(on.next.plugins, [{ id: "acme.vpn" }], "turning it on recreates the carrier")

  // `omarchy plugin enable acme.vpn` after our off: the host removes it from
  // disabledPlugins and finds the carrier, so it comes back in the drawer.
  const off = plan(stowed, { id: "acme.vpn", to: "off" }).next
  const hostEnabled = JSON.parse(JSON.stringify(off))
  hostEnabled.disabledPlugins = []
  const again = P.placementBoard(hostEnabled, facts())
  assert.equal(again.byId["acme.vpn"].zone, "drawer")
  assert.equal(again.byId["acme.vpn"].state, "live")
})

test("a widget both on the bar and in the drawer is shown, never silently repaired", () => {
  const c = config()
  c.bar.layout.right[1].drawer = ["acme.vpn"]
  const board = P.placementBoard(c, facts())
  assert.deepEqual(board.conflicts, ["acme.vpn"])
  assert.equal(board.byId["acme.vpn"].zone, "left")
  assert.equal(plan(c, { id: "acme.vpn", to: "drawer" }).reason, "conflict")
})

test("plans leave absent host lists absent", () => {
  const c = config()
  delete c.plugins
  delete c.disabledPlugins
  const reorder = plan(c, { id: "omarchy.clock", to: "right", gap: 0 })
  assert.equal("plugins" in reorder.next, false)
  assert.equal("disabledPlugins" in reorder.next, false)
  const stow = plan(c, { id: "acme.vpn", to: "drawer" })
  assert.deepEqual(stow.next.plugins, [{ id: "acme.vpn", color: "red" }])
  assert.equal("disabledPlugins" in stow.next, false)
})
