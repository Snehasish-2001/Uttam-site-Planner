"""
json_to_dxf.py (uttam-4)

Simple multi-floor JSON -> DXF converter, started from the "simple" style
of json_to_dxf.py from uttam-1/prototype (no LLM, no rich_planner.py
schema), generalised to stack N floors vertically in one DXF, using
layout_geometry.py for every floor's plot/buildable-area/offset math so
this file and pdf_render.py can never disagree about where a floor sits.

Walls are double-line with real thickness and cut door/window openings
(layout_geometry.build_wall_lines()), not a single rectangle per room -
this was added specifically to get closer to a real architect's DXF
convention (see uttam-4/dxf_demo/ and uttam-4/CLAUDE.md's "Matching a
real DXF" section for the comparison this was built against).

Usage:
    python json_to_dxf.py layout.json output.dxf
"""

import json
import sys
from pathlib import Path

import ezdxf

from layout_geometry import (
    LayoutError,
    buildable_rect,
    build_wall_bands,
    floor_offsets,
    floor_label,
    get_plot,
    get_wall_thickness,
    stair_layout,
)

FT_TO_MM = 304.8


def ft(value):
    return float(value) * FT_TO_MM


def ensure_layers(doc):
    layers = {
        "PLOT": 8,
        "SETBACK": 2,
        "FOOTPRINT": 30,
        "WALL": 7,
        "DOOR": 1,
        "WINDOW": 4,
        "ROOM_TEXT": 3,
        "DIMENSION": 2,
        "STAIR": 6,
        "PARKING": 5,
        "ANNOTATION": 1,
    }
    for name, color in layers.items():
        if name not in doc.layers:
            doc.layers.add(name, color=color)


def add_line(msp, p1, p2, layer):
    msp.add_line(p1, p2, dxfattribs={"layer": layer})


def add_rect(msp, x, y, w, h, layer, y_offset=0.0):
    x, y, w, h = ft(x), ft(y + y_offset), ft(w), ft(h)
    add_line(msp, (x, y), (x + w, y), layer)
    add_line(msp, (x + w, y), (x + w, y + h), layer)
    add_line(msp, (x + w, y + h), (x, y + h), layer)
    add_line(msp, (x, y + h), (x, y), layer)


def add_polyline(msp, points, layer, y_offset=0.0, closed=True):
    """A closed (by default) polyline through arbitrary vertices, in feet - used for
    non-rectangular plot/buildable/footprint boundaries. Drawn as plain line segments
    (matching add_rect()'s convention) rather than ezdxf's LWPOLYLINE entity, so every
    boundary in this file is the same entity type regardless of plot shape."""
    pts = [(ft(px), ft(py + y_offset)) for px, py in points]
    if not pts:
        return
    if closed:
        pts = pts + [pts[0]]
    for p1, p2 in zip(pts, pts[1:]):
        add_line(msp, p1, p2, layer)


def add_filled_rect(msp, x1, y1, x2, y2, layer):
    """A solid-filled axis-aligned rectangle (already in mm/DXF units, no
    ft() conversion here - callers convert). Point order is the standard
    "Z" order add_solid()/3DFACE need to avoid a self-intersecting bowtie
    fill: (bottom-left, bottom-right, top-left, top-right), not a simple
    walk around the perimeter."""
    x1, x2 = sorted((x1, x2))
    y1, y2 = sorted((y1, y2))
    msp.add_solid([(x1, y1), (x2, y1), (x1, y2), (x2, y2)], dxfattribs={"layer": layer})


def add_text(msp, value, x, y, y_offset=0.0, height=250, layer="ROOM_TEXT"):
    entity = msp.add_text(str(value), dxfattribs={"layer": layer, "height": height})
    entity.set_placement((ft(x), ft(y + y_offset)))
    return entity


def add_dimension(msp, p1, p2, base, angle=0):
    dim = msp.add_linear_dim(
        base=(ft(base[0]), ft(base[1])),
        p1=(ft(p1[0]), ft(p1[1])),
        p2=(ft(p2[0]), ft(p2[1])),
        angle=angle,
        dxfattribs={"layer": "DIMENSION"},
    )
    dim.render()


