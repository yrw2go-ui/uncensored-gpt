"""CSV and text importers. Column names are matched against common aliases
(Regrid exports, county downloads, hand-built spreadsheets)."""

from __future__ import annotations

import csv
import hashlib
import json
import re
import sqlite3
from pathlib import Path

from . import obituary
from .db import now
from .names import norm, parse_any_name, parse_owner

PARCEL_COLUMNS = {
    "parcel_number": ["parcel_number", "parcelnumb", "parcel_id", "parcel", "pin", "state_parcel_id", "parcel_no", "key_no"],
    "county": ["county"],
    "situs_address": ["situs_address", "address", "site_address", "property_address", "location"],
    "situs_city": ["situs_city", "scity", "city", "property_city"],
    "situs_zip": ["situs_zip", "szip", "zip", "property_zip"],
    "owner_raw": ["owner", "owner_name", "owner_raw", "deeded_owner", "owners"],
    "mailing_address": ["mailing_address", "mailadd", "mail_address", "owner_address"],
    "mailing_city": ["mailing_city", "mail_city", "owner_city"],
    "mailing_state": ["mailing_state", "mail_state2", "mail_state", "owner_state"],
    "mailing_zip": ["mailing_zip", "mail_zip", "owner_zip"],
    "property_class": ["property_class", "usedesc", "class", "land_use"],
    "assessed_value": ["assessed_value", "parval", "av_total", "total_av", "assessed"],
    "last_sale_date": ["last_sale_date", "saledate", "sale_date"],
}
DEED_COLUMNS = {
    "instrument_no": ["instrument_no", "instrument", "document_number", "doc_no", "inst_no"],
    "county": ["county"],
    "recorded_date": ["recorded_date", "record_date", "recorded", "date"],
    "doc_type": ["doc_type", "document_type", "type", "kind"],
    "grantor": ["grantor", "grantors", "from"],
    "grantee": ["grantee", "grantees", "to"],
    "parcel_number": ["parcel_number", "parcel", "parcel_id", "pin"],
}
CASE_COLUMNS = {
    "case_number": ["case_number", "case", "case_no", "cause_number"],
    "county": ["county"],
    "case_type": ["case_type", "type"],
    "filed_date": ["filed_date", "filed", "file_date", "date"],
    "decedent_name": ["decedent_name", "decedent", "name", "estate_of"],
    "decedent_address": ["decedent_address", "address", "last_address"],
    "decedent_city": ["decedent_city", "city"],
    "personal_rep": ["personal_rep", "personal_representative", "pr", "executor"],
    "source_url": ["source_url", "url", "link"],
}
SALE_COLUMNS = {
    "address": ["address", "street", "location"],
    "city": ["city"],
    "zip": ["zip", "zipcode"],
    "start_date": ["start_date", "start", "date", "sale_date"],
    "end_date": ["end_date", "end"],
    "company": ["company", "organizer", "host"],
    "description": ["description", "title", "notes"],
    "url": ["url", "link", "source_url"],
}


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _already(con: sqlite3.Connection, digest: str) -> bool:
    return con.execute("SELECT 1 FROM imports WHERE sha256=?", (digest,)).fetchone() is not None


def _record_import(con, kind: str, path: Path, digest: str, rows: int) -> int:
    cur = con.execute(
        "INSERT INTO imports(kind, path, sha256, rows, imported_at) VALUES (?,?,?,?,?)",
        (kind, str(path), digest, rows, now()),
    )
    return cur.lastrowid


def _map_columns(header: list[str], spec: dict[str, list[str]]) -> dict[str, str]:
    lowered = {h.strip().lower().replace(" ", "_"): h for h in header}
    mapping = {}
    for field_name, aliases in spec.items():
        for alias in aliases:
            if alias in lowered:
                mapping[field_name] = lowered[alias]
                break
    return mapping


def _rows(path: Path, spec: dict[str, list[str]], extra: dict[str, str] | None = None):
    if extra:
        spec = {k: ([extra[k].strip().lower().replace(" ", "_")] if k in extra else []) + v for k, v in spec.items()}
    with path.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        mapping = _map_columns(reader.fieldnames or [], spec)
        for raw in reader:
            yield {f: (raw.get(col) or "").strip() for f, col in mapping.items()}


def _date(value: str) -> str | None:
    return obituary.parse_date(value) if value else None


