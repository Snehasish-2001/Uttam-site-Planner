# CLAUDE.md (uttam-6)

Guidance for Claude Code when working inside `uttam-6/`. See the repo-root `CLAUDE.md` for how
this folder fits among the other iterations, and `uttam-5/CLAUDE.md` for the computation this
one inherits wholesale. **This is a UX/architecture rebuild of `uttam-5`, not a features
rebuild** - the geometry engine is the same code, doing the same things; what changed is how the
user navigates and how the two halves of `uttam-5`'s wizard relate to each other.

> **Reading this in the `Uttam-site-Planner` repo?** That repo is a mirror of this one folder, so
> its root *is* `uttam-6/` - a path written here as `uttam-6/site_geometry.py` is just
> `site_geometry.py` there, and `python app.py` runs from the repo root rather than from a
> `uttam-6/` subfolder. The sibling folders this file refers to for history (`uttam-5/`, the
> repo-root `CLAUDE.md`, the earlier iterations) are **not** in that repo; they live only in the
> local multi-folder workspace, so treat those references as background, not as files to open.

## What this is

`uttam-5` was one linear wizard: a single page whose Site Plan step flowed into a Master Plan
step, sharing one plot boundary, one set of module-level globals, and one print sheet.

`uttam-6` splits that into **two fully independent tools** reached from a home screen:

| Tool | Steps |
|---|---|
| **Site Plan** | Metes & Bounds -> North Setter -> Print Sheet |
| **Master Plan** | Metes & Bounds -> Road Logic -> Plot Logic -> Plot Editor -> North Setter -> Print Sheet |

Each has its own plot-boundary entry, its own finalize/gating state, and its own print sheet.
They share UI *code* and share no data at all (see "The independence rule" below).

The home screen also shows **Floor Plan** and **More** as visibly disabled cards. Neither has
any flow behind it. The Building Footprint step that was `uttam-5`'s page 3 is **gone from this
folder entirely** - it belongs to the future Floor Plan tool, and its ~570 lines were dropped
rather than carried along dead.

## Running it

```
cd uttam-6
python app.py
```

Starts uvicorn on `127.0.0.1:8007` with `reload=True` (8005 is `uttam-5`, 8006 is
`uttam-site-planner`). No test suite, linter, or type-checker, same as every other folder.

**Not synced anywhere.** `uttam-5` has the `uttam-site-planner` deployment sibling; `uttam-6`
has none and must not be pushed to git or copied anywhere unless explicitly asked - same
standing rule as every other iteration.

## The independence rule

> Site Plan and Master Plan may share UI components and rendering code. They must never share
> data, state, or gating logic.

This is the single constraint that shapes `frontend/app.js`, so it is worth being precise about
how it is enforced rather than merely intended:

- The entire wizard body lives inside **`createTool(toolKey, host)`**. Every `currentVertices`,
  `roads`, `subsections`, `plotEditSession`, `lastBuildable`, `currentUnit`, print-sheet field
  and finalize flag is a closure local of one call to that function. Two tools = two closures.
  Independence is structural, not a discipline any individual function has to observe.
- The only module-scope mutable value in the file is `activeTool`, which holds *which* instance
  is mounted - never any of its data.
- **No shared store, event bus, URL parameter, or `localStorage`/`sessionStorage` key exists**,
  deliberately. If a future change makes one of these convenient, that is the thing this design
  exists to prevent; verified by inspection that both storages stay empty through a full run of
  both tools.
- Going Home empties `#toolHost`, which destroys the instance and its state with it. Every
  home-screen click therefore starts a genuinely fresh tool - documents are not persisted or
  listed yet (out of scope for this task).

**Every instance clones every step's markup, not just its own tool's.** `def.steps` alone
decides which steps get a tab and are reachable; the rest stay parked, hidden, and never
populate. This is on purpose: it lets the wizard body stay byte-identical to `uttam-5`'s, which
wires up every control unconditionally at construction time and would throw on a missing
element. Site Plan therefore carries an inert copy of the Road Logic/Plot Logic/Plot Editor
markup - it has no tab for them, its `subsections` stays `[]`, and its print sheet correctly
falls back to the bare plot boundary. Don't "clean this up" by only cloning `def.steps`'s own
nodes without also guarding ~40 listener registrations.

## Backend

**Mostly unchanged from `uttam-5`** - `app.py`, `layout_geometry.py`, `json_to_dxf.py`,
`pdf_render.py`, `dxf_render.py`, `layout_semantics.py` are byte-identical copies apart from
`app.py`'s port and docstring path. `site_geometry.py` has since diverged with one real fix (see
"Whole-sub-section fill plot" below) - if a `uttam-5`/`uttam-site-planner` fix ever needs
porting here, or vice versa, check this file's own history first rather than assuming a blind
copy is safe. The endpoint table in `uttam-5/CLAUDE.md` still applies verbatim:

| Endpoint | Purpose |
|---|---|
| `POST /compute-site` | metes-and-bounds plot + per-edge setbacks -> resolved plot polygon + inset buildable polygon |
| `POST /compute-footprint` | still present and still works; **nothing in uttam-6's frontend calls it** (Building Footprint moved out of scope) |
| `POST /compute-subsections` | plot vertices + finalized roads -> the polygons left once each road's strip is carved out |
| `POST /insert-plots` | one sub-section + road-facing edges + sizing params -> real plots, fill plots, `openSpace`, `invariantErrors` |
| `POST /resize-plot` | one plot grown/shrunk by an edge push, fill/open space regenerated around it |
| `POST /regenerate-fill` | rebuilt fill + open space after a manual edge/diagonal edit |
| `POST /generate-pdf`, `/generate-plan`, `/generate-pdf-from-dxf` | layout.json -> PDF/DXF; not wired to any uttam-6 page |

`site_geometry.py` carries the option-(a) residual/edge-push plot-editor rework (`/resize-plot`,
`partition_residual`, `normalize_polygon`) - it was already done in `uttam-5` when this folder
was created, so it came across with everything else.

**The frontage-touch rounding bug - read this before touching plot placement.** Symptom: a
sub-section with perfectly good, long, straight road frontage places *zero* road-facing plots and
reports `"along a 126 ft stretch of frontage, the usable land here pulls away from the road
instead of bordering it"`, dumping the whole sub-section into the fill/open-space stage. It
looked like a shape limitation for a long time (and was repeatedly explained away as one - it is
not). Root cause: **two coordinate spaces that disagree by a rounding step.**

