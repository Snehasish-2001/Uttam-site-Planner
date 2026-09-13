// uttam-5 - page 2 (site plan) client logic.
//
// Geometry model: with N side lengths fixed, a simple polygon has only N-3 truly free
// parameters (a triangle needs none - SSS fully determines it; a quadrilateral needs
// exactly one; a pentagon two; ...). Instead of angles, this uses the same triangulation
// technique architects/surveyors actually use on site: measure diagonals from one corner
// (A) with a tape measure, no angle tool needed. A fan of (N-3) diagonals from A splits
// the polygon into (N-2) triangles, each fully determined by SSS (SIDE-SIDE-SIDE, no
// ambiguity beyond the usual left/right mirror choice) via circle-circle intersection -
// closed-form, no iteration.

// Feet is the canonical unit everywhere internally (matching layout_geometry.py, the
// /compute-site payload, and every other part of this project) - the unit selector only
// changes what's typed/displayed on this page. Every geometric computation still happens
// in feet; values are converted at the input/output boundary only.
const FT_PER_M = 3.280839895;
const SQFT_PER_KATHA = 720; // West Bengal/Bangladesh convention (20 Chatak = 1 Katha)
const SQFT_PER_CHATAK = 36;
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
  const lengthHeader = document.getElementById("lengthHeader");
  const setbackHeader = document.getElementById("setbackHeader");
  const roadWidthHeader = document.getElementById("roadWidthHeader");
  const diagonalLengthHeader = document.getElementById("diagonalLengthHeader");
  const roadExtensionLabel = document.getElementById("roadExtensionLabel");
  const footprintLengthHeader = document.getElementById("footprintLengthHeader");
  const footprintStartXLabel = document.getElementById("footprintStartXLabel");
  const footprintStartYLabel = document.getElementById("footprintStartYLabel");
  if (lengthHeader) lengthHeader.textContent = `Length (${u})`;
  if (setbackHeader) setbackHeader.textContent = `Setback (${u})`;
  if (roadWidthHeader) roadWidthHeader.textContent = `Road width (${u})`;
  if (diagonalLengthHeader) diagonalLengthHeader.textContent = `Length (${u})`;
  if (roadExtensionLabel) roadExtensionLabel.textContent = `Road extension (${u}, each side)`;
  if (footprintLengthHeader) footprintLengthHeader.textContent = `Length (${u})`;
  if (footprintStartXLabel) footprintStartXLabel.textContent = `Start X (${u})`;
  if (footprintStartYLabel) footprintStartYLabel.textContent = `Start Y (${u})`;
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
  // expects them), never shown to the user anymore.
  const n = vertices.length;
  return vertices.map((v, i) => {
    const prev = vertices[(i - 1 + n) % n];
    const next = vertices[(i + 1) % n];
    const v1 = { x: prev.x - v.x, y: prev.y - v.y };
    const v2 = { x: next.x - v.x, y: next.y - v.y };
    const a1 = Math.atan2(v1.y, v1.x);
    const a2 = Math.atan2(v2.y, v2.x);
    let ang = ((a1 - a2) * 180) / Math.PI;
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

function solveFromDiagonalGraph(lengths, diagonalSpecs) {
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

  const pts = new Array(n).fill(null);
  pts[0] = { x: 0, y: 0 };
  pts[1] = { x: lengths[0], y: 0 };
  let placedCount = 2;
  let progress = true;
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
        };
      }
      pts[k] = pickOutward(pts.filter((p) => p !== null), solutions);
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
    };
  }
  return { ok: true, vertices: pts };
}

const unitSelectEl = document.getElementById("unitSelect");
const sidesCountEl = document.getElementById("sidesCount");
const regularToggleEl = document.getElementById("regularToggle");
const regularNoteEl = document.getElementById("regularNote");
const edgeRowsEl = document.getElementById("edgeRows");
const diagonalRowsEl = document.getElementById("diagonalRows");
const diagonalsTableEl = document.getElementById("diagonalsTable");
const diagonalsNoteEl = document.getElementById("diagonalsNote");
const diagonalAddBtnEl = document.getElementById("addDiagonalBtn");
const computeBtn = document.getElementById("computeBtn");
const closureNoteEl = document.getElementById("closureNote");
const svgEl = document.getElementById("sitePreviewSvg");
const statusLogEl = document.getElementById("statusLog");
const errorBoxEl = document.getElementById("errorBox");
const resultBoxEl = document.getElementById("resultBox");
const roadExtensionEl = document.getElementById("roadExtension");
const areaSummaryEl = document.getElementById("areaSummary");
const finaliseBtn = document.getElementById("finaliseBtn");
const rotationInputEl = document.getElementById("rotationInput");
const finalSvgEl = document.getElementById("finalSitePlanSvg");
const northIndicatorEl = document.getElementById("northIndicator");
const adminTypeSelectEl = document.getElementById("adminTypeSelect");
const adminNameInputEl = document.getElementById("adminNameInput");
const adminNameLabelEl = document.getElementById("adminNameLabel");
const wardNoInputEl = document.getElementById("wardNoInput");
const rsKhatianInputEl = document.getElementById("rsKhatianInput");
const rsPlotInputEl = document.getElementById("rsPlotInput");
const csPlotInputEl = document.getElementById("csPlotInput");
const sketchScaleNTSEl = document.getElementById("sketchScaleNTS");
const sketchScaleToScaleEl = document.getElementById("sketchScaleToScale");
const sketchScaleRatioRowEl = document.getElementById("sketchScaleRatioRow");
const sketchScaleXEl = document.getElementById("sketchScaleX");
const sketchScaleYEl = document.getElementById("sketchScaleY");
const siteScaleNTSEl = document.getElementById("siteScaleNTS");
const siteScaleToScaleEl = document.getElementById("siteScaleToScale");
const siteScaleRatioRowEl = document.getElementById("siteScaleRatioRow");
const siteScaleXEl = document.getElementById("siteScaleX");
const siteScaleYEl = document.getElementById("siteScaleY");
const mouzaScaleNTSEl = document.getElementById("mouzaScaleNTS");
const mouzaScaleToScaleEl = document.getElementById("mouzaScaleToScale");
const mouzaScaleRatioRowEl = document.getElementById("mouzaScaleRatioRow");
const mouzaScaleXEl = document.getElementById("mouzaScaleX");
const mouzaScaleYEl = document.getElementById("mouzaScaleY");
const surveyorNameInputEl = document.getElementById("surveyorNameInput");
const surveyorRegdInputEl = document.getElementById("surveyorRegdInput");
const drawnByInputEl = document.getElementById("drawnByInput");
const additionalNotesInputEl = document.getElementById("additionalNotesInput");
const mouzaMapInputEl = document.getElementById("mouzaMapInput");
const previewPdfBtn = document.getElementById("previewPdfBtn");
const downloadPdfBtn = document.getElementById("downloadPdfBtn");
const pdfNoteEl = document.getElementById("pdfNote");
const pdfPreviewFrameEl = document.getElementById("pdfPreviewFrame");
const addRoadBtnEl = document.getElementById("addRoadBtn");
const roadLogicSvgEl = document.getElementById("roadLogicSvg");
const roadRowsEl = document.getElementById("roadRows");
const roadLogicNoteEl = document.getElementById("roadLogicNote");
const finalizeRoadLogicBtn = document.getElementById("finalizeRoadLogicBtn");
const finalizeRoadLogicNoteEl = document.getElementById("finalizeRoadLogicNote");
const plotLogicCardEl = document.getElementById("plotLogicCard");
const plotLogicSvgEl = document.getElementById("plotLogicSvg");
const plotLogicNoteEl = document.getElementById("plotLogicNote");
const subsectionRowsEl = document.getElementById("subsectionRows");
const finalizeMasterPlanBtn = document.getElementById("finalizeMasterPlanBtn");
const finalizeMasterPlanNoteEl = document.getElementById("finalizeMasterPlanNote");
const masterPlanCardEl = document.getElementById("masterPlanCard");
const masterPlanSvgEl = document.getElementById("masterPlanSvg");
const masterPlanSummaryEl = document.getElementById("masterPlanSummary");
const finalizePlotLogicBtn = document.getElementById("finalizePlotLogicBtn");
const finalizePlotLogicNoteEl = document.getElementById("finalizePlotLogicNote");
const plotEditorCardEl = document.getElementById("plotEditorCard");
const plotEditorSvgEl = document.getElementById("plotEditorSvg");
const addPlotInputEl = document.getElementById("addPlotInput");
const addPlotBtnEl = document.getElementById("addPlotBtn");
const addPlotNoteEl = document.getElementById("addPlotNote");
const plotNameInputEl = document.getElementById("plotNameInput");
const plotNameNoteEl = document.getElementById("plotNameNote");
const plotEditFieldsEl = document.getElementById("plotEditFields");
const plotSidesCountEl = document.getElementById("plotSidesCount");
const plotEdgeRowsEl = document.getElementById("plotEdgeRows");
const plotDiagonalsNoteEl = document.getElementById("plotDiagonalsNote");
const plotDiagonalsTableEl = document.getElementById("plotDiagonalsTable");
const plotDiagonalRowsEl = document.getElementById("plotDiagonalRows");
const addPlotDiagonalBtnEl = document.getElementById("addPlotDiagonalBtn");
const plotAreaNoteEl = document.getElementById("plotAreaNote");
const plotAreaMinusBtnEl = document.getElementById("plotAreaMinusBtn");
const plotAreaPlusBtnEl = document.getElementById("plotAreaPlusBtn");
const plotAreaValueEl = document.getElementById("plotAreaValue");
const plotAreaStepNoteEl = document.getElementById("plotAreaStepNote");
const pushEdgeSelectEl = document.getElementById("pushEdgeSelect");
const resetPlotBtnEl = document.getElementById("resetPlotBtn");
const savePlotBtnEl = document.getElementById("savePlotBtn");
const savePlotNoteEl = document.getElementById("savePlotNote");
const footprintEntryCardEl = document.getElementById("footprintEntryCard");
const importSiteplanBtn = document.getElementById("importSiteplanBtn");
const uploadSiteplanBtn = document.getElementById("uploadSiteplanBtn");
const uploadSiteplanCardEl = document.getElementById("uploadSiteplanCard");
const footprintCardEl = document.getElementById("footprintCard");
const footprintSvgEl = document.getElementById("footprintSvg");
const footprintPlaceholderNoteEl = document.getElementById("footprintPlaceholderNote");
const footprintSidesCountEl = document.getElementById("footprintSidesCount");
const footprintStartXEl = document.getElementById("footprintStartX");
const footprintStartYEl = document.getElementById("footprintStartY");
const footprintCornerNoteEl = document.getElementById("footprintCornerNote");
const footprintRowsEl = document.getElementById("footprintRows");
const footprintPreviewBtn = document.getElementById("footprintPreviewBtn");
const footprintStatusNoteEl = document.getElementById("footprintStatusNote");
const footprintAreaSummaryEl = document.getElementById("footprintAreaSummary");
const footprintErrorBoxEl = document.getElementById("footprintErrorBox");
const changeShapeBtn = document.getElementById("changeShapeBtn");
const changeShapeFieldEl = document.getElementById("changeShapeField");
const footprintIrregularToggleEl = document.getElementById("footprintIrregularToggle");
const footprintRectilinearGroupEl = document.getElementById("footprintRectilinearGroup");
const footprintIrregularGroupEl = document.getElementById("footprintIrregularGroup");
const footprintIrregularRowsEl = document.getElementById("footprintIrregularRows");
const footprintDiagonalsNoteEl = document.getElementById("footprintDiagonalsNote");
const footprintDiagonalsTableEl = document.getElementById("footprintDiagonalsTable");
const footprintDiagonalRowsEl = document.getElementById("footprintDiagonalRows");