def norm_address(addr: str | None) -> str:
    """Street address key: '1234 W. Example Avenue' -> '1234 W EXAMPLE AVE'."""
    a = norm(addr)
    replacements = {
        "AVENUE": "AVE", "STREET": "ST", "ROAD": "RD", "DRIVE": "DR", "LANE": "LN",
        "COURT": "CT", "PLACE": "PL", "BOULEVARD": "BLVD", "PARKWAY": "PKWY",
        "CIRCLE": "CIR", "TERRACE": "TER", "HIGHWAY": "HWY", "TRAIL": "TRL",
        "NORTH": "N", "SOUTH": "S", "EAST": "E", "WEST": "W",
    }
    tokens = [replacements.get(t, t) for t in a.split()]
    # drop unit designators
    out = []
    for t in tokens:
        if t in {"APT", "UNIT", "#"}:
            break
        out.append(t)
    return " ".join(out)


def import_parcels(con, path: Path, county: str, owner_format: str = "last_first", force=False,
                   column_map: dict[str, str] | None = None) -> int:
    digest = sha256_file(path)
    if _already(con, digest) and not force:
        return 0
    import_id = _record_import(con, "parcels", path, digest, 0)
    count = 0
    for r in _rows(path, PARCEL_COLUMNS, column_map):
        if not r.get("parcel_number"):
            continue
        av = r.get("assessed_value", "").replace(",", "").replace("$", "")
        values = (
            r.get("county") or county, r["parcel_number"], r.get("situs_address"),
            r.get("situs_city"), r.get("situs_zip"), r.get("owner_raw"),
            r.get("mailing_address"), r.get("mailing_city"), r.get("mailing_state"),
            r.get("mailing_zip"), r.get("property_class"),
            float(av) if re.fullmatch(r"\d+(\.\d+)?", av or "") else None,
            _date(r.get("last_sale_date", "")), path.name, import_id, now(),
        )
        con.execute(
            """INSERT INTO parcels(county, parcel_number, situs_address, situs_city, situs_zip,
                   owner_raw, mailing_address, mailing_city, mailing_state, mailing_zip,
                   property_class, assessed_value, last_sale_date, source, import_id, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(county, parcel_number) DO UPDATE SET
                   situs_address=excluded.situs_address, situs_city=excluded.situs_city,
                   situs_zip=excluded.situs_zip, owner_raw=excluded.owner_raw,
                   mailing_address=excluded.mailing_address, mailing_city=excluded.mailing_city,
                   mailing_state=excluded.mailing_state, mailing_zip=excluded.mailing_zip,
                   property_class=excluded.property_class, assessed_value=excluded.assessed_value,
                   last_sale_date=excluded.last_sale_date, source=excluded.source,
                   import_id=excluded.import_id, updated_at=excluded.updated_at""",
            values,
        )
        pid = con.execute("SELECT id FROM parcels WHERE county=? AND parcel_number=?",
                          (values[0], values[1])).fetchone()["id"]
        index_owner(con, pid, r.get("owner_raw", ""), owner_format)
        count += 1
    con.execute("UPDATE imports SET rows=? WHERE id=?", (count, import_id))
    con.commit()
    return count


def index_owner(con, parcel_id: int, owner_raw: str, owner_format: str = "last_first") -> None:
    con.execute("DELETE FROM parcel_owners WHERE parcel_id=?", (parcel_id,))
    parsed = parse_owner(owner_raw or "", owner_format)
    for i, p in enumerate(parsed.persons):
        con.execute(
            "INSERT INTO parcel_owners VALUES (?,?,?,?,?,?,?,?)",
            (parcel_id, i, p.first, p.middle, p.last, p.suffix, int(p.is_entity), int(parsed.is_estate)),
        )


