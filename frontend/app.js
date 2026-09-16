// uttam-6 - two standalone tools (Site Plan, Master Plan) built from one shared UI.
//
// ARCHITECTURE, and the single rule that shapes this whole file:
//
//   Site Plan and Master Plan share *code* and share *nothing else*. Everything below the
//   `createTool()` line is instantiated once per tool: its own cloned DOM subtree, its own
//   element lookups, its own `currentVertices` / `roads` / `subsections` / `plotEditSession`
//   / print-sheet fields, its own per-step finalize flags. There is deliberately no shared
//   store, event bus, URL parameter or localStorage key through which one tool's data could
//   reach the other - the only module-scope mutable thing in this file is `activeTool`, which
//   holds *which* instance is currently mounted, never any of its data.
//
//   That is why the whole body is a closure rather than module-scope globals (which is what
//   uttam-5 used, being a single linear wizard). Two instances = two closures = independence
//   by construction, with no discipline required of any individual function inside.
//
// Geometry model (unchanged from uttam-5): with N side lengths fixed, a simple polygon has
// only N-3 truly free parameters. Instead of angles this uses the triangulation surveyors
// actually use on site - diagonals measured from one corner (A) with a tape measure. A fan of
// (N-3) diagonals from A splits the polygon into (N-2) triangles, each fully determined by SSS
// via circle-circle intersection - closed-form, no iteration.
//
// Feet is the canonical unit everywhere internally (matching layout_geometry.py and the
// /compute-site payload); the unit selector only changes what is typed/displayed.
const FT_PER_M = 3.280839895;
const SQFT_PER_KATHA = 720; // West Bengal/Bangladesh convention (20 Chatak = 1 Katha)
const SQFT_PER_CHATAK = 36;

// Which steps each tool has, in order, and what each tab is called. This table is the only
// place the two tools differ structurally - everything else below is identical code running
// against different data.
const TOOL_DEFS = {
  site: {
    title: "Site Plan",
    badge: "Standalone tool",
    steps: [
      { key: "mb", label: "Metes & Bounds" },
      { key: "north", label: "North Setter" },
      // The sheet preview is an iframe, not an SVG - there is nothing for the zoom/pan wrapper
      // to do with it (the PDF viewer has its own zoom), so this step hides those controls.
      { key: "print", label: "Print Sheet", noZoom: true },
    ],
  },
  master: {
    title: "Master Plan",
    badge: "Standalone tool",
    steps: [
      { key: "mb", label: "Metes & Bounds" },
      { key: "road", label: "Road Logic" },
      { key: "plots", label: "Plot Logic" },
      { key: "editor", label: "Plot Editor" },
      { key: "north", label: "North Setter" },
      { key: "print", label: "Print Sheet", noZoom: true },
    ],
  },
};

let instanceCounter = 0;

// ---------------------------------------------------------------------------------------
// One tool instance. Everything from here to the matching close brace is per-instance state.
// ---------------------------------------------------------------------------------------
function createTool(toolKey, host) {
  const def = TOOL_DEFS[toolKey];
  const instanceId = `t${++instanceCounter}`;

  const root = document.getElementById("toolShellTemplate").content.firstElementChild.cloneNode(true);
  root.dataset.tool = toolKey; // lets CSS/JS branch on which tool this instance is, e.g. to
                               // hide the neighbour-name/plot-no. columns for Master Plan only
  host.innerHTML = "";
  host.appendChild(root);

  // Every lookup in this instance is scoped to its own subtree. uttam-5 used `id=` and
  // document.getElementById, which cannot survive two live copies of the same markup on one
  // page - `data-el=` plus this helper is the same thing, scoped.
  const $ = (name) => root.querySelector(`[data-el="${name}"]`);

  const stepTabsEl = $("stepTabs");
  const zoomViewportEl = $("zoomViewport");
  const zoomCanvasEl = $("zoomCanvas");
  const zoomControlsEl = $("zoomControls");
  const zoomLevelEl = $("zoomLevel");
  const legendHostEl = $("legendHost");
  const messageAreaEl = $("messageArea");
  const actionHostEl = $("actionHost");
  const extraLeftHostEl = $("extraLeftHost");
  const formHostEl = $("formHost");
  const paneRightEl = $("paneRight");
  const readonlyBannerEl = $("readonlyBanner");
  const finalSheetEl = $("finalSheet");
  const finalSheetFrameEl = $("finalSheetFrame");

  $("toolTitle").textContent = def.title;
  $("toolBadge").textContent = def.badge;

  // Step panels: clone the shared step markup. The kept nodes are MOVED into the split layout
  // on navigation (never re-cloned), so each step's inputs keep their values and listeners
  // across tab switches.
  //
  // Every instance clones EVERY step's markup, not just the ones in its own tab list, so that
  // the wizard body below can stay byte-identical to uttam-5's (it wires up every control
  // unconditionally at instance-construction time and would throw on a missing element).
  // `def.steps` alone decides which steps get a tab and are reachable - the extra parked nodes
  // are never shown and their state never populates, so e.g. Site Plan's print sheet still
  // sees an empty `subsections` and correctly falls back to the bare plot boundary.
  const stepsFragment = document.getElementById("toolStepsTemplate").content.cloneNode(true);
  const stepNodes = {};
  stepsFragment.querySelectorAll(".step-def").forEach((node) => {
    stepNodes[node.dataset.step] = node;
    root.appendChild(node);            // parked off-layout until this step is shown
    node.style.display = "none";
  });
  def.steps.forEach((s) => {
    if (!stepNodes[s.key]) throw new Error(`missing step markup for "${s.key}"`);
  });

  // Set by drawPlotEditorPreview() so a click on the drawing can be mapped back to plot feet.
  let lastEditorTransform = null;

  // Radio groups are name-scoped per document, so two instances of the same markup would
  // otherwise share one group and unselect each other's buttons.
  root.querySelectorAll('input[type="radio"]').forEach((r) => {
    if (r.name) r.name = `${r.name}__${instanceId}`;
  });

  // ---- Message area: one place for every step-level message, with real severities. --------
  // info    - neutral, non-blocking ("closure corrected by 0.3 ft")
  // warning - amber, something was repaired/assumed but the step still works
  // error   - red, and always paired with a finalize/action that refused to proceed
  function setMessage(text, severity) {
    if (!text) {
      messageAreaEl.textContent = "";
      messageAreaEl.className = "message-area";
      messageAreaEl.dataset.severity = "";
      return;
    }
    messageAreaEl.textContent = text;
    messageAreaEl.className = `message-area msg-${severity || "info"}`;
    messageAreaEl.dataset.severity = severity || "info";
  }
  function clearMessage() { setMessage(""); }

let currentUnit = "ft";

function feetToDisplay(feet) {
  return currentUnit === "m" ? feet / FT_PER_M : feet;
}

function displayToFeet(display) {
  return currentUnit === "m" ? display * FT_PER_M : display;
}

function unitLabel() {
  return currentUnit === "m" ? "m" : "ft";
}

function updateUnitLabels() {
  const u = unitLabel();
  const lengthHeader = $("lengthHeader");
  const setbackHeader = $("setbackHeader");
  const roadWidthHeader = $("roadWidthHeader");
  const diagonalLengthHeader = $("diagonalLengthHeader");
  const roadExtensionLabel = $("roadExtensionLabel");
  if (lengthHeader) lengthHeader.textContent = `Length (${u})`;
  if (setbackHeader) setbackHeader.textContent = `Setback (${u})`;
  if (roadWidthHeader) roadWidthHeader.textContent = `Road width (${u})`;
  if (diagonalLengthHeader) diagonalLengthHeader.textContent = `Length (${u})`;
  if (roadExtensionLabel) roadExtensionLabel.textContent = `Road extension (${u}, each side)`;
  // Master Plan hides the table headers (its Metes & Bounds lists are a two-column grid, which a
  // header row can't line up with), so the unit has to be stated here instead of in "Length (ft)".
  const sidesNote = $("sidesNote");
  if (sidesNote) sidesNote.textContent = `Length of each side, in ${u}, walking the boundary in order.`;
}

function labelsFor(n) {
  const labels = [];
  let i = 0;
  while (labels.length < n) {
    let label = "";
    let k = i;
    while (true) {
      label = String.fromCharCode(65 + (k % 26)) + label;
      k = Math.floor(k / 26) - 1;
      if (k < 0) break;
    }
    labels.push(label);
    i++;
  }
  return labels;
}

function centroidOf(vertices) {
  let cx = 0, cy = 0;
  vertices.forEach((v) => { cx += v.x; cy += v.y; });
  return { x: cx / vertices.length, y: cy / vertices.length };
}

function signedArea(pts) {
  let area = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p1 = pts[i], p2 = pts[(i + 1) % n];
    area += p1.x * p2.y - p2.x * p1.y;
  }
  return area / 2;
}

function polygonArea(pts) {
  return Math.abs(signedArea(pts));
}

function triangleArea(a, b, c) {
  return Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
}

function interiorAnglesFromVertices(vertices) {
  // The real geometric interior angle at every vertex of an already-resolved polygon -
  // needed only to report equivalent angle values to the backend (/compute-site still
  // expects them), never shown to the user anymore. Robust to EITHER winding direction: the
  // Metes & Bounds "Mirror" option reflects the whole shape, which flips CCW to CW - without
  // checking the polygon's own overall winding once and picking the matching turn direction,
  // a mirrored shape's angles would each come back as the REFLEX of the real interior angle
  // (verified: mirroring a unit square's corner gives 270 deg here instead of 90 deg without
  // this), and /compute-site would reconstruct a completely different, likely invalid polygon
  // from a perfectly valid mirrored one.
  const n = vertices.length;
  const ccw = signedArea(vertices) >= 0;
  return vertices.map((v, i) => {
    const prev = vertices[(i - 1 + n) % n];
    const next = vertices[(i + 1) % n];
    const v1 = { x: prev.x - v.x, y: prev.y - v.y };
    const v2 = { x: next.x - v.x, y: next.y - v.y };
    const a1 = Math.atan2(v1.y, v1.x);
    const a2 = Math.atan2(v2.y, v2.x);
    let ang = ((ccw ? a1 - a2 : a2 - a1) * 180) / Math.PI;
    ang = ((ang % 360) + 360) % 360;
    return ang;
  });
}

function circleIntersections(c1, r1, c2, r2) {
  const dx = c2.x - c1.x, dy = c2.y - c1.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9 || d > r1 + r2 + 1e-6 || d < Math.abs(r1 - r2) - 1e-6) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = Math.max(0, r1 * r1 - a * a);
  const h = Math.sqrt(h2);
  const xm = c1.x + (a * dx) / d, ym = c1.y + (a * dy) / d;
  const p1 = { x: xm + (h * dy) / d, y: ym - (h * dx) / d };
  const p2 = { x: xm - (h * dy) / d, y: ym + (h * dx) / d };
  if (h < 1e-9) return [p1];
  return [p1, p2];
}

function pickOutward(placedSoFar, candidates) {
  let best = candidates[0], bestArea = -Infinity;
  for (const cand of candidates) {
    const area = Math.abs(signedArea(placedSoFar.concat([cand])));
    if (area > bestArea) { bestArea = area; best = cand; }
  }
  return best;
}

function walkRegular(lengths, regularAngle) {
  // All angles equal - always closes exactly, no solving needed.
  const n = lengths.length;
  const pts = [{ x: 0, y: 0 }];
  let heading = 0, x = 0, y = 0;
  for (let i = 0; i < n; i++) {
    x += lengths[i] * Math.cos((heading * Math.PI) / 180);
    y += lengths[i] * Math.sin((heading * Math.PI) / 180);
    if (i < n - 1) pts.push({ x, y });
    heading += 180 - regularAngle;
  }
  return pts;
}

function diagonalCount(n) {
  return Math.max(0, n - 3);
}

function solveFromDiagonals(lengths, diagonals) {
  // diagonals[j] = length of A-to-V(j+2), for j = 0..(n-4) - the fan triangulation from A.
  const n = lengths.length;
  const labels = labelsFor(n);
  const V0 = { x: 0, y: 0 };
  const V1 = { x: lengths[0], y: 0 };
  const vertices = [V0, V1];

  for (let k = 2; k <= n - 2; k++) {
    const diagIndex = k - 2;
    const prevVertex = vertices[k - 1];
    const sideLen = lengths[k - 1];
    const diagLen = diagonals[diagIndex];
    const solutions = circleIntersections(prevVertex, sideLen, V0, diagLen);
    if (solutions.length === 0) {
      return {
        ok: false,
        error: `No triangle closes with side ${labels[k - 1]}-${labels[k]} (${sideLen} ft) and ` +
          `diagonal ${labels[0]}-${labels[k]} (${diagLen} ft) - one is too long or too short ` +
          `relative to the other. Adjust one of them.`,
      };
    }
    vertices.push(pickOutward(vertices, solutions));
  }

  // Closing step: the last vertex must sit exactly the last two side lengths away.
  const prevVertex = vertices[n - 2];
  const sideLen = lengths[n - 2];
  const closingLen = lengths[n - 1];
  const solutions = circleIntersections(prevVertex, sideLen, V0, closingLen);
  if (solutions.length === 0) {
    return {
      ok: false,
      error: `The last two sides (${labels[n - 2]}-${labels[n - 1]} = ${sideLen} ft, ` +
        `${labels[n - 1]}-${labels[0]} = ${closingLen} ft) don't close the shape given the ` +
        `diagonals above - adjust a diagonal or one of these two side lengths.`,
    };
  }
  vertices.push(pickOutward(vertices, solutions));
  return { ok: true, vertices };
}

// Generates every size-`size` combination of the integers [0, count), as arrays, depth-first,
// via a generator so a bounded caller (see solveFromDiagonalGraph below) can stop consuming
// early without ever materialising combinations it will never look at.
function* combinationsOf(count, size, start, combo) {
  start = start || 0;
  combo = combo || [];
  if (combo.length === size) { yield combo.slice(); return; }
  for (let i = start; i < count; i++) {
    combo.push(i);
    yield* combinationsOf(count, size, i + 1, combo);
    combo.pop();
  }
}

// Cross product of (i2-i1) x (p-i1) - positive means p sits to the LEFT of the directed line
// from i1 to i2, negative means RIGHT. Used to translate a user's explicit "left"/"right"
// corner-placement choice into a concrete solution index, and nowhere else - the sign
// convention only has to be self-consistent, not match any particular real-world compass sense.
function sideOfLine(i1, i2, p) {
  return (i2.x - i1.x) * (p.y - i1.y) - (i2.y - i1.y) * (p.x - i1.x);
}

function solveFromDiagonalGraph(lengths, diagonalSpecs, cornerChoices) {
  // The general "chain triangulation" method surveyors actually use for large plots instead
  // of always measuring back to corner A (which can be impractically far away): every
  // diagonal can connect any two corners, not just A to something. This builds a full
  // distance graph (every side, plus every diagonal given) and places one vertex at a time
  // via circle-circle intersection, exactly like solveFromDiagonals() above, but picking
  // whichever not-yet-placed vertex already has two already-placed neighbours (by side OR
  // diagonal) rather than assuming a fixed fan-from-A order. Feeding it the old "every
  // diagonal from A" shape produces the identical placement sequence as solveFromDiagonals(),
  // so this is a strict generalisation, not a different algorithm.
  const n = lengths.length;
  const labels = labelsFor(n);
  const dist = Array.from({ length: n }, () => ({}));
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    dist[i][j] = lengths[i];
    dist[j][i] = lengths[i];
  }
  diagonalSpecs.forEach(({ from, to, length }) => {
    if (from === to || validDiagonalTargets(n, from).has(to)) return; // ignore anything that's actually a side
    if (!(to in dist[from])) dist[from][to] = length;
    if (!(from in dist[to])) dist[to][from] = length;
  });

  // Places every vertex. Every corner resolved from exactly two known distances is a
  // circle-circle intersection, which always has two mirror-image solutions - distance alone
  // can never say which side of that pair the real boundary bulges to, that's a fact about the
  // physical site, not something any of these numbers encode.
  //
  // `branchOf(idx, ctx)`, when given, is consulted for every such corner (`ctx` names it and
  // its two reference corners: `{label, i1Label, i2Label}`) and may return 0 or 1 to force a
  // specific solution, "left"/"right" (resolved here, relative to the directed line from the
  // first reference corner to the second, via `sideOfLine`) for the same purpose in the units a
  // human actually thinks in, or anything else (including nothing) to fall back to the default
  // heuristic (whichever solution keeps the polygon's running area largest). Every corner's
  // resolved 0/1 branch is recorded (in placement order) in `branches`, and its identity plus
  // reference corners in `freeInfo` - together these let a caller re-run with the same choices,
  // or specific ones flipped, and land on exactly the same corners either way; `freeInfo` alone
  // (independent of whether placement fully succeeds) is what the UI uses to list which corners
  // are actually ambiguous right now, so a per-corner Left/Right control can be shown next to
  // the truly ambiguous ones instead of guessing at the shape from the diagonal graph alone.
  function place(branchOf) {
    const pts = new Array(n).fill(null);
    pts[0] = { x: 0, y: 0 };
    pts[1] = { x: lengths[0], y: 0 };
    let placedCount = 2;
    let progress = true;
    let freeIndex = 0;
    const branches = [];
    const freeInfo = [];
    while (placedCount < n && progress) {
      progress = false;
      for (let k = 0; k < n; k++) {
        if (pts[k]) continue;
        const knownNeighbours = Object.keys(dist[k]).map(Number).filter((j) => pts[j] !== null);
        if (knownNeighbours.length < 2) continue;
        const [i1, i2] = knownNeighbours;
        const solutions = circleIntersections(pts[i1], dist[k][i1], pts[i2], dist[k][i2]);
        if (solutions.length === 0) {
          return {
            ok: false,
            error: `${labels[k]} doesn't fit: the distance from ${labels[i1]} (${dist[k][i1]} ft) and ` +
              `from ${labels[i2]} (${dist[k][i2]} ft) can't both reach the same point. Adjust one of them.`,
            freeInfo,
          };
        }
        if (solutions.length === 1) {
          pts[k] = solutions[0]; // no real ambiguity (h≈0) - not counted as a free corner at all
        } else {
          const idx = freeIndex++;
          const ctx = { label: labels[k], i1Label: labels[i1], i2Label: labels[i2] };
          freeInfo.push(ctx);
          const rawForced = branchOf ? branchOf(idx, ctx) : null;
          let forced = null;
          if (rawForced === 0 || rawForced === 1) {
            forced = rawForced;
          } else if (rawForced === "left" || rawForced === "right") {
            const sol0IsLeft = sideOfLine(pts[i1], pts[i2], solutions[0]) > 0;
            forced = rawForced === "left" ? (sol0IsLeft ? 0 : 1) : (sol0IsLeft ? 1 : 0);
          }
          if (forced === 0 || forced === 1) {
            pts[k] = solutions[forced];
            branches[idx] = forced;
          } else {
            const chosen = pickOutward(pts.filter((p) => p !== null), solutions);
            pts[k] = chosen;
            branches[idx] = chosen === solutions[0] ? 0 : 1;
          }
        }
        placedCount++;
        progress = true;
      }
    }

    if (placedCount < n) {
      const missing = pts.map((p, i) => (p ? null : labels[i])).filter(Boolean);
      return {
        ok: false,
        error: `Not enough diagonals to fully determine the shape - ${missing.join(", ")} ` +
          `${missing.length === 1 ? "isn't" : "aren't"} pinned down yet. Add a diagonal connecting ` +
          `one of them to two corners that are already fixed.`,
        freeInfo,
      };
    }
    return { ok: true, vertices: pts, branches, freeCount: freeIndex, freeInfo };
  }

  // An explicit per-corner choice always wins, on the very first placement - not just as a tie
  // breaker once a crossing is already found. `cornerChoices` maps a corner's OWN label (not a
  // diagonal's from/to - a corner can be pinned by two diagonals, a diagonal and a side, or two
  // sides, so the choice belongs to the corner, never to any one specific diagonal row) to
  // "left" or "right"; anything else (absent, "auto") defers to the default heuristic below.
  const pinned = (label) => {
    const c = cornerChoices && cornerChoices[label];
    return c === "left" || c === "right" ? c : null;
  };
  const base = place((idx, ctx) => pinned(ctx.label));
  if (!base.ok) return base;
  if (!polygonSelfIntersects(base.vertices)) return base;

  // The heuristic above picked a mirror image at some corner that makes the boundary cross
  // itself - not a data problem (every side and diagonal is still exactly what was entered),
  // just the wrong guess at an inherently two-way choice. Search nearby alternatives: flip a
  // small GROUP of ambiguous, NOT-explicitly-pinned corners together (starting from one at a
  // time) rather than every 2^(free corners) combination, since the full search needs to stay
  // fast on every keystroke. A corner the user has already pinned is never a candidate to flip -
  // it stays exactly as they set it even while the rest is searched.
  //
  // Among every simple (non-crossing) alternative found, keep the one with the LARGEST total
  // enclosed area - not just the first one found, and specifically NOT whichever needs the
  // fewest corners flipped from the original guess (that was tried first and picked a valid but
  // wrong mirror on a real 12-gon: needing only 2 flips instead of the actual 4, it landed on
  // one of the 78 possible simple shapes that was a near-worst fit to the real site, ranking
  // 69th of 78 by similarity - while "largest area" alone picked the actual correct shape,
  // ranked 1st). This isn't a coincidence: a real plot boundary is never folded back over
  // itself, so of every way to resolve the same lengths and diagonals into a simple polygon,
  // the true one is never smaller than a self-intersecting "solution" would naively compute
  // (crossing folds area back over itself) or than another valid-but-wrong mirror choice
  // elsewhere on the shape - maximum area is the closest thing to "most like the real site"
  // available without ever having seen the site (or without the user pinning a corner
  // explicitly, which is always preferred over this guess when available).
  const searchable = base.freeInfo.map((info, idx) => idx).filter((idx) => !pinned(base.freeInfo[idx].label));
  let best = null;
  let bestArea = -Infinity;
  if (searchable.length > 0) {
    const MAX_GROUP = 4;
    const MAX_ATTEMPTS = 20000;
    let attempts = 0;
    search:
    for (let groupSize = 1; groupSize <= Math.min(MAX_GROUP, searchable.length); groupSize++) {
      for (const localFlipSet of combinationsOf(searchable.length, groupSize)) {
        if (++attempts > MAX_ATTEMPTS) break search;
        const flipped = new Set(localFlipSet.map((i) => searchable[i]));
        const attempt = place((idx, ctx) => {
          const p = pinned(ctx.label);
          if (p) return p;
          return flipped.has(idx) ? 1 - base.branches[idx] : base.branches[idx];
        });
        if (!attempt.ok || polygonSelfIntersects(attempt.vertices)) continue;
        const area = polygonArea(attempt.vertices);
        if (area > bestArea) {
          bestArea = area;
          best = attempt;
        }
      }
    }
  }

  if (best) {
    best.autoFixedCrossing = true;
    // Only the corners actually left on "Auto" were guessed - a corner the user pinned stayed
    // exactly as set throughout the search, so it's not part of what needs double-checking.
    best.autoFixedLabels = searchable.map((idx) => base.freeInfo[idx].label);
    return best;
  }

  return {
    ok: false,
    error: "These exact side lengths and diagonals only produce a self-crossing shape, however " +
      "the corners are placed - a real plot boundary can't cross itself. Try measuring one of " +
      "the diagonals near the crossing from a different corner, or pin a corner's placement " +
      "directly in the Corner placement section below.",
    freeInfo: base.freeInfo,
  };
}

// Which corners are ambiguous depends only on the diagonal graph's TOPOLOGY (n sides, and
// which two corners each diagonal connects) - not on the actual length values, which the user
// may still be mid-typing or leave momentarily inconsistent. So the Corner Placement list is
// computed from a synthetic regular n-gon's own geometry (guaranteed convex, so this always
// succeeds and never itself needs a corner pinned) purely to read off `freeInfo` - never shown,
// never mixed into the real solve.
function computeFreeCorners(n, diagonalSpecs) {
  if (n < 4) return []; // a triangle has no ambiguity - 3 sides alone always fully determine it
  const regularAngle = ((n - 2) * 180) / n;
  const verts = walkRegular(new Array(n).fill(100), regularAngle);
  const dist = (a, b) => Math.hypot(verts[a].x - verts[b].x, verts[a].y - verts[b].y);
  const syntheticLengths = verts.map((v, i) => dist(i, (i + 1) % n));
  const syntheticDiagonals = diagonalSpecs
    .filter(({ from, to }) => from !== to)
    .map(({ from, to }) => ({ from, to, length: dist(from, to) }));
  const result = solveFromDiagonalGraph(syntheticLengths, syntheticDiagonals, null);
  return result.freeInfo || [];
}

const unitSelectEl = $("unitSelect");
const sidesCountEl = $("sidesCount");
const regularToggleEl = $("regularToggle");
const regularNoteEl = $("regularNote");
const edgeRowsEl = $("edgeRows");
const diagonalRowsEl = $("diagonalRows");
const diagonalsTableEl = $("diagonalsTable");
const diagonalsNoteEl = $("diagonalsNote");
const diagonalAddBtnEl = $("addDiagonalBtn");
const cornerPlacementTableEl = $("cornerPlacementTable");
const cornerPlacementRowsEl = $("cornerPlacementRows");
const cornerPlacementNoteEl = $("cornerPlacementNote");
const computeBtn = $("computeBtn");
const closureNoteEl = $("closureNote");
const svgEl = $("sitePreviewSvg");
const statusLogEl = $("statusLog");
const errorBoxEl = $("errorBox");
const resultBoxEl = $("resultBox");
const roadExtensionEl = $("roadExtension");
const mirrorEdgeSelectEl = $("mirrorEdgeSelect");
const mirrorBtnEl = $("mirrorBtn");
const rotationOrientationInputEl = $("rotationOrientationInput");
const areaSummaryEl = $("areaSummary");
const finaliseBtn = $("finaliseBtn");
const rotationInputEl = $("rotationInput");
const finalSvgEl = $("finalSitePlanSvg");
const northIndicatorEl = $("northIndicator");
const adminTypeSelectEl = $("adminTypeSelect");
const adminNameInputEl = $("adminNameInput");
const adminNameLabelEl = $("adminNameLabel");
const wardNoInputEl = $("wardNoInput");
const rsKhatianInputEl = $("rsKhatianInput");
const rsPlotInputEl = $("rsPlotInput");
const csPlotInputEl = $("csPlotInput");
const sketchScaleNTSEl = $("sketchScaleNTS");
const sketchScaleToScaleEl = $("sketchScaleToScale");
const sketchScaleRatioRowEl = $("sketchScaleRatioRow");
const sketchScaleXEl = $("sketchScaleX");
const sketchScaleYEl = $("sketchScaleY");
const siteScaleNTSEl = $("siteScaleNTS");
const siteScaleToScaleEl = $("siteScaleToScale");
const siteScaleRatioRowEl = $("siteScaleRatioRow");
const siteScaleXEl = $("siteScaleX");
const siteScaleYEl = $("siteScaleY");
const mouzaScaleNTSEl = $("mouzaScaleNTS");
const mouzaScaleToScaleEl = $("mouzaScaleToScale");
const mouzaScaleRatioRowEl = $("mouzaScaleRatioRow");
const mouzaScaleXEl = $("mouzaScaleX");
const mouzaScaleYEl = $("mouzaScaleY");
const surveyorNameInputEl = $("surveyorNameInput");
const surveyorRegdInputEl = $("surveyorRegdInput");
const drawnByInputEl = $("drawnByInput");
const additionalNotesInputEl = $("additionalNotesInput");
const mouzaMapInputEl = $("mouzaMapInput");
const previewPdfBtn = $("previewPdfBtn");
const downloadPdfBtn = $("downloadPdfBtn");
const pdfNoteEl = $("pdfNote");
const pdfPreviewFrameEl = $("pdfPreviewFrame");
const addRoadBtnEl = $("addRoadBtn");
const addOuterRoadBtnEl = $("addOuterRoadBtn");
const roadLogicSvgEl = $("roadLogicSvg");
const roadRowsEl = $("roadRows");
const outerRoadRowsEl = $("outerRoadRows");
const outerRoadNoteEl = $("outerRoadNote");
const roadLogicNoteEl = $("roadLogicNote");
const finalizeRoadLogicBtn = $("finalizeRoadLogicBtn");
const finalizeRoadLogicNoteEl = $("finalizeRoadLogicNote");
const plotLogicCardEl = $("plotLogicCard");
const plotLogicSvgEl = $("plotLogicSvg");
const plotLogicNoteEl = $("plotLogicNote");
const subsectionRowsEl = $("subsectionRows");
const finalizeMasterPlanBtn = $("finalizeMasterPlanBtn");
const finalizeMasterPlanNoteEl = $("finalizeMasterPlanNote");
const masterPlanCardEl = $("masterPlanCard");
const masterPlanSvgEl = $("masterPlanSvg");
const masterPlanSummaryEl = $("masterPlanSummary");
const finalizePlotLogicBtn = $("finalizePlotLogicBtn");
const finalizePlotLogicNoteEl = $("finalizePlotLogicNote");
const plotEditorCardEl = $("plotEditorCard");
const plotEditorSvgEl = $("plotEditorSvg");
const addPlotInputEl = $("addPlotInput");
const addPlotBtnEl = $("addPlotBtn");
const addPlotNoteEl = $("addPlotNote");
const combinePlotAInputEl = $("combinePlotAInput");
const combinePlotBInputEl = $("combinePlotBInput");
const combinePlotsBtnEl = $("combinePlotsBtn");
const combinePlotsNoteEl = $("combinePlotsNote");
const plotNameInputEl = $("plotNameInput");
const plotNameNoteEl = $("plotNameNote");
const plotEditFieldsEl = $("plotEditFields");
const plotSidesCountEl = $("plotSidesCount");
const plotEdgeRowsEl = $("plotEdgeRows");
const plotDiagonalsNoteEl = $("plotDiagonalsNote");
const plotDiagonalsTableEl = $("plotDiagonalsTable");
const plotDiagonalRowsEl = $("plotDiagonalRows");
const addPlotDiagonalBtnEl = $("addPlotDiagonalBtn");
const plotCornerPlacementTableEl = $("plotCornerPlacementTable");
const plotCornerPlacementRowsEl = $("plotCornerPlacementRows");
const plotCornerPlacementNoteEl = $("plotCornerPlacementNote");
const plotAreaNoteEl = $("plotAreaNote");
const plotAreaMinusBtnEl = $("plotAreaMinusBtn");
const plotAreaPlusBtnEl = $("plotAreaPlusBtn");
const plotAreaValueEl = $("plotAreaValue");
const plotAreaStepNoteEl = $("plotAreaStepNote");
const pushEdgeSelectEl = $("pushEdgeSelect");
const expandPlotBtnEl = $("expandPlotBtn");
const expandPlotNoteEl = $("expandPlotNote");
const resetPlotBtnEl = $("resetPlotBtn");
const savePlotBtnEl = $("savePlotBtn");
const savePlotNoteEl = $("savePlotNote");