let mouzaMapDataUrl = null;
let lastPdfDoc = null;

let lastBuildable = null;   // stashed for page 3 (footprint) to reuse later
let footprintDefaultsInitialized = false;
let lastFootprintVertices = null;
let lastFootprintGapWalk = null;
let footprintOrientation = 0;    // which of the 4 corner-rotations of the current template is showing
let footprintCurrentAngles = []; // the template's own angle values - not user-editable anymore
let currentVertices = null; // the last successfully resolved plot polygon (local coords)
let lastBuildableAreaSqft = null;
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

function showError(message) {
  errorBoxEl.style.display = "block";
  errorBoxEl.textContent = message;
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

function buildEdgeRows() {
  const n = Math.max(3, Math.min(20, parseInt(sidesCountEl.value, 10) || 4));
  sidesCountEl.value = n;
  const labels = labelsFor(n);
  const regularAngle = ((n - 2) * 180) / n;

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
    const roleSelect = document.createElement("select");
    roleSelect.className = "role-select";
    [
      ["", "-"],
      ["front", "Front"],
      ["road", "Road"],
      ["front_road", "Front / Road"],
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
    const setbackInput = document.createElement("input");
    setbackInput.type = "number";
    setbackInput.step = "0.5";
    setbackInput.min = "0";
    setbackInput.value = feetToDisplay(0).toFixed(2);
    setbackInput.className = "setback-input";
    setbackTd.appendChild(setbackInput);
    tr.appendChild(setbackTd);

    const roadWidthTd = document.createElement("td");
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

    const neighbourNameTd = document.createElement("td");
    const neighbourNameInput = document.createElement("input");
    neighbourNameInput.type = "text";
    neighbourNameInput.className = "neighbour-name-input";
    neighbourNameInput.placeholder = "e.g. Ajit Mandal";
    neighbourNameInput.addEventListener("input", () => drawPreview(currentVertices, lastBuildable));
    neighbourNameTd.appendChild(neighbourNameInput);
    tr.appendChild(neighbourNameTd);

    const neighbourPlotTd = document.createElement("td");
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
  currentVertices = walkRegular(lengths, regularAngle);
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

function addDiagonalRow(defaultFrom, defaultTo) {
  // defaultTo === null means "just pick the first valid target" - used by the Add Diagonal
  // button, where there's no particular vertex the new row is expected to connect to.
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
    onDiagonalChanged();
  });
  toSelect.addEventListener("change", () => {
    reseed();
    onDiagonalChanged();
  });
  input.addEventListener("input", onDiagonalChanged);
  input.addEventListener("change", onDiagonalChanged);

  diagonalRowsEl.appendChild(tr);
}

function buildDiagonalRows() {
  const n = currentSideCount();
  diagonalRowsEl.innerHTML = "";

  if (regularToggleEl.checked) {
    diagonalsTableEl.style.display = "none";
    diagonalAddBtnEl.style.display = "none";
    diagonalsNoteEl.textContent = "Not needed for a regular polygon - every diagonal follows automatically from the side length and vertex count.";
    return;
  }

  const count = diagonalCount(n);
  if (count === 0) {
    diagonalsTableEl.style.display = "none";
    diagonalAddBtnEl.style.display = "none";
    diagonalsNoteEl.textContent = "None needed - 3 sides alone fully determine a triangle.";
    return;
  }

  diagonalsNoteEl.textContent =
    `${count} diagonal(s) needed to fully determine this ${n}-sided shape - seeded below from ` +
    `corner A, matching the shape currently shown. Change which corners a diagonal connects with ` +
    `the dropdowns, or use "Add diagonal" for an extra one if that's easier to measure on site.`;
  diagonalsTableEl.style.display = "table";
  diagonalAddBtnEl.style.display = "inline-block";

  for (let k = 2; k <= n - 2; k++) {
    addDiagonalRow(0, k);
  }
}

function resolveAndRedraw() {
  const n = currentSideCount();
  const lengths = readLengths();
  const regularAngle = ((n - 2) * 180) / n;

  if (regularToggleEl.checked) {
    currentVertices = walkRegular(lengths, regularAngle);
    closureNoteEl.textContent = "Regular polygon - always closes exactly.";
    closureNoteEl.classList.remove("closure-error");
    drawPreview(currentVertices, lastBuildable);
    return;
  }

  const diagonalSpecs = readDiagonalSpecs();
  const result = solveFromDiagonalGraph(lengths, diagonalSpecs);
  if (!result.ok) {
    showError(result.error);
    closureNoteEl.textContent = "Could not solve a closed shape - see the message above.";
    closureNoteEl.classList.add("closure-error");
    return; // keep showing the last valid currentVertices, don't blank the preview
  }
  clearError();
  currentVertices = result.vertices;
  closureNoteEl.textContent = "Closes exactly (solved from your side lengths and diagonals).";
  closureNoteEl.classList.remove("closure-error");
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
  if (edgeRowsEl.children.length === plotVertices.length) {
    const { roles, roadWidths } = readRoleSetback();
    const ccw = signedArea(plotVertices) > 0;
    const extension = Math.max(0, displayToFeet(parseFloat(roadExtensionEl.value) || 0));
    plotVertices.forEach((v, i) => {
      if (!isRoadRole(roles[i])) return;
      const width = roadWidths[i] || 0;
      if (width <= 0) return;
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
        along: { x: ux, y: uy }, extension,
        frontRoad: roles[i] === "front_road",
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

  plotVertices.forEach((v, i) => {
    const next = plotVertices[(i + 1) % plotVertices.length];
    const length = Math.hypot(next.x - v.x, next.y - v.y);
    const mid = { x: (v.x + next.x) / 2, y: (v.y + next.y) / 2 };
    const dx = mid.x - centroid.x, dy = mid.y - centroid.y;
    const dlen = Math.hypot(dx, dy) || 1;

    // Length label: inside the polygon, running alongside the side (matching a real
    // surveyor's sketch map convention).
    const insidePoint = { x: mid.x - (dx / dlen) * nudge, y: mid.y - (dy / dlen) * nudge };
    const pInside = transform(insidePoint);
    const pv = transform(v), pn = transform(next);
    const screenLen = Math.hypot(pn.x - pv.x, pn.y - pv.y);
    let angleDeg = (Math.atan2(pn.y - pv.y, pn.x - pv.x) * 180) / Math.PI;
    if (angleDeg > 90 || angleDeg < -90) angleDeg += 180; // keep text upright/readable

    const lengthText = `${feetToDisplay(length).toFixed(2)} ${unitLabel()}`;
    const lengthFontSize = fontSizeForEdgeText(screenLen, lengthText.length, 6.5, 12);
    svg += `<text x="${pInside.x.toFixed(1)}" y="${pInside.y.toFixed(1)}" font-size="${lengthFontSize.toFixed(1)}" font-weight="600" ` +
      `fill="${lengthLabelColor}" text-anchor="middle" dominant-baseline="middle" ` +
      `transform="rotate(${angleDeg.toFixed(1)} ${pInside.x.toFixed(1)} ${pInside.y.toFixed(1)})">${lengthText}</text>`;

    // Neighbour name/plot: outside the polygon (where the length label used to sit),
    // only for non-road edges that have something entered.
    if (!isRoadRole(edgeRoles[i]) && (neighbourNames[i] || neighbourPlots[i])) {
      const outsidePoint = { x: mid.x + (dx / dlen) * nudge, y: mid.y + (dy / dlen) * nudge };
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
  return (pt) => ({
    x: pad + (pt.x - minX) * scale,
    y: pad + (maxY - pt.y) * scale, // flip Y so North is up
  });
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
      return;
    }

    lastBuildable = data.buildable.vertices;
    lastBuildableAreaSqft = polygonArea(lastBuildable);
    drawPreview(data.plot.vertices, lastBuildable);
    initFootprintDefaults();
    drawFootprintPreview();
    drawRoadLogicPreview(); // keep the Master plan page's own preview in sync too, in case it's already open

    let msg = `Buildable area computed (${data.buildable.vertices.length} vertices).`;
    if (data.adjusted) msg += ` Closure auto-corrected (${data.closure_error_ft} ft error).`;
    if (data.buildable.repaired) msg += ` Note: setbacks required geometric repair near a tight corner - double-check the buildable outline looks reasonable.`;
    resultBoxEl.style.display = "block";
    resultBoxEl.textContent = msg;
    logStatus("Done.");
  } catch (err) {
    showError(`Network/parse error: ${err}`);
    logStatus(`Failed: ${err}`, true);
  } finally {
    computeBtn.disabled = false;
  }
}

// ---- Building footprint (reuses lastBuildable/currentVertices from the site plot above) ----

function footprintSideCount() {
  return parseInt(footprintSidesCountEl.value, 10) || 4;
}

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

function buildNotchedRectangle(w, h, cornerFlags, cornerNotchFrac, midEdgeFlags, midNotchFrac, midDepthFrac) {
  // The one generator behind every template shape. cornerFlags/midEdgeFlags are each
  // [bottom-edge-or-corner, right, top, left] booleans (corner index c sits between edge
  // c-1 and edge c, in the same CCW order as the edges).
  //   - A flagged CORNER replaces that single vertex with a 3-point inward step (+2 net
  //     vertices) - this alone makes an L (1 corner), a T or Z (2 corners, adjacent or
  //     opposite), or a plus (all 4 corners).
  //   - A flagged EDGE inserts an isolated notch in the middle of that edge, touching
  //     neither of its corners (+4 net vertices, 2 of them concave) - this is the real
  //     U-shape: a slot cut into one side, not a corner cut at all.
  //   - Both kinds compose freely (e.g. one corner notch + one mid-edge notch on a
  //     different, non-adjacent edge), which is what makes the 10-sided combinations work.
  const corners = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const nx = w * cornerNotchFrac, ny = h * cornerNotchFrac;
  const cornerDetour = (c) => {
    if (c === 0) return [{ x: 0, y: ny }, { x: nx, y: ny }, { x: nx, y: 0 }];
    if (c === 1) return [{ x: w - nx, y: 0 }, { x: w - nx, y: ny }, { x: w, y: ny }];
    if (c === 2) return [{ x: w, y: h - ny }, { x: w - nx, y: h - ny }, { x: w - nx, y: h }];
    return [{ x: nx, y: h }, { x: nx, y: h - ny }, { x: 0, y: h - ny }];
  };
  // Where an edge actually starts/ends once its bounding corner's own notch (if any) is
  // accounted for - NOT the raw corner position. Without this, a mid-edge notch placed on
  // an edge whose corner is ALSO notched would measure from the wrong point and could
  // overlap or cross the corner notch - this is what lets corner- and edge-notches combine
  // freely on the higher side counts instead of only on carefully-chosen "safe" edges.
  const edgeStart = (c) => (cornerFlags[c] ? cornerDetour(c)[cornerDetour(c).length - 1] : corners[c]);
  const edgeEnd = (c) => (cornerFlags[c] ? cornerDetour(c)[0] : corners[c]);
  const pts = [];
  for (let e = 0; e < 4; e++) {
    if (cornerFlags[e]) pts.push(...cornerDetour(e));
    else pts.push(corners[e]);
    if (midEdgeFlags[e]) {
      const from = edgeStart(e), to = edgeEnd((e + 1) % 4);
      const dx = to.x - from.x, dy = to.y - from.y;
      const len = Math.hypot(dx, dy);
      const ux = dx / len, uy = dy / len;
      const inX = -uy, inY = ux; // 90deg CCW rotation of the edge direction = inward, for a CCW polygon
      const nw = len * midNotchFrac;
      const depth = (e % 2 === 0 ? h : w) * midDepthFrac;
      const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
      const n1 = { x: mid.x - ux * (nw / 2), y: mid.y - uy * (nw / 2) };
      const n2 = { x: n1.x + inX * depth, y: n1.y + inY * depth };
      const n3 = { x: n2.x + ux * nw, y: n2.y + uy * nw };
      const n4 = { x: n3.x - inX * depth, y: n3.y - inY * depth };
      pts.push(n1, n2, n3, n4);
    }
  }
  return pts;
}

function popcount4(mask) {
  return ((mask & 1) ? 1 : 0) + ((mask & 2) ? 1 : 0) + ((mask & 4) ? 1 : 0) + ((mask & 8) ? 1 : 0);
}

function maskToFlags(mask) {
  return [0, 1, 2, 3].map((i) => !!(mask & (1 << i)));
}

function footprintTemplateVariants(n) {
  // Every distinct, realizable arrangement of corner-notches and mid-edge-notches for this
  // side count - a full enumeration (every subset of the 4 corners paired with every subset
  // of the 4 edges that together add up to the required concave-vertex count), not a
  // hand-picked pattern rotated around. A corner contributes 1 concave vertex (+2 total
  // vertices, a 3-point inward step); a mid-edge notch contributes 2 concave vertices (+4
  // total vertices, an isolated slot touching neither of that edge's corners) - so
  // corners.length + 2*edges.length must equal k. "Change shape" cycles through this whole
  // list, in order, so every combination is genuinely reachable.
  const k = (n - 4) / 2;
  if (!Number.isInteger(k) || k < 0) return null;
  const variants = [];
  for (let cMask = 0; cMask < 16; cMask++) {
    const cCount = popcount4(cMask);
    if (cCount > k) continue;
    const remaining = k - cCount;
    if (remaining % 2 !== 0) continue;
    const eCount = remaining / 2;
    if (eCount > 4) continue;
    for (let eMask = 0; eMask < 16; eMask++) {
      if (popcount4(eMask) !== eCount) continue;
      variants.push({
        corners: maskToFlags(cMask),
        cornerFrac: 0.3,
        mid: maskToFlags(eMask),
        midFrac: 0.35,
        midDepth: 0.22,
        square: cCount === 4 && eCount === 0, // the pure plus/cross needs a square box to come out symmetric
      });
    }
  }
  return variants.length > 0 ? variants : null; // k > 12 isn't reachable with only 4 corners/4 edges
}

function computeDefaultFootprintVertices(n, buildableVertices, orientation) {
  // A best-effort default shape that sits inside the buildable polygon - shrinks from 60% of
  // the bounding box down until every vertex actually falls inside (handles narrow or concave
  // buildable areas), falling back to a small square at the centroid.
  const xs = buildableVertices.map((v) => v.x), ys = buildableVertices.map((v) => v.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const fullW = maxX - minX, fullH = maxY - minY;
  const variants = footprintTemplateVariants(n);
  if (!variants) return null; // more sides than these families cover (n > 12) - no template available
  const template = variants[((orientation || 0) % variants.length + variants.length) % variants.length];

  for (let scale = 0.6; scale > 0.08; scale -= 0.04) {
    let w = fullW * scale, h = fullH * scale;
    if (template.square) { const s = Math.min(w, h); w = s; h = s; }
    const local = buildNotchedRectangle(w, h, template.corners, template.cornerFrac, template.mid, template.midFrac, template.midDepth);
    const originX = cx - w / 2, originY = cy - h / 2;
    const abs = local.map((p) => ({ x: p.x + originX, y: p.y + originY }));
    if (abs.every((v) => pointInPolygon(v, buildableVertices))) {
      return abs;
    }
  }
  const c = centroidOf(buildableVertices);
  return [
    { x: c.x - 5, y: c.y - 5 }, { x: c.x + 5, y: c.y - 5 },
    { x: c.x + 5, y: c.y + 5 }, { x: c.x - 5, y: c.y + 5 },
  ];
}

function footprintVariantCount(n) {
  const variants = footprintTemplateVariants(n);
  return variants ? variants.length : 0;
}

function walkOpenPolygon(lengths, interiorAngles, start, startHeadingDeg) {
  // Same turtle walk as the server's vertices_from_edges(), but WITHOUT the compass-rule
  // closure correction - used only to visualize where a non-closing shape actually ends up,
  // matching what the server just rejected.
  const n = lengths.length;
  const exteriorSumKnown = interiorAngles.reduce((s, a) => s + (180 - a), 0);
  const exteriorLast = 360 - exteriorSumKnown;
  const interiorLast = 180 - exteriorLast;
  const allInterior = interiorAngles.concat([interiorLast]);

  const pts = [{ x: start.x, y: start.y }];
  let heading = startHeadingDeg;
  let x = start.x, y = start.y;
  for (let i = 0; i < n; i++) {
    x += lengths[i] * Math.cos((heading * Math.PI) / 180);
    y += lengths[i] * Math.sin((heading * Math.PI) / 180);
    pts.push({ x, y });
    if (i < n - 1) heading += 180 - allInterior[i];
  }
  return pts; // n+1 points: pts[0..n-1] are the placed vertices, pts[n] is where it actually ends up
}

function requiredCornerCounts(n) {
  return { convex: (n + 4) / 2, concave: (n - 4) / 2 };
}

function readFootprintAngles() {
  // Corner angles now come from the current template + orientation (see "Change shape"),
  // not from per-row controls - hand-tuning 90/270 per vertex almost never produces a shape
  // that actually closes, so there's nothing useful left to toggle here.
  return footprintCurrentAngles;
}

function readFootprintLengths() {
  return Array.from(footprintRowsEl.querySelectorAll(".footprint-length-input"))
    .map((el) => displayToFeet(parseFloat(el.value) || 0));
}

function updateFootprintCornerNote() {
  const n = footprintSideCount();
  if (n % 2 !== 0 || n < 4) {
    footprintCornerNoteEl.textContent = `Footprint needs an even number of sides, 4 or more (got ${n}).`;
    footprintCornerNoteEl.classList.add("closure-error");
    return false;
  }
  const { convex, concave } = requiredCornerCounts(n);
  const angles = readFootprintAngles();
  const actualConvex = angles.filter((a) => a === 90).length;
  const actualConcave = angles.filter((a) => a === 270).length;
  const ok = actualConvex === convex && actualConcave === concave;
  footprintCornerNoteEl.textContent =
    `Corners needed for a closed ${n}-sided footprint: ${convex} × 90°, ${concave} × 270°. ` +
    `Currently set: ${actualConvex} × 90°, ${actualConcave} × 270°.`;
  footprintCornerNoteEl.classList.toggle("closure-error", !ok);
  return ok;
}

function buildFootprintRows(seed) {
  const n = footprintSideCount();
  const labels = labelsFor(n);
  footprintCurrentAngles = seed && seed.angles ? seed.angles : new Array(n).fill(90);
  footprintRowsEl.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const defaultLen = seed && seed.lengths ? seed.lengths[i] : displayToFeet(10);
    const angle = footprintCurrentAngles[i];
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td><strong>${labels[i]}</strong></td>` +
      `<td>${angle}&deg;${angle === 270 ? " (notch)" : ""}</td>` +
      `<td>${labels[i]} → ${labels[(i + 1) % n]}</td>` +
      `<td><input type="number" class="footprint-length-input" min="0.1" step="any" value="${feetToDisplay(defaultLen).toFixed(2)}" /></td>`;
    footprintRowsEl.appendChild(tr);
  }
  updateFootprintCornerNote();
}

function readFootprintIrregularLengths() {
  return Array.from(footprintIrregularRowsEl.querySelectorAll(".footprint-irregular-length-input"))
    .map((el) => displayToFeet(parseFloat(el.value) || 0));
}

function readFootprintDiagonalsList() {
  return Array.from(footprintDiagonalRowsEl.querySelectorAll(".footprint-diagonal-input"))
    .map((el) => displayToFeet(parseFloat(el.value) || 0));
}

function buildFootprintIrregularRows(seed) {
  const n = footprintSideCount();
  const labels = labelsFor(n);
  footprintIrregularRowsEl.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const defaultLen = seed && seed.lengths ? seed.lengths[i] : displayToFeet(10);
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${labels[i]} → ${labels[(i + 1) % n]}</td>` +
      `<td><input type="number" class="footprint-irregular-length-input" min="0.01" step="any" value="${feetToDisplay(defaultLen).toFixed(2)}" /></td>`;
    footprintIrregularRowsEl.appendChild(tr);
  }
}

function buildFootprintDiagonalRows(seedVertices) {
  // Mirrors the site plot's own diagonals-from-corner-A section exactly (same N-3 rule,
  // same fan triangulation) - just scoped to the footprint's own table/note elements.
  const n = footprintSideCount();
  const labels = labelsFor(n);
  footprintDiagonalRowsEl.innerHTML = "";
  const count = diagonalCount(n);
  if (count === 0) {
    footprintDiagonalsTableEl.style.display = "none";
    footprintDiagonalsNoteEl.textContent = "None needed - 3 sides alone fully determine a triangle.";
    return;
  }
  footprintDiagonalsNoteEl.textContent =
    `${count} diagonal(s) needed from corner ${labels[0]} to fully determine this ${n}-sided shape - ` +
    `seeded below to match a regular-ish starting shape, adjust as needed.`;
  footprintDiagonalsTableEl.style.display = "table";
  for (let k = 2; k <= n - 2; k++) {
    const tr = document.createElement("tr");
    const seedDist = seedVertices
      ? Math.hypot(seedVertices[k].x - seedVertices[0].x, seedVertices[k].y - seedVertices[0].y)
      : displayToFeet(14);
    tr.innerHTML =
      `<td>${labels[0]}-${labels[k]}</td>` +
      `<td><input type="number" class="footprint-diagonal-input" min="0.01" step="any" value="${feetToDisplay(seedDist).toFixed(2)}" /></td>`;
    footprintDiagonalRowsEl.appendChild(tr);
  }
}

function seedFootprintIrregular(n, seedVertices) {
  // Seeds the irregular edge/diagonal inputs - from an existing footprint shape's actual
  // vertices when one exists (e.g. switching the checkbox on keeps whatever was already
  // drawn), or from a plain regular-polygon walk otherwise, exactly like the site plot's own
  // "freeze the current shape, just seed diagonals from it" behaviour.
  let vertices = seedVertices;
  if (!vertices || vertices.length !== n) {
    const regularAngle = ((n - 2) * 180) / n;
    vertices = walkRegular(new Array(n).fill(displayToFeet(10)), regularAngle);
  }
  const lengths = vertices.map((v, i) => {
    const next = vertices[(i + 1) % n];
    return Math.hypot(next.x - v.x, next.y - v.y);
  });
  buildFootprintIrregularRows({ lengths });
  buildFootprintDiagonalRows(vertices);
  // The seeded shape always closes by construction (either a fresh regular-polygon walk, or
  // the exact vertices already on screen) - show it right away instead of waiting for a
  // manual click, matching the rectilinear side's own auto-preview behaviour.
  if (lastBuildable) previewFootprint();
}

function footprintSolveIrregular() {
  const n = footprintSideCount();
  const lengths = readFootprintIrregularLengths();
  if (lengths.length !== n || lengths.some((l) => !l || l <= 0)) {
    return { ok: false, error: "Every side needs a length greater than zero." };
  }
  const diagonals = readFootprintDiagonalsList();
  return solveFromDiagonals(lengths, diagonals);
}

function seedFootprintTemplate(n) {
  // Generates an actual valid, already-closing shape (not just placeholder numbers) for the
  // given side count - a rectangle, L, T, or plus, sized and positioned to sit inside the
  // current buildable area - then derives the length/angle values that reproduce it, so
  // "Preview footprint" (or the auto-preview below) succeeds immediately instead of the user
  // having to hand-fix lengths for a shape the count-check alone can't fully validate.
  if (!lastBuildable) return;
  const vertices = computeDefaultFootprintVertices(n, lastBuildable, footprintOrientation);
  if (!vertices) {
    // No ready-made template beyond 20 sides - fall back to plain placeholder values the
    // user can adjust by hand, same as before this feature existed.
    buildFootprintRows();
    return;
  }
  const count = vertices.length;
  const lengths = vertices.map((v, i) => {
    const next = vertices[(i + 1) % count];
    return Math.hypot(next.x - v.x, next.y - v.y);
  });
  const angles = interiorAnglesFromVertices(vertices).map((a) => Math.round(a));
  footprintStartXEl.value = feetToDisplay(vertices[0].x).toFixed(2);
  footprintStartYEl.value = feetToDisplay(vertices[0].y).toFixed(2);
  buildFootprintRows({ lengths, angles });
  // Visible right away, not just sitting in the form fields waiting for a manual click - run
  // it through the same validated /compute-footprint round trip immediately so it's drawn
  // and contained-checked already.
  previewFootprint();
}

function initFootprintDefaults() {
  if (!lastBuildable || footprintDefaultsInitialized) return;
  footprintDefaultsInitialized = true;
  footprintPlaceholderNoteEl.style.display = "none";
  footprintPreviewBtn.disabled = false;
  changeShapeBtn.disabled = false;
  footprintSidesCountEl.value = 4;
  footprintOrientation = 0;
  seedFootprintTemplate(4);
}

function drawFootprintPreview() {
  if (!currentVertices) return;
  const gapPts = lastFootprintGapWalk || [];
  const boundsSource = currentVertices.concat(lastFootprintVertices || []).concat(gapPts);
  const transform = svgTransformFor(boundsSource);
  let svg = `<polygon points="${polygonPoints(transform, currentVertices)}" fill="none" stroke="#1f2430" stroke-width="2" />`;
  if (lastBuildable && lastBuildable.length >= 3) {
    svg += `<polygon points="${polygonPoints(transform, lastBuildable)}" fill="none" stroke="#999999" stroke-width="1.5" stroke-dasharray="6,4" />`;
  }
  if (gapPts.length >= 2) {
    const labels = labelsFor(gapPts.length - 1);
    const placed = gapPts.slice(0, -1);
    const rawEnd = gapPts[gapPts.length - 1];
    const start = gapPts[0];
    const walkedPath = gapPts.map((p, i) => `${i === 0 ? "M" : "L"}${transform(p).x.toFixed(1)},${transform(p).y.toFixed(1)}`).join(" ");
    svg += `<path d="${walkedPath}" fill="none" stroke="#1a5fb4" stroke-width="2" />`;
    const pStart = transform(start), pEnd = transform(rawEnd);
    svg += `<line x1="${pEnd.x.toFixed(1)}" y1="${pEnd.y.toFixed(1)}" x2="${pStart.x.toFixed(1)}" y2="${pStart.y.toFixed(1)}" ` +
      `stroke="#c0392b" stroke-width="2" stroke-dasharray="5,4" />`;
    const gapLen = Math.hypot(rawEnd.x - start.x, rawEnd.y - start.y);
    const mid = { x: (pEnd.x + pStart.x) / 2, y: (pEnd.y + pStart.y) / 2 };
    svg += `<text x="${mid.x.toFixed(1)}" y="${(mid.y - 6).toFixed(1)}" font-size="11" font-weight="700" ` +
      `fill="#c0392b" text-anchor="middle">Gap: ${feetToDisplay(gapLen).toFixed(2)} ${unitLabel()}</text>`;
    placed.forEach((v, i) => {
      const p = transform(v);
      svg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#1a5fb4" />`;
      svg += `<text x="${(p.x + 8).toFixed(1)}" y="${(p.y - 8).toFixed(1)}" font-size="12" font-weight="700" fill="#1a5fb4">${labels[i]}</text>`;
    });
  }
  if (lastFootprintVertices && lastFootprintVertices.length >= 3) {
    const n = lastFootprintVertices.length;
    const labels = labelsFor(n);
    const centroid = centroidOf(lastFootprintVertices);
    svg += `<polygon points="${polygonPoints(transform, lastFootprintVertices)}" fill="rgba(26,95,180,0.08)" stroke="#1a5fb4" stroke-width="2" />`;
    lastFootprintVertices.forEach((v, i) => {
      const next = lastFootprintVertices[(i + 1) % n];
      const length = Math.hypot(next.x - v.x, next.y - v.y);
      const mid = { x: (v.x + next.x) / 2, y: (v.y + next.y) / 2 };
      const dx = mid.x - centroid.x, dy = mid.y - centroid.y;
      const dlen = Math.hypot(dx, dy) || 1;
      const insidePoint = { x: mid.x - (dx / dlen) * 12, y: mid.y - (dy / dlen) * 12 };
      const pInside = transform(insidePoint);
      svg += `<text x="${pInside.x.toFixed(1)}" y="${pInside.y.toFixed(1)}" font-size="10.5" font-weight="600" ` +
        `fill="#1a5fb4" text-anchor="middle" dominant-baseline="middle">${feetToDisplay(length).toFixed(2)} ${unitLabel()}</text>`;
      const p = transform(v);
      svg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#1a5fb4" />`;
      svg += `<text x="${(p.x + 8).toFixed(1)}" y="${(p.y - 8).toFixed(1)}" font-size="12" font-weight="700" fill="#1a5fb4">${labels[i]}</text>`;
    });
  }
  footprintSvgEl.innerHTML = svg;
}

function clearFootprintError() {
  footprintErrorBoxEl.style.display = "none";
  footprintErrorBoxEl.textContent = "";
}

function showFootprintError(msg) {
  footprintErrorBoxEl.style.display = "block";
  footprintErrorBoxEl.textContent = msg;
}

async function previewFootprint() {
  clearFootprintError();
  footprintAreaSummaryEl.style.display = "none";
  if (!lastBuildable) {
    showFootprintError("Compute the buildable area above first.");
    return;
  }
  const n = footprintSideCount();
  const irregular = footprintIrregularToggleEl.checked;

  let lengths, interiorAngles;
  if (irregular) {
    if (n < 3) {
      showFootprintError(`Number of sides must be at least 3 (got ${n}).`);
      return;
    }
    const solved = footprintSolveIrregular();
    if (!solved.ok) {
      // A bad diagonal/length combo is a local geometry problem, not something the server
      // needs to see - same as the site plot's own diagonal solver.
      showFootprintError(solved.error);
      return;
    }
    lengths = solved.vertices.map((v, i) => {
      const next = solved.vertices[(i + 1) % n];
      return Math.hypot(next.x - v.x, next.y - v.y);
    });
    interiorAngles = interiorAnglesFromVertices(solved.vertices).slice(1);
  } else {
    if (n % 2 !== 0 || n < 4) {
      showFootprintError(`Number of sides must be even and at least 4 (got ${n}).`);
      return;
    }
    if (!updateFootprintCornerNote()) {
      showFootprintError("Corner angle counts don't add up to a closed shape yet - see the note above the table.");
      return;
    }
    lengths = readFootprintLengths();
    if (lengths.some((l) => !l || l <= 0)) {
      showFootprintError("Every side needs a length greater than zero.");
      return;
    }
    // Vertex A's angle is derived server-side, matching /compute-site's own convention
    // (computeSite() above does the same actualAngles.slice(1)).
    interiorAngles = readFootprintAngles().slice(1);
  }

  const body = {
    lengths,
    regular: false,
    interior_angles: interiorAngles,
    start: {
      x: displayToFeet(parseFloat(footprintStartXEl.value) || 0),
      y: displayToFeet(parseFloat(footprintStartYEl.value) || 0),
    },
    start_heading_deg: 0,
    buildable: { vertices: lastBuildable },
  };

  footprintPreviewBtn.disabled = true;
  footprintStatusNoteEl.textContent = "Validating...";
  try {
    const res = await fetch("/compute-footprint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.success) {
      showFootprintError(`[${data.stage || "error"}] ${data.error}`);
      footprintStatusNoteEl.textContent = "";
      // Show the actual gap instead of leaving the drawing blank - walk the same
      // lengths/angles client-side (no closure correction) so the user can see exactly
      // where the boundary stops short of closing.
      lastFootprintVertices = null;
      lastFootprintGapWalk = walkOpenPolygon(lengths, interiorAngles, body.start, 0);
      drawFootprintPreview();
      return;
    }

    lastFootprintGapWalk = null;
    lastFootprintVertices = data.footprint.vertices;
    drawFootprintPreview();
    footprintStatusNoteEl.textContent = data.adjusted
      ? `Closure auto-corrected (${data.closure_error_ft} ft error).`
      : "Shape closed exactly.";

    const footprintAreaSqft = polygonArea(lastFootprintVertices);
    const au = areaUnitLabel();
    let areaMsg = `<strong>Footprint area:</strong> ${sqFeetToDisplayArea(footprintAreaSqft).toFixed(1)} ${au} ` +
      `(${kathaChatakText(footprintAreaSqft)})<br/>`;
    if (data.contained) {
      areaMsg += `<span style="color: var(--accent-dark); font-weight:700;">Fits entirely within the buildable area.</span>`;
    } else {
      areaMsg += `<span style="color: var(--danger); font-weight:700;">Extends outside the buildable area by ~` +
        `${sqFeetToDisplayArea(data.violation_area_sqft).toFixed(1)} ${au}. Adjust the shape or start position.</span>`;
    }
    footprintAreaSummaryEl.innerHTML = areaMsg;
    footprintAreaSummaryEl.style.display = "block";
  } catch (err) {
    showFootprintError(`Network/parse error: ${err}`);
    footprintStatusNoteEl.textContent = "";
  } finally {
    footprintPreviewBtn.disabled = false;
  }
}

footprintSidesCountEl.addEventListener("change", () => {
  let n = footprintSideCount();
  if (footprintIrregularToggleEl.checked) {
    if (n < 3) n = 3;
    footprintSidesCountEl.value = n;
    seedFootprintIrregular(n, null);
    return;
  }
  if (n < 4) n = 4;
  if (n % 2 !== 0) n += 1;
  footprintSidesCountEl.value = n;
  footprintOrientation = 0;
  if (lastBuildable) {
    seedFootprintTemplate(n);
  } else {
    buildFootprintRows();
    drawFootprintPreview();
  }
});
footprintPreviewBtn.addEventListener("click", previewFootprint);
changeShapeBtn.addEventListener("click", () => {
  const n = footprintSideCount();
  const count = footprintVariantCount(n) || 1;
  footprintOrientation = (footprintOrientation + 1) % count;
  seedFootprintTemplate(n);
});
footprintIrregularToggleEl.addEventListener("change", () => {
  const irregular = footprintIrregularToggleEl.checked;
  footprintRectilinearGroupEl.style.display = irregular ? "none" : "block";
  changeShapeFieldEl.style.display = irregular ? "none" : "flex";
  footprintIrregularGroupEl.style.display = irregular ? "block" : "none";
  footprintCornerNoteEl.style.display = irregular ? "none" : "block";

  if (irregular) {
    // Sides no longer need to be even - an irregular footprint can have any shape, just
    // like a triangle needs no diagonals at all.
    footprintSidesCountEl.min = "3";
    footprintSidesCountEl.step = "1";
    let n = footprintSideCount();
    if (n < 3) { n = 3; footprintSidesCountEl.value = n; }
    // Keep whatever shape is already on screen as the starting point - freeze it into
    // lengths/diagonals rather than resetting to a plain default, same as the site plot's
    // own "uncheck regular, seed diagonals from the current shape" behaviour.
    seedFootprintIrregular(n, lastFootprintVertices);
  } else {
    footprintSidesCountEl.min = "4";
    footprintSidesCountEl.step = "2";
    let n = footprintSideCount();
    if (n < 4) n = 4;
    if (n % 2 !== 0) n += 1;
    footprintSidesCountEl.value = n;
    footprintOrientation = 0;
    if (lastBuildable) seedFootprintTemplate(n);
  }
});

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
  document.querySelectorAll(".length-input, .setback-input, .diagonal-input, .road-width-input, .footprint-length-input, .footprint-start-input").forEach(convert);
  convert(roadExtensionEl);

  resolveAndRedraw();
  drawFootprintPreview();
});

sidesCountEl.addEventListener("change", buildEdgeRows);
roadExtensionEl.addEventListener("input", () => drawPreview(currentVertices, lastBuildable));
roadExtensionEl.addEventListener("change", () => drawPreview(currentVertices, lastBuildable));
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

previewPdfBtn.addEventListener("click", async () => {
  pdfNoteEl.textContent = "Generating preview...";
  previewPdfBtn.disabled = true;
  try {
    const doc = await generatePdf();
    if (!doc) return;
    pdfPreviewFrameEl.src = String(doc.output("bloburl"));
    pdfPreviewFrameEl.style.display = "block";
    downloadPdfBtn.disabled = false;
    pdfNoteEl.textContent = "Preview ready.";
  } catch (err) {
    pdfNoteEl.textContent = `Failed: ${err}`;
  } finally {
    previewPdfBtn.disabled = false;
  }
});

downloadPdfBtn.addEventListener("click", () => {
  if (lastPdfDoc) lastPdfDoc.save("site_plan.pdf");
});
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
  addDiagonalRow(0, null);
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

function addRoadRow() {
  const uid = String(++roadUidCounter);
  const index = roadRowsEl.children.length;
  const div = document.createElement("div");
  div.className = "road-row";
  div.dataset.roadUid = uid;
  div.style.cssText = "border:1px solid var(--border); border-radius:7px; padding:10px 12px; margin-top:10px;";
  div.innerHTML =
    `<div class="row">` +
    `<div class="field"><label>Road name</label><input type="text" class="road-name-input" value="R${index + 1}" /></div>` +
    `<div class="field"><label>Road type</label><select class="road-type-select">` +
    `<option value="spine">Spine</option><option value="loop">Loop</option>` +
    `<option value="branch">Branch</option><option value="culdesac">Cul-de-sac</option>` +
    `</select></div>` +
    `<div class="field"><label>Shape</label><select class="road-shape-select">` +
    `<option value="straight">Straight</option><option value="curved">Curved</option>` +
    `</select></div>` +
    `<div class="field"><label>Start</label><select class="road-start-select"></select></div>` +
    `<div class="field"><label class="road-start-distance-label">Distance (ft)</label>` +
    `<input type="number" class="road-start-distance-input" step="any" /></div>` +
    `<div class="field"><label>End</label><select class="road-end-select"></select></div>` +
    `<div class="field road-end-distance-field"><label class="road-end-distance-label">Distance (ft)</label>` +
    `<input type="number" class="road-end-distance-input" step="any" /></div>` +
    `<div class="field road-deadend-length" style="display:none;"><label>Length (ft)</label>` +
    `<input type="number" class="road-deadend-length-input" step="any" min="0.1" value="${feetToDisplay(30).toFixed(2)}" /></div>` +
    `<div class="field road-deadend-direction" style="display:none;"><label>Perpendicular to side</label>` +
    `<select class="road-deadend-direction-select"></select></div>` +
    `<div class="field"><label>Width (ft)</label><input type="number" class="road-width-input" step="any" min="0.1" value="${feetToDisplay(12).toFixed(2)}" /></div>` +
    `<div class="field"><label>Buffer (ft)</label><input type="number" class="road-buffer-input" step="any" min="0" value="0" /></div>` +
    `<div class="field road-curve-bulge" style="display:none;"><label>Curve bulge (ft)</label>` +
    `<input type="number" class="road-bulge-input" step="any" min="0" value="${feetToDisplay(10).toFixed(2)}" /></div>` +
    `<div class="field road-curve-direction" style="display:none;"><label>Curve direction</label>` +
    `<select class="road-direction-select"><option value="left">Left of travel</option><option value="right">Right of travel</option></select></div>` +
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
  const curveBulgeField = div.querySelector(".road-curve-bulge");
  const curveDirectionField = div.querySelector(".road-curve-direction");
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
    const isCurved = shapeSelect.value === "curved";
    curveBulgeField.style.display = isCurved ? "flex" : "none";
    curveDirectionField.style.display = isCurved ? "flex" : "none";
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
    const midPoint = path[Math.floor(path.length / 2)];
    const mid = transform(midPoint);
    const chordLength = Math.hypot(r.end.x - r.start.x, r.end.y - r.start.y);
    const bufferPart = r.buffer ? ` + ${feetToDisplay(r.buffer).toFixed(1)} ${unitLabel()} buffer/side` : "";
    const curvePart = r.shape === "curved" ? `, curved (${feetToDisplay(r.bulge).toFixed(1)} ${unitLabel()} bulge)` : "";
    svg += `<text x="${mid.x.toFixed(1)}" y="${(mid.y - 8).toFixed(1)}" font-size="11" font-weight="700" ` +
      `fill="#7d5ba6" text-anchor="middle">${r.name} (${feetToDisplay(chordLength).toFixed(1)} ${unitLabel()} long, ` +
      `${feetToDisplay(r.width).toFixed(1)} ${unitLabel()} wide${bufferPart}${curvePart})</text>`;
  });
  roadLogicSvgEl.innerHTML = svg;

  if (errors && errors.length) {
    roadLogicNoteEl.textContent = errors.join(" ");
    roadLogicNoteEl.classList.add("closure-error");
  } else {
    roadLogicNoteEl.textContent = roads && roads.length
      ? `${roads.length} road(s) defined.`
      : "No roads yet - click \"Add road\" to start.";
    roadLogicNoteEl.classList.remove("closure-error");
  }
}

addRoadBtnEl.addEventListener("click", () => {
  addRoadRow();
  recomputeAllRoads();
});

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
  if (currentVertices && edgeRowsEl.children.length === currentVertices.length) {
    const { roles } = readRoleSetback();
    const n = currentVertices.length;
    for (let i = 0; i < n; i++) {
      if (!isRoadRole(roles[i])) continue;
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
    field(`Max length (${unitLabel()})`, "sub-max-length", feetToDisplay(60).toFixed(1)) +
    field(`Min length (${unitLabel()})`, "sub-min-length", feetToDisplay(40).toFixed(1)) +
    field(`Max width (${unitLabel()})`, "sub-max-width", feetToDisplay(50).toFixed(1)) +
    field(`Min width (${unitLabel()})`, "sub-min-width", feetToDisplay(30).toFixed(1)) +
    `</div><div class="row" style="margin-top:8px;">` +
    field(`Min gap between two plots (${unitLabel()})`, "sub-min-gap", feetToDisplay(0).toFixed(1)) +
    field(`Plot roadside threshold (${unitLabel()})`, "sub-road-threshold", feetToDisplay(5).toFixed(1)) +
    `<div class="field"><label>&nbsp;</label><button type="button" class="sub-insert-btn">Insert plots</button></div>` +
    `</div>` +
    `<p class="hint sub-details" style="margin-top:8px;"></p>`;
  subsectionRowsEl.appendChild(div);

  sub.detailsEl = div.querySelector(".sub-details");
  const readParams = () => ({
    minPlots: parseInt(div.querySelector(".sub-min-plots").value, 10) || 0,
    maxLength: displayToFeet(parseFloat(div.querySelector(".sub-max-length").value) || 0),
    minLength: displayToFeet(parseFloat(div.querySelector(".sub-min-length").value) || 0),
    maxWidth: displayToFeet(parseFloat(div.querySelector(".sub-max-width").value) || 0),
    minWidth: displayToFeet(parseFloat(div.querySelector(".sub-min-width").value) || 0),
    minGap: displayToFeet(parseFloat(div.querySelector(".sub-min-gap").value) || 0),
    roadThreshold: displayToFeet(parseFloat(div.querySelector(".sub-road-threshold").value) || 0),
    maxPlots: null,
  });

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
    finalizeRoadLogicNoteEl.textContent = "Compute the buildable area on the Site plan page first.";
    finalizeRoadLogicNoteEl.classList.add("closure-error");
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
      return;
    }
    subsections = data.subsections.map((s, i) => ({ vertices: s.vertices, index: i, params: null, plots: [], details: null, detailsEl: null }));
    subsectionRowsEl.innerHTML = "";
    subsections.forEach((sub) => buildSubsectionRow(sub));
    finalizeRoadLogicNoteEl.textContent = `${subsections.length} sub-section(s) found.`;
    plotLogicCardEl.style.display = "block";
    drawPlotLogicPreview();
  } catch (err) {
    finalizeRoadLogicNoteEl.textContent = `Network/parse error: ${err}`;
    finalizeRoadLogicNoteEl.classList.add("closure-error");
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

function addPlotDiagonalRow(defaultFrom, defaultTo) {
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
    onPlotFieldChanged();
  });
  toSelect.addEventListener("change", () => {
    reseed();
    onPlotFieldChanged();
  });
  input.addEventListener("input", onPlotFieldChanged);
  input.addEventListener("change", onPlotFieldChanged);

  plotDiagonalRowsEl.appendChild(tr);
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
  const result = solveFromDiagonalGraph(lengths, diagonalSpecs);
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
  plotNameNoteEl.textContent = `Editing ${session.name}.`;
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
    plotAreaStepNoteEl.textContent = data.error || "That resize was refused.";
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

plotAreaPlusBtnEl.addEventListener("click", () => stepPlotArea("grow"));
plotAreaMinusBtnEl.addEventListener("click", () => stepPlotArea("shrink"));
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
        svg += `<polygon points="${pts}" fill="rgba(47,111,79,0.12)" stroke="#2f6f4f" stroke-width="1.2" />`;
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
}

