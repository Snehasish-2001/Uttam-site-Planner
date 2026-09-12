"""
Arbitrary-shape site/footprint polygon math for uttam-5.

uttam-4's schema assumes an axis-aligned rectangular plot (layout_geometry.get_plot() /
buildable_rect()). uttam-5 replaces that with a general polygon described the way a real
land survey/deed describes an irregular plot: metes-and-bounds (per-edge length + interior
angle at each vertex), not raw coordinates and not click-to-draw.

Coordinate convention matches layout_geometry.py: feet, X=East, Y=North.

Functions:
    vertices_from_edges()   -- metes-and-bounds walk -> resolved vertex list, with closure
                                check/adjustment.
    offset_polygon_edges()  -- per-edge inward setback -> buildable polygon.
    polygon_contains()      -- does container polygon fully cover the inner polygon.
    bounding_rect_hint()    -- best-effort largest-inscribed-axis-aligned-rectangle heuristic,
                                a visual suggestion only, not an exact optimum.
"""
import math

import shapely
from shapely.geometry import LineString, Point, Polygon
from shapely.validation import make_valid
from shapely.ops import split, unary_union


class SiteGeometryError(ValueError):
    """Raised for structurally-bad or physically-inconsistent site/footprint input."""


# A closure error under this is treated as ordinary survey-rounding noise and silently
# corrected. Above it, something is actually wrong with the entered lengths/angles.
CLOSURE_TOLERANCE_FT = 1.0


def _labels_for(n):
    """A, B, C, ... Z, AA, AB, ... for n vertices."""
    labels = []
    i = 0
    while len(labels) < n:
        label = ""
        k = i
        while True:
            label = chr(ord("A") + k % 26) + label
            k = k // 26 - 1
            if k < 0:
                break
        labels.append(label)
        i += 1
    return labels


def vertices_from_edges(lengths, interior_angles, start=(0.0, 0.0), start_heading_deg=0.0):
    """
    Walk a simple polygon from N side lengths and N-1 interior angles (the angle at each
    vertex EXCEPT the first one reached, i.e. interior_angles[i] is the angle at the vertex
    the walk arrives at after edge i). The Nth (closing) angle is derived, not supplied --
    exterior angles of any simple polygon sum to 360 degrees, so it's fully determined by
    the others.

    Positional closure (does the walk actually return to `start`) is a separate, real
    constraint that real survey numbers only satisfy approximately -- this applies the
    standard surveying "compass rule" adjustment for small errors and raises for large ones.

    Args:
        lengths: list of N edge lengths (ft), in walk order.
        interior_angles: list of N-1 interior angles (degrees), for vertices 1..N-1 (0-indexed;
            vertex 0 is `start` and never needs an angle since the walk hasn't turned yet when
            it arrives there).
        start: (x, y) of the first vertex.
        start_heading_deg: initial walk direction in degrees, 0 = +X (East), 90 = +Y (North).

    Returns:
        {
            "vertices": [{"label": "A", "x": .., "y": ..}, ...],   # N vertices, closed implicitly
            "closure_error_ft": float,     # magnitude of the raw closure error before correction
            "adjusted": bool,               # whether compass-rule correction was applied
        }
    """
    n = len(lengths)
    if n < 3:
        raise SiteGeometryError(f"A polygon needs at least 3 sides, got {n}.")
    if len(interior_angles) != n - 1:
        raise SiteGeometryError(
            f"Expected {n - 1} interior angle(s) for a {n}-sided polygon (the last is "
            f"derived from closure), got {len(interior_angles)}."
        )
    if any(l <= 0 for l in lengths):
        raise SiteGeometryError("Every edge length must be positive.")

    # Derive the Nth (closing) interior angle from the 360-degree exterior-angle-sum rule.
    exterior_sum_known = sum(180.0 - a for a in interior_angles)
    exterior_last = 360.0 - exterior_sum_known
    interior_last = 180.0 - exterior_last
    all_interior = list(interior_angles) + [interior_last]

    # Turtle walk. Vertex 0 = start, heading = start_heading_deg initially.
    pts = [tuple(start)]
    heading = start_heading_deg
    x, y = start
    for i in range(n):
        x += lengths[i] * math.cos(math.radians(heading))
        y += lengths[i] * math.sin(math.radians(heading))
        pts.append((x, y))
        # Turn by the exterior angle at the vertex just placed, before walking the next edge.
        # (The vertex just placed is vertex i+1, 1-indexed into all_interior at position i.)
        if i < n - 1:
            turn = 180.0 - all_interior[i]
            heading += turn

    raw_last = pts[-1]
    closure_error = math.hypot(raw_last[0] - start[0], raw_last[1] - start[1])
    pts = pts[:-1]  # drop the duplicate closing point; we'll re-close it after adjustment

    adjusted = False
    if closure_error > 1e-9:
        if closure_error > CLOSURE_TOLERANCE_FT:
            raise SiteGeometryError(
                f"Boundary does not close: after walking every edge and angle, the finish "
                f"point is {closure_error:.2f} ft from the start. Re-check the entered "
                f"lengths/angles (tolerance is {CLOSURE_TOLERANCE_FT:.1f} ft)."
            )
        # Compass-rule adjustment: distribute the closure error across vertices,
        # proportional to cumulative distance walked from the start.
        total_length = sum(lengths)
        err_x = raw_last[0] - start[0]
        err_y = raw_last[1] - start[1]
        cum = 0.0
        adjusted_pts = [pts[0]]
        for i in range(1, n):
            cum += lengths[i - 1]
            frac = cum / total_length
            px, py = pts[i]
            adjusted_pts.append((px - err_x * frac, py - err_y * frac))
        pts = adjusted_pts
        adjusted = True

    labels = _labels_for(n)
    vertices = [{"label": lbl, "x": round(px, 4), "y": round(py, 4)} for lbl, (px, py) in zip(labels, pts)]
    return {"vertices": vertices, "closure_error_ft": round(closure_error, 4), "adjusted": adjusted}


def regular_polygon_angles(n):
    """Interior angle (degrees) of a regular n-gon, repeated N-1 times for vertices_from_edges."""
    if n < 3:
        raise SiteGeometryError(f"A polygon needs at least 3 sides, got {n}.")
    angle = (n - 2) * 180.0 / n
    return [angle] * (n - 1)


def _polygon_from_vertices(vertices):
    return [(v["x"], v["y"]) for v in vertices]


def _signed_area(pts):
    area = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        area += x1 * y2 - x2 * y1
    return area / 2.0


def _line_intersection(p1, d1, p2, d2):
    """Intersection of line p1+t*d1 and p2+s*d2. Returns None if parallel."""
    x1, y1 = p1
    dx1, dy1 = d1
    x2, y2 = p2
    dx2, dy2 = d2
    denom = dx1 * dy2 - dy1 * dx2
    if abs(denom) < 1e-9:
        return None
    t = ((x2 - x1) * dy2 - (y2 - y1) * dx2) / denom
    return (x1 + t * dx1, y1 + t * dy1)


def offset_polygon_edges(vertices, edge_setbacks):
    """
    Compute the buildable polygon: each boundary edge moved inward by its own setback
    distance. Handles convex and concave polygons via the standard "offset each edge's
    line, take the intersection of consecutive offset lines" construction; the result is
    validated (and repaired if necessary) with shapely since a large setback near a
    concave notch can make the raw offset self-intersect.

    Args:
        vertices: [{"label", "x", "y"}, ...] in walk order (as returned by
            vertices_from_edges).
        edge_setbacks: list of N setback distances (ft), aligned with edges
            (edge i runs from vertices[i] to vertices[(i+1) % n]).

    Returns:
        {
            "vertices": [{"x", "y"}, ...],   # buildable polygon, unlabeled
            "repaired": bool,                 # True if the raw offset self-intersected and
                                               # had to be cleaned up
        }
    """
    pts = _polygon_from_vertices(vertices)
    n = len(pts)
    if len(edge_setbacks) != n:
        raise SiteGeometryError(f"Expected {n} edge setback value(s), got {len(edge_setbacks)}.")
    if any(s < 0 for s in edge_setbacks):
        raise SiteGeometryError("Setback distances cannot be negative.")

    # CCW polygons: inward normal for edge (Vi -> Vi+1) is the edge direction rotated -90deg.
    # CW polygons: use +90deg instead. Normalize winding first via signed area.
    ccw = _signed_area(pts) > 0

    offset_lines = []  # (point_on_line, direction_vector) per edge
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        dx, dy = x2 - x1, y2 - y1
        length = math.hypot(dx, dy)
        if length < 1e-9:
            raise SiteGeometryError(f"Edge {i} has zero length.")
        ux, uy = dx / length, dy / length
        # inward normal
        nx, ny = (-uy, ux) if ccw else (uy, -ux)
        setback = edge_setbacks[i]
        offset_point = (x1 + nx * setback, y1 + ny * setback)
        offset_lines.append((offset_point, (ux, uy)))

    new_pts = []
    for i in range(n):
        prev_point, prev_dir = offset_lines[i - 1]
        cur_point, cur_dir = offset_lines[i]
        pt = _line_intersection(prev_point, prev_dir, cur_point, cur_dir)
        if pt is None:
            # Parallel consecutive edges (e.g. a straight-through vertex) -- just use the
            # offset point of the current edge's line directly.
            pt = cur_point
        new_pts.append(pt)

    repaired = False
    poly = Polygon(new_pts)
    if not poly.is_valid or poly.area <= 0:
        repaired_poly = make_valid(poly)
        if repaired_poly.geom_type == "MultiPolygon":
            repaired_poly = max(repaired_poly.geoms, key=lambda g: g.area)
        if repaired_poly.is_empty or repaired_poly.area <= 0:
            raise SiteGeometryError(
                "The setbacks are too large for this plot shape -- the buildable area "
                "collapses to nothing (likely a deep concave notch consumed entirely)."
            )
        poly = repaired_poly
        repaired = True

    out_coords = list(poly.exterior.coords)[:-1]  # drop shapely's repeated closing point
    return {
        "vertices": [{"x": round(px, 4), "y": round(py, 4)} for px, py in out_coords],
        "repaired": repaired,
    }


def polygon_contains(inner_vertices, outer_vertices):
    """
    True if `outer_vertices` polygon fully covers `inner_vertices` polygon (boundary
    touching allowed). Used to validate a footprint sits inside the buildable area, and
    (later) that generated rooms sit inside the footprint.
    """
    inner = Polygon(_polygon_from_vertices(inner_vertices))
    outer = Polygon(_polygon_from_vertices(outer_vertices))
    if not inner.is_valid:
        inner = make_valid(inner)
    if not outer.is_valid:
        outer = make_valid(outer)
    return outer.covers(inner)


