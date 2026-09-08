"""
layout_semantics.py (uttam-4)

Validates a floor's ROOM CONNECTIVITY GRAPH against basic architectural
adjacency rules - independent of geometry. A layout can be perfectly
non-overlapping and wall-aligned while still being functionally absurd:
a toilet with two doors acting as a corridor between two other rooms, a
staircase opening straight into a bedroom, a bedroom that's really a
passage to a second bedroom. This is a lint pass, not a layout generator -
it flags bad connectivity, it doesn't invent good connectivity. See
uttam-4/CLAUDE.md's semantics section for why an actual generator (one
that assigns rooms to positions while honoring these rules automatically)
is a separate, much larger project deferred for now.

Room type comes from an optional "type" field on the room dict when
present (one of ROOM_TYPES below), falling back to matching the room's
`name` against NAME_PATTERNS - so existing fixtures with no "type" field
still get classified automatically, and a future author can be explicit
where the name alone would be ambiguous.

Usage:
    python layout_semantics.py layout.json
"""

import json
import sys
from pathlib import Path

from layout_geometry import floor_offsets, floor_label, rooms_touching_opening

ROOM_TYPES = ("wet", "private", "circulation", "vertical_circulation", "service")

NAME_PATTERNS = {
    "wet": ("toilet", "bath", "washroom", "wc"),
    "private": ("bedroom", "bed room"),
    "circulation": ("hallway", "living", "dining", "corridor", "landing", "lobby", "foyer", "family"),
    "vertical_circulation": ("stair",),
    "service": ("kitchen", "utility", "store", "pantry"),
}


def classify_room(room):
    explicit = room.get("type")
    if explicit in ROOM_TYPES:
        return explicit
    name = str(room.get("name", "")).lower()
    for rtype, keywords in NAME_PATTERNS.items():
        if any(keyword in name for keyword in keywords):
            return rtype
    return "unclassified"


def _connections(floor):
    """(interior, exterior, orphans, ambiguous): interior is a list of
    (room_a, room_b, door) for every door touching exactly two rooms;
    exterior is (room, door) for a door touching exactly one (an
    entrance/exit); orphans are doors matching zero rooms (don't line up
    with any room's boundary); ambiguous are doors matching 3+ rooms (a
    coincidental T-junction where more than one room's edge shares the
    door's coordinate) - kept distinct from orphans since "matches nothing"
    and "matches too many to pick two" are different data problems and
    shouldn't share a warning message."""
    interior, exterior, orphans, ambiguous = [], [], [], []
    for door in floor.get("doors", []):
        touching = rooms_touching_opening(floor, door)
        if len(touching) == 2:
            interior.append((touching[0], touching[1], door))
        elif len(touching) == 1:
            exterior.append((touching[0], door))
        elif len(touching) == 0:
            orphans.append(door)
        else:
            ambiguous.append((touching, door))
    return interior, exterior, orphans, ambiguous


def validate_semantics(floor):
    """Returns a list of human-readable warning strings describing
    adjacency-rule violations in this floor's door graph. Never raises -
    collects every issue it can find rather than stopping at the first."""
    rooms = floor.get("rooms", [])
    types = {id(room): classify_room(room) for room in rooms}
    names = {id(room): room.get("name", "?") for room in rooms}

    interior, exterior, orphans, ambiguous = _connections(floor)

    neighbors = {id(room): [] for room in rooms}
    for a, b, door in interior:
        neighbors[id(a)].append(b)
        neighbors[id(b)].append(a)

    exterior_count = {id(room): 0 for room in rooms}
    for room, door in exterior:
        exterior_count[id(room)] += 1

    warnings = []

    for room in rooms:
        rid = id(room)
        rtype = types[rid]
        name = names[rid]
        own_neighbors = neighbors[rid]
        degree = len(own_neighbors)
        # "Reachable at all" counts an exterior opening too (a straight
        # archway from outside, e.g. a dedicated stair entrance, is a
        # perfectly real way into a room) - but "acting as a passage
        # between two other rooms" is only meaningful for INTERIOR
        # connections, so that check stays on `degree` alone.
        any_door_count = degree + exterior_count[rid]

        if rtype == "wet":
            if any_door_count == 0:
                warnings.append(f"'{name}' (wet room) has no door at all - unreachable.")
            elif degree > 1:
                others = ", ".join(f"'{names[id(n)]}'" for n in own_neighbors)
                warnings.append(
                    f"'{name}' (wet room) has {degree} doors, connecting {others} - it "
                    "reads as a passage between them, not a private toilet. A wet room "
                    "should have exactly one door, either into its circulation hub or "
                    "into the single bedroom it's an ensuite for."
                )

        elif rtype == "vertical_circulation":
            if any_door_count == 0:
                warnings.append(f"'{name}' (staircase) has no door at all - unreachable.")
            for n in own_neighbors:
                if types[id(n)] == "private":
                    warnings.append(
                        f"'{name}' (staircase) opens directly into '{names[id(n)]}' (a "
                        "private room) - vertical circulation should land in a "
                        "circulation/public space, not force a walk through someone's "
                        "bedroom."
                    )

        elif rtype == "private":
            for n in own_neighbors:
                if types[id(n)] in ("private", "service"):
                    warnings.append(
                        f"'{name}' (private room) connects directly to '{names[id(n)]}' "
                        f"({types[id(n)]}) - a bedroom should only be reached from "
                        "circulation space (or its own ensuite), never act as a passage "
                        "to another bedroom or a service room."
                    )

    if orphans:
        warnings.append(
            f"{len(orphans)} door(s) don't line up with any room's own boundary within "
            "tolerance - check their x/y against the rooms they're meant to connect."
        )

    for touching, door in ambiguous:
        room_names = ", ".join(f"'{r.get('name', '?')}'" for r in touching)
        warnings.append(
            f"A door at (x={door.get('x')}, y={door.get('y')}) touches {len(touching)} "
            f"rooms at once ({room_names}) - likely straddling a T-junction where more "
            "than one room's wall shares that coordinate. Not counted in any room's "
            "door graph below since it's ambiguous which two it actually connects; "
            "narrow its position/width so it clearly sits on just one wall."
        )

    return warnings


def main():
    if len(sys.argv) != 2:
        print("Usage:\n  python layout_semantics.py layout.json")
        sys.exit(1)

    path = Path(sys.argv[1])
    if not path.exists():
        print(f"ERROR: file not found: {path}")
        sys.exit(1)

    data = json.loads(path.read_text(encoding="utf-8"))

    any_warnings = False
    for floor, _y_offset, index in floor_offsets(data):
        warnings = validate_semantics(floor)
        label = floor_label(floor, index)
        if warnings:
            any_warnings = True
            print(f"=== {label}: {len(warnings)} issue(s) ===")
            for w in warnings:
                print(f"  - {w}")
        else:
            print(f"=== {label}: clean ===")

    sys.exit(1 if any_warnings else 0)


if __name__ == "__main__":
    main()
