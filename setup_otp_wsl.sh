#!/usr/bin/env bash
# One-shot OTP setup for WSL (Ubuntu, aarch64).
# Installs a project-local JDK, downloads OTP + data, stages feeds, builds the graph.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"
DATA="$PROJECT_DIR/otp-data"
JDK_DIR="$HOME/.local/jdks"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# --- 0. OS packages ---------------------------------------------------------
log "Installing zip/unzip/curl (apt)"
sudo apt-get update -y >/dev/null
sudo apt-get install -y zip unzip curl python3-pandas >/dev/null

# --- 1. JDK 25 (aarch64 Linux, Temurin) -------------------------------------
if ! ls -d "$JDK_DIR"/jdk-* >/dev/null 2>&1; then
  log "Downloading Temurin JDK 25 (aarch64 Linux)"
  mkdir -p "$JDK_DIR"
  curl -fSL -o /tmp/jdk.tar.gz \
    "https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.3%2B9/OpenJDK25U-jdk_aarch64_linux_hotspot_25.0.3_9.tar.gz"
  tar -xzf /tmp/jdk.tar.gz -C "$JDK_DIR"
  rm -f /tmp/jdk.tar.gz
else
  log "JDK already present under $JDK_DIR"
fi
JAVA_HOME="$(ls -d "$JDK_DIR"/jdk-*/ 2>/dev/null | sort -V | tail -1)"
JAVA="${JAVA_HOME}bin/java"
"$JAVA" -version

# --- 2. OTP 2.9 jar ---------------------------------------------------------
if [ ! -f "$DATA/otp-shaded-2.9.0.jar" ]; then
  log "Downloading OTP 2.9 shaded jar (~120 MB)"
  curl -fSL -o "$DATA/otp-shaded-2.9.0.jar" \
    "https://repo1.maven.org/maven2/org/opentripplanner/otp-shaded/2.9.0/otp-shaded-2.9.0.jar"
else
  log "OTP jar already present"
fi

# --- 3. Dublin OSM extract --------------------------------------------------
if [ ! -f "$DATA/dublin.osm.pbf" ]; then
  log "Downloading Ireland+NI OSM extract from Geofabrik (~400 MB)"
  curl -fSL -o /tmp/ireland.osm.pbf \
    "https://download.geofabrik.de/europe/ireland-and-northern-ireland-latest.osm.pbf"
  # Use as-is; OTP will only graph what the GTFS touches. (Cropping needs osmium.)
  cp /tmp/ireland.osm.pbf "$DATA/dublin.osm.pbf"
  rm -f /tmp/ireland.osm.pbf
else
  log "OSM pbf already present"
fi

# --- 4. National TFI GTFS, filtered to Dublin -------------------------------
if [ ! -f "$DATA/tfi_dublin_gtfs.zip" ]; then
  if [ ! -d "$PROJECT_DIR/GTFS_All" ]; then
    log "Downloading national TFI GTFS (~160 MB)"
    curl -fSL -o /tmp/GTFS_All.zip \
      "https://www.transportforireland.ie/transitData/Data/GTFS_All.zip"
    mkdir -p "$PROJECT_DIR/GTFS_All"
    unzip -o /tmp/GTFS_All.zip -d "$PROJECT_DIR/GTFS_All" >/dev/null
    rm -f /tmp/GTFS_All.zip
  fi
  log "Filtering national GTFS down to Dublin"
  python3 "$PROJECT_DIR/filter_gtfs_dublin.py"
else
  log "Filtered Dublin GTFS already present"
fi
[ -f "$PROJECT_DIR/tfi_dublin_gtfs.zip" ] && cp "$PROJECT_DIR/tfi_dublin_gtfs.zip" "$DATA/"

# --- 5. Microsoft Connector GTFS -------------------------------------------
log "Packaging Microsoft Connector GTFS"
( cd "$PROJECT_DIR/microsoft_connector_gtfs" && zip -j -r "$PROJECT_DIR/ms_connector_gtfs.zip" ./*.txt >/dev/null )
cp "$PROJECT_DIR/ms_connector_gtfs.zip" "$DATA/"

# --- 6. Build the graph -----------------------------------------------------
log "Building OTP graph (this can take several minutes)"
"$JAVA" -Xmx6G -jar "$DATA/otp-shaded-2.9.0.jar" --build --save "$DATA"

log "Done. Start the server with: ./otp.sh serve   (or run serve_otp_wsl.sh)"