let mouzaMapDataUrl = null;
let lastPdfDoc = null;

let lastBuildable = null;   // this tool's own buildable polygon, from its own /compute-site
let currentVertices = null; // the last successfully resolved plot polygon (local coords),
                             // AFTER the Mirror/Rotate orientation transform below
let rawSolvedVertices = null; // the same shape BEFORE that transform - whatever chirality the
                               // solver/corner-placement search itself produced. Kept separately
                               // so /compute-site's response (reconstructed server-side by a
                               // fixed-turn-convention walk that can land in either chirality -
                               // see applyOrientation()'s own comment) can be lined up against
                               // the actual solve, not against a shape the user has already
                               // mirrored/rotated on top of it.
let lastBuildableAreaSqft = null;
let mirrorEnabled = false; // toggled by the Mirror button, not a checkbox's own .checked state
// Explicit corner-placement pins for the site/master boundary and for the plot editor's own
// reshape solve, kept separate since they're two different label spaces (A..L vs A'..L'). Maps
// a corner's own label to "left" or "right"; a corner absent here is "Auto" (the solver's
// self-intersection-avoiding, largest-area heuristic decides). Reset whenever the underlying
// shape's vertex count/diagonal graph changes - see buildEdgeRows()/loadPlotForEditing().
let cornerChoices = {};
let plotCornerChoices = {};
let roads = []; // resolved {name, type, width, start, end} for each road-logic row, in order
let roadUidCounter = 0; // stable per-row id, independent of DOM position, so removing a road
                         // never shifts another row's own reference value

function logStatus(line, isError) {
  statusLogEl.classList.remove("empty");
  const el = document.createElement("div");
  if (isError) el.className = "error-line";
  el.textContent = line;
  statusLogEl.appendChild(el);
  statusLogEl.scrollTop = statusLogEl.scrollHeight;
}

// Every showError() call site is a refused action, so it is always a blocking-severity
// message as well as a red box next to the fields that caused it.
function showError(message) {
  errorBoxEl.style.display = "block";
  errorBoxEl.textContent = message;
  setMessage(message, "error");
}

function clearError() {
  errorBoxEl.style.display = "none";
  errorBoxEl.textContent = "";
}

function currentSideCount() {
  return edgeRowsEl.querySelectorAll("tr").length;
}

function readLengths() {
  return Array.from(edgeRowsEl.querySelectorAll("tr")).map(
    (r) => displayToFeet(parseFloat(r.querySelector(".length-input").value) || 0)
  );
}

function readRoleSetback() {
  const rows = Array.from(edgeRowsEl.querySelectorAll("tr"));
  return {
    roles: rows.map((r) => r.querySelector(".role-select").value || null),
    setbacks: rows.map((r) => displayToFeet(parseFloat(r.querySelector(".setback-input").value) || 0)),
    roadWidths: rows.map((r) => displayToFeet(parseFloat(r.querySelector(".road-width-input").value) || 0)),
  };
}

function isRoadRole(role) {
  return role === "road" || role === "front_road";
}

// The single source of truth for OUTER roads - the ones running along a boundary side, outside
// the plot, as opposed to the internal network Road Logic carves through it.
//
// Master Plan owns these on the Road Logic step ("Add outer road"), which is what keeps the
// Metes & Bounds page down to the boundary itself. Site Plan has no Road Logic step at all
// (see TOOL_DEFS), so it keeps them on its own Metes & Bounds rows exactly as before - hence
// the two branches rather than one. Every consumer (the drawing, the PDF sheet, sub-section
// frontage detection) goes through here, so the two tools can't drift apart.
function readOuterRoads() {
  if (toolKey === "master") {
    if (!outerRoadRowsEl) return [];
    return Array.from(outerRoadRowsEl.querySelectorAll(".outer-road-row")).map((row) => ({
      edgeIndex: parseInt(row.querySelector(".outer-road-side-select").value, 10),
      width: displayToFeet(parseFloat(row.querySelector(".outer-road-width-input").value) || 0),
      extension: Math.max(0, displayToFeet(parseFloat(row.querySelector(".outer-road-extension-input").value) || 0)),
      frontRoad: false,
    })).filter((r) => Number.isInteger(r.edgeIndex) && r.edgeIndex >= 0 && r.width > 0);
  }
  if (!edgeRowsEl.children.length) return [];
  const { roles, roadWidths } = readRoleSetback();
  const extension = Math.max(0, displayToFeet(parseFloat(roadExtensionEl.value) || 0));
  const out = [];
  roles.forEach((role, i) => {
    if (isRoadRole(role) && roadWidths[i] > 0) {
      out.push({ edgeIndex: i, width: roadWidths[i], extension, frontRoad: role === "front_road" });
    }
  });
  return out;
}

function outerRoadEdgeSet() {
  return new Set(readOuterRoads().map((r) => r.edgeIndex));
}

function readNeighbours() {
  const rows = Array.from(edgeRowsEl.querySelectorAll("tr"));
  return {
    names: rows.map((r) => r.querySelector(".neighbour-name-input").value.trim()),
    plots: rows.map((r) => r.querySelector(".neighbour-plot-input").value.trim()),
  };
}

function readDiagonalSpecs() {
  return Array.from(diagonalRowsEl.querySelectorAll("tr")).map((tr) => ({
    from: parseInt(tr.querySelector(".diagonal-from-select").value, 10),
    to: parseInt(tr.querySelector(".diagonal-to-select").value, 10),
    length: displayToFeet(parseFloat(tr.querySelector(".diagonal-input").value) || 0),
  }));
}

function validDiagonalTargets(n, fromIndex) {
  // A diagonal can't connect a vertex to itself or to either of its own polygon neighbours -
  // those are sides, not diagonals.
  const prev = (fromIndex - 1 + n) % n;
  const next = (fromIndex + 1) % n;
  return new Set([fromIndex, prev, next]);
}

function populateDiagonalSelect(selectEl, n, labels, excludeSet) {
  const previousValue = selectEl.value;
  selectEl.innerHTML = "";
  for (let i = 0; i < n; i++) {
    if (excludeSet.has(i)) continue;
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = labels[i];
    selectEl.appendChild(opt);
  }
  const stillValid = Array.from(selectEl.options).some((o) => o.value === previousValue);
  if (stillValid) selectEl.value = previousValue;
  else if (selectEl.options.length) selectEl.selectedIndex = 0;
}

// "A-B", "B-C", ... for whichever edge Mirror should reflect across - rebuilt alongside the
// edge rows themselves, since the option list depends only on side count, not on any length.
function mirrorEdgeOptions(n) {
  const labels = labelsFor(n);
  return Array.from({ length: n }, (_, i) => ({
    value: String(i),
    text: `${labels[i]}-${labels[(i + 1) % n]}`,
  }));
}

function buildEdgeRows() {
  const n = Math.max(3, Math.min(20, parseInt(sidesCountEl.value, 10) || 4));
  sidesCountEl.value = n;
  const labels = labelsFor(n);
  const regularAngle = ((n - 2) * 180) / n;

  cornerChoices = {}; // a new side count invalidates every previous corner pin's meaning
  populateSelectOptions(mirrorEdgeSelectEl, mirrorEdgeOptions(n)); // defaults to index 0 = A-B
                                                                    // when the old value (an edge
                                                                    // index from before) no longer
                                                                    // exists at the new side count

  edgeRowsEl.innerHTML = "";

  for (let i = 0; i < n; i++) {
    const from = labels[i];
    const to = labels[(i + 1) % n];
    const tr = document.createElement("tr");
    tr.dataset.edgeIndex = String(i);

    const edgeTd = document.createElement("td");
    edgeTd.textContent = `${from}-${to}`;
    tr.appendChild(edgeTd);

    const lengthTd = document.createElement("td");
    const lengthInput = document.createElement("input");
    lengthInput.type = "number";
    lengthInput.step = "0.01";
    lengthInput.min = "0.01";
    lengthInput.value = feetToDisplay(200).toFixed(2);
    lengthInput.className = "length-input";
    lengthInput.disabled = regularToggleEl.checked && i > 0;
    lengthInput.addEventListener("input", onLengthChanged);
    lengthInput.addEventListener("change", onLengthChanged);
    lengthTd.appendChild(lengthInput);
    tr.appendChild(lengthTd);

    const roleTd = document.createElement("td");
    roleTd.className = "col-role";
    const roleSelect = document.createElement("select");
    roleSelect.className = "role-select";
    // Master Plan declares outer roads on its Road Logic step instead, so the two road roles
    // (and the Road width column beside them) are not offered here - see readOuterRoads().
    [
      ["", "-"],
      ["front", "Front"],
      ...(toolKey === "master" ? [] : [["road", "Road"], ["front_road", "Front / Road"]]),
      ["rear", "Rear"],
      ["side", "Side"],
    ].forEach(([val, text]) => {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = text;
      roleSelect.appendChild(opt);
    });
    roleSelect.value = "side";
    roleTd.appendChild(roleSelect);
    tr.appendChild(roleTd);

    const setbackTd = document.createElement("td");
    setbackTd.className = "col-setback";
    const setbackInput = document.createElement("input");
    setbackInput.type = "number";
    setbackInput.step = "0.5";
    setbackInput.min = "0";
    setbackInput.value = feetToDisplay(0).toFixed(2);
    setbackInput.className = "setback-input";
    setbackTd.appendChild(setbackInput);
    tr.appendChild(setbackTd);

    const roadWidthTd = document.createElement("td");
    roadWidthTd.className = "col-road-width";
    const roadWidthInput = document.createElement("input");
    roadWidthInput.type = "number";
    roadWidthInput.step = "0.5";
    roadWidthInput.min = "0";
    roadWidthInput.value = "";
    roadWidthInput.placeholder = "NA";
    roadWidthInput.className = "road-width-input";
    roadWidthInput.disabled = true;
    roadWidthInput.addEventListener("input", () => drawPreview(currentVertices, lastBuildable));
    roadWidthInput.addEventListener("change", () => drawPreview(currentVertices, lastBuildable));
    roadWidthTd.appendChild(roadWidthInput);
    tr.appendChild(roadWidthTd);

    // Hidden (not just visually, the whole <td>) for Master Plan via CSS on `.col-neighbour-*`
    // keyed off `[data-tool="master"]` - a master-planned plot is being subdivided, not
    // conveyed against a named neighbour, so these fields don't apply there the way they do
    // for a real site plan. The inputs still exist in the DOM either way (readNeighbours()
    // just reads empty strings for Master Plan), so no other code needs to know the columns
    // are hidden.
    const neighbourNameTd = document.createElement("td");
    neighbourNameTd.className = "col-neighbour-name";
    const neighbourNameInput = document.createElement("input");
    neighbourNameInput.type = "text";
    neighbourNameInput.className = "neighbour-name-input";
    neighbourNameInput.placeholder = "e.g. Ajit Mandal";
    neighbourNameInput.addEventListener("input", () => drawPreview(currentVertices, lastBuildable));
    neighbourNameTd.appendChild(neighbourNameInput);
    tr.appendChild(neighbourNameTd);

    const neighbourPlotTd = document.createElement("td");
    neighbourPlotTd.className = "col-neighbour-plot";
    const neighbourPlotInput = document.createElement("input");
    neighbourPlotInput.type = "text";
    neighbourPlotInput.className = "neighbour-plot-input";
    neighbourPlotInput.placeholder = "e.g. 4738";
    neighbourPlotInput.addEventListener("input", () => drawPreview(currentVertices, lastBuildable));
    neighbourPlotTd.appendChild(neighbourPlotInput);
    tr.appendChild(neighbourPlotTd);

    roleSelect.addEventListener("change", () => {
      const isRoad = roleSelect.value === "road" || roleSelect.value === "front_road";
      roadWidthInput.disabled = !isRoad;
      if (isRoad && roadWidthInput.value === "") {
        roadWidthInput.value = feetToDisplay(20).toFixed(2);
      }
      neighbourNameInput.disabled = isRoad;
      neighbourPlotInput.disabled = isRoad;
      if (isRoad) {
        neighbourNameInput.value = "NA";
        neighbourPlotInput.value = "NA";
      } else {
        if (neighbourNameInput.value === "NA") neighbourNameInput.value = "";
        if (neighbourPlotInput.value === "NA") neighbourPlotInput.value = "";
      }
      drawPreview(currentVertices, lastBuildable);
    });

    edgeRowsEl.appendChild(tr);
  }

  // Every fresh side count starts life as its own regular polygon (frozen: diagonal
  // fields, if shown, are just seeded from it, not yet re-solved from user input).
  const lengths = readLengths();
  rawSolvedVertices = walkRegular(lengths, regularAngle);
  currentVertices = applyOrientation(rawSolvedVertices);
  buildDiagonalRows();
  drawPreview(currentVertices, lastBuildable);
  closureNoteEl.textContent = regularToggleEl.checked ? "Regular polygon - always closes exactly." : "";
  closureNoteEl.classList.remove("closure-error");
}

function diagonalSeedLength(fromIndex, toIndex) {
  if (currentVertices && currentVertices[fromIndex] && currentVertices[toIndex]) {
    const a = currentVertices[fromIndex], b = currentVertices[toIndex];
    return Math.hypot(b.x - a.x, b.y - a.y);
  }
  return displayToFeet(20);
}

function addDiagonalRow(defaultFrom, defaultTo, removable) {
  // defaultTo === null means "just pick the first valid target" - used by the Add Diagonal
  // button, where there's no particular vertex the new row is expected to connect to.
  // `removable` marks a diagonal added ON TOP of the N-3 that are actually needed to fully
  // determine the shape - over-specifying it, kept only because it happened to be an easier
  // measurement to take on site. Only those rows get a Remove button; the required rows
  // buildDiagonalRows() seeds can't be removed; removing one from a solved shape would leave
  // it under-determined again.
  const n = currentSideCount();
  const labels = labelsFor(n);
  const tr = document.createElement("tr");

  const fromTd = document.createElement("td");
  const fromSelect = document.createElement("select");
  fromSelect.className = "diagonal-from-select";
  populateDiagonalSelect(fromSelect, n, labels, new Set());
  fromSelect.value = String(defaultFrom);
  fromTd.appendChild(fromSelect);
  tr.appendChild(fromTd);

  const toTd = document.createElement("td");
  const toSelect = document.createElement("select");
  toSelect.className = "diagonal-to-select";
  toTd.appendChild(toSelect);
  tr.appendChild(toTd);
  populateDiagonalSelect(toSelect, n, labels, validDiagonalTargets(n, defaultFrom));
  if (defaultTo !== null && !validDiagonalTargets(n, defaultFrom).has(defaultTo)) {
    toSelect.value = String(defaultTo);
  }

  const inputTd = document.createElement("td");
  const input = document.createElement("input");
  input.type = "number";
  input.step = "0.01";
  input.min = "0.01";
  input.className = "diagonal-input";
  input.value = feetToDisplay(diagonalSeedLength(parseInt(fromSelect.value, 10), parseInt(toSelect.value, 10))).toFixed(2);
  inputTd.appendChild(input);
  tr.appendChild(inputTd);

  const reseed = () => {
    input.value = feetToDisplay(diagonalSeedLength(parseInt(fromSelect.value, 10), parseInt(toSelect.value, 10))).toFixed(2);
  };
  fromSelect.addEventListener("change", () => {
    populateDiagonalSelect(toSelect, n, labels, validDiagonalTargets(n, parseInt(fromSelect.value, 10)));
    reseed();
    rebuildCornerPlacementRows(); // which corners are ambiguous can change with the graph shape
    onDiagonalChanged();
  });
  toSelect.addEventListener("change", () => {
    reseed();
    rebuildCornerPlacementRows();
    onDiagonalChanged();
  });
  input.addEventListener("input", onDiagonalChanged);
  input.addEventListener("change", onDiagonalChanged);

  const removeTd = document.createElement("td");
  if (removable) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "secondary diagonal-remove-btn";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => {
      tr.remove();
      rebuildCornerPlacementRows();
      onDiagonalChanged();
    });
    removeTd.appendChild(removeBtn);
  }
  tr.appendChild(removeTd);

  diagonalRowsEl.appendChild(tr);
}

function buildDiagonalRows() {
  const n = currentSideCount();
  diagonalRowsEl.innerHTML = "";

  if (regularToggleEl.checked) {
    diagonalsTableEl.style.display = "none";
    diagonalAddBtnEl.style.display = "none";
    diagonalsNoteEl.textContent = "Not needed for a regular polygon - every diagonal follows automatically from the side length and vertex count.";
    rebuildCornerPlacementRows();
    return;
  }

  const count = diagonalCount(n);
  if (count === 0) {
    diagonalsTableEl.style.display = "none";
    diagonalAddBtnEl.style.display = "none";
    diagonalsNoteEl.textContent = "None needed - 3 sides alone fully determine a triangle.";
    rebuildCornerPlacementRows();
    return;
  }

  diagonalsNoteEl.textContent =
    `${count} diagonal(s) needed to fully determine this ${n}-sided shape - seeded below from ` +
    `corner A, matching the shape currently shown. Change which corners a diagonal connects with ` +
    `the dropdowns, or use "Add diagonal" for an extra one if that's easier to measure on site.`;
  diagonalsTableEl.style.display = ""; // "" not "table": Master Plan restyles these as a
  // two-column grid (see style.css), and an inline display:table would override it.
  diagonalAddBtnEl.style.display = "inline-block";

  for (let k = 2; k <= n - 2; k++) {
    addDiagonalRow(0, k);
  }
  rebuildCornerPlacementRows();
}

// Rebuilds the Corner placement list from the CURRENT diagonal graph topology (side count +
// which corners each diagonal connects) - never from the actual length values, so this only
// needs re-running when that topology changes (sides count, regular toggle, a diagonal's own
// from/to, or one being added/removed), not on every length keystroke. Existing choices for
// corners that are still ambiguous are preserved; a select is rebuilt either way since the
// underlying DOM row is always fresh, but its value is restored from `cornerChoices`.
function rebuildCornerPlacementRows() {
  const n = currentSideCount();
  const diagonalSpecs = regularToggleEl.checked ? [] : readDiagonalSpecs();
  const freeInfo = regularToggleEl.checked ? [] : computeFreeCorners(n, diagonalSpecs);

  // Corners no longer ambiguous (or no longer existing) shouldn't keep a stale pin around.
  const stillFree = new Set(freeInfo.map((info) => info.label));
  Object.keys(cornerChoices).forEach((label) => { if (!stillFree.has(label)) delete cornerChoices[label]; });

  cornerPlacementRowsEl.innerHTML = "";
  if (!freeInfo.length) {
    cornerPlacementTableEl.style.display = "none";
    cornerPlacementNoteEl.textContent = regularToggleEl.checked
      ? "Not needed for a regular polygon - every corner follows automatically."
      : "No ambiguous corners with the current diagonals - each one is fully pinned by its own two reference distances.";
    return;
  }

  cornerPlacementNoteEl.textContent =
    "Distance alone can't say which side of two reference corners a corner actually sits on - " +
    "leave \"Auto\" to let the drawing decide (it avoids a self-crossing shape automatically, " +
    "and warns when it had to guess), or set one directly if you already know which side matches your site.";
  cornerPlacementTableEl.style.display = ""; // "" not "table": Master Plan restyles these as a
  // two-column grid (see style.css), and an inline display:table would override it.

  freeInfo.forEach(({ label, i1Label, i2Label }) => {
    const tr = document.createElement("tr");
    // One cell, one font: "L with respect to AB" reads as a sentence, where a bold corner letter
    // beside a separate muted "using A, B" read as two unrelated columns.
    const cornerTd = document.createElement("td");
    cornerTd.className = "corner-ref-cell";
    cornerTd.textContent = `${label} with respect to ${i1Label}${i2Label}`;
    tr.appendChild(cornerTd);
    const selectTd = document.createElement("td");
    const select = document.createElement("select");
    select.className = "corner-bulge-select";
    select.innerHTML =
      `<option value="auto">Auto</option>` +
      `<option value="left">Left of ${i1Label}→${i2Label}</option>` +
      `<option value="right">Right of ${i1Label}→${i2Label}</option>`;
    select.value = cornerChoices[label] || "auto";
    select.addEventListener("change", () => {
      if (select.value === "auto") delete cornerChoices[label];
      else cornerChoices[label] = select.value;
      resolveAndRedraw();
    });
    selectTd.appendChild(select);
    tr.appendChild(selectTd);
    cornerPlacementRowsEl.appendChild(tr);
  });
}

// Clears the step message area, but only if it's currently showing the "auto-fixed a
// self-crossing shape" note from a previous solve - never an unrelated message that happens to
// be showing (e.g. from a Compute area click), which resolveAndRedraw() has no business erasing.
function clearAutofixNoteIfShown() {
  if (messageAreaEl.dataset.autofixNote === "1") {
    clearMessage();
    delete messageAreaEl.dataset.autofixNote;
  }
}

// Reflects point p across the infinite line through a and b (not just the segment) - the
// standard "project onto the line, then go the same distance again on the other side" formula.
function reflectAcrossLine(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy || 1;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  const qx = a.x + t * dx, qy = a.y + t * dy;
  return { x: 2 * qx - p.x, y: 2 * qy - p.y };
}

// Mirror reflects the resolved shape across whichever of its own edges is chosen in
// `mirrorEdgeSelectEl` (A-B by default) - both endpoints of that edge stay exactly where they
// are, everything else flips to the other side. Rotate then spins the result around A, which
// stays pinned at the origin throughout, easy to reason about and to keep in sync with anything
// else built from `currentVertices` (Road Logic's edge/side references are plain array indices,
// unaffected by either transform). Both are pure functions of the current toggle/field state,
// applied fresh every time from the untouched solve - never accumulated onto an already-
// transformed shape - so flipping Mirror on and off, changing its edge, or changing the
// rotation value, can never drift or double up.
function applyOrientation(vertices) {
  if (!vertices || !vertices.length) return vertices;
  let pts = vertices;
  if (mirrorEnabled) {
    const n = vertices.length;
    const edgeIdx = ((parseInt(mirrorEdgeSelectEl.value, 10) || 0) % n + n) % n;
    const a = vertices[edgeIdx], b = vertices[(edgeIdx + 1) % n];
    pts = pts.map((v) => reflectAcrossLine(v, a, b));
  }
  const deg = parseFloat(rotationOrientationInputEl.value) || 0;
  if (deg % 360 !== 0) {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    pts = pts.map((v) => ({ x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos }));
  }
  return pts;
}

// /compute-site reconstructs the plot server-side from (lengths, interior angles) via a fixed
// left-turn walk (site_geometry.vertices_from_edges) - and mirroring a shape never changes any
// of its interior angles, so that data cannot say which of the two possible chiralities is the
// real one. Confirmed empirically: for a client shape solved CW, the server came back as the
// exact Y-mirror (identical x, negated y at every vertex) of it. Left uncorrected, the
// buildable-area polygon computed from that reconstruction would come back mirrored relative
// to the actual plot boundary it's meant to sit inside - lining it up against the RAW
// (pre-Mirror/Rotate) client solve, before the user's own chosen orientation is re-applied on
// top, is what keeps the two always agreeing.
function alignServerChirality(serverVertices, reference) {
  if (!serverVertices || !reference || !reference.length) return serverVertices;
  const same = (signedArea(serverVertices) >= 0) === (signedArea(reference) >= 0);
  return same ? serverVertices : serverVertices.map((v) => ({ x: v.x, y: -v.y }));
}

function resolveAndRedraw() {
  const n = currentSideCount();
  const lengths = readLengths();
  const regularAngle = ((n - 2) * 180) / n;

  if (regularToggleEl.checked) {
    rawSolvedVertices = walkRegular(lengths, regularAngle);
    currentVertices = applyOrientation(rawSolvedVertices);
    closureNoteEl.textContent = "Regular polygon - always closes exactly.";
    closureNoteEl.classList.remove("closure-error");
    clearAutofixNoteIfShown(); // a regular polygon has no diagonals, so no crossing risk at all
    drawPreview(currentVertices, lastBuildable);
    return;
  }

  const diagonalSpecs = readDiagonalSpecs();
  const result = solveFromDiagonalGraph(lengths, diagonalSpecs, cornerChoices);
  if (!result.ok) {
    showError(result.error);
    closureNoteEl.textContent = "Could not solve a closed shape - see the message above.";
    closureNoteEl.classList.add("closure-error");
    return; // keep showing the last valid currentVertices, don't blank the preview
  }
  clearError();
  rawSolvedVertices = result.vertices;
  currentVertices = applyOrientation(rawSolvedVertices);
  if (result.autoFixedCrossing) {
    // Every side/diagonal length is exactly as entered - the solver just had to pick a
    // different (still fully consistent) mirror image at one or more corners to keep the
    // boundary from crossing itself. Worth flagging as a warning, not silently absorbing it,
    // since the corner in question could still land on the wrong side of your actual site. Name
    // exactly which corners were guessed (never one the user already pinned, see
    // solveFromDiagonalGraph's `autoFixedLabels`) so there's a specific, actionable next step -
    // check those rows in Corner placement, not "somewhere in this drawing".
    closureNoteEl.textContent =
      "Closes exactly - an alternate corner placement was used automatically to avoid a self-crossing shape.";
    closureNoteEl.classList.remove("closure-error");
    const guessedList = (result.autoFixedLabels || []).join(", ");
    setMessage(
      `An alternate corner placement was used automatically to avoid a self-crossing shape - ` +
      `distance alone can't tell which side of a diagonal the boundary actually bulges to. ` +
      `Guessed corner(s): ${guessedList || "unknown"}. If the drawing doesn't match your site, ` +
      `set the correct side directly for one of them in Corner placement below.`,
      "warning",
    );
    messageAreaEl.dataset.autofixNote = "1";
  } else {
    closureNoteEl.textContent = "Closes exactly (solved from your side lengths and diagonals).";
    closureNoteEl.classList.remove("closure-error");
    clearAutofixNoteIfShown();
  }
  drawPreview(currentVertices, lastBuildable);
}

