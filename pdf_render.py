"""
pdf_render.py (uttam-4)

Simple PDF renderer for uttam-4's layout JSON - one page per floor, drawn
directly from the JSON (not by re-parsing the DXF back, unlike uttam-2/3's
dxf_to_pdf.py, which has to reconstruct wall polygons from raw DXF lines
because nothing else reads rich_planner's DXF geometry directly). Walls
here are solid-filled bands of real thickness with cut door/window
openings, derived by layout_geometry.build_wall_bands() - the exact same
function json_to_dxf.py calls, so this file draws the identical wall
geometry without re-deriving or reconstructing anything from the DXF.

Usage:
    python pdf_render.py layout.json output.pdf
"""

import json
import sys
import textwrap
from pathlib import Path

import matplotlib
matplotlib.use("Agg")  # headless - safe to call from a background thread

import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.patches import Rectangle, Polygon as MplPolygon

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

PAGE_SIZE_IN = (16.53, 11.69)  # A3 landscape
MARGIN_FT = 6.0
WALL_COLOR = "#2b2b2b"
FOOTPRINT_COLOR = "#b5651d"


def plot_bounds(data):
    """(min_x, min_y, max_x, max_y) of the plot - from site.plot.vertices for a polygon
    site (uttam-5), else the legacy [0,width]x[0,depth] rectangle. Mirrors
    json_to_dxf.plot_bounds() so both renderers agree on where the drawing's margins/
    dimensions/north-arrow default sit."""
    site = data.get("site", {})
    plot_vertices = (site.get("plot") or {}).get("vertices")
    if plot_vertices:
        xs = [v["x"] for v in plot_vertices]
        ys = [v["y"] for v in plot_vertices]
        return min(xs), min(ys), max(xs), max(ys)
    plot = get_plot(site)
    return 0.0, 0.0, plot["width"], plot["depth"]


def _draw_site_and_footprint(ax, data):
    """Draws the plot/buildable boundary (polygon if site.plot.vertices is present, else
    the legacy rectangle) and, if present, the building footprint boundary. Mirrors
    json_to_dxf.draw_site_and_footprint()."""
    site = data.get("site", {})
    plot_vertices = (site.get("plot") or {}).get("vertices")

    if plot_vertices:
        pts = [(v["x"], v["y"]) for v in plot_vertices]
        ax.add_patch(MplPolygon(pts, closed=True, fill=False, edgecolor="black",
                                 linewidth=1.6, zorder=2))
        for v in plot_vertices:
            label = v.get("label")
            if label:
                ax.text(v["x"], v["y"], label, fontsize=9, fontweight="bold",
                        ha="center", va="center", color="#444444", zorder=4, clip_on=True)

        buildable_vertices = (site.get("buildable") or {}).get("vertices")
        if buildable_vertices:
            bpts = [(v["x"], v["y"]) for v in buildable_vertices]
            ax.add_patch(MplPolygon(bpts, closed=True, fill=False, edgecolor="#999999",
                                     linewidth=1.0, linestyle=(0, (5, 3)), zorder=2))
    else:
        plot = get_plot(site)
        plot_w, plot_h = plot["width"], plot["depth"]
        ax.add_patch(Rectangle((0, 0), plot_w, plot_h, fill=False, edgecolor="black",
                                linewidth=1.6, zorder=2))
        bx, by, bw, bh = buildable_rect(site)
        ax.add_patch(Rectangle((bx, by), bw, bh, fill=False, edgecolor="#999999",
                                linewidth=1.0, linestyle=(0, (5, 3)), zorder=2))

    footprint_vertices = (data.get("footprint") or {}).get("vertices")
    if footprint_vertices:
        fpts = [(v["x"], v["y"]) for v in footprint_vertices]
        ax.add_patch(MplPolygon(fpts, closed=True, fill=False, edgecolor=FOOTPRINT_COLOR,
                                 linewidth=1.2, linestyle=(0, (1, 1)), zorder=2))


