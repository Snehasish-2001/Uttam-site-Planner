"""
app.py (uttam-5)

Guided-wizard planner app. Phase 1 (this build): pages 1-4 - project/legal info, an
arbitrary-shape site plot (metes-and-bounds: side lengths + interior angles, any convex or
concave polygon), a building footprint inside that site, and floors/rooms. Pages 5-8
(elevation/section, foundation/soak-pit, CAD export, cost estimate) are deliberately out of
scope for this build.

Reuses uttam-4's proven engine wholesale (layout_geometry.py, json_to_dxf.py, pdf_render.py,
dxf_render.py, layout_semantics.py, the MLightCAD viewer JS), extended only where uttam-4
hard-coded a rectangular plot - see site_geometry.py (the new polygon-math module) and the
PLOT/SETBACK/FOOTPRINT drawing branches added to json_to_dxf.py / pdf_render.py.

    /compute-site       - metes-and-bounds site plot -> resolved plot + buildable polygon
    /compute-footprint  - metes-and-bounds footprint -> resolved footprint + containment check
    /resize-plot        - grow/shrink one real plot by an edge push + regenerated fill
    /regenerate-fill    - rebuild a sub-section's fill/open space from its real plots
    /generate-plan      - (not yet wired - lands with the page-4 LLM generation stage)
    /generate-pdf       - layout.json -> PDF, same contract as uttam-4
    /generate-pdf-from-dxf - live-edited-viewer DXF -> PDF, same contract as uttam-4

Own process, own port (8006), own artifact folders. Run:

    cd uttam-site-planner
    python app.py
    -> http://127.0.0.1:8006/
"""

import json
import traceback
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import dxf_render
import json_to_dxf
import layout_semantics
import pdf_render
from layout_geometry import LayoutError, floor_label, floor_offsets
from site_geometry import (
    SiteGeometryError,
    bounding_rect_hint,
    compute_subsections,
    containment_violations,
    insert_plots,
    offset_polygon_edges,
    polygon_contains,
    regenerate_fill,
    regular_polygon_angles,
    resize_plot,
    vertices_from_edges,
)

ROOT = Path(__file__).resolve().parent

FRONTEND_DIR = ROOT / "frontend"
USER_JSON_DIR = ROOT / "user_json"
FLOORPLANS_DIR = ROOT / "floorplans"
OUTPUT_DIR = ROOT / "output"

for directory in (FRONTEND_DIR, USER_JSON_DIR, FLOORPLANS_DIR, OUTPUT_DIR):
    directory.mkdir(parents=True, exist_ok=True)