def import_deeds(con, path: Path, county: str, force=False) -> int:
    digest = sha256_file(path)
    if _already(con, digest) and not force:
        return 0
    import_id = _record_import(con, "deeds", path, digest, 0)
    count = 0
    for r in _rows(path, DEED_COLUMNS):
        if not r.get("instrument_no"):
            continue
        cur = con.execute(
            """INSERT OR IGNORE INTO deeds(county, instrument_no, recorded_date, doc_type, grantor,
                   grantee, parcel_number, source, import_id, first_seen)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (r.get("county") or county, r["instrument_no"], _date(r.get("recorded_date", "")),
             r.get("doc_type"), r.get("grantor"), r.get("grantee"), r.get("parcel_number"),
             path.name, import_id, now()),
        )
        count += cur.rowcount
    con.execute("UPDATE imports SET rows=? WHERE id=?", (count, import_id))
    con.commit()
    return count


def import_cases(con, path: Path, county: str = "", force=False) -> int:
    digest = sha256_file(path)
    if _already(con, digest) and not force:
        return 0
    import_id = _record_import(con, "cases", path, digest, 0)
    count = 0
    for r in _rows(path, CASE_COLUMNS):
        if not r.get("case_number"):
            continue
        case_no = r["case_number"].upper()
        inferred_county = {"45": "Lake", "64": "Porter"}.get(case_no[:2], "")
        case_type = r.get("case_type") or (case_no.split("-")[2] if case_no.count("-") >= 3 else "")
        cur = con.execute(
            """INSERT OR IGNORE INTO court_cases(county, case_number, case_type, filed_date,
                   decedent_name, decedent_address, decedent_city, personal_rep, source_url,
                   source, import_id, first_seen)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (r.get("county") or county or inferred_county, case_no, case_type,
             _date(r.get("filed_date", "")), r.get("decedent_name"), r.get("decedent_address"),
             r.get("decedent_city"), r.get("personal_rep"), r.get("source_url"), path.name,
             import_id, now()),
        )
        count += cur.rowcount
    con.execute("UPDATE imports SET rows=? WHERE id=?", (count, import_id))
    con.commit()
    return count


def import_estate_sales(con, path: Path, force=False) -> int:
    digest = sha256_file(path)
    if _already(con, digest) and not force:
        return 0
    import_id = _record_import(con, "estate_sales", path, digest, 0)
    count = 0
    for r in _rows(path, SALE_COLUMNS):
        if not r.get("address"):
            continue
        cur = con.execute(
            """INSERT OR IGNORE INTO estate_sales(address, city, zip, start_date, end_date, company,
                   description, url, source, import_id, first_seen)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (r["address"], r.get("city"), r.get("zip"), _date(r.get("start_date", "")),
             _date(r.get("end_date", "")), r.get("company"), r.get("description"), r.get("url"),
             path.name, import_id, now()),
        )
        count += cur.rowcount
    con.execute("UPDATE imports SET rows=? WHERE id=?", (count, import_id))
    con.commit()
    return count


def add_obituary(con, path: Path) -> int | None:
    """Create a subject from an obituary text file. Returns the subject id,
    or None if this exact text was already added."""
    text = path.read_text(encoding="utf-8")
    digest = hashlib.sha256(text.encode()).hexdigest()
    if con.execute("SELECT 1 FROM subjects WHERE raw_sha256=?", (digest,)).fetchone():
        return None
    clues = obituary.extract(text)
    if not clues.full_name:
        raise ValueError(f"{path.name}: could not find the decedent's name; add 'name:' front matter")
    extra = {
        "survivors": [s.__dict__ for s in clues.survivors],
        "funeral_home": clues.funeral_home,
        "evidence": clues.evidence,
        "published": clues.published,
    }
    cur = con.execute(
        """INSERT INTO subjects(origin, full_name, age, birth_date, death_date, residence_city,
               spouse_name, spouse_status, clues_json, source_url, source_file, raw_sha256, created_at)
           VALUES ('obituary',?,?,?,?,?,?,?,?,?,?,?,?)""",
        (clues.full_name, clues.age, clues.birth_date, clues.death_date, clues.residence_city,
         clues.spouse_name, clues.spouse_status, json.dumps(extra), clues.source_url, path.name,
         digest, now()),
    )
    con.commit()
    return cur.lastrowid


def subject_from_case(con, case_row) -> int:
    """Estate cases with no matching obituary become their own subjects."""
    person = parse_any_name(case_row["decedent_name"] or "")
    cur = con.execute(
        """INSERT INTO subjects(origin, full_name, residence_city, clues_json, source_url,
               court_case_id, created_at)
           VALUES ('estate_case',?,?,?,?,?,?)""",
        (person.display() or case_row["decedent_name"], case_row["decedent_city"] or "",
         json.dumps({"evidence": {"case": case_row["case_number"]}}), case_row["source_url"],
         case_row["id"], now()),
    )
    return cur.lastrowid
