# M1: the Drawer

Status: implemented. M2 replaced the Dashboard outlined at the end with
stacks; see [m2-stacks.md](m2-stacks.md). The Drawer described here is now
where stacks are configured, and stowing is gone.

Omniplug is a fork of Juan Casanueva's Plugin Manager for the Omarchy 4.x
shell. M1 does two things: it gives the project its own identity, and it lets
you stow bar widgets you seldom use in a **Drawer** behind Omniplug's own bar
icon, so the bar stops being crowded.

The design came out of a grilling session (every decision below was put to
the owner and answered) and a design-it-twice round: three competing
interfaces each for Placement and for Hosting, compared on depth, locality and
seam placement. What follows is the hybrid that won.

## Glossary

Use these words in code, comments and tests.

| Term | Meaning |
|---|---|
| **Widget** | A bar widget contributed by a plugin, first-party (`omarchy.*`) or third-party, identified by its id. |
| **Entry** | One placement record in `shell.json`: a bare id string or `{id, ...per-entry settings}`. |
| **Zone** | Where a widget lives. M1: `left`, `center`, `right` (the bar sections) and `drawer`. M2 adds `dashboard`. A widget lives in exactly one zone. |
| **Drawer** | Omniplug's popup when you click its bar icon: a row of stowed widgets, live, wrapping into a grid, with **Manage** in the header. |
| **Stowed widget** | A widget whose zone is `drawer`. |
| **Carrier** | The `plugins[]` entry `{id, ...settings}` that keeps a stowed widget enabled and holds its settings. |
| **Placeholder** | The `⚠ <name>` tile shown for a stowed widget that is missing or failed to load. It stays until it is removed in Arrange. |
| **Board** | Placement's frozen read of every zone. Arrange draws it; the Drawer and the manager read it. |
| **Intent** | One request to Placement: "put widget X in zone Z (at gap G)", or "turn it off", or "remove it". |
| **Hosting** | Running another plugin's widget inside Omniplug's own windows so it behaves as it does in the bar. |
| **Stage** | The per-monitor owner of every hosted widget instance. |
| **Mount** | A place in a view where the Stage shows one hosted instance. |
| **Bar root** | The host's built-in `Bar` object for one monitor (`plugins/bar/Bar.qml`). Not public API. |

Architecture words (module, interface, seam, adapter, depth, leverage,
locality) are used as in Matt Pocock's `codebase-design` skill.

## Decisions (from the grilling)

1. Omniplug keeps a single bar widget, the puzzle icon. Clicking it opens the
   Drawer. Middle click still refreshes. The update badge stays on the icon.
2. The Drawer shows the stowed widgets live, in arranged order, in a row under
   the icon that wraps into a grid. It opens on click, not on hover.
3. The Drawer header has **Manage**, which switches to today's manager (the
   Installed and Browse tabs). **Back** returns to the Drawer. The expand icon
   still opens the full panel.
4. There is one Drawer. You fill it by hand: Arrange gains a **Drawer** zone
   beside Left, Center and Right, and every widget is in exactly one zone.
5. Clicking a stowed widget opens its own popup. The Drawer stays open under
   it, and closing the Drawer closes that popup.
6. A stowed widget that is uninstalled or fails to load becomes a placeholder.
   Nothing is cleaned up silently.
7. Switching a stowed widget off and on again in the manager puts it back in
   its Drawer spot.
8. Hotkeys that summon a stowed widget's panel are out of scope.
9. Identity: id `io.github.h3sam.omniplug` (also the IPC target), name
   **Omniplug**. MIT, keeping Juan's copyright line.
10. Milestones: **M1** is the rename and the Drawer. **M2** is the Dashboard,
    the `dashboardCard` contract and the separate Resources plugin.

## What the host allows (the facts the design rests on)

References are to the Omarchy source, `basecamp/omarchy` branch `quattro`
(`8b4eae6`, equivalent to v4.0.4 for these files), under `shell/`.

