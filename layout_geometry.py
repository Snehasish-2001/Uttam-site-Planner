"""
layout_geometry.py

Shared geometry/validation helpers for uttam-4's simple multi-floor schema.
Both json_to_dxf.py (DXF writer) and pdf_render.py (PDF writer) import this
module for plot/setback/floor-offset math, so the two renderers can never
silently disagree about where a floor sits or what its buildable area is -
see the repo-root CLAUDE.md's own record of exactly this kind of drift
(dxf_to_pdf.py/planPreview.js/rich_planner.py re-deriving the same geometry
three different ways) for why this is worth doing from the start here.

Schema (see sample_layout.json for a full worked example):

{
  "project": {"name": "..."},
  "site": {
    "plot": {"width": <ft>, "depth": <ft>},
    "setbacks": {"front": <ft>, "rear": <ft>, "left": <ft>, "right": <ft>}
  },
  "floors": [
    {
      "name": "Ground Floor",
      "level": 0,
      "rooms":   [{"name": str, "x", "y", "width", "height"}, ...],
      "doors":   [{"x", "y", "width", "orientation": "horizontal"|"vertical", "swing": "ccw"|"cw"}, ...],
      "windows": [{"x", "y", "width", "orientation": "horizontal"|"vertical"}, ...],
      "stairs":  [{"x", "y", "width", "height", "steps"}, ...],
      "parking": [{"name", "x", "y", "width", "height"}, ...]
    },
    ...
  ],
  "annotations": {"overall_dimensions": true},
  "north_arrow": {"x": <ft>, "y": <ft>}
}

All coordinates are in feet, one shared plot footprint per floor (this is a
simple schema - it does not support a floor with a different footprint than
the one below it), origin (0,0) at the plot's bottom-left corner, X = East,
Y = North. Floors are stacked vertically in drawing space (not overlaid) so
a single DXF/PDF can show every floor of the building.
"""

FLOOR_GAP_FT = 12.0

DEFAULT_PLOT = {"width": 40.0, "depth": 30.0}
DEFAULT_SETBACKS = {"front": 0.0, "rear": 0.0, "left": 0.0, "right": 0.0}
DEFAULT_WALL_THICKNESS = 0.5  # ft ~= 150mm, matching a typical real partition wall

LANDING_DEPTH_FT = 3.5  # ft - a switchback stair's shared mid-landing depth
MIN_FLIGHT_RUN_FT = 3.0  # ft - below this a flight reads as absurdly cramped
MIN_FLIGHT_WIDTH_FT = 2.5  # ft - ditto, for a flight's own walkable width


class LayoutError(ValueError):
    """Raised for a structurally invalid layout JSON - always a plain,
    specific message naming exactly what's missing/wrong, never a bare
    KeyError/TypeError leaking out of this module."""


def _num(value, field_name):
    try:
        return float(value)
    except (TypeError, ValueError):
        raise LayoutError(f"Expected a number for '{field_name}', got: {value!r}")


def get_plot(site):
    """For a polygon plot (site.plot.vertices present - uttam-5's arbitrary-shape sites),
    returns the plot's own bounding-box width/depth rather than requiring width/depth keys
    directly. This is only used where an actual bounding dimension is needed (e.g.
    floor_offsets()'s vertical floor-stacking gap) - a safe, conservative stand-in for a
    non-rectangular footprint, never used to draw the boundary itself (see
    json_to_dxf.draw_site_and_footprint() / pdf_render's equivalent, which draw the real
    polygon directly from site.plot.vertices when present)."""
    plot = site.get("plot", DEFAULT_PLOT) if isinstance(site, dict) else DEFAULT_PLOT
    vertices = plot.get("vertices") if isinstance(plot, dict) else None
    if vertices:
        xs = [_num(v.get("x"), "site.plot.vertices[].x") for v in vertices]
        ys = [_num(v.get("y"), "site.plot.vertices[].y") for v in vertices]
        return {"width": max(xs) - min(xs), "depth": max(ys) - min(ys)}
    return {
        "width": _num(plot.get("width", DEFAULT_PLOT["width"]), "site.plot.width"),
        "depth": _num(plot.get("depth", DEFAULT_PLOT["depth"]), "site.plot.depth"),
    }


