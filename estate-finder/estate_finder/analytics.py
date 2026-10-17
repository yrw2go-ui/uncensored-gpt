"""Progressive matching analytics and the Phase 0 exit tests."""

from __future__ import annotations

import json
import sqlite3
from datetime import date, timedelta
from statistics import median

from .importers import norm_address

CONTACT_LOCKOUT_DAYS = 90
TARGET_VERIFIED_PER_MONTH = 25
TARGET_PRECISION = 0.80


def _d(s: str | None) -> date | None:
    return date.fromisoformat(s[:10]) if s else None


def latest_run(con):
    return con.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 1").fetchone()


def aggregate_funnel(con) -> list[dict]:
    """Median and total candidates remaining at each clue stage, using each
    subject's most recent run."""
    rows = con.execute(
        """SELECT f.* FROM funnel f
           JOIN (SELECT subject_id, MAX(run_id) AS run_id FROM funnel GROUP BY subject_id) l
             ON l.subject_id=f.subject_id AND l.run_id=f.run_id
           JOIN subjects s ON s.id=f.subject_id
           ORDER BY f.stage""").fetchall()
    by_stage: dict[int, dict] = {}
    for r in rows:
        st = by_stage.setdefault(r["stage"], {"stage": r["stage"], "label": r["label"], "values": []})
        st["values"].append(r["remaining"])
    out = []
    for st in sorted(by_stage.values(), key=lambda x: x["stage"]):
        v = st.pop("values")
        st.update(subjects=len(v), total=sum(v), median=median(v) if v else 0,
                  resolved=sum(1 for x in v if x == 1))
        out.append(st)
    return out


def subject_funnel(con, subject_id: int) -> list[tuple[str, int]]:
    rows = con.execute(
        """SELECT label, remaining FROM funnel WHERE subject_id=? AND run_id=
           (SELECT MAX(run_id) FROM funnel WHERE subject_id=?) ORDER BY stage""",
        (subject_id, subject_id)).fetchall()
    return [(r["label"], r["remaining"]) for r in rows]


def progression(con, subject_id: int, parcel_id: int) -> list[dict]:
    return [dict(r) for r in con.execute(
        """SELECT at, match_score, availability, band, clue_count, factors_json FROM score_history
           WHERE subject_id=? AND parcel_id=? ORDER BY at, id""", (subject_id, parcel_id))]


def clue_impact(con) -> list[dict]:
    """Average points each clue type contributes to the current top candidate
    of every subject: which clues do the work."""
    totals: dict[str, list[int]] = {}
    for s in con.execute("SELECT id FROM subjects"):
        top = con.execute(
            """SELECT factors_json FROM candidates WHERE subject_id=? AND active=1
               ORDER BY match_score DESC, availability DESC LIMIT 1""", (s["id"],)).fetchone()
        if not top:
            continue
        per = {}
        for f in json.loads(top["factors_json"]):
            if f["kind"] == "match":
                per[f["clue"]] = per.get(f["clue"], 0) + f["points"]
        for clue, pts in per.items():
            totals.setdefault(clue, []).append(pts)
    return sorted(({"clue": k, "subjects": len(v), "avg_points": round(sum(v) / len(v), 1)}
                   for k, v in totals.items()), key=lambda x: -abs(x["avg_points"]))


def kpis(con, as_of: str | None = None) -> dict:
    run = latest_run(con)
    as_of_d = _d(as_of) or (_d(run["as_of"]) if run else None) or date.today()
    month_ago = (as_of_d - timedelta(days=30)).isoformat()

    reviewed = con.execute(
        "SELECT review, band, reviewed_at FROM candidates WHERE review IN ('confirmed','rejected')").fetchall()
    confirmed = [r for r in reviewed if r["review"] == "confirmed"]
    rejected = [r for r in reviewed if r["review"] == "rejected"]
    precision = len(confirmed) / len(reviewed) if reviewed else None
    verified_30d = sum(1 for r in confirmed if (r["reviewed_at"] or "") >= month_ago)

    subjects = con.execute("SELECT * FROM subjects").fetchall()
    tops = []
    for s in subjects:
        cs = con.execute(
            """SELECT c.*, p.situs_address, p.mailing_address FROM candidates c JOIN parcels p ON p.id=c.parcel_id
               WHERE c.subject_id=? AND c.active=1 AND c.review NOT IN ('transferred','rejected')
               ORDER BY c.match_score DESC, c.availability DESC""", (s["id"],)).fetchall()
        tops.append((s, cs))
    with_cands = [t for t in tops if t[1]]
    resolved = [t for t in with_cands if _resolved(t[1])]
    strong = sum(1 for _, cs in with_cands if cs[0]["match_score"] >= 80)
    hot = sum(1 for _, cs in with_cands if cs[0]["match_score"] >= 50 and cs[0]["availability"] >= 60)

    # Days from a subject's first appearance to its first confirming record.
    lags = []
    for s in subjects:
        if s["origin"] != "obituary":
            continue
        ev = con.execute(
            """SELECT MIN(at) AS at FROM events WHERE subject_id=? AND kind='new_clue'
               AND (detail LIKE 'Estate case%' OR detail LIKE '%Estate sale%' OR detail LIKE '%from the estate%')""",
            (s["id"],)).fetchone()
        first = con.execute("SELECT MIN(at) AS at FROM events WHERE subject_id=? AND kind='new_subject'",
                            (s["id"],)).fetchone()
        if ev["at"] and first["at"]:
            lags.append((_d(ev["at"]) - _d(first["at"])).days)

    transferred = con.execute("SELECT COUNT(*) FROM candidates WHERE review='transferred'").fetchone()[0]
    return {
        "as_of": as_of_d.isoformat(),
        "subjects": len(subjects),
        "from_obituaries": sum(1 for s in subjects if s["origin"] == "obituary"),
        "from_cases": sum(1 for s in subjects if s["origin"] == "estate_case"),
        "with_candidates": len(with_cands),
        "strong_top": strong,
        "resolved_single": len(resolved),
        "resolution_rate": len(resolved) / len(with_cands) if with_cands else None,
        "hot_leads": hot,
        "verified_30d": verified_30d,
        "confirmed": len(confirmed),
        "rejected": len(rejected),
        "precision": precision,
        "median_days_to_record": median(lags) if lags else None,
        "transferred": transferred,
        "target_verified": TARGET_VERIFIED_PER_MONTH,
        "target_precision": TARGET_PRECISION,
    }


def _resolved(cands) -> bool:
    """Top match is strong and every other plausible parcel belongs to the same
    person (same tax-bill mailing address, or mailed to the top parcel)."""
    if not cands or cands[0]["match_score"] < 80:
        return False
    top = cands[0]
    home = {norm_address(top["situs_address"]), norm_address(top["mailing_address"])} - {""}
    return all(norm_address(c["mailing_address"]) in home for c in cands[1:] if c["match_score"] >= 50)


def contact_unlock_date(death_date: str | None) -> str | None:
    d = _d(death_date)
    return (d + timedelta(days=CONTACT_LOCKOUT_DAYS)).isoformat() if d else None