def containment_violations(inner_vertices, outer_vertices, tol_ft=0.05):
    """
    Returns the area (sq ft) of `inner_vertices` that falls OUTSIDE `outer_vertices`, or 0.0
    if fully contained (within tol_ft^2 of noise). Useful for reporting "how far outside"
    rather than a bare pass/fail.
    """
    inner = Polygon(_polygon_from_vertices(inner_vertices))
    outer = Polygon(_polygon_from_vertices(outer_vertices))
    if not inner.is_valid:
        inner = make_valid(inner)
    if not outer.is_valid:
        outer = make_valid(outer)
    outside = inner.difference(outer)
    area = outside.area if not outside.is_empty else 0.0
    return area if area > tol_ft * tol_ft else 0.0


def bounding_rect_hint(vertices, samples=80):
    """
    Best-effort heuristic for the largest axis-aligned rectangle inscribed in the polygon.
    NOT an exact optimum -- there is no simple closed form for a general (especially
    concave) polygon. This is a visual suggestion shown to the user before they draw their
    own footprint, not a hard constraint.

    Approach: sample `samples` horizontal cross-sections of the polygon; at each sampled Y,
    take the single widest horizontal interval the polygon offers there (a concave shape can
    have more than one disjoint interval at a given Y -- this heuristic only tracks the
    widest, which is enough for a reference outline). Since polygon edges are straight lines,
    each interval's left/right bound varies linearly with Y between vertex events, so the
    tightest (smallest) interval over any contiguous Y-range is exactly the intersection of
    the interval at that range's two endpoints -- a sliding window over the sampled
    cross-sections then finds the best-area rectangle without needing per-candidate
    containment checks.
    """
    pts = _polygon_from_vertices(vertices)
    poly = Polygon(pts)
    if not poly.is_valid:
        poly = make_valid(poly)
        if poly.geom_type == "MultiPolygon":
            poly = max(poly.geoms, key=lambda g: g.area)

    minx, miny, maxx, maxy = poly.bounds
    if maxx - minx <= 0 or maxy - miny <= 0:
        raise SiteGeometryError("Degenerate polygon: zero width or height.")

    slices = []  # (y, x0, x1) or (y, None) if the polygon has no width at that Y
    for i in range(samples + 1):
        y = miny + (maxy - miny) * i / samples
        line = LineString([(minx - 1, y), (maxx + 1, y)])
        inter = poly.intersection(line)
        geoms = list(inter.geoms) if hasattr(inter, "geoms") else [inter]
        best_seg = None
        for g in geoms:
            if g.is_empty or g.length == 0:
                continue
            coords = list(g.coords)
            gx0, gx1 = sorted([coords[0][0], coords[-1][0]])
            if best_seg is None or (gx1 - gx0) > (best_seg[1] - best_seg[0]):
                best_seg = (gx0, gx1)
        slices.append((y, best_seg))

    best = None  # (area, x0, y0, x1, y1)
    n = len(slices)
    for i in range(n):
        if slices[i][1] is None:
            continue
        x0, x1 = slices[i][1]
        y0 = slices[i][0]
        for j in range(i, n):
            if slices[j][1] is None:
                break
            jx0, jx1 = slices[j][1]
            x0 = max(x0, jx0)
            x1 = min(x1, jx1)
            if x1 <= x0:
                break
            y1 = slices[j][0]
            area = (x1 - x0) * (y1 - y0)
            if best is None or area > best[0]:
                best = (area, x0, y0, x1, y1)

    if best is None:
        cx, cy = poly.centroid.x, poly.centroid.y
        best = (0.0, cx, cy, cx, cy)

    _, x0, y0, x1, y1 = best
    return {"x": round(x0, 3), "y": round(y0, 3), "width": round(x1 - x0, 3), "height": round(y1 - y0, 3)}


def _road_polygon(points, half_width, cap_dir_start=None, cap_dir_end=None, epsilon_ft=0.1):
    """
    Builds a road's strip polygon directly (not via LineString.buffer()), so each end can be
    cut COLINEAR with whatever it connects to (a plot side, or another road) instead of always
    perpendicular to the road's own direction. A perpendicular cut where a road meets a
    boundary at an angle leaves a sliver of leftover land wedged between the cut and the real
    boundary; cutting along the boundary's own direction instead removes that sliver entirely,
    and naturally makes the road's own cross-section a trapezoid (not a rectangle) wherever it
    isn't perpendicular to what it's connecting to - exactly the shape a real road junction has.

    points: the road's centerline (2+ points; a straight road is just 2, a curved road is the
        client's discretized-arc polyline).
    cap_dir_start / cap_dir_end: unit direction (dx, dy) of whatever that end connects to, or
        None for an end with nothing to align to (a dead end) - falls back to the old
        perpendicular-flat-cap-with-epsilon-overshoot behaviour for that end only.
    """
    n = len(points)
    seg_tangents = []
    for i in range(n - 1):
        dx, dy = points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]
        length = math.hypot(dx, dy) or 1.0
        seg_tangents.append((dx / length, dy / length))

    def seg_normal(t):
        return (-t[1], t[0])

    vertex_normals = []
    for i in range(n):
        if i == 0:
            vertex_normals.append(seg_normal(seg_tangents[0]))
        elif i == n - 1:
            vertex_normals.append(seg_normal(seg_tangents[-1]))
        else:
            nx1, ny1 = seg_normal(seg_tangents[i - 1])
            nx2, ny2 = seg_normal(seg_tangents[i])
            tx, ty = nx1 + nx2, ny1 + ny2
            length = math.hypot(tx, ty) or 1.0
            vertex_normals.append((tx / length, ty / length))

    left_pts = [(points[i][0] + vertex_normals[i][0] * half_width, points[i][1] + vertex_normals[i][1] * half_width) for i in range(n)]
    right_pts = [(points[i][0] - vertex_normals[i][0] * half_width, points[i][1] - vertex_normals[i][1] * half_width) for i in range(n)]

    if cap_dir_start:
        t0 = seg_tangents[0]
        n0 = seg_normal(t0)
        left_line_pt = (points[0][0] + n0[0] * half_width, points[0][1] + n0[1] * half_width)
        right_line_pt = (points[0][0] - n0[0] * half_width, points[0][1] - n0[1] * half_width)
        new_left = _line_intersection(left_line_pt, t0, points[0], cap_dir_start)
        new_right = _line_intersection(right_line_pt, t0, points[0], cap_dir_start)
        if new_left is not None:
            left_pts[0] = new_left
        if new_right is not None:
            right_pts[0] = new_right
    else:
        # No boundary to align with (a dead end) - keep the perpendicular cut, but overshoot
        # slightly past the true endpoint so a cut that happens to sit exactly on the plot's
        # own boundary still passes fully through it rather than just grazing it (the same
        # GEOS pinched-polygon guard the old buffer-based approach used everywhere).
        left_pts[0] = (left_pts[0][0] - seg_tangents[0][0] * epsilon_ft, left_pts[0][1] - seg_tangents[0][1] * epsilon_ft)
        right_pts[0] = (right_pts[0][0] - seg_tangents[0][0] * epsilon_ft, right_pts[0][1] - seg_tangents[0][1] * epsilon_ft)

    if cap_dir_end:
        t_last = seg_tangents[-1]
        n_last = seg_normal(t_last)
        left_line_pt = (points[-1][0] + n_last[0] * half_width, points[-1][1] + n_last[1] * half_width)
        right_line_pt = (points[-1][0] - n_last[0] * half_width, points[-1][1] - n_last[1] * half_width)
        new_left = _line_intersection(left_line_pt, t_last, points[-1], cap_dir_end)
        new_right = _line_intersection(right_line_pt, t_last, points[-1], cap_dir_end)
        if new_left is not None:
            left_pts[-1] = new_left
        if new_right is not None:
            right_pts[-1] = new_right
    else:
        left_pts[-1] = (left_pts[-1][0] + seg_tangents[-1][0] * epsilon_ft, left_pts[-1][1] + seg_tangents[-1][1] * epsilon_ft)
        right_pts[-1] = (right_pts[-1][0] + seg_tangents[-1][0] * epsilon_ft, right_pts[-1][1] + seg_tangents[-1][1] * epsilon_ft)

    polygon_pts = left_pts + list(reversed(right_pts))
    poly = Polygon(polygon_pts)
    if not poly.is_valid:
        poly = make_valid(poly)
    return poly


