"""Command line: python -m estate_finder <command> ..."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

from . import analytics, arcgis, daily, importers, report
from .db import connect

DEFAULT_DB = os.environ.get("ESTATE_FINDER_DB", "data/estate_finder.db")
DEFAULT_INBOX = os.environ.get("ESTATE_FINDER_INBOX", "data/inbox")
DEFAULT_REPORT = "data/reports/latest.html"

DEMO_DAYS = [
    # (folder, as-of date, reviews to record that day as (surname, parcel, decision, note))
    ("day01", "2026-10-02", []),
    ("day04", "2026-10-05", []),
    ("day06", "2026-10-07", []),
    ("day09", "2026-10-10", [("Kowal", "45-07-29-152-004.000-026", "confirmed",
                              "Last vesting deed 1978 to Walter & Helen; no TOD deed found")]),
    ("day12", "2026-10-13", [("Petrovich", "64-09-21-176-004.000-004", "confirmed",
                              "Assessor and 1972 deed checked"),
                             ("Johnson", "45-12-21-330-015.000-030", "rejected",
                              "Merrillville owner is a different Mary A. Johnson (age 41 per voter roll note)"),
                             ("Garcia", "45-03-31-277-021.000-024", "confirmed",
                              "Case address matches; sole owner since 1991")]),
]


def _parse_map(pairs: list[str] | None) -> dict[str, str]:
    out = {}
    for p in pairs or []:
        k, _, v = p.partition("=")
        out[k.strip()] = v.strip()
    return out


def cmd_import(args, con):
    path = Path(args.file)
    if args.kind == "parcels":
        n = importers.import_parcels(con, path, args.county, args.owner_format, args.force, _parse_map(args.map))
    elif args.kind == "deeds":
        n = importers.import_deeds(con, path, args.county, args.force)
    elif args.kind == "cases":
        n = importers.import_cases(con, path, args.county, args.force)
    else:
        n = importers.import_estate_sales(con, path, args.force)
    print(f"Imported {n} {args.kind} rows from {path.name}" + ("" if n else " (already imported? use --force)"))


def cmd_add_obit(args, con):
    for f in args.files:
        sid = importers.add_obituary(con, Path(f))
        if sid is None:
            print(f"{f}: already added")
            continue
        s = con.execute("SELECT * FROM subjects WHERE id=?", (sid,)).fetchone()
        print(f"Subject #{sid}: {s['full_name']} | age {s['age']} | died {s['death_date']} | city {s['residence_city']} "
              f"| spouse {s['spouse_name'] or '-'} ({s['spouse_status'] or '-'})")


def cmd_daily(args, con):
    summary = daily.run_daily(con, Path(args.inbox) if args.inbox else None, args.as_of, args.county)
    out = report.render(con, Path(args.report))
    print(json.dumps(summary, indent=2))
    print(f"Report: {out}")


def cmd_review(args, con):
    daily.review(con, args.subject_id, args.parcel_number, args.decision, args.note or "")
    print("Saved.")


def cmd_show(args, con):
    s = con.execute("SELECT * FROM subjects WHERE id=?", (args.subject_id,)).fetchone()
    if not s:
        sys.exit("No such subject")
    print(f"#{s['id']} {s['full_name']} ({s['origin']}, {s['status']})")
    print("  funnel: " + " -> ".join(f"{lbl} {n}" for lbl, n in analytics.subject_funnel(con, s["id"])))
    for c in con.execute(
            """SELECT c.*, p.parcel_number, p.situs_address, p.situs_city FROM candidates c
               JOIN parcels p ON p.id=c.parcel_id WHERE subject_id=? AND active=1
               ORDER BY match_score DESC""", (s["id"],)):
        print(f"  {c['parcel_number']}  {c['situs_address']}, {c['situs_city']}  match {c['match_score']} ({c['band']})"
              f"  avail {c['availability']}  [{c['review']}]")
        for f in json.loads(c["factors_json"]):
            print(f"      {f['points']:+4d}  {f['kind'][:5]}  {f['label']}")


def cmd_list(args, con):
    for s in con.execute("SELECT * FROM subjects ORDER BY id"):
        top = con.execute("SELECT MAX(match_score) FROM candidates WHERE subject_id=? AND active=1", (s["id"],)).fetchone()[0]
        print(f"#{s['id']:<4} {s['full_name']:<28} {s['origin']:<12} {s['status']:<9} top match {top if top is not None else '-'}")


def cmd_report(args, con):
    print(f"Report: {report.render(con, Path(args.out))}")


def cmd_stats(args, con):
    print(json.dumps({"kpis": analytics.kpis(con), "funnel": analytics.aggregate_funnel(con),
                      "clue_impact": analytics.clue_impact(con)}, indent=2, default=str))


def cmd_fetch_parcels(args, con):
    n = arcgis.fetch_layer(args.url, Path(args.out), args.where, max_records=args.limit)
    print(f"Wrote {n} records to {args.out}. Import with: python -m estate_finder import parcels {args.out} --county {args.county}")


def cmd_demo(args, _con):
    base = Path(__file__).resolve().parent.parent / "sample_data" / "demo"
    db_path = Path(args.db)
    if db_path.exists():
        db_path.unlink()
    con = connect(db_path)
    for folder, as_of, reviews in DEMO_DAYS:
        summary = daily.run_daily(con, base / folder, as_of)
        for last, parcel, decision, note in reviews:
            sid = con.execute("""SELECT id FROM subjects WHERE full_name LIKE ?
                                 ORDER BY origin='obituary' DESC, id LIMIT 1""", (f"%{last}%",)).fetchone()["id"]
            daily.review(con, sid, parcel, decision, note, at=as_of)
        print(f"{as_of}: {summary['subjects']} subjects, {summary['new_candidates']} new candidates, "
              f"{summary['new_clues']} new clues, {summary['score_changes']} score moves, {summary['transfers']} transfers")
    out = report.render(con, Path(args.report))
    print(f"Demo database: {db_path}\nReport: {out}")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="estate_finder", description="Phase 0 estate-to-parcel matching")
    ap.add_argument("--db", default=DEFAULT_DB, help=f"SQLite file (default {DEFAULT_DB})")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("import", help="Import a CSV of parcels, deeds, cases or estate sales")
    p.add_argument("kind", choices=["parcels", "deeds", "cases", "estate-sales"])
    p.add_argument("file")
    p.add_argument("--county", default="Lake")
    p.add_argument("--owner-format", choices=["last_first", "first_last"], default="last_first")
    p.add_argument("--map", action="append", help="field=CSV column, e.g. owner_raw=OWNER_NAME (repeatable)")
    p.add_argument("--force", action="store_true", help="re-import a file already imported")
    p.set_defaults(fn=cmd_import)

    p = sub.add_parser("add-obit", help="Add obituary text files as subjects")
    p.add_argument("files", nargs="+")
    p.set_defaults(fn=cmd_add_obit)

    p = sub.add_parser("daily", help="Import the inbox, re-check every subject, write the report")
    p.add_argument("--inbox", default=DEFAULT_INBOX)
    p.add_argument("--as-of", help="date to stamp this run with (default: now)")
    p.add_argument("--county", default="Lake", help="county for CSVs whose filename doesn't say")
    p.add_argument("--report", default=DEFAULT_REPORT)
    p.set_defaults(fn=cmd_daily)

    p = sub.add_parser("review", help="Record a verification decision")
    p.add_argument("subject_id", type=int)
    p.add_argument("parcel_number")
    p.add_argument("decision", choices=["confirmed", "rejected", "transferred", "proposed"])
    p.add_argument("--note")
    p.set_defaults(fn=cmd_review)

    p = sub.add_parser("show", help="Show a subject's candidates and every scoring factor")
    p.add_argument("subject_id", type=int)
    p.set_defaults(fn=cmd_show)

    sub.add_parser("list", help="List subjects").set_defaults(fn=cmd_list)

    p = sub.add_parser("report", help="Write the HTML dashboard")
    p.add_argument("--out", default=DEFAULT_REPORT)
    p.set_defaults(fn=cmd_report)

    sub.add_parser("stats", help="Print Phase 0 metrics as JSON").set_defaults(fn=cmd_stats)

    p = sub.add_parser("fetch-parcels", help="Download a public ArcGIS parcel layer to CSV")
    p.add_argument("url", help="FeatureServer/MapServer layer URL ending in /<layer id>")
    p.add_argument("--out", default="data/inbox/parcels/lake_parcels_arcgis.csv")
    p.add_argument("--where", default="1=1")
    p.add_argument("--county", default="Lake")
    p.add_argument("--limit", type=int)
    p.set_defaults(fn=cmd_fetch_parcels)

    p = sub.add_parser("demo", help="Build a demo database from fictional sample data")
    p.add_argument("--report", default="data/reports/demo.html")
    p.set_defaults(fn=cmd_demo)

    args = ap.parse_args(argv)
    if args.cmd == "demo" and args.db == DEFAULT_DB:
        args.db = "data/demo.db"
    con = None if args.cmd == "demo" else connect(args.db)
    args.fn(args, con)


if __name__ == "__main__":
    main()