function onLengthChanged() {
  if (regularToggleEl.checked) {
    const rows = Array.from(edgeRowsEl.querySelectorAll("tr"));
    const first = rows[0].querySelector(".length-input").value;
    rows.forEach((r, i) => { if (i > 0) r.querySelector(".length-input").value = first; });
  }
  resolveAndRedraw();
}

function onDiagonalChanged() {
  resolveAndRedraw();
}

function sqFeetToDisplayArea(sqft) {
  return currentUnit === "m" ? sqft / (FT_PER_M * FT_PER_M) : sqft;
}

function areaUnitLabel() {
  return currentUnit === "m" ? "sq m" : "sq ft";
}

function kathaChatakText(sqft) {
  // Katha/Chatak are areal units (fixed sq-ft definitions), independent of the ft/m
  // display toggle above - West Bengal/Bangladesh convention: 1 Katha = 720 sq ft,
  // 20 Chatak = 1 Katha, matching the reference sketch map's own "3 KATHA. 8 CHH" style.
  const katha = Math.floor(sqft / SQFT_PER_KATHA);
  const remainder = sqft - katha * SQFT_PER_KATHA;
  const chatak = Math.floor(remainder / SQFT_PER_CHATAK);
  return `${katha} Katha ${chatak} Chatak`;
}

function updateAreaSummary(plotVertices) {
  if (!plotVertices || plotVertices.length < 3) {
    areaSummaryEl.style.display = "none";
    return;
  }
  const n = plotVertices.length;
  const labels = labelsFor(n);
  const totalSqft = polygonArea(plotVertices);
  const au = areaUnitLabel();
  const lines = [
    `<strong>Total plot area:</strong> ${sqFeetToDisplayArea(totalSqft).toFixed(1)} ${au} (${kathaChatakText(totalSqft)})`,
  ];
  if (lastBuildableAreaSqft != null) {
    lines.push(
      `<strong>Total buildable area:</strong> ${sqFeetToDisplayArea(lastBuildableAreaSqft).toFixed(1)} ${au} ` +
      `(${kathaChatakText(lastBuildableAreaSqft)})`
    );
  }
  const triParts = [];
  for (let k = 1; k <= n - 2; k++) {
    const area = triangleArea(plotVertices[0], plotVertices[k], plotVertices[k + 1]);
    triParts.push(`${labels[0]}-${labels[k]}-${labels[k + 1]} = ${sqFeetToDisplayArea(area).toFixed(1)} ${au}`);
  }
  lines.push(`<strong>Triangle areas</strong> (fan from ${labels[0]}): ${triParts.join(", ")}`);
  areaSummaryEl.style.display = "block";
  areaSummaryEl.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
}

function buildPlotSvg(plotVertices, options) {
  const showVertices = !options || options.showVertices !== false;
  const showDiagonals = !options || options.showDiagonals !== false;
  // The finalized site plan and its PDF export want a clean, ink-only presentation drawing
  // (matching a real surveyor's sheet) rather than the color-coded working view every other
  // caller of this function still wants (green length labels stand out against colored plot
  // fills elsewhere) - monochrome swaps just that one non-neutral color for the same near-black
  // used everywhere else in the drawing.
  const monochrome = !!(options && options.monochrome);
  const lengthLabelColor = monochrome ? "#1f2430" : "#2f6f4f";
  // Everything about the plot presentation EXCEPT the buildable-area overlay (drawPreview
  // adds that on top for the live working view; the finalised site plan deliberately
  // omits it) - shared so the two displays can never drift apart. Roads extend outside
  // the plot boundary, so their outer corners must be included in the bounding box the
  // transform is built from - otherwise a road band gets clipped off the edge of the SVG
  // canvas.
  let roadSegments = [];
  {
    const ccw = signedArea(plotVertices) > 0;
    readOuterRoads().forEach(({ edgeIndex: i, width, extension, frontRoad }) => {
      if (i >= plotVertices.length) return;
      const v = plotVertices[i];
      const next = plotVertices[(i + 1) % plotVertices.length];
      const dx = next.x - v.x, dy = next.y - v.y;
      const elen = Math.hypot(dx, dy) || 1;
      const ux = dx / elen, uy = dy / elen; // unit vector along the edge
      const nrm = ccw ? { x: uy, y: -ux } : { x: -uy, y: ux }; // outward normal
      // Extend both ends past the vertices by the same amount - a road doesn't stop at
      // the plot corner, it keeps going both directions in real life.
      const extV = { x: v.x - ux * extension, y: v.y - uy * extension };
      const extNext = { x: next.x + ux * extension, y: next.y + uy * extension };
      const outerA = { x: extV.x + nrm.x * width, y: extV.y + nrm.y * width };
      const outerB = { x: extNext.x + nrm.x * width, y: extNext.y + nrm.y * width };
      roadSegments.push({
        v: extV, next: extNext, outerA, outerB, width,
        along: { x: ux, y: uy }, extension, frontRoad,
      });
    });
  }

  const boundsVertices = plotVertices.concat(
    roadSegments.flatMap((r) => [r.outerA, r.outerB])
  );
  const transform = svgTransformFor(boundsVertices);
  const labels = labelsFor(plotVertices.length);
  const centroid = centroidOf(plotVertices);
  const xs = plotVertices.map((v) => v.x), ys = plotVertices.map((v) => v.y);
  const diagonalSpan = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1;
  const nudge = diagonalSpan * 0.07;

  let svg = "";

  // Roads, drawn first (as a band outside the plot boundary) so the plot outline and
  // everything else layers cleanly on top of it. Each road is extended past both plot
  // vertices (a real road doesn't stop at the property corner) and capped with a
  // conventional break-line zigzag where the drawing itself is cut off.
  function breakLinePoints(base, normal, width, along) {
    const jitter = width * 0.18;
    return [
      base,
      { x: base.x + normal.x * width * 0.35 + along.x * jitter, y: base.y + normal.y * width * 0.35 + along.y * jitter },
      { x: base.x + normal.x * width * 0.65 - along.x * jitter, y: base.y + normal.y * width * 0.65 - along.y * jitter },
      { x: base.x + normal.x * width, y: base.y + normal.y * width },
    ];
  }

  roadSegments.forEach((r) => {
    const pv = transform(r.v), pn = transform(r.next), poA = transform(r.outerA), poB = transform(r.outerB);
    svg += `<polygon points="${pv.x.toFixed(1)},${pv.y.toFixed(1)} ${pn.x.toFixed(1)},${pn.y.toFixed(1)} ` +
      `${poB.x.toFixed(1)},${poB.y.toFixed(1)} ${poA.x.toFixed(1)},${poA.y.toFixed(1)}" ` +
      `fill="none" stroke="#8d949e" stroke-width="1" />`;

    if (r.extension > 0) {
      const nrmVec = { x: (r.outerA.x - r.v.x) / r.width, y: (r.outerA.y - r.v.y) / r.width };
      [
        { base: r.v, along: { x: -r.along.x, y: -r.along.y } },
        { base: r.next, along: r.along },
      ].forEach(({ base, along }) => {
        const pts = breakLinePoints(base, nrmVec, r.width, along).map(transform);
        const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
        svg += `<path d="${d}" fill="none" stroke="#5b6169" stroke-width="1.4" />`;
      });
    }

    const mid = { x: (r.v.x + r.next.x + r.outerA.x + r.outerB.x) / 4, y: (r.v.y + r.next.y + r.outerA.y + r.outerB.y) / 4 };
    const pMid = transform(mid);
    const roadWidthDisp = `${feetToDisplay(r.width).toFixed(0)} ${unitLabel()}`;
    const label = r.frontRoad ? `ROAD (${roadWidthDisp}) - FRONT` : `ROAD (${roadWidthDisp})`;
    svg += `<text x="${pMid.x.toFixed(1)}" y="${pMid.y.toFixed(1)}" font-size="10.5" font-weight="700" ` +
      `fill="#5b6169" text-anchor="middle" dominant-baseline="middle">${label}</text>`;
  });

  svg += `<polygon points="${polygonPoints(transform, plotVertices)}" fill="none" stroke="#1f2430" stroke-width="2" />`;

  // Diagonals, red dotted, only meaningful in non-regular mode - drawn from whatever pairs
  // are actually configured in the diagonals table now (any corner to any corner), not
  // assumed to always start from A.
  if (showDiagonals && !regularToggleEl.checked && plotVertices.length >= 4) {
    Array.from(diagonalRowsEl.querySelectorAll("tr")).forEach((tr) => {
      const fromSelect = tr.querySelector(".diagonal-from-select");
      const toSelect = tr.querySelector(".diagonal-to-select");
      if (!fromSelect || !toSelect) return;
      const fi = parseInt(fromSelect.value, 10), ti = parseInt(toSelect.value, 10);
      if (fi === ti || !(fi in plotVertices) || !(ti in plotVertices)) return;
      const Vi = plotVertices[fi], Vj = plotVertices[ti];
      const pVi = transform(Vi), pVj = transform(Vj);
      const length = Math.hypot(Vj.x - Vi.x, Vj.y - Vi.y);
      svg += `<line x1="${pVi.x.toFixed(1)}" y1="${pVi.y.toFixed(1)}" x2="${pVj.x.toFixed(1)}" y2="${pVj.y.toFixed(1)}" stroke="#c0392b" stroke-width="1.4" stroke-dasharray="3,3" />`;
      const mid = { x: (Vi.x + Vj.x) / 2, y: (Vi.y + Vj.y) / 2 };
      const dx = mid.x - centroid.x, dy = mid.y - centroid.y;
      const dlen = Math.hypot(dx, dy) || 1;
      const labelPoint = { x: mid.x + (dx / dlen) * (nudge * 0.6), y: mid.y + (dy / dlen) * (nudge * 0.6) };
      const pLabel = transform(labelPoint);
      svg += `<text x="${pLabel.x.toFixed(1)}" y="${pLabel.y.toFixed(1)}" font-size="11.5" font-weight="600" ` +
        `fill="#c0392b" text-anchor="middle" dominant-baseline="middle">${feetToDisplay(length).toFixed(2)} ${unitLabel()}</text>`;
    });
  }

  const rowsMatch = edgeRowsEl.children.length === plotVertices.length;
  const edgeRoles = rowsMatch ? readRoleSetback().roles : plotVertices.map(() => null);
  const neighbourData = rowsMatch ? readNeighbours() : { names: [], plots: [] };
  const neighbourNames = neighbourData.names, neighbourPlots = neighbourData.plots;

  // Master Plan has no Neighbour name/Plot no. columns (see buildEdgeRows) - a master-planned
  // boundary is being subdivided, not conveyed against a named adjoining owner - so nothing
  // else wants the space just outside the boundary there. Its length labels move out to that
  // space, matching a real subdivision/dimensioned-plan convention of setting dimensions
  // outside the shape rather than crowding them inside one that's about to be full of
  // sub-section and plot detail. Site Plan is unchanged: length stays inside, neighbour info
  // (when entered) sits outside.
  const lengthOutside = toolKey === "master";

  plotVertices.forEach((v, i) => {
    const next = plotVertices[(i + 1) % plotVertices.length];
    const length = Math.hypot(next.x - v.x, next.y - v.y);
    const mid = { x: (v.x + next.x) / 2, y: (v.y + next.y) / 2 };
    const dx = mid.x - centroid.x, dy = mid.y - centroid.y;
    const dlen = Math.hypot(dx, dy) || 1;

    const insidePoint = { x: mid.x - (dx / dlen) * nudge, y: mid.y - (dy / dlen) * nudge };
    const outsidePoint = { x: mid.x + (dx / dlen) * nudge, y: mid.y + (dy / dlen) * nudge };
    const pLength = transform(lengthOutside ? outsidePoint : insidePoint);
    const pv = transform(v), pn = transform(next);
    const screenLen = Math.hypot(pn.x - pv.x, pn.y - pv.y);
    let angleDeg = (Math.atan2(pn.y - pv.y, pn.x - pv.x) * 180) / Math.PI;
    if (angleDeg > 90 || angleDeg < -90) angleDeg += 180; // keep text upright/readable

    // Font size scales with the side's own on-screen length, not a fixed size - a short side
    // gets small text instead of overlapping its neighbours' labels, a long side gets bigger,
    // clearer text, the same rule fontSizeForEdgeText already applies to every other edge label
    // in this drawing (neighbour text below, diagonal/plot labels elsewhere).
    const lengthText = `${feetToDisplay(length).toFixed(2)} ${unitLabel()}`;
    const lengthFontSize = fontSizeForEdgeText(screenLen, lengthText.length, 6.5, 12);
    svg += `<text x="${pLength.x.toFixed(1)}" y="${pLength.y.toFixed(1)}" font-size="${lengthFontSize.toFixed(1)}" font-weight="600" ` +
      `fill="${lengthLabelColor}" text-anchor="middle" dominant-baseline="middle" ` +
      `transform="rotate(${angleDeg.toFixed(1)} ${pLength.x.toFixed(1)} ${pLength.y.toFixed(1)})">${lengthText}</text>`;

    // Neighbour name/plot: outside the polygon, only for non-road edges that have something
    // entered - never reachable for Master Plan (its neighbour inputs are hidden and stay
    // empty), and would collide with the length label there if it ever were, since Master
    // Plan's length label now sits at this same outside spot.
    if (!lengthOutside && !isRoadRole(edgeRoles[i]) && (neighbourNames[i] || neighbourPlots[i])) {
      const pOutside = transform(outsidePoint);
      const parts = [];
      if (neighbourNames[i]) parts.push(neighbourNames[i]);
      if (neighbourPlots[i]) parts.push(`P-${neighbourPlots[i]}`);
      const neighbourText = parts.join(" ");
      const neighbourFontSize = fontSizeForEdgeText(screenLen, neighbourText.length, 6, 11);
      svg += `<text x="${pOutside.x.toFixed(1)}" y="${pOutside.y.toFixed(1)}" font-size="${neighbourFontSize.toFixed(1)}" font-weight="600" ` +
        `fill="#333333" text-anchor="middle" dominant-baseline="middle" ` +
        `transform="rotate(${angleDeg.toFixed(1)} ${pOutside.x.toFixed(1)} ${pOutside.y.toFixed(1)})">${neighbourText}</text>`;
    }
  });

  if (showVertices) {
    plotVertices.forEach((v, i) => {
      const p = transform(v);
      svg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#1f2430" />`;
      svg += `<text x="${(p.x + 8).toFixed(1)}" y="${(p.y - 8).toFixed(1)}" font-size="13" font-weight="700" fill="#1f2430">${labels[i]}</text>`;
    });
  }

  return { svg, transform };
}

// Draws every finalized internal road (from Road logic) as a true-to-scale band - the
// carriageway itself (solid) plus, when a buffer is set, a lighter fringe on both sides for
// the extra clearance /compute-subsections also carves out of the sub-sections beyond the
// road's own width. Previously roads were drawn as a flat 5px line regardless of their real
// width, so the genuine to-scale gap Plot Logic leaves around a road (which is just the
// road's own width) looked like an unexplained mystery buffer with no way to control it.
// Offsets every point of a polyline perpendicular to it by a fixed distance h, using the
// averaged normal of a point's two adjacent segments at interior points (the standard
// mitred-offset construction) - for a plain 2-point straight path this reduces to exactly the
// single-segment-normal quad this function used to hand-build, so straight roads are unaffected.
function offsetPolyline(path, h) {
  const segCount = path.length - 1;
  const segNormals = [];
  for (let i = 0; i < segCount; i++) {
    const dx = path[i + 1].x - path[i].x, dy = path[i + 1].y - path[i].y;
    const len = Math.hypot(dx, dy) || 1;
    segNormals.push({ x: -dy / len, y: dx / len });
  }
  return path.map((p, i) => {
    let nx, ny;
    if (i === 0) { nx = segNormals[0].x; ny = segNormals[0].y; }
    else if (i === path.length - 1) { nx = segNormals[segCount - 1].x; ny = segNormals[segCount - 1].y; }
    else {
      nx = segNormals[i - 1].x + segNormals[i].x;
      ny = segNormals[i - 1].y + segNormals[i].y;
      const l = Math.hypot(nx, ny) || 1;
      nx /= l; ny /= l;
    }
    return { x: p.x + nx * h, y: p.y + ny * h };
  });
}

function internalRoadBandSvg(transform, monochrome) {
  const roadColor = monochrome ? "#5b6169" : "#7d5ba6";
  let svg = "";
  (roads || []).forEach((r) => {
    if (!r) return;
    const path = r.path && r.path.length >= 2 ? r.path : [r.start, r.end];
    const half = r.width / 2;
    const buffer = r.buffer || 0;
    const bandPoints = (h) => {
      const left = offsetPolyline(path, h);
      const right = offsetPolyline(path, -h).slice().reverse();
      return left.concat(right).map(transform).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    };
    if (buffer > 0) {
      svg += `<polygon points="${bandPoints(half + buffer)}" fill="${roadColor}" opacity="0.15" stroke="none" />`;
    }
    svg += `<polygon points="${bandPoints(half)}" fill="${roadColor}" opacity="${monochrome ? 0.35 : 0.55}" stroke="none" />`;
  });
  return svg;
}

function drawPreview(plotVertices, buildableVertices) {
  const { svg: baseSvg, transform } = buildPlotSvg(plotVertices);
  let svg = baseSvg;

  if (buildableVertices && buildableVertices.length >= 3) {
    svg += `<polygon points="${polygonPoints(transform, buildableVertices)}" fill="none" stroke="#999999" stroke-width="1.5" stroke-dasharray="6,4" />`;
  }

  // Any roads already laid out in Road Logic - shown here too so the site plan itself
  // reflects the master plan, not just the Road Logic/Plot Logic cards further down.
  svg += internalRoadBandSvg(transform);

  svgEl.innerHTML = svg;
  updateAreaSummary(plotVertices);
}

function renderFinalSitePlan() {
  if (!currentVertices) return;
  // Once roads/plots exist, the finalized, orientable presentation should show the actual
  // master plan (sub-sections, real/fill plots) rather than just the bare site boundary - the
  // same content "Final master plan" already shows, just rotatable to true north here.
  const { svg: content, transform } = hasMasterPlanContent()
    ? buildMasterPlanContentSvg({ showVertices: false, showDiagonals: false, monochrome: true, monochromePlots: true })
    : buildPlotSvg(currentVertices, { showVertices: false, showDiagonals: false, monochrome: true });
  const rotation = ((parseFloat(rotationInputEl.value) || 0) % 360 + 360) % 360;
  // Pivot on the drawing's own screen-space center (not the viewBox's own center) - the
  // shape doesn't necessarily fill/center within the viewBox on its own, so rotating
  // around a fixed point can otherwise send it sliding off to one side.
  const screenPts = currentVertices.map(transform);
  const xs = screenPts.map((p) => p.x), ys = screenPts.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  finalSvgEl.innerHTML = `<g transform="rotate(${rotation} ${cx.toFixed(1)} ${cy.toFixed(1)})">${content}</g>`;
  // North indicator is constant - it never rotates. The point of the rotation control is
  // to turn the DRAWING until its true north lines up with this fixed arrow, exactly like
  // a real site plan sheet where north is a fixed reference and the site is oriented to it.
}

// Deliberately roomy - big enough that the drawing never clips at any rotation angle.
// The north arrow used to be baked into this same image at a fixed corner, but that
// meant trimming down to "just the drawing" also had to stretch all the way out to
// wherever the arrow sat, undoing the trim. The arrow is now drawn separately, straight
// into the PDF with jsPDF's own vector calls (see drawNorthArrowPdf) - this SVG only
// ever needs to contain the rotated drawing itself.
const EXPORT_VIEWBOX = { minX: -250, minY: -250, w: 1100, h: 920 };

function buildExportSvg() {
  if (!currentVertices) return null;
  // Same fallback as renderFinalSitePlan() - the Print Sheet should embed the real master plan
  // once one exists, not just the bare boundary "Final site plan" shows before roads/plots do.
  const { svg: content, transform } = hasMasterPlanContent()
    ? buildMasterPlanContentSvg({ showVertices: false, showDiagonals: false, monochrome: true, monochromePlots: true })
    : buildPlotSvg(currentVertices, { showVertices: false, showDiagonals: false, monochrome: true });
  const rotation = ((parseFloat(rotationInputEl.value) || 0) % 360 + 360) % 360;
  const screenPts = currentVertices.map(transform);
  const xs = screenPts.map((p) => p.x), ys = screenPts.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const rotated = `<g transform="rotate(${rotation} ${cx.toFixed(1)} ${cy.toFixed(1)})">${content}</g>`;

  const vb = `${EXPORT_VIEWBOX.minX} ${EXPORT_VIEWBOX.minY} ${EXPORT_VIEWBOX.w} ${EXPORT_VIEWBOX.h}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">` +
    `<rect x="${EXPORT_VIEWBOX.minX}" y="${EXPORT_VIEWBOX.minY}" width="${EXPORT_VIEWBOX.w}" height="${EXPORT_VIEWBOX.h}" fill="#ffffff" />` +
    `${rotated}</svg>`;
}

function trimCanvasToContent(canvas, paddingPx) {
  // The source canvas is mostly blank margin (see EXPORT_VIEWBOX above) - crop down to
  // the actual drawn content's own bounding box so the PDF doesn't end up embedding a
  // small drawing lost inside a huge white image.
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = rowStart + x * 4;
      const a = data[i + 3];
      if (a < 10) continue;
      if (data[i] > 250 && data[i + 1] > 250 && data[i + 2] > 250) continue; // near-white background
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return canvas; // nothing found - return unchanged rather than error
  const pad = paddingPx || 0;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const cropW = maxX - minX + 1, cropH = maxY - minY + 1;
  const cropped = document.createElement("canvas");
  cropped.width = cropW;
  cropped.height = cropH;
  const cctx = cropped.getContext("2d");
  cctx.fillStyle = "#ffffff";
  cctx.fillRect(0, 0, cropW, cropH);
  cctx.drawImage(canvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
  return cropped;
}

function svgToTrimmedPng(svgString, pxWidth, pxHeight) {
  return new Promise((resolve, reject) => {
    const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = pxWidth;
      canvas.height = pxHeight;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, pxWidth, pxHeight);
      ctx.drawImage(img, 0, 0, pxWidth, pxHeight);
      URL.revokeObjectURL(url);
      const trimmed = trimCanvasToContent(canvas, Math.round(pxWidth * 0.015));
      resolve({ dataUrl: trimmed.toDataURL("image/png"), width: trimmed.width, height: trimmed.height });
    };
    img.onerror = (err) => { URL.revokeObjectURL(url); reject(err); };
    img.src = url;
  });
}