def compute_subsections(plot_vertices, roads):
    """
    Subtracts every road's own width-buffered strip from the master plot polygon, returning
    whatever land is left as one or more "sub-section" polygons - the blocks that plots later
    get sliced out of in the plot-logic stage. `roads` is a list of
    {"start": {"x":.., "y":..}, "end": {"x":.., "y":..}, "width": ft, "buffer": ft (optional,
    default 0), "path": [{"x":.., "y":..}, ...] (optional)}.

    `path` is the full polyline to buffer for the road's strip - two points for a straight
    road, or the client's discretized-arc points for a curved one (the client, not this
    function, resolves the circular-arc math from a bulge/direction, the same way it already
    resolves every other road connection point - this function just buffers whatever polyline
    it's given). Falls back to a straight two-point path from start/end when `path` is absent,
    for backward compatibility with older callers.

    `buffer` is EXTRA clearance carved out on both sides of the road, beyond its own width -
    e.g. a utility/drainage/greenery strip along the carriageway. It defaults to 0, meaning
    only the road's declared width itself is removed and nothing more; the actual strip
    subtracted has half-width `width / 2 + buffer` on each side of the road's centerline.

    Road strips use FLAT (not rounded) end caps, so a road doesn't eat into land past its own
    given endpoint - a dead end really does end exactly where its length says it does. Where an
    end DOES connect to something (a plot side or another road), that cut is made colinear with
    the thing it connects to, via `capDirStart`/`capDirEnd` (see `_road_polygon`), rather than
    perpendicular to the road's own direction - a perpendicular cut against an angled boundary
    would otherwise leave a sliver of leftover land wedged into that corner.

    `capDirStart`/`capDirEnd`: optional {"x":.., "y":..} unit direction of whatever that end of
    the road connects to (falls back to a perpendicular cut, with a small epsilon overshoot to
    dodge a GEOS pinched-polygon degenerate case, when absent - e.g. a dead end).
    """
    plot = Polygon(_polygon_from_vertices(plot_vertices))
    if not plot.is_valid:
        plot = make_valid(plot)

    strips = []
    for road in roads:
        raw_path = road.get("path")
        if isinstance(raw_path, list) and len(raw_path) >= 2:
            points = [(p["x"], p["y"]) for p in raw_path]
        else:
            points = [(road["start"]["x"], road["start"]["y"]), (road["end"]["x"], road["end"]["y"])]
        width = float(road.get("width", 0))
        buffer = max(0.0, float(road.get("buffer", 0) or 0))
        if width <= 0:
            continue
        total_len = sum(math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]) for i in range(len(points) - 1))
        if total_len < 1e-6:
            continue

        cap_start = road.get("capDirStart")
        cap_end = road.get("capDirEnd")
        cap_dir_start = (cap_start["x"], cap_start["y"]) if cap_start else None
        cap_dir_end = (cap_end["x"], cap_end["y"]) if cap_end else None

        strips.append(_road_polygon(points, width / 2.0 + buffer, cap_dir_start, cap_dir_end))

    remaining = plot
    if strips:
        roads_union = unary_union(strips)
        remaining = plot.difference(roads_union)
        if not remaining.is_valid:
            remaining = make_valid(remaining)
        # Two roads meeting the plot boundary at (or extremely near) the same point - or a
        # road's own cap landing a hair's width from a plot vertex due to ordinary floating-
        # point noise in upstream vertex math - can leave what should be two genuinely separate
        # sub-sections joined by a razor-thin bridge, which GEOS's exact arithmetic sometimes
        # resolves as "still one connected region" instead of cleanly splitting it. An opening
        # (erode then dilate back by a tiny amount, far below any real plot dimension) severs
        # any bridge that thin while leaving genuinely wide regions unchanged. Both buffer
        # passes round every corner into a small fan of extra vertices (shapely's default
        # arc approximation) - simplify() immediately after collapses that rounding noise back
        # into the clean straight corners the actual geometry has, without needing to touch
        # any real edge.
        remaining = remaining.buffer(-0.001).buffer(0.001).simplify(0.01, preserve_topology=True)
        if not remaining.is_valid:
            remaining = make_valid(remaining)

    if remaining.is_empty:
        return []

    if hasattr(remaining, "geoms"):
        polygons = [g for g in remaining.geoms if g.geom_type == "Polygon" and not g.is_empty and g.area > 1e-6]
    elif remaining.geom_type == "Polygon" and not remaining.is_empty:
        polygons = [remaining]
    else:
        polygons = []

    subsections = []
    for poly in polygons:
        coords = list(poly.exterior.coords)[:-1]  # drop the repeated closing point
        subsections.append([{"x": round(x, 4), "y": round(y, 4)} for x, y in coords])
    return subsections


def _polygon_to_vertex_list(poly):
    coords = list(poly.exterior.coords)[:-1]
    return [{"x": round(x, 4), "y": round(y, 4)} for x, y in coords]


def _largest_polygon(geom):
    """Reduce a Polygon/MultiPolygon/GeometryCollection result to its single largest Polygon
    component, or None if it has no polygonal area at all (a sliver that collapsed to a line
    or point)."""
    if geom.is_empty:
        return None
    if geom.geom_type == "Polygon":
        return geom
    if hasattr(geom, "geoms"):
        polys = [g for g in geom.geoms if g.geom_type == "Polygon" and not g.is_empty and g.area > 1e-9]
        if not polys:
            return None
        return max(polys, key=lambda g: g.area)
    return None


# ---------------------------------------------------------------------------
# Geometry hygiene
#
# Every polygon this module hands back to the client goes through normalize_polygon().
# Before it existed, insert_plots() stored `rect.intersection(remaining)` verbatim, and GEOS
# routinely returns the uncovered remainder of a frontage chord as a zero-width filament: an
# observed frontage plot came back as [100,50] [100,30] [160,30] [160,0] [100,0] - a clean
# 60x30 rectangle plus a 20 ft spike running back up the road edge, contributing no area but
# making the polygon self-intersecting the instant any vertex moved, which froze that plot
# against every possible edit.
# ---------------------------------------------------------------------------

SNAP_GRID_FT = 0.01          # coordinates are rounded onto this grid
COLLINEAR_TOL_DEG = 0.5      # a turn smaller than this is a straight-through vertex
SPIKE_TOL_DEG = 179.0        # a turn larger than this is a backtracking spike
OVERLAP_TOL_SQFT = 0.01      # per-pair overlap / out-of-bounds allowance
AREA_BALANCE_TOL_SQFT = 0.5  # real + fill + open space must sum to the sub-section within this


def _snap(value):
    return round(round(value / SNAP_GRID_FT) * SNAP_GRID_FT, 4)


def _turn_degrees(a, b, c):
    """Turn angle at b, walking a -> b -> c. 0 = straight through, 180 = full backtrack."""
    v1x, v1y = b[0] - a[0], b[1] - a[1]
    v2x, v2y = c[0] - b[0], c[1] - b[1]
    l1 = math.hypot(v1x, v1y)
    l2 = math.hypot(v2x, v2y)
    if l1 < 1e-12 or l2 < 1e-12:
        return 0.0
    cos_t = max(-1.0, min(1.0, (v1x * v2x + v1y * v2y) / (l1 * l2)))
    return math.degrees(math.acos(cos_t))


def normalize_polygon(poly, cull_vertices=True):
    """
    Clean a polygon into the canonical form every downstream consumer (side counts, edge
    pushes, the invariant checks) is entitled to assume: valid, single-part, snapped to
    SNAP_GRID_FT, no duplicate / collinear / spike vertices, wound CCW.

    Accepts a shapely Polygon or a list of (x, y) / {"x":, "y":} vertices. Returns a shapely
    Polygon, or None if what was passed has no real area left once cleaned up.

    `cull_vertices=False` keeps every vertex (only validity, snapping and winding are applied).
    Open space is reported that way: a genuinely hairline leftover - half an inch wide along
    one edge - has near-180-degree turns at both ends, so the spike rule would delete it
    outright, and the land it covers would then be accounted for nowhere at all.
    """
    if poly is None:
        return None
    if not isinstance(poly, Polygon):
        pts = []
        for v in poly:
            pts.append((v["x"], v["y"]) if isinstance(v, dict) else (v[0], v[1]))
        if len(pts) < 3:
            return None
        poly = Polygon(pts)

    if not poly.is_valid:
        poly = make_valid(poly)
    poly = _largest_polygon(poly)
    if poly is None or poly.is_empty or poly.area <= 0:
        return None

    coords = [(_snap(x), _snap(y)) for x, y in list(poly.exterior.coords)[:-1]]

    # Duplicate-, collinear- and spike-vertex removal all have to run to a fixed point:
    # dropping one vertex can leave its two neighbours collinear with each other.
    changed = cull_vertices
    while changed and len(coords) > 3:
        changed = False
        # Two points one grid step apart are adjacent lattice cells - at 0.01 ft (an eighth of
        # an inch) there is no real feature between them, only rounding, so they merge.
        deduped = []
        for pt in coords:
            if not deduped or math.hypot(pt[0] - deduped[-1][0], pt[1] - deduped[-1][1]) > SNAP_GRID_FT:
                deduped.append(pt)
        if len(deduped) > 3 and math.hypot(deduped[0][0] - deduped[-1][0], deduped[0][1] - deduped[-1][1]) <= SNAP_GRID_FT:
            deduped.pop()
        if len(deduped) != len(coords):
            coords = deduped
            changed = True
            continue
        n = len(coords)
        for i in range(n):
            turn = _turn_degrees(coords[(i - 1) % n], coords[i], coords[(i + 1) % n])
            if turn < COLLINEAR_TOL_DEG or turn > SPIKE_TOL_DEG:
                coords = coords[:i] + coords[i + 1:]
                changed = True
                break

    if len(coords) < 3:
        return None
    cleaned = Polygon(coords)
    if not cleaned.is_valid:
        cleaned = make_valid(cleaned)
        cleaned = _largest_polygon(cleaned)
        if cleaned is None:
            return None
    if cleaned.is_empty or cleaned.area <= 0:
        return None
    if _signed_area(list(cleaned.exterior.coords)[:-1]) < 0:
        cleaned = Polygon(list(cleaned.exterior.coords)[:-1][::-1])
    return cleaned


def _plot_record(poly, fill=False, name=None):
    """The dict shape the client expects for one plot."""
    record = {
        "vertices": _polygon_to_vertex_list(poly),
        "area": round(poly.area, 2),
        "sides": len(list(poly.exterior.coords)) - 1,
        "fill": bool(fill),
    }
    if name:
        record["name"] = name
    return record


# ---------------------------------------------------------------------------
# Residual partitioning (fill plots + open space)
# ---------------------------------------------------------------------------

SLIVER_TOL_FT = 0.25         # residual-only opening width; NOT the compute_subsections one
MIN_FILL_AREA_SQFT = 150.0
MIN_FILL_WIDTH_FT = 8.0
MIN_FILL_ANGLE_DEG = 20.0
MAX_FILL_ASPECT = 6.0
MIN_OPEN_SPACE_SQFT = 1.0    # below this a leftover is dust, not something worth reporting
NARROW_FILL_WIDTH_FT = 12.0  # a fill piece this narrow gets folded into a neighbour if it can be


def _open_residual(geom, tol=SLIVER_TOL_FT):
    """Morphological opening with MITRED joins. The default round joins would replace every
    corner with a fan of arc vertices, which is how an earlier version of this produced
    13- and 14-sided "fill triangles"; mitring keeps a square corner square."""
    opened = geom.buffer(-tol, join_style=2, mitre_limit=8.0).buffer(tol, join_style=2, mitre_limit=8.0)
    if not opened.is_valid:
        opened = make_valid(opened)
    return opened


def _min_interior_angle(poly):
    coords = list(poly.exterior.coords)[:-1]
    n = len(coords)
    if n < 3:
        return 0.0
    worst = 180.0
    for i in range(n):
        # interior angle = 180 - turn
        worst = min(worst, 180.0 - _turn_degrees(coords[(i - 1) % n], coords[i], coords[(i + 1) % n]))
    return worst


def _min_rect_sides(poly):
    """The two side lengths of the minimum rotated bounding rectangle, shortest first. Used
    both as a cheap "how wide is this really" measure and to derive the aspect ratio."""
    rect = poly.minimum_rotated_rectangle
    if rect.geom_type != "Polygon":
        return 0.0, float("inf")
    coords = list(rect.exterior.coords)[:-1]
    if len(coords) < 4:
        return 0.0, float("inf")
    side_a = math.hypot(coords[1][0] - coords[0][0], coords[1][1] - coords[0][1])
    side_b = math.hypot(coords[2][0] - coords[1][0], coords[2][1] - coords[1][1])
    return sorted((side_a, side_b))


