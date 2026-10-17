"""Render the daily dashboard as one self-contained HTML file."""

from __future__ import annotations

import json
import sqlite3
from html import escape
from pathlib import Path

from . import analytics

EVENT_LABELS = {
    "new_subject": ("New subject", "blue"),
    "new_clue": ("New clue", "green"),
    "new_candidate": ("New candidate", "plat"),
    "score_change": ("Score moved", "amber"),
    "transferred": ("Transferred", "red"),
    "dropped": ("Dropped", "muted"),
    "review": ("Review", "blue"),
    "import": ("Import", "muted"),
    "import_error": ("Import error", "red"),
}

CSS = """
:root{--paper:#f7f8f6;--sheet:#fff;--ink:#18231f;--muted:#5a6761;--rule:#d7ddd9;--plat:#1d6b57;--plat-soft:#e3efe9;
--amber:#9a5b00;--amber-soft:#fbf0dc;--red:#a1302b;--red-soft:#f8e4e2;--green:#2c6e2f;--green-soft:#e4f1e2;--blue:#2b5a8a;--blue-soft:#e3ecf6;
--f-body:"Public Sans",system-ui,-apple-system,"Segoe UI",sans-serif;--f-display:"Source Serif 4",Georgia,serif;--f-mono:"JetBrains Mono",ui-monospace,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--paper:#111715;--sheet:#18201d;--ink:#e4ebe7;--muted:#9fb0a8;--rule:#2c3833;--plat:#6cc2a6;--plat-soft:#1d3029;
--amber:#e6a849;--amber-soft:#33281a;--red:#ee8a83;--red-soft:#3a2120;--green:#8ed08f;--green-soft:#1f3220;--blue:#8db8e6;--blue-soft:#1d2a3a;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 var(--f-body)}
.wrap{max-width:1180px;margin:0 auto;padding:28px max(16px,env(safe-area-inset-left,0px)) 64px}
h1{font-family:var(--f-display);font-size:30px;margin:4px 0 6px}h2{font-family:var(--f-display);font-size:21px;margin:34px 0 10px}
.eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--plat);font-weight:700}
.sub{color:var(--muted);margin:0}.privacy{background:var(--amber-soft);border-radius:6px;padding:10px 14px;font-size:13.5px;margin:14px 0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.kpi{background:var(--sheet);border:1px solid var(--rule);border-radius:6px;padding:12px 14px}
.kpi .l{font-size:11.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);font-weight:700}
.kpi .v{font-family:var(--f-mono);font-size:26px;font-weight:600;font-variant-numeric:tabular-nums}
.kpi .t{font-size:12.5px;color:var(--muted)}.kpi.ok{border-left:4px solid var(--green)}.kpi.short{border-left:4px solid var(--amber)}
.bar{height:6px;background:var(--rule);border-radius:3px;overflow:hidden;margin-top:6px}.bar i{display:block;height:100%;background:var(--plat)}
.tbl{overflow-x:auto;background:var(--sheet);border:1px solid var(--rule);border-radius:6px}
table{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:8px 11px;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);background:var(--paper);white-space:nowrap}
tr:last-child td{border-bottom:0}td.n,th.n{text-align:right;white-space:nowrap}.nw{white-space:nowrap}
.pill{display:inline-block;font-size:11.5px;font-weight:700;padding:1px 8px;border-radius:999px;white-space:nowrap}
.blue{background:var(--blue-soft);color:var(--blue)}.green{background:var(--green-soft);color:var(--green)}.plat{background:var(--plat-soft);color:var(--plat)}
.amber{background:var(--amber-soft);color:var(--amber)}.red{background:var(--red-soft);color:var(--red)}.muted{background:var(--paper);color:var(--muted);border:1px solid var(--rule)}
.strong{background:var(--green-soft);color:var(--green)}.probable{background:var(--amber-soft);color:var(--amber)}.possible{background:var(--paper);color:var(--muted);border:1px solid var(--rule)}
.events{list-style:none;padding:0;margin:0;display:grid;gap:6px}
.events li{display:grid;grid-template-columns:118px minmax(0,1fr);gap:10px;align-items:baseline;background:var(--sheet);border:1px solid var(--rule);border-radius:6px;padding:7px 12px;font-size:14px}
.events .who{font-weight:700}
.funnel{display:grid;gap:6px;max-width:760px}.frow{display:grid;grid-template-columns:190px minmax(0,1fr) 120px;gap:10px;align-items:center;font-size:14px}
.fbar{height:20px;background:var(--plat);border-radius:3px;min-width:2px}.frow .num{font-family:var(--f-mono);font-size:13px;color:var(--muted)}
details.subj{background:var(--sheet);border:1px solid var(--rule);border-radius:6px;margin:10px 0}
details.subj summary{cursor:pointer;padding:12px 16px;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:baseline}
details.subj summary:focus-visible{outline:2px solid var(--plat)}
.subj-body{padding:0 16px 16px;display:grid;gap:14px}
.clues{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13.5px;color:var(--muted)}.clues b{color:var(--ink)}
.steps{font-family:var(--f-mono);font-size:13px}.steps span{white-space:nowrap}
.cand{border-top:1px solid var(--rule);padding-top:12px;display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:16px}
@media (max-width:700px){.cand{grid-template-columns:minmax(0,1fr)}.frow{grid-template-columns:120px minmax(0,1fr) 90px}.events li{grid-template-columns:minmax(0,1fr)}}
.cand h4{margin:0 0 4px;font-size:15px}.mono{font-family:var(--f-mono);font-size:12.5px;color:var(--muted)}
.factors{list-style:none;padding:0;margin:6px 0 0;font-size:13.5px;display:grid;gap:3px}
.factors li{display:grid;grid-template-columns:44px minmax(0,1fr);gap:8px}.pts{font-family:var(--f-mono);text-align:right}
.pos{color:var(--green)}.neg{color:var(--red)}.zero{color:var(--muted)}
.spark svg{width:100%;height:auto;display:block}.spark .lg{font-size:12px;color:var(--muted);display:flex;gap:12px}
.lg i{display:inline-block;width:10px;height:3px;vertical-align:middle;margin-right:4px}
footer{margin-top:40px;font-size:12.5px;color:var(--muted)}
"""