def _draw_walls(ax, floor, wall_thickness):
    for orient, coord_a, coord_b, segments in build_wall_bands(floor, wall_thickness):
        for start, end in segments:
            if coord_a == coord_b:
                # Degenerate (zero-gap) band - nothing to fill, draw a single line.
                if orient == "H":
                    ax.plot([start, end], [coord_a, coord_a], color=WALL_COLOR, linewidth=1.3, zorder=3, clip_on=True)
                else:
                    ax.plot([coord_a, coord_a], [start, end], color=WALL_COLOR, linewidth=1.3, zorder=3, clip_on=True)
            elif orient == "H":
                y0, y1 = sorted((coord_a, coord_b))
                ax.add_patch(Rectangle((start, y0), end - start, y1 - y0,
                                        facecolor=WALL_COLOR, edgecolor="none", zorder=3))
            else:
                x0, x1 = sorted((coord_a, coord_b))
                ax.add_patch(Rectangle((x0, start), x1 - x0, end - start,
                                        facecolor=WALL_COLOR, edgecolor="none", zorder=3))


def _draw_room(ax, room):
    x, y = float(room["x"]), float(room["y"])
    w, h = float(room["width"]), float(room["height"])
    cx, cy = x + w / 2, y + h / 2
    ax.text(cx, cy, str(room["name"]), ha="center", va="center", fontsize=8, zorder=4, clip_on=True)
    if room.get("show_size", True):
        ax.text(
            cx, cy - min(h * 0.18, 1.2), f'{room["width"]}\' x {room["height"]}\'',
            ha="center", va="center", fontsize=6, color="#444444", zorder=4, clip_on=True,
        )


def _draw_door(ax, door, wall_thickness):
    # "archway" is a plain wall opening - no jamb marks at all. The wall
    # itself is still cut at this position (layout_geometry.build_wall_bands()
    # doesn't care about "style", it treats every entry in doors[] as an
    # opening to cut regardless) - this only skips the visual door symbol.
    if door.get("style") == "archway":
        return

    x, y = float(door["x"]), float(door["y"])
    width = float(door.get("width", 3))
    orientation = door.get("orientation", "horizontal")
    depth = wall_thickness / 2

    # Plain jamb marks, no leaf/swing arc - a short tick perpendicular to
    # the wall at each end of the opening ("-|      |-"), leaving the gap
    # itself untouched (the wall cut already shows the opening; this just
    # marks it as a door rather than a plain archway).
    if orientation == "horizontal":
        ax.plot([x, x], [y - depth, y + depth], color="#b5651d", linewidth=1.4, zorder=3, clip_on=True)
        ax.plot([x + width, x + width], [y - depth, y + depth], color="#b5651d", linewidth=1.4, zorder=3, clip_on=True)
    else:
        ax.plot([x - depth, x + depth], [y, y], color="#b5651d", linewidth=1.4, zorder=3, clip_on=True)
        ax.plot([x - depth, x + depth], [y + width, y + width], color="#b5651d", linewidth=1.4, zorder=3, clip_on=True)


def _draw_window(ax, window, wall_thickness):
    x, y = float(window["x"]), float(window["y"])
    width = float(window.get("width", 4))
    orientation = window.get("orientation", "horizontal")
    depth = wall_thickness  # fills the wall's own thickness, not a fixed gap

    if orientation == "horizontal":
        ax.add_patch(Rectangle((x, y - depth / 2), width, depth,
                                facecolor="#2266cc", edgecolor="none", zorder=4, clip_on=True))
    else:
        ax.add_patch(Rectangle((x - depth / 2, y), depth, width,
                                facecolor="#2266cc", edgecolor="none", zorder=4, clip_on=True))