def _aspect_ratio(poly):
    lo, hi = _min_rect_sides(poly)
    return hi / lo if lo > 1e-9 else float("inf")


def _fill_quality(poly, thresholds):
    """(passes, reason). A piece only becomes a named fill plot if it is actually usable
    land; everything else is reported honestly as open space rather than dressed up as a
    plot nobody could build on."""
    if poly is None or poly.is_empty:
        return False, "empty"
    if poly.area < thresholds["min_area"]:
        return False, f"area {poly.area:.1f} < {thresholds['min_area']:.0f} sqft"
    if _min_interior_angle(poly) < thresholds["min_angle"]:
        return False, f"min angle {_min_interior_angle(poly):.1f} deg"
    if poly.buffer(-thresholds["min_width"] / 2.0).is_empty:
        return False, f"narrower than {thresholds['min_width']:.0f} ft"
    if _aspect_ratio(poly) > thresholds["max_aspect"]:
        return False, f"aspect {_aspect_ratio(poly):.1f}"
    return True, ""


def _fill_thresholds(params):
    params = params or {}
    return {
        "min_area": float(params.get("fillMinArea", MIN_FILL_AREA_SQFT)),
        "min_width": float(params.get("fillMinWidth", MIN_FILL_WIDTH_FT)),
        "min_angle": float(params.get("fillMinAngle", MIN_FILL_ANGLE_DEG)),
        "max_aspect": float(params.get("fillMaxAspect", MAX_FILL_ASPECT)),
    }


def _residual_pieces(residual):
    if residual is None or residual.is_empty:
        return []
    if hasattr(residual, "geoms"):
        return [g for g in residual.geoms if g.geom_type == "Polygon" and g.area > 1e-6]
    return [residual] if residual.geom_type == "Polygon" and residual.area > 1e-6 else []


def _cut_lines_for(plot_polys, piece):
    """Infinite-ish lines extended from every real plot's own side edges, clipped to the
    piece's neighbourhood. Cutting the residual along these instead of triangulating it
    blindly keeps the fill aligned with the layout that's already there - quads and
    trapezoids that read as continuations of the block, not arbitrary wedges."""
    minx, miny, maxx, maxy = piece.bounds
    span = max(maxx - minx, maxy - miny) * 2.0 + 10.0
    cx, cy = (minx + maxx) / 2.0, (miny + maxy) / 2.0
    lines = []
    seen = set()
    for poly in plot_polys:
        coords = list(poly.exterior.coords)[:-1]
        n = len(coords)
        for i in range(n):
            a, b = coords[i], coords[(i + 1) % n]
            dx, dy = b[0] - a[0], b[1] - a[1]
            length = math.hypot(dx, dy)
            if length < 1e-6:
                continue
            ux, uy = dx / length, dy / length
            # Dedupe by (direction, signed distance from the piece centre) so ten plots
            # sharing one grid line don't contribute ten identical cuts.
            offset = (a[0] - cx) * (-uy) + (a[1] - cy) * ux
            key = (round(abs(ux), 3), round(abs(uy), 3), round(offset, 2))
            if key in seen:
                continue
            seen.add(key)
            mid = ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)
            line = LineString([
                (mid[0] - ux * span, mid[1] - uy * span),
                (mid[0] + ux * span, mid[1] + uy * span),
            ])
            if line.intersects(piece):
                lines.append(line)
    return lines


def _split_piece(piece, lines, thresholds):
    """Split `piece` by each cut line in turn, keeping a split only when it actually helps
    (every resulting part still big enough to be worth having)."""
    pieces = [piece]
    for line in lines:
        nxt = []
        for pc in pieces:
            if pc.area < thresholds["min_area"] * 2:
                nxt.append(pc)
                continue
            try:
                parts = [g for g in split(pc, line).geoms
                         if g.geom_type == "Polygon" and g.area > 1e-9]
            except Exception:
                parts = []
            if len(parts) < 2 or min(p.area for p in parts) < thresholds["min_area"]:
                nxt.append(pc)
            else:
                nxt.extend(parts)
        pieces = nxt
        if len(pieces) > 24:  # runaway guard - a block never legitimately needs this many
            break
    return pieces


def partition_residual(residual, plot_polys, params=None):
    """
    Turn whatever land is left over in a sub-section into (fill_plots, open_space).

    Fill plots are a DERIVED VIEW of the residual, never independent objects - they are
    thrown away and rebuilt from scratch every time a real plot changes. Anything that
    isn't usable land (too small, too sharp, too thin, too elongated) is reported as open
    space instead of being dressed up as a plot.

    Returns (list[Polygon] fill, list[Polygon] open_space).
    """
    thresholds = _fill_thresholds(params)
    fill, open_space = [], []
    if residual is None or residual.is_empty:
        return fill, open_space

    # A residual-only opening, deliberately far coarser than compute_subsections' own
    # 0.001 ft one (which exists to sever floating-point bridges between sub-sections and
    # must stay exactly as it is). This one's job is different: drop the hairline strips
    # that clipping leaves behind, so they can never become needle triangles.
    opened = _open_residual(residual)
    slivers = residual.difference(opened) if not opened.is_empty else residual

    for raw_piece in _residual_pieces(opened):
        piece = normalize_polygon(raw_piece.simplify(SNAP_GRID_FT, preserve_topology=True))
        if piece is None:
            # Too thin to survive vertex culling, but the land is still there - report it as
            # open space rather than letting it fall out of the books entirely.
            faithful = normalize_polygon(raw_piece, cull_vertices=False)
            if faithful is not None and faithful.area >= MIN_OPEN_SPACE_SQFT:
                open_space.append(faithful)
            continue
        passes, _ = _fill_quality(piece, thresholds)
        if passes and piece.area < thresholds["min_area"] * 2:
            fill.append(piece)
            continue
        candidates = _split_piece(piece, _cut_lines_for(plot_polys, piece), thresholds)
        for raw_part in candidates:
            part = normalize_polygon(raw_part)
            if part is None:
                faithful = normalize_polygon(raw_part, cull_vertices=False)
                if faithful is not None and faithful.area >= MIN_OPEN_SPACE_SQFT:
                    open_space.append(faithful)
                continue
            ok, _ = _fill_quality(part, thresholds)
            if ok:
                fill.append(part)
                continue
            # A genuine corner wedge (the diagonal-road corners in S3/S4) can still be worth
            # something once triangulated, so fall back to Delaunay for the failures only.
            salvaged = False
            if part.area >= thresholds["min_area"]:
                try:
                    tris = shapely.constrained_delaunay_triangles(part)
                    tri_geoms = list(tris.geoms) if hasattr(tris, "geoms") else [tris]
                except Exception:
                    tri_geoms = []
                for tri in tri_geoms:
                    tri = normalize_polygon(tri)
                    if tri is None:
                        continue
                    tri_ok, _ = _fill_quality(tri, thresholds)
                    if tri_ok:
                        fill.append(tri)
                        salvaged = True
                    else:
                        open_space.append(tri)
                if tri_geoms:
                    continue
            if not salvaged:
                open_space.append(part)

    for sliver in _residual_pieces(slivers):
        cleaned = normalize_polygon(sliver, cull_vertices=False)
        if cleaned is not None and cleaned.area >= MIN_OPEN_SPACE_SQFT:
            open_space.append(cleaned)

    fill, open_space = _absorb_failed_pieces(fill, open_space, thresholds, residual)
    fill = _merge_narrow_fill_pieces(fill, thresholds)
    return fill, [p for p in open_space if p.area >= MIN_OPEN_SPACE_SQFT]


def _merge_narrow_fill_pieces(fill, thresholds):
    """
    Cutting the residual with extension lines from every nearby real plot's own edges
    (`_cut_lines_for`) is what keeps fill aligned with the block - but where TWO different
    frontage runs meet at a corner and their plots don't share a width (e.g. one run divided
    into 25 ft plots, another into 40 ft ones), both grids' cut lines land in the same leftover
    region and slice a normal-sized piece into an odd narrow strip sandwiched between two wider
    ones. Each such strip can still individually pass the quality gate (10 ft comfortably
    clears an 8 ft minimum width), so nothing here is technically broken - it just reads as a
    mistake sitting next to its neighbours. Folding anything narrower than
    NARROW_FILL_WIDTH_FT into whichever neighbour it shares the most boundary with removes that
    without touching pieces that were never a problem.
    """
    fill = list(fill)
    changed = True
    while changed:
        changed = False
        for i in range(len(fill)):
            width, _ = _min_rect_sides(fill[i])
            if width >= NARROW_FILL_WIDTH_FT:
                continue
            shares = []
            for j in range(len(fill)):
                if j == i:
                    continue
                share = fill[i].buffer(SNAP_GRID_FT).intersection(fill[j].exterior).length
                if share > SNAP_GRID_FT:
                    shares.append((share, j))
            shares.sort(reverse=True)
            for _share, j in shares:
                merged = normalize_polygon(unary_union([fill[i], fill[j]]))
                if merged is None:
                    continue
                ok, _reason = _fill_quality(merged, thresholds)
                if not ok:
                    continue
                fill = [p for k, p in enumerate(fill) if k not in (i, j)] + [merged]
                changed = True
                break
            if changed:
                break
    return fill


def _absorb_failed_pieces(fill, open_space, thresholds, clip_region):
    """A band cut off a residual piece can land just under the quality gate (a 3 ft deep,
    100 sqft strip against a 150 sqft floor) while sitting right against a fill piece that
    would happily absorb it. Give each failed piece to the neighbouring fill plot it shares
    the most boundary with, as long as the union still passes the gate - otherwise a perfectly
    ordinary band of land gets reported as open space purely because of where a cut fell."""
    if not fill or not open_space:
        return fill, open_space
    kept = []
    for piece in open_space:
        best_idx, best_share = None, 0.0
        for idx, target in enumerate(fill):
            share = piece.buffer(SNAP_GRID_FT).intersection(target.exterior).length
            if share > best_share:
                best_idx, best_share = idx, share
        if best_idx is None or best_share <= 0:
            kept.append(piece)
            continue
        # The small dilation is only there to weld two pieces whose shared edge coordinates
        # don't match to the last decimal; clipping straight back to the residual stops that
        # weld from spilling a hundredth of a foot over the real plot next door (which the
        # invariant check rightly refused).
        welded = unary_union([fill[best_idx], piece.buffer(SNAP_GRID_FT / 2)])
        merged = normalize_polygon(_largest_polygon(welded.intersection(clip_region)) or welded)
        ok = merged is not None and _fill_quality(merged, thresholds)[0]
        if ok and abs(merged.area - (fill[best_idx].area + piece.area)) < 1.0:
            fill[best_idx] = merged
        else:
            kept.append(piece)
    return fill, kept