def add_door(msp, door, y_offset, wall_thickness):
    # "archway" is a plain wall opening - no jamb marks at all. The wall
    # itself is still cut at this position (layout_geometry.build_wall_bands()
    # doesn't care about "style", it treats every entry in doors[] as an
    # opening to cut regardless) - this only skips the visual door symbol.
    if door.get("style") == "archway":
        return

    x = ft(door["x"])
    y = ft(door["y"] + y_offset)
    width = ft(door.get("width", 3))
    orientation = door.get("orientation", "horizontal")
    depth = ft(wall_thickness) / 2

    # Plain jamb marks, no leaf/swing arc - a short tick perpendicular to
    # the wall at each end of the opening ("-|      |-"), leaving the gap
    # itself untouched (the wall cut already shows the opening; this just
    # marks it as a door rather than a plain archway).
    if orientation == "horizontal":
        add_line(msp, (x, y - depth), (x, y + depth), "DOOR")
        add_line(msp, (x + width, y - depth), (x + width, y + depth), "DOOR")
    else:
        add_line(msp, (x - depth, y), (x + depth, y), "DOOR")
        add_line(msp, (x - depth, y + width), (x + depth, y + width), "DOOR")


def add_window(msp, window, y_offset, wall_thickness):
    x = ft(window["x"])
    y = ft(window["y"] + y_offset)
    width = ft(window.get("width", 4))
    orientation = window.get("orientation", "horizontal")
    depth = ft(wall_thickness)  # fills the wall's own thickness, not a fixed gap

    if orientation == "horizontal":
        add_filled_rect(msp, x, y - depth / 2, x + width, y + depth / 2, "WINDOW")
    else:
        add_filled_rect(msp, x - depth / 2, y, x + depth / 2, y + width, "WINDOW")


def add_stair(msp, stair, y_offset, wall_thickness):
    x_ft, y_ft = float(stair["x"]), float(stair["y"])
    w_ft, h_ft = float(stair["width"]), float(stair["height"])

    add_rect(msp, x_ft, y_ft, w_ft, h_ft, "STAIR", y_offset=y_offset)

    layout = stair_layout(stair, wall_thickness)

    if layout["style"] == "switchback":
        for fx0, fx1, fy0, fy1, fsteps in (layout["flight_a"], layout["flight_b"]):
            x0, x1 = ft(fx0), ft(fx1)
            y0, y1 = ft(fy0 + y_offset), ft(fy1 + y_offset)
            tread_h = (y1 - y0) / fsteps
            for i in range(1, fsteps):
                yy = y0 + i * tread_h
                add_line(msp, (x0, yy), (x1, yy), "STAIR")

        # Divider between the two flights, and the landing's own outline -
        # both thin reference lines (not a filled wall) so they read as
        # part of the stair diagram itself, matching the tread-line style.
        dx, dy0, dy1 = layout["divider"]
        add_line(msp, (ft(dx), ft(dy0 + y_offset)), (ft(dx), ft(dy1 + y_offset)), "STAIR")
        add_rect(msp, x_ft, dy1, w_ft, (y_ft + h_ft) - dy1, "STAIR", y_offset=y_offset)
    else:
        x0, x1 = ft(x_ft), ft(x_ft + w_ft)
        for ty in layout["tread_ys"]:
            yy = ft(ty + y_offset)
            add_line(msp, (x0, yy), (x1, yy), "STAIR")

    # Up/down travel line - straight run only. For a switchback, the
    # divider already drawn above serves as the one center line; also
    # drawing the up-across-down travel path would add two more near-
    # parallel vertical lines (one through each flight's own center)
    # right alongside it, cluttering the box with three lines doing
    # almost the same job instead of one.
    if layout["style"] == "straight":
        path = [(ft(px), ft(py + y_offset)) for px, py in layout["path"]]
        for p1, p2 in zip(path, path[1:]):
            add_line(msp, p1, p2, "STAIR")

    # Wall capping the top of the flight (where it meets the floor above) -
    # drawn explicitly here, on the WALL layer, rather than relying on
    # whatever build_wall_bands() resolves the Staircase room's own top
    # edge to (thin if it happens to share a zero-gap boundary with a
    # neighbor, which reads as "no wall" right where a real flight ends).
    x, y, w, h = ft(x_ft), ft(y_ft + y_offset), ft(w_ft), ft(h_ft)
    depth = ft(wall_thickness)
    add_filled_rect(msp, x, y + h - depth / 2, x + w, y + h + depth / 2, "WALL")


