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


def compute_subsections(plot_vertices, roads):
    """
    Subtracts every road's own width-buffered strip from the master plot polygon, returning
    whatever land is left as one or more "sub-section" polygons - the blocks that plots later
    get sliced out of in the plot-logic stage. `roads` is a list of
    {"start": {"x":.., "y":..}, "end": {"x":.., "y":..}, "width": ft}.

    Road strips use FLAT (not rounded) end caps, so a road doesn't eat into land past its own
    given endpoint - a dead end really does end exactly where its length says it does.

    Each strip is extended by a tiny epsilon past both of its own endpoints before the
    subtraction. A road that runs corner-to-corner or side-to-side has an endpoint sitting
    EXACTLY on the plot's own boundary; subtracting a strip whose edge is exactly coincident
    with the container's boundary is a classic exact-arithmetic degenerate case for GEOS,
    which can return one "pinched" polygon (both halves joined by a zero-width bridge)
    instead of cleanly splitting it into two. Overshooting very slightly guarantees the cut
    actually passes through the boundary rather than just touching it.
    """
    EPSILON_FT = 0.1

    plot = Polygon(_polygon_from_vertices(plot_vertices))
    if not plot.is_valid:
        plot = make_valid(plot)

    strips = []
    for road in roads:
        start = (road["start"]["x"], road["start"]["y"])
        end = (road["end"]["x"], road["end"]["y"])
        width = float(road.get("width", 0))
        if width <= 0:
            continue
        length = math.hypot(end[0] - start[0], end[1] - start[1])
        if length < 1e-6:
            continue
        ux, uy = (end[0] - start[0]) / length, (end[1] - start[1]) / length
        ext_start = (start[0] - ux * EPSILON_FT, start[1] - uy * EPSILON_FT)
        ext_end = (end[0] + ux * EPSILON_FT, end[1] + uy * EPSILON_FT)
        line = LineString([ext_start, ext_end])
        strips.append(line.buffer(width / 2.0, cap_style=2))  # cap_style 2 = flat

    remaining = plot
    if strips:
        roads_union = unary_union(strips)
        remaining = plot.difference(roads_union)
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

    road_facing_edges: list of {"a": {x,y}, "b": {x,y}} - which of the sub-section's own
        boundary edges actually border a road (that determination - checking both internal
        roads and the master plot's own Role-tagged edges - is already made client-side, so
        this function just takes the resulting edge list rather than re-deriving it).
    params: {
        "minArea", "maxArea"  (sq ft) - target range for a frontage plot; the midpoint is the
            aim size, and depth adapts downward per-slot toward whatever still clears minArea.
        "minGap"   (ft) - fixed spacing between adjacent frontage plots along an edge.
        "roadThreshold" (ft) - minimum length of a plot's own road-facing side.
        "minSides" (int) - a frontage candidate whose actual clipped shape has fewer sides
            than this is rejected as a distinct plot and left for the triangulation fill pass
            instead (this is what keeps, e.g., a sliver triangle from being reported as one of
            the "real" frontage plots when minSides is 4).
        "maxSides" (int) - a clipped shape with more vertices than this is likewise rejected
            (shrinking depth is tried first in case a shallower cut has fewer sides).
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
    centroid = sub_poly.centroid

    min_area = float(params.get("minArea", 0))
    max_area = float(params.get("maxArea", 0))
    gap = max(0.0, float(params.get("minGap", 0)))
    road_threshold = max(0.0, float(params.get("roadThreshold", 0)))
    min_sides = int(params.get("minSides", 3) or 3)
    max_sides = int(params.get("maxSides", 6) or 6)
    max_plots = params.get("maxPlots") or None

    target_area = (min_area + max_area) / 2.0 if (min_area and max_area) else max(min_area, max_area, 100.0)
    aspect = 1.2
    width = math.sqrt(target_area / aspect) if target_area > 0 else 0
    if width < road_threshold:
        width = road_threshold
    depth = (target_area / width) if width > 0 else 0
    min_depth = (min_area / width) if (width > 0 and min_area > 0) else depth * 0.2

    remaining = sub_poly
    frontage_plots = []

    edges = []
    for e in road_facing_edges or []:
        a, b = e.get("a"), e.get("b")
        if not a or not b:
            continue
        length = math.hypot(b["x"] - a["x"], b["y"] - a["y"])
        if length < 1e-6:
            continue
        edges.append({"a": a, "b": b, "len": length})
    edges.sort(key=lambda e: -e["len"])

    for edge in edges:
        if max_plots and len(frontage_plots) >= max_plots:
            break
        if remaining is None or remaining.is_empty or width <= 0:
            continue
        ax, ay, bx, by = edge["a"]["x"], edge["a"]["y"], edge["b"]["x"], edge["b"]["y"]
        length = edge["len"]
        ux, uy = (bx - ax) / length, (by - ay) / length
        nx, ny = -uy, ux
        mid_x, mid_y = (ax + bx) / 2.0, (ay + by) / 2.0
        toward_x, toward_y = centroid.x - mid_x, centroid.y - mid_y
        if nx * toward_x + ny * toward_y < 0:
            nx, ny = -nx, -ny

        pos = 0.0
        while pos + width <= length + 1e-6:
            if max_plots and len(frontage_plots) >= max_plots:
                break
            x0, y0 = ax + ux * pos, ay + uy * pos
            x1, y1 = ax + ux * (pos + width), ay + uy * (pos + width)

            accepted = None
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
                area = candidate.area
                if area < min_area - 1e-6:
                    continue
                sides = len(list(candidate.exterior.coords)) - 1
                if sides < min_sides or sides > max_sides:
                    continue
                accepted = candidate
                break

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