def get_setbacks(site):
    setbacks = site.get("setbacks", {}) if isinstance(site, dict) else {}
    return {
        key: _num(setbacks.get(key, default), f"site.setbacks.{key}")
        for key, default in DEFAULT_SETBACKS.items()
    }


def buildable_rect(site):
    """Returns (x, y, width, height) of the buildable area, in feet,
    relative to the plot's own (0,0) - i.e. before any floor Y offset."""
    plot = get_plot(site)
    setbacks = get_setbacks(site)

    x = setbacks["left"]
    y = setbacks["front"]
    w = plot["width"] - setbacks["left"] - setbacks["right"]
    h = plot["depth"] - setbacks["front"] - setbacks["rear"]

    if w <= 0 or h <= 0:
        raise LayoutError(
            f"Setbacks leave no buildable area (plot {plot['width']}x{plot['depth']} ft, "
            f"setbacks front={setbacks['front']} rear={setbacks['rear']} "
            f"left={setbacks['left']} right={setbacks['right']})."
        )

    return x, y, w, h


def validate_floor(floor, index):
    if not isinstance(floor, dict):
        raise LayoutError(f"floors[{index}] must be an object, got: {type(floor).__name__}")

    for key in ("rooms", "doors", "windows", "stairs", "parking"):
        value = floor.get(key, [])
        if not isinstance(value, list):
            raise LayoutError(f"floors[{index}].{key} must be a list, got: {type(value).__name__}")

    for room_index, room in enumerate(floor.get("rooms", [])):
        for field in ("name", "x", "y", "width", "height"):
            if field not in room:
                raise LayoutError(
                    f"floors[{index}].rooms[{room_index}] is missing '{field}': {room}"
                )
        _num(room["width"], f"floors[{index}].rooms[{room_index}].width")
        _num(room["height"], f"floors[{index}].rooms[{room_index}].height")


def floor_offsets(data):
    """Returns [(floor_dict, y_offset_ft, index), ...] - every floor stacked
    bottom-up in the order given in floors[], each sitting on the same
    plot footprint shifted up by every earlier floor's depth + FLOOR_GAP_FT.
    Validates every floor as it goes (fail fast, name the exact floor)."""
    floors = data.get("floors")
    if not isinstance(floors, list) or not floors:
        raise LayoutError("Layout must have a non-empty 'floors' array.")

    plot = get_plot(data.get("site", {}))
    plot_h = plot["depth"]

    result = []
    for index, floor in enumerate(floors):
        validate_floor(floor, index)
        y_offset = index * (plot_h + FLOOR_GAP_FT)
        result.append((floor, y_offset, index))
    return result


def floor_label(floor, index):
    name = floor.get("name")
    return str(name) if name else f"Floor {index}"


def get_wall_thickness(site):
    if isinstance(site, dict) and "wall_thickness" in site:
        return _num(site["wall_thickness"], "site.wall_thickness")
    return DEFAULT_WALL_THICKNESS


def _room_edges(room):
    """A room's 4 boundary edges, in LOCAL (un-shifted) floor coordinates.
    'side' is which bound of the fixed axis this edge sits on - needed to
    know which direction is "into the room" versus "facing the next room"."""
    x, y = float(room["x"]), float(room["y"])
    w, h = float(room["width"]), float(room["height"])
    return [
        {"orient": "H", "coord": y, "span": (x, x + w), "side": "min", "room": room},
        {"orient": "H", "coord": y + h, "span": (x, x + w), "side": "max", "room": room},
        {"orient": "V", "coord": x, "span": (y, y + h), "side": "min", "room": room},
        {"orient": "V", "coord": x + w, "span": (y, y + h), "side": "max", "room": room},
    ]


def _span_overlap(a, b):
    lo, hi = max(a[0], b[0]), min(a[1], b[1])
    return max(0.0, hi - lo), lo, hi