- `insert_plots()` snaps the sub-section through `normalize_polygon()` onto the `SNAP_GRID_FT`
  (0.01 ft) lattice, deliberately, so plots clipped from it share one grid.
- The `roadFacingEdges` paths are the client's own **un-snapped** boundary coordinates, passed
  through untouched.
- `try_place()`'s frontage-touch check then measured `candidate.intersection(frontage_chord)`
  with **zero tolerance**. Snapping moves the boundary up to ~0.007 ft perpendicular, in whichever
  direction the rounding happens to fall. When it falls *inward*, the frontage line ends up
  lying entirely **outside** the snapped polygon, so `touch_length` is `0.000` for every slot, at
  every depth, in every plan - and the whole run is rejected.

Measured on a real failing case: frontage run endpoints matched sub-section vertices *exactly*
(distance 0.000000), the chord lay exactly on the raw polygon (91.492 of 91.492 ft inside), and
**0.000 of 91.492 ft inside the snapped polygon** - a 0.0022 ft (0.027 inch) offset silently
erasing an entire sub-section's plots. Because the rounding direction is effectively a coin flip
per edge, this also explains why the failure looked random: neighbouring sub-sections of the same
drawing would work perfectly while others came back empty for no visible reason.

Fixed in two places: the frontage paths are now snapped onto the same grid as they are read (in
`insert_plots()`'s `edges` loop), and the touch test measures against a grid-dilated candidate
(`candidate.buffer(SNAP_GRID_FT)`) via the now-named `FRONTAGE_TOUCH_FRACTION`. The dilation is
0.01 ft against a defect the check genuinely exists to catch (fragments floating *feet* inward,
disconnected from the road), so it is 2-3 orders of magnitude too small to weaken that check.

Impact was large and everywhere, not just on the pathological case - re-running every saved
repro: a sub-section that placed **0 real plots now places 3** (45x55 ft each, 97% of its land,
zero overlap, no invariant errors); others went 1->9, 2->32, 5->30, 7->23 real plots with open
space dropping (e.g. 16,328 -> 11,231 sqft, 1,466 -> 586 sqft). Even `v3_master.py`'s plain
200 ft square baseline improved from `[3, 3, 3, 2]` plots per sub-section to `[4, 4, 4, 2]` -
that test had been silently encoding one lost plot per sub-section as if it were correct. **If a
placement change moves those baseline numbers again, check which direction it moved before
assuming a regression.**

Where zero plots still legitimately happen, the reported reason is now a real one that names a
real measurement (e.g. "the usable land here only reaches 17.4 ft deep, short of the 45 ft
minimum length"), not the bogus "pulls away from the road".

**Whole-sub-section fill plot.** When `insert_plots()` places *zero* real (road-facing) plots
along a frontage - e.g. `generationNotes: "the usable land here pulls away from the road instead
of bordering it"` - `partition_residual()` had nothing to cut the leftover land with:
`_cut_lines_for()` only extends lines from real plots' own edges, so with none to extend from,
`_split_piece()` returned the entire residual as ONE unsplit piece, which then sailed through
`_fill_quality()`'s ordinary checks (area/angle/width/aspect - none of which cap *maximum* size)
and became a single "fill plot" spanning the sub-section's own entire remaining area (observed:
one 9-sided, ~28,000 sq ft fill plot). Technically "accounted for" (used + open == sub-section
area) but reading on screen as one vast, undivided, barely-visible (10% opacity) blob - easy to
mistake for untouched, undetected land, which is exactly the complaint that surfaced it.

Fixed by giving `_fill_quality()` a `max_area` ceiling (via `_fill_thresholds()`): derived from
the sub-section's own target plot footprint - `maxLength x maxWidth x 3` (the same numbers
`insert_plots()` already sized real plots against, scaled generously since fill legitimately
runs bigger and odder-shaped than real plots) - falling back to `min_area x 20` only when a
caller genuinely supplies no target size. A piece over that ceiling now fails quality even with
nothing to cut it, which routes it into the SAME Delaunay-triangulation salvage path already
used for genuine corner wedges (`partition_residual`'s "fall back to Delaunay for the failures
only" branch) - each resulting triangle is checked independently, becoming a real, reasonably-
sized fill plot if it passes, or honest hatched open space if it doesn't. Verified against the
case that surfaced this: the one 27,976 sq ft blob became 3 real fill plots (2127/4139/1652 sq
ft) plus 3 open-space pieces (totalling ~20,059 sq ft) - the SAME land, but now visibly and
honestly subdivided instead of one undifferentiated mass. The underlying reason zero real plots
could be placed there at all was, in the majority of observed cases, **not** a shape limitation
at all - it was the frontage-touch rounding bug documented above, fixed later. This fix only ever
stopped the *leftover* from being misrepresented; it did not (and could not) put the missing
plots back. Treat "zero real plots here" as a bug to investigate first and a shape limitation
only once the reported reason names a real measurement.

**Plot Editor "grow" crashing/blocked on a dense sub-section.** Reported as "I can not expand
the areas" against a sub-section with many small real plots plus a lot of derived fill (`S1F1`,
`S1F2`, ... `S1F20`-style). Reproduced by scripting the exact insert/grow flow against the
seeded 12-gon (not the user's live tab - see the CDP harness note above) and intercepting the
real `/resize-plot` request/response via a monkey-patched `window.fetch`. Two separate bugs, both
inside `partition_residual()`'s post-push fill regeneration in `site_geometry.py`, not in the
edge-push math itself (`resize_plot()`'s own boundary/neighbour/min-dimension checks were already
correct):
1. `_merge_narrow_fill_pieces()` calls `unary_union([fill[i], fill[j]])` on two fill pieces that
   *look* adjacent (a small dilation-based "do they share a border" probe passes) but, once both
   are snapped to `SNAP_GRID_FT`, only touch at an isolated point - the union comes back as a
   `MultiPolygon`, and `normalize_polygon()` unconditionally did `for v in poly:` assuming a
   Polygon-or-vertex-list, which threw `TypeError: 'MultiPolygon' object is not iterable` and
   surfaced to the user as a bare "Resize failed: ...". Fixed in two layers: `normalize_polygon()`
   now routes any non-Polygon `shapely` geometry through the existing `_largest_polygon()` helper
   first (a general safety net - correct for every other caller that already hands it Polygon/
   MultiPolygon results), and `_merge_narrow_fill_pieces()` itself now checks
   `union.geom_type != "Polygon"` and skips that merge candidate entirely rather than silently
   keeping only the larger disjoint part (which would make the smaller piece's land vanish from
   every area total - confirmed this was happening: after only the first-layer fix, two other
   plots that used to crash instead started failing `check_invariants()`'s "sqft unaccounted for"
   check, ~155 sqft each, i.e. real land was being dropped, not just double-drawn).
2. `_absorb_failed_pieces()` welds a too-small leftover piece onto its best-matching neighbouring
   fill plot via `unary_union([fill[best_idx], piece.buffer(SNAP_GRID_FT / 2)])`, then clips the
   result back to the overall residual (`clip_region`) - but never against every *other* already-
   placed fill piece, so the half-grid-step buffer used to weld two pieces' mismatched shared edge
   could bite a sliver out of a third fill piece sitting on the far side of the one being welded.
   Individually each such nick was a few hundredths to (at most) ~0.7 sqft - far below
   `check_invariants()`'s pairwise overlap test tolerance (which eroded each polygon by
   `SNAP_GRID_FT` before comparing, specifically to ignore grid-snap noise this size) - but summed
   across ~19 such pairs in one sub-section to just over the separate `AREA_BALANCE_TOL_SQFT` (0.5
   sqft) *land-balance* check, which sums total area across every piece rather than comparing
   pairs. That's what actually produced "plots and open space cover 28353.21 sqft, more than the
   sub-section's own 28352.17 sqft" - a real (if tiny) double-count, not an over-strict tolerance;
   resist the urge to fix this class of failure by just loosening `AREA_BALANCE_TOL_SQFT`. Fixed
   by also subtracting the union of every *other* fill piece from the weld before accepting it.