def _draw_stair(ax, stair, wall_thickness):
    x, y = float(stair["x"]), float(stair["y"])
    w, h = float(stair["width"]), float(stair["height"])

    ax.add_patch(Rectangle((x, y), w, h, fill=False, edgecolor="#7a4fa3", linewidth=1.2, zorder=3))

    layout = stair_layout(stair, wall_thickness)

    if layout["style"] == "switchback":
        for fx0, fx1, fy0, fy1, fsteps in (layout["flight_a"], layout["flight_b"]):
            tread_h = (fy1 - fy0) / fsteps
            for i in range(1, fsteps):
                yy = fy0 + i * tread_h
                ax.plot([fx0, fx1], [yy, yy], color="#7a4fa3", linewidth=0.6, zorder=3, clip_on=True)

        # Divider between the two flights, and the landing's own outline -
        # both thin reference lines (not a filled wall) so they read as
        # part of the stair diagram itself, matching the tread-line style.
        dx, dy0, dy1 = layout["divider"]
        ax.plot([dx, dx], [dy0, dy1], color="#7a4fa3", linewidth=1.0, zorder=3, clip_on=True)
        ax.add_patch(Rectangle((x, dy1), w, (y + h) - dy1, fill=False,
                                edgecolor="#7a4fa3", linewidth=1.0, zorder=3))

        # "UP" sits a little way up flight A, offset off the travel-line's
        # own x so rotated text doesn't render as an illegible smudge on
        # top of the line sharing its axis (a real bug hit and fixed for
        # the straight-run style earlier - same fix, generalised).
        ax0, ax1, ay0, _ay1, _asteps = layout["flight_a"]
        up_x = ax0 + (ax1 - ax0) * 0.75
        up_y = ay0 + (layout["divider"][2] - ay0) * 0.15
    else:
        for ty in layout["tread_ys"]:
            ax.plot([x, x + w], [ty, ty], color="#7a4fa3", linewidth=0.6, zorder=3, clip_on=True)
        up_x, up_y = x + w * 0.75, y + h * 0.15

    # Up/down travel line - straight run only. For a switchback, the
    # divider already drawn above serves as the one center line; also
    # drawing the up-across-down travel path would add two more near-
    # parallel vertical lines (one through each flight's own center)
    # right alongside it, cluttering the box with three lines doing
    # almost the same job instead of one.
    if layout["style"] == "straight":
        path = layout["path"]
        for p1, p2 in zip(path, path[1:]):
            ax.plot([p1[0], p2[0]], [p1[1], p2[1]], color="#7a4fa3", linewidth=1.0, zorder=3, clip_on=True)

    # Wall capping the top of the flight (where it meets the floor above) -
    # drawn explicitly here rather than relying on whatever build_wall_bands()
    # resolves the Staircase room's own top edge to (thin if it happens to
    # share a zero-gap boundary with a neighbor, which reads as "no wall"
    # right where a real flight ends).
    ax.add_patch(Rectangle((x, y + h - wall_thickness / 2), w, wall_thickness,
                            facecolor=WALL_COLOR, edgecolor="none", zorder=3))

    ax.text(up_x, up_y, "UP", ha="center", va="bottom", fontsize=7,
             color="#7a4fa3", rotation=90, zorder=4, clip_on=True)


def _draw_parking(ax, parking):
    x, y = float(parking["x"]), float(parking["y"])
    w, h = float(parking["width"]), float(parking["height"])
    ax.add_patch(Rectangle((x, y), w, h, fill=False, edgecolor="#888888",
                            linewidth=1.0, linestyle=(0, (4, 2)), zorder=3))
    ax.text(x + w / 2, y + h / 2, parking.get("name", "PARKING"), ha="center", va="center",
            fontsize=6.5, color="#888888", zorder=4, clip_on=True)


def _draw_dimension(ax, p1, p2, offset, label, vertical=False):
    if vertical:
        ax.annotate("", xy=(offset, p2[1]), xytext=(offset, p1[1]),
                    arrowprops=dict(arrowstyle="<->", color="black", linewidth=0.8), clip_on=False)
        ax.text(offset - 0.6, (p1[1] + p2[1]) / 2, label, ha="right", va="center",
                fontsize=7, rotation=90, clip_on=False)
    else:
        ax.annotate("", xy=(p2[0], offset), xytext=(p1[0], offset),
                    arrowprops=dict(arrowstyle="<->", color="black", linewidth=0.8), clip_on=False)
        ax.text((p1[0] + p2[0]) / 2, offset - 0.6, label, ha="center", va="top",
                fontsize=7, clip_on=False)