def _pct(x):
    return "n/a" if x is None else f"{x * 100:.0f}%"


def _spark(points: list[dict]) -> str:
    if not points:
        return ""
    w, h, pad = 220, 90, 12
    n = len(points)
    xs = [pad + (w - 2 * pad) * (i / (n - 1) if n > 1 else 0.5) for i in range(n)]

    def line(key, color):
        ys = [h - pad - (h - 2 * pad) * (p[key] / 100) for p in points]
        pts = " ".join(f"{x:.1f},{y:.1f}" for x, y in zip(xs, ys))
        dots = "".join(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="2.6" fill="{color}"/>' for x, y in zip(xs, ys))
        return f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="2"/>{dots}'

    grid = "".join(f'<line x1="{pad}" x2="{w - pad}" y1="{h - pad - (h - 2 * pad) * v / 100}" y2="{h - pad - (h - 2 * pad) * v / 100}" stroke="var(--rule)" stroke-width="1"/>'
                   for v in (0, 50, 80, 100))
    first, last = points[0]["at"][:10], points[-1]["at"][:10]
    return (f'<div class="spark"><svg viewBox="0 0 {w} {h}" role="img" aria-label="Score history">{grid}'
            f'{line("availability", "var(--amber)")}{line("match_score", "var(--plat)")}</svg>'
            f'<div class="lg"><span><i style="background:var(--plat)"></i>match</span>'
            f'<span><i style="background:var(--amber)"></i>availability</span><span>{first} → {last}</span></div></div>')


def render(con: sqlite3.Connection, out: Path, max_detail: int = 40) -> Path:
    k = analytics.kpis(con)
    run = analytics.latest_run(con)
    funnel = analytics.aggregate_funnel(con)
    impact = analytics.clue_impact(con)
    run_id = run["id"] if run else -1
    events = con.execute(
        """SELECT e.*, s.full_name FROM events e LEFT JOIN subjects s ON s.id=e.subject_id
           WHERE e.run_id=? OR (e.run_id IS NULL AND e.at >= ?) ORDER BY e.id""",
        (run_id, (run["as_of"] if run else "")[:10])).fetchall()

    def kpi(label, value, target=None, ok=None, frac=None):
        cls = "" if ok is None else (" ok" if ok else " short")
        bar = f'<div class="bar"><i style="width:{max(0, min(100, frac * 100)):.0f}%"></i></div>' if frac is not None else ""
        t = f'<div class="t">{escape(target)}</div>' if target else ""
        return f'<div class="kpi{cls}"><div class="l">{escape(label)}</div><div class="v">{value}</div>{t}{bar}</div>'

    prec = k["precision"]
    tiles = "".join([
        kpi("Subjects watched", k["subjects"], f'{k["from_obituaries"]} from obituaries · {k["from_cases"]} from estate cases'),
        kpi("Verified, last 30 days", k["verified_30d"], f'Phase 0 target: {k["target_verified"]}',
            k["verified_30d"] >= k["target_verified"], k["verified_30d"] / k["target_verified"]),
        kpi("Match precision", _pct(prec), f'{k["confirmed"]} confirmed · {k["rejected"]} rejected · target {_pct(k["target_precision"])}',
            None if prec is None else prec >= k["target_precision"], prec),
        kpi("Resolved to one parcel", _pct(k["resolution_rate"]), f'{k["resolved_single"]} of {k["with_candidates"]} with candidates'),
        kpi("Strong top match", k["strong_top"], "match score 80+"),
        kpi("Hot leads", k["hot_leads"], "match 50+ and availability 60+"),
        kpi("Days to a confirming record", "n/a" if k["median_days_to_record"] is None else f'{k["median_days_to_record"]:.0f}',
            "median, obituary → case, sale or deed"),
        kpi("Closed: title moved", k["transferred"], "transferred after the death"),
    ])

    ev_html = "".join(
        f'<li><span><span class="pill {EVENT_LABELS.get(e["kind"], (e["kind"], "muted"))[1]}">{EVENT_LABELS.get(e["kind"], (e["kind"], ""))[0]}</span></span>'
        f'<span>{"<span class=who>" + escape(e["full_name"]) + "</span> · " if e["full_name"] else ""}{escape(e["detail"])}</span></li>'
        for e in events) or "<li><span></span><span>No changes in this run.</span></li>"

    top = max((f["total"] for f in funnel), default=1) or 1
    funnel_html = "".join(
        f'<div class="frow"><span>{escape(f["label"])}</span><div class="fbar" style="width:{f["total"] / top * 100:.1f}%"></div>'
        f'<span class="num">{f["total"]} · median {f["median"]:g}</span></div>' for f in funnel)
    impact_html = "".join(
        f'<tr><td>{escape(i["clue"])}</td><td class="n {"pos" if i["avg_points"] > 0 else "neg"}">{i["avg_points"]:+g}</td><td class="n">{i["subjects"]}</td></tr>'
        for i in impact)

    subjects = con.execute("SELECT * FROM subjects ORDER BY CASE status WHEN 'verified' THEN 0 WHEN 'watching' THEN 1 ELSE 2 END, id DESC").fetchall()
    rows, details = [], []
    for s in subjects:
        cands = con.execute(
            """SELECT c.*, p.situs_address, p.situs_city, p.parcel_number, p.owner_raw, p.county
               FROM candidates c JOIN parcels p ON p.id=c.parcel_id
               WHERE c.subject_id=? AND c.active=1 ORDER BY c.match_score DESC, c.availability DESC""",
            (s["id"],)).fetchall()
        open_c = [c for c in cands if c["review"] not in ("transferred", "rejected")]
        t = open_c[0] if open_c else (cands[0] if cands else None)
        unlock = analytics.contact_unlock_date(s["death_date"])
        locked = unlock and unlock > k["as_of"]
        top_addr = (escape(t["situs_address"] or t["parcel_number"]) + ", " + escape(t["situs_city"] or "")) if t else "—"
        top_match = f'{t["match_score"]} <span class="pill {t["band"]}">{t["band"]}</span>' if t else "—"
        contact = f'<span class="pill amber">locked to {unlock}</span>' if locked else (unlock or "needs death date")
        spouse = escape(s["spouse_status"] or "listed") if s["spouse_name"] else ""
        rows.append(
            f'<tr><td><b>{escape(s["full_name"])}</b><div class="mono">{escape(s["origin"].replace("_", " "))} · {escape(s["status"])}</div></td>'
            f'<td class="nw">{escape(s["death_date"] or "")}</td><td>{escape(s["residence_city"] or "")}</td>'
            f'<td>{spouse}</td><td class="n">{len(cands)}</td><td>{top_addr}</td>'
            f'<td class="n">{top_match}</td><td class="n">{t["availability"] if t else "—"}</td>'
            f'<td>{contact}</td></tr>')
        if len(details) >= max_detail:
            continue
        clues = json.loads(s["clues_json"] or "{}")
        surv = clues.get("survivors", [])
        from .obituary import Survivor
        away = sum(1 for x in surv if Survivor(**x).is_local is False)
        case = con.execute("SELECT * FROM court_cases WHERE id=?", (s["court_case_id"],)).fetchone() if s["court_case_id"] else None
        clue_bits = [
            f'<span>Age <b>{s["age"]}</b></span>' if s["age"] else "",
            f'<span>Born <b>{s["birth_date"]}</b></span>' if s["birth_date"] else "",
            f'<span>Died <b>{s["death_date"]}</b></span>' if s["death_date"] else "",
            f'<span>City <b>{escape(s["residence_city"])}</b></span>' if s["residence_city"] else "",
            f'<span>Spouse <b>{escape(s["spouse_name"])}</b> ({escape(s["spouse_status"] or "status unknown")})</span>' if s["spouse_name"] else "",
            f'<span>Children listed <b>{len(surv)}</b>, out of area <b>{away}</b></span>' if surv else "",
            f'<span>Funeral home <b>{escape(clues.get("funeral_home"))}</b></span>' if clues.get("funeral_home") else "",
            f'<span>Estate case <b>{escape(case["case_number"])}</b> ({escape(case["case_type"] or "")}, filed {escape(case["filed_date"] or "?")})</span>' if case else "",
            f'<span><a href="{escape(s["source_url"])}">source</a></span>' if s["source_url"] else "",
        ]
        steps = " → ".join(f'<span title="{escape(lbl)}">{escape(lbl)} <b>{n}</b></span>' for lbl, n in analytics.subject_funnel(con, s["id"]))
        cand_html = []
        for c in cands[:3]:
            facs = json.loads(c["factors_json"])
            fl = "".join(
                f'<li><span class="pts {"pos" if f["points"] > 0 else "neg" if f["points"] < 0 else "zero"}">'
                f'{("+" if f["points"] > 0 else "") + str(f["points"]) if f["points"] else ("·" if f["kind"] == "note" else "0")}</span>'
                f'<span>{"<i>availability:</i> " if f["kind"] == "availability" else ""}{escape(f["label"])}</span></li>' for f in facs)
            hist = analytics.progression(con, s["id"], c["parcel_id"])
            review = c["review"]
            rv = {"confirmed": "green", "rejected": "red", "transferred": "red"}.get(review, "muted")
            cand_html.append(
                f'<div class="cand"><div><h4>{escape(c["situs_address"] or "")}, {escape(c["situs_city"] or "")} '
                f'<span class="pill {c["band"]}">{c["match_score"]} {c["band"]}</span> '
                f'<span class="pill amber">avail {c["availability"]}</span> <span class="pill {rv}">{review}</span></h4>'
                f'<div class="mono">{escape(c["county"])} · parcel {escape(c["parcel_number"])} · owner "{escape(c["owner_raw"] or "")}"</div>'
                f'<ul class="factors">{fl}</ul></div>{_spark(hist)}</div>')
        details.append(
            f'<details class="subj"{" open" if len(details) < 4 else ""}><summary><b>{escape(s["full_name"])}</b>'
            f'<span class="pill {"green" if s["status"] == "verified" else "blue"}">{escape(s["status"])}</span>'
            f'<span class="mono">{len(cands)} candidate(s) · checked {escape((s["last_checked_at"] or "")[:10])}</span></summary>'
            f'<div class="subj-body"><div class="clues">{"".join(b for b in clue_bits if b)}</div>'
            f'<div class="steps">{steps}</div>{"".join(cand_html) or "<p>No parcel matches yet.</p>"}</div></details>')

    html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Estate Finder Daily</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;700&family=Source+Serif+4:opsz,wght@8..60,700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>{CSS}</style></head><body><div class="wrap">
<div class="eyebrow">Phase 0 validation · Lake &amp; Porter Counties</div>
<h1>Estate Finder daily check</h1>
<p class="sub">As of {escape(k["as_of"])} · run #{run_id if run else "—"}</p>
<div class="privacy"><b>Contains personal information.</b> Keep this file on your own computer. Do not publish or share it. Scores are evidence of a possible link, not proof of ownership; verify title before any offer. No contact before the unlock date.</div>
<h2>Phase 0 scorecard</h2><div class="kpis">{tiles}</div>
<h2>What changed in this run</h2><ul class="events">{ev_html}</ul>
<h2>How each clue narrows the field</h2>
<p class="sub">Candidate parcels remaining after each clue is applied, summed across all subjects (median per subject).</p>
<div class="funnel" style="margin-top:10px">{funnel_html or "<p>No runs yet.</p>"}</div>
<h2>Which clues do the work</h2><div class="tbl"><table><thead><tr><th>Clue</th><th class="n">Avg points on top match</th><th class="n">Subjects</th></tr></thead><tbody>{impact_html}</tbody></table></div>
<h2>Watch list</h2><div class="tbl"><table><thead><tr><th>Decedent</th><th>Died</th><th>City</th><th>Spouse</th><th>Cands</th><th>Top parcel</th><th>Match</th><th>Avail.</th><th>Contact</th></tr></thead><tbody>{"".join(rows)}</tbody></table></div>
<h2>Subject detail</h2>{"".join(details)}
<footer>Generated by estate-finder. Every score lists the facts behind it; open the source records before acting.</footer>
</div></body></html>"""
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    return out
