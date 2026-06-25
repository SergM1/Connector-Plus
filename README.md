# Connector+

A journey planner for Microsoft Dublin staff that plans routes across **both** the
Microsoft "Connector" shuttle network **and** Dublin public transport (Dublin Bus,
Luas, DART, Irish Rail) in one result list. Installable as a phone home-screen app
(PWA) — no app store.

## The core thesis

Google Maps can't do this. Its transit graph only contains operators that feed Google,
and there's no way to inject the private Microsoft shuttle into it. The whole value of
this product lives in the half of the problem Google structurally can't solve.

The engine that *can* combine both is **OpenTripPlanner (OTP)**: feed it GTFS schedules
plus an OpenStreetMap street network, and it routes across everything as one graph.

## Stack

- **Routing brain:** OpenTripPlanner 2.9 (self-hosted, free, open source). Java app.
- **Front end:** plain HTML/CSS/JS + MapLibre GL (free OpenFreeMap tiles). Ships as a PWA.
- **Geocoding:** Nominatim (free, no key).
- **Hosting:** laptop for dev, Hetzner VPS for the live demo.

## Headline feature

For every search the app queries OTP **twice** — once normally, and once with the
Microsoft Connector agency banned — then compares the best itinerary from each:

> *"Connector saves you 23 min and €2.00 vs public transport."*

The time saving is the real duration difference; the money saving is the Leap fare of
the public-only alternative (the Connector is free to staff). If public transport
actually wins a trip, the app says so honestly instead of forcing a saving.

---

## Repository layout

```
filter_gtfs_dublin.py   # trims the national TFI GTFS down to the Dublin bbox
otp.sh                  # build / serve OTP with a project-local JDK (no Docker)
otp-data/
  build-config.json     # OTP graph build config (timezone, OSM + GTFS feeds)
microsoft_connector_gtfs/   # the MS Connector shuttle feed (internal — repo is private)
web/                    # the PWA front end (map, inputs, results, comparison)
```

Large/binary artifacts are **not** committed (see `.gitignore`). They are downloaded or
regenerated locally per the steps below.

---

## Data setup

Three inputs are needed. Two are large public downloads; the third (the Connector feed)
is in the repo.

### 1. National TFI GTFS  →  `GTFS_All/`

The all-Ireland GTFS feed from the National Transport Authority (CC BY 4.0).

- Download: <https://www.transportforireland.ie/transitData/Data/GTFS_All.zip>
  (mirror / docs: <https://developer.nationaltransport.ie/>)
- Unzip it into a folder named `GTFS_All/` in the project root.

It is ~160 MB zipped and covers all of Ireland; the next step trims it to Dublin.

### 2. Dublin street network  →  `*.osm.pbf`

County Dublin OpenStreetMap extract (street + footpath network).

- Download a Dublin/Leinster `.osm.pbf` from BBBike (<https://extract.bbbike.org/>)
  or Geofabrik (<https://download.geofabrik.de/europe/ireland-and-northern-ireland.html>).
- A bounding box that covers all of County Dublin plus every Connector stop with margin:

  ```
  west=-6.55  south=53.17  east=-6.00  north=53.65
  ```

- Save the file in the project root (any `*.osm.pbf` name works; the build step copies it
  to `otp-data/dublin.osm.pbf`).

---

## Build & run

Prerequisites: Python 3 with `pandas`, and a JDK 25 (OTP 2.9 is compiled for Java 25).
`otp.sh` auto-selects the newest JDK under `~/.local/jdks/`; install one there with no
admin rights, e.g.:

```bash
mkdir -p ~/.local/jdks && cd ~/.local/jdks
curl -fSL -o jdk.tar.gz \
  "https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.3%2B9/OpenJDK25U-jdk_aarch64_mac_hotspot_25.0.3_9.tar.gz"
tar -xzf jdk.tar.gz
```

Then, from the project root:

```bash
# 1. Filter the national feed to Dublin  ->  tfi_dublin_gtfs.zip
python3 filter_gtfs_dublin.py

# 2. Download the OTP 2.9 jar into otp-data/
curl -fSL -o otp-data/otp-shaded-2.9.0.jar \
  "https://repo1.maven.org/maven2/org/opentripplanner/otp-shaded/2.9.0/otp-shaded-2.9.0.jar"

# 3. Stage the feeds + street network into otp-data/
cp tfi_dublin_gtfs.zip otp-data/
(cd microsoft_connector_gtfs && zip -j -r ../ms_connector_gtfs.zip *.txt) && cp ms_connector_gtfs.zip otp-data/
cp *.osm.pbf otp-data/dublin.osm.pbf

# 4. Build the graph, then serve it on :8080
./otp.sh build
./otp.sh serve
```

OTP's API is then at `http://localhost:8080/otp/gtfs/v1` (GraphQL) and a debug UI at `/`.

### Run the front end

```bash
cd web && python3 -m http.server 5500
```

Open <http://localhost:5500/>. The PWA calls the OTP server on `:8080` (OTP sends
permissive CORS headers, so no proxy is needed for local dev).

---

## Parked for later (not MVP)

- **Realtime:** NTA GTFS-Realtime (free key from developer.nationaltransport.ie) makes the
  *public* legs live. The shuttle has no live feed, so those legs stay schedule-only.
- HTTPS + full PWA install polish for the Hetzner deployment.
- Accessibility routing, multi-city.

## Demo narrative

1. "Today you check Google Maps, then separately check the shuttle timetable, then do the
   maths in your head."
2. Show Connector+ doing it in one search.
3. Land the saved-time / saved-money badge.
4. "Google literally cannot show the shuttle. We can."