function drawNorthArrowPdf(doc, x, y, size) {
  // Drawn with jsPDF's own vector primitives, independent of the (trimmed) drawing
  // image - a fixed graphic near the top of the sheet, matching the reference sketch
  // map's own small standalone north arrow.
  const half = size / 2;
  doc.setDrawColor(0);
  doc.setFillColor(0, 0, 0);
  doc.setLineWidth(0.6);
  doc.line(x, y + half, x, y - half * 0.3);
  doc.triangle(x - half * 0.35, y - half * 0.3, x + half * 0.35, y - half * 0.3, x, y - half, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text("N", x, y - half - 2, { align: "center" });
}

function readImageAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function imageFormatFromDataUrl(dataUrl) {
  const match = /^data:image\/(\w+);/.exec(dataUrl);
  if (!match) return "PNG";
  const type = match[1].toUpperCase();
  return type === "JPG" ? "JPEG" : type;
}

function scaleText(label, toScaleRadio, xInput, yInput) {
  const x = xInput.value.trim(), y = yInput.value.trim();
  if (!toScaleRadio.checked || !x || !y) return `${label}: NOT TO SCALE`;
  return `${label}: SCALE ${x}:${y}`;
}

function buildHeaderText() {
  const adminType = adminTypeSelectEl.value.toUpperCase();
  const adminName = adminNameInputEl.value.trim();
  const wardNo = wardNoInputEl.value.trim();
  const rsKhatian = rsKhatianInputEl.value.trim();
  const rsPlot = rsPlotInputEl.value.trim();
  const csPlot = csPlotInputEl.value.trim();
  const notes = additionalNotesInputEl.value.trim();

  const lines = ["SKETCH MAP & SITE PLAN OF THE LAND WITHIN-"];

  const underParts = [`UNDER- ${adminName ? adminName + " " : ""}${adminType}`];
  if (wardNo) underParts.push(`WARD NO-${wardNo}`);
  lines.push(underParts.join(", "));

  const plotParts = [];
  if (rsKhatian) plotParts.push(`R.S KHATIAN NO- ${rsKhatian}`);
  if (rsPlot) plotParts.push(`R.S PLOT NO- ${rsPlot}`);
  if (plotParts.length) lines.push(plotParts.join(", "));
  if (csPlot) lines.push(`C.S PLOT NO - ${csPlot}`);

  if (notes) lines.push(notes);

  return lines.join("\n");
}

async function generatePdf() {
  if (!currentVertices) {
    pdfNoteEl.textContent = "No site plan to render yet - build a shape above first.";
    return null;
  }
  const svgString = buildExportSvg();
  const sitePlan = await svgToTrimmedPng(svgString, 1600, Math.round(1600 * EXPORT_VIEWBOX.h / EXPORT_VIEWBOX.w));

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  // Outer sheet border, matching the reference sketch map's own framed page.
  const borderInset = 4;
  doc.setLineWidth(0.4);
  doc.rect(borderInset, borderInset, pageW - borderInset * 2, pageH - borderInset * 2);

  const margin = borderInset + 6;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  const headerText = buildHeaderText() || "SITE PLAN";
  const headerLines = doc.splitTextToSize(headerText, pageW * 0.5);
  doc.text(headerLines, margin, margin + 5);

  drawNorthArrowPdf(doc, pageW - margin - 60, margin + 10, 14);

  let mouzaLeftEdge = pageW - margin; // no mouza map -> nothing to stay clear of
  if (mouzaMapDataUrl) {
    const mapSize = 45;
    const mapX = pageW - margin - mapSize;
    const mapY = margin + 22;
    doc.addImage(mouzaMapDataUrl, imageFormatFromDataUrl(mouzaMapDataUrl), mapX, mapY, mapSize, mapSize);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.text("MOUZA MAP", mapX + mapSize / 2, mapY + mapSize + 4, { align: "center" });
    doc.text(scaleText("SCALE", mouzaScaleToScaleEl, mouzaScaleXEl, mouzaScaleYEl), mapX + mapSize / 2, mapY + mapSize + 8, { align: "center" });
    mouzaLeftEdge = mapX - 8;
  }

  // Footer zone (divider + signatures + drawn-by block) gets a fixed, generous height
  // reserved from the bottom of the FRAME (not the page edge) so nothing in it can ever
  // overlap or spill past the border - this is what was happening before: the vendor
  // signature line sat below the frame's own bottom edge, right on top of its stroke.
  const footerH = 26;
  const stripY = pageH - borderInset - footerH;
  const scaleBoxH = 12;
  const scaleBoxY = stripY - scaleBoxH - 6;

  // The mouza map sits in the top-right CORNER, not spanning the drawing's own column
  // on the left - it only needs to be kept clear of horizontally (drawingW), not waited
  // out vertically. Making drawingTop wait for the map's bottom edge (as before) wasted
  // a large chunk of the page's height for no real reason, capping how big the drawing
  // could render even though nothing was actually going to overlap it.
  const drawingTop = Math.max(margin + headerLines.length * 5 + 8, 40);
  const drawingBottom = scaleBoxY - 6;
  const drawingH = drawingBottom - drawingTop;
  const drawingW = mouzaLeftEdge - margin;
  const imgAspect = sitePlan.width / sitePlan.height;
  let renderW = drawingW, renderH = renderW / imgAspect;
  if (renderH > drawingH) { renderH = drawingH; renderW = renderH * imgAspect; }
  // Centered within its own allocated area (both axes), rather than pinned to a corner.
  const renderX = margin + (drawingW - renderW) / 2;
  const renderY = drawingTop + (drawingH - renderH) / 2;
  doc.addImage(sitePlan.dataUrl, "PNG", renderX, renderY, renderW, renderH);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  const scaleLines = [
    scaleText("SKETCH MAP", sketchScaleToScaleEl, sketchScaleXEl, sketchScaleYEl),
    scaleText("SITE PLAN", siteScaleToScaleEl, siteScaleXEl, siteScaleYEl),
  ];
  const scaleBoxW = Math.max(...scaleLines.map((t) => doc.getTextWidth(t))) + 6;
  doc.rect(margin, scaleBoxY, scaleBoxW, scaleBoxH);
  doc.text(scaleLines[0], margin + 3, scaleBoxY + 5);
  doc.text(scaleLines[1], margin + 3, scaleBoxY + 9.5);

  doc.line(borderInset, stripY, pageW - borderInset, stripY);
  doc.setFontSize(9);
  doc.text("SIGN. OF VENDEE :-", margin, stripY + 6);
  doc.text("SIGN. OF VENDOR :-", margin, stripY + 12);

  doc.setFont("helvetica", "bold");
  doc.text("DRAWN BY", pageW - margin - 55, stripY + 5);
  doc.setFont("helvetica", "normal");
  const surveyorName = surveyorNameInputEl.value.trim();
  const surveyorRegd = surveyorRegdInputEl.value.trim();
  const drawnByAddress = drawnByInputEl.value.trim();
  const drawnByLines = [];
  if (surveyorName) drawnByLines.push(`(Surveyor) ${surveyorName}`);
  if (surveyorRegd) drawnByLines.push(`Regd.No -${surveyorRegd}`);
  if (drawnByAddress) drawnByLines.push(drawnByAddress);
  doc.text(drawnByLines, pageW - margin - 55, stripY + 10);

  lastPdfDoc = doc;
  return doc;
}

function svgTransformFor(vertices) {
  const xs = vertices.map((v) => v.x);
  const ys = vertices.map((v) => v.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);
  const pad = 40;
  const viewW = 600 - pad * 2;
  const viewH = 420 - pad * 2;
  const scale = Math.min(viewW / w, viewH / h);
  const fn = (pt) => ({
    x: pad + (pt.x - minX) * scale,
    y: pad + (maxY - pt.y) * scale, // flip Y so North is up
  });
  // Needed by the Plot Editor's click-to-select: an SVG-user-space point coming back from
  // getScreenCTM() has to be turned back into plot feet to hit-test against plot polygons.
  fn.inverse = (p) => ({
    x: minX + (p.x - pad) / scale,
    y: maxY - (p.y - pad) / scale,
  });
  return fn;
}

function fontSizeForEdgeText(screenLen, textLength, minSize, maxSize) {
  // Size the font so the text roughly fits within the edge's own rendered length -
  // short sides get smaller text instead of overlapping neighbouring labels.
  const approxCharWidth = 0.62; // fraction of font-size per character, typical for this font
  const size = (screenLen * 0.9) / Math.max(1, textLength * approxCharWidth);
  return Math.max(minSize, Math.min(maxSize, size));
}

function polygonPoints(transform, vertices) {
  return vertices.map((v) => {
    const p = transform(v);
    return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  }).join(" ");
}

async function computeSite() {
  clearError();
  resultBoxEl.style.display = "none";
  const n = currentSideCount();
  const lengths = readLengths();
  const { roles, setbacks } = readRoleSetback();
  const actualAngles = interiorAnglesFromVertices(currentVertices);
  // /compute-site expects N-1 interior angles for vertices 1..N-1 (vertex 0's is derived
  // server-side too) - currentVertices is already a fully-resolved, closing polygon
  // (whether via the regular formula or the diagonal solve above), so these are just read
  // off it directly - the backend doesn't need to know diagonals were ever involved.
  const interiorAngles = actualAngles.slice(1);

  const body = {
    lengths,
    regular: false,
    interior_angles: interiorAngles,
    edges: roles.map((role, i) => ({ role, setback: setbacks[i] })),
  };

  computeBtn.disabled = true;
  logStatus(`Computing site polygon (${n} sides)...`);
  try {
    const res = await fetch("/compute-site", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.success) {
      showError(`[${data.stage || "error"}] ${data.error}`);
      logStatus(`Failed: ${data.error}`, true);
      return false;
    }

    // The server reconstructs the plot from (lengths, interior angles) via its own fixed-turn
    // walk, which can land on either chirality - nothing in that data says which one is real,
    // since mirroring never changes an interior angle. Line its response up against the RAW
    // (pre-Mirror/Rotate) solve actually produced client-side before re-applying the user's own
    // chosen orientation on top - otherwise "Compute area" could silently flip the buildable
    // outline relative to the plot boundary it's meant to sit inside, or snap the drawing back
    // out of whatever Mirror/Rotate the user had set.
    const alignedPlot = alignServerChirality(data.plot.vertices, rawSolvedVertices);
    const alignedBuildable = alignServerChirality(data.buildable.vertices, rawSolvedVertices);
    const orientedPlot = applyOrientation(alignedPlot);
    lastBuildable = applyOrientation(alignedBuildable);
    lastBuildableAreaSqft = polygonArea(lastBuildable);
    drawPreview(orientedPlot, lastBuildable);
    drawRoadLogicPreview(); // keep the Road Logic step's own preview in sync too

    let msg = `Buildable area computed (${data.buildable.vertices.length} vertices).`;
    // Severity comes from what the backend actually reported: a compass-rule closure
    // correction is routine (info), while a setback offset that needed geometric repair is
    // something the user should look at before trusting the outline (warning).
    let severity = "info";
    if (data.adjusted) msg += ` Closure auto-corrected (${data.closure_error_ft} ft error).`;
    if (data.buildable.repaired) {
      msg += ` Note: setbacks required geometric repair near a tight corner - double-check the buildable outline looks reasonable.`;
      severity = "warning";
    }
    resultBoxEl.style.display = "block";
    resultBoxEl.textContent = msg;
    setMessage(msg, severity);
    logStatus("Done.");
    return true;
  } catch (err) {
    showError(`Network/parse error: ${err}`);
    logStatus(`Failed: ${err}`, true);
    return false;
  } finally {
    computeBtn.disabled = false;
  }
}

unitSelectEl.addEventListener("change", () => {
  const oldUnit = currentUnit;
  const newUnit = unitSelectEl.value;
  if (oldUnit === newUnit) return;
  // Re-express every already-typed value in the new unit (same underlying feet value,
  // just relabeled) - the canonical feet value must not change just from a unit switch.
  const factor = oldUnit === "ft" ? 1 / FT_PER_M : FT_PER_M; // ft->m or m->ft
  currentUnit = newUnit;
  updateUnitLabels();

  const convert = (el) => {
    if (el.value === "") return;
    const v = parseFloat(el.value);
    if (!isNaN(v)) el.value = (v * factor).toFixed(2);
  };
  root.querySelectorAll(".length-input, .setback-input, .diagonal-input, .road-width-input, "
                      + ".outer-road-width-input, .outer-road-extension-input").forEach(convert);
  convert(roadExtensionEl);
  // Outer-road rows bake the unit into their own field labels when built, so they need
  // re-labelling here the way updateUnitLabels() handles every fixed label in the markup.
  root.querySelectorAll(".outer-road-row").forEach((row) => {
    const labels = row.querySelectorAll("label");
    if (labels[1]) labels[1].textContent = `Width (${unitLabel()})`;
    if (labels[2]) labels[2].textContent = `Road extension (${unitLabel()}, each side)`;
  });

  resolveAndRedraw();
});

sidesCountEl.addEventListener("change", buildEdgeRows);
roadExtensionEl.addEventListener("input", () => drawPreview(currentVertices, lastBuildable));
roadExtensionEl.addEventListener("change", () => drawPreview(currentVertices, lastBuildable));
// Mirror/Rotate are pure display-orientation toggles - re-run the exact same solve/orientation
// pipeline resolveAndRedraw() already does on every other edit, rather than trying to transform
// the already-computed currentVertices in place (which would accumulate rounding error over
// repeated edits and risks drifting out of sync with rawSolvedVertices).
//
// Mirror is a toggle BUTTON, not a checkbox - clicking it flips `mirrorEnabled` and the button's
// own label/look reflect that state directly, same as any other on/off action button in this UI.
// The button just says "Mirror" and does it - pressing it flips the drawing across the side
// picked in "Mirror across", pressing it again puts it back. No "On/Off" in the label: the
// diagram itself is the feedback, and the button's own pressed styling carries the state.
function updateMirrorBtn() {
  mirrorBtnEl.textContent = "Mirror";
  mirrorBtnEl.classList.toggle("toggle-active", mirrorEnabled);
  mirrorBtnEl.setAttribute("aria-pressed", mirrorEnabled ? "true" : "false");
}
mirrorBtnEl.addEventListener("click", () => {
  mirrorEnabled = !mirrorEnabled;
  updateMirrorBtn();
  resolveAndRedraw();
});
mirrorEdgeSelectEl.addEventListener("change", resolveAndRedraw);
rotationOrientationInputEl.addEventListener("input", resolveAndRedraw);
rotationOrientationInputEl.addEventListener("change", resolveAndRedraw);
finaliseBtn.addEventListener("click", renderFinalSitePlan);
rotationInputEl.addEventListener("input", renderFinalSitePlan);
rotationInputEl.addEventListener("change", renderFinalSitePlan);

adminTypeSelectEl.addEventListener("change", () => {
  adminNameLabelEl.textContent = `${adminTypeSelectEl.value} name`;
});

[
  [sketchScaleNTSEl, sketchScaleToScaleEl, sketchScaleRatioRowEl],
  [siteScaleNTSEl, siteScaleToScaleEl, siteScaleRatioRowEl],
  [mouzaScaleNTSEl, mouzaScaleToScaleEl, mouzaScaleRatioRowEl],
].forEach(([ntsRadio, toScaleRadio, ratioRow]) => {
  const sync = () => { ratioRow.style.display = toScaleRadio.checked ? "flex" : "none"; };
  ntsRadio.addEventListener("change", sync);
  toScaleRadio.addEventListener("change", sync);
});

mouzaMapInputEl.addEventListener("change", async () => {
  const file = mouzaMapInputEl.files[0];
  if (!file) { mouzaMapDataUrl = null; return; }
  try {
    mouzaMapDataUrl = await readImageAsDataUrl(file);
  } catch (err) {
    pdfNoteEl.textContent = `Could not read the image: ${err}`;
  }
});

// "Refresh sheet preview" and the download button are both driven by the two-stage Print
// Sheet flow at the bottom of this file (refreshSheetPreview / the stage-2 overlay), so the
// single-shot handlers uttam-5 had here are gone - having both would render the sheet twice
// per click.
regularToggleEl.addEventListener("change", () => {
  regularNoteEl.style.display = regularToggleEl.checked ? "block" : "none";
  const rows = Array.from(edgeRowsEl.querySelectorAll("tr"));
  rows.forEach((r, i) => { r.querySelector(".length-input").disabled = regularToggleEl.checked && i > 0; });
  if (!regularToggleEl.checked) {
    // Freeze: keep showing exactly the current (regular) shape until the user edits
    // something - just reveal the diagonal inputs, seeded from the shape as it stands.
    buildDiagonalRows();
  } else {
    resolveAndRedraw();
    buildDiagonalRows();
  }
});
computeBtn.addEventListener("click", computeSite);
diagonalAddBtnEl.addEventListener("click", () => {
  addDiagonalRow(0, null, true);
  rebuildCornerPlacementRows();
  onDiagonalChanged();
});

// ---- Road logic (master plan): lay out internal roads before slicing lots ----

function roadSideOptions() {
  if (!currentVertices) return [];
  const n = currentVertices.length;
  const labels = labelsFor(n);
  return Array.from({ length: n }, (_, i) => ({
    value: `side:${i}`,
    text: `Side ${labels[i]}${labels[(i + 1) % n]}`,
  }));
}

function populateSelectOptions(selectEl, options) {
  const previousValue = selectEl.value;
  selectEl.innerHTML = "";
  options.forEach(({ value, text }) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    selectEl.appendChild(opt);
  });
  const stillValid = Array.from(selectEl.options).some((o) => o.value === previousValue);
  if (stillValid) selectEl.value = previousValue;
  else if (selectEl.options.length) selectEl.selectedIndex = 0;
}

function rowIndexForUid(uid) {
  return Array.from(roadRowsEl.children).findIndex((row) => row.dataset.roadUid === uid);
}

function populateRoadEndpointSelect(selectEl, currentRow, includeDeadEnd) {
  const options = roadSideOptions();
  const rows = Array.from(roadRowsEl.children);
  const myIndex = rows.indexOf(currentRow);
  rows.forEach((row, i) => {
    if (i >= myIndex) return; // only roads already added before this one are valid targets
    const name = row.querySelector(".road-name-input").value.trim() || "Road";
    options.push({ value: `road:${row.dataset.roadUid}`, text: `Road ${name}` });
  });
  if (includeDeadEnd) options.push({ value: "deadend", text: "Dead end" });
  populateSelectOptions(selectEl, options);
}

function referenceLength(ref) {
  // The full length of whatever a start/end dropdown currently points at - a plot side or
  // an already-resolved road - used both to size the "distance from" field's default and to
  // turn a distance back into an actual point.
  if (!currentVertices) return 0;
  const n = currentVertices.length;
  if (ref.startsWith("side:")) {
    const idx = parseInt(ref.split(":")[1], 10);
    const a = currentVertices[idx], b = currentVertices[(idx + 1) % n];
    return Math.hypot(b.x - a.x, b.y - a.y);
  }
  if (ref.startsWith("road:")) {
    const uid = ref.split(":")[1];
    const r = roads[rowIndexForUid(uid)];
    if (!r) return 0;
    return Math.hypot(r.end.x - r.start.x, r.end.y - r.start.y);
  }
  return 0;
}

function distanceFieldLabel(ref) {
  if (!currentVertices || !ref) return "Distance (ft)";
  if (ref.startsWith("side:")) {
    const idx = parseInt(ref.split(":")[1], 10);
    const labels = labelsFor(currentVertices.length);
    return `Distance from ${labels[idx]} (ft)`;
  }
  if (ref.startsWith("road:")) {
    const uid = ref.split(":")[1];
    const row = Array.from(roadRowsEl.children).find((r) => r.dataset.roadUid === uid);
    const name = row ? (row.querySelector(".road-name-input").value.trim() || "Road") : "Road";
    return `Distance from start of ${name} (ft)`;
  }
  return "Distance (ft)";
}

// One OUTER road: a road running along a boundary side, outside the plot. It needs no name and
// no endpoints - the side it abuts identifies it - so it is a much smaller row than an inner
// road's, which is the whole reason these moved off the Metes & Bounds page.
function addOuterRoadRow() {
  const div = document.createElement("div");
  div.className = "road-row outer-road-row";
  div.style.cssText = "border:1px solid var(--border); border-radius:7px; padding:10px 12px; margin-top:10px;";
  div.innerHTML =
    `<div class="row">` +
    `<div class="field"><label>Side</label><select class="outer-road-side-select"></select></div>` +
    `<div class="field"><label>Width (${unitLabel()})</label>` +
    `<input type="number" class="outer-road-width-input" step="any" min="0.1" value="${feetToDisplay(20).toFixed(2)}" /></div>` +
    `<div class="field"><label>Road extension (${unitLabel()}, each side)</label>` +
    `<input type="number" class="outer-road-extension-input" step="any" min="0" value="${feetToDisplay(15).toFixed(2)}" /></div>` +
    `<div class="field"><label>&nbsp;</label>` +
    `<button type="button" class="secondary outer-road-remove-btn">Remove</button></div>` +
    `</div>`;
  outerRoadRowsEl.appendChild(div);

  const sideSelect = div.querySelector(".outer-road-side-select");
  const n = currentVertices ? currentVertices.length : 0;
  const labels = labelsFor(n);
  populateSelectOptions(sideSelect, Array.from({ length: n }, (_, i) => ({
    value: String(i),
    text: `${labels[i]}-${labels[(i + 1) % n]}`,
  })));

  const refresh = () => {
    updateOuterRoadNote();
    drawPreview(currentVertices, lastBuildable);
    drawRoadLogicPreview();
  };
  div.querySelector(".outer-road-remove-btn").addEventListener("click", () => {
    div.remove();
    refresh();
  });
  [sideSelect, div.querySelector(".outer-road-width-input"), div.querySelector(".outer-road-extension-input")]
    .forEach((el) => {
      el.addEventListener("input", refresh);
      el.addEventListener("change", refresh);
    });
  refresh();
}

function updateOuterRoadNote() {
  if (!outerRoadNoteEl) return;
  const count = outerRoadRowsEl ? outerRoadRowsEl.querySelectorAll(".outer-road-row").length : 0;
  outerRoadNoteEl.textContent = count
    ? `${count} outer road(s) along the boundary.`
    : `No outer roads yet - click "Add outer road" if a road runs along one of the boundary sides.`;
}

function addRoadRow() {
  const uid = String(++roadUidCounter);
  const index = roadRowsEl.children.length;
  const div = document.createElement("div");
  div.className = "road-row";
  div.dataset.roadUid = uid;
  div.style.cssText = "border:1px solid var(--border); border-radius:7px; padding:10px 12px; margin-top:10px;";
  // Four fixed rows rather than one long wrapping row, so the fields group by what they are
  // about and land in the same place at every pane width: identity, then the start endpoint,
  // then the end endpoint, then the road's own dimensions plus Remove. The curve parameters
  // get their own row under the identity row (they describe the shape picked there) and it is
  // shown only for a curved road.
  div.innerHTML =
    `<div class="row road-row-identity">` +
    `<div class="field"><label>Road name</label><input type="text" class="road-name-input" value="R${index + 1}" /></div>` +
    `<div class="field"><label>Road type</label><select class="road-type-select">` +
    `<option value="spine">Spine</option><option value="loop">Loop</option>` +
    `<option value="branch">Branch</option><option value="culdesac">Cul-de-sac</option>` +
    `</select></div>` +
    `<div class="field"><label>Shape</label><select class="road-shape-select">` +
    `<option value="straight">Straight</option><option value="curved">Curved</option>` +
    `</select></div>` +
    `</div>` +

    `<div class="row road-row-curve" style="display:none;">` +
    `<div class="field road-curve-bulge"><label>Curve bulge (ft)</label>` +
    `<input type="number" class="road-bulge-input" step="any" min="0" value="${feetToDisplay(10).toFixed(2)}" /></div>` +
    `<div class="field road-curve-direction"><label>Curve direction</label>` +
    `<select class="road-direction-select"><option value="left">Left of travel</option><option value="right">Right of travel</option></select></div>` +
    `</div>` +

    `<div class="row road-row-start">` +
    `<div class="field"><label>Start</label><select class="road-start-select"></select></div>` +
    `<div class="field"><label class="road-start-distance-label">Distance (ft)</label>` +
    `<input type="number" class="road-start-distance-input" step="any" /></div>` +
    `</div>` +

    `<div class="row road-row-end">` +
    `<div class="field"><label>End</label><select class="road-end-select"></select></div>` +
    `<div class="field road-end-distance-field"><label class="road-end-distance-label">Distance (ft)</label>` +
    `<input type="number" class="road-end-distance-input" step="any" /></div>` +
    `<div class="field road-deadend-length" style="display:none;"><label>Length (ft)</label>` +
    `<input type="number" class="road-deadend-length-input" step="any" min="0.1" value="${feetToDisplay(30).toFixed(2)}" /></div>` +
    `<div class="field road-deadend-direction" style="display:none;"><label>Perpendicular to side</label>` +
    `<select class="road-deadend-direction-select"></select></div>` +
    `</div>` +

    `<div class="row road-row-size">` +
    `<div class="field"><label>Width (ft)</label><input type="number" class="road-width-input" step="any" min="0.1" value="${feetToDisplay(12).toFixed(2)}" /></div>` +
    `<div class="field"><label>Buffer (ft)</label><input type="number" class="road-buffer-input" step="any" min="0" value="0" /></div>` +
    `<div class="field"><label>&nbsp;</label><button type="button" class="secondary road-remove-btn">Remove road</button></div>` +
    `</div>`;
  roadRowsEl.appendChild(div);

  const nameInput = div.querySelector(".road-name-input");
  const typeSelect = div.querySelector(".road-type-select");
  const startSelect = div.querySelector(".road-start-select");
  const startDistanceLabel = div.querySelector(".road-start-distance-label");
  const startDistanceInput = div.querySelector(".road-start-distance-input");
  const endSelect = div.querySelector(".road-end-select");
  const endDistanceField = div.querySelector(".road-end-distance-field");
  const endDistanceLabel = div.querySelector(".road-end-distance-label");
  const endDistanceInput = div.querySelector(".road-end-distance-input");
  const widthInput = div.querySelector(".road-width-input");
  const bufferInput = div.querySelector(".road-buffer-input");
  const shapeSelect = div.querySelector(".road-shape-select");
  const curveRow = div.querySelector(".road-row-curve");
  const bulgeInput = div.querySelector(".road-bulge-input");
  const directionSelect = div.querySelector(".road-direction-select");
  const deadendLengthField = div.querySelector(".road-deadend-length");
  const deadendDirField = div.querySelector(".road-deadend-direction");
  const deadendLengthInput = div.querySelector(".road-deadend-length-input");
  const deadendDirSelect = div.querySelector(".road-deadend-direction-select");
  const removeBtn = div.querySelector(".road-remove-btn");

  populateRoadEndpointSelect(startSelect, div, false);
  populateRoadEndpointSelect(endSelect, div, true);
  populateSelectOptions(deadendDirSelect, roadSideOptions());

  removeBtn.addEventListener("click", () => {
    div.remove();
    recomputeAllRoads();
  });

  function reseedStartDistance() {
    startDistanceLabel.textContent = distanceFieldLabel(startSelect.value);
    startDistanceInput.value = feetToDisplay(referenceLength(startSelect.value) / 2).toFixed(2);
  }
  function reseedEndDistance() {
    endDistanceLabel.textContent = distanceFieldLabel(endSelect.value);
    endDistanceInput.value = feetToDisplay(referenceLength(endSelect.value) / 2).toFixed(2);
  }
  function updateDeadendVisibility() {
    const isDeadEnd = endSelect.value === "deadend";
    deadendLengthField.style.display = isDeadEnd ? "flex" : "none";
    deadendDirField.style.display = isDeadEnd ? "flex" : "none";
    endDistanceField.style.display = isDeadEnd ? "none" : "flex";
  }
  function updateCurveVisibility() {
    curveRow.style.display = shapeSelect.value === "curved" ? "flex" : "none";
  }
  reseedStartDistance();
  updateDeadendVisibility();
  updateCurveVisibility();
  if (endSelect.value !== "deadend") reseedEndDistance();

  shapeSelect.addEventListener("change", () => {
    updateCurveVisibility();
    recomputeAllRoads();
  });

  [nameInput, typeSelect, widthInput, bufferInput, bulgeInput, directionSelect, startDistanceInput, endDistanceInput, deadendLengthInput, deadendDirSelect].forEach((el) => {
    el.addEventListener("input", recomputeAllRoads);
    el.addEventListener("change", recomputeAllRoads);
  });
  startSelect.addEventListener("change", () => {
    reseedStartDistance();
    recomputeAllRoads();
  });
  endSelect.addEventListener("change", () => {
    updateDeadendVisibility();
    if (endSelect.value !== "deadend") reseedEndDistance();
    recomputeAllRoads();
  });
}

// A curved road is modelled as a real circular arc between its start and end (the same
// "horizontal curve" convention actual road design uses) rather than an arbitrary freehand
// bend - "bulge" is the sagitta: how far the arc's own midpoint deviates, perpendicular to
// the straight line between start and end, on the chosen side of the direction of travel.
// bulge <= 0 (or a degenerate zero-length chord) just returns the straight two-point path.
// Returns a polyline (start, ...intermediate arc points..., end) since every downstream
// consumer - the shapely strip cut, frontage detection, band rendering - already works on an
// arbitrary polyline path, not just a single straight segment.
function arcPointsForRoad(start, end, bulgeFt, direction, segments) {
  segments = segments || 24;
  const dx = end.x - start.x, dy = end.y - start.y;
  const chordLen = Math.hypot(dx, dy);
  if (!bulgeFt || bulgeFt <= 1e-6 || chordLen < 1e-6) return [start, end];

  const ux = dx / chordLen, uy = dy / chordLen;
  // 'left of travel' = rotate the travel direction 90 degrees counter-clockwise.
  const nx = direction === "right" ? uy : -uy;
  const ny = direction === "right" ? -ux : ux;

  const halfChord = chordLen / 2;
  const s = bulgeFt;
  const radius = (halfChord * halfChord + s * s) / (2 * s);
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  // The circle's centre sits on the opposite side of the chord from the bulge, at distance
  // (radius - sagitta) from the chord's own midpoint.
  const center = { x: mid.x - nx * (radius - s), y: mid.y - ny * (radius - s) };

  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1 = Math.atan2(end.y - center.y, end.x - center.x);
  const sagittaPoint = { x: mid.x + nx * s, y: mid.y + ny * s };
  const aBulge = Math.atan2(sagittaPoint.y - center.y, sagittaPoint.x - center.x);

  function normalizeDelta(from, to) {
    let d = to - from;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }
  // Two possible sweeps (short way / long way around the circle) connect a0 to a1 - pick
  // whichever one actually passes through the bulge side, not just the shorter arithmetic
  // delta, since a large bulge relative to the chord needs the major arc.
  let sweep = normalizeDelta(a0, a1);
  const directMidAngle = a0 + sweep / 2;
  if (Math.abs(normalizeDelta(directMidAngle, aBulge)) > Math.PI / 2) {
    sweep = sweep > 0 ? sweep - 2 * Math.PI : sweep + 2 * Math.PI;
  }

  const points = [];
  for (let i = 0; i <= segments; i++) {
    const a = a0 + sweep * (i / segments);
    points.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  }
  points[0] = start;
  points[points.length - 1] = end;
  return points;
}

// Shortest distance from a point to a polyline path (a straight road's path is just its two
// endpoints; a curved road's path is the discretized arc) - the minimum over every segment.
function pointToPathDistance(pt, path) {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    best = Math.min(best, pointToSegmentDistance(pt, path[i], path[i + 1]));
  }
  return best;
}

