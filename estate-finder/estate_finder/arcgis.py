"""Download parcel attributes from a public ArcGIS FeatureServer layer to CSV.

Use only on layers published for public download (for example the Lake County
GIS Hub or IndianaMap parcel services) and keep request volume modest.
Field names differ by layer; the CSV keeps them as-is and the parcel importer
matches them by alias, or you pass --map owner=OWNER_FIELD etc. on import.
"""

from __future__ import annotations

import csv
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

USER_AGENT = "estate-finder/0.1 (parcel research; contact via project owner)"


def _get(url: str, params: dict) -> dict:
    q = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{url}?{q}", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if "error" in data:
        raise RuntimeError(f"ArcGIS error: {data['error']}")
    return data


def fetch_layer(layer_url: str, out: Path, where: str = "1=1", out_fields: str = "*",
                page_size: int = 1000, pause: float = 1.0, max_records: int | None = None) -> int:
    """Page through a layer's /query endpoint and write attributes to CSV."""
    layer_url = layer_url.rstrip("/")
    query_url = layer_url + "/query"
    meta = _get(layer_url, {"f": "json"})
    page_size = min(page_size, int(meta.get("maxRecordCount") or page_size))
    out.parent.mkdir(parents=True, exist_ok=True)
    written, offset, writer, fh = 0, 0, None, None
    try:
        while True:
            data = _get(query_url, {
                "where": where, "outFields": out_fields, "returnGeometry": "false",
                "resultOffset": offset, "resultRecordCount": page_size, "f": "json",
            })
            feats = data.get("features", [])
            if not feats:
                break
            for f in feats:
                attrs = f.get("attributes", {})
                if writer is None:
                    fh = out.open("w", newline="", encoding="utf-8")
                    writer = csv.DictWriter(fh, fieldnames=list(attrs.keys()))
                    writer.writeheader()
                writer.writerow(attrs)
                written += 1
                if max_records and written >= max_records:
                    return written
            if not data.get("exceededTransferLimit") and len(feats) < page_size:
                break
            offset += len(feats)
            time.sleep(pause)
    finally:
        if fh:
            fh.close()
    return written