def _subtract_interval(spans, lo, hi):
    """Removes [lo, hi] from a list of disjoint (start, end) spans, returning
    the remaining pieces (splitting a span in two if [lo, hi] falls in its
    middle). Used to track each wall edge's own not-yet-matched sub-spans as
    nearest-neighbor pairing claims pieces of it - see build_wall_bands()."""
    result = []
    for a, b in spans:
        if a < lo:
            result.append((a, min(b, lo)))
        if b > hi:
            result.append((max(a, hi), b))
    return [(a, b) for a, b in result if b - a > 1e-6]


def _openings_for_floor(floor):
    """Every door/window as (orient, fixed_coord, span) - the same shape as
    a room edge, so cutting a wall line just means subtracting overlapping
    opening spans on the same orient/coord from the wall's own span."""
    openings = []
    for kind in ("doors", "windows"):
        for item in floor.get(kind, []):
            x, y = float(item["x"]), float(item["y"])
            width = float(item.get("width", 3 if kind == "doors" else 4))
            if item.get("orientation", "horizontal") == "horizontal":
                openings.append(("H", y, (x, x + width)))
            else:
                openings.append(("V", x, (y, y + width)))
    return openings


def _cut_span(span, coords, orient, openings, coord_tol):
    """Subtract every opening on the same orient within coord_tol of ANY of
    `coords` (a wall band's one or two face coordinates) from `span`,
    returning the list of remaining (start, end) sub-spans - i.e. the
    visible wall segments once door/window gaps are cut out. Cutting by the
    whole band at once (rather than once per face) guarantees both faces of
    a double-line wall are cut identically - an opening goes all the way
    through, never through only one face."""
    cuts = []
    for o_orient, o_coord, o_span in openings:
        if o_orient != orient or not any(abs(o_coord - c) <= coord_tol for c in coords):
            continue
        overlap, lo, hi = _span_overlap(span, o_span)
        if overlap > 1e-6:
            cuts.append((lo, hi))

    if not cuts:
        return [span]

    cuts.sort()
    merged = [cuts[0]]
    for lo, hi in cuts[1:]:
        if lo <= merged[-1][1] + 1e-6:
            merged[-1] = (merged[-1][0], max(merged[-1][1], hi))
        else:
            merged.append((lo, hi))

    segments, cursor = [], span[0]
    for lo, hi in merged:
        if lo > cursor + 1e-6:
            segments.append((cursor, lo))
        cursor = max(cursor, hi)
    if cursor < span[1] - 1e-6:
        segments.append((cursor, span[1]))
    return segments