function recomputeAllRoads() {
  // Outer-road side lists are built from the boundary's own corner labels, so a change to the
  // side count leaves them naming sides that no longer exist - rebuild them here, keeping each
  // row's current pick where that side still exists.
  if (outerRoadRowsEl && currentVertices) {
    const n = currentVertices.length;
    const labels = labelsFor(n);
    const sideOptions = Array.from({ length: n }, (_, i) => ({
      value: String(i), text: `${labels[i]}-${labels[(i + 1) % n]}`,
    }));
    outerRoadRowsEl.querySelectorAll(".outer-road-side-select").forEach((sel) => {
      populateSelectOptions(sel, sideOptions);
    });
    updateOuterRoadNote();
  }

  const rows = Array.from(roadRowsEl.children);
  rows.forEach((row) => {
    populateRoadEndpointSelect(row.querySelector(".road-start-select"), row, false);
    populateRoadEndpointSelect(row.querySelector(".road-end-select"), row, true);
    // Keep "Distance from X" labels in sync if an earlier road's name just changed.
    row.querySelector(".road-start-distance-label").textContent = distanceFieldLabel(row.querySelector(".road-start-select").value);
    const endRefNow = row.querySelector(".road-end-select").value;
    if (endRefNow !== "deadend") {
      row.querySelector(".road-end-distance-label").textContent = distanceFieldLabel(endRefNow);
    }
  });

  if (!currentVertices) {
    roads = [];
    drawRoadLogicPreview([]);
    return;
  }

  const n = currentVertices.length;
  const centroid = centroidOf(currentVertices);
  const resolved = [];
  const errors = [];

  // Turns a "distance from the reference's own start" measurement into an actual point -
  // for a side, that's distance from its first-named vertex toward the second; for a road,
  // distance from that road's own start point toward its own end. Extrapolates past either
  // end if given a distance outside the reference's own length, rather than clamping.
  function resolveRef(ref, distanceFt) {
    if (ref.startsWith("side:")) {
      const idx = parseInt(ref.split(":")[1], 10);
      const a = currentVertices[idx], b = currentVertices[(idx + 1) % n];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const t = distanceFt / len;
      return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
    }
    if (ref.startsWith("road:")) {
      const uid = ref.split(":")[1];
      const r = resolved[rowIndexForUid(uid)];
      if (!r) return null;
      // Distance is measured along the STRAIGHT chord between that road's start and end, even
      // if the referenced road is curved - an approximation (true arc-length parameterization
      // would need the discretized path here too), acceptable since a road connecting into a
      // curved road is a secondary/rare case and the chord is close to the arc for gentle bulges.
      const len = Math.hypot(r.end.x - r.start.x, r.end.y - r.start.y) || 1;
      const t = distanceFt / len;
      return { x: r.start.x + t * (r.end.x - r.start.x), y: r.start.y + t * (r.end.y - r.start.y) };
    }
    return null;
  }

  // The unit direction of whatever a start/end connects to (a plot side, or another road's own
  // chord) - used so a road's own end cut can be made COLINEAR with that side/road instead of
  // perpendicular to the new road's own direction. A road meeting a boundary at an angle with a
  // perpendicular cut leaves a sliver of leftover land wedged between the cut and the actual
  // boundary; cutting along the boundary's own direction instead removes that sliver entirely,
  // and naturally makes the road's own cross-section a trapezoid rather than a rectangle
  // wherever it isn't perpendicular to what it's connecting to.
  function refDirection(ref) {
    if (ref.startsWith("side:")) {
      const idx = parseInt(ref.split(":")[1], 10);
      const a = currentVertices[idx], b = currentVertices[(idx + 1) % n];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: dx / len, y: dy / len };
    }
    if (ref.startsWith("road:")) {
      const uid = ref.split(":")[1];
      const r = resolved[rowIndexForUid(uid)];
      if (!r) return null;
      const dx = r.end.x - r.start.x, dy = r.end.y - r.start.y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: dx / len, y: dy / len };
    }
    return null;
  }

  rows.forEach((row, i) => {
    const name = row.querySelector(".road-name-input").value.trim() || `R${i + 1}`;
    const type = row.querySelector(".road-type-select").value;
    const startRef = row.querySelector(".road-start-select").value;
    const endRef = row.querySelector(".road-end-select").value;
    const width = displayToFeet(parseFloat(row.querySelector(".road-width-input").value) || 0);
    const buffer = Math.max(0, displayToFeet(parseFloat(row.querySelector(".road-buffer-input").value) || 0));
    const shape = row.querySelector(".road-shape-select").value;
    const bulge = Math.max(0, displayToFeet(parseFloat(row.querySelector(".road-bulge-input").value) || 0));
    const curveDirection = row.querySelector(".road-direction-select").value;
    const startDistance = displayToFeet(parseFloat(row.querySelector(".road-start-distance-input").value) || 0);

    const startPoint = resolveRef(startRef, startDistance);
    if (!startPoint) {
      errors.push(`${name}: can't resolve the start connection.`);
      resolved.push(null);
      return;
    }

    let endPoint;
    if (endRef === "deadend") {
      const length = displayToFeet(parseFloat(row.querySelector(".road-deadend-length-input").value) || 0);
      const dirRef = row.querySelector(".road-deadend-direction-select").value;
      const dirIdx = parseInt(dirRef.split(":")[1], 10);
      const da = currentVertices[dirIdx], db = currentVertices[(dirIdx + 1) % n];
      const edx = db.x - da.x, edy = db.y - da.y;
      const elen = Math.hypot(edx, edy) || 1;
      // Perpendicular to the chosen side; pick whichever of the two perpendicular
      // directions points back toward the plot's centroid, so a dead end never shoots
      // outside the boundary.
      let px = -edy / elen, py = edx / elen;
      const toward = { x: centroid.x - startPoint.x, y: centroid.y - startPoint.y };
      if (px * toward.x + py * toward.y < 0) { px = -px; py = -py; }
      endPoint = { x: startPoint.x + px * length, y: startPoint.y + py * length };
    } else {
      const endDistance = displayToFeet(parseFloat(row.querySelector(".road-end-distance-input").value) || 0);
      endPoint = resolveRef(endRef, endDistance);
    }

    if (!endPoint) {
      errors.push(`${name}: can't resolve the end connection.`);
      resolved.push(null);
      return;
    }

    const startCapDir = refDirection(startRef); // null for a dead end's own start? no - start is
                                                  // never a dead end, only end can be.
    const endCapDir = endRef === "deadend" ? null : refDirection(endRef);

    const path = shape === "curved" ? arcPointsForRoad(startPoint, endPoint, bulge, curveDirection) : [startPoint, endPoint];
    resolved.push({
      name, type, width, buffer, shape, bulge, curveDirection,
      start: startPoint, end: endPoint, path, startCapDir, endCapDir,
    });
  });

  roads = resolved;
  drawRoadLogicPreview(errors);
  drawPreview(currentVertices, lastBuildable); // keep the site plan's own preview showing roads live too
}

function drawRoadLogicPreview(errors) {
  if (!currentVertices) {
    roadLogicSvgEl.innerHTML = "";
    roadLogicNoteEl.textContent = "Compute the buildable area on the Site plan page first.";
    roadLogicNoteEl.classList.remove("closure-error");
    return;
  }
  // Reuse the site plot's own renderer for the plot outline - this is what already knows how
  // to draw the outer, boundary-edge roads (the gray bands with break lines from the Site
  // plan page's own Role column), not just the internal roads defined here. Without this,
  // Road Logic/Plot Logic only ever showed the bare plot outline, silently dropping any
  // road the site plan itself already had.
  const { svg: baseSvg, transform } = buildPlotSvg(currentVertices, { showVertices: true, showDiagonals: false });
  let svg = baseSvg;
  svg += internalRoadBandSvg(transform);
  (roads || []).forEach((r) => {
    if (!r) return;
    const path = r.path && r.path.length >= 2 ? r.path : [r.start, r.end];
    const chordLength = Math.hypot(r.end.x - r.start.x, r.end.y - r.start.y);
    const bufferPart = r.buffer ? ` + ${feetToDisplay(r.buffer).toFixed(1)} ${unitLabel()} buffer/side` : "";
    const curvePart = r.shape === "curved" ? `, curved (${feetToDisplay(r.bulge).toFixed(1)} ${unitLabel()} bulge)` : "";
    const label = `${r.name} (${feetToDisplay(chordLength).toFixed(1)} ${unitLabel()} long, `
      + `${feetToDisplay(r.width).toFixed(1)} ${unitLabel()} wide${bufferPart}${curvePart})`;

    // Written ALONG the road and inside its own band, like a street name on a map, rather than
    // as horizontal text floating above one end of it (where it collided with the boundary's own
    // corner labels). Everything below is computed in SCREEN space: the transform scales and can
    // flip, so a real-world angle would be wrong.
    const screenPath = path.map(transform);
    let total = 0;
    for (let i = 0; i < screenPath.length - 1; i++) {
      total += Math.hypot(screenPath[i + 1].x - screenPath[i].x, screenPath[i + 1].y - screenPath[i].y);
    }
    // The point at HALF the road's length, and the direction of the segment it falls on (so a
    // curved road's label follows the arc there). The old code used path[floor(n/2)], which for
    // a straight road's 2-point path is its END, not its middle - that's why the label sat up at
    // the top of the band.
    let remaining = total / 2;
    let mid = screenPath[0];
    let angle = 0;
    for (let i = 0; i < screenPath.length - 1; i++) {
      const dx = screenPath[i + 1].x - screenPath[i].x;
      const dy = screenPath[i + 1].y - screenPath[i].y;
      const segLen = Math.hypot(dx, dy) || 1;
      if (remaining <= segLen || i === screenPath.length - 2) {
        const t = Math.max(0, Math.min(1, remaining / segLen));
        mid = { x: screenPath[i].x + dx * t, y: screenPath[i].y + dy * t };
        angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        break;
      }
      remaining -= segLen;
    }
    // Keep the text upright - a road drawn right-to-left would otherwise read upside down.
    if (angle > 90) angle -= 180;
    else if (angle < -90) angle += 180;

    // Sized off the road's own length, as asked: a long road carries big text, a short one has
    // to shrink or the label would run out past its own ends. Also capped by the band's
    // thickness (0.55 char-width per em is the usual approximation for a bold sans face) so the
    // text can never overflow the road sideways either.
    const scale = chordLength > 1e-6 ? total / chordLength : 1;
    const byLength = (total * 0.92) / Math.max(label.length * 0.55, 1);
    const byWidth = r.width * scale * 0.62;
    const fontSize = Math.max(4.5, Math.min(15, byLength, byWidth));

    svg += `<text x="${mid.x.toFixed(1)}" y="${mid.y.toFixed(1)}" font-size="${fontSize.toFixed(1)}" ` +
      `font-weight="700" fill="#3a2352" text-anchor="middle" dominant-baseline="central" ` +
      `transform="rotate(${angle.toFixed(1)} ${mid.x.toFixed(1)} ${mid.y.toFixed(1)})">${label}</text>`;
  });
  roadLogicSvgEl.innerHTML = svg;

  if (errors && errors.length) {
    roadLogicNoteEl.textContent = errors.join(" ");
    roadLogicNoteEl.classList.add("closure-error");
  } else {
    roadLogicNoteEl.textContent = roads && roads.length
      ? `${roads.length} road(s) defined.`
      : "No inner roads yet - click \"Add inner road\" to start.";
    roadLogicNoteEl.classList.remove("closure-error");
  }
}

addRoadBtnEl.addEventListener("click", () => {
  addRoadRow();
  recomputeAllRoads();
});

if (addOuterRoadBtnEl) {
  addOuterRoadBtnEl.addEventListener("click", () => {
    if (!currentVertices) {
      setMessage("Finish Metes & Bounds first - an outer road runs along one of the boundary's own sides.", "error");
      return;
    }
    addOuterRoadRow();
  });
}

// ---- Plot logic (master plan): sub-sections left after roads, then plots within each ----

let subsections = []; // {vertices, params, plots: [[{x,y}x4],...], details}

function pointToSegmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function isEdgeRoadFacing(a, b) {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  for (const r of roads) {
    if (!r) continue;
    const path = r.path && r.path.length >= 2 ? r.path : [r.start, r.end];
    if (pointToPathDistance(mid, path) <= r.width / 2 + (r.buffer || 0) + 0.5) return true;
  }
  if (currentVertices) {
    const n = currentVertices.length;
    for (const i of outerRoadEdgeSet()) {
      if (i >= n) continue;
      const pa = currentVertices[i], pb = currentVertices[(i + 1) % n];
      if (pointToSegmentDistance(mid, pa, pb) < 0.5) return true;
    }
  }
  return false;
}

// Small, muted side-length labels for one plot - deliberately tiny (well below the plot's own
// "S1P2"-style number label) so a whole sub-section full of them stays readable rather than
// turning into a wall of numbers; nudged slightly inward from each edge's own midpoint so the
// text sits over the plot's own fill instead of straddling the boundary line with a neighbour.
function plotSideLabelsSvg(transform, plot) {
  const verts = plot.vertices;
  const n = verts.length;
  const centroid = centroidOf(verts);
  const fontSize = plot.fill ? 5 : 6;
  let svg = "";
  for (let i = 0; i < n; i++) {
    const a = verts[i], b = verts[(i + 1) % n];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-6) continue;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dx = centroid.x - mid.x, dy = centroid.y - mid.y;
    const dlen = Math.hypot(dx, dy) || 1;
    // A shared edge between two adjacent plots gets a label from EACH of them - nudging
    // further inward (rather than sitting right on the line) keeps the two on visibly
    // separate sides of that line instead of colliding into unreadable overlapping text.
    const nudge = Math.min(dlen * 0.3, 6);
    const labelPoint = { x: mid.x + (dx / dlen) * nudge, y: mid.y + (dy / dlen) * nudge };
    const p = transform(labelPoint);
    svg += `<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" font-size="${fontSize}" fill="#5b6169" ` +
      `text-anchor="middle" dominant-baseline="middle">${feetToDisplay(length).toFixed(1)}${unitLabel()}</text>`;
  }
  return svg;
}

// A sub-section's own side lengths, small font, nudged OUTWARD (away from its centroid) rather
// than inward like plotSideLabelsSvg - inward would land right on top of the frontage plots'
// own edge labels, which already crowd the inside of every sub-section right along this same
// boundary. Outward puts it in the road strip (or just past the outer plot boundary) instead,
// which is clear space in every layout this app produces.
function subsectionSideLabelsSvg(transform, sub) {
  const verts = sub.vertices;
  const n = verts.length;
  const centroid = centroidOf(verts);
  let svg = "";
  for (let i = 0; i < n; i++) {
    const a = verts[i], b = verts[(i + 1) % n];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-6) continue;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dx = mid.x - centroid.x, dy = mid.y - centroid.y;
    const dlen = Math.hypot(dx, dy) || 1;
    const nudge = Math.min(dlen * 0.12, 9);
    const labelPoint = { x: mid.x + (dx / dlen) * nudge, y: mid.y + (dy / dlen) * nudge };
    const p = transform(labelPoint);
    svg += `<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" font-size="6.5" font-weight="600" fill="#2f6f4f" ` +
      `text-anchor="middle" dominant-baseline="middle">${feetToDisplay(length).toFixed(1)}${unitLabel()}</text>`;
  }
  return svg;
}

// Internal (Road Logic) roads' width, small font, at each road's own midpoint - Road Logic's
// own preview already spells out name/length/width/buffer in full; here it's just the width,
// since that's the one dimension relevant to reading a sub-section's own available frontage.
function internalRoadWidthLabelsSvg(transform) {
  let svg = "";
  (roads || []).forEach((r) => {
    if (!r) return;
    const path = r.path && r.path.length >= 2 ? r.path : [r.start, r.end];
    const mid = transform(path[Math.floor(path.length / 2)]);
    svg += `<text x="${mid.x.toFixed(1)}" y="${mid.y.toFixed(1)}" font-size="6.5" font-weight="600" ` +
      `fill="#5b3a8a" text-anchor="middle" dominant-baseline="middle">${feetToDisplay(r.width).toFixed(1)}${unitLabel()} wide</text>`;
  });
  return svg;
}

// Leftover land that failed the fill quality gate (too small, too sharp, too thin, too
// elongated to be a plot anyone could build on). It is drawn hatched and left unnamed
// precisely so it doesn't read as a plot - the old behaviour of triangulating every scrap
// into a named "plot" is what produced 1 sq ft, 0.16-degree needles.
const OPEN_SPACE_HATCH_ID = "openSpaceHatch";

function openSpaceDefsSvg() {
  return `<defs><pattern id="${OPEN_SPACE_HATCH_ID}" width="6" height="6" ` +
    `patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<line x1="0" y1="0" x2="0" y2="6" stroke="#9aa1ac" stroke-width="1.2" /></pattern></defs>`;
}

function openSpaceSvg(transform, sub) {
  return (sub.openSpace || []).map((piece) =>
    `<polygon points="${polygonPoints(transform, piece.vertices)}" ` +
    `fill="url(#${OPEN_SPACE_HATCH_ID})" fill-opacity="0.55" stroke="#9aa1ac" ` +
    `stroke-width="0.8" stroke-dasharray="2,2" />`
  ).join("");
}

function drawPlotLogicPreview() {
  if (!currentVertices) {
    plotLogicSvgEl.innerHTML = "";
    return;
  }
  // Reuse the site plot's own renderer, same reasoning as Road Logic's preview - this is
  // what draws the outer, boundary-edge roads (gray bands from the Site plan page's Role
  // column), which the plot-logic display would otherwise silently drop.
  const { svg: baseSvg, transform } = buildPlotSvg(currentVertices, { showVertices: true, showDiagonals: false });
  let svg = openSpaceDefsSvg() + baseSvg;
  svg += internalRoadBandSvg(transform);
  svg += internalRoadWidthLabelsSvg(transform);
  subsections.forEach((s, si) => {
    svg += `<polygon points="${polygonPoints(transform, s.vertices)}" fill="none" stroke="#2f6f4f" stroke-width="1.5" />`;
    const c = centroidOf(s.vertices);
    const pc = transform(c);
    svg += `<text x="${pc.x.toFixed(1)}" y="${pc.y.toFixed(1)}" font-size="12" font-weight="700" fill="#2f6f4f" text-anchor="middle">S${si + 1}</text>`;
    svg += subsectionSideLabelsSvg(transform, s);
    svg += openSpaceSvg(transform, s);
    (s.plots || []).forEach((plot, pi) => {
      const isFill = plot.fill;
      const pts = polygonPoints(transform, plot.vertices);
      if (isFill) {
        svg += `<polygon points="${pts}" fill="rgba(200,120,40,0.10)" stroke="#c87828" stroke-width="1" stroke-dasharray="3,3" />`;
      } else {
        svg += `<polygon points="${pts}" fill="rgba(47,111,79,0.12)" stroke="#2f6f4f" stroke-width="1.2" />`;
      }
      // Fill triangles can number in the dozens for an irregular sub-section - labeling every
      // sliver clutters the display unreadably, so only label fill plots big enough for a
      // label to actually fit (frontage plots are always labeled, there are far fewer of them).
      if (!isFill || plot.area >= 60) {
        const pcen = centroidOf(plot.vertices);
        const ppc = transform(pcen);
        const fontSize = isFill ? 7 : 9;
        svg += `<text x="${ppc.x.toFixed(1)}" y="${ppc.y.toFixed(1)}" font-size="${fontSize}" font-weight="600" fill="#1f2430" text-anchor="middle">${plot.name || `S${si + 1}P${pi + 1}`}</text>`;
        svg += plotSideLabelsSvg(transform, plot);
      }
    });
  });
  plotLogicSvgEl.innerHTML = svg;
}

// A sub-section's road-facing boundary isn't necessarily one straight edge - a curved road's
// frontage is dozens of tiny polyline segments (the discretized arc), and every one of those
// is individually far too short to hold even one plot. Grouping consecutive road-facing edges
// into one continuous polyline "run" per contiguous stretch lets the backend walk plots along
// the run's own arc length instead of getting stuck on each tiny piece separately.
function buildFrontageRuns(verts) {
  const n = verts.length;
  const facing = [];
  for (let i = 0; i < n; i++) facing.push(isEdgeRoadFacing(verts[i], verts[(i + 1) % n]));
  if (!facing.some(Boolean)) return [];
  // Rotate the starting point to a non-facing edge when one exists, so a run never has to
  // wrap past the end of the array back to the start.
  let startOffset = facing.indexOf(false);
  if (startOffset === -1) startOffset = 0; // the whole boundary is road-facing

  // A run should only continue across a vertex where the boundary keeps roughly the same
  // direction - that's what makes a curved road's many small discretization segments
  // correctly merge into one frontage. A genuine sharp corner (e.g. a sub-section bordering
  // one road on one side and a different, perpendicular road on the adjacent side) must NOT
  // be smoothed over the same way, or a single plot's frontage chord ends up cutting
  // diagonally across the corner instead of following either real edge - exactly what
  // produced skewed, rotated plots and slivers in an L-shaped corner block.
  const MAX_TURN_DEG = 45;
  function edgeDir(i) {
    const a = verts[i], b = verts[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  }
  function turnAngleDeg(dirA, dirB) {
    const dot = Math.max(-1, Math.min(1, dirA.x * dirB.x + dirA.y * dirB.y));
    return (Math.acos(dot) * 180) / Math.PI;
  }

  const runs = [];
  let current = null;
  let lastDir = null;
  for (let k = 0; k < n; k++) {
    const i = (startOffset + k) % n;
    if (facing[i]) {
      const dir = edgeDir(i);
      if (current && lastDir && turnAngleDeg(lastDir, dir) > MAX_TURN_DEG) {
        runs.push(current);
        current = null;
      }
      if (!current) current = [verts[i]];
      current.push(verts[(i + 1) % n]);
      lastDir = dir;
    } else if (current) {
      runs.push(current);
      current = null;
      lastDir = null;
    }
  }
  if (current) runs.push(current);
  return runs;
}

async function insertPlotsForSubsection(sub) {
  const verts = sub.vertices;
  const p = sub.params;
  const frontageRuns = buildFrontageRuns(verts);
  const roadFacingEdges = frontageRuns.map((path) => ({ path }));
  if (roadFacingEdges.length === 0) {
    sub.plots = [];
    sub.details = { error: "No road frontage on this sub-section - add a road bordering it before inserting plots." };
    return;
  }

  // The actual plot geometry is computed server-side (shapely): rectangular/trapezoidal
  // frontage plots are clipped against whatever land is really left (never overlapping, since
  // each accepted plot is subtracted before the next is even tried), then everything still
  // left over is tiled edge-to-edge with triangles via constrained Delaunay triangulation -
  // this is real polygon math, not something worth re-implementing by hand in JS.
  let data;
  try {
    const res = await fetch("/insert-plots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subsection: { vertices: verts },
        roadFacingEdges,
        params: {
          minLength: p.minLength, maxLength: p.maxLength,
          minWidth: p.minWidth, maxWidth: p.maxWidth,
          minGap: p.minGap, roadThreshold: p.roadThreshold, maxPlots: p.maxPlots,
        },
      }),
    });
    data = await res.json();
  } catch (err) {
    sub.plots = [];
    sub.details = { error: `Network/parse error: ${err}` };
    return;
  }
  if (!data.success) {
    sub.plots = [];
    sub.details = { error: `[${data.stage || "error"}] ${data.error}` };
    return;
  }

  const plots = data.plots; // [{vertices, area, sides, fill}, ...]
  nameSubsectionPlots(sub, plots);
  sub.openSpace = data.openSpace || [];
  sub.invariantErrors = data.invariantErrors || [];
  const frontagePlots = plots.filter((pl) => !pl.fill);
  const totalPlotArea = plots.reduce((s, pl) => s + pl.area, 0);
  const openArea = (sub.openSpace || []).reduce((s, o) => s + o.area, 0);
  const subArea = data.subsectionArea;
  const areas = plots.map((pl) => pl.area);
  const biggestIdx = areas.length ? areas.indexOf(Math.max(...areas)) : -1;
  const smallestIdx = areas.length ? areas.indexOf(Math.min(...areas)) : -1;

  sub.plots = plots;
  sub.details = {
    count: plots.length,
    frontageCount: frontagePlots.length,
    fillCount: plots.length - frontagePlots.length,
    usedArea: totalPlotArea,
    openArea,
    subArea,
    biggestLabel: biggestIdx >= 0 ? plots[biggestIdx].name : null,
    biggestArea: biggestIdx >= 0 ? areas[biggestIdx] : null,
    smallestLabel: smallestIdx >= 0 ? plots[smallestIdx].name : null,
    smallestArea: smallestIdx >= 0 ? areas[smallestIdx] : null,
    belowMin: p.minPlots && frontagePlots.length < p.minPlots,
    invariantErrors: sub.invariantErrors,
    // Only shown when zero real (road-facing) plots were placed at all - with a partial
    // success elsewhere in the sub-section, one tapering corner failing on its own is usually
    // expected behaviour, not something to alarm the user with on every insert.
    generationNotes: frontagePlots.length === 0 ? (data.generationNotes || []) : [],
  };

  // Step-level severity for the shared message area: a sub-section the solver couldn't place
  // any road-facing plot in, or one that came back with an invariant complaint, is a warning
  // the user should look at - a normal insert is just informational.
  if ((sub.invariantErrors || []).length) {
    setMessage(`Sub-section ${sub.index + 1}: ${sub.invariantErrors[0]}`, "warning");
  } else if (frontagePlots.length === 0) {
    const why = (sub.details.generationNotes || [])[0];
    setMessage(
      `Sub-section ${sub.index + 1}: no road-facing plots could be placed${why ? ` - ${why}` : ""}.`,
      "warning",
    );
  } else {
    setMessage(
      `Sub-section ${sub.index + 1}: ${frontagePlots.length} road-facing plot(s) + ` +
      `${plots.length - frontagePlots.length} fill plot(s) inserted.`,
      "info",
    );
  }
}

// Real plots keep a permanent S{sub}P{n} name, assigned once, so the plot editor can keep
// referring to one even after its neighbours change. Fill plots are a derived view of the
// residual - thrown away and rebuilt whenever a real plot moves - so they get their own
// S{sub}F{n} sequence that is simply renumbered on every regeneration and can never collide
// with a real plot's name.
function nameSubsectionPlots(sub, plots) {
  let realNo = 0;
  let fillNo = 0;
  plots.forEach((pl) => {
    if (pl.fill) {
      fillNo += 1;
      pl.name = `S${sub.index + 1}F${fillNo}`;
    } else {
      realNo += 1;
      pl.name = `S${sub.index + 1}P${realNo}`;
    }
  });
  return plots;
}

// Replace a sub-section's derived fill + open space, keeping every real plot exactly as it is.
function applyRegeneratedFill(sub, fillPlots, openSpace) {
  const realPlots = (sub.plots || []).filter((pl) => !pl.fill);
  (fillPlots || []).forEach((pl) => { pl.fill = true; });
  sub.plots = realPlots.concat(fillPlots || []);
  sub.openSpace = openSpace || [];
  nameSubsectionPlots(sub, sub.plots);
  if (sub.details) {
    const plots = sub.plots;
    const areas = plots.map((pl) => pl.area);
    const biggestIdx = areas.length ? areas.indexOf(Math.max(...areas)) : -1;
    const smallestIdx = areas.length ? areas.indexOf(Math.min(...areas)) : -1;
    sub.details.count = plots.length;
    sub.details.frontageCount = realPlots.length;
    sub.details.fillCount = plots.length - realPlots.length;
    sub.details.usedArea = areas.reduce((s, a) => s + a, 0);
    sub.details.openArea = sub.openSpace.reduce((s, o) => s + o.area, 0);
    sub.details.biggestLabel = biggestIdx >= 0 ? plots[biggestIdx].name : null;
    sub.details.biggestArea = biggestIdx >= 0 ? areas[biggestIdx] : null;
    sub.details.smallestLabel = smallestIdx >= 0 ? plots[smallestIdx].name : null;
    sub.details.smallestArea = smallestIdx >= 0 ? areas[smallestIdx] : null;
  }
}

// The server-side params object for one sub-section, shared by /insert-plots, /resize-plot
// and /regenerate-fill so all three agree on the sizing rules.
function subsectionParams(sub) {
  const p = sub.params || {};
  return {
    minLength: p.minLength, maxLength: p.maxLength,
    minWidth: p.minWidth, maxWidth: p.maxWidth,
    minGap: p.minGap, roadThreshold: p.roadThreshold, maxPlots: p.maxPlots,
  };
}

function renderSubsectionDetails(sub) {
  const el = sub.detailsEl;
  const au = areaUnitLabel();
  if (!sub.details) {
    el.textContent = "";
    return;
  }
  if (sub.details.error) {
    el.textContent = sub.details.error;
    el.classList.add("closure-error");
    return;
  }
  el.classList.remove("closure-error");
  const lines = [
    `${sub.details.frontageCount} plot(s) placed (+ ${sub.details.fillCount} fill plot(s), dotted).`,
    `Used: ${sqFeetToDisplayArea(sub.details.usedArea).toFixed(1)} ${au} / Sub-section: ${sqFeetToDisplayArea(sub.details.subArea).toFixed(1)} ${au}`,
    `Open space: ${sqFeetToDisplayArea(sub.details.openArea || 0).toFixed(1)} ${au}`,
  ];
  // A naive area/(length x width) ceiling - ignores road frontage, shape, gaps and the +/-
  // range entirely, so it is always an OVER-estimate, never a target to hit. Its only job is
  // to give a sense of scale next to the real, shape-aware result: a huge gap between the two
  // is a hint the sub-section's frontage/shape (not a bug) is what's limiting it, worth
  // revisiting the road layout for rather than the plot size inputs.
  const tLen = sub.params && sub.params.targetLength, tWid = sub.params && sub.params.targetWidth;
  if (tLen > 0 && tWid > 0) {
    const approxMax = Math.floor(sub.details.subArea / (tLen * tWid));
    const actualCount = sub.details.frontageCount + sub.details.fillCount;
    lines.push(
      `Area-only estimate: up to ~${approxMax} plot(s) could fit by area alone (ignores road ` +
      `frontage/shape) - ${actualCount} actually placed.`
    );
  }
  if (sub.details.biggestLabel) {
    lines.push(`Biggest: ${sub.details.biggestLabel} (${sqFeetToDisplayArea(sub.details.biggestArea).toFixed(1)} ${au})`);
    lines.push(`Smallest: ${sub.details.smallestLabel} (${sqFeetToDisplayArea(sub.details.smallestArea).toFixed(1)} ${au})`);
  }
  if (sub.details.belowMin) {
    lines.push(`Below the requested minimum plot count - try a smaller target area or a smaller gap.`);
  }
  if (sub.details.frontageCount === 0 && (sub.details.generationNotes || []).length) {
    lines.push(`<span class="closure-error">No road-facing plots could be placed here:</span>`);
    sub.details.generationNotes.forEach((note) => {
      lines.push(`<span class="closure-error">&middot; ${note}.</span>`);
    });
  }
  (sub.details.invariantErrors || []).forEach((problem) => {
    lines.push(`<span class="closure-error">Geometry check: ${problem}</span>`);
  });
  el.innerHTML = lines.join("<br/>");
}