def _draw_north_arrow(ax, x, y):
    ax.annotate("", xy=(x, y + 3), xytext=(x, y - 1),
                arrowprops=dict(arrowstyle="-|>", color="black", linewidth=1.2), clip_on=False)
    ax.text(x, y + 3.4, "N", ha="center", va="bottom", fontsize=9, fontweight="bold", clip_on=False)


def _render_floor_page(pdf, data, floor, index, total_floors):
    site = data.get("site", {})
    min_x, min_y, max_x, max_y = plot_bounds(data)
    plot_w, plot_h = max_x - min_x, max_y - min_y

    fig = plt.figure(figsize=PAGE_SIZE_IN)
    ax = fig.add_axes([0.04, 0.04, 0.92, 0.86])
    ax.set_aspect("equal")
    ax.axis("off")

    ax.set_xlim(min_x - MARGIN_FT, max_x + MARGIN_FT)
    ax.set_ylim(min_y - MARGIN_FT, max_y + MARGIN_FT * 0.7)

    _draw_site_and_footprint(ax, data)

    wall_thickness = get_wall_thickness(site)
    _draw_walls(ax, floor, wall_thickness)
    for room in floor.get("rooms", []):
        _draw_room(ax, room)
    for door in floor.get("doors", []):
        _draw_door(ax, door, wall_thickness)
    for window in floor.get("windows", []):
        _draw_window(ax, window, wall_thickness)
    for stair in floor.get("stairs", []):
        _draw_stair(ax, stair, wall_thickness)
    for parking in floor.get("parking", []):
        _draw_parking(ax, parking)

    if data.get("annotations", {}).get("overall_dimensions", True):
        _draw_dimension(ax, (min_x, min_y), (max_x, min_y), min_y - 2.2, f"{plot_w:g}'-0\"")
        _draw_dimension(ax, (min_x, min_y), (min_x, max_y), min_x - 2.2, f"{plot_h:g}'-0\"", vertical=True)

    north = data.get("north_arrow")
    if north:
        _draw_north_arrow(ax, float(north.get("x", max_x + 3)), float(north.get("y", max_y - 5)))

    project_name = data.get("project", {}).get("name", "Untitled Project")
    fig.text(0.5, 0.965, project_name, ha="center", fontsize=15, fontweight="bold")
    fig.text(0.5, 0.935, floor_label(floor, index), ha="center", fontsize=11, color="#333333")
    fig.text(0.5, 0.015, f"Page {index + 1} of {total_floors} - Not to scale - uttam-4 simple pipeline",
              ha="center", fontsize=7, color="#777777")

    border = plt.Rectangle((0.012, 0.012), 0.976, 0.976, transform=fig.transFigure,
                            fill=False, edgecolor="black", linewidth=1.0)
    fig.patches.append(border)

    pdf.savefig(fig)
    plt.close(fig)


def generate(data, output_path):
    if not isinstance(data, dict):
        raise LayoutError(f"Layout JSON must be an object, got: {type(data).__name__}")

    bands = floor_offsets(data)  # validates every floor as a side effect
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with PdfPages(str(output_path)) as pdf:
        for floor, _y_offset, index in bands:
            _render_floor_page(pdf, data, floor, index, len(bands))

    return {"page_count": len(bands)}


def main():
    if len(sys.argv) != 3:
        print("Usage:\n  python pdf_render.py layout.json output.pdf")
        sys.exit(1)

    json_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])

    if not json_path.exists():
        print(f"ERROR: JSON file not found: {json_path}")
        sys.exit(1)

    try:
        with json_path.open("r", encoding="utf-8") as f:
            data = json.load(f)

        result = generate(data, output_path)
        print("PDF generated successfully!")
        print(f"JSON : {json_path}")
        print(f"PDF  : {output_path}")
        print(f"Pages: {result['page_count']}")

    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
