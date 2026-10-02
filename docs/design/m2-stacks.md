# M2: Stacks

Status: agreed design, being implemented. It replaces the "M2 hooks" section
of [m1-drawer.md](m1-drawer.md): the Dashboard outlined there is not being
built. M1's Placement, Hosting and the Drawer window are reused; what M1 called
"stowing" goes away.

A **stack** is a bar entry with a fixed width that holds several **cards**.
A card is a row of widgets you choose. The bar shows one card at a time and the
mouse wheel flips between them. The **Drawer** (the puzzle icon's popup)
becomes the place where you build stacks and decide what goes in each card.

The decisions came out of a grilling session with the owner. The technical
choices below them were checked against the Omarchy source
(`basecamp/omarchy` branch `quattro`, `821ae58`), under `shell/`.

## Glossary

The M1 glossary still holds, with these additions and changes.

| Term | Meaning |
|---|---|
| **Stack** | An Omniplug bar entry `{id: <omniplug>, stack: <sid>}` that shows one card at a time in a fixed width. |
| **Card** | One row of widgets inside a stack. A stack has zero or more cards. A card is never empty. |
| **Stacked widget** | A widget whose zone is `stack`. It is in exactly one card of exactly one stack. |
| **Stack store** | Omniplug's `plugins[]` entry, `{id: <omniplug>, stacks: {<sid>: {...}}}`, which holds every stack's cards and settings. |
| **Icon** | The Omniplug entry without `stack`: the puzzle icon that opens the Drawer. |
| **Fan out** | A card wider than its stack grows to its full width while hovered, pushing the rest of the bar aside. |
| **Bar strip** | The Drawer's row of what is on the bar now, the source and target of drags into and out of cards. |
| **Carrier** | As in M1: the `plugins[]` entry that keeps a stacked widget enabled and holds its settings. |

## Decisions (from the grilling)

1. A stack shows one card. The mouse wheel over it flips to the next card.
   Clicks go to the widget under the pointer, so its own popup opens as usual.
2. A card is a row of widgets, configured in the Drawer.
3. Each stack has a fixed width. A card whose widgets are wider than that fans
   out on hover: the stack grows to the card's width, pushing its neighbours
   aside, and shrinks back when the pointer leaves.
4. There can be many stacks, anywhere on the bar. Every widget is still in
   exactly one place: a bar section or one card.
5. The Drawer becomes the place to configure stacks. It no longer hosts stowed
   widgets.
6. Building: the Drawer shows a bar strip and, below it, each stack with its
   cards as rows. Drag a widget from the strip into a card or onto
   **+ New card**; drag it back to the strip to return it to the bar.
7. **+ New stack** in the Drawer adds an empty stack at the end of the right
   section. You move it like any other entry in Arrange. Deleting a stack
   returns its widgets to the bar where the stack was, in card order.
8. Widgets stowed with M1 become one new stack with one card holding them all,
   at the end of the right section. Nothing disappears.
9. Per-stack settings: the **fixed width** and whether the **card indicator**
   dots are drawn. Stacks have no names and no auto-rotate.
10. Flipping wraps around past the last card. The shown card is remembered
    while the shell runs; a shell restart shows the first card.

These were decided by me (not grilled), as the smallest choice that fits:

- A stack with no cards shows a dim stack icon on the bar, so it can be found.
- A card stays fanned out while one of its widgets has its popup open, so the
  popup's anchor does not move under it.
- A stacked widget switched off in the manager is hidden on the bar and shown
  dimmed in the Drawer. A missing one is a `⚠` placeholder in both, until it
  is removed in the Drawer.
- An empty card is removed as soon as its last widget leaves.
- Cards cannot yet be reordered, except by moving their widgets.
- On a vertical bar the fixed width is a fixed height, and a card is a column.

## What the host allows (new facts)

- **Settings-only writes do not rebuild the bar, unless the id is duplicated.**
  `Bar.applyBarConfig` patches a write in place when
  `BarModel.inlineSettingsDelta` finds the same ids in the same order. It gives
  up (and rebuilds every widget on every monitor) when a changed entry's id
  appears more than once (`BarModel.js:68-104`). With stacks, Omniplug's id is
  on the bar several times. So **nothing a stack shows may live in its bar
  entry.** The entry `{id, stack: sid}` is written once, when the stack is
  made, and never changed. Everything else lives in the stack store in
  `plugins[]`, which the bar does not read, so editing cards or settings never
  rebuilds the bar.
- **A change outside `bar.layout` reaches the bar as an empty delta.** The new
  `barConfig` produces an empty delta, so the bar patches nothing
  (`Bar.qml:585-600`).
- **`updateEntryInline(id, settings)` rewrites every object entry with that
  id** (`shell.qml:1069`). Called for Omniplug, it would turn every stack into
  a copy of the icon. Once a stack exists, Omniplug's own settings switches
  write through the in-process writer instead, to the icon entry only.
- **`omarchy plugin disable` removes the first entry it finds**
  (`PluginRegistry.setEnabled`). For a stacked widget that is its carrier, so
  the widget shows as off, as it did in M1.
- **A widget inside a bar entry is in the bar window.** Unlike the Drawer, a
  stack needs no window of its own: tooltips, click targets and popup
  placement all work as they do for any bar widget.

## Storage

```jsonc
"bar": { "layout": { "right": [
  "omarchy.tray",
  { "id": "io.github.h3sam.omniplug" },                  // the icon
  { "id": "io.github.h3sam.omniplug", "stack": "s1" }    // a stack
] } },
"plugins": [
  { "id": "io.github.h3sam.omniplug",                    // the stack store
    "stacks": { "s1": { "width": 160, "dots": true,
                        "cards": [["omarchy.battery", "acme.vpn"], ["acme.media"]] } } },
  { "id": "acme.vpn", "color": "red" },                  // carriers
  { "id": "acme.media" }
]
```

- **Stack ids** are `s1`, `s2`, …: the lowest unused number, at most 32 stacks.
- **A definition without a bar entry** is an *orphan*, for example after the
  entry was removed by hand. The Drawer lists orphans under "Not on the bar",
  and the only thing it offers for them is delete.
- **A bar entry without a definition** is an empty stack.
- **Limits:** 32 stacks, 16 cards per stack, 32 widgets per card, 64 stacked
  widgets in all. The width is between 24 and 1200 logical pixels; the default
  is 160.
- **Carriers** follow M1's rules: moving bar → card merges the layout entry's
  settings into a carrier, and card → bar moves them back and drops the
  carrier, unless the plugin has kinds other than `bar-widget`.
- **Off** is the id in `disabledPlugins`, as in M1.

## Placement changes

`Placement.js` keeps its shape: a frozen `board`, and `placementPlan` turning
one intent into at most one `shell.json` write, checked against the board key.

```
Board  { key, zones: { left, center, right: [Slot] }, stacks: [Stack], orphans: [Stack],
         byId, duplicates, conflicts, canStow, reason, selfPlaced, legacyDrawer: [id] }
Stack  { sid, zone, index, width, dots, cards: [[Slot]] }   // zone/index of its bar entry
Slot   { id, zone, index, name, settings, state, custom, stack?, card? }

Intent { id, to: "left"|"center"|"right"|"stack"|"off"|"on"|"remove",
         stack?, card?, gap?, from?, key? }
       | { op: "newStack", section? } | { op: "deleteStack", stack }
       | { op: "stackSettings", stack, width?, dots? } | { op: "migrateDrawer" }
```

- `to: "stack"` takes `stack` and `card`. A `card` equal to the number of cards
  means "a new card at the end". `gap` is the insertion slot in that card, as
  displayed and before the source is removed.
- `from` is `{zone, index}` for a bar entry, or `{zone: "stack", stack, card,
  index}` for a stacked widget.
- `on`/`off` apply only to stacked widgets; bar widgets keep the host's
  `omarchy plugin enable`/`disable`.
- `remove` forgets a stacked id and drops its carrier: this is how a
  placeholder goes.
- `migrateDrawer` turns M1's `drawer: [...]` on the icon entry into a stack
  (decision 8). The Placement owner sends it once, as soon as it can write.
  When every widget in the list is already placed, it only clears the list
  and makes no stack.
- **Widgets placed nowhere.** `board.unplaced` lists the bar widgets that are
  neither on the bar nor in a stack, each marked `carried` when it still has a
  `plugins[]` entry. `omarchy plugin enable` finds that entry, takes the
  widget for placed, and changes nothing, so a by-id intent to a bar section
  (or to a stack) places it instead, moving the entry's settings onto the
  bar. The manager's placement question sends such a widget to Placement, and
  the Drawer lists them under "Not on the bar" for dragging.
- `to: "none"` is the way back: it takes a widget off the bar or out of its
  card. Its settings, and an entry that keeps its other kinds enabled, wait
  in `plugins[]`. It refuses Omniplug and its stacks, custom modules and the
  last built-in on the bar.
- **Refusals** keep M1's reasons. `self` now also covers putting Omniplug (or
  a stack) into a stack. New reasons: `noStack` (the stack named does not
  exist), `full` (a limit above).