def build_wall_bands(floor, wall_thickness=None, min_wall_for_double=0.12, max_pair_gap=3.0):
    """Derives drawable, FILLABLE wall bands from a floor's room rectangles,
    matching a real architect's DXF convention (a solid-filled wall of real
    thickness with door/window gaps cut all the way through) instead of
    drawing each room as a thin single-line outline.

    Two rooms whose facing edges are close together (within max_pair_gap)
    are treated as sharing ONE interior wall - its two faces sit exactly at
    each room's own edge, so the wall's thickness is whatever gap the
    layout JSON already leaves between them (this repo's sample fixtures
    use deliberate ~0.5ft gaps for exactly this reason). If that gap is
    smaller than min_wall_for_double (including the common case of two
    rooms tiled with zero gap, as older fixtures do), the band is
    degenerate (coord_a == coord_b) - there's no real thickness to show
    without inventing an offset that would shrink one of the rooms, so
    callers should draw a single line for it rather than a filled quad.

    A room's edge can face MORE THAN ONE neighbor along its length (a
    T-junction - e.g. one room's full-height edge touching two stacked
    rooms on the other side). Pairing tracks each edge's own *remaining*
    uncovered sub-spans (`_subtract_interval()`), not just a whole-edge
    used/unused flag, and matches the nearest candidate first for whatever
    portion is still uncovered - so every sub-range gets paired against
    whichever room actually faces it there, rather than the whole edge
    being claimed by the first match found and everything past that point
    silently falling through to the exterior case below (a real bug this
    replaced: the "leftover" portion of a T-junction edge was rendering as
    a synthetic-thickness exterior skirt instead of the thin/matched
    interior wall it actually is).

    Only after every edge's nearest-neighbor matching is exhausted does any
    remaining uncovered sub-span get treated as exterior (an edge with no
    facing partner at all, or a genuine gap wider than max_pair_gap) -
    those get a synthetic second face inset by `wall_thickness` into that
    room, so exterior walls still render with real fillable thickness even
    though the JSON only states one boundary for them.

    Returns a list of (orient, coord_a, coord_b, segments) bands, where
    `segments` is a list of (start, end) sub-spans along the free axis
    (already cut for door/window openings - both faces share identical
    cuts, see _cut_span). Coordinates are in the same LOCAL (un-shifted)
    floor coordinates as the room data itself - callers apply their own
    floor Y-offset and unit conversion, and draw a filled quad between
    coord_a/coord_b for each segment (or a single line when coord_a ==
    coord_b).
    """
    if wall_thickness is None:
        wall_thickness = DEFAULT_WALL_THICKNESS

    edges = []
    for room in floor.get("rooms", []):
        edges.extend(_room_edges(room))

    openings = _openings_for_floor(floor)
    opening_tol = wall_thickness + 0.25

    bands = []

    def add_band(orient, coord_a, coord_b, span):
        segments = _cut_span(span, (coord_a, coord_b), orient, openings, opening_tol)
        segments = [s for s in segments if s[1] - s[0] > 1e-6]
        if segments:
            bands.append((orient, coord_a, coord_b, segments))

    # Each edge's own not-yet-claimed sub-spans - starts as its whole span,
    # shrinks as nearest-neighbor matches claim pieces of it.
    remaining = [[e["span"]] for e in edges]

    # 1. Match every "max"-side edge against its nearest "min"-side facing
    # edge(s), nearest gap first, splitting on overlap so a T-junction edge
    # can pair against multiple neighbors along its length.
    for i, e1 in enumerate(edges):
        if e1["side"] != "max":
            continue

        candidates = []
        for j, e2 in enumerate(edges):
            if j == i or e2["orient"] != e1["orient"] or e2["side"] != "min" or e2["room"] is e1["room"]:
                continue
            gap = e2["coord"] - e1["coord"]
            if gap < -1e-6 or gap > max_pair_gap:
                continue
            candidates.append((gap, j))
        candidates.sort(key=lambda c: c[0])

        for gap, j in candidates:
            e2 = edges[j]
            for a, b in list(remaining[i]):
                for c, d in list(remaining[j]):
                    overlap, lo, hi = _span_overlap((a, b), (c, d))
                    if overlap <= 1e-6:
                        continue
                    remaining[i] = _subtract_interval(remaining[i], lo, hi)
                    remaining[j] = _subtract_interval(remaining[j], lo, hi)
                    if gap >= min_wall_for_double:
                        add_band(e1["orient"], e1["coord"], e2["coord"], (lo, hi))
                    else:
                        add_band(e1["orient"], e1["coord"], e1["coord"], (lo, hi))

    # 2. Whatever is still unclaimed on any edge (no facing partner at all,
    # anywhere along that sub-span) is exterior - a synthetic filled skirt.
    for i, e in enumerate(edges):
        inward = wall_thickness if e["side"] == "min" else -wall_thickness
        for a, b in remaining[i]:
            add_band(e["orient"], e["coord"], e["coord"] + inward, (a, b))

    return bands


def rooms_touching_opening(floor, opening, tol=None):
    """Every room in `floor` whose boundary the given door/window sits on -
    an interior door normally touches exactly 2 rooms, an exterior door or
    window touches exactly 1, and a door that touches 0 doesn't line up
    with any room's own wall (a data problem worth flagging on its own).

    This is the same edge-matching `build_wall_bands()` already does
    per-line internally, just exposed at the whole-room level - shared so
    layout_semantics.py's connectivity graph can't disagree with what the
    renderers themselves consider "this door is on that room's wall." The
    default tolerance matches build_wall_bands()'s own `opening_tol`
    (DEFAULT_WALL_THICKNESS + 0.25) rather than something tighter - a door
    authored at one side's exact coordinate must still reach the OTHER
    room across a real (e.g. 0.5 ft) gap, or it would only ever register
    as touching one room instead of the two it actually connects.
    """
    if tol is None:
        tol = DEFAULT_WALL_THICKNESS + 0.25
    x, y = float(opening["x"]), float(opening["y"])
    width = float(opening.get("width", 3))
    if opening.get("orientation", "horizontal") == "horizontal":
        orient, coord, span = "H", y, (x, x + width)
    else:
        orient, coord, span = "V", x, (y, y + width)

    touching = []
    for room in floor.get("rooms", []):
        for edge in _room_edges(room):
            if edge["orient"] != orient or abs(edge["coord"] - coord) > tol:
                continue
            overlap, _, _ = _span_overlap(edge["span"], span)
            if overlap > 1e-6:
                touching.append(room)
                break
    return touching


