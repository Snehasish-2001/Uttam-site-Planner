"""
dxf_render.py (uttam-4)

Renders a PDF directly from a DXF file's own entities - unlike pdf_render.py
(which draws from the layout JSON, never reading the DXF back), this module
exists specifically for the MLightCAD editor round-trip: whatever the user
edited in the browser is exported back out as DXF text (AcDbDatabase.dxfOut()
on the JS side - see frontend/mlightcadViewer.js's exportCurrentDxf()) with
no attempt to map those edits back into layout.json's room/door/window
schema. This module just draws whatever DXF entities it's given.

Deliberately simple relative to uttam-2/3's dxf_to_pdf.py: this pipeline's
own DXF never has wall-pair geometry to reconstruct (WALL/WINDOW are already
filled SOLID quads, see json_to_dxf.py's add_filled_rect()) or layer-name
aliasing to worry about, so entities are drawn close to 1:1 by layer color
and DXF type. All floors render onto ONE page (no per-floor split like
pdf_render.py does) - a real simplification, acceptable for "preview what I
just edited," not a replacement for the full multi-page pipeline.

Known gaps: DIMENSION entities (from add_linear_dim()) are skipped - their
graphical representation lives in an anonymous block this simple reader
doesn't resolve; MTEXT is not used by json_to_dxf.py so isn't handled either.

Usage:
    python dxf_render.py input.dxf output.pdf
"""

import io
import math
import sys
from pathlib import Path

import ezdxf
import matplotlib
matplotlib.use("Agg")

import matplotlib.pyplot as plt
from matplotlib.patches import Polygon

MM_TO_FT = 1.0 / 304.8

LAYER_COLOR = {
    "PLOT": "black",
    "SETBACK": "#999999",
    "WALL": "#2b2b2b",
    "DOOR": "#b5651d",
    "WINDOW": "#2266cc",
    "ROOM_TEXT": "black",
    "STAIR": "#7a4fa3",
    "PARKING": "#888888",
    "ANNOTATION": "black",
}

SKIP_TYPES = {"DIMENSION"}


def _ft(x, y):
    return x * MM_TO_FT, y * MM_TO_FT


def _draw_line(ax, e, color):
    x1, y1 = _ft(e.dxf.start.x, e.dxf.start.y)
    x2, y2 = _ft(e.dxf.end.x, e.dxf.end.y)
    ax.plot([x1, x2], [y1, y2], color=color, linewidth=1.1, zorder=3, clip_on=True)
    return [x1, x2], [y1, y2]


def _draw_arc(ax, e, color):
    cx, cy = _ft(e.dxf.center.x, e.dxf.center.y)
    r = e.dxf.radius * MM_TO_FT
    a1, a2 = e.dxf.start_angle, e.dxf.end_angle
    if a2 < a1:
        a2 += 360
    angles = [a1 + i * (a2 - a1) / 24 for i in range(25)]
    xs = [cx + r * math.cos(math.radians(a)) for a in angles]
    ys = [cy + r * math.sin(math.radians(a)) for a in angles]
    ax.plot(xs, ys, color=color, linewidth=0.9, zorder=3, clip_on=True)
    return xs, ys


def _draw_solid(ax, e, color):
    # add_filled_rect() writes vtx0..vtx3 in "Z" order (BL, BR, TL, TR) to
    # avoid a bowtie fill on write - re-order to a plain perimeter walk
    # (BL, BR, TR, TL) for matplotlib's Polygon.
    raw = [e.dxf.vtx0, e.dxf.vtx1, e.dxf.vtx3, e.dxf.vtx2]
    pts = [_ft(p.x, p.y) for p in raw]
    ax.add_patch(Polygon(pts, closed=True, facecolor=color, edgecolor="none", zorder=3))
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return xs, ys


def _draw_text(ax, e, color):
    x, y = _ft(e.dxf.insert.x, e.dxf.insert.y)
    height_ft = (e.dxf.height or 250) * MM_TO_FT
    fontsize = max(6, min(14, height_ft * 6))
    ax.text(x, y, e.dxf.text, color=color, fontsize=fontsize, zorder=4, clip_on=True)
    return [x], [y]


def generate(dxf_source, output_path):
    """dxf_source may be a path (str/Path) or a file-like/str of DXF text."""
    if isinstance(dxf_source, (str, Path)) and Path(str(dxf_source)).suffix.lower() == ".dxf" and Path(str(dxf_source)).exists():
        doc = ezdxf.readfile(str(dxf_source))
    elif isinstance(dxf_source, str):
        doc = ezdxf.read(io.StringIO(dxf_source))
    else:
        doc = ezdxf.read(dxf_source)

    msp = doc.modelspace()

    fig = plt.figure(figsize=(16.53, 11.69))  # A3 landscape
    ax = fig.add_axes([0.04, 0.05, 0.92, 0.88])
    ax.set_aspect("equal")
    ax.axis("off")

    xs_all, ys_all = [], []
    for e in msp:
        t = e.dxftype()
        if t in SKIP_TYPES:
            continue
        layer = e.dxf.layer
        color = LAYER_COLOR.get(layer, "black")

        if t == "LINE":
            xs, ys = _draw_line(ax, e, color)
        elif t == "ARC":
            xs, ys = _draw_arc(ax, e, color)
        elif t == "SOLID":
            xs, ys = _draw_solid(ax, e, color)
        elif t == "TEXT":
            xs, ys = _draw_text(ax, e, color)
        else:
            continue
        xs_all.extend(xs)
        ys_all.extend(ys)

    if xs_all and ys_all:
        margin = 6
        ax.set_xlim(min(xs_all) - margin, max(xs_all) + margin)
        ax.set_ylim(min(ys_all) - margin, max(ys_all) + margin)

    fig.text(0.5, 0.975, "Edited in MLightCAD - rendered from the exported DXF",
              ha="center", fontsize=11, fontweight="bold")
    fig.text(0.5, 0.015, "All floors on one page - not the full per-floor pipeline",
              ha="center", fontsize=7, color="#777777")

    border = plt.Rectangle((0.012, 0.012), 0.976, 0.976, transform=fig.transFigure,
                            fill=False, edgecolor="black", linewidth=1.0)
    fig.patches.append(border)

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path)
    plt.close(fig)
    return {"page_count": 1}


def main():
    if len(sys.argv) != 3:
        print("Usage:\n  python dxf_render.py input.dxf output.pdf")
        sys.exit(1)

    dxf_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])

    if not dxf_path.exists():
        print(f"ERROR: DXF file not found: {dxf_path}")
        sys.exit(1)

    try:
        result = generate(dxf_path, output_path)
        print("PDF generated successfully!")
        print(f"DXF : {dxf_path}")
        print(f"PDF : {output_path}")
        print(f"Pages: {result['page_count']}")
    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