- **Enabled means registered.** A widget's component is loaded into the bar's
  widget registry only while its plugin is enabled (`shell.qml`
  `syncPluginWidgets`). `PluginRegistry.isEnabled`
  (`services/PluginRegistry.qml:148-164`) returns false for any id listed in
  `disabledPlugins`. Otherwise a first-party widget is always enabled, and a
  third-party widget is enabled only when an entry for it exists in
  `bar.layout` or `plugins[]`. That is why a stowed third-party widget needs a
  carrier.
- **`omarchy plugin list` says "enabled" only for widgets in the bar.** For a
  bar widget, `enabled` is `inBar(id)` (`shell.qml:1806-1807`), so it reports
  every stowed widget as off. The manager has to take on/off from Placement.
- **No public write can stow a widget.**
  - Our scoped facade offers `updateEntryInline` on our own entry only.
  - `_mutateBarConfig` is refused, because it is only for plugins of the `bar`
    kind (`shell.qml:641-643`).
  - `omarchy plugin enable` puts a bar widget *into the bar*.
  - `omarchy-bar` only knows bar sections.
- **The in-process writer.** `ShellRoot.mutateShellConfig(mutator)`
  (`shell.qml:164-168`) deep-copies `shellConfig`, calls the mutator, then
  persists it and assigns `shellConfig` synchronously. If the mutator throws,
  nothing is persisted. It is reachable only through the Bar root's `shell`
  property.
- **`updateEntryInline(id, settings)`** (`shell.qml:1069`) rewrites every
  *object* entry with that id in `bar.layout`. Only if it finds none does it
  rewrite matching `plugins[]` entries. It never matches bare-string entries.
  The bar patches a settings-only change in place (`BarModel.inlineSettingsDelta`).
  Any structural change rebuilds every bar widget on every monitor.