// Simple O(n^2) non-adjacent segment-intersection check - plots here are always small polygons
// (at most a handful of sides), so this is plenty fast and needs no spatial indexing.
// A real plot must stay within the sub-section it belongs to - editing a shared corner freely
// could otherwise stretch a plot straight into the road strip or past the sub-section's own
// outer edge, which is just as much "bad geometry" for a real plot as self-intersecting. Each
// corner is nudged slightly toward the sub-section's centroid before testing, same reasoning
// as elsewhere in this app: ray-casting containment is unreliable for a point sitting exactly
// on a boundary edge, which a plot's own corner very often does by construction.
function plotStaysInsideSubsection(verts, subVertices) {
  const centroid = centroidOf(subVertices);
  return verts.every((v) => {
    const dx = centroid.x - v.x, dy = centroid.y - v.y;
    const len = Math.hypot(dx, dy) || 1;
    const nudged = { x: v.x + (dx / len) * 0.05, y: v.y + (dy / len) * 0.05 };
    return pointInPolygon(nudged, subVertices);
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
  const nA = polyA.length, nB = polyB.length;
  const tol = 0.1;
  for (let i = 0; i < nA; i++) {
    const a1 = polyA[i], a2 = polyA[(i + 1) % nA];
    for (let j = 0; j < nB; j++) {
      const b1 = polyB[j], b2 = polyB[(j + 1) % nB];
      if (properSegmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  const midpoints = (poly) => poly.map((v, i) => {
    const w = poly[(i + 1) % poly.length];
    return { x: (v.x + w.x) / 2, y: (v.y + w.y) / 2 };
  });
  for (const p of polyA.concat(midpoints(polyA))) {
    if (pointStrictlyInsidePolygon(p, polyB, tol)) return true;
  }
  for (const p of polyB.concat(midpoints(polyB))) {
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
  addPlotDiagonalRow(0, null);
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
    return;
  }
  const notReady = subsections.filter((s) => !s.details || s.details.error);
  if (notReady.length) {
    finalizePlotLogicNoteEl.textContent =
      `Insert plots for every sub-section first - Sub-section ${notReady.map((s) => s.index + 1).join(", ")} ` +
      `${notReady.length > 1 ? "haven't" : "hasn't"} been filled yet.`;
    finalizePlotLogicNoteEl.classList.add("closure-error");
    return;
  }
  finalizePlotLogicNoteEl.textContent = "";
  finalizePlotLogicNoteEl.classList.remove("closure-error");
  plotEditorCardEl.style.display = "block";
  drawPlotEditorPreview();
  plotEditorCardEl.scrollIntoView({ behavior: "smooth", block: "start" });
});

// Locks in a clean, combined presentation of every sub-section's plots together, plus totals
// across the whole master plan - the plot-logic equivalent of the site plan's own "Finalise
// site plan" step. Requires every sub-section to have had "Insert plots" run at least once,
// since finalizing before that would just present an empty/partial plan as if it were done.
finalizeMasterPlanBtn.addEventListener("click", () => {
  if (!subsections.length) {
    finalizeMasterPlanNoteEl.textContent = "Finalize road logic first so there are sub-sections to fill.";
    finalizeMasterPlanNoteEl.classList.add("closure-error");
    return;
  }
  const notReady = subsections.filter((s) => !s.details || s.details.error);
  if (notReady.length) {
    finalizeMasterPlanNoteEl.textContent =
      `Insert plots for every sub-section first - Sub-section ${notReady.map((s) => s.index + 1).join(", ")} ` +
      `${notReady.length > 1 ? "haven't" : "hasn't"} been filled yet.`;
    finalizeMasterPlanNoteEl.classList.add("closure-error");
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
  masterPlanCardEl.scrollIntoView({ behavior: "smooth", block: "start" });
});

// ---- Wizard page navigation (step-nav pills) ----
function showWizardPage(step) {
  document.querySelectorAll(".wizard-page").forEach((el) => {
    el.style.display = el.id === `wizardPage${step}` ? "block" : "none";
  });
  document.querySelectorAll(".step-nav .step-pill").forEach((pill) => {
    if (pill.classList.contains("todo")) return;
    pill.classList.toggle("active", pill.dataset.step === String(step));
  });
  // The site plot/final site plan cards and the print sheet live outside the wizard-page
  // toggle entirely (one shared set of cards, not a duplicate per page) since the master plan
  // is built directly on top of the same site plan, not a separate thing - shown under either
  // of those two steps, hidden under Footprint/Floors where they don't belong yet.
  const stepStr = String(step);
  const showShared = stepStr === "2" || stepStr === "masterplan";
  document.querySelectorAll(".shared-with-masterplan").forEach((el) => {
    el.style.display = showShared ? "block" : "none";
  });
  // The Road logic preview used to only ever get drawn by the "Build master plan" button's
  // own click handler (which always redrew it fresh at that moment); now that this page is
  // reached by navigation instead, redraw it on every visit so it reflects whatever the site
  // plan currently is - a no-op via its own currentVertices guard if nothing's computed yet.
  if (step === "masterplan") drawRoadLogicPreview();
}
document.querySelectorAll(".step-nav .step-pill:not(.todo)").forEach((pill) => {
  pill.addEventListener("click", () => showWizardPage(pill.dataset.step));
});

// ---- Footprint page: choose the site-plan source ----
importSiteplanBtn.addEventListener("click", () => {
  footprintCardEl.style.display = "block";
  uploadSiteplanCardEl.style.display = "none";
});
uploadSiteplanBtn.addEventListener("click", () => {
  uploadSiteplanCardEl.style.display = "block";
  footprintCardEl.style.display = "none";
});

showWizardPage(2);
updateUnitLabels();
buildEdgeRows();