def _merge_slivers_into_plots(residual, plot_polys, sub_poly):
    """
    GENERATION-TIME ONLY. Hand each hairline residual strip to the real plot it shares the
    most boundary with, when that plot can absorb it without changing shape class. This is
    what stops a 0.18 ft wide, 65 ft long strip left along a clipped plot edge from becoming
    a 0.16-degree needle triangle. Never used at edit time - under the independent-plots
    model an edit may not reshape a plot other than the one being edited.

    Returns (new_plot_polys, new_residual).
    """
    opened = _open_residual(residual)
    slivers = _residual_pieces(residual.difference(opened)) if not opened.is_empty else _residual_pieces(residual)
    if not slivers:
        return plot_polys, residual

    plots = list(plot_polys)
    absorbed = []
    for sliver in slivers:
        if sliver.area < 1e-6:
            continue
        best_idx, best_share = None, 0.0
        for idx, poly in enumerate(plots):
            share = sliver.buffer(SNAP_GRID_FT).intersection(poly.exterior).length
            if share > best_share:
                best_idx, best_share = idx, share
        if best_idx is None or best_share <= 0:
            continue
        merged = normalize_polygon(unary_union([plots[best_idx], sliver.buffer(SNAP_GRID_FT / 2)]))
        if merged is None:
            continue
        if merged.difference(sub_poly).area > OVERLAP_TOL_SQFT:
            continue
        if len(list(merged.exterior.coords)) - 1 != len(list(plots[best_idx].exterior.coords)) - 1:
            continue  # would change the plot's shape class - leave it for open space instead
        if any(i != best_idx and merged.intersection(other).area > OVERLAP_TOL_SQFT
               for i, other in enumerate(plots)):
            continue
        plots[best_idx] = merged
        absorbed.append(sliver)

    new_residual = residual
    if absorbed:
        new_residual = residual.difference(unary_union([a.buffer(SNAP_GRID_FT / 2) for a in absorbed]))
        if not new_residual.is_valid:
            new_residual = make_valid(new_residual)
    return plots, new_residual


# ---------------------------------------------------------------------------
# Invariants
# ---------------------------------------------------------------------------

def check_invariants(sub_poly, real_polys, fill_polys, open_polys):
    """Per sub-section sanity check, run after generation and after every edit. Returns a
    list of human-readable violations (empty == healthy).

    Both tests allow for the coordinate snap grid. Every polygon here has been snapped onto a
    SNAP_GRID_FT lattice, which can move a vertex half a grid step perpendicular to an edge, so
    two plots sharing a 60 ft boundary can show a few hundredths of a square foot of "overlap"
    purely from rounding. Eroding by the grid step before testing removes exactly that artefact
    while still catching the real defects this check exists for - the 0.3 sqft overshoots the
    old blanket simplify() produced, and anything larger."""
    problems = []
    everything = [("real", p) for p in real_polys] + [("fill", p) for p in fill_polys]

    for i in range(len(everything)):
        for j in range(i + 1, len(everything)):
            kind_a, a = everything[i]
            kind_b, b = everything[j]
            inter = a.buffer(-SNAP_GRID_FT).intersection(b.buffer(-SNAP_GRID_FT))
            if not inter.is_empty and inter.area > OVERLAP_TOL_SQFT:
                problems.append(
                    f"{kind_a} plot #{i} overlaps {kind_b} plot #{j} by {inter.area:.3f} sqft"
                )

    container = sub_poly.buffer(SNAP_GRID_FT)
    for kind, poly in everything + [("open space", p) for p in open_polys]:
        outside = poly.difference(container).area
        if outside > OVERLAP_TOL_SQFT:
            problems.append(f"a {kind} piece falls {outside:.3f} sqft outside the sub-section")

    # Land accounting. Over-accounting is a straight area comparison; under-accounting is
    # measured on the actual unclaimed geometry rather than on the totals, because open space
    # below MIN_OPEN_SPACE_SQFT is deliberately not reported - a handful of half-inch specks
    # along clipped edges would otherwise read as "land missing" when nothing is wrong. Eroding
    # the unclaimed region by half the sliver tolerance leaves exactly the pieces that are wide
    # enough to matter, so a genuinely lost block (the 227 sqft this check was written for)
    # still trips it.
    pieces = list(real_polys) + list(fill_polys) + list(open_polys)
    total = sum(p.area for p in pieces)
    if total - sub_poly.area > AREA_BALANCE_TOL_SQFT:
        problems.append(
            f"plots and open space cover {total:.2f} sqft, more than the sub-section's own "
            f"{sub_poly.area:.2f} sqft"
        )
    elif pieces:
        unclaimed = sub_poly.difference(unary_union(pieces))
        meaningful = unclaimed.buffer(-SLIVER_TOL_FT / 2.0) if not unclaimed.is_empty else unclaimed
        if not meaningful.is_empty and meaningful.area > AREA_BALANCE_TOL_SQFT:
            problems.append(
                f"{unclaimed.area:.2f} sqft of the sub-section is unaccounted for - it belongs "
                f"to no plot, fill piece or open space"
            )

    for kind, poly in everything:
        coords = list(poly.exterior.coords)[:-1]
        n = len(coords)
        for i in range(n):
            turn = _turn_degrees(coords[(i - 1) % n], coords[i], coords[(i + 1) % n])
            if turn < COLLINEAR_TOL_DEG or turn > SPIKE_TOL_DEG:
                problems.append(f"a {kind} plot has an un-normalized vertex (turn {turn:.2f} deg)")
                break

    return problems


# ---------------------------------------------------------------------------
# Frontage slot planning
# ---------------------------------------------------------------------------

FRONTAGE_SIMPLIFY_FT = 0.3   # only applied when it genuinely drops vertices, then re-clipped
FRONTAGE_PROBE_FT = 0.05     # how far off the boundary counts as "still bordering free land"
MIN_PLOT_AREA_FRACTION = 0.25  # of (frontage chord x minLength) - rejects zero-width wedges


def _side_count(poly):
    return len(list(poly.exterior.coords)) - 1


def _free_frontage_intervals(points, remaining):
    """
    The sub-intervals of one frontage run (as arc-length [start, end] pairs) that still border
    free land. Placing slots only inside these is what keeps a run from stamping a slot over
    frontage another run already consumed at a shared corner.
    """
    line = LineString(points)
    if remaining is None or remaining.is_empty or line.length < 1e-6:
        return []
    try:
        touched = line.intersection(remaining.buffer(FRONTAGE_PROBE_FT))
    except Exception:
        return [(0.0, line.length)]
    geoms = list(touched.geoms) if hasattr(touched, "geoms") else [touched]
    intervals = []
    for g in geoms:
        if g.geom_type != "LineString" or g.length < 1e-6:
            continue
        d0 = line.project(Point(g.coords[0]))
        d1 = line.project(Point(g.coords[-1]))
        lo, hi = sorted((d0, d1))
        if hi - lo > 1e-6:
            intervals.append((lo, hi))
    if not intervals:
        return []
    intervals.sort()
    merged = [list(intervals[0])]
    for lo, hi in intervals[1:]:
        if lo <= merged[-1][1] + FRONTAGE_PROBE_FT:
            merged[-1][1] = max(merged[-1][1], hi)
        else:
            merged.append([lo, hi])
    return [(lo, hi) for lo, hi in merged]


def _plan_options(interval_length, min_width, max_width, gap, budget=None):
    """
    Every equal-width slot plan worth trying for one free stretch of frontage, densest first.

    Equal widths replace the old "stamp maxWidth plots, then one narrow leftover" rule, which
    is what produced the odd stub plot at the end of every run. The preferred plan is the
    largest count whose equal share still lands inside [min_width, max_width]; the sparser
    counts follow as fallbacks for a run whose land can't actually take the densest split.
    """
    if interval_length < min_width - 1e-6 or min_width <= 0:
        return []
    options = []
    k_max = int(math.floor((interval_length + gap) / (min_width + gap) + 1e-9))
    if budget:
        k_max = min(k_max, budget)
    for k in range(k_max, 0, -1):
        w = (interval_length - (k - 1) * gap) / k
        if min_width - 1e-6 <= w <= max_width + 1e-6:
            options.append([w] * k)
    # A stretch a little longer than one max-width plot but too short for two min-width ones
    # divides evenly into nothing usable: take as many max-width plots as genuinely fit and let
    # the true remainder fall through to the residual, rather than stamping one odd-sized plot
    # purely to use it up.
    k = int(math.floor((interval_length + gap) / (max_width + gap) + 1e-9))
    if budget:
        k = min(k, budget)
    if k > 0:
        options.append([max_width] * k)
    return options


def _plan_even_slots(interval_length, min_width, max_width, gap, budget=None):
    """The preferred (densest) plan from _plan_options - kept as the single-answer form."""
    options = _plan_options(interval_length, min_width, max_width, gap, budget)
    return options[0] if options else []