def add_parking(msp, parking, y_offset):
    add_rect(msp, parking["x"], parking["y"], parking["width"], parking["height"],
              "PARKING", y_offset=y_offset)
    add_text(
        msp,
        parking.get("name", "PARKING"),
        float(parking["x"]) + float(parking["width"]) / 2,
        float(parking["y"]) + float(parking["height"]) / 2,
        y_offset=y_offset,
        height=200,
        layer="PARKING",
    )


def plot_bounds(data):
    """(min_x, min_y, max_x, max_y) of the plot - from site.plot.vertices for a polygon
    site, else the legacy [0,width]x[0,depth] rectangle. Every caller that used to assume
    the plot spans [0,plot_w]x[0,plot_h] (dimensions, north-arrow default, floor label
    position) now anchors to this bounding box instead, since a polygon plot's own walk
    doesn't necessarily start at the bounding box's own corner."""
    site = data.get("site", {})
    plot_vertices = (site.get("plot") or {}).get("vertices")
    if plot_vertices:
        xs = [v["x"] for v in plot_vertices]
        ys = [v["y"] for v in plot_vertices]
        return min(xs), min(ys), max(xs), max(ys)
    plot = get_plot(site)
    return 0.0, 0.0, plot["width"], plot["depth"]


def draw_site_and_footprint(msp, data, y_offset):
    """Draws the PLOT/SETBACK boundary (polygon site.plot.vertices if present, else the
    legacy axis-aligned width/depth rectangle) and, if present, the FOOTPRINT boundary
    (footprint.vertices). Plot vertices get lettered labels (A, B, C, ...) matching how a
    real survey labels corners - shown once per floor, same as every other floor annotation."""
    site = data.get("site", {})
    plot_vertices = (site.get("plot") or {}).get("vertices")

    if plot_vertices:
        plot_pts = [(v["x"], v["y"]) for v in plot_vertices]
        add_polyline(msp, plot_pts, "PLOT", y_offset=y_offset)
        for v in plot_vertices:
            label = v.get("label")
            if label:
                add_text(msp, label, v["x"], v["y"], y_offset=y_offset, height=250, layer="ANNOTATION")

        buildable_vertices = (site.get("buildable") or {}).get("vertices")
        if buildable_vertices:
            add_polyline(msp, [(v["x"], v["y"]) for v in buildable_vertices], "SETBACK", y_offset=y_offset)
    else:
        plot = get_plot(site)
        plot_w, plot_h = plot["width"], plot["depth"]
        add_rect(msp, 0, 0, plot_w, plot_h, "PLOT", y_offset=y_offset)

        bx, by, bw, bh = buildable_rect(site)
        add_rect(msp, bx, by, bw, bh, "SETBACK", y_offset=y_offset)

    footprint_vertices = (data.get("footprint") or {}).get("vertices")
    if footprint_vertices:
        add_polyline(msp, [(v["x"], v["y"]) for v in footprint_vertices], "FOOTPRINT", y_offset=y_offset)