function buildSubsectionRow(sub) {
  const div = document.createElement("div");
  div.className = "road-row"; // reuse the same bordered-card look as a road row
  const field = (label, cls, value) =>
    `<div class="field"><label>${label}</label><input type="number" class="${cls}" step="any" min="0" value="${value}" /></div>`;
  div.innerHTML =
    `<h3 style="font-size:14px; margin: 0 0 8px;">Sub-section ${sub.index + 1}</h3>` +
    `<div class="row">` +
    field("Min number of plots", "sub-min-plots", 1) +
    field(`Plot length (${unitLabel()})`, "sub-plot-length", feetToDisplay(50).toFixed(1)) +
    field(`Plot width (${unitLabel()})`, "sub-plot-width", feetToDisplay(40).toFixed(1)) +
    field(`Max range (${unitLabel()})`, "sub-max-range", feetToDisplay(5).toFixed(1)) +
    `</div><div class="row" style="margin-top:8px;">` +
    field(`Min gap between two plots (${unitLabel()})`, "sub-min-gap", feetToDisplay(0).toFixed(1)) +
    field(`Plot roadside threshold (${unitLabel()})`, "sub-road-threshold", feetToDisplay(5).toFixed(1)) +
    `<div class="field"><label>&nbsp;</label><button type="button" class="sub-insert-btn">Insert plots</button></div>` +
    `</div>` +
    `<p class="hint sub-details" style="margin-top:8px;"></p>`;
  subsectionRowsEl.appendChild(div);

  sub.detailsEl = div.querySelector(".sub-details");
  // "Plot length"/"Plot width" is the target size the user actually thinks in; "Max range" is
  // how far above/below that target a plot may land - e.g. length=30, width=20, range=5 gives
  // the same maxLength=35/minLength=25/maxWidth=25/minWidth=15 the backend has always wanted,
  // without asking the user to keep two numbers per dimension in sync by hand. `insert_plots`'s
  // own sizing contract (minLength/maxLength/minWidth/maxWidth) is unchanged server-side - this
  // is purely how the two values feeding it are entered.
  const readParams = () => {
    const length = displayToFeet(parseFloat(div.querySelector(".sub-plot-length").value) || 0);
    const width = displayToFeet(parseFloat(div.querySelector(".sub-plot-width").value) || 0);
    const range = Math.max(0, displayToFeet(parseFloat(div.querySelector(".sub-max-range").value) || 0));
    return {
      minPlots: parseInt(div.querySelector(".sub-min-plots").value, 10) || 0,
      maxLength: length + range,
      minLength: Math.max(0, length - range),
      maxWidth: width + range,
      minWidth: Math.max(0, width - range),
      minGap: displayToFeet(parseFloat(div.querySelector(".sub-min-gap").value) || 0),
      roadThreshold: displayToFeet(parseFloat(div.querySelector(".sub-road-threshold").value) || 0),
      maxPlots: null,
      // Kept only so renderSubsectionDetails() can show a naive area/(length*width) capacity
      // estimate next to the real result - not sent to the server, which only ever wanted the
      // min/max range above.
      targetLength: length,
      targetWidth: width,
    };
  };

  div.querySelector(".sub-insert-btn").addEventListener("click", async () => {
    sub.params = readParams();
    const btn = div.querySelector(".sub-insert-btn");
    btn.disabled = true;
    sub.detailsEl.textContent = "Computing...";
    sub.detailsEl.classList.remove("closure-error");
    try {
      await insertPlotsForSubsection(sub);
    } finally {
      btn.disabled = false;
    }
    renderSubsectionDetails(sub);
    drawPlotLogicPreview();
  });
}

finalizeRoadLogicBtn.addEventListener("click", async () => {
  if (!currentVertices) {
    finalizeRoadLogicNoteEl.textContent = "Finalize the Metes & Bounds step first.";
    finalizeRoadLogicNoteEl.classList.add("closure-error");
    setMessage("Finish Metes & Bounds first - there's no plot boundary to carve roads into yet.", "error");
    return;
  }
  finalizeRoadLogicBtn.disabled = true;
  finalizeRoadLogicNoteEl.textContent = "Computing sub-sections...";
  finalizeRoadLogicNoteEl.classList.remove("closure-error");
  try {
    const body = {
      plot: { vertices: currentVertices },
      roads: roads.filter(Boolean).map((r) => ({
        start: r.start, end: r.end, width: r.width, buffer: r.buffer,
        path: r.path && r.path.length >= 2 ? r.path : [r.start, r.end],
        capDirStart: r.startCapDir, capDirEnd: r.endCapDir,
      })),
    };
    const res = await fetch("/compute-subsections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.success) {
      finalizeRoadLogicNoteEl.textContent = `[${data.stage || "error"}] ${data.error}`;
      finalizeRoadLogicNoteEl.classList.add("closure-error");
      setMessage(`[${data.stage || "error"}] ${data.error}`, "error");
      return;
    }
    subsections = data.subsections.map((s, i) => ({ vertices: s.vertices, index: i, params: null, plots: [], details: null, detailsEl: null }));
    subsectionRowsEl.innerHTML = "";
    subsections.forEach((sub) => buildSubsectionRow(sub));
    finalizeRoadLogicNoteEl.textContent = `${subsections.length} sub-section(s) found.`;
    drawPlotLogicPreview();
    setMessage(`Road logic finalized - ${subsections.length} sub-section(s) found.`, "info");
    advanceFrom("road");
  } catch (err) {
    finalizeRoadLogicNoteEl.textContent = `Network/parse error: ${err}`;
    finalizeRoadLogicNoteEl.classList.add("closure-error");
    setMessage(`Network/parse error: ${err}`, "error");
  } finally {
    finalizeRoadLogicBtn.disabled = false;
  }
});

// The full master-plan drawing (sub-sections, real/fill plots, roads) - shared by "Final
// master plan" and, once a master plan actually exists, by "Final site plan" and the Print
// Sheet export, so all three show the real subdivided plan instead of just the bare plot
// boundary the moment sub-sections/plots exist. `options.monochrome` is passed straight
// through to buildPlotSvg for the outer boundary's own text color only - "Final master plan"
// wants that (a plain black boundary label) while keeping its colored plot fills exactly as
// they are. `options.monochromePlots` is the separate, stronger switch that ALSO swaps every
// plot/sub-section/road color in here for the same ink-only neutral tones - only "Final site
// plan"/the Print Sheet export set it, since real vs fill plots still read apart there by
// solid-vs-dashed outline, not color, same as the rest of a printed presentation sheet.
function buildMasterPlanContentSvg(options) {
  const monochrome = !!(options && options.monochromePlots);
  const subsectionColor = monochrome ? "#5b6169" : "#2f6f4f";
  const realStrokeColor = monochrome ? "#1f2430" : "#2f6f4f";
  const realFillColor = monochrome ? "none" : "rgba(47,111,79,0.12)";
  const fillPlotStrokeColor = monochrome ? "#5b6169" : "#c87828";
  const fillPlotFillColor = monochrome ? "none" : "rgba(200,120,40,0.10)";
  const { svg: baseSvg, transform } = buildPlotSvg(currentVertices, options);
  let svg = openSpaceDefsSvg() + baseSvg;
  svg += internalRoadBandSvg(transform, monochrome);
  subsections.forEach((s, si) => {
    svg += `<polygon points="${polygonPoints(transform, s.vertices)}" fill="none" stroke="${subsectionColor}" stroke-width="1.5" />`;
    svg += openSpaceSvg(transform, s);
    (s.plots || []).forEach((plot, pi) => {
      const isFill = plot.fill;
      const pts = polygonPoints(transform, plot.vertices);
      if (isFill) {
        svg += `<polygon points="${pts}" fill="${fillPlotFillColor}" stroke="${fillPlotStrokeColor}" stroke-width="1" stroke-dasharray="3,3" />`;
      } else {
        svg += `<polygon points="${pts}" fill="${realFillColor}" stroke="${realStrokeColor}" stroke-width="1.2" />`;
      }
      if (!isFill || plot.area >= 60) {
        const pcen = centroidOf(plot.vertices);
        const ppc = transform(pcen);
        svg += `<text x="${ppc.x.toFixed(1)}" y="${ppc.y.toFixed(1)}" font-size="${isFill ? 7 : 9}" font-weight="600" fill="#1f2430" text-anchor="middle">${plot.name || `S${si + 1}P${pi + 1}`}</text>`;
        svg += plotSideLabelsSvg(transform, plot);
      }
    });
  });
  return { svg, transform };
}

// True once roads have been carved into sub-sections and at least one has been filled with
// plots - the point past which there's an actual master plan to show, not just the bare site
// boundary "Final site plan"/the Print Sheet fall back to before then.
function hasMasterPlanContent() {
  return subsections.length > 0 && subsections.some((s) => (s.plots || []).length > 0);
}

function drawMasterPlanPreview() {
  if (!currentVertices) {
    masterPlanSvgEl.innerHTML = "";
    return;
  }
  // "Final master plan" is a locked presentation view, same as "Final site plan" - the outer
  // boundary drops its corner letters and its length labels' color for the same reason: this
  // is the clean deliverable, not the working drawing that needed them for construction.
  const { svg } = buildMasterPlanContentSvg({ showVertices: false, showDiagonals: false, monochrome: true });
  masterPlanSvgEl.innerHTML = svg;
}

// ---- Plot editor: load one real plot by name and reshape it - by pushing one of its own
// edges (the area stepper) or by editing its sides/diagonals - with nothing else in the master
// plan allowed to move. Only committed on "Save plot". ----
//
// INDEPENDENT PLOTS. A real plot only ever grows into free residual land and only ever gives
// land back to the residual; no edit may move, reshape or re-save any OTHER real plot. Fill
// plots are not objects that can be edited at all - they are a derived view of
// `sub-section - union(real plots)` and get rebuilt from scratch by the server whenever a real
// plot changes. The previous model, where an edit dragged every plot sharing a corner along
// with it, is what let one plot's growth push a neighbour into a third plot.

let plotEditSession = null;
// {
//   subIndex, plotIndex, name,
//   originalVertices, workingVertices,      // both [{x,y}, ...], same length, sides frozen
//   anchorPos, anchorHeadingRad,             // where/how solveFromDiagonalGraph's local-space
//                                            // result gets placed back into real coordinates
//   frontageEdges,                           // indices of edges lying on a road - never pushable
//   pushEdgeIndex,                           // null = let the server pick (rear, then sides)
// }

function findFillPlotByName(name) {
  const target = name.trim().toUpperCase();
  if (!target) return null;
  for (let si = 0; si < subsections.length; si++) {
    const plots = subsections[si].plots || [];
    for (let pi = 0; pi < plots.length; pi++) {
      const p = plots[pi];
      if (p.fill && p.name && p.name.toUpperCase() === target) {
        return { subIndex: si, plotIndex: pi, plot: p };
      }
    }
  }
  return null;
}

// "Add plot": promote one or more fill plots (S{sub}F{n} - a derived leftover piece with no
// road frontage) into real plots. A promoted plot keeps its exact shape - it's already valid
// land, just reclassified - and gets the next chronological S{sub}P{n} name in its own
// sub-section, same as any other real plot. Several names (space/comma separated) can be
// promoted in one go, including from different sub-sections at once.
addPlotBtnEl.addEventListener("click", async () => {
  const raw = addPlotInputEl.value.trim();
  if (!raw) return;
  const names = raw.split(/[\s,]+/).filter(Boolean);

  const promoted = [];   // {subIndex, requestedName, plot}
  const notFound = [];
  const alreadyReal = [];
  names.forEach((rawName) => {
    if (findRealPlotByName(rawName)) {
      alreadyReal.push(rawName);
      return;
    }
    const found = findFillPlotByName(rawName);
    if (!found) {
      notFound.push(rawName);
      return;
    }
    found.plot.fill = false; // stays at its current position in sub.plots - see nameSubsectionPlots
    promoted.push({ subIndex: found.subIndex, requestedName: rawName, plot: found.plot });
  });

  if (!promoted.length) {
    addPlotNoteEl.textContent =
      (notFound.length ? `No fill plot found for: ${notFound.join(", ")}. ` : "") +
      (alreadyReal.length ? `Already a real plot: ${alreadyReal.join(", ")}.` : "");
    addPlotNoteEl.classList.add("closure-error");
    return;
  }

  addPlotNoteEl.textContent = "Adding...";
  addPlotNoteEl.classList.remove("closure-error");

  // Regenerate fill/open space for every affected sub-section - the promoted piece's land no
  // longer belongs to the residual, and this also assigns its real chronological name (fill
  // and real plots are both renumbered from their final array order, see nameSubsectionPlots).
  const affectedSubs = [...new Set(promoted.map((p) => p.subIndex))];
  const failed = [];
  for (const si of affectedSubs) {
    const sub = subsections[si];
    let data;
    try {
      const res = await fetch("/regenerate-fill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subsection: { vertices: sub.vertices },
          plots: sub.plots.map((pl) => ({ name: pl.name, fill: !!pl.fill, vertices: pl.vertices })),
          params: subsectionParams(sub),
        }),
      });
      data = await res.json();
    } catch (err) {
      failed.push(`S${si + 1}: network/parse error: ${err}`);
      continue;
    }
    if (!data.success || (data.invariantErrors || []).length) {
      // Roll back this sub-section's promotions rather than leave it in a half-applied state.
      promoted.filter((p) => p.subIndex === si).forEach((p) => { p.plot.fill = true; });
      failed.push(`S${si + 1}: ${data.error || (data.invariantErrors || [])[0] || "rejected"}`);
      continue;
    }
    applyRegeneratedFill(sub, data.fill, data.openSpace);
    renderSubsectionDetails(sub);
  }

  if (failed.length) {
    addPlotNoteEl.textContent = `Could not add plot(s): ${failed.join("; ")}.`;
    addPlotNoteEl.classList.add("closure-error");
  } else {
    addPlotNoteEl.textContent = `Added ${promoted.length} plot(s).` +
      (notFound.length ? ` Not found: ${notFound.join(", ")}.` : "") +
      (alreadyReal.length ? ` Already real: ${alreadyReal.join(", ")}.` : "");
    addPlotNoteEl.classList.remove("closure-error");
    addPlotInputEl.value = "";
  }
  drawPlotLogicPreview();
  if (plotEditSession) drawPlotEditorPreview();
});

function findAnyPlotByName(name) {
  const target = name.trim().toUpperCase();
  if (!target) return null;
  for (let si = 0; si < subsections.length; si++) {
    const plots = subsections[si].plots || [];
    for (let pi = 0; pi < plots.length; pi++) {
      const p = plots[pi];
      if (p.name && p.name.toUpperCase() === target) return { subIndex: si, plotIndex: pi, plot: p };
    }
  }
  return null;
}

// "Combine plots": merge two or more touching plots into ONE real plot, whatever shape that
// union turns out to be. Real and fill plots can be mixed - combining a fill piece into a real
// plot is how a plot absorbs the leftover land beside it, which the area stepper can't do when
// that land isn't reachable by pushing a single edge in a straight line.
combinePlotsBtnEl.addEventListener("click", async () => {
  const rawA = combinePlotAInputEl.value.trim();
  const rawB = combinePlotBInputEl.value.trim();

  const fail = (msg) => {
    combinePlotsNoteEl.textContent = msg;
    combinePlotsNoteEl.classList.add("closure-error");
  };

  if (!rawA || !rawB) {
    fail("Fill in both boxes - name one plot in each, e.g. S1P1 and S1F1.");
    return;
  }
  const names = [...new Set([rawA, rawB].map((n) => n.toUpperCase()))];
  if (names.length < 2) {
    fail("Those are the same plot - name two different ones.");
    return;
  }

  const found = names.map((n) => ({ name: n, hit: findAnyPlotByName(n) }));
  const missing = found.filter((f) => !f.hit).map((f) => f.name);
  if (missing.length) {
    fail(`No plot found for: ${missing.join(", ")}.`);
    return;
  }
  // A plot is one piece of land inside one sub-section - two plots separated by a road are not
  // combinable at all, so say that plainly rather than letting the server infer it from names.
  const subIndexes = [...new Set(found.map((f) => f.hit.subIndex))];
  if (subIndexes.length > 1) {
    fail(`Those plots are in different sub-sections (${subIndexes.map((i) => `S${i + 1}`).join(", ")}) - `
       + `a plot can't span a road, so they can't be combined.`);
    return;
  }

  const sub = subsections[subIndexes[0]];
  combinePlotsNoteEl.textContent = "Combining...";
  combinePlotsNoteEl.classList.remove("closure-error");

  let data;
  try {
    const res = await fetch("/combine-plots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subsection: { vertices: sub.vertices },
        plots: (sub.plots || []).map((pl) => ({ name: pl.name, fill: !!pl.fill, vertices: pl.vertices })),
        names,
        params: subsectionParams(sub),
      }),
    });
    data = await res.json();
  } catch (err) {
    fail(`Network/parse error: ${err}`);
    return;
  }
  if (!data.success) {
    fail(data.error || "That combine was refused.");
    return;
  }

  // The merged plot takes the earliest position of the plots it replaces, so the sub-section's
  // chronological P-numbering (applied by nameSubsectionPlots from array order) stays stable
  // instead of the combined plot jumping to the end of the list.
  const mergedIndexes = found.map((f) => f.hit.plotIndex).sort((a, b) => a - b);
  const insertAt = mergedIndexes[0];
  const doomed = new Set(mergedIndexes);
  const kept = (sub.plots || []).filter((_pl, i) => !doomed.has(i));
  const before = (sub.plots || []).filter((_pl, i) => !doomed.has(i) && i < insertAt).length;
  data.plot.fill = false;
  kept.splice(before, 0, data.plot);
  sub.plots = kept;

  // An in-progress edit anywhere in this sub-section has to go: the plot array was just
  // re-indexed and renamed underneath it, so the session's subIndex/plotIndex (and its working
  // vertices) can no longer be trusted to point at the plot the user thinks they're editing.
  if (plotEditSession && plotEditSession.subIndex === subIndexes[0]) {
    plotEditSession = null;
    plotEditFieldsEl.style.display = "none";
    plotNameInputEl.value = "";
    plotNameNoteEl.textContent = "";
    plotNameNoteEl.classList.remove("closure-error");
    plotAreaStepNoteEl.textContent = "";
    plotAreaStepNoteEl.classList.remove("closure-error");
  }

  applyRegeneratedFill(sub, data.fill, data.openSpace);
  renderSubsectionDetails(sub);

  const mergedName = (sub.plots[before] || {}).name || "the combined plot";
  // A land-balance/geometry note is reported, never treated as a failure: the merge is done and
  // committed by this point, and these numbers are usually a sub-square-foot drift the
  // sub-section was already carrying before the combine touched it.
  const notes = data.invariantErrors || [];
  combinePlotsNoteEl.textContent =
    `Combined ${names.join(" + ")} into ${mergedName} (${sqFeetToDisplayArea(data.plot.area).toFixed(1)} ${areaUnitLabel()}, ${data.plot.sides} sides).`
    + (notes.length ? ` Geometry note: ${notes[0]}` : "");
  combinePlotsNoteEl.classList.remove("closure-error");
  combinePlotAInputEl.value = "";
  combinePlotBInputEl.value = "";

  drawPlotLogicPreview();
  drawPlotEditorPreview();
});

function findRealPlotByName(name) {
  const target = name.trim().toUpperCase();
  if (!target) return null;
  for (let si = 0; si < subsections.length; si++) {
    const plots = subsections[si].plots || [];
    for (let pi = 0; pi < plots.length; pi++) {
      const p = plots[pi];
      if (!p.fill && p.name && p.name.toUpperCase() === target) {
        return { subIndex: si, plotIndex: pi, plot: p };
      }
    }
  }
  return null;
}

function plotEdgeLengths(vertices) {
  const n = vertices.length;
  const lengths = [];
  for (let i = 0; i < n; i++) {
    const a = vertices[i], b = vertices[(i + 1) % n];
    lengths.push(Math.hypot(b.x - a.x, b.y - a.y));
  }
  return lengths;
}

function plotDiagonalSeedLength(fromIndex, toIndex) {
  const verts = plotEditSession.workingVertices;
  if (verts[fromIndex] && verts[toIndex]) {
    const a = verts[fromIndex], b = verts[toIndex];
    return Math.hypot(b.x - a.x, b.y - a.y);
  }
  return displayToFeet(20);
}

function addPlotDiagonalRow(defaultFrom, defaultTo, removable) {
  // Same "required vs. over-specified" distinction as the site plot's own addDiagonalRow -
  // only a diagonal added on top of the N-3 that are actually needed gets a Remove button.
  const n = plotEditSession.workingVertices.length;
  const labels = labelsFor(n).map((l) => `${l}'`);
  const tr = document.createElement("tr");

  const fromTd = document.createElement("td");
  const fromSelect = document.createElement("select");
  fromSelect.className = "plot-diagonal-from-select";
  populateDiagonalSelect(fromSelect, n, labels, new Set());
  fromSelect.value = String(defaultFrom);
  fromTd.appendChild(fromSelect);
  tr.appendChild(fromTd);

  const toTd = document.createElement("td");
  const toSelect = document.createElement("select");
  toSelect.className = "plot-diagonal-to-select";
  toTd.appendChild(toSelect);
  tr.appendChild(toTd);
  populateDiagonalSelect(toSelect, n, labels, validDiagonalTargets(n, defaultFrom));
  if (defaultTo !== null && !validDiagonalTargets(n, defaultFrom).has(defaultTo)) {
    toSelect.value = String(defaultTo);
  }

  const inputTd = document.createElement("td");
  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.min = "0.01";
  input.className = "plot-diagonal-input";
  input.value = feetToDisplay(plotDiagonalSeedLength(parseInt(fromSelect.value, 10), parseInt(toSelect.value, 10))).toFixed(2);
  inputTd.appendChild(input);
  tr.appendChild(inputTd);

  const reseed = () => {
    input.value = feetToDisplay(plotDiagonalSeedLength(parseInt(fromSelect.value, 10), parseInt(toSelect.value, 10))).toFixed(2);
  };
  fromSelect.addEventListener("change", () => {
    populateDiagonalSelect(toSelect, n, labels, validDiagonalTargets(n, parseInt(fromSelect.value, 10)));
    reseed();
    rebuildPlotCornerPlacementRows();
    onPlotFieldChanged();
  });
  toSelect.addEventListener("change", () => {
    reseed();
    rebuildPlotCornerPlacementRows();
    onPlotFieldChanged();
  });
  input.addEventListener("input", onPlotFieldChanged);
  input.addEventListener("change", onPlotFieldChanged);

  const removeTd = document.createElement("td");
  if (removable) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "secondary diagonal-remove-btn";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => {
      tr.remove();
      rebuildPlotCornerPlacementRows();
      onPlotFieldChanged();
    });
    removeTd.appendChild(removeBtn);
  }
  tr.appendChild(removeTd);

  plotDiagonalRowsEl.appendChild(tr);
}

// Same purpose and logic as rebuildCornerPlacementRows() for the site/master boundary, applied
// to whichever plot is currently loaded in the editor - separate DOM, separate `plotCornerChoices`
// map, since a plot's corners (A'..) are a different label space from the boundary's (A..).
function rebuildPlotCornerPlacementRows() {
  if (!plotEditSession) return;
  const n = plotEditSession.workingVertices.length;
  const diagonalSpecs = readPlotDiagonalSpecs();
  const freeInfo = computeFreeCorners(n, diagonalSpecs);
  const tick = "′"; // the plot editor labels its own corners A′, B′, ... (never plain A, B)

  const stillFree = new Set(freeInfo.map((info) => info.label));
  Object.keys(plotCornerChoices).forEach((label) => { if (!stillFree.has(label)) delete plotCornerChoices[label]; });

  plotCornerPlacementRowsEl.innerHTML = "";
  if (!freeInfo.length) {
    plotCornerPlacementTableEl.style.display = "none";
    plotCornerPlacementNoteEl.textContent =
      "No ambiguous corners with the current diagonals - each one is fully pinned by its own two reference distances.";
    return;
  }
  plotCornerPlacementNoteEl.textContent =
    "Distance alone can't say which side of two reference corners a corner actually sits on - " +
    "leave \"Auto\" to let the shape decide (it avoids a self-crossing result automatically, " +
    "and warns when it had to guess), or set one directly if you know which side is right.";
  plotCornerPlacementTableEl.style.display = "table";

  freeInfo.forEach(({ label, i1Label, i2Label }) => {
    const tr = document.createElement("tr");
    // Same single-cell phrasing as the Metes & Bounds list above.
    const cornerTd = document.createElement("td");
    cornerTd.className = "corner-ref-cell";
    cornerTd.textContent = `${label}${tick} with respect to ${i1Label}${tick}${i2Label}${tick}`;
    tr.appendChild(cornerTd);
    const selectTd = document.createElement("td");
    const select = document.createElement("select");
    select.className = "plot-corner-bulge-select";
    select.innerHTML =
      `<option value="auto">Auto</option>` +
      `<option value="left">Left of ${i1Label}${tick}→${i2Label}${tick}</option>` +
      `<option value="right">Right of ${i1Label}${tick}→${i2Label}${tick}</option>`;
    select.value = plotCornerChoices[label] || "auto";
    select.addEventListener("change", () => {
      if (select.value === "auto") delete plotCornerChoices[label];
      else plotCornerChoices[label] = select.value;
      onPlotFieldChanged();
    });
    selectTd.appendChild(select);
    tr.appendChild(selectTd);
    plotCornerPlacementRowsEl.appendChild(tr);
  });
}

function readPlotLengths() {
  return Array.from(plotEdgeRowsEl.querySelectorAll("tr")).map(
    (r) => displayToFeet(parseFloat(r.querySelector(".plot-length-input").value) || 0)
  );
}

function readPlotDiagonalSpecs() {
  return Array.from(plotDiagonalRowsEl.querySelectorAll("tr")).map((tr) => ({
    from: parseInt(tr.querySelector(".plot-diagonal-from-select").value, 10),
    to: parseInt(tr.querySelector(".plot-diagonal-to-select").value, 10),
    length: displayToFeet(parseFloat(tr.querySelector(".plot-diagonal-input").value) || 0),
  }));
}

function updatePlotAreaNote() {
  const area = polygonArea(plotEditSession.workingVertices);
  const areaText = `${sqFeetToDisplayArea(area).toFixed(1)} ${areaUnitLabel()}`;
  plotAreaNoteEl.textContent = `Current area: ${areaText}`;
  plotAreaValueEl.textContent = areaText;
}

function buildPlotEditFields() {
  const session = plotEditSession;
  const n = session.workingVertices.length;
  const labels = labelsFor(n).map((l) => `${l}'`);

  plotSidesCountEl.value = n;

  plotEdgeRowsEl.innerHTML = "";
  const lengths = plotEdgeLengths(session.workingVertices);
  for (let i = 0; i < n; i++) {
    const tr = document.createElement("tr");
    const edgeTd = document.createElement("td");
    edgeTd.textContent = `${labels[i]}-${labels[(i + 1) % n]}`;
    tr.appendChild(edgeTd);
    const lengthTd = document.createElement("td");
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.min = "0.01";
    input.className = "plot-length-input";
    input.value = feetToDisplay(lengths[i]).toFixed(2);
    input.addEventListener("input", onPlotFieldChanged);
    input.addEventListener("change", onPlotFieldChanged);
    lengthTd.appendChild(input);
    tr.appendChild(lengthTd);
    plotEdgeRowsEl.appendChild(tr);
  }

  plotDiagonalRowsEl.innerHTML = "";
  const count = diagonalCount(n);
  if (count === 0) {
    plotDiagonalsTableEl.style.display = "none";
    addPlotDiagonalBtnEl.style.display = "none";
    plotDiagonalsNoteEl.textContent = "None needed - 3 sides alone fully determine a triangle.";
  } else {
    plotDiagonalsNoteEl.textContent =
      `${count} diagonal(s) needed to fully determine this ${n}-sided shape - seeded below from ` +
      `corner A', matching the plot's current shape.`;
    plotDiagonalsTableEl.style.display = "table";
    addPlotDiagonalBtnEl.style.display = "inline-block";
    for (let k = 2; k <= n - 2; k++) {
      addPlotDiagonalRow(0, k);
    }
  }
  rebuildPlotCornerPlacementRows();

  updatePlotAreaNote();
  plotAreaStepNoteEl.textContent = "";
  plotAreaStepNoteEl.classList.remove("closure-error");
}