def insert_plots(subsection_vertices, road_facing_edges, params):
    """
    Fills a sub-section polygon with plots: rectangular/trapezoidal plots along every
    road-facing edge first (real polygon math, not fixed-size stamping - each candidate is
    clipped against whatever land is ACTUALLY still left, via shapely intersection, so a
    plot near a taper naturally comes out as a trapezoid instead of an ill-fitting rectangle,
    and overlap between plots is structurally impossible since each accepted plot is
    immediately subtracted from the remaining land before the next one is even considered).
    Whatever land is left over afterwards goes through partition_residual(), which turns the
    usable parts into fill plots and reports the rest honestly as open space.

    road_facing_edges: list of {"path": [{x,y}, ...]} (2+ points) - each entry is one
        CONTINUOUS run of the sub-section's own boundary that borders a road, already merged
        client-side from consecutive road-facing boundary edges. This matters for a curved
        road: its frontage isn't one straight edge, it's dozens of tiny polyline segments (the
        discretized arc), and treating each one as an independent frontage - as an earlier
        version of this function did - meant no single segment was ever long enough to hold
        even one plot, so a curved frontage silently produced zero real plots. Walking
        plots along the whole merged run's own arc-length instead fixes that; each plot's own
        frontage-facing side is still the straight chord between two points on the run (a
        curving road's plots read as slightly kinked when consecutive slots follow it, which is
        both the practical convention real subdivision plats use and geometrically necessary -
        a single plot's own edge is inherently straight). {"a": {x,y}, "b": {x,y}} (a single
        straight edge, the older shape) is still accepted as a 2-point path for compatibility.
    params: {
        "minLength", "maxLength" (ft) - depth range (perpendicular into the sub-section, away
            from the road): every slot first tries maxLength, then shrinks in steps toward
            whatever depth still clears minLength, same adaptive reasoning a taper always
            needed, just driven directly by a length range now instead of a derived-from-area
            floor.
        "minWidth", "maxWidth" (ft) - width range (along the road frontage). Plots are spread
            EVENLY: within each free stretch of frontage, the largest plot count whose equal
            share falls inside [minWidth_eff, maxWidth] wins, and all of them get that same
            width. The older "as many maxWidth plots as fit, then one narrow leftover" rule is
            gone - it was what produced the odd stub plot at the end of every run.
        "minGap"   (ft) - fixed spacing between adjacent frontage plots along an edge.
        "roadThreshold" (ft) - minimum length of a plot's own road-facing side; acts as a floor
            under minWidth (a plot's frontage can never be narrower than this, even if minWidth
            itself is set lower).
        "maxPlots" (int or falsy) - optional hard cap on frontage plot count.
        plus the optional fill-quality overrides read by _fill_thresholds().
    }

    Returns:
        {
            "plots": [{"vertices": [...], "area": sqft, "sides": n, "fill": bool}, ...],
            "openSpace": [{"vertices": [...], "area": sqft}, ...],
            "subsectionArea": sqft,
            "invariantErrors": [str, ...],
        }
        `fill: false` entries are road-touching frontage plots; `fill: true` entries are the
        derived fill pieces covering usable leftover land. Fill plots are NOT independent
        objects - they are a view of the residual and get rebuilt from scratch whenever a real
        plot changes. `openSpace` is leftover land that failed the fill quality gate: it is
        reported rather than dressed up as a plot nobody could build on.
    """
    # Normalized here too, so the sub-section and the plots cut from it live on the same
    # coordinate grid - otherwise every clipped plot edge sits a few thousandths off its own
    # boundary and shows up as a spurious containment violation.
    sub_poly = normalize_polygon(subsection_vertices)
    if sub_poly is None:
        raise SiteGeometryError("The sub-section polygon is degenerate.")
    subsection_area = sub_poly.area

    min_length = float(params.get("minLength", 0))
    max_length = float(params.get("maxLength", 0)) or min_length
    min_width = float(params.get("minWidth", 0))
    max_width = float(params.get("maxWidth", 0)) or min_width
    gap = max(0.0, float(params.get("minGap", 0)))
    road_threshold = max(0.0, float(params.get("roadThreshold", 0)))
    max_plots = params.get("maxPlots") or None

    # roadThreshold is the same idea as minWidth (how short can a plot's own road-facing side
    # be) - whichever is stricter wins.
    effective_min_width = max(min_width, road_threshold)
    width = max(max_width, effective_min_width)
    depth = max_length
    min_depth = min(min_length, depth) if min_length > 0 else depth * 0.2

    remaining = sub_poly
    frontage_polys = []

    def path_point_at(points, seg_lengths, total, dist):
        """Point at arc-length `dist` along a polyline (clamped to the path's own ends)."""
        if dist <= 0:
            return points[0]
        if dist >= total:
            return points[-1]
        d = dist
        for i, seg_len in enumerate(seg_lengths):
            if d <= seg_len or i == len(seg_lengths) - 1:
                t = (d / seg_len) if seg_len > 1e-9 else 0.0
                p0, p1 = points[i], points[i + 1]
                return (p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t)
            d -= seg_len
        return points[-1]

    edges = []
    for e in road_facing_edges or []:
        raw_path = e.get("path")
        if isinstance(raw_path, list) and len(raw_path) >= 2:
            points = [(p["x"], p["y"]) for p in raw_path]
        else:
            a, b = e.get("a"), e.get("b")
            if not a or not b:
                continue
            points = [(a["x"], a["y"]), (b["x"], b["y"])]
        seg_lengths = [math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]) for i in range(len(points) - 1)]
        total = sum(seg_lengths)
        if total < 1e-6:
            continue
        edges.append({"points": points, "seg_lengths": seg_lengths, "len": total})
    edges.sort(key=lambda e: -e["len"])

    def try_place(x0, y0, x1, y1, remaining):
        """One frontage slot, from (x0,y0) to (x1,y1) along the road: probes both inward
        directions (whichever actually claims real land - see below), then shrinks depth from
        the target down to the minimum until a candidate whose real achieved depth clears
        min_length is found. Returns (accepted shapely Polygon, None) or (None, reason) - the
        reason names the actual constraint that blocked every attempt, surfaced to the user
        when a whole run ends up with zero plots so "why is this sub-section empty" has a real
        answer instead of a silent gap. Pure: it reads the land still available but never
        commits anything, so a whole slot plan can be tried and rolled back."""
        chord_len = math.hypot(x1 - x0, y1 - y0)
        if chord_len < 1e-6:
            return None, "this slot has no width"
        ux, uy = (x1 - x0) / chord_len, (y1 - y0) / chord_len
        nx, ny = -uy, ux
        # Which perpendicular actually points INTO the remaining land is an empirical
        # question, not a geometric guess - a centroid-direction heuristic (checking which
        # side the sub-section's overall centroid sits on) breaks down for a frontage that
        # curves or bends, where the correct inward direction for one slot can point quite
        # differently than the vector to the whole shape's centroid. Instead, probe both
        # directions at the full target depth and keep whichever actually claims real
        # land - directly answering the question the heuristic could only guess at.
        probe_a = Polygon([(x0, y0), (x1, y1), (x1 + nx * depth, y1 + ny * depth), (x0 + nx * depth, y0 + ny * depth)])
        probe_b = Polygon([(x0, y0), (x1, y1), (x1 - nx * depth, y1 - ny * depth), (x0 - nx * depth, y0 - ny * depth)])
        area_a = probe_a.intersection(remaining).area if probe_a.is_valid else make_valid(probe_a).intersection(remaining).area
        area_b = probe_b.intersection(remaining).area if probe_b.is_valid else make_valid(probe_b).intersection(remaining).area
        if area_b > area_a:
            nx, ny = -nx, -ny

        best_reason = "no usable land reaches this stretch of frontage at all"
        steps = 12
        for i in range(steps + 1):
            d = depth - ((depth - min_depth) * i / steps)
            if d < min_depth - 1e-6 or d <= 0:
                break
            rect = Polygon([
                (x0, y0), (x1, y1),
                (x1 + nx * d, y1 + ny * d), (x0 + nx * d, y0 + ny * d),
            ])
            if not rect.is_valid:
                rect = make_valid(rect)
            candidate = _largest_polygon(rect.intersection(remaining))
            if candidate is None:
                continue
            exact = candidate
            # `remaining`, after several subtractions, can end up as multiple disjoint pieces
            # (e.g. a plot taken from one frontage run can isolate a small pocket of land from
            # the rest). Intersecting a probe rectangle against a fragmented `remaining` can, in
            # rare GEOS edge cases, stitch two of those unrelated pieces into ONE returned
            # polygon joined by a hairline bridge - a shape that cannot be a real frontage plot
            # since part of it then sits entirely outside the sub-section (observed: one lobe
            # legitimately near the frontage, bridged to a second lobe on the far side of a
            # completely different boundary). A real candidate is always fully inside the
            # sub-section, so reject anything that isn't rather than trust the shape as given.
            if candidate.difference(sub_poly).area > 1.0:
                best_reason = "the only usable land here bridges two disconnected pockets"
                continue
            # A candidate clipped against a CURVED road's own remaining-land boundary picks up
            # every one of that curve's discretization vertices along its frontage side, which
            # can turn an intended straight/near-straight frontage into a 15+ sided sliver-fest.
            # Simplifying that away is still worth doing - but an EARLIER version simplified
            # unconditionally and kept the result even when it no longer matched the land it had
            # been clipped from, and that was the direct cause of two separate defects: plots
            # sitting 0.02-0.03 sqft outside their own sub-section (whose hairline edge crossings
            # then made neighbouring plots look like they overlapped, freezing every later edit),
            # and 0.18 ft wide leftover strips that the fill stage turned into 0.16-degree needle
            # triangles. So simplify only when it genuinely removes vertices AND survives being
            # clipped back to the real land; otherwise keep the exact clip.
            simplified = _largest_polygon(candidate.simplify(FRONTAGE_SIMPLIFY_FT, preserve_topology=True))
            if simplified is not None and _side_count(simplified) < _side_count(exact):
                trimmed = _largest_polygon(simplified.intersection(remaining))
                if (trimmed is not None
                        and _side_count(trimmed) <= _side_count(simplified)
                        and abs(trimmed.area - simplified.area) < 1.0):
                    candidate = trimmed
            # How deep does this candidate actually reach, measured the same way the target
            # depth itself is defined - the furthest any of its vertices project along the
            # inward normal from the frontage baseline. This is the length-based analogue of
            # the old area check, and it works even when clipping against an irregular boundary
            # leaves a shape whose "depth" isn't uniform across its width.
            achieved_depth = max(
                (vx - x0) * nx + (vy - y0) * ny for vx, vy in candidate.exterior.coords
            )
            if achieved_depth < min_length - 1e-6:
                # The first iteration probes the full requested depth, so its achieved_depth is
                # the deepest this chord can ever reach - later, shallower iterations can only
                # do worse. That makes it the one number worth reporting: "here is how deep the
                # land actually goes, and it falls short of what you asked for."
                if i == 0:
                    best_reason = (
                        f"the usable land here only reaches {achieved_depth:.1f} ft deep, short "
                        f"of the {min_length:.0f} ft minimum length"
                    )
                continue
            # The depth check alone only asks "does SOME point of this shape reach far enough
            # inward" - it says nothing about whether the shape actually touches the road at
            # all. When land right at the frontage baseline has already been claimed by a
            # neighbouring plot (e.g. from a DIFFERENT frontage run reaching into the same
            # area), the intersection can leave a fragment that floats a few feet inward,
            # disconnected from the road, yet still "achieves" enough depth by this measure -
            # exactly the kind of stray sliver that isn't a real frontage plot. Require the
            # candidate to actually border a meaningful length of its own frontage chord.
            frontage_chord = LineString([(x0, y0), (x1, y1)])
            touch_length = candidate.intersection(frontage_chord).length
            if touch_length < chord_len * 0.9:
                best_reason = "the usable land here pulls away from the road instead of bordering it"
                continue
            # Depth and frontage-touch alone can both be satisfied by a shape that encloses
            # nothing: a zero-width wedge hugging an angled boundary runs the full length of
            # the chord and reaches far enough inward at its tip, yet has essentially no area
            # (observed: a 6-sided 5.9 sqft zigzag along a diagonal road that was accepted as a
            # real plot). Require the candidate to hold a sensible fraction of the land its own
            # frontage and minimum depth imply - a genuine tapering trapezoid clears this
            # comfortably, a sliver cannot.
            if candidate.area < chord_len * min_length * MIN_PLOT_AREA_FRACTION:
                best_reason = "the usable land here is too narrow a sliver to count as a real plot"
                continue
            return normalize_polygon(candidate), None
        return None, best_reason

    generation_notes = []
    for edge in edges:
        if max_plots and len(frontage_polys) >= max_plots:
            break
        if remaining is None or remaining.is_empty or width <= 0:
            continue
        length = edge["len"]

        # Only lay slots along the stretches of this run that still border free land. A run
        # whose first stretch was already taken by a plot from an ADJACENT run (they meet at a
        # shared corner) used to still get a slot stamped there, and the intersection of that
        # slot with the land actually left came back as a real rectangle plus a zero-width
        # filament running up the already-taken frontage - the spike that made S2P3 a
        # "5-sided rectangle" no edit could ever move.
        intervals = _free_frontage_intervals(edge["points"], remaining)
        for interval_start, interval_end in intervals:
            budget = (max_plots - len(frontage_polys)) if max_plots else None
            if budget is not None and budget <= 0:
                break

            interval_length = interval_end - interval_start
            options = _plan_options(interval_length, effective_min_width, width, gap, budget)
            if not options:
                generation_notes.append(
                    f"a {interval_length:.1f} ft stretch of frontage is shorter than the "
                    f"{effective_min_width:.0f} ft minimum width, so no plot fits there"
                )
                continue

            # Try the evenly-divided plans in turn, most plots first, and keep the first one
            # where every slot actually lands. Where a run tapers (the land behind part of it
            # is shallower than minLength), the densest even split can't fit there at all -
            # falling back to fewer, wider plots lets one plot span from the deep land into the
            # taper as a trapezoid, which is what keeps utilisation up instead of handing half
            # the block to the fill stage.
            best_plots, best_remaining, best_reasons = None, remaining, []
            for slot_widths in options:
                trial_remaining = remaining
                placed, reasons = [], []
                pos = interval_start
                for slot_width in slot_widths:
                    x0, y0 = path_point_at(edge["points"], edge["seg_lengths"], length, pos)
                    x1, y1 = path_point_at(edge["points"], edge["seg_lengths"], length, pos + slot_width)
                    accepted, reason = try_place(x0, y0, x1, y1, trial_remaining)
                    if accepted is not None:
                        placed.append(accepted)
                        # The polygon stored as the plot and the polygon taken out of the land
                        # still available are the same object - no simplify/reclip divergence
                        # between them, which is what used to leave hairline strips behind for
                        # the fill stage to turn into needles.
                        trial_remaining = trial_remaining.difference(accepted)
                        if not trial_remaining.is_valid:
                            trial_remaining = make_valid(trial_remaining)
                    elif reason:
                        reasons.append(reason)
                    pos += slot_width + gap
                # Strict improvement only (a tie keeps the FIRST option's reasons, since that is
                # the densest attempt and its reasons are the most informative to report) - but
                # zero-vs-zero must still count as an "improvement" the first time through, or
                # the failure reasons from a totally unplaceable interval never get captured.
                if best_plots is None or len(placed) > len(best_plots):
                    best_plots, best_remaining, best_reasons = placed, trial_remaining, reasons
                if len(placed) == len(slot_widths) and placed:
                    best_reasons = []
                    break
            best_plots = best_plots or []
            frontage_polys.extend(best_plots)
            remaining = best_remaining
            if not best_plots and best_reasons:
                generation_notes.append(f"along a {interval_length:.0f} ft stretch of frontage, {best_reasons[0]}")

    # Hairline strips left along a clipped edge are handed to the neighbouring plot that owns
    # most of that boundary, rather than surviving into the fill stage as needles.
    frontage_polys, remaining = _merge_slivers_into_plots(remaining, frontage_polys, sub_poly)

    fill_polys, open_polys = partition_residual(remaining, frontage_polys, params)

    problems = check_invariants(sub_poly, frontage_polys, fill_polys, open_polys)

    unique_notes = []
    for note in generation_notes:
        if note not in unique_notes:
            unique_notes.append(note)

    return {
        "plots": [_plot_record(p, fill=False) for p in frontage_polys]
                 + [_plot_record(p, fill=True) for p in fill_polys],
        "openSpace": [{"vertices": _polygon_to_vertex_list(p), "area": round(p.area, 2)}
                      for p in open_polys],
        "subsectionArea": round(subsection_area, 2),
        "invariantErrors": problems,
        # Only surfaced to the user when zero real plots were placed at all (see app.js) - with
        # a partial success elsewhere in the sub-section these are usually just one tapering
        # corner behaving exactly as it should, not something to alarm over.
        "generationNotes": unique_notes,
    }