def draw_floor(msp, data, floor, y_offset, index):
    site = data.get("site", {})
    draw_site_and_footprint(msp, data, y_offset)

    wall_thickness = get_wall_thickness(site)
    for orient, coord_a, coord_b, segments in build_wall_bands(floor, wall_thickness):
        for start, end in segments:
            if coord_a == coord_b:
                # Degenerate (zero-gap) band - nothing to fill, draw a single line.
                if orient == "H":
                    add_line(msp, (ft(start), ft(coord_a + y_offset)), (ft(end), ft(coord_a + y_offset)), "WALL")
                else:
                    add_line(msp, (ft(coord_a), ft(start + y_offset)), (ft(coord_a), ft(end + y_offset)), "WALL")
            elif orient == "H":
                add_filled_rect(msp, ft(start), ft(coord_a + y_offset), ft(end), ft(coord_b + y_offset), "WALL")
            else:
                add_filled_rect(msp, ft(coord_a), ft(start + y_offset), ft(coord_b), ft(end + y_offset), "WALL")

    for room in floor.get("rooms", []):
        cx = float(room["x"]) + float(room["width"]) / 2
        cy = float(room["y"]) + float(room["height"]) / 2
        add_text(msp, room["name"], cx, cy, y_offset=y_offset, height=250)
        if room.get("show_size", True):
            size_text = f'{room["width"]}\'-0" x {room["height"]}\'-0"'
            add_text(msp, size_text, cx, cy - 1.2, y_offset=y_offset, height=160)

    for door in floor.get("doors", []):
        add_door(msp, door, y_offset, wall_thickness)

    for window in floor.get("windows", []):
        add_window(msp, window, y_offset, wall_thickness)

    for stair in floor.get("stairs", []):
        add_stair(msp, stair, y_offset, wall_thickness)

    for parking in floor.get("parking", []):
        add_parking(msp, parking, y_offset)

    min_x, min_y, max_x, max_y = plot_bounds(data)

    if data.get("annotations", {}).get("overall_dimensions", True):
        add_dimension(
            msp, (min_x, min_y + y_offset), (max_x, min_y + y_offset),
            ((min_x + max_x) / 2, min_y + y_offset - 4), 0,
        )
        add_dimension(
            msp, (min_x, min_y + y_offset), (min_x, max_y + y_offset),
            (min_x - 4, (min_y + max_y) / 2 + y_offset), 90,
        )

    north = data.get("north_arrow")
    if north:
        x = float(north.get("x", max_x + 5))
        y = float(north.get("y", max_y - 5))
        add_line(msp, (ft(x), ft(y - 2 + y_offset)), (ft(x), ft(y + 3 + y_offset)), "ANNOTATION")
        add_text(msp, "N", x - 0.4, y + 3.5, y_offset=y_offset, height=300, layer="ANNOTATION")

    add_text(
        msp,
        floor_label(floor, index),
        min_x,
        max_y + 2,
        y_offset=y_offset,
        height=350,
        layer="ANNOTATION",
    )


def generate(data, output_path):
    if not isinstance(data, dict):
        raise LayoutError(f"Layout JSON must be an object, got: {type(data).__name__}")

    doc = ezdxf.new("R2018")
    doc.header["$INSUNITS"] = 4  # millimetres
    doc.header["$MEASUREMENT"] = 1

    ensure_layers(doc)
    msp = doc.modelspace()

    bands = []
    for floor, y_offset, index in floor_offsets(data):
        draw_floor(msp, data, floor, y_offset, index)
        bands.append({"index": index, "name": floor_label(floor, index), "y_offset": y_offset})

    title = data.get("project", {}).get("name")
    if title:
        top_offset = bands[-1]["y_offset"] if bands else 0.0
        min_x, _min_y, _max_x, max_y = plot_bounds(data)
        add_text(msp, title, min_x, max_y + 6, y_offset=top_offset, height=400, layer="ANNOTATION")

    auditor = doc.audit()
    if auditor.errors:
        raise RuntimeError(f"DXF audit found {len(auditor.errors)} error(s): {auditor.errors}")

    doc.saveas(output_path)
    return {"floor_bands": bands}


def main():
    if len(sys.argv) != 3:
        print("Usage:\n  python json_to_dxf.py layout.json output.dxf")
        sys.exit(1)

    json_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])

    if not json_path.exists():
        print(f"ERROR: JSON file not found: {json_path}")
        sys.exit(1)

    try:
        with json_path.open("r", encoding="utf-8") as f:
            data = json.load(f)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        result = generate(data, output_path)

        print("DXF generated successfully!")
        print(f"JSON : {json_path}")
        print(f"DXF  : {output_path}")
        print(f"Floors: {[b['name'] for b in result['floor_bands']]}")

    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