app = FastAPI(title="Uttam Planner 5 - Guided Wizard (arbitrary-shape sites)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _no_cache_frontend(request: Request, call_next):
    """Same anti-stale-cache discipline as uttam-4's app.py - this is an actively-edited
    local dev app, force revalidation on the page itself and the static mount so a plain
    refresh always sees the latest JS/CSS, not a cached copy."""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/")
async def home():
    return FileResponse(FRONTEND_DIR / "index.html")


def _file_url(path: Path, route: str) -> str:
    return f"{route}/{path.name}"


def _resolve_polygon(body):
    """Shared lengths+angles -> resolved vertex list logic for /compute-site and
    /compute-footprint. `body` must have "lengths" (list of N numbers) and either
    "regular": true or "interior_angles" (list of N-1 numbers). Returns
    vertices_from_edges()'s result dict. Raises SiteGeometryError / ValueError on bad input -
    callers catch and translate to the usual error envelope."""
    lengths = body.get("lengths")
    if not isinstance(lengths, list) or len(lengths) < 3:
        raise SiteGeometryError("Expected a 'lengths' list with at least 3 side lengths.")
    lengths = [float(l) for l in lengths]

    if body.get("regular"):
        interior_angles = regular_polygon_angles(len(lengths))
    else:
        interior_angles = body.get("interior_angles")
        if not isinstance(interior_angles, list):
            raise SiteGeometryError(
                "Expected an 'interior_angles' list (N-1 angles) unless 'regular' is true."
            )
        interior_angles = [float(a) for a in interior_angles]

    start = body.get("start") or {"x": 0.0, "y": 0.0}
    start_heading = float(body.get("start_heading_deg", 0.0))
    return vertices_from_edges(
        lengths, interior_angles,
        start=(float(start.get("x", 0.0)), float(start.get("y", 0.0))),
        start_heading_deg=start_heading,
    )


@app.post("/compute-site")
async def compute_site(request: Request):
    """Metes-and-bounds site plot (side lengths + interior angles, or 'regular': true) plus
    per-edge setbacks -> the resolved plot polygon and its inset buildable polygon. This is
    the authoritative version of whatever the page-2 client-side preview already sketched -
    the client preview is a per-keystroke convenience, this endpoint is the source of truth
    that gets stored into layout.json's site.plot/site.buildable."""
    try:
        body = await request.json()
        if not isinstance(body, dict):
            return {"success": False, "error": "Invalid request. Expected a JSON object."}

        try:
            walk = _resolve_polygon(body)
        except SiteGeometryError as exc:
            return {"success": False, "stage": "site_geometry", "error": str(exc)}
        except (TypeError, ValueError) as exc:
            return {"success": False, "stage": "site_geometry", "error": f"Bad input: {exc}"}

        plot_vertices = walk["vertices"]

        edges = body.get("edges")
        if not isinstance(edges, list) or len(edges) != len(plot_vertices):
            return {
                "success": False,
                "stage": "site_geometry",
                "error": f"Expected an 'edges' list with {len(plot_vertices)} entries "
                         f"(one per side, each with a 'setback' distance).",
            }
        try:
            setbacks = [float(e.get("setback", 0.0)) for e in edges]
        except (TypeError, ValueError) as exc:
            return {"success": False, "stage": "site_geometry", "error": f"Bad setback value: {exc}"}

        try:
            buildable = offset_polygon_edges(plot_vertices, setbacks)
        except SiteGeometryError as exc:
            return {"success": False, "stage": "site_geometry", "error": str(exc)}

        hint = None
        try:
            hint = bounding_rect_hint(buildable["vertices"])
        except SiteGeometryError:
            pass  # the reference-rectangle hint is a nice-to-have, never blocks the response

        return {
            "success": True,
            "plot": {"vertices": plot_vertices},
            "buildable": {"vertices": buildable["vertices"], "repaired": buildable["repaired"]},
            "closure_error_ft": walk["closure_error_ft"],
            "adjusted": walk["adjusted"],
            "suggested_rect": hint,
        }

    except Exception as exc:
        return {
            "success": False,
            "stage": "pipeline",
            "error": f"Unexpected error: {exc}",
            "detail": traceback.format_exc(),
        }


@app.post("/compute-footprint")
async def compute_footprint(request: Request):
    """Metes-and-bounds building footprint (same shape as /compute-site's polygon input,
    plus an optional 'start' anchor point since a footprint sits somewhere inside the site
    rather than always starting at the origin) -> the resolved footprint polygon and an
    authoritative containment check against the buildable polygon the client already has
    from /compute-site."""
    try:
        body = await request.json()
        if not isinstance(body, dict):
            return {"success": False, "error": "Invalid request. Expected a JSON object."}

        try:
            walk = _resolve_polygon(body)
        except SiteGeometryError as exc:
            return {"success": False, "stage": "site_geometry", "error": str(exc)}
        except (TypeError, ValueError) as exc:
            return {"success": False, "stage": "site_geometry", "error": f"Bad input: {exc}"}

        footprint_vertices = walk["vertices"]

        buildable = body.get("buildable")
        buildable_vertices = buildable.get("vertices") if isinstance(buildable, dict) else None
        if not isinstance(buildable_vertices, list) or len(buildable_vertices) < 3:
            return {
                "success": False,
                "stage": "site_geometry",
                "error": "Expected 'buildable': {vertices: [...]} - the buildable polygon "
                         "from a prior /compute-site call.",
            }

        try:
            contained = polygon_contains(footprint_vertices, buildable_vertices)
            violation_area = containment_violations(footprint_vertices, buildable_vertices)
        except Exception as exc:
            return {"success": False, "stage": "site_geometry", "error": f"Containment check failed: {exc}"}

        return {
            "success": True,
            "footprint": {"vertices": footprint_vertices},
            "closure_error_ft": walk["closure_error_ft"],
            "adjusted": walk["adjusted"],
            "contained": contained,
            "violation_area_sqft": round(violation_area, 2),
        }

    except Exception as exc:
        return {
            "success": False,
            "stage": "pipeline",
            "error": f"Unexpected error: {exc}",
            "detail": traceback.format_exc(),
        }


@app.post("/compute-subsections")
async def compute_subsections_endpoint(request: Request):
    """Master plot vertices + the finalized road network -> the sub-section polygons left
    over once every road's own width is carved out. `body` must have 'plot': {vertices:[...]}
    and 'roads': [{start:{x,y}, end:{x,y}, width}, ...]. This is the authoritative,
    shapely-backed polygon subtraction the plot-logic stage builds on - carving road strips
    out of an arbitrary (possibly concave) plot by hand in JS would be far more error-prone."""
    try:
        body = await request.json()
        if not isinstance(body, dict):
            return {"success": False, "error": "Invalid request. Expected a JSON object."}

        plot = body.get("plot")
        plot_vertices = plot.get("vertices") if isinstance(plot, dict) else None
        if not isinstance(plot_vertices, list) or len(plot_vertices) < 3:
            return {
                "success": False,
                "stage": "site_geometry",
                "error": "Expected 'plot': {vertices: [...]} - the resolved plot polygon from /compute-site.",
            }

        roads = body.get("roads")
        if not isinstance(roads, list):
            return {"success": False, "stage": "site_geometry", "error": "Expected a 'roads' list."}

        try:
            subsections = compute_subsections(plot_vertices, roads)
        except Exception as exc:
            return {"success": False, "stage": "site_geometry", "error": f"Subsection computation failed: {exc}"}

        return {
            "success": True,
            "subsections": [{"vertices": verts} for verts in subsections],
        }

    except Exception as exc:
        return {
            "success": False,
            "stage": "pipeline",
            "error": f"Unexpected error: {exc}",
            "detail": traceback.format_exc(),
        }


@app.post("/insert-plots")
async def insert_plots_endpoint(request: Request):
    """One sub-section polygon + which of its edges actually face a road + sizing params ->
    the plots that fill it: rectangular/trapezoidal frontage plots first (clipped against
    real remaining land via shapely, not stamped at a fixed size), then whatever's left over
    tiled edge-to-edge with triangles via constrained Delaunay triangulation, so nothing in
    the sub-section goes unaccounted for as "waste" that a rectangle-only approach would have
    left in the corners. `body` must have 'subsection': {vertices:[...]}, 'roadFacingEdges':
    [{a:{x,y}, b:{x,y}}, ...], and 'params': {minLength, maxLength, minWidth, maxWidth,
    minGap, roadThreshold, maxPlots}."""
    try:
        body = await request.json()
        if not isinstance(body, dict):
            return {"success": False, "error": "Invalid request. Expected a JSON object."}

        sub = body.get("subsection")
        sub_vertices = sub.get("vertices") if isinstance(sub, dict) else None
        if not isinstance(sub_vertices, list) or len(sub_vertices) < 3:
            return {
                "success": False,
                "stage": "site_geometry",
                "error": "Expected 'subsection': {vertices: [...]} - one polygon from /compute-subsections.",
            }

        road_facing_edges = body.get("roadFacingEdges")
        if not isinstance(road_facing_edges, list):
            return {"success": False, "stage": "site_geometry", "error": "Expected a 'roadFacingEdges' list."}

        params = body.get("params")
        if not isinstance(params, dict):
            return {"success": False, "stage": "site_geometry", "error": "Expected a 'params' object."}

        try:
            result = insert_plots(sub_vertices, road_facing_edges, params)
        except Exception as exc:
            return {"success": False, "stage": "site_geometry", "error": f"Plot insertion failed: {exc}"}

        return {"success": True, **result}

    except Exception as exc:
        return {
            "success": False,
            "stage": "pipeline",
            "error": f"Unexpected error: {exc}",
            "detail": traceback.format_exc(),
        }


@app.post("/resize-plot")
async def resize_plot_endpoint(request: Request):
    """Grow or shrink ONE real plot by pushing one of its non-frontage edges, and hand back the
    sub-section's regenerated fill/open space. `body` needs 'subsection': {vertices:[...]},
    'roadFacingEdges': [...], 'plots': [{name, vertices, fill}, ...], 'plotName', 'params', and
    either 'targetArea' or 'direction' ("grow"/"shrink") with an optional 'stepFt'; 'edgeIndex'
    picks a specific edge instead of the automatic rear-then-sides order.

    Only the named plot's own polygon ever changes - no other real plot is moved or re-saved."""
    try:
        body = await request.json()
        if not isinstance(body, dict):
            return {"success": False, "error": "Invalid request. Expected a JSON object."}

        sub = body.get("subsection")
        sub_vertices = sub.get("vertices") if isinstance(sub, dict) else None
        if not isinstance(sub_vertices, list) or len(sub_vertices) < 3:
            return {"success": False, "stage": "site_geometry",
                    "error": "Expected 'subsection': {vertices: [...]}."}
        plots = body.get("plots")
        if not isinstance(plots, list) or not plots:
            return {"success": False, "stage": "site_geometry", "error": "Expected a 'plots' list."}
        plot_name = body.get("plotName")
        if not plot_name:
            return {"success": False, "stage": "site_geometry", "error": "Expected a 'plotName'."}

        target_area = body.get("targetArea")
        direction = body.get("direction")
        if target_area is None and direction not in ("grow", "shrink"):
            return {"success": False, "stage": "site_geometry",
                    "error": "Expected either 'targetArea' or 'direction': 'grow' | 'shrink'."}

        edge_index = body.get("edgeIndex")
        try:
            result = resize_plot(
                sub_vertices,
                body.get("roadFacingEdges") or [],
                plots,
                plot_name,
                body.get("params") or {},
                direction=direction,
                step_ft=float(body.get("stepFt") or 2.0),
                target_area=float(target_area) if target_area is not None else None,
                edge_index=int(edge_index) if edge_index is not None else None,
            )
        except SiteGeometryError as exc:
            return {"success": False, "stage": "site_geometry", "error": str(exc)}
        except Exception as exc:
            return {"success": False, "stage": "site_geometry",
                    "error": f"Resize failed: {exc}", "detail": traceback.format_exc()}

        if "error" in result:
            return {"success": False, "stage": "resize", **result}
        return {"success": True, **result}

    except Exception as exc:
        return {"success": False, "stage": "pipeline", "error": f"Unexpected error: {exc}",
                "detail": traceback.format_exc()}


@app.post("/regenerate-fill")
async def regenerate_fill_endpoint(request: Request):
    """Rebuild one sub-section's fill plots and open space from its real plots alone. Fill is a
    derived view of `sub-section - union(real plots)`, so this runs after any manual edge or
    diagonal edit is saved, the same way /resize-plot regenerates it after a stepper push.
    `body` needs 'subsection': {vertices:[...]}, 'plots': [...], and 'params'."""
    try:
        body = await request.json()
        if not isinstance(body, dict):
            return {"success": False, "error": "Invalid request. Expected a JSON object."}

        sub = body.get("subsection")
        sub_vertices = sub.get("vertices") if isinstance(sub, dict) else None
        if not isinstance(sub_vertices, list) or len(sub_vertices) < 3:
            return {"success": False, "stage": "site_geometry",
                    "error": "Expected 'subsection': {vertices: [...]}."}

        try:
            result = regenerate_fill(sub_vertices, body.get("plots") or [], body.get("params") or {})
        except SiteGeometryError as exc:
            return {"success": False, "stage": "site_geometry", "error": str(exc)}
        except Exception as exc:
            return {"success": False, "stage": "site_geometry",
                    "error": f"Fill regeneration failed: {exc}", "detail": traceback.format_exc()}

        return {"success": True, **result}

    except Exception as exc:
        return {"success": False, "stage": "pipeline", "error": f"Unexpected error: {exc}",
                "detail": traceback.format_exc()}


@app.post("/generate-pdf")
async def generate_pdf(request: Request):
    """layout.json -> pdf_render.generate() -> PDF (one page per floor). Same contract as
    uttam-4's /generate-pdf."""
    try:
        layout = await request.json()
        if not isinstance(layout, dict):
            return {"success": False, "error": "Invalid request. Expected a layout JSON object."}

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        pdf_file = OUTPUT_DIR / f"plan_{timestamp}.pdf"

        try:
            pdf_result = pdf_render.generate(layout, pdf_file)
        except LayoutError as exc:
            return {"success": False, "stage": "pdf_render", "error": str(exc)}
        except Exception as exc:
            return {
                "success": False,
                "stage": "pdf_render",
                "error": f"PDF generation failed: {exc}",
                "detail": traceback.format_exc(),
            }

        if not pdf_file.exists():
            return {"success": False, "stage": "verification", "error": "PDF generation finished but the file is missing."}

        return {
            "success": True,
            "pdf_url": _file_url(pdf_file, "/output"),
            "page_count": pdf_result["page_count"],
        }

    except Exception as exc:
        return {
            "success": False,
            "stage": "pipeline",
            "error": f"Unexpected pipeline error: {exc}",
            "detail": traceback.format_exc(),
        }


@app.post("/generate-plan")
async def generate_plan(request: Request):
    """layout.json -> json_to_dxf.generate() -> DXF, ready for the in-browser viewer.
    Same contract as uttam-4's /generate-plan. Whatever produced this layout.json (today:
    hand-built/test fixtures; once page 4's layout_engine.py fork lands: an LLM call
    retargeted to this same schema) is upstream of this endpoint - it only renders."""
    try:
        layout = await request.json()
        if not isinstance(layout, dict):
            return {"success": False, "error": "Invalid request. Expected a layout JSON object."}

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        json_file = USER_JSON_DIR / "layout.json"
        dxf_file = FLOORPLANS_DIR / f"plan_{timestamp}.dxf"

        try:
            json_file.write_text(json.dumps(layout, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception as exc:
            return {"success": False, "error": f"Could not save layout.json: {exc}", "detail": traceback.format_exc()}

        try:
            dxf_result = json_to_dxf.generate(layout, dxf_file)
        except LayoutError as exc:
            return {"success": False, "stage": "json_to_dxf", "error": str(exc)}
        except Exception as exc:
            return {
                "success": False,
                "stage": "json_to_dxf",
                "error": f"DXF generation failed: {exc}",
                "detail": traceback.format_exc(),
            }

        if not dxf_file.exists():
            return {"success": False, "stage": "verification", "error": "DXF generation finished but the file is missing."}

        semantic_warnings = []
        try:
            for floor, _y_offset, index in floor_offsets(layout):
                label = floor_label(floor, index)
                for warning in layout_semantics.validate_semantics(floor):
                    semantic_warnings.append(f"{label}: {warning}")
        except Exception:
            pass  # semantics is advisory only - never let it block a successful generation

        footprint_warning = None
        footprint_vertices = (layout.get("footprint") or {}).get("vertices")
        if footprint_vertices:
            try:
                for floor, _y_offset, index in floor_offsets(layout):
                    for room in floor.get("rooms", []):
                        room_poly = [
                            {"x": room["x"], "y": room["y"]},
                            {"x": room["x"] + room["width"], "y": room["y"]},
                            {"x": room["x"] + room["width"], "y": room["y"] + room["height"]},
                            {"x": room["x"], "y": room["y"] + room["height"]},
                        ]
                        if not polygon_contains(room_poly, footprint_vertices):
                            footprint_warning = (
                                f"{floor_label(floor, index)}: room '{room.get('name', '?')}' "
                                f"extends outside the building footprint."
                            )
                            break
                    if footprint_warning:
                        break
            except Exception:
                pass  # advisory only, same as semantic_warnings

        return {
            "success": True,
            "layout_url": _file_url(json_file, "/user-json"),
            "dxf_url": _file_url(dxf_file, "/floorplans"),
            "floor_bands": dxf_result["floor_bands"],
            "semantic_warnings": semantic_warnings,
            "footprint_warning": footprint_warning,
            "layout": layout,
        }

    except Exception as exc:
        return {
            "success": False,
            "stage": "pipeline",
            "error": f"Unexpected pipeline error: {exc}",
            "detail": traceback.format_exc(),
        }


@app.post("/generate-pdf-from-dxf")
async def generate_pdf_from_dxf(request: Request):
    """Renders a PDF straight from a DXF's own entities (dxf_render.py) - the live-edited-
    viewer export path. Same contract as uttam-4's endpoint of the same name."""
    try:
        body = await request.json()
        dxf_text = body.get("dxf") if isinstance(body, dict) else None
        if not isinstance(dxf_text, str) or not dxf_text.strip():
            return {"success": False, "error": "Expected a JSON body shaped {dxf: <ASCII DXF text>}."}

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        dxf_file = FLOORPLANS_DIR / f"edited_{timestamp}.dxf"
        pdf_file = OUTPUT_DIR / f"edited_{timestamp}.pdf"

        try:
            dxf_file.write_text(dxf_text, encoding="utf-8")
        except Exception as exc:
            return {"success": False, "error": f"Could not save the exported DXF: {exc}", "detail": traceback.format_exc()}

        try:
            pdf_result = dxf_render.generate(dxf_file, pdf_file)
        except Exception as exc:
            return {
                "success": False,
                "stage": "dxf_render",
                "error": f"Could not render a PDF from the exported DXF: {exc}",
                "detail": traceback.format_exc(),
            }

        if not pdf_file.exists():
            return {"success": False, "stage": "verification", "error": "PDF generation finished but the file is missing."}

        return {
            "success": True,
            "dxf_url": _file_url(dxf_file, "/floorplans"),
            "pdf_url": _file_url(pdf_file, "/output"),
            "page_count": pdf_result["page_count"],
        }

    except Exception as exc:
        return {
            "success": False,
            "stage": "pipeline",
            "error": f"Unexpected pipeline error: {exc}",
            "detail": traceback.format_exc(),
        }


app.mount("/user-json", StaticFiles(directory=USER_JSON_DIR), name="user-json")
app.mount("/floorplans", StaticFiles(directory=FLOORPLANS_DIR), name="floorplans")
app.mount("/output", StaticFiles(directory=OUTPUT_DIR), name="output")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8006, reload=True)