// Client-side safety net before anything is committed: does this shape cut into the interior
// of another REAL plot in the same sub-section? Sharing a boundary with a neighbour is normal
// adjacency; actually overlapping it is not. Fill plots are ignored here on purpose - they are
// a derived view of the residual and get rebuilt around whatever the real plots end up being.
// Returns the colliding plot's name, or null.
function editWouldCauseUnrelatedOverlap(session, newVerts) {
  const plots = subsections[session.subIndex].plots || [];
  for (let oi = 0; oi < plots.length; oi++) {
    if (oi === session.plotIndex || plots[oi].fill) continue;
    if (polygonsOverlap(newVerts, plots[oi].vertices)) return plots[oi].name || `plot #${oi + 1}`;
  }
  return null;
}

// Re-solves the edited plot's shape from its current edge/diagonal field values and places the
// result back into real coordinates, anchored at the plot's own original first corner and first
// edge heading (so a plot doesn't drift or spin away just because one side length changed).
//
// Nothing else moves. Under the independent-plots model a manual edit may not drag a corner of
// any other real plot along with it, so if the solved shape collides with a neighbour or leaves
// the sub-section it is simply refused - the last valid shape stays on screen with an inline
// error naming what it hit, the same closure-failure UX the Site plan page already uses.
function recomputeWorkingVertices() {
  const session = plotEditSession;
  const lengths = readPlotLengths();
  const diagonalSpecs = readPlotDiagonalSpecs();
  const result = solveFromDiagonalGraph(lengths, diagonalSpecs, plotCornerChoices);
  if (!result.ok) {
    plotNameNoteEl.textContent = result.error;
    plotNameNoteEl.classList.add("closure-error");
    return false; // session.workingVertices untouched - last valid shape stays shown
  }
  // solveFromDiagonalGraph works in its own local frame and picks one of the two circle-
  // intersection branches at each step, so the shape it returns can come back mirrored
  // relative to the plot as stored (the plots the backend emits are all wound CCW). Anchoring
  // a mirrored solution at the same corner and heading flips the plot across its own first
  // edge - which put S1P1's far corners at x=233 instead of x=167, outside the sub-section, so
  // every manual edit was refused no matter how small. Match the winding before placing it.
  const flip = (signedArea(session.originalVertices) >= 0) === (signedArea(result.vertices) >= 0) ? 1 : -1;
  const cosA = Math.cos(session.anchorHeadingRad), sinA = Math.sin(session.anchorHeadingRad);
  const newVerts = result.vertices.map((p) => ({
    x: session.anchorPos.x + p.x * cosA - flip * p.y * sinA,
    y: session.anchorPos.y + p.x * sinA + flip * p.y * cosA,
  }));

  const editedSubVerts = subsections[session.subIndex].vertices;
  if (polygonArea(newVerts) < 1 || polygonSelfIntersects(newVerts)) {
    plotNameNoteEl.textContent =
      `That would make ${session.name}'s own shape invalid (self-intersecting or collapsed) - the edit wasn't applied.`;
    plotNameNoteEl.classList.add("closure-error");
    return false;
  }
  if (!plotStaysInsideSubsection(newVerts, editedSubVerts)) {
    plotNameNoteEl.textContent =
      `That would push ${session.name} past its sub-section boundary (into a road or the next ` +
      `block) - the edit wasn't applied.`;
    plotNameNoteEl.classList.add("closure-error");
    return false;
  }
  const hit = editWouldCauseUnrelatedOverlap(session, newVerts);
  if (hit) {
    plotNameNoteEl.textContent =
      `That would make ${session.name} overlap ${hit} - the edit wasn't applied. A plot can only ` +
      `grow into free land, never into another plot.`;
    plotNameNoteEl.classList.add("closure-error");
    return false;
  }

  session.workingVertices = newVerts;
  plotNameNoteEl.textContent = result.autoFixedCrossing
    ? `Editing ${session.name}. (Guessed corner placement for ${(result.autoFixedLabels || []).map((l) => l + "′").join(", ") || "an ambiguous corner"} to avoid a self-crossing shape - check Corner placement below if this doesn't look right.)`
    : `Editing ${session.name}.`;
  plotNameNoteEl.classList.remove("closure-error");
  return true;
}

function onPlotFieldChanged() {
  if (!plotEditSession) return;
  recomputeWorkingVertices();
  updatePlotAreaNote();
  plotAreaStepNoteEl.textContent = "";
  plotAreaStepNoteEl.classList.remove("closure-error");
  drawPlotEditorPreview();
}

// ---- Area stepper: parametric edge push, resolved server-side ----
//
// Growing or shrinking a plot means translating ONE of its own non-frontage edges along that
// edge's outward normal and re-intersecting it with its two neighbours, which keeps the side
// count fixed, slides its corners ALONG the sub-section boundary rather than through it, and
// never touches another plot. The previous client-side model moved corners diagonally along a
// bisector, so any corner sitting on the sub-section boundary was immediately pushed outside it
// and the whole edit was refused - which is why "maxed out" kept appearing with free land in
// plain view. The real polygon work (bisection for the largest feasible push, the invariant
// checks, and regenerating the fill/open space around the result) lives in site_geometry.py.

const AREA_PUSH_STEP_FT = 2.0;

// Rewrites the existing edge/diagonal input fields' values to match the plot's current working
// shape, without rebuilding the rows themselves - used after a live area push so the length
// values on screen track the new size, same as the user would see from a manual edit.
function syncPlotFieldValuesFromWorkingVertices() {
  const session = plotEditSession;
  const lengths = plotEdgeLengths(session.workingVertices);
  Array.from(plotEdgeRowsEl.querySelectorAll("tr")).forEach((tr, i) => {
    const input = tr.querySelector(".plot-length-input");
    if (input && lengths[i] !== undefined) input.value = feetToDisplay(lengths[i]).toFixed(2);
  });
  Array.from(plotDiagonalRowsEl.querySelectorAll("tr")).forEach((tr) => {
    const from = parseInt(tr.querySelector(".plot-diagonal-from-select").value, 10);
    const to = parseInt(tr.querySelector(".plot-diagonal-to-select").value, 10);
    const a = session.workingVertices[from], b = session.workingVertices[to];
    if (a && b) {
      tr.querySelector(".plot-diagonal-input").value = feetToDisplay(Math.hypot(b.x - a.x, b.y - a.y)).toFixed(2);
    }
  });
}

function plotEditRoadFacingEdges() {
  const sub = subsections[plotEditSession.subIndex];
  return buildFrontageRuns(sub.vertices).map((path) => ({ path }));
}

// Which of the loaded plot's edges lie on a road - the ones the server will refuse to push,
// mirrored here only so the "Push edge" dropdown doesn't offer them.
function plotFrontageEdgeIndices(verts, sub) {
  const runs = buildFrontageRuns(sub.vertices);
  const hits = [];
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const onRoad = runs.some((path) => {
      for (let k = 0; k < path.length - 1; k++) {
        if (distancePointToSegment(mid, path[k], path[k + 1]) <= 0.75) return true;
      }
      return false;
    });
    if (onRoad) hits.push(i);
  }
  return hits;
}

function buildPushEdgeOptions() {
  const session = plotEditSession;
  if (!session || !pushEdgeSelectEl) return;
  const verts = session.workingVertices;
  const labels = labelsFor(verts.length).map((l) => `${l}'`);
  pushEdgeSelectEl.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "Auto (rear, then sides)";
  pushEdgeSelectEl.appendChild(auto);
  for (let i = 0; i < verts.length; i++) {
    if (session.frontageEdges.includes(i)) continue; // a road frontage never moves
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `${labels[i]}-${labels[(i + 1) % verts.length]}`;
    pushEdgeSelectEl.appendChild(opt);
  }
  pushEdgeSelectEl.value = session.pushEdgeIndex === null ? "" : String(session.pushEdgeIndex);
}

async function stepPlotArea(direction) {
  const session = plotEditSession;
  if (!session) return;
  const sub = subsections[session.subIndex];
  plotAreaStepNoteEl.textContent = direction === "grow" ? "Growing..." : "Shrinking...";
  plotAreaStepNoteEl.classList.remove("closure-error");

  let data;
  try {
    const res = await fetch("/resize-plot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subsection: { vertices: sub.vertices },
        roadFacingEdges: plotEditRoadFacingEdges(),
        // The edited plot is sent with its live working shape so repeated clicks compound,
        // while every other plot is sent exactly as committed - the server may only move the
        // named one.
        plots: (sub.plots || []).map((pl, pi) => ({
          name: pl.name,
          fill: !!pl.fill,
          vertices: pi === session.plotIndex ? session.workingVertices : pl.vertices,
        })),
        plotName: session.name,
        params: subsectionParams(sub),
        direction,
        stepFt: AREA_PUSH_STEP_FT,
        edgeIndex: session.pushEdgeIndex,
      }),
    });
    data = await res.json();
  } catch (err) {
    plotAreaStepNoteEl.textContent = `Network/parse error: ${err}`;
    plotAreaStepNoteEl.classList.add("closure-error");
    return;
  }

  if (!data.success) {
    // The server names the constraint that actually stopped the push (a neighbouring plot, the
    // sub-section boundary, a side-count change, or a minimum dimension) rather than blaming
    // fill triangles, which no longer constrain anything at all.
    // A blocked GROW is also where the stepper's own design runs out: it slides one edge with the
    // side count fixed, so free land that isn't square-on to an edge is unreachable by it. Point
    // at the tool that can reach it rather than leaving a dead end.
    plotAreaStepNoteEl.textContent = (data.error || "That resize was refused.")
      + (direction === "grow"
          ? ` If there is still free land beside it, pick that side in "Push edge" above and use `
            + `"Expand to boundary" - it sweeps that side out and absorbs the land whatever shape it is.`
          : "");
    plotAreaStepNoteEl.classList.add("closure-error");
    return;
  }

  session.workingVertices = data.plot.vertices.map((v) => ({ x: v.x, y: v.y }));
  session.lastEdgePushed = data.edgePushed;
  session.pendingFill = data.fill;
  session.pendingOpenSpace = data.openSpace;
  syncPlotFieldValuesFromWorkingVertices();
  updatePlotAreaNote();
  const labels = labelsFor(session.workingVertices.length).map((l) => `${l}'`);
  const n = session.workingVertices.length;
  plotAreaStepNoteEl.textContent =
    `Pushed edge ${labels[data.edgePushed]}-${labels[(data.edgePushed + 1) % n]}. ` +
    `Click "Save plot" to keep it.`;
  plotAreaStepNoteEl.classList.remove("closure-error");
  plotNameNoteEl.textContent = `Editing ${session.name}.`;
  plotNameNoteEl.classList.remove("closure-error");
  drawPlotEditorPreview();
}

// "Expand to boundary": the escalation from the area stepper. Sweeps ONE chosen side straight
// outward and absorbs the free land it crosses, out to the sub-section edge / a road / the next
// plot - so unlike the stepper it can take land of any shape and the side count changes to match.
// A side must be chosen explicitly: with "Auto" the sweep direction would be a guess, and this
// takes far more land per click than a 2 ft push.
async function expandPlotToBoundary() {
  const session = plotEditSession;
  if (!session) return;
  if (session.pushEdgeIndex === null || session.pushEdgeIndex === undefined) {
    expandPlotNoteEl.textContent =
      `Choose which side to expand in "Push edge" above first - "Auto" doesn't say which way to sweep.`;
    expandPlotNoteEl.classList.add("closure-error");
    return;
  }
  const sub = subsections[session.subIndex];
  expandPlotNoteEl.textContent = "Expanding...";
  expandPlotNoteEl.classList.remove("closure-error");

  let data;
  try {
    const res = await fetch("/expand-plot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subsection: { vertices: sub.vertices },
        roadFacingEdges: plotEditRoadFacingEdges(),
        plots: (sub.plots || []).map((pl, pi) => ({
          name: pl.name,
          fill: !!pl.fill,
          vertices: pi === session.plotIndex ? session.workingVertices : pl.vertices,
        })),
        plotName: session.name,
        edgeIndex: session.pushEdgeIndex,
        params: subsectionParams(sub),
      }),
    });
    data = await res.json();
  } catch (err) {
    expandPlotNoteEl.textContent = `Network/parse error: ${err}`;
    expandPlotNoteEl.classList.add("closure-error");
    return;
  }
  if (!data.success) {
    expandPlotNoteEl.textContent = data.error || "That expansion was refused.";
    expandPlotNoteEl.classList.add("closure-error");
    return;
  }

  // Same pending-edit contract as the stepper: live until "Save plot", undone by "Reset plot".
  const before = session.workingVertices.length;
  session.workingVertices = data.plot.vertices.map((v) => ({ x: v.x, y: v.y }));
  session.lastEdgePushed = null;
  session.pendingFill = data.fill;
  session.pendingOpenSpace = data.openSpace;

  // The side count changed, so everything derived from the vertex list is stale and has to be
  // rebuilt from the new shape - not just the edge/diagonal tables and corner-placement rows,
  // but the anchor (taken from vertices 0 and 1), which edges now count as road frontage, and
  // the chosen push edge, whose old index points at a different side of a different polygon.
  const verts = session.workingVertices;
  session.anchorPos = { x: verts[0].x, y: verts[0].y };
  session.anchorHeadingRad = Math.atan2(verts[1].y - verts[0].y, verts[1].x - verts[0].x);
  session.frontageEdges = plotFrontageEdgeIndices(verts, sub);
  session.pushEdgeIndex = null;
  plotCornerChoices = {};
  buildPlotEditFields();
  syncPlotFieldValuesFromWorkingVertices();
  buildPushEdgeOptions();
  updatePlotAreaNote();
  plotNameNoteEl.textContent = `Editing ${session.name} (${verts.length} sides).`;
  plotNameNoteEl.classList.remove("closure-error");

  const notes = data.invariantErrors || [];
  expandPlotNoteEl.textContent =
    `Absorbed ${sqFeetToDisplayArea(data.absorbedArea).toFixed(1)} ${areaUnitLabel()} of free land`
    + (data.pocketCount ? ` (including ${data.pocketCount} pocket(s) it would otherwise have sealed off)` : "")
    + `; ${before} -> ${session.workingVertices.length} sides. Click "Save plot" to keep it.`
    + (notes.length ? ` Geometry note: ${notes[0]}` : "");
  expandPlotNoteEl.classList.remove("closure-error");
  plotAreaStepNoteEl.textContent = "";
  plotAreaStepNoteEl.classList.remove("closure-error");
  drawPlotEditorPreview();
}

plotAreaPlusBtnEl.addEventListener("click", () => stepPlotArea("grow"));
plotAreaMinusBtnEl.addEventListener("click", () => stepPlotArea("shrink"));
if (expandPlotBtnEl) expandPlotBtnEl.addEventListener("click", expandPlotToBoundary);
if (pushEdgeSelectEl) {
  pushEdgeSelectEl.addEventListener("change", () => {
    if (!plotEditSession) return;
    plotEditSession.pushEdgeIndex = pushEdgeSelectEl.value === "" ? null : parseInt(pushEdgeSelectEl.value, 10);
    drawPlotEditorPreview();
  });
}

// The vertices to actually draw for one plot: the live working copy for the plot being edited,
// and whatever is committed for everything else. No other plot has a "live" state any more -
// an edit can't move one.
function plotDisplayVertices(subIndex, plotIndex) {
  const session = plotEditSession;
  const committed = subsections[subIndex].plots[plotIndex].vertices;
  if (!session) return committed;
  if (subIndex === session.subIndex && plotIndex === session.plotIndex) return session.workingVertices;
  return committed;
}

function loadPlotForEditing(name) {
  const found = findRealPlotByName(name);
  if (!found) {
    plotEditSession = null;
    plotEditFieldsEl.style.display = "none";
    plotNameNoteEl.textContent = `No real plot named "${name}" found - check the name (e.g. S1P1). Fill plots (S1F1, ...) are derived from the leftover land and aren't editable.`;
    plotNameNoteEl.classList.add("closure-error");
    plotAreaStepNoteEl.textContent = "";
    plotAreaStepNoteEl.classList.remove("closure-error");
    drawPlotEditorPreview();
    return;
  }
  const { subIndex, plotIndex, plot } = found;
  plotCornerChoices = {}; // a different plot (or the same one reloaded) means different corners
  const originalVertices = plot.vertices.map((v) => ({ x: v.x, y: v.y }));
  const dx = originalVertices[1].x - originalVertices[0].x;
  const dy = originalVertices[1].y - originalVertices[0].y;
  plotEditSession = {
    subIndex, plotIndex, name: plot.name,
    originalVertices,
    workingVertices: originalVertices.map((v) => ({ x: v.x, y: v.y })),
    anchorPos: { x: originalVertices[0].x, y: originalVertices[0].y },
    anchorHeadingRad: Math.atan2(dy, dx),
    frontageEdges: plotFrontageEdgeIndices(originalVertices, subsections[subIndex]),
    pushEdgeIndex: null,
    lastEdgePushed: null,
    pendingFill: null,
    pendingOpenSpace: null,
  };
  plotNameNoteEl.textContent = `Editing ${plot.name} (${originalVertices.length} sides).`;
  plotNameNoteEl.classList.remove("closure-error");
  savePlotNoteEl.textContent = "";
  savePlotNoteEl.classList.remove("closure-error");
  buildPlotEditFields();
  buildPushEdgeOptions();
  plotEditFieldsEl.style.display = "block";
  drawPlotEditorPreview();
}

function drawPlotEditorPreview() {
  if (!currentVertices) {
    plotEditorSvgEl.innerHTML = "";
    return;
  }
  const { svg: baseSvg, transform } = buildPlotSvg(currentVertices, { showVertices: true, showDiagonals: false });
  let svg = openSpaceDefsSvg() + baseSvg;
  svg += internalRoadBandSvg(transform);
  const session = plotEditSession;
  subsections.forEach((s, si) => {
    svg += `<polygon points="${polygonPoints(transform, s.vertices)}" fill="none" stroke="#2f6f4f" stroke-width="1.5" />`;
    // While an un-saved resize is pending, show the fill/open space the server rebuilt around
    // it rather than the committed view, so the display matches what Save would actually keep.
    const pendingSub = session && si === session.subIndex && session.pendingFill;
    svg += openSpaceSvg(transform, pendingSub ? { openSpace: session.pendingOpenSpace } : s);
    if (pendingSub) {
      (session.pendingFill || []).forEach((pl) => {
        svg += `<polygon points="${polygonPoints(transform, pl.vertices)}" fill="rgba(200,120,40,0.10)" stroke="#c87828" stroke-width="1" stroke-dasharray="3,3" />`;
      });
    }
    (s.plots || []).forEach((plot, pi) => {
      const isEdited = !!session && si === session.subIndex && pi === session.plotIndex;
      if (pendingSub && plot.fill) return; // superseded by the pending fill drawn above
      const verts = plotDisplayVertices(si, pi);
      const isFill = plot.fill;
      const pts = polygonPoints(transform, verts);
      if (isEdited) {
        svg += `<polygon points="${pts}" fill="rgba(31,111,180,0.18)" stroke="#1f6fb4" stroke-width="2" />`;
      } else if (isFill) {
        svg += `<polygon points="${pts}" fill="rgba(200,120,40,0.10)" stroke="#c87828" stroke-width="1" stroke-dasharray="3,3" />`;
      } else {
        // .plot-hit marks this polygon as clickable - it is a real plot, so the SVG click
        // handler will load it for editing. Fill plots and open space deliberately don't get it,
        // since clicking those only ever produces a "not editable" message.
        svg += `<polygon class="plot-hit" points="${pts}" fill="rgba(47,111,79,0.12)" stroke="#2f6f4f" stroke-width="1.2" />`;
      }
      if (!isFill || plot.area >= 60 || isEdited) {
        const pcen = centroidOf(verts);
        const ppc = transform(pcen);
        svg += `<text x="${ppc.x.toFixed(1)}" y="${ppc.y.toFixed(1)}" font-size="${isFill && !isEdited ? 7 : 9}" font-weight="600" fill="#1f2430" text-anchor="middle">${plot.name || `S${si + 1}P${pi + 1}`}</text>`;
        svg += plotSideLabelsSvg(transform, { vertices: verts, fill: isFill, area: polygonArea(verts) });
      }
      if (isEdited) {
        // The edge the next +/- click will push (explicitly chosen, or the last one the server
        // picked automatically) is drawn thick so it's obvious which side is about to move.
        const highlight = session.pushEdgeIndex !== null ? session.pushEdgeIndex : session.lastEdgePushed;
        if (highlight !== null && highlight !== undefined && verts[highlight]) {
          const a = transform(verts[highlight]);
          const b = transform(verts[(highlight + 1) % verts.length]);
          svg += `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#e8830c" stroke-width="3.5" stroke-linecap="round" />`;
        }
        const cornerLabels = labelsFor(verts.length).map((l) => `${l}'`);
        verts.forEach((v, vi) => {
          const p = transform(v);
          svg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.2" fill="#1f6fb4" stroke="none" />`;
          svg += `<text x="${(p.x + 6).toFixed(1)}" y="${(p.y - 6).toFixed(1)}" font-size="7" font-weight="700" fill="#1f6fb4">${cornerLabels[vi]}</text>`;
        });
      }
    });
  });
  plotEditorSvgEl.innerHTML = svg;
  lastEditorTransform = transform; // so a click on the drawing can be mapped back to feet
}

// Simple O(n^2) non-adjacent segment-intersection check - plots here are always small polygons
// (at most a handful of sides), so this is plenty fast and needs no spatial indexing.
// A real plot must stay within the sub-section it belongs to - editing a shared corner freely
// could otherwise stretch a plot straight into the road strip or past the sub-section's own
// outer edge, which is just as much "bad geometry" for a real plot as self-intersecting. Each
// corner is nudged slightly toward the sub-section's centroid before testing, same reasoning
// as elsewhere in this app: ray-casting containment is unreliable for a point sitting exactly
// on a boundary edge, which a plot's own corner very often does by construction.
// A plot corner is acceptable when it is inside the sub-section, or sitting on its boundary
// within `tol` - which is exactly where "Expand to boundary" is supposed to put corners.
//
// This used to nudge each corner 0.05 ft TOWARDS the sub-section's centroid and require the
// nudged point to be inside. That only holds for a convex sub-section: on a concave one - which
// is most of them once roads cut the block up - the direction from a corner sitting in a notch
// to the overall centroid can leave the polygon immediately, so a perfectly legal corner tested
// as "outside". Measuring distance to the boundary instead is direction-free and behaves the
// same way on concave and convex shapes. The server still does the authoritative containment
// check (an area difference against the real polygon); this is only the inline safety net.
function plotStaysInsideSubsection(verts, subVertices) {
  const tol = 0.05;
  const n = subVertices.length;
  return verts.every((v) => {
    if (pointInPolygon(v, subVertices)) return true;
    for (let i = 0; i < n; i++) {
      if (distancePointToSegment(v, subVertices[i], subVertices[(i + 1) % n]) <= tol) return true;
    }
    return false;
  });
}

function ccw3(a, b, c) {
  return (c.y - a.y) * (b.x - a.x) - (b.y - a.y) * (c.x - a.x);
}

// Strict "proper crossing" test - two segments that merely touch at a shared endpoint (as
// every pair of edges around a polygon, or two genuinely adjacent plots' shared boundary, does)
// are NOT considered intersecting, only a true transversal crossing counts.
function properSegmentsIntersect(p1, p2, p3, p4) {
  const d1 = ccw3(p3, p4, p1), d2 = ccw3(p3, p4, p2), d3 = ccw3(p1, p2, p3), d4 = ccw3(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function polygonSelfIntersects(verts) {
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const a1 = verts[i], a2 = verts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i || j === (i + 1) % n || (j + 1) % n === i) continue; // adjacent edges share a vertex
      const b1 = verts[j], b2 = verts[(j + 1) % n];
      if (properSegmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

function distancePointToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// "Inside" here means genuinely inside, not just touching the boundary - a point sitting on
// (or within `tol` of) an edge is treated as boundary/touching, not overlap, since adjacent
// plots sharing an edge or corner is completely normal and must not be flagged.
function pointStrictlyInsidePolygon(pt, poly, tol) {
  if (!pointInPolygon(pt, poly)) return false;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    if (distancePointToSegment(pt, poly[i], poly[(i + 1) % n]) < tol) return false;
  }
  return true;
}

// Do these two plot polygons share real interior area (not just a common edge/corner)? Used as
// a final safety net after any live-edit propagation - two plots merely touching along a shared
// boundary is normal adjacency, but one plot's edge actually cutting into another's interior
// means the edit went further than it should have, even if each shape checked out on its own.
function polygonsOverlap(polyA, polyB) {
  const tol = 0.1;
  // Measured purely as DEPTH of penetration, sampled along both boundaries. The obvious test -
  // "do any two edges properly cross?" - cannot be used here, because it has no tolerance: two
  // plots that legitimately share a boundary wobble across it by a few thousandths of a foot
  // once both have been snapped onto the coordinate grid, and every one of those micro-crossings
  // is a genuine proper intersection. That made adjacency itself read as overlap (measured case:
  // a 62 ft shared edge, 0.0176 sqft of "overlap" at 0.0009 ft deep - one hundredth of an inch -
  // blocking a save the server had already checked and passed). Sampling depth instead ignores
  // anything shallower than `tol` while still catching a plot genuinely cutting into another,
  // and it needs no polygon-clipping in JS. properSegmentsIntersect is still the right tool for
  // the self-intersection check, where a crossing is a crossing at any scale.
  const SAMPLES_PER_EDGE = 16;
  const boundarySamples = (poly) => {
    const pts = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      for (let s = 0; s < SAMPLES_PER_EDGE; s++) {
        const t = s / SAMPLES_PER_EDGE;
        pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    return pts;
  };
  for (const p of boundarySamples(polyA)) {
    if (pointStrictlyInsidePolygon(p, polyB, tol)) return true;
  }
  for (const p of boundarySamples(polyB)) {
    if (pointStrictlyInsidePolygon(p, polyA, tol)) return true;
  }
  return false;
}

plotNameInputEl.addEventListener("input", () => {
  const name = plotNameInputEl.value.trim();
  if (!name) {
    plotEditSession = null;
    plotEditFieldsEl.style.display = "none";
    plotNameNoteEl.textContent = "";
    plotNameNoteEl.classList.remove("closure-error");
    savePlotNoteEl.textContent = "";
    plotAreaStepNoteEl.textContent = "";
    plotAreaStepNoteEl.classList.remove("closure-error");
    drawPlotEditorPreview();
    return;
  }
  loadPlotForEditing(name);
});

addPlotDiagonalBtnEl.addEventListener("click", () => {
  addPlotDiagonalRow(0, null, true);
  rebuildPlotCornerPlacementRows();
  onPlotFieldChanged();
});

resetPlotBtnEl.addEventListener("click", () => {
  if (!plotEditSession) return;
  loadPlotForEditing(plotEditSession.name); // reloads fresh from the still-untouched committed data
});

savePlotBtnEl.addEventListener("click", async () => {
  const session = plotEditSession;
  if (!session) return;

  // Client-side safety net. The server re-checks all of this (and the full per-sub-section
  // invariants) when it regenerates the fill below, but refusing an obviously-bad shape here
  // keeps the failure next to the fields that caused it.
  const editedArea = polygonArea(session.workingVertices);
  const sub = subsections[session.subIndex];
  if (editedArea < 1 || polygonSelfIntersects(session.workingVertices) || !plotStaysInsideSubsection(session.workingVertices, sub.vertices)) {
    savePlotNoteEl.textContent = `Bad geometry warning: ${session.name}'s own shape is invalid (self-intersecting, collapsed, or pokes outside its sub-section/into a road) - adjust the values and try again.`;
    savePlotNoteEl.classList.add("closure-error");
    return;
  }
  const hit = editWouldCauseUnrelatedOverlap(session, session.workingVertices);
  if (hit) {
    savePlotNoteEl.textContent = `Bad geometry warning: this change would make ${session.name} overlap ${hit} - adjust the values and try again.`;
    savePlotNoteEl.classList.add("closure-error");
    return;
  }

  // Only the edited plot's own polygon is written. Every other real plot is left exactly as it
  // was; the fill and open space are then rebuilt from the residual the new shape leaves behind.
  const plot = sub.plots[session.plotIndex];
  const previousVertices = plot.vertices;
  const previousArea = plot.area;
  plot.vertices = session.workingVertices;
  plot.area = editedArea;

  savePlotNoteEl.textContent = "Saving...";
  savePlotNoteEl.classList.remove("closure-error");
  let data;
  try {
    const res = await fetch("/regenerate-fill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subsection: { vertices: sub.vertices },
        plots: sub.plots.map((pl) => ({ name: pl.name, fill: !!pl.fill, vertices: pl.vertices })),
        params: subsectionParams(sub),
      }),
    });
    data = await res.json();
  } catch (err) {
    plot.vertices = previousVertices;
    plot.area = previousArea;
    savePlotNoteEl.textContent = `Network/parse error: ${err}`;
    savePlotNoteEl.classList.add("closure-error");
    return;
  }
  if (!data.success) {
    plot.vertices = previousVertices;
    plot.area = previousArea;
    savePlotNoteEl.textContent = `[${data.stage || "error"}] ${data.error}`;
    savePlotNoteEl.classList.add("closure-error");
    return;
  }
  if ((data.invariantErrors || []).length) {
    plot.vertices = previousVertices;
    plot.area = previousArea;
    savePlotNoteEl.textContent = `Bad geometry warning: ${data.invariantErrors[0]} - the save was rolled back.`;
    savePlotNoteEl.classList.add("closure-error");
    setMessage(`${data.invariantErrors[0]} - the save was rolled back.`, "error");
    return;
  }

  applyRegeneratedFill(sub, data.fill, data.openSpace);
  sub.invariantErrors = [];
  if (sub.details) sub.details.invariantErrors = [];
  renderSubsectionDetails(sub);

  const savedName = session.name;
  loadPlotForEditing(savedName); // fresh session from the now-committed data
  // After the reload, not before - loadPlotForEditing() clears this note as part of starting a
  // new session, which used to wipe the confirmation the instant it was written.
  savePlotNoteEl.textContent = `${savedName} saved. Fill and open space rebuilt around it.`;
  savePlotNoteEl.classList.remove("closure-error");
  drawPlotLogicPreview();
});