def stair_layout(stair, wall_thickness=None):
    """Describes how to draw one stairs[] entry as either a two-flight
    SWITCHBACK with a shared mid-landing (the real dog-leg stair
    convention: climb one flight, turn on a landing shared by both
    flights, climb the second flight back across to arrive at the other
    side) or, when the box is too shallow/wide to fit that comfortably,
    the STRAIGHT single run this schema started with.

    Both flights run the full available length side by side (not stacked
    and not each half-length) - that's what makes a dog-leg stair compact:
    you fold one long run into two parallel short-plan-footprint runs
    connected by a landing, rather than lengthening the shaft. A solid
    wall (`wall_thickness` thick) divides the two flights along their
    run, stopping exactly at the landing - the landing itself has no
    wall through it, since both flights share it as common ground.

    Auto-detection (no schema field needed): a box qualifies for
    switchback when it's clearly taller than wide (height > width * 1.3)
    and what's left over after the divider/landing still leaves each
    flight a sane minimum run and width (MIN_FLIGHT_RUN_FT /
    MIN_FLIGHT_WIDTH_FT) - otherwise this falls back to a straight run
    unchanged from the schema's original behavior, so an oddly-shaped or
    small stair box never gets a cramped, wrong-looking switchback forced
    onto it.

    Returns a dict:
      {"style": "switchback",
       "flight_a": (x0, x1, y0, y1, steps),
       "flight_b": (x0, x1, y0, y1, steps),
       "divider": (x, y0, y1),
       "path": [(x, y), (x, y), (x, y), (x, y)]}   # the up/down travel line
    or
      {"style": "straight",
       "tread_ys": [...],
       "path": [(x, y), (x, y)]}

    All coordinates are in the same LOCAL (un-shifted) floor coordinates
    as the stair entry itself - callers apply their own floor Y-offset
    and unit conversion, same convention as build_wall_bands().
    """
    if wall_thickness is None:
        wall_thickness = DEFAULT_WALL_THICKNESS

    x, y = float(stair["x"]), float(stair["y"])
    w, h = float(stair["width"]), float(stair["height"])
    steps = int(stair.get("steps", 12))

    flight_run = h - LANDING_DEPTH_FT
    flight_w = (w - wall_thickness) / 2

    fits_switchback = (
        h > w * 1.3
        and flight_run >= MIN_FLIGHT_RUN_FT
        and flight_w >= MIN_FLIGHT_WIDTH_FT
    )

    if fits_switchback:
        steps_a = max(1, steps // 2)
        steps_b = max(1, steps - steps_a)
        ax0, ax1 = x, x + flight_w
        bx0, bx1 = x + flight_w + wall_thickness, x + w
        landing_y = y + flight_run
        a_cx, b_cx = (ax0 + ax1) / 2, (bx0 + bx1) / 2
        return {
            "style": "switchback",
            "flight_a": (ax0, ax1, y, landing_y, steps_a),
            "flight_b": (bx0, bx1, y, landing_y, steps_b),
            "divider": (x + w / 2, y, landing_y),
            "path": [(a_cx, y), (a_cx, landing_y), (b_cx, landing_y), (b_cx, y)],
        }

    tread_h = h / steps if steps else h
    tread_ys = [y + i * tread_h for i in range(1, steps)]
    cx = x + w / 2
    return {
        "style": "straight",
        "tread_ys": tread_ys,
        "path": [(cx, y), (cx, y + h)],
    }
