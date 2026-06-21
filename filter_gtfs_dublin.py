#!/usr/bin/env python3
"""Filter the national TFI GTFS feed down to the Dublin bounding box.

Keeps stops inside the bbox (plus their parent/child station relatives), then
keeps only trips whose stops are *entirely* within the kept set so OTP never
sees a dangling stop reference. Cascades to routes, agencies, shapes, services.

Output: tfi_dublin_gtfs.zip
"""
import sys
import zipfile
from pathlib import Path

import pandas as pd

SRC = Path("GTFS_All")
OUT_DIR = Path("tfi_dublin_gtfs")
OUT_ZIP = Path("tfi_dublin_gtfs.zip")

# Dublin bbox
WEST, SOUTH, EAST, NORTH = -6.55, 53.17, -6.00, 53.65

STOP_TIMES_CHUNK = 1_000_000


def log(msg: str) -> None:
    print(msg, flush=True)


def read_csv(name: str, **kw) -> pd.DataFrame:
    return pd.read_csv(SRC / name, dtype=str, keep_default_na=False, **kw)


def main() -> None:
    OUT_DIR.mkdir(exist_ok=True)

    # 1. Stops inside the bbox -------------------------------------------------
    stops = read_csv("stops.txt")
    log(f"stops total: {len(stops)}")
    lat = pd.to_numeric(stops["stop_lat"], errors="coerce")
    lon = pd.to_numeric(stops["stop_lon"], errors="coerce")
    in_box = (lat >= SOUTH) & (lat <= NORTH) & (lon >= WEST) & (lon <= EAST)
    kept_stop_ids = set(stops.loc[in_box, "stop_id"])
    log(f"stops in bbox: {len(kept_stop_ids)}")

    # Pull in parent stations of kept stops, and children of any kept parent,
    # so station/platform groupings stay intact.
    has_parent = "parent_station" in stops.columns
    if has_parent:
        parent_of = dict(zip(stops["stop_id"], stops["parent_station"]))
        children = {}
        for sid, pid in parent_of.items():
            if pid:
                children.setdefault(pid, []).append(sid)
        changed = True
        while changed:
            before = len(kept_stop_ids)
            add = set()
            for sid in kept_stop_ids:
                pid = parent_of.get(sid, "")
                if pid:
                    add.add(pid)
                add.update(children.get(sid, []))
            kept_stop_ids |= add
            changed = len(kept_stop_ids) != before
        log(f"stops after parent/child closure: {len(kept_stop_ids)}")

    # 2. stop_times: find trips fully inside the kept stop set -----------------
    # A trip is kept only if every one of its stops is in kept_stop_ids.
    trip_total = {}
    trip_inside = {}
    cols = ["trip_id", "stop_id"]
    reader = pd.read_csv(
        SRC / "stop_times.txt",
        dtype=str,
        keep_default_na=False,
        usecols=cols,
        chunksize=STOP_TIMES_CHUNK,
    )
    n_rows = 0
    for chunk in reader:
        n_rows += len(chunk)
        inside = chunk["stop_id"].isin(kept_stop_ids)
        for tid, cnt in chunk["trip_id"].value_counts().items():
            trip_total[tid] = trip_total.get(tid, 0) + int(cnt)
        for tid, cnt in chunk.loc[inside, "trip_id"].value_counts().items():
            trip_inside[tid] = trip_inside.get(tid, 0) + int(cnt)
        log(f"  stop_times scanned: {n_rows}")
    kept_trip_ids = {
        tid for tid, tot in trip_total.items() if trip_inside.get(tid, 0) == tot
    }
    log(f"trips total: {len(trip_total)} | trips fully in bbox: {len(kept_trip_ids)}")

    # 3. Filter trips, cascade to routes / agencies / shapes / services --------
    trips = read_csv("trips.txt")
    trips = trips[trips["trip_id"].isin(kept_trip_ids)].copy()
    kept_route_ids = set(trips["route_id"])
    kept_service_ids = set(trips["service_id"])
    kept_shape_ids = (
        set(trips["shape_id"]) - {""} if "shape_id" in trips.columns else set()
    )
    log(f"trips kept: {len(trips)} | routes: {len(kept_route_ids)} | "
        f"services: {len(kept_service_ids)} | shapes: {len(kept_shape_ids)}")

    routes = read_csv("routes.txt")
    routes = routes[routes["route_id"].isin(kept_route_ids)].copy()
    kept_agency_ids = (
        set(routes["agency_id"]) if "agency_id" in routes.columns else set()
    )

    agency = read_csv("agency.txt")
    if "agency_id" in agency.columns and kept_agency_ids:
        agency = agency[agency["agency_id"].isin(kept_agency_ids)].copy()

    # Reduce stops.txt to only the stops we actually keep.
    stops_out = stops[stops["stop_id"].isin(kept_stop_ids)].copy()

    # calendar / calendar_dates limited to kept services
    calendar = read_csv("calendar.txt")
    calendar = calendar[calendar["service_id"].isin(kept_service_ids)].copy()
    calendar_dates = read_csv("calendar_dates.txt")
    calendar_dates = calendar_dates[
        calendar_dates["service_id"].isin(kept_service_ids)
    ].copy()

    # feed_info passes through unchanged
    feed_info = read_csv("feed_info.txt")

    # Write the simple tables now; stop_times streams separately below.
    outputs = {
        "agency.txt": agency,
        "stops.txt": stops_out,
        "routes.txt": routes,
        "trips.txt": trips,
        "calendar.txt": calendar,
        "calendar_dates.txt": calendar_dates,
        "feed_info.txt": feed_info,
    }
    for name, df in outputs.items():
        df.to_csv(OUT_DIR / name, index=False)
        log(f"wrote {name}: {len(df)} rows")

    # 4. Stream stop_times.txt, keeping only kept trips -----------------------
    st_out = OUT_DIR / "stop_times.txt"
    reader = pd.read_csv(
        SRC / "stop_times.txt",
        dtype=str,
        keep_default_na=False,
        chunksize=STOP_TIMES_CHUNK,
    )
    written = 0
    first = True
    with open(st_out, "w", newline="") as fh:
        for chunk in reader:
            keep = chunk[chunk["trip_id"].isin(kept_trip_ids)]
            keep.to_csv(fh, index=False, header=first)
            first = False
            written += len(keep)
    log(f"wrote stop_times.txt: {written} rows")

    # 5. Stream shapes.txt (383MB), keeping only kept shapes ------------------
    if (SRC / "shapes.txt").exists() and kept_shape_ids:
        sh_out = OUT_DIR / "shapes.txt"
        reader = pd.read_csv(
            SRC / "shapes.txt",
            dtype=str,
            keep_default_na=False,
            chunksize=STOP_TIMES_CHUNK,
        )
        sh_written = 0
        first = True
        with open(sh_out, "w", newline="") as fh:
            for chunk in reader:
                keep = chunk[chunk["shape_id"].isin(kept_shape_ids)]
                keep.to_csv(fh, index=False, header=first)
                first = False
                sh_written += len(keep)
        outputs["shapes.txt"] = None
        log(f"wrote shapes.txt: {sh_written} rows")

    # 6. Zip it up ------------------------------------------------------------
    files = sorted(p for p in OUT_DIR.iterdir() if p.suffix == ".txt")
    with zipfile.ZipFile(OUT_ZIP, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in files:
            zf.write(p, p.name)
    size_mb = OUT_ZIP.stat().st_size / 1e6
    log(f"\nDONE -> {OUT_ZIP} ({size_mb:.1f} MB) containing: "
        f"{[p.name for p in files]}")


if __name__ == "__main__":
    sys.exit(main())
