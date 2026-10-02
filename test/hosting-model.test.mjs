// HostingModel.js is loaded by QML; evaluate the shipped source and test the
// rules through its functions only.
import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const source = readFileSync(new URL("../HostingModel.js", import.meta.url), "utf8")
const H = Function(source + `; return { hostingIsHostBar, hostingCanWrite, hostingFindHostBar,
  hostingIsDescendant, hostingTiles, hostingSettings, hostingSettingsKey, hostingTileState,
  hostingReasonText, hostingPopoutVerdict, HOSTING_MAX_ENTRIES, hostingStackCards, hostingStackEntries,
  hostingWrap, hostingWheelStep, hostingStackExtent }`)()

const barRoot = (over = {}) => ({
  pluginBarApiFor() {}, requestPopout() {}, registerModuleSlot() {}, barWidgetRegistry: {}, ...over
})

test("a Bar root is recognised by what it can do, and only a real ShellRoot can write", () => {
  assert.equal(H.hostingIsHostBar(barRoot()), true)
  assert.equal(H.hostingIsHostBar({ ...barRoot(), registerModuleSlot: undefined }), false)
  assert.equal(H.hostingIsHostBar({ pluginBarApiFor() {} }), false, "a facade is not a root")
  assert.equal(H.hostingIsHostBar(null), false)
  assert.equal(H.hostingCanWrite(barRoot({ shell: { mutateShellConfig() {}, shellConfig: {} } })), true)
  assert.equal(H.hostingCanWrite(barRoot({ shell: { summon() {} } })), false, "a replacement bar's facade")
  assert.equal(H.hostingCanWrite(barRoot()), false)
  const throwing = { get shell() { throw new Error("gone") } }
  assert.equal(H.hostingCanWrite(throwing), false)
})

test("the Bar root is found through a built-in widget, within a node budget", () => {
  const root = barRoot()
  const tree = { children: [
    { bar: { pluginBarApiFor() {} }, children: [] },
    { children: [{ children: [{ bar: root, children: [] }] }] }
  ] }
  assert.equal(H.hostingFindHostBar(tree), root)
  assert.equal(H.hostingFindHostBar(tree, 3), null, "the walk stops at its budget")
  assert.equal(H.hostingFindHostBar(null), null)
  const hostile = { children: [{ get bar() { throw new Error("destroyed") }, children: null }] }
  assert.equal(H.hostingFindHostBar(hostile), null)
})

test("descendant checks walk parents and survive cycles and dead objects", () => {
  const a = { parent: null }, b = { parent: a }, c = { parent: b }
  assert.equal(H.hostingIsDescendant(c, a), true)
  assert.equal(H.hostingIsDescendant(a, c), false)
  const loop = {}; loop.parent = loop
  assert.equal(H.hostingIsDescendant(loop, a), false)
})

test("tiles get stable id#n keys, keep order, and are capped", () => {
  const tiles = H.hostingTiles([
    { id: "omarchy.clock", name: "Clock", settings: { format: "24h" }, state: "live" },
    "acme.vpn",
    { id: "omarchy.clock", state: "off" },
    { id: "io.github.h3sam.omniplug" },
    null, { id: 3 }
  ], "io.github.h3sam.omniplug")
  assert.deepEqual(tiles.map(t => t.key),
    ["omarchy.clock#0", "acme.vpn#0", "omarchy.clock#1", "io.github.h3sam.omniplug#0"])
  assert.equal(tiles[0].name, "Clock")
  assert.equal(tiles[1].name, "acme.vpn")
  assert.deepEqual(tiles[0].settings, { format: "24h" })
  assert.equal(tiles[2].placement, "off")
  assert.equal(tiles[3].self, true)
  const many = Array.from({ length: 100 }, (_, i) => "w" + i)
  assert.equal(H.hostingTiles(many, "").length, H.HOSTING_MAX_ENTRIES)
  assert.deepEqual(H.hostingTiles("nope", ""), [])
})

test("settings are the entry's keys with the carrier on top, never the id", () => {
  assert.deepEqual(H.hostingSettings({ id: "x", color: "red", size: 2 }, { id: "x", color: "blue" }),
    { color: "blue", size: 2 })
  assert.deepEqual(H.hostingSettings(null, undefined), {})
  assert.equal(H.hostingSettingsKey({ a: 1 }), '{"a":1}')
  const cyclic = {}; cyclic.self = cyclic
  assert.equal(H.hostingSettingsKey(cyclic), "")
})