# ---------------------------------------------------------------------------
# Editing one plot: parametric edge push
#
# The area stepper used to move a plot's CORNERS along the bisector of their two edges'
# outward normals. That moves a corner diagonally, so any corner sitting on the sub-section
# boundary was pushed straight out of it and the edit was refused - traced as
# "own-outside-subsection" for the full/half/tenth-foot steps on three different plots, which
# is why growth almost never found a legal move. Translating a whole EDGE along its own
# outward normal and re-intersecting it with its two neighbours slides those corners ALONG the
# boundary instead, keeps the side count fixed, and never needs to touch another plot.
# ---------------------------------------------------------------------------

FRONTAGE_MATCH_TOL_FT = 0.75   # how close a plot edge's midpoint must sit to a road run
MIN_PUSH_FT = 0.02             # a push smaller than this is not worth reporting as progress
PUSH_BISECT_STEPS = 30
TARGET_AREA_TOL_SQFT = 0.5


def _edge_geometry(coords, i):
    n = len(coords)
    a, b = coords[i], coords[(i + 1) % n]
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dy)
    if length < 1e-9:
        return None
    ux, uy = dx / length, dy / length
    return {"a": a, "b": b, "u": (ux, uy), "outward": (uy, -ux), "length": length,
            "mid": ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)}


def _push_edge(coords, edge_index, t):
    """Translate edge `edge_index` by `t` along its own outward normal and re-intersect it
    with its two neighbouring edges' lines. Same line-intersection construction as
    offset_polygon_edges(). Returns new coords, or None if a neighbour is parallel (the
    corner would run off to infinity)."""
    n = len(coords)
    lines = []
    for i in range(n):
        geom = _edge_geometry(coords, i)
        if geom is None:
            return None
        point = geom["a"]
        if i == edge_index:
            point = (point[0] + geom["outward"][0] * t, point[1] + geom["outward"][1] * t)
        lines.append((point, geom["u"]))
    prev_i, next_i = (edge_index - 1) % n, (edge_index + 1) % n
    start = _line_intersection(lines[prev_i][0], lines[prev_i][1], lines[edge_index][0], lines[edge_index][1])
    end = _line_intersection(lines[edge_index][0], lines[edge_index][1], lines[next_i][0], lines[next_i][1])
    if start is None or end is None:
        return None
    new_coords = list(coords)
    new_coords[edge_index] = start
    new_coords[(edge_index + 1) % n] = end
    return new_coords


def _frontage_edge_indices(coords, road_paths):
    """Which of this plot's edges lie on a road-facing boundary of the sub-section. These are
    never pushed - a frontage plot that loses its road contact is not a plot any more."""
    hits = []
    for i in range(len(coords)):
        geom = _edge_geometry(coords, i)
        if geom is None:
            continue
        point = Point(geom["mid"])
        if any(path.distance(point) <= FRONTAGE_MATCH_TOL_FT for path in road_paths):
            hits.append(i)
    return hits


def _plot_frontage_and_depth(coords, frontage_indices):
    """(total frontage length, depth perpendicular to the frontage). With no frontage edge at
    all, depth falls back to the shape's own smaller bounding dimension."""
    if not frontage_indices:
        xs = [c[0] for c in coords]
        ys = [c[1] for c in coords]
        return 0.0, min(max(xs) - min(xs), max(ys) - min(ys))
    total = 0.0
    nx = ny = 0.0
    for i in frontage_indices:
        geom = _edge_geometry(coords, i)
        if geom is None:
            continue
        total += geom["length"]
        nx -= geom["outward"][0]
        ny -= geom["outward"][1]   # inward = opposite the frontage's outward normal
    norm = math.hypot(nx, ny)
    if norm < 1e-9:
        return total, 0.0
    nx, ny = nx / norm, ny / norm
    projections = [c[0] * nx + c[1] * ny for c in coords]
    return total, max(projections) - min(projections)


def _resolve_road_paths(road_facing_edges):
    paths = []
    for e in road_facing_edges or []:
        raw = e.get("path")
        if isinstance(raw, list) and len(raw) >= 2:
            pts = [(p["x"], p["y"]) for p in raw]
        else:
            a, b = e.get("a"), e.get("b")
            if not a or not b:
                continue
            pts = [(a["x"], a["y"]), (b["x"], b["y"])]
        line = LineString(pts)
        if line.length > 1e-6:
            paths.append(line)
    return paths