- **Hosting.** Every hosting plugin (Bar Drawer, Groups, Ty Richards' tray)
  reaches the Bar root the same way: it walks the bar window's item tree to a
  first-party widget whose `bar` is the Bar root. It then does what the bar's
  `ModuleSlot` does (`plugins/bar/Bar.qml:1773-2010`):
  - loads `barWidgetRegistry.widgets[id].component`;
  - injects `bar` (the Bar root for first-party widgets,
    `pluginBarApiFor(id, id, true)` for third-party ones), then `moduleName`,
    then `settings`;
  - injects again on the next tick.

  This needs at least one `omarchy.*` widget on the bar.
- **The shell deletes facades nobody uses.** A facade is destroyed when no
  registered module slot claims its id (`Bar.qml:281-319`). Registering a
  proxy slot (`registerModuleSlot`) keeps a hosted widget's facade alive.
- **One popout at a time.** `Bar.requestPopout(owner)` closes the previous
  owner through `closeForPopoutSwitch()`, or `close()` if it has none
  (`Bar.qml:542-553`).
- **Child panels position themselves against their anchor's window.**
  `Ui/KeyboardPanel.qml:189-214` and `Ui/PopupCard.qml:25,90` measure the
  anchor window's thickness. A hosted widget in a full-screen window would open
  its panel at the far edge of the screen, so the window hosting widgets must
  run from the screen edge across the bar to the far side of the tiles, the
  way Bar Drawer's `Shelf.qml` does.
- **Tooltips and clicks.**
  - The bar draws tooltips only for targets in its own window, so hosts mirror
    `tooltipTarget`, `tooltipText` and `tooltipShown` into their own window.
  - Click hit-testing (`Bar.qml:982-1005`) skips targets that are not
    `visible`, so hidden hosted widgets must be `visible: false`.

## Modules and seams

```
                 ┌──────────────── Omniplug ──────────────────────────────┐
 Arrange board ──┤ Placement (QML owner) ── Placement.js (pure)           │
 Manager rows  ──┤      │ ShellConfigPort ──┬─ LiveShellConfig ─┐         │
 Drawer view   ──┤      │                   └─ FakeShellConfig  │         │
                 │ HostStage / HostMount ── HostingModel.js (pure)│        │
                 │      │ HostPort ─────────┬─ LiveBarPort ─────┤         │
                 │                          └─ FakeBarPort      │         │
                 │                       BarLocator (shared) ◄──┘         │
                 └────────────────────────────────────┬──────────────────┘
                                                      ▼
                                   host internals: Bar root, ShellRoot
```

- **Two pure modules hold every rule.** `Placement.js` and `HostingModel.js`
  run in Node tests. `Placement.js` absorbs today's `barLayoutSnapshot`,
  `barLayoutMove` and `barSectionMovePlan`.
- **Two ports, real seams.** Each has a live adapter and a fake. Placement's
  `ShellConfigPort` can write config. Hosting's `HostPort` cannot. They share
  only the `BarLocator` (finding and caching the Bar root), so Placement tests
  never fake popouts, and Hosting can never write `shell.json`.
- **One source of truth for host member names.** `LiveBarPort.qml` and
  `LiveShellConfig.qml` are the only files that name host members. A drift test
  checks those names against the host source when it is available.

## Placement

### Interface

```
board                      // frozen, recomputed whenever the config changes
request(intent) → Ticket   // the only write

Board   { key, zones: { left, center, right, drawer: [Slot] }, byId: { id → Slot },
          canStow, reason }
Slot    { id, zone, index, name, settings, state: "live" | "off" | "missing" }
Intent  { id, to: "left" | "center" | "right" | "drawer" | "off" | "remove",
          gap?, from?: { zone, index }, key? }
Ticket  { serial, ok, phase: "landed" | "refused" | "sent" | "unconfirmed", reason, note }
```

- **Positional intents** (Arrange) carry `from` and `key` from the board the
  user dragged on. **By-id intents** (the manager) leave them out, and
  Placement fills them in from the current board. Either way the write is
  checked against the key.
- **`gap`** is the insertion slot in the destination zone as displayed, before
  the source is removed. This is today's convention. If it is omitted:
  - a widget returning to the drawer goes back to its remembered spot;
  - anything else going to the drawer goes to the end;
  - a bar section uses today's anchor rule (after workspaces, weather or tray).
- **`to: "off"`** applies only to a stowed widget: it adds the widget to
  `disabledPlugins` and keeps its drawer spot and carrier. For a widget in the
  bar, Placement refuses with `notStowed`, and the manager keeps using the
  host's own disable (`omarchy plugin disable`).
- **Turning it back on** is `to: "drawer"` with no `gap`, which also removes
  it from `disabledPlugins`.
- **`to: "remove"`** forgets a stowed id. This is how a placeholder is removed,
  and it drops the carrier as well.

### Storage

- **Omniplug's own entry** (wherever it sits, normally `bar.layout`) gains
  `drawer: [id, ...]`. The list holds the order, and off members stay in it.
- **Each stowed widget has a carrier** `{id, ...settings}` in `plugins[]`. It
  keeps a third-party widget enabled, and it is where the widget's own
  `updateEntryInline` saves land while it is stowed. That keeps settings where
  they are read, so nothing has to reclaim them the way Groups does.
- **Moving bar → drawer** removes the layout entry, merges its settings into
  the carrier (creating it if needed), and inserts the id into `drawer`.
- **Moving drawer → bar** inserts the carrier's settings as the layout entry.
  It removes the carrier unless the manifest has kinds other than `bar-widget`,
  in which case it keeps `{id}`. It then removes the id from `drawer`.
- **Off** means the id is in `disabledPlugins`. `isEnabled` checks that list
  first, for first- and third-party widgets alike. This works with the host's
  own tools: `omarchy plugin enable X` removes X from `disabledPlugins` and
  finds the carrier, so a stowed widget comes back on *in the drawer*. It is
  never inserted into the bar.

### Invariants

- **One place per widget.** An id is either in the bar (the host allows
  duplicates there) or in `drawer`, exactly once, never both. Reads never
  repair a hand-edited config. A conflict shows on the board and is refused
  for stowing.
- **No surprise removals.** Only an intent removes anything. Placeholders stay
  until you remove them.
- **One write per intent, never retried.** Each intent is at most one
  `shell.json` change, checked against the board key the caller saw. A
  mismatch is refused as `stale`.
- **Things Placement refuses to stow:**
  - Omniplug itself;
  - `bar`-kind plugins;
  - custom (`type`) entries;
  - ids that are duplicated in the bar;
  - the last `omarchy.*` widget on the bar, because hosting needs one to find
    the Bar root.
- **Our own entry.** Every write to Omniplug's own entry reads that entry
  fresh and modifies it in the same JS turn. This includes the existing
  settings switches (`writeSelfSetting`), so a settings write can never
  overwrite the drawer order.

### Write channels (inside `ShellConfigPort`)

The least-privileged channel that can express the plan is chosen.

1. **Own entry only**, such as a drawer reorder, off→on inside the drawer, or
   removing a placeholder that has no carrier: `updateEntryInline(selfId, entry)`,
   read and written in the same turn. The bar is not rebuilt. If our own entry
   is a bare string, this channel cannot reach it, so the first write goes
   through channel 2.
2. **Everything else**: `ShellRoot.mutateShellConfig(mutator)`, reached
   through the `BarLocator`.
   - The mutator first re-derives the key from the config it is given and
     throws on mismatch. It validates the whole plan before touching anything,
     so a refusal persists nothing.
   - The engine is single-threaded, so the check and the write are one atomic
     step.
   - Afterwards Placement re-reads `shellConfig` and compares it with the plan's
     expected result. A difference is reported as `unconfirmed`, not retried.
3. **No Bar root found**: bar-only moves fall back to today's
   `omarchy-bar move` path, with the same timeout, output cap, argv safety and
   reconcile step. Moves that cross between the bar and the drawer are refused
   with `needsBarAccess`. Without a Bar root the Drawer cannot host widgets
   anyway, so there is no file-editing fallback. It would only add a channel
   that can race the host's own writes.

In M1, Arrange sends Placement only the drops that involve the Drawer (and
the placeholder remove control). A move between two bar sections keeps the
store's tested `omarchy-bar move` path, whether or not the in-process writer
is reachable; `Placement.placementIntentFor` makes that split, and
`placementArrangeSnapshot` builds the four-column board from the bar snapshot
Arrange already had plus Placement's drawer.

### Where it lives

- **The owner is a single Placement object** in the retained, keepLoaded
  Expanded panel, reached from the popup through PopupBridge. That is today's
  move-owner pattern.
- **Plugin facts.** Placement needs the plugin list (kinds, built-in or not)
  for anything that touches carriers. The expanded window loads its list only
  when opened, so any surface that has loaded rows offers them to the owner
  (`offerFacts`); the window's own list wins once it has one.
- **Rebuilds.** A structural write rebuilds every bar widget, including
  Omniplug's popup, so callers hold no closures across a write. They re-read
  `board` and the last ticket.

### Errors

Nothing throws. A ticket comes back `refused`, with one of these reasons:

| Reason | Meaning |
|---|---|
| `stale` | The config changed since the caller's board key |
| `busy` | Another write is in flight |
| `invalid` | The intent is malformed |
| `self` | Tried to stow, switch off or remove Omniplug itself (moving it around the bar is fine) |
| `notStowable` | A refused kind, custom entry or conflict |
| `lastBuiltin` | Would stow the last `omarchy.*` widget on the bar |
| `duplicate` | The id appears more than once on the bar |
| `needsBarAccess` | No Bar root, and the move crosses the bar and the drawer |
| `untransportable` | An id that the CLI fallback cannot pass through argv losslessly |
| `limits` | The config is too large to process |
| `unreadable` | The config, or the plugin list a carrier change depends on, could not be read whole |
| `conflict` | The id is both on the bar and in the drawer (a hand edit); move one copy by hand |
| `notStowed` / `notPlaced` | Off or remove for a widget not in the drawer; a bar move for a widget placed nowhere |

Otherwise the phase is `landed`, `sent` (only on the CLI fallback, while it
waits for the host) or `unconfirmed`. Each ticket carries a one-line `note`
for the status bar.

## Hosting

### Interface

```qml
// BarWidget.qml: one per Omniplug bar-widget instance, so one per monitor
HostStage {
  required property Item owner      // Omniplug's BarWidget: popout identity, facade, bar window
  property var entries: []          // Slots from placement.board.zones.drawer, in order
  property bool shown: false        // hosted content is on screen and may take input
  readonly property var tiles       // frozen [{key, id, name, state, reason}], in entry order
  readonly property bool childPanelOpen
  readonly property string hostProblem   // "" | "searching" | "no-builtin-widget"
  signal dismissRequested()         // a popout outside this stage took over; close the Drawer
  function deferPopoutSwitch()      // → bool; owner.closeForPopoutSwitch() calls this first
}

// In a view (the Drawer now, Dashboard cards in M2)
HostMount { required property var stage; required property string key }
```

- **Tile states:**
  - `waiting`: the Bar root is still being searched for, or the registry is
    still scanning. A tile stays here at most ~10 s.
  - `live`: the widget is running.
  - `missing`: `not-installed`, `disabled` or `not-registered`.
  - `failed`: the load error text.
  - `refused`: `self` or `no-host`.
- **Keys** are `id#n`, where n counts earlier occurrences of the same id. A key
  stays the same across reorders, settings edits and, in M2,
  drawer↔dashboard moves.

### Invariants

- **Lifetime.** An instance exists for a key while the key is in `entries`,
  the stage is alive and the registry has a component for the id.
  - Its life does not depend on `shown` or on mounts. When unmounted, the
    instance is parked invisibly inside the stage.
  - Switching to Manage and back costs nothing.
  - Stowed widgets keep their IPC and `broadcast()` peers working, just as they
    did in the bar.
- **Mounting** re-parents the instance: O(1), and no restart. If a second
  mount asks for the same key, it stays 0×0.
- **Injection is done exactly as `ModuleSlot` does it.**
  - `bar`, then `moduleName`, then `settings`, and again on the next tick.
  - Only properties the widget declares are set.
  - Settings are the entry's inline keys overlaid by its carrier, and the
    carrier wins.
  - Settings are re-injected only when their JSON changes.
- **Hidden means inert.** Unless `shown` is true and the instance is mounted,
  it is `visible: false`, so the host's click and tooltip checks ignore it.
- **Popouts.** While `shown`, the Bar root's `activePopout` may only be:
  - the owner (the Drawer itself);
  - a hosted child's own popout (the Drawer stays open);
  - null, briefly, after which the stage takes the popout back for the owner.

  Anything else fires `dismissRequested` exactly once. When `shown` becomes
  false, an open child panel is closed first.
- **Read-only.** Hosting never writes `shell.json` and never runs a CLI.
- **It never hosts Omniplug itself.**

### Caller obligations

- **O1.** Create the stage in `BarWidget.qml`, next to the panel loader, not
  inside a view.
- **O2.** `BarWidget.closeForPopoutSwitch()` calls `stage.deferPopoutSwitch()`
  first, and returns if it answers true.
- **O3.** `shown` goes false no later than the moment the Drawer starts
  hiding.
- **O4.** Mounts live in the Drawer window, which runs from the screen edge
  across the bar to the far side of the card and is masked to the card. The
  Drawer suspends its own outside-click dismissal while `childPanelOpen`.

### What it hides

- **Finding the Bar root.** A bounded walk (at most 8000 nodes, retried every
  250 ms up to 40 times) of the owner's bar window, looking for a first-party
  slot whose `bar` passes the `isHostBar` duck-type check. The result is cached
  per screen in a `.pragma library` file and checked again before each use.
- **Proxy slots.** One proxy module slot per instance, registered *before*
  asking for its facade.
  - Its region is `"omniplug"`, which no bar section uses, so drop targets,
    tab order and `applySettingsDelta` skip it.
  - It exposes `activeItem` only while shown, so summon routing never opens a
    hidden child.
  - Fallback: re-inject on `pluginBarApisChanged` if `registerModuleSlot` is
    missing.
- **Click targets.** After hosted targets change, the owner's own buttons are
  registered again, so Omniplug's icon stays first in the scan.
- **Tooltips.** Mirrored into a popup in the Drawer window, for targets that
  belong to it.
- **Popout ownership.** A popout counts as the stage's when it is a hosted
  instance, when its `anchorItem` sits inside a mounted tile, or, as a
  fallback, when a hosted widget reports `opened`. The decision waits a
  `callLater` so the popout has settled.
- **Transparent bars.** The foreground colour is rebound so widgets stay
  readable on the Drawer card.
- **Also inside:** bounds on inputs, and the placeholder component.

### How it degrades when the host changes

Every port member is checked before use, and each missing capability costs one
feature, never the Drawer as a whole.

| Host change | Result |
|---|---|
| No Bar root found | Every tile is a `no-host` placeholder; Manage still works |
| `registerModuleSlot` gone | Re-inject fallback; a pruned facade can drop an open child panel |
| `activePopout` unreadable | `opened` probe; worst case a child's panel closes the Drawer |
| Tooltip state renamed | No tooltips in the Drawer |
| Host ships public hosting | Swap the adapter; the interface stays the same |

## The Drawer view and Manage

- **Click the puzzle icon** and the Drawer window opens. It has a header
  (Omniplug, **Manage**, Arrange, Settings), then the row of `HostMount`s
  wrapping into a grid, with a placeholder tile wherever a stowed widget is
  missing. With nothing stowed, it shows a one-line hint pointing at Arrange.
- **Manage** closes the Drawer window and opens today's manager popup (the
  `KeyboardPanel` in `Panel.qml`) on the same screen, with a **Back** button
  that reverses the swap. Two windows, drawn to look like one popup.
