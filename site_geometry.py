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
from shapely.geometry import Polygon, LineString
from shapely.validation import make_valid
from shapely.ops import unary_union


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


def insert_plots(subsection_vertices, road_facing_edges, params):
    """
    Fills a sub-section polygon with plots: rectangular/trapezoidal plots along every
    road-facing edge first (real polygon math, not fixed-size stamping - each candidate is
    clipped against whatever land is ACTUALLY still left, via shapely intersection, so a
    plot near a taper naturally comes out as a trapezoid instead of an ill-fitting rectangle,
    and overlap between plots is structurally impossible since each accepted plot is
    immediately subtracted from the remaining land before the next one is even considered).
    Whatever land is left after every frontage edge has had a pass filled is not wasted -
    it's tiled edge-to-edge with a constrained Delaunay triangulation (shapely, respects the
    remaining shape's own concave boundary exactly), so corners and tapers a rectangle could
    never reach are covered by small triangular plots instead of counted as waste.

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
        "minWidth", "maxWidth" (ft) - width range (along the road frontage): most plots along a
            run use maxWidth; whatever's left over at the end of a run once no more full-width
            plot fits gets ONE final plot sized down to whatever remains, as long as that's at
            least minWidth (and the road threshold below) - the "no wasted frontage" case a
            fixed width could never use.
        "minGap"   (ft) - fixed spacing between adjacent frontage plots along an edge.
        "roadThreshold" (ft) - minimum length of a plot's own road-facing side; acts as a floor
            under minWidth (a plot's frontage can never be narrower than this, even if minWidth
            itself is set lower).
        "maxPlots" (int or falsy) - optional hard cap on frontage plot count.
    }

    Returns:
        {
            "plots": [{"vertices": [...], "area": sqft, "sides": n, "fill": bool}, ...],
            "subsectionArea": sqft,
        }
        `fill: false` entries are road-touching frontage plots (rectangle/trapezoid/pentagon
        depending on how the boundary clipped them); `fill: true` entries are the triangular
        fill plots with no frontage requirement, meant to be drawn with a dashed/dotted
        outline so they read visually as "corner fill" rather than a standard plot.
    """
    sub_poly = Polygon(_polygon_from_vertices(subsection_vertices))
    if not sub_poly.is_valid:
        sub_poly = make_valid(sub_poly)
    sub_poly = _largest_polygon(sub_poly) or sub_poly
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
    frontage_plots = []

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

    def try_place(x0, y0, x1, y1):
        """One frontage slot, from (x0,y0) to (x1,y1) along the road: probes both inward
        directions (whichever actually claims real land - see below), then shrinks depth from
        the target down to the minimum until a candidate whose real achieved depth clears
        min_length is found. Returns the accepted shapely Polygon, or None."""
        nonlocal remaining
        chord_len = math.hypot(x1 - x0, y1 - y0)
        if chord_len < 1e-6:
            return None
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
                continue
            # A candidate clipped against a CURVED road's own remaining-land boundary picks up
            # every one of that curve's discretization vertices along its frontage side, which
            # can turn an intended straight/near-straight frontage into a 15+ sided sliver-fest -
            # a curved road's real-world plots have a straight (or gently kinked) frontage line
            # approximating the curve locally, not one that traces every arc facet, so simplify
            # away that sub-foot wiggle. simplify() can nudge a vertex a fraction of a foot
            # outside the true remaining land (re-clipping against `remaining` to force an exact
            # fit would just retrace the same wiggle right back onto the boundary, undoing the
            # simplification entirely) - a sub-foot approximation here is consistent with the
            # arc itself already being a 24-segment discretization, not a mathematically exact
            # curve.
            candidate = _largest_polygon(candidate.simplify(0.3, preserve_topology=True)) or candidate
            # How deep does this candidate actually reach, measured the same way the target
            # depth itself is defined - the furthest any of its vertices project along the
            # inward normal from the frontage baseline. This is the length-based analogue of
            # the old area check, and it works even when clipping against an irregular boundary
            # leaves a shape whose "depth" isn't uniform across its width.
            achieved_depth = max(
                (vx - x0) * nx + (vy - y0) * ny for vx, vy in candidate.exterior.coords
            )
            if achieved_depth < min_length - 1e-6:
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
                continue
            return candidate
        return None

    for edge in edges:
        if max_plots and len(frontage_plots) >= max_plots:
            break
        if remaining is None or remaining.is_empty or width <= 0:
            continue
        length = edge["len"]

        pos = 0.0
        while pos + width <= length + 1e-6:
            if max_plots and len(frontage_plots) >= max_plots:
                break
            x0, y0 = path_point_at(edge["points"], edge["seg_lengths"], length, pos)
            x1, y1 = path_point_at(edge["points"], edge["seg_lengths"], length, pos + width)
            accepted = try_place(x0, y0, x1, y1)
            if accepted is not None:
                frontage_plots.append({
                    "vertices": _polygon_to_vertex_list(accepted),
                    "area": round(accepted.area, 2),
                    "sides": len(list(accepted.exterior.coords)) - 1,
                    "fill": False,
                })
                remaining = remaining.difference(accepted)
                if not remaining.is_valid:
                    remaining = make_valid(remaining)
                remaining = _largest_polygon(remaining) if remaining.geom_type == "Polygon" else remaining
            pos += width + gap

        # Whatever's left of this run's own frontage (shorter than one more full-width plot)
        # doesn't have to go to waste (or fall through to the corner-fill triangulation, which
        # has no road-frontage requirement at all) - if it's still at least as wide as the
        # minimum a plot is allowed to be, give it one last, narrower plot sized to exactly
        # what's left, using the same depth-adaptive placement as every other slot.
        leftover = length - pos
        if leftover >= effective_min_width - 1e-6 and not (max_plots and len(frontage_plots) >= max_plots):
            x0, y0 = path_point_at(edge["points"], edge["seg_lengths"], length, pos)
            x1, y1 = path_point_at(edge["points"], edge["seg_lengths"], length, length)
            accepted = try_place(x0, y0, x1, y1)
            if accepted is not None:
                frontage_plots.append({
                    "vertices": _polygon_to_vertex_list(accepted),
                    "area": round(accepted.area, 2),
                    "sides": len(list(accepted.exterior.coords)) - 1,
                    "fill": False,
                })
                remaining = remaining.difference(accepted)
                if not remaining.is_valid:
                    remaining = make_valid(remaining)
                remaining = _largest_polygon(remaining) if remaining.geom_type == "Polygon" else remaining

    fill_plots = []
    if remaining is not None and not remaining.is_empty:
        remaining_polys = (
            [g for g in remaining.geoms if g.geom_type == "Polygon" and g.area > 1e-6]
            if hasattr(remaining, "geoms") else
            ([remaining] if remaining.geom_type == "Polygon" and remaining.area > 1e-6 else [])
        )
        for poly in remaining_polys:
            tris = shapely.constrained_delaunay_triangles(poly)
            tri_geoms = tris.geoms if hasattr(tris, "geoms") else [tris]
            for tri in tri_geoms:
                if tri.geom_type != "Polygon" or tri.area < 0.5:
                    continue
                fill_plots.append({
                    "vertices": _polygon_to_vertex_list(tri),
                    "area": round(tri.area, 2),
                    "sides": len(list(tri.exterior.coords)) - 1,
                    "fill": True,
                })

    return {
        "plots": frontage_plots + fill_plots,
        "subsectionArea": round(subsection_area, 2),
    }