def resize_plot(subsection_vertices, road_facing_edges, plots, target_name, params,
                direction=None, step_ft=2.0, target_area=None, edge_index=None):
    """
    Grow or shrink ONE real plot by pushing one of its non-frontage edges, and rebuild the
    sub-section's fill/open space around the result.

    Independent-plots rule: the only polygon that changes is the target's own. A push that
    would run into another real plot, leave the sub-section, change the side count, or break a
    minimum dimension is refused, and the reason names the constraint that actually stopped it.

    plots: [{"name": str, "vertices": [...], "fill": bool}, ...] - the sub-section's plots as
        the client holds them; only the real (fill: false) ones are treated as land owners.

    Returns a dict with either "error" (blocked, with an honest reason) or the new plot plus
    the regenerated fill/open space.
    """
    sub_poly = normalize_polygon([{"x": v["x"], "y": v["y"]} for v in subsection_vertices])
    if sub_poly is None:
        raise SiteGeometryError("The sub-section polygon is degenerate.")

    real_polys, real_names = [], []
    target_idx = None
    for entry in plots or []:
        if entry.get("fill"):
            continue
        poly = normalize_polygon(entry.get("vertices") or [])
        if poly is None:
            continue
        if entry.get("name") == target_name:
            target_idx = len(real_polys)
        real_polys.append(poly)
        real_names.append(entry.get("name"))
    if target_idx is None:
        return {"error": f"No real plot named {target_name!r} in this sub-section."}

    target = real_polys[target_idx]
    others = [p for i, p in enumerate(real_polys) if i != target_idx]
    other_names = [n for i, n in enumerate(real_names) if i != target_idx]

    min_length = float(params.get("minLength", 0) or 0)
    min_width = max(float(params.get("minWidth", 0) or 0), float(params.get("roadThreshold", 0) or 0))

    coords = list(target.exterior.coords)[:-1]
    road_paths = _resolve_road_paths(road_facing_edges)
    frontage_indices = _frontage_edge_indices(coords, road_paths)
    pushable = [i for i in range(len(coords)) if i not in frontage_indices]
    if not pushable:
        return {"error": f"{target_name} has no non-frontage edge to push - every one of its "
                         f"sides lies on a road."}

    residual = sub_poly
    for poly in real_polys:
        residual = residual.difference(poly)
    if not residual.is_valid:
        residual = make_valid(residual)

    grow = (direction or ("grow" if (target_area or 0) >= target.area else "shrink")) == "grow"
    base_area = target.area

    def evaluate_on(edge, t):
        """(polygon, reason). `reason` names the binding constraint when the push is refused."""
        signed = t if grow else -t
        pushed = _push_edge(coords, edge, signed)
        if pushed is None:
            return None, "the neighbouring sides run parallel, so that corner has nowhere to land"
        poly = normalize_polygon(pushed)
        if poly is None:
            return None, "the push collapses the plot"
        if _side_count(poly) != len(coords):
            return None, (f"further movement on this edge would change {target_name} from "
                          f"{len(coords)} to {_side_count(poly)} sides")
        outside = poly.difference(sub_poly).area
        if outside > OVERLAP_TOL_SQFT:
            return None, "the edge would push past the sub-section boundary"
        for other, name in zip(others, other_names):
            if poly.intersection(other).area > OVERLAP_TOL_SQFT:
                return None, f"the edge would push into {name}"
        frontage_len, depth = _plot_frontage_and_depth(list(poly.exterior.coords)[:-1], frontage_indices)
        if min_width > 0 and frontage_indices and frontage_len < min_width - 1e-6:
            return None, f"frontage would drop below the minimum width of {min_width:g} ft"
        if min_length > 0 and depth < min_length - 1e-6:
            return None, f"depth is already at the minimum length of {min_length:g} ft"
        if grow and poly.area <= base_area + 1e-9:
            return None, "that push does not actually add area"
        if not grow and poly.area >= base_area - 1e-9:
            return None, "that push does not actually remove area"
        return poly, None

    def largest_feasible(edge, limit):
        """Bisection between 0 (always valid - it is the plot as it stands) and a bound shown
        to fail. Halving a single step from a fixed start can skip straight over a valid small
        push and give up below the floor, which is exactly how the old stepper produced
        'maxed out' while free land was still sitting there."""
        full = evaluate_on(edge, limit)
        if full[0] is not None:
            return limit, full[0], None
        # The reason to report is the one that blocks the step the user actually asked for.
        # Reasons harvested during the bisection are not it: as the trial push shrinks toward
        # zero the snapped polygon stops changing at all, so the last failure is always the
        # uninformative "that push does not actually add/remove area" rather than the real
        # constraint.
        reason = full[1]
        lo, hi = 0.0, limit
        best = None
        for _ in range(PUSH_BISECT_STEPS):
            mid = (lo + hi) / 2.0
            poly, _why = evaluate_on(edge, mid)
            if poly is not None:
                lo, best = mid, poly
            else:
                hi = mid
        if best is None or lo < MIN_PUSH_FT:
            return 0.0, None, reason
        return lo, best, None

    if edge_index is not None and edge_index not in pushable:
        return {"error": f"Edge {edge_index} of {target_name} is a road frontage and cannot be "
                         f"moved - the plot would lose its road contact."}
    order = [edge_index] if edge_index is not None else \
        _auto_edge_order(coords, pushable, frontage_indices, residual, grow)

    blocked_reasons = []
    for edge in order:
        if target_area is not None:
            poly, why = _push_to_target_area(lambda t: evaluate_on(edge, t), target_area, base_area, grow)
            if poly is not None:
                return _resize_result(sub_poly, real_polys, target_idx, poly, edge,
                                      params, target_name)
            blocked_reasons.append(why)
            continue
        _t, poly, reason = largest_feasible(edge, max(MIN_PUSH_FT, float(step_ft)))
        if poly is not None:
            return _resize_result(sub_poly, real_polys, target_idx, poly, edge,
                                  params, target_name)
        blocked_reasons.append(reason or "no movement was possible on that edge")

    unique = []
    for reason in blocked_reasons:
        if reason and reason not in unique:
            unique.append(reason)
    verb = "grow" if grow else "shrink"
    return {"error": f"Can't {verb} {target_name}: " + "; ".join(unique[:3]) + ".",
            "blocked": True}


def _push_to_target_area(evaluate, target_area, base_area, grow):
    """Area is monotonic in the push distance, so bisect the distance to land on the requested
    area. Returns (polygon or None, reason)."""
    lo, hi = 0.0, 1.0
    best, reason = None, "no push on this edge changes the area"
    for _ in range(24):  # grow the bracket until a push overshoots the target (or is refused)
        poly, why = evaluate(hi)
        if poly is None:
            reason = why
            break
        best = poly
        if (grow and poly.area >= target_area) or (not grow and poly.area <= target_area):
            break
        lo = hi
        hi *= 2.0
        if hi > 1e4:
            break
    for _ in range(PUSH_BISECT_STEPS):
        mid = (lo + hi) / 2.0
        poly, why = evaluate(mid)
        if poly is None:
            hi, reason = mid, why
            continue
        best = poly
        if abs(poly.area - target_area) <= TARGET_AREA_TOL_SQFT:
            return poly, None
        if (grow and poly.area < target_area) or (not grow and poly.area > target_area):
            lo = mid
        else:
            hi = mid
    return best, reason


def _auto_edge_order(coords, pushable, frontage_indices, residual, grow):
    """Rear edge first (the one facing away from the road), then the side edges ordered by how
    much free land actually lies beyond each of them."""
    frontage_outward = (0.0, 0.0)
    for i in frontage_indices:
        geom = _edge_geometry(coords, i)
        if geom:
            frontage_outward = (frontage_outward[0] + geom["outward"][0],
                                frontage_outward[1] + geom["outward"][1])
    norm = math.hypot(*frontage_outward)
    if norm > 1e-9:
        frontage_outward = (frontage_outward[0] / norm, frontage_outward[1] / norm)

    scored = []
    for i in pushable:
        geom = _edge_geometry(coords, i)
        if geom is None:
            continue
        rear_score = -(geom["outward"][0] * frontage_outward[0] + geom["outward"][1] * frontage_outward[1])
        free = 0.0
        if grow and residual is not None and not residual.is_empty:
            reach = 30.0
            probe = Polygon([
                geom["a"], geom["b"],
                (geom["b"][0] + geom["outward"][0] * reach, geom["b"][1] + geom["outward"][1] * reach),
                (geom["a"][0] + geom["outward"][0] * reach, geom["a"][1] + geom["outward"][1] * reach),
            ])
            if not probe.is_valid:
                probe = make_valid(probe)
            try:
                free = probe.intersection(residual).area
            except Exception:
                free = 0.0
        scored.append((i, rear_score, free))

    rear = max(scored, key=lambda s: s[1]) if scored else None
    rest = sorted([s for s in scored if rear is None or s[0] != rear[0]],
                  key=lambda s: -s[2])
    return ([rear[0]] if rear else []) + [s[0] for s in rest]


def _resize_result(sub_poly, real_polys, target_idx, new_poly, edge_pushed, params, target_name):
    updated = list(real_polys)
    updated[target_idx] = new_poly
    residual = sub_poly
    for poly in updated:
        residual = residual.difference(poly)
    if not residual.is_valid:
        residual = make_valid(residual)
    fill_polys, open_polys = partition_residual(residual, updated, params)
    problems = check_invariants(sub_poly, updated, fill_polys, open_polys)
    if problems:
        return {"error": f"That edit would break the sub-section: {problems[0]}",
                "invariantErrors": problems}
    return {
        "plot": _plot_record(new_poly, fill=False, name=target_name),
        "edgePushed": edge_pushed,
        "fill": [_plot_record(p, fill=True) for p in fill_polys],
        "openSpace": [{"vertices": _polygon_to_vertex_list(p), "area": round(p.area, 2)}
                      for p in open_polys],
        "invariantErrors": [],
    }


def regenerate_fill(subsection_vertices, plots, params):
    """
    Rebuild a sub-section's fill plots and open space from its real plots alone. Fill is a
    derived view of `sub-section - union(real plots)`, so this is the single place that view
    is produced - after generation, after an area-stepper push, and after a manual edge or
    diagonal edit is saved.
    """
    sub_poly = normalize_polygon([{"x": v["x"], "y": v["y"]} for v in subsection_vertices])
    if sub_poly is None:
        raise SiteGeometryError("The sub-section polygon is degenerate.")

    real_polys = []
    for entry in plots or []:
        if entry.get("fill"):
            continue
        poly = normalize_polygon(entry.get("vertices") or [])
        if poly is not None:
            real_polys.append(poly)

    residual = sub_poly
    for poly in real_polys:
        residual = residual.difference(poly)
    if not residual.is_valid:
        residual = make_valid(residual)

    fill_polys, open_polys = partition_residual(residual, real_polys, params)
    problems = check_invariants(sub_poly, real_polys, fill_polys, open_polys)
    return {
        "realPlots": [_plot_record(p, fill=False) for p in real_polys],
        "fill": [_plot_record(p, fill=True) for p in fill_polys],
        "openSpace": [{"vertices": _polygon_to_vertex_list(p), "area": round(p.area, 2)}
                      for p in open_polys],
        "invariantErrors": problems,
    }