test("tile state: waiting only while there is reason to wait, then an honest reason", () => {
  const base = { placement: "live", attached: true, searching: false, scanning: false, graceOver: true }
  assert.deepEqual(H.hostingTileState({ ...base, hasComponent: true }), { state: "live", reason: "" })
  assert.deepEqual(H.hostingTileState({ ...base, self: true }), { state: "refused", reason: "self" })
  assert.deepEqual(H.hostingTileState({ ...base, placement: "missing" }), { state: "missing", reason: "not-installed" })
  assert.deepEqual(H.hostingTileState({ ...base, placement: "off" }), { state: "missing", reason: "disabled" })
  assert.deepEqual(H.hostingTileState({ ...base, attached: false, searching: true, graceOver: false }),
    { state: "waiting", reason: "" })
  assert.deepEqual(H.hostingTileState({ ...base, attached: false, searching: true, graceOver: true }),
    { state: "refused", reason: "no-host" })
  assert.deepEqual(H.hostingTileState({ ...base, scanning: true }), { state: "waiting", reason: "" })
  assert.deepEqual(H.hostingTileState({ ...base, graceOver: false }), { state: "waiting", reason: "" })
  assert.deepEqual(H.hostingTileState({ ...base }), { state: "missing", reason: "not-registered" })
  assert.deepEqual(H.hostingTileState({ ...base, hasComponent: true, loadError: "boom" }), { state: "failed", reason: "boom" })
  assert.match(H.hostingReasonText("no-host"), /Omarchy widget/)
  assert.match(H.hostingReasonText("TypeError: x"), /Could not load: TypeError/)
  assert.equal(H.hostingReasonText(""), "")
})

test("popout verdicts keep the drawer for its own children and dismiss it for anything else", () => {
  const owner = {}, child = {}, stranger = {}
  assert.equal(H.hostingPopoutVerdict({ shown: false, active: stranger, owner }), "keep")
  assert.equal(H.hostingPopoutVerdict({ shown: true, active: owner, owner }), "keep")
  assert.equal(H.hostingPopoutVerdict({ shown: true, active: child, owner, ownsActive: true }), "keep")
  assert.equal(H.hostingPopoutVerdict({ shown: true, active: null, owner }), "reclaim")
  assert.equal(H.hostingPopoutVerdict({ shown: true, active: stranger, owner, ownsActive: false }), "dismiss")
})

test("a stack shows its cards without switched-off widgets, and hosts every slot", () => {
  const stack = { cards: [[{ id: "a", state: "live" }, { id: "b", state: "off" }], [{ id: "c", state: "off" }],
    [{ id: "d", state: "missing" }]] }
  assert.deepEqual(H.hostingStackCards(stack).map(card => card.map(s => s.id)), [["a"], ["d"]])
  assert.deepEqual(H.hostingStackEntries(stack).map(s => s.id), ["a", "b", "c", "d"])
  assert.deepEqual(H.hostingStackCards(null), [])
  assert.deepEqual(H.hostingStackEntries({}), [])
})

test("flipping wraps around both ends, one card per wheel notch", () => {
  assert.equal(H.hostingWrap(2, 1, 3), 0)
  assert.equal(H.hostingWrap(0, -1, 3), 2)
  assert.equal(H.hostingWrap(5, 0, 3), 2, "a remembered index past the end is brought back in")
  assert.equal(H.hostingWrap(0, 1, 0), 0)
  assert.deepEqual(H.hostingWheelStep(0, -120), { step: 1, rest: 0 }, "down goes forward")
  assert.deepEqual(H.hostingWheelStep(0, 240), { step: -2, rest: 0 })
  assert.deepEqual(H.hostingWheelStep(0, -40), { step: 0, rest: -40 }, "a touchpad accumulates")
  assert.deepEqual(H.hostingWheelStep(-100, -40), { step: 1, rest: -20 })
})

test("a stack keeps its fixed width and only fans out wider, while hovered", () => {
  const base = { hasCards: true, fixed: 160, natural: 300, emptyExtent: 20 }
  assert.equal(H.hostingStackExtent(base), 160)
  assert.equal(H.hostingStackExtent({ ...base, fanned: true }), 300)
  assert.equal(H.hostingStackExtent({ ...base, fanned: true, natural: 100 }), 160, "a narrow card never shrinks it")
  assert.equal(H.hostingStackExtent({ ...base, hasCards: false }), 20)
})