- **Every write uses the in-process writer** (channel 2 in M1). The own-entry
  channel is kept only for the icon's own settings while Omniplug has a single
  bar entry. Bar-only moves keep the `omarchy-bar move` fallback.
- **Rebuilds.** Moves between the bar and a card, `newStack`, `deleteStack`
  and `migrateDrawer` change `bar.layout`, so they rebuild the bar, and the
  Drawer with it. The Drawer reopens itself on the same screen afterwards,
  the way Arrange does after a move. Moves between cards and settings changes
  do not rebuild anything.

## The stack on the bar

`BarWidget.qml` checks its own `settings.stack`. Without it, it is the icon,
as before. With it, it loads `StackWidget.qml` and nothing else: no panel, no
IPC handler, no PopupBridge registration.

- **One `HostStage` per stack** hosts every widget in every card. It runs with
  `holdsPopout: false`, because a stack, unlike the Drawer, is never a popout
  owner, so the stage neither reclaims nor dismisses popouts. Widgets on cards
  that are not showing stay parked and running (M1's lifetime rule), so
  flipping never restarts a widget.
- **The showing card** mounts its widgets in a row (a column on a vertical
  bar). The stack's extent along the bar is its fixed width. It is the card's
  natural width only while it fans out, with a short animation. At rest a
  wider card is clipped.
- **Fan out** starts when the pointer enters a card wider than the stack, and
  ends 300 ms after the pointer leaves, unless one of the card's widgets owns
  the bar's popout.
- **The wheel** flips one card per notch (or per 120 units of pixel delta),
  wrapping around. The new card slides in a few pixels from the side it came
  from and fades up (160 ms); nothing animates between flips.
- **The flip strip** sits at the trailing end (the bottom on a vertical bar)
  whenever there is more than one card. No widget is ever placed there, at
  rest or fanned out (a fanned card grows to its width plus the strip), so it
  is always somewhere to scroll. It shows one circle per card, stacked across
  the bar's thickness and shrunk to fit, the showing card's brightest. It is
  very dim until hovered. With the indicator off, it keeps its room and shows
  a single line. The fixed width includes it.
- **Settings for stacked widgets** come from their carriers, injected exactly
  as in M1.

## The Drawer as the configuration place

The Drawer window keeps its position logic, mask and focus grab. Its content
becomes:

- a header: Omniplug, **+ New stack**, **Manage**;
- the bar strip: chips for every widget on the bar, in three groups (Left,
  Center, Right). Omniplug's own entries and custom entries are shown but
  cannot be dragged;
- one block per stack, in bar order: a title ("Stack 1 · right"), the width
  stepper, the indicator switch and **Delete**, then each card as a row of
  chips, then a **+ New card** drop target;
- the widgets placed nowhere, under "Not on the bar", to drag onto the bar or
  into a card; dropping a widget there takes it off the bar or out of its
  card;
- orphaned stacks, with **Delete** only;
- a status line for the last ticket's note.

Chips are plain labels, not live widgets. Off chips are dimmed. Missing chips
carry a `⚠` and a `✕` that removes them. A drag is a press, a move past the
start distance, and a release over a drop target; `Esc` or a release anywhere
else cancels it. Every drop becomes one `placement.request(...)` through
PopupBridge.

## Arrange and the manager

- **Arrange** loses its Drawer column. A stack entry is labelled "Stack N" and
  moves around the bar like any other entry.
- **Manager rows** come from `Model.withStowed`, which now reads stacked
  widgets from the board's stacks: a stacked row reads as on unless it was
  switched off, and its switch sends `off`/`on`. The place dialog loses its
  **Drawer** choice.

## Known gaps

- **Dragging a stack on the bar itself.** The bar's own drag-to-reorder moves
  an entry by name (`Bar.dropBarModule` → `moveModuleInConfig`), and every
  stack and the icon share Omniplug's id. Dragging one of them on the bar can
  move the first Omniplug entry in that section instead. Arrange moves entries
  by position, so it is the way to move stacks.
- **Summons.** The shell routes `omarchy-shell shell toggle <omniplug>` to
  one Omniplug entry; when that is a stack, nothing opens. The expanded
  panel's hotkey is unaffected.
- **The Drawer's strip only takes widgets back from stacks.** Reordering the
  bar stays Arrange's job.

## Build order

Each step is one commit.

1. This document.
2. Placement: the stack zone, the stack store, the new intents, migration, and
   tests.
3. HostStage's `holdsPopout`, `StackWidget.qml`, and `BarWidget.qml`'s split.
4. The Drawer as the configuration place, and reopening after a rebuild.
5. Arrange, the manager rows, self settings through the writer, and the
   automatic migration.

## Tests

- **Node:** `test/placement.test.mjs` covers the board with stacks and orphans,
  every new intent, the carrier and empty-card rules, limits, refusals and
  migration.
- **QML (offscreen PySide6):** a stack against `FakeBarPort` (flipping,
  wrapping, parking, fan-out width), and the Drawer's drag routing.
- **Manual, on Omarchy:** a stack on top, bottom and left bars; two monitors;
  first- and third-party widgets in cards; a stacked widget's popup; fan-out
  pushing neighbours; deleting a stack; migration of an M1 drawer.