- **Placeholder tiles** say what is wrong in their tooltip: not installed,
  disabled, no built-in widget on the bar, or the load error.

## Arrange and the manager

- **Arrange** draws `placement.board`, with a fourth column, **Drawer**. A drop
  becomes one `placement.request(...)`.
  - The board shows `stale`, `lastBuiltin` and the other refusals as today's
    status line does.
  - A placeholder tile in the Drawer column has a remove control, which sends
    `to: "remove"`.
- **Manager rows** are the store's rows passed through `Model.withStowed`
  on each surface: a stowed row reads as on unless it was switched off, and
  sits in the `drawer`. A stowed widget's switch sends `to: "off"`, or
  `to: "drawer"` to turn it back on. Every other row keeps today's
  enable/disable path, and the place dialog gains **Drawer** as a choice when
  Placement can stow. It is not offered while installing: an install lands
  (and rebuilds the bar) before Placement could stow it.

## Tests

- **Node** (`node --test`):
  - `test/placement.test.mjs`: board derivation, every intent across all
    zones, the storage rules, off/on memory, refusals, key checks, and the
    shell-CLI interplay described above.
  - `test/hosting-model.test.mjs`: keys, the settings merge, the tile-state
    table, the popout verdicts, and the Bar-root finder over plain object
    trees.
  - `test/host-contract.test.mjs`: the drift canary. It checks every host
    member the live adapters name against `$OMARCHY_PATH/shell`, and skips
    when that is absent.
  - Existing tests that covered `barLayoutSnapshot` and `barLayoutMove` move to
    Placement's interface.
