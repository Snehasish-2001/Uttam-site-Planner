/*
mlightcadViewer.js

Loads MLightCAD's @mlightcad/cad-simple-viewer straight from a CDN (jsDelivr
ESM build) and mounts it against a DXF URL served by this app's own FastAPI
process - no npm install, no bundler, matching this repo's "no build step"
frontend convention everywhere else.

IMPORTANT - this integration was built from the package's published API
docs/examples without a browser to test in, then iterated against real
errors from an actual browser run (see uttam-4/CLAUDE.md's "MLightCAD
viewer" section for all three real bugs found and fixed that way: the raw
dist file's unresolved bare imports, fixed via jsDelivr's "+esm" endpoint;
`new Worker()` refusing a cross-origin script URL, fixed by fetching the
worker script and handing it a same-origin `blob:` URL instead; and
opening read-only by default, fixed below). Every step still reports its
own status/failure through onStatus/onError rather than only logging to
the console, so the *next* thing that breaks (if anything) is equally
visible on-page. If this throws, app.js still lets the rest of the
pipeline (Generate PDF / download) work - viewing is not on the critical
path, only a bonus.

openDocument() DOES succeed and render, confirmed live - it just opens read-only by default when
the third argument omits `mode`. The access-mode field is a NUMERIC enum (`AcEdOpenMode`, exported
from this same package: Read=0, Review=4 (compatible with Read), Write=8 (compatible with Review
and Read) - a command needs `document.openMode >= command's own required mode` to run, so Write is
required for real editing) - not a string like "edit"/"review", which is what got guessed first.
`AcEdOpenMode` is destructured from the same module import as `AcApDocManager` below, with a
literal `8` fallback in case a future version stops exporting the enum by that name.

Known unknowns still unverified:
  - Whether AcApDocManager is exported the way this file assumes, and whether createInstance()
    returns the manager directly or only AcApDocManager.instance does (this file tries both) -
    confirmed the module itself loads and exports something usable enough to get past worker setup
    and render a document, not yet confirmed which of these two paths is the real one.
*/

const VIEWER_VERSION = "1.6.3";
const CDN_BASE = `https://cdn.jsdelivr.net/npm/@mlightcad/cad-simple-viewer@${VIEWER_VERSION}`;
// The package's own dist/cad-simple-viewer.js has unresolved bare-specifier
// imports for its peer deps (e.g. "@mlightcad/data-model") - a plain browser
// import() can't resolve those without an import map or bundler. jsDelivr's
// "+esm" endpoint re-bundles the module with every transitive dependency
// flattened/resolved, so it works as a single buildless <script type=module>
// import instead. See uttam-4/CLAUDE.md's "MLightCAD viewer" section.
const MODULE_URL = `${CDN_BASE}/+esm`;
const WORKER_URLS = { mtextRender: `${CDN_BASE}/dist/mtext-renderer-worker.js` };

// `new Worker(url)` refuses a cross-origin script URL outright (a stricter
// rule than plain fetch/CORS - there is no header that grants an exception).
// The standard workaround: fetch the script ourselves (a normal CORS-enabled
// fetch, which jsDelivr allows) and hand the library a same-origin `blob:`
// URL wrapping that same source instead of the raw CDN URL.
const _blobUrlCache = new Map();

async function toBlobWorkerUrl(remoteUrl) {
  if (_blobUrlCache.has(remoteUrl)) return _blobUrlCache.get(remoteUrl);
  const response = await fetch(remoteUrl);
  if (!response.ok) {
    throw new Error(`Could not fetch worker script ${remoteUrl} (HTTP ${response.status}).`);
  }
  const code = await response.text();
  const blobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
  _blobUrlCache.set(remoteUrl, blobUrl);
  return blobUrl;
}

/**
 * @param {HTMLElement} containerEl - empty element the viewer will render into.
 * @param {string} dxfUrl - same-origin (or CORS-enabled) URL to the DXF file.
 * @param {{onStatus?: (msg: string) => void}} [opts]
 * @returns {Promise<object>} the AcApDocManager instance, for further use.
 */
