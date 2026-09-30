import QtQuick
import "Placement.js" as Placement
import "PopupBridge.js" as PopupBridge

// Placement's owner: the one place a placement intent is turned into a write.
// It lives in the expanded panel, which stays loaded while the bar (and every
// popup) is rebuilt around it, and the popup reaches it through PopupBridge.
// See docs/design/m1-drawer.md, Placement.
//
// Callers read `board` and send `request(intent)`; the result is a ticket
//   { serial, ok, phase: "landed"|"refused"|"sent"|"unconfirmed", reason, note,
//     id, touched }
// kept in `ticket` so a popup rebuilt by the write can still show it.
// Moves between bar sections do not come here: they keep the store's
// omarchy-bar path, with its reconcile and "Use current layout" recovery.
Item {
  id: owner
  visible: false

  property string selfId: ""
  // { id: { name, kinds, firstParty } } from this window's store rows, or
  // null until it has loaded them. The popup usually loads its list first, so
  // any surface with rows offers them too; this window's own win when present.
  property var facts: null
  property var offeredFacts: null
  readonly property var effectiveFacts: owner.facts ? owner.facts : owner.offeredFacts
  function offerFacts(facts) { if (facts) owner.offeredFacts = facts }
  // Omniplug's scoped shell facade: barConfig and updateEntryInline.
  property var facadeShell: null
  // LiveShellConfig here; FakeShellConfig in tests.
  property var port: livePort

  LiveShellConfig {
    id: livePort
    facadeShell: owner.facadeShell
  }

  // PopupBridge calls this when any Omniplug bar widget finds the Bar root.
  function hostBarOffered(root) { livePort.hostBar = root }
  Component.onCompleted: livePort.hostBar = PopupBridge.hostBar()

  // Without the in-process writer only the bar is visible, so plugins[] and
  // disabledPlugins are unknown; Placement is told so rather than shown empty
  // lists.
  readonly property bool partial: !owner.port.config
  readonly property var config: owner.port.config ? owner.port.config
    : owner.facadeShell && owner.facadeShell.barConfig ? { bar: owner.facadeShell.barConfig } : null
  readonly property var placementFacts: ({
    selfId: owner.selfId, plugins: owner.effectiveFacts, canCross: owner.port.canCross, partial: owner.partial
  })
  readonly property var board: owner.config ? Placement.placementBoard(owner.config, owner.placementFacts) : null

  property var ticket: null
  property int serial: 0
  // How long a sent change may take to show before it is reported unconfirmed.
  property int confirmInterval: 3000
  property var waiting: null
  readonly property bool busy: owner.waiting !== null

  function currentConfig() {
    var live = owner.port.current()
    return live ? live : owner.config
  }

  function settle(fields) {
    var result = {
      serial: owner.serial, ok: fields.ok === true, phase: fields.phase, reason: fields.reason || "",
      note: fields.note || "", id: fields.id || "", touched: fields.touched || [], noOp: fields.noOp === true
    }
    owner.waiting = null
    owner.ticket = Object.freeze(result)
    return owner.ticket
  }

  function request(intent) {
    var id = intent && typeof intent.id === "string" ? intent.id : ""
    // A change in flight keeps its ticket; this request is simply refused.
    if (owner.waiting) return Object.freeze({ serial: owner.serial + 1, ok: false, phase: "refused",
      reason: "busy", note: Placement.PLACEMENT_NOTES.busy, id: id, touched: [], noOp: false })
    owner.serial++
    // An offer may have been missed; ask the bridge once more before planning.
    if (!owner.port.canCross && owner.port === livePort) {
      var shared = PopupBridge.hostBar()
      if (shared) livePort.hostBar = shared
    }
    var facts = owner.placementFacts
    var plan = Placement.placementPlan(owner.currentConfig(), facts, intent)
    if (!plan.ok) {
      // Say exactly what is out of reach, so a refusal can be acted on.
      var note = plan.reason === "needsBarAccess" && owner.port.problem
        ? plan.note + " " + owner.port.problem : plan.note
      return owner.settle({ ok: false, phase: "refused", reason: plan.reason, note: note, id: id })
    }
    if (plan.noOp) return owner.settle({ ok: true, phase: "landed", noOp: true, id: id })

    var result
    if (plan.channel === "own") {
      result = owner.port.writeOwn(owner.selfId, JSON.parse(JSON.stringify(plan.ownSettings)))
    } else if (plan.channel === "config") {
      // Re-planned inside the writer against the host's own copy; a throw
      // means nothing was persisted.
      result = owner.port.mutate(function(copy) { Placement.placementAssign(copy, plan, facts) })
    } else {
      return owner.settleRefused("needsBarAccess", id)
    }
    if (!result.ok) {
      var stale = /stale/.test(String(result.error))
      return owner.settle({ ok: false, phase: "refused", reason: stale ? "stale" : "writeFailed", id: id,
        note: stale ? Placement.PLACEMENT_NOTES.stale : "The change could not be saved. Nothing was moved." })
    }
    owner.waiting = { plan: plan, serial: owner.serial }
    owner.ticket = Object.freeze({ serial: owner.serial, ok: true, phase: "sent", reason: "", note: plan.note,
      id: id, touched: plan.touched, noOp: false })
    owner.verify()
    return owner.ticket
  }

  function settleRefused(reason, id) {
    return owner.settle({ ok: false, phase: "refused", reason: reason, id: id,
      note: Placement.PLACEMENT_NOTES[reason] || Placement.PLACEMENT_NOTES.invalid })
  }

  // Landed when the host shows what the plan expected. An own-entry write is
  // judged by the drawer order alone, which is all a partial read can see.
  function landed(plan) {
    var board = owner.config ? Placement.placementBoard(owner.config, owner.placementFacts) : null
    if (!board) return false
    if (plan.channel === "own") {
      var ids = board.zones.drawer.map(function(slot) { return slot.id })
      return JSON.stringify(ids) === JSON.stringify(plan.ownSettings.drawer || [])
    }
    return board.key === plan.expectedKey
  }

  function verify() {
    if (!owner.waiting) return
    var plan = owner.waiting.plan
    if (owner.landed(plan))
      owner.settle({ ok: true, phase: "landed", note: plan.note, id: plan.id, touched: plan.touched })
  }

  onConfigChanged: owner.verify()

  // Never retried: after this the user sees the board as it is and decides.
  Timer {
    interval: owner.confirmInterval
    running: owner.waiting !== null
    onTriggered: {
      var plan = owner.waiting ? owner.waiting.plan : null
      if (plan) owner.settle({ ok: false, phase: "unconfirmed", id: plan.id, touched: plan.touched,
        note: "The change was sent but the bar has not shown it yet. Check the board before trying again." })
    }
  }
}