Verified against the exact reproduction: all four real plots in the dense sub-section (`S1P1`-
`S1P4`) that previously either crashed or reported "can't grow" now grow cleanly (confirmed
successful `/resize-plot` responses with sane new areas), and both `v3_master.py` and
`v6_editor_regression.py` still pass with no JS errors and no change to their existing
non-pathological assertions (`plots per sub-section: [3, 3, 3, 2]` unchanged).

Confirmed the same fix also covers `insert_plots()` (initial generation, not just `/resize-plot`)
since both share `partition_residual()` - stress-tested two more fragmentation-heavy layouts
against the patched server and got zero `invariantErrors` in either. If "Geometry check: ...sqft
unaccounted for/more than the sub-section's own..." ever shows up again after this fix, it is
either a genuinely new cause (re-run the same MultiPolygon/weld-nick investigation, don't assume
it's the same bug back) or a stale result from before the fix - re-clicking "Insert plots" reruns
server-side and needs no page reload.

**Area-only capacity estimate (Plot Logic).** Per the user's own suggestion: alongside the real,
shape-aware result, `renderSubsectionDetails()` in `app.js` now also shows a naive
`floor(subsectionArea / (targetLength x targetWidth))` estimate - ignoring the +/- range, gaps,
and (most importantly) whether the land actually touches a road at all. It is deliberately a
ceiling, not a target: a big gap between it and the real count means something other than the
plot-size inputs is limiting that sub-section. It was this estimate making that gap visible on
several sub-sections at once that prompted the investigation which found the frontage-touch
rounding bug above - so treat a large gap as a lead worth chasing, not as proof of a shape
limitation. `targetLength`/`targetWidth` are carried on `sub.params` purely for this display -
`subsectionParams()` (the function that actually builds the `/insert-plots` request body) still
whitelists only the fields the server has ever wanted, so they never reach the request.

**Master Plan's Metes & Bounds is a two-column grid, and drops Role/Setback.** Continuing the
same shortening: Role and Setback join the Neighbour and Road columns in being Site-Plan-only (a
master-planned boundary is subdivided by the road network and per-plot editing that follow, not
by a per-edge role and its own setback). That leaves each row holding just a label and one or two
controls, so all three Metes & Bounds lists - **Sides**, **Diagonals**, **Corner placement** - are
laid out two-per-row instead of single-file: a 12-sided plot goes from 12 rows to 6, its 9
diagonals from 9 to 5. Column headers are hidden with them, since every row is self-labelling and
a header row cannot line up with a grid that reflows; the unit moved into the new "Sides" hint,
which `updateUnitLabels()` keeps current.

Two things to know if you touch this:
- **It is pure CSS, keyed on a `.mb-grid` class**, not on the step. `.step-def[data-step="mb"]`
  does NOT work as a selector: the shell *moves* each step's slots into the split layout, and the
  wrapper carrying `data-step` is left behind (the table's real ancestor chain is
  `div.step-form > div > section.pane-right`). The marker class also keeps the Plot Editor's own
  edge/diagonal/corner tables - same `.edge-table` markup - out of it.
- `diagonalsTableEl`/`cornerPlacementTableEl` now set `style.display = ""` rather than `"table"`
  when shown. An inline `display: table` would beat the stylesheet and silently defeat the grid.
  The Plot Editor's two tables still set `"table"` inline, deliberately.

Site Plan keeps the plain table with all seven columns - verified after the change.

Corner placement states each row as one phrase in one cell, one font - `L with respect to AB`
rather than a bold corner letter beside a separate muted "using A, B", which read as two
unrelated columns. Applied to the Plot Editor's equivalent list too (`C' with respect to A'B'`)
so the two don't diverge; both tables' headers lost their now-merged "Reference" column.

**Click-to-select in the Plot Editor was dead, killed by pointer capture.** The handler had been
there all along (click the SVG -> screen px -> SVG units -> plot feet -> `pointInPolygon` against
each plot -> `loadPlotForEditing`), and the hint text advertised it, but clicking a plot did
nothing whatsoever: no selection, no message. Root cause was in the zoom/pan wrapper, not the
editor - `pointerdown` called `setPointerCapture()` on **every press**. While an element holds
pointer capture the browser retargets the whole gesture to it, *including the `click` it
synthesises at the end*, so every click was delivered to the zoom viewport and the SVG's own
listener never fired. Confirmed by probe: a capture-phase listener on the SVG saw zero real
clicks, while a synthetic click dispatched straight at a polygon selected the plot correctly.

Fixed by taking pointer capture only once the gesture has actually become a pan (first move past
`DRAG_THRESHOLD_PX`), re-anchoring the pan origin at that moment so the drawing doesn't jump.
Two things fell out of the same area:
- The drag threshold compared each move against the **previous** move's position, so a slow drag
  could travel any distance without ever registering as a pan while a fast flick registered
  instantly. It now measures from where the press started.
- `.zoom-canvas` gets `user-select: none`. The drawing is full of `<text>` labels, so dragging
  used to start a text selection - the labels highlighted and the gesture was partly consumed by
  the selection. This is the other half of what the user reported ("it only selects the text
  inside the block and helps moving the whole sheet").

**If click-to-select ever goes quiet again, suspect an element grabbing the pointer or swallowing
the click before the SVG sees it - not the hit-testing.** The quickest check is a capture-phase
listener on the editor SVG: if it records nothing on a real click, the problem is upstream.

Real plots now also carry a `.plot-hit` class so the affordance is pure CSS - `cursor: pointer`
plus a stronger fill on `:hover`. Deliberately not applied to fill plots or open space, which
would promise an edit the editor then refuses. No JS hover hit-testing: the SVG is regenerated
wholesale on each redraw, so there is no listener or state to keep in sync.

**Inner road labels are written along the road, inside its band** (`drawRoadLogicPreview`), like a
street name on a map, rather than as horizontal text above one end of it - where it collided with
the boundary's own corner labels. Three things worth keeping if this is touched:
- Position, angle and size are all computed in **screen space**. The transform scales and can
  flip, so a real-world angle would be drawn wrong.
- The anchor is the point at **half the road's arc length**, found by walking the transformed
  polyline, and the angle is that of the segment it lands on (so a curved road's label follows
  the arc there). The old code used `path[Math.floor(path.length / 2)]`, which on a straight
  road's 2-point path is its **end** - that is why the label used to sit at the top of the band.
  The angle is then clamped to +/-90 so a right-to-left road doesn't read upside down.
- Font size is driven by the road's own length, as asked - a short road's label shrinks rather
  than running out past its own ends - but is ALSO capped by the band's thickness
  (`r.width * scale * 0.62`), or a long road's text would overflow the road sideways. On a
  typical 12 ft road the width cap is what binds for anything but a short road; that is
  deliberate, not a bug.

The Mirror control is a button labelled just **"Mirror"** - pressing it flips the drawing across
the side chosen in "Mirror across" and pressing it again restores it. It used to read
"Mirror: Off"/"Mirror: On"; the diagram itself is the feedback, with the button's pressed styling
(`.toggle-active`, plus `aria-pressed`) carrying the state.

**Outer roads live on Road Logic (Master Plan only).** Metes & Bounds was getting very long, so
the road concept moved off it: Road Logic now has **"+ Add outer road"** and **"+ Add inner
road"**. An outer road is one running along a boundary side, outside the plot, and needs no name -
the side it abuts identifies it - so its row is just Side (A-B, B-C, ...), Width, Road extension
(each side), Remove. "Add inner road" is the previous "+ Add road", unchanged.

**Site Plan deliberately keeps its road fields on Metes & Bounds**, because it has no Road Logic
step at all (`TOOL_DEFS`: mb -> north -> print) and would otherwise lose the ability to show an
abutting road entirely. So the two tools genuinely differ here, and `readOuterRoads()` exists as
the single source of truth that hides it: it returns `[{edgeIndex, width, extension, frontRoad}]`
from the Road Logic rows for `master` and from the Metes & Bounds role/road-width/road-extension
fields for `site`. Every consumer goes through it - the drawing and PDF sheet (`buildPlotSvg`'s
road bands) and `isEdgeRoadFacing()`, which is what tells sub-section frontage detection where the
roads are - so the tools cannot drift apart. Master's Metes & Bounds hides the two road Role
options, the Road width column (`.col-road-width`) and the Road extension row
(`.row-road-extension`), reusing the same `[data-tool="master"]` CSS pattern that already drops
the Neighbour columns.

`enter_square()` in the CDP harness now detects which mechanism the tool has (does the Role select
offer "road"?) and uses the right one, so both regression suites drive Master Plan through Road
Logic. `plots per sub-section: [4, 4, 4, 2]` is unchanged across the move.

**Expand to boundary (Plot Editor).** `expand_plot_to_boundary()` in `site_geometry.py` +
`POST /expand-plot` + the "Expand to boundary" button beside "Push edge". Sweeps ONE chosen side
of a plot straight outward and absorbs the free land it crosses, stopping at the sub-section
boundary, a road, or the next plot - and the plot's side count changes to match whatever stopped
it.

This is the deliberate escalation from `resize_plot()`'s area stepper. The stepper slides one edge
with the side count FIXED, so it can only ever reach land lying square-on to an existing edge;
free land around a corner or behind an irregular boundary is unreachable by it no matter how many
times it is pushed. A blocked **grow** now says so and points at this button.

Scope, decided with the user: the **corridor the chosen edge sweeps** (its own width, projected
outward) plus any pocket the expansion would otherwise seal in (`_sealed_pockets()` -
`SEALED_POCKET_FRACTION` of the pocket's perimeter walled by the expanded plot + the sub-section
boundary). Deliberately NOT every connected scrap touching the edge: keeping the sweep to the
edge's own width is what makes the direction predictable instead of one click swallowing half the
sub-section. Within the corridor it takes everything reachable, so a neighbour blocking part of
the width gives a stepped outline rather than stopping the whole edge short. A side must be chosen
explicitly ("Auto" is refused - the sweep direction would be a guess, and this takes far more land
per click than a 2 ft push). Road-frontage sides are refused outright. Like `combine_plots`,
`check_invariants` is reported, not enforced.

Two things worth knowing:
- **The corridor must be opened before use** (`_open_residual()`, the same helper
  `partition_residual` uses). Grid-snapping leaves hairline strips between a plot and its
  neighbours and the corridor happily picks them up - observed as a 4-sided plot coming back
  5-sided having "absorbed" under a square foot. The area floor is `MIN_OPEN_SPACE_SQFT`, an
  AREA; an earlier version compared the area gain against `MIN_PUSH_FT`, which is a push
  *distance*, and let exactly those slivers through.
- **After expanding, the whole edit session must be rebuilt**, not just the vertex list: the
  anchor (taken from vertices 0 and 1), `frontageEdges`, the chosen push edge (its old index now
  points at a different side of a different polygon), the corner-placement rows and the
  edge/diagonal tables are all sized or derived from the side count.

Verified: repeatedly expanding the largest available side drove one sub-section's free land from
**5,196 sqft to 0.0** in six rounds, which is the point of the feature.

**`polygonsOverlap()` had no tolerance on its segment test - fixed here.** Expanding always
produces a long shared boundary with a neighbour, which exposed a latent bug in the client-side
save check: it combined a *tolerant* point-in-polygon test (0.1 ft) with a **zero-tolerance**
"do any two edges properly cross?" test. Two plots that legitimately share a boundary wobble
across it by a few thousandths of a foot once both are snapped onto the grid, and every one of
those micro-crossings is a genuine proper intersection - so adjacency itself read as overlap.
Measured case: a 62 ft shared edge, 0.0176 sqft of "overlap" at **0.0009 ft** deep (one hundredth
of an inch), eroding to exactly zero, blocking a save the server had already checked and passed.
Now overlap is measured purely as *depth of penetration*, sampled along both boundaries, which
ignores anything shallower than the tolerance while still catching a plot genuinely cutting into
another - and needs no polygon clipping in JS. `properSegmentsIntersect` is still correct for the
self-intersection check, where a crossing is a crossing at any scale. This bug predates the expand
feature and would equally have hit Combine results and any other server-produced adjacency.

**`plotStaysInsideSubsection()` broke on concave sub-sections - also fixed here.** It used to
nudge each plot corner 0.05 ft **towards the sub-section's centroid** and require the nudged point
to be inside. That only holds for a CONVEX sub-section: once roads cut a block into concave
pieces, the direction from a corner sitting in a notch to the overall centroid can leave the
polygon immediately, so a perfectly legal corner tested as "outside" and the save was refused with
"S1P2's own shape is invalid (...pokes outside its sub-section/into a road)". Expanding puts many
corners exactly ON that boundary, which is what made it fire constantly (it blocked an 894 sqft
expansion outright). Now it asks whether each corner is inside OR within tolerance of the
boundary - direction-free, and identical on concave and convex shapes.

**Two more tolerance fixes made while verifying expand, both root causes rather than symptoms:**
- `check_invariants()`'s land-balance allowance is now `max(AREA_BALANCE_TOL_SQFT, area *
  AREA_BALANCE_TOL_FRACTION)`. A flat 0.5 sqft is ~0.003% of a 15,000 sqft sub-section, and every
  polygon in it is snapped onto `SNAP_GRID_FT` with each shared edge contributing rounding - so a
  block carved into 15 plots trips it where one carved into 3 does not. That is the "plots and
  open space cover 19615.30 sqft, more than 19614.69" drift the user reported, which then blocked
  every later edit in that sub-section for a defect no edit had caused. At 0.02% the
  genuinely-lost-block case the check exists for (227 sqft) is still caught with ~75x margin.
- `_absorb_failed_pieces()` had an `or welded` fallback that returned the **unclipped** weld when
  clipping to the residual produced nothing. The weld is dilated half a grid step BEYOND the free
  land, so that fallback put fill on top of the neighbouring real plot. It now simply declines the
  weld and leaves the piece as open space.

Verified after all of the above: 168 expansions across every saved layout produce valid simple
polygons with a single sub-0.05 sqft invariant note, and in the browser three consecutive
expand+save cycles took one sub-section's free land from 5,084 -> 3,578 sqft with no failures.

**Combine plots (Plot Editor).** `combine_plots()` in `site_geometry.py` + `POST /combine-plots`
+ the "Combine plots" row in the Plot Editor. Merges two or more of ONE sub-section's plots into
a single real plot. Deliberately permissive about shape - the result is whatever the union is,
concave/L-shaped included, and NO fill-quality gate is applied, because this is the user's
explicit instruction about their own land rather than land the generator is proposing. Real and
fill plots mix freely and the result is always REAL: since fill is only a derived view of the
residual, merging a fill piece into a plot is precisely how a plot absorbs the leftover land
beside it - which the area stepper structurally cannot do when that land isn't reachable by
pushing one existing edge in a straight line.

Only structural rules are enforced: one connected polygon, inside the sub-section, and no overlap
with a plot that wasn't part of the merge. Non-adjacent plots are refused (a union of disjoint
pieces is not a plot), as are cross-sub-section pairs (caught client-side so the message can name
both sub-sections).

`check_invariants()` is deliberately **reported, not enforced** here - the one place in the module
that treats it as information rather than a gate (`_resize_result()` still blocks on it). A
combine is the user stating what their own land is, out of plots that already existed, so there
is no version of "refuse it" that leaves them better off. Concretely, it was blocking merges over
a land-balance drift of well under a square foot that the sub-section **already carried before
the combine** (reported case: generated 0.61 sqft over its own area, so every merge in it was
refused for a defect the merge neither caused nor could fix). The numbers still come back and the
UI appends them as a "Geometry note:", the same way `insert_plots`/`regenerate_fill` already
surface theirs. If a combine ever needs to be blocked again, gate on whether it makes an existing
problem *worse*, not on whether a problem exists at all.

The UI takes **two separate name boxes** ("Combine plot ___ with plot ___"), not one shared
field - the backend still accepts N names, so chains keep working, but two boxes is what the
editor exposes. The merged plot takes the earliest array
position of the plots it replaces, so `nameSubsectionPlots()`'s chronological P-numbering stays
stable rather than the combined plot jumping to the end of the list; any in-progress edit in that
sub-section is dropped, because the array was just re-indexed and renamed under it.

**Three tolerance traps caught while building this - the same class as the frontage bug above,
and worth re-reading before adding any geometry check:**
1. Plots that legitimately share an edge overlap by a hairline once both are snapped onto
   `SNAP_GRID_FT` independently. The overlap pre-check must erode both by the grid step first,
   exactly as `check_invariants()` does - compared raw, that artefact reads as a real collision
   and refused essentially *every* merge whose result touched a neighbour (0 of 24 valid merges
   passed).
2. Plots that visually share an edge can still sit a rounding step *apart*, so `unary_union`
   returns a MultiPolygon. Closed morphologically (dilate/union/erode by `SNAP_GRID_FT`) and then
   area-checked against the sum of the parts within `COMBINE_WELD_TOL_SQFT` - a weld that moves
   real area is a distortion, not a weld.
3. Going the other way and skipping vertex culling (`cull_vertices=False`) to protect the exact
   union outline does NOT work: `check_invariants()` refuses any real plot carrying
   collinear/spike vertices, so every merge was then rejected as "un-normalized". The working
   combination is `simplify(0)` (drops collinear vertices without moving the boundary at all)
   followed by normal culling.

Verified across a real 17-plot sub-section: all 24 adjacent pairs merge (7 real+fill, 9 real+real,
8 fill+fill) with worst area drift 0.26 sqft and no invariant errors; three-way chain merges work;
and single-name / repeated-name / unknown-name / non-adjacent (97 ft apart) / cross-sub-section
inputs are all still refused with their own specific message.

### Warnings carried forward from `uttam-5` - still true, do not re-lose

- **Closure tolerance.** `vertices_from_edges()` asks for only N-1 interior angles (the Nth is
  derived from exterior-angle closure). *Positional* closure is a separate constraint: an error
  under `CLOSURE_TOLERANCE_FT` (1 ft) is silently corrected by a surveying **compass-rule
  adjustment**; above it the request is rejected rather than drawing a broken polygon.
- **`compute_subsections`'s sliver opening.** Right after subtracting the road strips,
  `remaining` gets a tiny morphological opening
  (`buffer(-0.001).buffer(0.001).simplify(0.01, preserve_topology=True)`). It exists to sever
  razor-thin floating-point bridges between regions that should split into separate
  sub-sections; an entire expected sub-section was silently lost once without it.
- **`normalize_polygon()` is not cosmetic.** Without it, `rect.intersection(remaining)` hands
  back zero-width filaments - one observed plot was a clean 60x30 rectangle plus a 20 ft spike,
  contributing no area but making the polygon self-intersecting the instant any vertex moved,
  which froze that plot against every possible edit.
- **Plot naming and `splice()`.** Real plots keep a permanent `S{sub}P{n}` assigned once; fill
  plots are `S{sub}F{n}` and are **renumbered on every regeneration** because they are ephemeral
  by construction. Always look a plot up by `.name`, never by re-deriving a label from the
  current array index.
- **The plot editor's core rule.** A real plot only ever grows into free residual land and only
  ever gives land back to it. No edit - stepper or manual - may move, reshape or re-save any
  *other* real plot. Fill plots are a derived view of `sub-section - union(real plots)`, rebuilt
  server-side whenever a real plot changes.
- **Winding.** `solveFromDiagonalGraph` works in its own local frame and can return a shape
  mirrored relative to the plot as stored (backend plots are wound CCW).
  `recomputeWorkingVertices` compares `signedArea()` against the original and flips before
  placing it; without that, one plot's far corners landed 66 ft outside its sub-section and
  *every* manual edit failed.

## Frontend

`frontend/index.html` is now a home screen plus two `<template>`s; `frontend/app.js` is the
`createTool()` factory plus a small home-screen router; `frontend/style.css` gained the shell.

### `index.html` - three parts

1. **`#homeScreen`** - the four cards. Disabled cards write a "coming soon" line into
   `#homeNote` and do not navigate.
2. **`#toolShellTemplate`** - the split-screen shell, cloned once per instance: header + step
   tabs, left pane (zoom viewport, legend host, message area, extra-left host, action bar),
   right pane (read-only banner + form host), and the full-screen stage-2 print overlay.
3. **`#toolStepsTemplate`** - one `.step-def` per step, each holding up to five slots:
   `.step-diagram`, `.step-legend`, `.step-extra-left`, `.step-actions`, `.step-form`. On
   navigation the shell **moves** (never re-clones) those nodes into the split layout and parks
   them back on their own `.step-def` when leaving, so every field keeps its value and its
   listeners across tab switches.

**`id=` is gone; everything is `data-el=`.** Two live copies of the same markup cannot share
ids. Inside the factory, `$("name")` is `root.querySelector('[data-el="name"]')`. Radio `name`
attributes are also rewritten per instance at mount (`sketchScaleMode__t1` etc.) - without that,
two instances would share one radio group and unselect each other's buttons.

### `app.js` module breakdown

The wizard body (roughly 3,300 of the ~3,800 lines) is `uttam-5`'s `frontend/app.js` moved
verbatim into the factory, with exactly three mechanical changes:
`document.getElementById("x")` -> `$("x")`, one page-wide `document.querySelectorAll` scoped to
`root`, and the Building Footprint block removed. **When fixing geometry/editor behaviour, check
whether `uttam-5` has the same bug** - the code is the same code.

Inside `createTool()`:

1. **Site plot (Metes & Bounds)** - side/angle entry, live SVG preview, and
   `solveFromDiagonalGraph(lengths, diagonalSpecs)`: places `pts[0]=(0,0)`,
   `pts[1]=(lengths[0],0)`, then walks every other vertex via circle-circle intersection once it
   has two placed neighbours. Reused verbatim by the Plot Editor for reshaping one plot.

   **Corner-flipping self-intersection fix.** A vertex placed from exactly two known distances
   (a side + a diagonal, or two diagonals) is a circle-circle intersection, which always has two
   mirror-image solutions - distance alone can never say which side of that pair the real
   boundary bulges to, that's a fact about the physical site, not something any of these numbers
   encode. The original heuristic (`pickOutward` - whichever solution keeps the running area
   largest *at that step*) has no way to know this and can pick a mirror that makes the
   *boundary itself* self-intersect, even though every side and diagonal is individually exactly
   what was entered - discovered on a real 12-gon where several corners (out of ten genuinely
   ambiguous ones) were mirrored wrong, crossing in four places, while `/compute-site` still
   silently "closed" and only complained of a vague "tight corner" repair.

   `solveFromDiagonalGraph` now checks the greedy result with `polygonSelfIntersects()` and, if
   it crosses itself, searches nearby alternatives: flip a *group* of 1, then 2, then up to
   `MAX_GROUP` (4) of the ambiguous corners together (capped at `MAX_ATTEMPTS` = 20000 total
   tries), and among every simple (non-crossing) result found, keeps the one with the **largest
   total enclosed area** - never just the first hit, and specifically *not* whichever needed the
   fewest corners flipped from the original greedy guess. That first, simpler heuristic
   ("minimum flips from greedy") was tried and measured wrong: verified against the real 12-gon
   above (by digitizing the surveyor's own rough sketch and Procrustes-fitting all 78 valid
   simple resolutions of the same lengths/diagonals against it), the minimum-flips result ranked
   **69th of 78** by similarity to the real site, while picking the max-area result independently
   landed on the **1st**-ranked (correct) shape - needing 4 corners flipped, not 2. This isn't
   coincidence: a real plot boundary is never folded back over itself, so of every way to resolve
   the same lengths and diagonals into a simple polygon, the true one is never smaller than a
   self-intersecting "solution" would naively compute (crossing folds area back over itself) or
   than another valid-but-wrong mirror elsewhere on the shape - maximum area is the closest thing
   to "most like the real site" available without ever having seen the site. (If this class of
   bug resurfaces on a different polygon, re-verify with the same method - digitize the source
   sketch, brute-force every mirror combination, Procrustes-fit each against it - rather than
   trusting a new heuristic's plausibility alone; "fewest flips" looked reasonable too.)

   This still runs on every keystroke, so the search is bounded rather than exhaustive over
   2^(free corners) - confirmed at ~13ms for the 12-gon (10 free corners, needing group size 4),
   comfortably fast for live typing. When a fix is found the result carries
   `autoFixedCrossing: true` and `autoFixedLabels` (which corners were actually guessed, never
   one the user pinned - see below); `resolveAndRedraw()` (and the Plot Editor's
   `recomputeWorkingVertices()`) surface that as an amber warning naming exactly those corners
   rather than silently accepting it, since even the max-area result is a heuristic, not a
   guarantee - the user still has to confirm it against the real site (as happened here). If no
   group up to size 4 gives any simple result, the function returns `ok: false` with an explicit
   self-intersection error instead of whatever the greedy heuristic produced - never a
   silently-crossing polygon.

   **Corner placement: making it deterministic instead of guessed.** The area heuristic above is
   still only a heuristic - a plot with a genuine deep concave notch can have *less* area than a
   wrong mirror choice that "fills in" the notch, and the bounded search can exhaust its budget
   without finding the true best on a large enough polygon. Neither failure mode can be fixed by
   a smarter heuristic, only by giving the solver information it doesn't have: which side of two
   reference corners each ambiguous corner is actually on. `solveFromDiagonalGraph`'s third
   parameter, `cornerChoices` (`{ [cornerLabel]: "left" | "right" }`), does exactly that - set
   for a given corner, it's honored on the very first placement (not just as a search tiebreaker)
   and that corner is never a candidate for the crossing-search to flip. "Left"/"right" is
   resolved via `sideOfLine()` (a cross product against the directed line from the corner's
   first reference to its second) rather than any compass sense - the convention only has to be
   internally consistent, which is all a dropdown needs.

   The choice is deliberately **per corner, not per diagonal row**: a corner can be pinned by two
   diagonals, a diagonal and a side, or two sides entirely (e.g. corner G in the 12-gon above, no
   diagonal touches it at all) - diagonal rows and ambiguous corners are not in 1:1
   correspondence, so a toggle on the diagonals table couldn't represent every case. The
   **Corner placement** section (below Diagonals, in both the main Metes & Bounds step and the
   Plot Editor's own fields) lists whichever corners are *currently* ambiguous, each showing its
   two reference corners and an Auto/Left/Right select. This list is recomputed by
   `computeFreeCorners(n, diagonalSpecs)` - which topology (side count, and which corners each
   diagonal connects) makes a corner ambiguous is independent of the actual length *values*, so
   it's rebuilt only when that topology changes (side count, regular-polygon toggle, a diagonal's
   own from/to, or one added/removed - see the `rebuildCornerPlacementRows()`/
   `rebuildPlotCornerPlacementRows()` call sites), never on every length keystroke; doing so
   would rebuild the whole section's DOM (and lose focus/selection) for no reason, since which
   corners are ambiguous wouldn't have changed. `computeFreeCorners()` runs the same solver
   against a synthetic regular n-gon's own geometry purely to read off which corners come out
   ambiguous - never shown, never mixed into the real solve - so the list stays valid and stable
   even while the user's real length values are momentarily incomplete or inconsistent.

   `cornerChoices` (site/master boundary) and `plotCornerChoices` (Plot Editor, separate map -
   different label space, `A′..` not `A..`) reset whenever the corners they'd refer to stop
   existing or meaning the same thing: on a side-count change (`buildEdgeRows()`) and on loading
   a (possibly different) plot into the editor (`loadPlotForEditing()`). A corner dropped back to
   "Auto" is deleted from the map entirely, not stored as an explicit "auto" value - keeps
   `pinned()`'s check in the solver a single truthy lookup.

   **Orientation: Mirror/Rotate, and the chirality bug they surfaced.** Metes & Bounds has a
   Mirror checkbox (reflects the resolved shape across its own A-B edge - both stay exactly
   where they are, everything else flips to the other side) and a Rotate field (spins the result
   around A, which stays pinned at the origin either way) - `applyOrientation(vertices)`, applied
   fresh from the untouched solve every time (never accumulated onto an already-transformed
   shape) at all three `currentVertices =` sites. Purely a display/working-orientation choice -
   it changes no length, diagonal, or corner placement, and is unrelated to the later North
   Setter step (which rotates the *finalized* presentation drawing to true north; this rotates
   the *working* shape before that, e.g. to match a hand sketch while still entering data). Since
   Road Logic's side/edge references are plain array indices into `currentVertices`, not
   compass-relative, nothing downstream needed to change to respect it.

   Building this exposed a real, pre-existing bug, independent of Mirror/Rotate: `/compute-site`
   reconstructs the plot server-side from (lengths, interior angles) via a fixed left-turn walk
   (`vertices_from_edges`) - and mirroring a shape never changes any of its interior angles, so
   that data cannot say which of the two possible chiralities is the real one. Confirmed by
   direct comparison: for the 12-gon above (which the corner-placement fix legitimately resolves
   to a CW shape), the server came back as the *exact* Y-mirror of it - identical x, negated y,
   at every one of the 12 vertices. Since `computeSite()` never overwrote `currentVertices` with
   the server's response (only drew it once and stored `lastBuildable`), this was silently
   corrupting the buildable-area overlay for any plot that resolves CW - which the corner-
   placement/max-area work made a *normal*, common outcome, not a rare edge case. `rawSolvedVertices`
   (the shape *before* Mirror/Rotate, alongside `currentVertices`) and `alignServerChirality()`
   fix it: compare `signedArea()` sign between the server's response and `rawSolvedVertices`, and
   Y-flip the server's `plot`/`buildable` vertices if they disagree, *then* run the user's own
   `applyOrientation()` on top - confirmed with a real 10 ft setback that every buildable vertex
   now lands strictly inside the plot boundary with matching winding, where before the same
   inputs would have produced a mismatched, likely-nonsensical overlay. `interiorAnglesFromVertices()`
   itself also needed a matching fix (compute the turn relative to the polygon's own actual
   winding, `signedArea() >= 0`, rather than assuming CCW) - without it, sending a CW shape's
   angles to `/compute-site` at all would report each one as its reflex (360 minus the real
   angle), and the server would raise "Boundary does not close" or reconstruct something
   completely different, not merely mirrored.

   **The temporary test default has been removed.** `seedDiagonalGraphTestCase()` used to run
   at the end of each instance's boot and pre-fill Metes & Bounds with the exact real 12-gon
   above, so the fix was visible with zero data entry. It has served its purpose and is gone -
   both tools now boot to the ordinary **200 ft square** again (4 sides x 200 ft, one seeded
   diagonal of 282.84 ft). The 12-gon's measurements are still recorded above if this ever needs
   reproducing by hand: lengths `[140, 61, 50, 88, 75, 87, 68, 67, 42, 54, 46, 84]` with
   diagonals `L-B 184, L-C 200, L-D 214, L-E 154, E-K 128, E-J 144, E-I 130, I-F 165, F-H 140`.
   Nothing about the solver changed when the seed was added or removed.
2. **Road logic** - internal roads (straight or arced) with start/end references that can point
   at a plot side or another road. Calls `/compute-subsections`.
3. **Plot logic** - per sub-section sizing params -> `/insert-plots`.
4. **Plot editor** - area stepper (`/resize-plot`), manual edge/diagonal edits, Save
   (`/regenerate-fill`), plus uttam-6's new click-to-select (below).
5. **Print sheet** - client-side only, built with `jsPDF` from cdnjs. No backend endpoint.
6. **Shell behaviour** (new in uttam-6) - zoom/pan, step tabs and gating, read-only revisits,
   message severities, the two-stage print flow.

Then, at module scope: the home-screen router and `window.__uttam` (a test handle; each
instance also exposes a read-only `debug` getter bag so the CDP harness can inspect one
instance's state directly - nothing in the app reads across instances through it).

### Shared shell behaviour - the parts worth knowing

- **Step gating.** `finalized[stepKey]` is set only by that step's own finalize action.
  `blockerFor(key)` returns the first unfinalized step before `key`; a locked tab is greyed with
  a dashed border but stays clickable so it can answer with **"Finish Road Logic first"** -
  naming the specific blocking step, not just "locked" - through the same message area every
  other step error uses. It does not navigate.
- **Read-only revisits.** Steps before the first unfinalized one render with their saved values
  and every input/button disabled, under a "Finalized - showing saved values" banner. This task
  builds no invalidation cascade, so re-opening a finished step for editing would let a later
  step's data silently disagree with what it was derived from.
  `setStepReadOnly()` takes **the live layout hosts, not the step node** - by the time it runs
  the slots have already been moved out of the step node, and querying the node would find
  nothing and silently leave a finalized step fully editable (this was a real bug, caught by
  driving the page).
- **Zoom/pan** is one wrapper around whatever SVG the current step renders - never per step. It
  survives editing fields on the same tab (the whole point of the redesign) and **resets to 100%
  on every tab switch**. Pan is a pointer drag on the viewport.
  A pan that actually moved arms `suppressNextClick` for exactly the one click the browser
  synthesises at the end of the gesture, and `resetZoom()` disarms it. Latching on `dragMoved`
  alone instead stays armed forever after the first pan and silently eats every later selection
  click in the Plot Editor - which is exactly what it did before this was fixed.
- **Message severities.** `setMessage(text, "info" | "warning" | "error")` writes the one
  step-level message area, styled neutral-blue / amber / red. Severity comes from what actually
  happened, not from the call site's convenience: a compass-rule closure correction is `info`; a
  `repaired: true` setback offset, or a sub-section that placed zero road-facing plots, is
  `warning`; every `showError()` and every refused finalize is `error`. `advanceFrom()` carries
  the outcome message across the navigation it triggers, since `goToStep()` clears the area on
  arrival.
- **Plot Editor click-to-select.** `svgTransformFor()` now also returns `fn.inverse`, so a click
  goes client coords -> `getScreenCTM().inverse()` -> SVG user units -> `inverse()` -> plot feet,
  then a ray cast against each plot. Real plot: selects it (discarding any in-progress edit
  without a prompt, per the existing "nothing is permanent until Save plot" rule). Fill plot:
  names it and refuses, `info`. Anything else inside the site boundary: a generic "not an
  editable plot", `info` - tested against the **site boundary**, not each sub-section's own
  polygon, because open space very often hugs a sub-section edge where an exact ray cast is a
  coin flip. Typing a name in the field still selects on canvas too.
- **North Setter** is its own step, immediately before Print Sheet in *both* tools (the rotation
  is a property of the drawing, not of the sheet's text block, and it is the last thing that
  changes the geometry the sheet embeds - so it gets finalized before the sheet is composed).
  Left pane: the ink-only presentation drawing plus the **fixed** north arrow, which is the one
  step that shows `northIndicator` at all. Right pane: the degrees input, which redraws live.
  "Finalise north" locks the angle and advances to Print Sheet. `rotationInput`,
  `finalSitePlanSvg` and `finaliseBtn` all live here now, not in the print step.
- **Print Sheet, two stages.** Stage 1 is the split-screen step: a debounced auto-refreshing
  sheet preview filling the left pane and the **text fields only** on the right - the drawing,
  its orientation, its geometry and every computed area are read-only and come from that tool's
  own finalized data. Its left pane is an iframe, not an SVG, so this step sets `noZoom: true`:
  the zoom controls are hidden and the viewport does not pan (the embedded PDF viewer has its
  own zoom). "Continue to final sheet" opens stage 2, a full-viewport locked preview with
  Download PDF and a "Back to editing" route that is deliberately not a one-way door.

### `pointInPolygon` - a specific trap

It lived in `uttam-5`'s Building Footprint block, but `plotStaysInsideSubsection()` and
`pointStrictlyInsidePolygon()` in the **plot editor** call it. Dropping the footprint block
silently broke every "Save plot" with an unhandled `ReferenceError` (the button just did
nothing) until it was restored. If more `uttam-5` code is ever pruned from this folder, check
for callers by name across the whole file, not just within the block being removed.

## Testing approach

No test suite exists. Drive the real page with a CDP-driven headless-Chrome harness
(`chrome.exe --headless=new --remote-debugging-port=<port> --remote-allow-origins=*`, scripted
from Python in the scratchpad) and inspect state directly via `Runtime.evaluate` - **never trust
a code review of `app.js` alone**. Every bug found while building uttam-6 (read-only not
applying, the click-suppression latch, the missing `pointInPolygon`) was invisible to reading
and obvious the moment the page was actually driven.

Two uttam-6-specific harness notes:

- **Open a new tab after any `app.js` edit.** A live tab keeps running the JS it already loaded
  even though `reload=True` restarts the server.
- State is not global any more. Read it through `__uttam.active.debug.<field>`, and reach
  elements as `document.querySelector('#toolHost [data-el="x"]')`.