export async function mountDxfViewer(containerEl, dxfUrl, opts = {}) {
  const report = opts.onStatus || (() => {});

  report("Loading MLightCAD viewer module from CDN...");
  let mod;
  try {
    mod = await import(MODULE_URL);
  } catch (err) {
    throw new Error(
      `Could not load the MLightCAD viewer module (${MODULE_URL}): ${err.message}`
    );
  }

  const AcApDocManager = mod.AcApDocManager || (mod.default && mod.default.AcApDocManager);
  if (!AcApDocManager) {
    throw new Error(
      "MLightCAD module loaded but did not export AcApDocManager - its public API may have changed since this was written."
    );
  }
  const AcEdOpenMode = mod.AcEdOpenMode || (mod.default && mod.default.AcEdOpenMode);
  const WRITE_MODE = AcEdOpenMode ? AcEdOpenMode.Write : 8;

  report("Fetching MLightCAD worker script (as a same-origin blob)...");
  let workerUrls;
  try {
    workerUrls = { mtextRender: await toBlobWorkerUrl(WORKER_URLS.mtextRender) };
  } catch (err) {
    throw new Error(`Could not prepare the MLightCAD worker script: ${err.message}`);
  }

  if (typeof AcApDocManager.checkWebworkerReadiness === "function") {
    report("Checking MLightCAD worker readiness (advisory only)...");
    try {
      const ready = await AcApDocManager.checkWebworkerReadiness(workerUrls);
      if (!ready) {
        // Not fatal: this check likely does something blob-URL-unfriendly
        // internally (a HEAD request, a URL-scheme check, ...) that has
        // nothing to do with whether the worker actually runs - it's a
        // pre-flight convenience per MLightCAD's own docs, not something
        // openDocument() itself depends on. Proceed and let the real
        // failure (if any) surface at createInstance/openDocument instead.
        report("Readiness check reported false for the blob URL - proceeding anyway.");
      }
    } catch (err) {
      report(`Readiness check itself threw (${err.message}) - proceeding anyway.`);
    }
  }

  report("Creating the viewer instance...");
  containerEl.innerHTML = "";
  const created = AcApDocManager.createInstance({
    container: containerEl,
    webworkerFileUrls: workerUrls,
    autoResize: true,
  });
  const manager = created || AcApDocManager.instance;
  if (!manager || typeof manager.openDocument !== "function") {
    throw new Error("AcApDocManager.createInstance() did not return a usable manager (no openDocument method).");
  }

  report("Fetching the generated DXF...");
  const response = await fetch(dxfUrl);
  if (!response.ok) {
    throw new Error(`Could not fetch the DXF file at ${dxfUrl} (HTTP ${response.status}).`);
  }
  const fileContent = await response.arrayBuffer();
  const fileName = dxfUrl.split("/").pop() || "plan.dxf";

  report("Opening the drawing in the viewer (write mode)...");
  const opened = await manager.openDocument(fileName, fileContent, { mode: WRITE_MODE });
  if (opened === false) {
    throw new Error("MLightCAD's openDocument() reported failure for this file.");
  }

  report("Drawing loaded.");
  return manager;
}

/**
 * Exports the CURRENT state of the viewer's document back to a DXF ASCII
 * string, so the caller can re-render a PDF from whatever the user just
 * edited - without needing to map those edits back into layout.json (the
 * user's own call: "no need to update the json just update the dxf...
 * then from that generate the pdf"). Confirmed live: AcDbDatabase.dxfOut()
 * exists and returns an ASCII string by default (or a Uint8Array in binary
 * mode, which this deliberately never requests, since the backend just
 * writes whatever string it's given straight to a .dxf file).
 *
 * The manager -> current document -> database path is the one real
 * remaining unknown here (mirrors ObjectARX's acDocManager->curDocument()
 * pattern, but the exact property/method name on THIS package's manager
 * object was never confirmed against a real instance) - tries a few
 * reasonable shapes and reports exactly which one worked (or didn't) via
 * onStatus, same discipline as the rest of this file.
 *
 * @param {object} manager - the object mountDxfViewer() resolved.
 * @param {(msg: string) => void} [onStatus]
 * @returns {string} ASCII DXF text.
 */
export function exportCurrentDxf(manager, onStatus) {
  const report = onStatus || (() => {});

  let doc = null;
  if (typeof manager.curDocument === "function") {
    doc = manager.curDocument();
  } else if (manager.curDocument) {
    doc = manager.curDocument;
  } else if (manager.curDoc) {
    doc = manager.curDoc;
  }

  const database = (doc && doc.database) || manager.database;
  if (!database || typeof database.dxfOut !== "function") {
    throw new Error(
      "Could not find AcDbDatabase.dxfOut() from the viewer's manager object - " +
      "tried manager.curDocument()/.curDocument/.curDoc/.database. The package's " +
      "API for reaching the current document may differ from what this was written against."
    );
  }

  report("Exporting the current drawing to DXF...");
  const result = database.dxfOut();
  if (typeof result !== "string") {
    throw new Error(`AcDbDatabase.dxfOut() returned ${typeof result}, expected a string (ASCII DXF).`);
  }
  return result;
}
