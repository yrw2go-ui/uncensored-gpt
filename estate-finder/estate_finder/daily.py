"""The daily check: pull in anything new, re-run every open subject, and log
what changed as events (new clues, score moves, transfers)."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from . import importers
from .db import now
from .matching import Matcher, link_cases

INBOX_FOLDERS = ("parcels", "deeds", "cases", "estate_sales", "obituaries")
NEW_CANDIDATE_MIN = 30   # don't announce weak name-only candidates
SCORE_MOVE_MIN = 5


def _county_from_name(path: Path, default: str) -> str:
    name = path.name.lower()
    if "porter" in name:
        return "Porter"
    if "lake" in name:
        return "Lake"
    return default


def _event(con, run_id, at, kind, detail, subject_id=None, parcel_id=None):
    con.execute(
        "INSERT INTO events(run_id, at, subject_id, parcel_id, kind, detail) VALUES (?,?,?,?,?,?)",
        (run_id, at, subject_id, parcel_id, kind, detail))


def import_inbox(con, inbox: Path, run_id: int, at: str, default_county: str = "Lake") -> dict:
    counts = {k: 0 for k in INBOX_FOLDERS}
    if not inbox or not inbox.exists():
        return counts
    for folder in INBOX_FOLDERS:
        d = inbox / folder
        if not d.is_dir():
            continue
        for path in sorted(d.iterdir()):
            if path.name.startswith("."):
                continue
            county = _county_from_name(path, default_county)
            if folder == "obituaries" and path.suffix.lower() in {".txt", ".md"}:
                try:
                    sid = importers.add_obituary(con, path)
                except ValueError as exc:
                    _event(con, run_id, at, "import_error", str(exc))
                    continue
                if sid:
                    s = con.execute("SELECT * FROM subjects WHERE id=?", (sid,)).fetchone()
                    where = f" of {s['residence_city']}" if s["residence_city"] else ""
                    _event(con, run_id, at, "new_subject", f"Obituary added: {s['full_name']}{where}", sid)
                    counts[folder] += 1
            elif path.suffix.lower() == ".csv":
                fn = {
                    "parcels": lambda p: importers.import_parcels(con, p, county),
                    "deeds": lambda p: importers.import_deeds(con, p, county),
                    "cases": lambda p: importers.import_cases(con, p, ""),
                    "estate_sales": lambda p: importers.import_estate_sales(con, p),
                }[folder]
                n = fn(path)
                if n:
                    counts[folder] += n
                    _event(con, run_id, at, "import", f"{n} new {folder.replace('_', ' ')} rows from {path.name}")
    con.commit()
    return counts


def run_daily(con: sqlite3.Connection, inbox: Path | None = None, as_of: str | None = None,
              default_county: str = "Lake") -> dict:
    at = as_of or now()
    run_id = con.execute("INSERT INTO runs(kind, as_of, started_at) VALUES ('daily', ?, ?)",
                         (at, now())).lastrowid
    imported = import_inbox(con, inbox, run_id, at, default_county) if inbox else {}

    for sid, case, created in link_cases(con):
        if created:
            _event(con, run_id, at, "new_subject",
                   f"Estate case {case['case_number']} with no obituary on file: {case['decedent_name']}", sid)
        else:
            _event(con, run_id, at, "new_clue",
                   f"Estate case {case['case_number']} ({case['case_type'] or 'estate'}) filed {case['filed_date'] or ''}".strip(), sid)

    matcher = Matcher(con)
    summary = {"subjects": 0, "new_candidates": 0, "score_changes": 0, "new_clues": 0, "transfers": 0}
    for subj in con.execute("SELECT * FROM subjects WHERE status IN ('watching','verified')").fetchall():
        summary["subjects"] += 1
        res = matcher.evaluate(subj)
        prev = {r["parcel_id"]: r for r in con.execute(
            "SELECT * FROM candidates WHERE subject_id=?", (subj["id"],))}
        seen = set()
        for c in res.candidates:
            pid = c.parcel["id"]
            seen.add(pid)
            fj = c.factors_json()
            old = prev.get(pid)
            addr = c.parcel["situs_address"] or c.parcel["parcel_number"]
            changed = old is None or old["match_score"] != c.match_score or old["availability"] != c.availability \
                or (old["review"] == "proposed" and c.transferred)
            if old is None:
                if c.match_score >= NEW_CANDIDATE_MIN:
                    summary["new_candidates"] += 1
                    _event(con, run_id, at, "new_candidate",
                           f"{addr}: match {c.match_score} ({c.band}), availability {c.availability}", subj["id"], pid)
            else:
                old_labels = {f["label"] for f in json.loads(old["factors_json"])}
                for f in c.factors:
                    if f.label not in old_labels and f.clue in {"record", "ownership", "spouse", "city", "age"} and f.kind != "note":
                        summary["new_clues"] += 1
                        _event(con, run_id, at, "new_clue", f"{addr}: {f.label}", subj["id"], pid)
                if abs(old["match_score"] - c.match_score) >= SCORE_MOVE_MIN or old["band"] != c.band:
                    summary["score_changes"] += 1
                    _event(con, run_id, at, "score_change",
                           f"{addr}: match {old['match_score']} → {c.match_score} ({c.band})", subj["id"], pid)
            review = old["review"] if old else "proposed"
            if c.transferred and review == "proposed":
                review = "transferred"
                summary["transfers"] += 1
                _event(con, run_id, at, "transferred", f"{addr}: title moved after the death; lead closed", subj["id"], pid)
            con.execute(
                """INSERT INTO candidates(subject_id, parcel_id, match_score, band, availability, factors_json,
                       review, first_seen, updated_at, active)
                   VALUES (?,?,?,?,?,?,?,?,?,1)
                   ON CONFLICT(subject_id, parcel_id) DO UPDATE SET
                       match_score=excluded.match_score, band=excluded.band,
                       availability=excluded.availability, factors_json=excluded.factors_json,
                       review=?, updated_at=excluded.updated_at, active=1""",
                (subj["id"], pid, c.match_score, c.band, c.availability, fj, review, at, at, review))
            if changed:
                con.execute(
                    """INSERT INTO score_history(subject_id, parcel_id, run_id, at, match_score, availability,
                           band, clue_count, factors_json) VALUES (?,?,?,?,?,?,?,?,?)""",
                    (subj["id"], pid, run_id, at, c.match_score, c.availability, c.band,
                     len(res.clues_used), fj))
        for pid, old in prev.items():
            if pid not in seen and old["active"]:
                con.execute("UPDATE candidates SET active=0, updated_at=? WHERE subject_id=? AND parcel_id=?",
                            (at, subj["id"], pid))
                _event(con, run_id, at, "dropped", "Candidate no longer matches after new data", subj["id"], pid)
        for stage, (label, remaining) in enumerate(res.funnel):
            con.execute("INSERT OR REPLACE INTO funnel VALUES (?,?,?,?,?)",
                        (subj["id"], run_id, stage, label, remaining))
        con.execute("UPDATE subjects SET last_checked_at=? WHERE id=?", (at, subj["id"]))

    summary["imported"] = imported
    con.execute("UPDATE runs SET finished_at=?, summary_json=? WHERE id=?",
                (now(), json.dumps(summary), run_id))
    con.commit()
    summary["run_id"] = run_id
    return summary


def review(con, subject_id: int, parcel_number: str, decision: str, note: str = "", at: str | None = None) -> None:
    """Record a human verification decision on a candidate parcel."""
    if decision not in {"confirmed", "rejected", "transferred", "proposed"}:
        raise ValueError("decision must be confirmed, rejected, transferred or proposed")
    row = con.execute(
        """SELECT c.parcel_id FROM candidates c JOIN parcels p ON p.id=c.parcel_id
           WHERE c.subject_id=? AND p.parcel_number=?""", (subject_id, parcel_number)).fetchone()
    if not row:
        raise ValueError(f"Parcel {parcel_number} is not a candidate for subject {subject_id}")
    at = at or now()
    con.execute("UPDATE candidates SET review=?, review_note=?, reviewed_at=? WHERE subject_id=? AND parcel_id=?",
                (decision, note, at, subject_id, row["parcel_id"]))
    if decision == "confirmed":
        con.execute("UPDATE subjects SET status='verified' WHERE id=?", (subject_id,))
    _event(con, None, at, "review", f"Reviewer marked parcel {parcel_number} {decision}" + (f": {note}" if note else ""),
           subject_id, row["parcel_id"])
    con.commit()
