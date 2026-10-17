"""SQLite storage. Every imported row keeps its source file and import time."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL UNIQUE,
    rows INTEGER,
    imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parcels (
    id INTEGER PRIMARY KEY,
    county TEXT NOT NULL,
    parcel_number TEXT NOT NULL,
    situs_address TEXT, situs_city TEXT, situs_zip TEXT,
    owner_raw TEXT,
    mailing_address TEXT, mailing_city TEXT, mailing_state TEXT, mailing_zip TEXT,
    property_class TEXT,
    assessed_value REAL,
    last_sale_date TEXT,
    source TEXT, import_id INTEGER, updated_at TEXT,
    UNIQUE (county, parcel_number)
);

CREATE TABLE IF NOT EXISTS parcel_owners (
    parcel_id INTEGER NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    first TEXT, middle TEXT, last TEXT, suffix TEXT,
    is_entity INTEGER DEFAULT 0,
    is_estate INTEGER DEFAULT 0,
    PRIMARY KEY (parcel_id, position)
);
CREATE INDEX IF NOT EXISTS ix_owner_last ON parcel_owners(last);

CREATE TABLE IF NOT EXISTS deeds (
    id INTEGER PRIMARY KEY,
    county TEXT NOT NULL,
    instrument_no TEXT NOT NULL,
    recorded_date TEXT, doc_type TEXT,
    grantor TEXT, grantee TEXT,
    parcel_number TEXT,
    source TEXT, import_id INTEGER, first_seen TEXT,
    UNIQUE (county, instrument_no)
);
CREATE INDEX IF NOT EXISTS ix_deeds_parcel ON deeds(parcel_number);

CREATE TABLE IF NOT EXISTS court_cases (
    id INTEGER PRIMARY KEY,
    county TEXT,
    case_number TEXT NOT NULL UNIQUE,
    case_type TEXT, filed_date TEXT,
    decedent_name TEXT, decedent_address TEXT, decedent_city TEXT,
    personal_rep TEXT,
    source_url TEXT, source TEXT, import_id INTEGER, first_seen TEXT
);

CREATE TABLE IF NOT EXISTS estate_sales (
    id INTEGER PRIMARY KEY,
    address TEXT NOT NULL, city TEXT, zip TEXT,
    start_date TEXT, end_date TEXT,
    company TEXT, description TEXT, url TEXT,
    source TEXT, import_id INTEGER, first_seen TEXT,
    UNIQUE (address, start_date)
);

-- A subject is a deceased person we are trying to tie to property.
-- It starts from an obituary (the "funeral starting point") or from an estate case.
CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY,
    origin TEXT NOT NULL,                  -- obituary | estate_case
    full_name TEXT NOT NULL,
    age INTEGER, birth_date TEXT, death_date TEXT,
    residence_city TEXT,
    spouse_name TEXT, spouse_status TEXT,
    clues_json TEXT,                       -- survivors, funeral home, evidence sentences
    source_url TEXT, source_file TEXT, raw_sha256 TEXT UNIQUE,
    court_case_id INTEGER REFERENCES court_cases(id),
    status TEXT NOT NULL DEFAULT 'watching', -- watching | verified | ruled_out | closed
    created_at TEXT NOT NULL,
    last_checked_at TEXT
);

CREATE TABLE IF NOT EXISTS candidates (
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    parcel_id INTEGER NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
    match_score INTEGER NOT NULL,
    band TEXT NOT NULL,
    availability INTEGER NOT NULL,
    factors_json TEXT NOT NULL,
    review TEXT NOT NULL DEFAULT 'proposed', -- proposed | confirmed | rejected | transferred
    review_note TEXT, reviewed_at TEXT,
    first_seen TEXT NOT NULL, updated_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (subject_id, parcel_id)
);

-- One row each time a candidate's score changes: the progressive record.
CREATE TABLE IF NOT EXISTS score_history (
    id INTEGER PRIMARY KEY,
    subject_id INTEGER NOT NULL, parcel_id INTEGER NOT NULL,
    run_id INTEGER, at TEXT NOT NULL,
    match_score INTEGER, availability INTEGER, band TEXT,
    clue_count INTEGER, factors_json TEXT
);

-- Candidate counts after each clue is applied, per subject per run.
CREATE TABLE IF NOT EXISTS funnel (
    subject_id INTEGER NOT NULL, run_id INTEGER NOT NULL,
    stage INTEGER NOT NULL, label TEXT NOT NULL, remaining INTEGER NOT NULL,
    PRIMARY KEY (subject_id, run_id, stage)
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    run_id INTEGER, at TEXT NOT NULL,
    subject_id INTEGER, parcel_id INTEGER,
    kind TEXT NOT NULL, detail TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL, as_of TEXT NOT NULL,
    started_at TEXT NOT NULL, finished_at TEXT,
    summary_json TEXT
);
"""


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def connect(path: str | Path) -> sqlite3.Connection:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path))
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.executescript(SCHEMA)
    return con