finalizePlotLogicBtn.addEventListener("click", () => {
  if (!subsections.length) {
    finalizePlotLogicNoteEl.textContent = "Finalize road logic first so there are sub-sections to fill.";
    finalizePlotLogicNoteEl.classList.add("closure-error");
    setMessage("Finish Road Logic first - there are no sub-sections to fill yet.", "error");
    return;
  }
  const notReady = subsections.filter((s) => !s.details || s.details.error);
  if (notReady.length) {
    const msg =
      `Insert plots for every sub-section first - Sub-section ${notReady.map((s) => s.index + 1).join(", ")} ` +
      `${notReady.length > 1 ? "haven't" : "hasn't"} been filled yet.`;
    finalizePlotLogicNoteEl.textContent = msg;
    finalizePlotLogicNoteEl.classList.add("closure-error");
    setMessage(msg, "error");
    return;
  }
  finalizePlotLogicNoteEl.textContent = "";
  finalizePlotLogicNoteEl.classList.remove("closure-error");
  drawPlotEditorPreview();
  setMessage("Plot logic finalized - click any real plot on the drawing to edit it.", "info");
  advanceFrom("plots");
});

// Locks in a clean, combined presentation of every sub-section's plots together, plus totals
// across the whole master plan - the plot-logic equivalent of the site plan's own "Finalise
// site plan" step. Requires every sub-section to have had "Insert plots" run at least once,
// since finalizing before that would just present an empty/partial plan as if it were done.
finalizeMasterPlanBtn.addEventListener("click", () => {
  if (!subsections.length) {
    finalizeMasterPlanNoteEl.textContent = "Finalize road logic first so there are sub-sections to fill.";
    finalizeMasterPlanNoteEl.classList.add("closure-error");
    setMessage("Finish Road Logic first - there are no sub-sections to fill yet.", "error");
    return;
  }
  const notReady = subsections.filter((s) => !s.details || s.details.error);
  if (notReady.length) {
    const msg =
      `Insert plots for every sub-section first - Sub-section ${notReady.map((s) => s.index + 1).join(", ")} ` +
      `${notReady.length > 1 ? "haven't" : "hasn't"} been filled yet.`;
    finalizeMasterPlanNoteEl.textContent = msg;
    finalizeMasterPlanNoteEl.classList.add("closure-error");
    setMessage(msg, "error");
    return;
  }

  finalizeMasterPlanNoteEl.textContent = "";
  finalizeMasterPlanNoteEl.classList.remove("closure-error");
  drawMasterPlanPreview();

  let totalFrontage = 0, totalFill = 0, totalUsed = 0, totalOpen = 0, totalSubArea = 0;
  let biggest = null, smallest = null;
  subsections.forEach((s) => {
    totalFrontage += s.details.frontageCount || 0;
    totalFill += s.details.fillCount || 0;
    totalUsed += s.details.usedArea || 0;
    totalOpen += s.details.openArea || 0;
    totalSubArea += s.details.subArea || 0;
    (s.plots || []).forEach((plot, pi) => {
      const entry = { label: plot.name || `S${s.index + 1}P${pi + 1}`, area: plot.area, fill: plot.fill };
      if (!biggest || entry.area > biggest.area) biggest = entry;
      if (!smallest || entry.area < smallest.area) smallest = entry;
    });
  });

  const au = areaUnitLabel();
  const lines = [
    `<strong>${subsections.length}</strong> sub-section(s), <strong>${totalFrontage}</strong> road-facing plot(s) + <strong>${totalFill}</strong> fill plot(s).`,
    `Used: ${sqFeetToDisplayArea(totalUsed).toFixed(1)} ${au} / Master plan land: ${sqFeetToDisplayArea(totalSubArea).toFixed(1)} ${au}`,
    `Open space: ${sqFeetToDisplayArea(totalOpen).toFixed(1)} ${au}`,
  ];
  if (biggest) lines.push(`Biggest plot: ${biggest.label}${biggest.fill ? " (fill)" : ""} (${sqFeetToDisplayArea(biggest.area).toFixed(1)} ${au})`);
  if (smallest) lines.push(`Smallest plot: ${smallest.label}${smallest.fill ? " (fill)" : ""} (${sqFeetToDisplayArea(smallest.area).toFixed(1)} ${au})`);
  masterPlanSummaryEl.innerHTML = lines.join("<br/>");
  masterPlanSummaryEl.style.display = "block";
  masterPlanCardEl.style.display = "block";
  setMessage("Master plan finalized - set the drawing's north orientation next.", "info");
  advanceFrom("editor");
});
  // =======================================================================================
  // Shared shell behaviour. Same code for both tools; separate state per instance.
  // =======================================================================================

  // ---- Zoom / pan --------------------------------------------------------------------
  // One wrapper around whatever SVG the current step renders - deliberately NOT implemented
  // per step. Zoom/pan survives editing fields on the same tab (that is the whole point: watch
  // a change land without losing your zoom) and resets to 100% on every tab switch.
  const ZOOM_MIN = 0.4, ZOOM_MAX = 8, ZOOM_FACTOR = 1.25;
  let zoom = 1, panX = 0, panY = 0;

  function applyZoom() {
    zoomCanvasEl.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    zoomLevelEl.textContent = `${Math.round(zoom * 100)}%`;
  }
  function resetZoom() {
    zoom = 1; panX = 0; panY = 0;
    // Also disarm a pan's click-suppression: the browser fires that synthetic click straight
    // after the gesture, so anything still armed by the time we reset (a tab switch, a Fit
    // click) is stale and would otherwise swallow a genuine selection click later on.
    suppressNextClick = false;
    applyZoom();
  }
  function setZoom(next) {
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    applyZoom();
  }
  $("zoomInBtn").addEventListener("click", () => setZoom(zoom * ZOOM_FACTOR));
  $("zoomOutBtn").addEventListener("click", () => setZoom(zoom / ZOOM_FACTOR));
  $("zoomFitBtn").addEventListener("click", resetZoom);

  // Click-drag to pan. A pan that actually moved must not also register as a plot click in
  // the Plot Editor, so it arms `suppressNextClick` for exactly the one click the browser
  // synthesises at the end of that gesture. (Latching on `dragMoved` alone instead would stay
  // armed forever after the first pan and silently eat every later selection click.)
  let dragging = false, dragStartX = 0, dragStartY = 0, dragMoved = false;
  let pressX = 0, pressY = 0;
  let suppressNextClick = false;
  const DRAG_THRESHOLD_PX = 3;   // below this the gesture is a click, not a pan
  zoomViewportEl.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || zoomControlsEl.contains(ev.target)) return;
    if (zoomViewportEl.classList.contains("no-zoom")) return;   // e.g. the sheet-preview iframe
    dragging = true;
    dragMoved = false;
    pressX = ev.clientX;
    pressY = ev.clientY;
    // Pointer capture is deliberately NOT taken here. While an element holds pointer capture the
    // browser retargets the whole gesture to it - including the `click` it synthesises at the
    // end - so capturing on every press meant a plain click on the drawing was delivered to this
    // viewport and never reached the plot polygon underneath. That is what made click-to-select
    // in the Plot Editor do nothing at all. Capture is taken below instead, only once the
    // gesture has actually become a pan.
  });
  zoomViewportEl.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    if (!dragMoved) {
      // Measured from where the press STARTED. The old test compared against the previous
      // move's position, so a slow drag could travel any distance without ever tripping it,
      // while a fast flick tripped it immediately.
      if (Math.abs(ev.clientX - pressX) <= DRAG_THRESHOLD_PX
          && Math.abs(ev.clientY - pressY) <= DRAG_THRESHOLD_PX) return;
      dragMoved = true;
      // Re-anchor at the moment panning begins so the drawing doesn't jump by the threshold.
      dragStartX = ev.clientX - panX;
      dragStartY = ev.clientY - panY;
      try { zoomViewportEl.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable */ }
      zoomViewportEl.classList.add("panning");
    }
    panX = ev.clientX - dragStartX;
    panY = ev.clientY - dragStartY;
    applyZoom();
  });
  const endDrag = (ev) => {
    if (!dragging) return;
    dragging = false;
    if (dragMoved) suppressNextClick = true;
    dragMoved = false;
    zoomViewportEl.classList.remove("panning");
    try { zoomViewportEl.releasePointerCapture(ev.pointerId); } catch (e) { /* already released */ }
  };
  zoomViewportEl.addEventListener("pointerup", endDrag);
  zoomViewportEl.addEventListener("pointercancel", endDrag);

  // ---- Step navigation and gating ----------------------------------------------------
  const stepOrder = def.steps.map((s) => s.key);
  const stepLabel = (key) => (def.steps.find((s) => s.key === key) || {}).label || key;
  const finalized = {};              // step key -> true once that step's finalize succeeded
  let currentStep = null;
  const tabEls = {};

  // The first step the user hasn't finalized yet is the one that is actually editable.
  // Everything before it is a finished step shown read-only; everything after it is locked.
  function firstOpenIndex() {
    for (let i = 0; i < stepOrder.length; i++) {
      if (!finalized[stepOrder[i]]) return i;
    }
    return stepOrder.length - 1;
  }

  // Which earlier step is blocking `key`, if any - named explicitly so a locked tab can say
  // "Finish Road Logic first" rather than just "locked".
  function blockerFor(key) {
    const target = stepOrder.indexOf(key);
    for (let i = 0; i < target; i++) {
      if (!finalized[stepOrder[i]]) return stepOrder[i];
    }
    return null;
  }

  function buildTabs() {
    stepTabsEl.innerHTML = "";
    def.steps.forEach((s) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "step-tab";
      tab.dataset.step = s.key;
      tab.textContent = s.label;
      tab.addEventListener("click", () => {
        const blocker = blockerFor(s.key);
        if (blocker) {
          // A disabled tab does not navigate - it explains itself in the same message area
          // every other step-level error uses.
          setMessage(`Finish ${stepLabel(blocker)} first - ${s.label} isn't reachable until it's finalized.`, "error");
          return;
        }
        goToStep(s.key);
      });
      stepTabsEl.appendChild(tab);
      tabEls[s.key] = tab;
    });
  }

  function refreshTabs() {
    const open = firstOpenIndex();
    stepOrder.forEach((key, i) => {
      const tab = tabEls[key];
      const locked = !!blockerFor(key);
      tab.classList.toggle("locked", locked);
      tab.classList.toggle("done", i < open);
      tab.classList.toggle("active", key === currentStep);
      tab.setAttribute("aria-disabled", locked ? "true" : "false");
    });
  }

  // Revisiting an already-finalized step is a read-only view: this task builds no
  // invalidation cascade, so re-opening a finished step for editing would let a later step's
  // data silently disagree with the earlier step it was derived from.
  // `scope` is the live layout (form host + action bar), NOT the step node - by the time this
  // runs the step's slots have already been moved into the split layout, so querying the step
  // node itself would find nothing and silently leave a finalized step fully editable.
  function setStepReadOnly(scopes, on) {
    scopes.forEach((scope) => scope.querySelectorAll("input, select, textarea, button").forEach((el) => {
      if (on) {
        if (el.dataset.origDisabled === undefined) el.dataset.origDisabled = el.disabled ? "1" : "0";
        el.disabled = true;
      } else if (el.dataset.origDisabled !== undefined) {
        el.disabled = el.dataset.origDisabled === "1";
        delete el.dataset.origDisabled;
      }
    }));
  }

  function goToStep(key) {
    if (currentStep === key) return;
    // Park the outgoing step's slots back on their own node so its values/listeners survive.
    if (currentStep) {
      const prev = stepNodes[currentStep];
      ["step-diagram", "step-legend", "step-actions", "step-form", "step-extra-left"].forEach((cls) => {
        const slot = root.querySelector(`.${cls}[data-owner="${currentStep}"]`);
        if (slot) prev.appendChild(slot);
      });
    }
    currentStep = key;
    const node = stepNodes[key];
    const move = (cls, target) => {
      const slot = node.querySelector(`:scope > .${cls}`);
      target.innerHTML = "";
      if (slot) {
        slot.dataset.owner = key;
        target.appendChild(slot);
      }
    };
    move("step-diagram", zoomCanvasEl);
    move("step-legend", legendHostEl);
    move("step-extra-left", extraLeftHostEl);
    move("step-actions", actionHostEl);
    move("step-form", formHostEl);

    const readOnly = stepOrder.indexOf(key) < firstOpenIndex();
    readonlyBannerEl.style.display = readOnly ? "block" : "none";
    setStepReadOnly([formHostEl, actionHostEl], readOnly);

    // Per your instruction: zoom/pan is per-step-visit, so every tab switch starts at 100%.
    resetZoom();
    clearMessage();
    paneRightEl.scrollTop = 0;
    // The fixed north arrow belongs to the North Setter, the one step whose whole job is
    // lining the drawing up against it.
    $("northIndicator").style.display = key === "north" ? "block" : "none";
    const stepDef = def.steps.find((s) => s.key === key) || {};
    zoomControlsEl.style.display = stepDef.noZoom ? "none" : "flex";
    zoomViewportEl.classList.toggle("no-zoom", !!stepDef.noZoom);
    refreshTabs();
    onStepShown(key);
  }

  function markFinalized(key) {
    finalized[key] = true;
    refreshTabs();
  }

  // A finalize writes its own outcome message (info, or warning when the backend repaired
  // something) and then navigates; goToStep clears the message area on arrival, so the
  // outcome is carried across rather than being wiped the instant it is written.
  function advanceFrom(key) {
    const carried = messageAreaEl.textContent;
    const carriedSeverity = messageAreaEl.dataset.severity;
    markFinalized(key);
    const i = stepOrder.indexOf(key);
    if (i >= 0 && i + 1 < stepOrder.length) goToStep(stepOrder[i + 1]);
    if (carried) setMessage(carried, carriedSeverity);
  }

  // Each step redraws itself on arrival, so a diagram is never stale from a previous visit.
  // Road Logic / Plot Logic still only recompute on their own buttons - this just re-renders
  // the last computed state, which is what those steps show by design.
  function onStepShown(key) {
    if (key === "mb") { if (currentVertices) drawPreview(currentVertices, lastBuildable); }
    else if (key === "road") drawRoadLogicPreview();
    else if (key === "plots") drawPlotLogicPreview();
    else if (key === "editor") drawPlotEditorPreview();
    else if (key === "north") renderFinalSitePlan();
    else if (key === "print") {
      renderFinalSitePlan();   // re-read the finalised angle before rendering the sheet
      schedulePreview(0);
    }
  }

  // ---- North Setter finalize ---------------------------------------------------------
  $("finalizeNorthBtn").addEventListener("click", () => {
    if (!currentVertices) {
      $("finalizeNorthNote").textContent = "Finalize the plot boundary first.";
      $("finalizeNorthNote").classList.add("closure-error");
      setMessage("There's no drawing to orient yet - finish Metes & Bounds first.", "error");
      return;
    }
    const rotation = ((parseFloat(rotationInputEl.value) || 0) % 360 + 360) % 360;
    $("finalizeNorthNote").textContent = "";
    $("finalizeNorthNote").classList.remove("closure-error");
    renderFinalSitePlan();
    setMessage(
      rotation === 0
        ? "North finalised with the drawing unrotated (its own north already points up)."
        : `North finalised - the drawing is rotated ${rotation}° to line its true north up with the arrow.`,
      "info",
    );
    advanceFrom("north");
  });

  // ---- Metes & Bounds finalize -------------------------------------------------------
  $("finalizeSiteBtn").addEventListener("click", async () => {
    const ok = await computeSite();
    if (!ok) return;   // computeSite() already wrote the blocking error into the message area
    advanceFrom("mb");
  });

  // ---- Plot Editor: click a plot on the drawing to select it -------------------------
  // Plain even-odd ray cast. Carried over from uttam-5 (where it sat in the Building Footprint
  // block, which uttam-6 drops) because plotStaysInsideSubsection()/pointStrictlyInsidePolygon()
  // in the plot editor still depend on it - losing it silently broke every "Save plot".
  function pointInPolygon(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      const intersect = (yi > pt.y) !== (yj > pt.y) &&
        pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  plotEditorSvgEl.addEventListener("click", (ev) => {
    if (suppressNextClick) {               // that was the tail of a pan gesture, not a selection
      suppressNextClick = false;
      return;
    }
    if (!lastEditorTransform || !lastEditorTransform.inverse) return;
    const ctm = plotEditorSvgEl.getScreenCTM();
    if (!ctm) return;
    const p = plotEditorSvgEl.createSVGPoint();
    p.x = ev.clientX; p.y = ev.clientY;
    const local = p.matrixTransform(ctm.inverse());       // SVG user units
    const world = lastEditorTransform.inverse(local);     // plot feet

    for (let si = 0; si < subsections.length; si++) {
      const sub = subsections[si];
      const plots = sub.plots || [];
      for (let pi = 0; pi < plots.length; pi++) {
        const verts = plotDisplayVertices(si, pi);
        if (!pointInPolygon(world, verts)) continue;
        if (plots[pi].fill) {
          // Fill plots are a derived view of the leftover land, not editable objects.
          setMessage(`${plots[pi].name || "That region"} is a fill plot, not an editable plot. Promote it with "Add plot" first.`, "info");
          return;
        }
        // An in-progress edit on a different plot is discarded without a prompt, matching the
        // existing "nothing is permanent until Save plot" rule.
        clearMessage();
        plotNameInputEl.value = plots[pi].name;
        loadPlotForEditing(plots[pi].name);
        return;
      }
    }
    // Nothing editable under the cursor. Anywhere inside the site boundary that isn't a real
    // plot is open space (or a road strip / a hairline gap between plots), so say so once
    // rather than going silent - testing against the site boundary rather than each
    // sub-section's own polygon deliberately, since open space very often hugs a sub-section
    // edge and an exact ray cast there is a coin flip. A click out in the margin stays quiet.
    if (currentVertices && pointInPolygon(world, currentVertices)) {
      setMessage("Not an editable plot - only road-facing (real) plots can be edited.", "info");
    }
  });

  // ---- Print Sheet: stage 1 (editable preview) / stage 2 (full-screen final) ----------
  let previewTimer = null;
  let previewBusy = false;

  function schedulePreview(delayMs) {
    if (currentStep !== "print") return;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshSheetPreview, delayMs === undefined ? 500 : delayMs);
  }

  async function refreshSheetPreview() {
    if (previewBusy || !currentVertices) return;
    previewBusy = true;
    pdfNoteEl.textContent = "Refreshing preview...";
    try {
      renderFinalSitePlan();
      const doc = await generatePdf();
      if (!doc) return;
      pdfPreviewFrameEl.src = String(doc.output("bloburl"));
      pdfNoteEl.textContent = "Preview up to date.";
    } catch (err) {
      pdfNoteEl.textContent = `Preview failed: ${err}`;
      setMessage(`Could not render the sheet preview: ${err}`, "error");
    } finally {
      previewBusy = false;
    }
  }

  // Text edits are the only thing that can change the sheet here; geometry and computed areas
  // are read-only in this step by design.
  stepNodes.print.querySelectorAll("input, select, textarea").forEach((el) => {
    const ev = el.type === "file" || el.tagName === "SELECT" || el.type === "radio" ? "change" : "input";
    el.addEventListener(ev, () => schedulePreview());
  });

  $("previewPdfBtn").addEventListener("click", () => schedulePreview(0));

  $("continueSheetBtn").addEventListener("click", async () => {
    if (!currentVertices) {
      setMessage("Finalize this tool's plot boundary before building a sheet.", "error");
      return;
    }
    setMessage("Rendering the final sheet...", "info");
    let doc;
    try {
      renderFinalSitePlan();
      doc = await generatePdf();
    } catch (err) {
      setMessage(`Could not render the final sheet: ${err}`, "error");
      return;
    }
    if (!doc) return;
    finalSheetFrameEl.src = String(doc.output("bloburl"));
    $("finalSheetTitle").textContent = `${def.title} - final sheet (locked)`;
    finalSheetEl.style.display = "flex";
    downloadPdfBtn.disabled = false;
    clearMessage();
  });

  // Stage 2 is never a one-way door.
  $("backToEditBtn").addEventListener("click", () => {
    finalSheetEl.style.display = "none";
  });

  $("downloadFinalBtn").addEventListener("click", () => {
    if (lastPdfDoc) lastPdfDoc.save(`${toolKey}_sheet.pdf`);
  });

  $("homeBtn").addEventListener("click", () => showHome());

  // TEMPORARY, for easy testing of the self-intersection auto-fix in solveFromDiagonalGraph
  // (see the "Corner-flipping self-intersection fix" note in uttam-6/CLAUDE.md) - pre-fills
  // Metes & Bounds with the exact real 12-gon that exposed the bug (a diagonal graph the old
  // heuristic resolved to a self-crossing shape) instead of the default 4-sided square, so the
  // fix is visible on page load with no manual data entry. Safe to delete this whole function
  // and its one call site below once the fix has been exercised enough to trust; it changes
  // nothing about the solver itself.
  function seedDiagonalGraphTestCase() {
    const testLengths = [140, 61, 50, 88, 75, 87, 68, 67, 42, 54, 46, 84]; // A-B, B-C, ..., L-A
    const testDiagonals = [
      ["L", "B", 184], ["L", "C", 200], ["L", "D", 214], ["L", "E", 154],
      ["E", "K", 128], ["E", "J", 144], ["E", "I", 130],
      ["I", "F", 165], ["F", "H", 140],
    ];
    const n = testLengths.length;
    const idxOf = (letter) => letter.charCodeAt(0) - 65;
    const labels = labelsFor(n);

    sidesCountEl.value = n;
    buildEdgeRows(); // n-sided rows + the (n-3) required diagonal rows, fan-from-A default

    regularToggleEl.checked = false;
    regularToggleEl.dispatchEvent(new Event("change"));

    Array.from(edgeRowsEl.querySelectorAll("tr")).forEach((tr, i) => {
      tr.querySelector(".length-input").value = feetToDisplay(testLengths[i]).toFixed(2);
    });

    // Overwrite the default fan-from-A diagonals with this specific graph (measured between
    // whichever corners were actually convenient on site) - same count (n-3=9), just different
    // endpoints, so no rows need adding or removing.
    Array.from(diagonalRowsEl.querySelectorAll("tr")).forEach((tr, i) => {
      const [fromLabel, toLabel, length] = testDiagonals[i];
      const fromIdx = idxOf(fromLabel), toIdx = idxOf(toLabel);
      const fromSelect = tr.querySelector(".diagonal-from-select");
      const toSelect = tr.querySelector(".diagonal-to-select");
      fromSelect.value = String(fromIdx);
      populateDiagonalSelect(toSelect, n, labels, validDiagonalTargets(n, fromIdx));
      toSelect.value = String(toIdx);
      tr.querySelector(".diagonal-input").value = feetToDisplay(length).toFixed(2);
    });

    rebuildCornerPlacementRows(); // the diagonal endpoints above were set directly, without a
                                  // "change" event - the Corner placement list otherwise still
                                  // reflects buildEdgeRows()'s original fan-from-A default
    resolveAndRedraw();
  }

  // ---- Boot this instance ------------------------------------------------------------
  buildTabs();
  updateUnitLabels();
  updateMirrorBtn();
  buildEdgeRows();
  goToStep(stepOrder[0]);
  seedDiagonalGraphTestCase(); // TEMPORARY - see comment above; must run AFTER goToStep, which
                                // clears the message area on every navigation (including this
                                // first one) and would otherwise wipe the warning this sets.

  return {
    root,
    // Exposed only so the CDP test harness can inspect each instance's own state directly
    // and prove the two tools really are separate objects. Nothing in the app reads these
    // across instances, and there is no path from one instance's debug handle to another's.
    debug: {
      toolKey,
      get currentVertices() { return currentVertices; },
      get lastBuildable() { return lastBuildable; },
      get roads() { return roads; },
      get subsections() { return subsections; },
      get plotEditSession() { return plotEditSession; },
      get finalized() { return finalized; },
      get currentStep() { return currentStep; },
      get zoom() { return { zoom, panX, panY }; },
      readLengths: () => readLengths(),
      sheetFields: () => ({
        adminName: adminNameInputEl.value,
        wardNo: wardNoInputEl.value,
        surveyor: surveyorNameInputEl.value,
        rotation: rotationInputEl.value,
      }),
    },
  };
}

// ---------------------------------------------------------------------------------------
// Home screen router. Holds WHICH tool is mounted - never any tool's data.
// ---------------------------------------------------------------------------------------
const homeScreenEl = document.getElementById("homeScreen");
const toolHostEl = document.getElementById("toolHost");
const homeNoteEl = document.getElementById("homeNote");
let activeTool = null;

function showHome() {
  activeTool = null;
  toolHostEl.innerHTML = "";     // destroys the instance; its state goes with it
  toolHostEl.style.display = "none";
  homeScreenEl.style.display = "block";
  homeNoteEl.textContent = "";
}

function openTool(key) {
  homeScreenEl.style.display = "none";
  toolHostEl.style.display = "block";
  // A fresh instance every time - documents aren't persisted or listed yet, so opening a tool
  // always starts empty rather than resuming whatever was open before.
  activeTool = createTool(key, toolHostEl);
}

document.querySelectorAll(".home-card").forEach((card) => {
  card.addEventListener("click", () => {
    const key = card.dataset.tool;
    if (card.classList.contains("disabled")) {
      homeNoteEl.textContent = `${card.querySelector(".home-card-title").textContent} is coming soon - it isn't built yet.`;
      return;
    }
    openTool(key);
  });
});

showHome();

// Test-harness handle only (see createTool's `debug` above for why this exists).
window.__uttam = {
  openTool,
  showHome,
  get active() { return activeTool; },
};
