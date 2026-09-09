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

const unitSelectEl = document.getElementById("unitSelect");
const sidesCountEl = document.getElementById("sidesCount");
const regularToggleEl = document.getElementById("regularToggle");
const regularNoteEl = document.getElementById("regularNote");
const edgeRowsEl = document.getElementById("edgeRows");
const diagonalRowsEl = document.getElementById("diagonalRows");
const diagonalsTableEl = document.getElementById("diagonalsTable");
const diagonalsNoteEl = document.getElementById("diagonalsNote");
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

let mouzaMapDataUrl = null;
let lastPdfDoc = null;

let lastBuildable = null;   // stashed for page 3 (footprint) to reuse later
let footprintDefaultsInitialized = false;
let lastFootprintVertices = null;
let currentVertices = null; // the last successfully resolved plot polygon (local coords)
let lastBuildableAreaSqft = null;

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

function readDiagonals() {
  return Array.from(diagonalRowsEl.querySelectorAll(".diagonal-input")).map(
    (el) => displayToFeet(parseFloat(el.value) || 0)
  );
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
    lengthInput.value = feetToDisplay(20).toFixed(2);
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

function buildDiagonalRows() {
  const n = currentSideCount();
  const labels = labelsFor(n);
  diagonalRowsEl.innerHTML = "";

  if (regularToggleEl.checked) {
    diagonalsTableEl.style.display = "none";
    diagonalsNoteEl.textContent = "Not needed for a regular polygon - every diagonal follows automatically from the side length and vertex count.";
    return;
  }

  const count = diagonalCount(n);
  if (count === 0) {
    diagonalsTableEl.style.display = "none";
    diagonalsNoteEl.textContent = "None needed - 3 sides alone fully determine a triangle.";
    return;
  }

  diagonalsNoteEl.textContent = `${count} diagonal(s) needed from corner ${labels[0]} to fully determine this ${n}-sided shape - seeded below to match the shape currently shown.`;
  diagonalsTableEl.style.display = "table";

  for (let k = 2; k <= n - 2; k++) {
    const tr = document.createElement("tr");
    const labelTd = document.createElement("td");
    labelTd.textContent = `${labels[0]}-${labels[k]}`;
    tr.appendChild(labelTd);

    const inputTd = document.createElement("td");
    const input = document.createElement("input");
    input.type = "number";
    input.step = "0.01";
    input.min = "0.01";
    input.className = "diagonal-input";
    input.dataset.vertexIndex = String(k);
    const seedDist = Math.hypot(
      currentVertices[k].x - currentVertices[0].x,
      currentVertices[k].y - currentVertices[0].y
    );
    input.value = feetToDisplay(seedDist).toFixed(2);
    input.addEventListener("input", onDiagonalChanged);
    input.addEventListener("change", onDiagonalChanged);
    inputTd.appendChild(input);
    tr.appendChild(inputTd);

    diagonalRowsEl.appendChild(tr);
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

  const diagonals = readDiagonals();
  const result = solveFromDiagonals(lengths, diagonals);
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

  // Diagonals from A, red dotted, only meaningful in non-regular mode.
  if (showDiagonals && !regularToggleEl.checked && plotVertices.length >= 4) {
    const n = plotVertices.length;
    const A = plotVertices[0];
    const pA = transform(A);
    for (let k = 2; k <= n - 2; k++) {
      const Vk = plotVertices[k];
      const pVk = transform(Vk);
      const length = Math.hypot(Vk.x - A.x, Vk.y - A.y);
      svg += `<line x1="${pA.x.toFixed(1)}" y1="${pA.y.toFixed(1)}" x2="${pVk.x.toFixed(1)}" y2="${pVk.y.toFixed(1)}" stroke="#c0392b" stroke-width="1.4" stroke-dasharray="3,3" />`;
      const mid = { x: (A.x + Vk.x) / 2, y: (A.y + Vk.y) / 2 };
      const dx = mid.x - centroid.x, dy = mid.y - centroid.y;
      const dlen = Math.hypot(dx, dy) || 1;
      const labelPoint = { x: mid.x + (dx / dlen) * (nudge * 0.6), y: mid.y + (dy / dlen) * (nudge * 0.6) };
      const pLabel = transform(labelPoint);
      svg += `<text x="${pLabel.x.toFixed(1)}" y="${pLabel.y.toFixed(1)}" font-size="11.5" font-weight="600" ` +
        `fill="#c0392b" text-anchor="middle" dominant-baseline="middle">${feetToDisplay(length).toFixed(2)} ${unitLabel()}</text>`;
    }
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
      `fill="#2f6f4f" text-anchor="middle" dominant-baseline="middle" ` +
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

function drawPreview(plotVertices, buildableVertices) {
  const { svg: baseSvg, transform } = buildPlotSvg(plotVertices);
  let svg = baseSvg;

  if (buildableVertices && buildableVertices.length >= 3) {
    svg += `<polygon points="${polygonPoints(transform, buildableVertices)}" fill="none" stroke="#999999" stroke-width="1.5" stroke-dasharray="6,4" />`;
  }

  svgEl.innerHTML = svg;
  updateAreaSummary(plotVertices);
}

function renderFinalSitePlan() {
  if (!currentVertices) return;
  const { svg: content, transform } = buildPlotSvg(currentVertices, { showVertices: false, showDiagonals: false });
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
  const { svg: content, transform } = buildPlotSvg(currentVertices, { showVertices: false, showDiagonals: false });
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

function computeDefaultFootprint(buildableVertices) {
  // A best-effort default rectangle that sits inside the buildable polygon - shrinks from
  // 60% of the bounding box down until every corner actually falls inside (handles narrow
  // or concave buildable areas), falling back to a small square at the centroid.
  const xs = buildableVertices.map((v) => v.x), ys = buildableVertices.map((v) => v.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const fullW = maxX - minX, fullH = maxY - minY;
  for (let scale = 0.6; scale > 0.1; scale -= 0.05) {
    const w = fullW * scale, h = fullH * scale;
    const corners = [
      { x: cx - w / 2, y: cy - h / 2 },
      { x: cx + w / 2, y: cy - h / 2 },
      { x: cx + w / 2, y: cy + h / 2 },
      { x: cx - w / 2, y: cy + h / 2 },
    ];
    if (corners.every((c) => pointInPolygon(c, buildableVertices))) {
      return { startX: cx - w / 2, startY: cy - h / 2, width: w, height: h };
    }
  }
  const c = centroidOf(buildableVertices);
  return { startX: c.x - 5, startY: c.y - 5, width: 10, height: 10 };
}

function requiredCornerCounts(n) {
  return { convex: (n + 4) / 2, concave: (n - 4) / 2 };
}

function readFootprintAngles() {
  const n = footprintRowsEl.children.length;
  const angles = [];
  for (let i = 0; i < n; i++) {
    const checked = footprintRowsEl.querySelector(`input[name="footprintAngle${i}"]:checked`);
    angles.push(checked ? parseFloat(checked.value) : 90);
  }
  return angles;
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
  footprintRowsEl.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const defaultLen = seed && seed.lengths ? seed.lengths[i] : displayToFeet(10);
    const defaultAngle = seed && seed.angles ? seed.angles[i] : 90;
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${labels[i]} → ${labels[(i + 1) % n]}</td>` +
      `<td><input type="number" class="footprint-length-input" min="0.1" step="any" value="${feetToDisplay(defaultLen).toFixed(2)}" /></td>` +
      `<td><div class="checkbox-row">` +
      `<input type="radio" name="footprintAngle${i}" value="90" id="footprintAngle${i}_90" ${defaultAngle === 90 ? "checked" : ""} />` +
      `<label for="footprintAngle${i}_90">90&deg;</label>` +
      `<input type="radio" name="footprintAngle${i}" value="270" id="footprintAngle${i}_270" style="margin-left:10px;" ${defaultAngle === 270 ? "checked" : ""} />` +
      `<label for="footprintAngle${i}_270">270&deg;</label>` +
      `</div></td>`;
    footprintRowsEl.appendChild(tr);
  }
  footprintRowsEl.querySelectorAll('input[type="radio"]').forEach((el) => {
    el.addEventListener("change", updateFootprintCornerNote);
  });
  updateFootprintCornerNote();
}

function initFootprintDefaults() {
  if (!lastBuildable || footprintDefaultsInitialized) return;
  footprintDefaultsInitialized = true;
  footprintPlaceholderNoteEl.style.display = "none";
  footprintPreviewBtn.disabled = false;
  const d = computeDefaultFootprint(lastBuildable);
  footprintSidesCountEl.value = 4;
  footprintStartXEl.value = feetToDisplay(d.startX).toFixed(2);
  footprintStartYEl.value = feetToDisplay(d.startY).toFixed(2);
  buildFootprintRows({ lengths: [d.width, d.height, d.width, d.height], angles: [90, 90, 90, 90] });
}

function drawFootprintPreview() {
  if (!currentVertices) return;
  const boundsSource = currentVertices.concat(lastFootprintVertices || []);
  const transform = svgTransformFor(boundsSource);
  let svg = `<polygon points="${polygonPoints(transform, currentVertices)}" fill="none" stroke="#1f2430" stroke-width="2" />`;
  if (lastBuildable && lastBuildable.length >= 3) {
    svg += `<polygon points="${polygonPoints(transform, lastBuildable)}" fill="none" stroke="#999999" stroke-width="1.5" stroke-dasharray="6,4" />`;
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
  if (n % 2 !== 0 || n < 4) {
    showFootprintError(`Number of sides must be even and at least 4 (got ${n}).`);
    return;
  }
  if (!updateFootprintCornerNote()) {
    showFootprintError("Corner angle counts don't add up to a closed shape yet - see the note above the table.");
    return;
  }
  const lengths = readFootprintLengths();
  if (lengths.some((l) => !l || l <= 0)) {
    showFootprintError("Every side needs a length greater than zero.");
    return;
  }
  const allAngles = readFootprintAngles();
  // Vertex A's angle is derived server-side, matching /compute-site's own convention
  // (computeSite() above does the same actualAngles.slice(1)).
  const interiorAngles = allAngles.slice(1);

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
      return;
    }

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
  if (n < 4) n = 4;
  if (n % 2 !== 0) n += 1;
  footprintSidesCountEl.value = n;
  buildFootprintRows();
  drawFootprintPreview();
});
footprintPreviewBtn.addEventListener("click", previewFootprint);

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

updateUnitLabels();
buildEdgeRows();