- **QML**: HostStage and HostMount against `FakeBarPort`, and Placement's QML
  owner against `FakeShellConfig`, under the repo's offscreen PySide6 harness
  where it can run.
- **Manual, on a real Omarchy 4.x machine:**
  - bars at the top, bottom and left;
  - two monitors;
  - first- and third-party widgets;
  - stowing and unstowing;
  - off→on memory;
  - a hosted widget's popup opening from the Drawer;
  - uninstalling a stowed plugin.

## M2 hooks (not built in M1)

- **`dashboard` zone.** A zone of cards, stored in the own entry as
  `dashboard: [[id, ...], ...]`, and addressed with `to: "dashboard"` plus
  `{card, gap}` or `{newCard}`. It follows the same carrier rule.
- **Cards.** A card is a row of `HostMount`s on the same stage.
- **Plugin-drawn cards.** A plugin's `entryPoints.dashboardCard` would add one
  member to the host port, `cardComponent(id)`.

## Build order

Each step is one commit.

1. This document.
2. The rename to Omniplug.
3. `Placement.js` and its tests.
4. `HostingModel.js`, the host ports and adapters, and the drift test.
5. HostStage and HostMount.
6. The Drawer view and Manage/Back.
7. The Arrange Drawer zone, the Placement owner and the manager rows.

## Credits

The hosting mechanics follow techniques from three MIT-licensed plugins, whose
notices are kept wherever code is adapted:

- Bar Drawer (SykesTheLord)
- Groups (Katsari and kristofferR)
- Ty Richards' tray
