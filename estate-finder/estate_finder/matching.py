"""Tie a deceased person (subject) to parcels, clue by clue.

Every point added or taken away is recorded as a factor with a plain-language
reason, so a reviewer can see exactly why a parcel scored what it did.
Scores are evidence of a possible link, never proof of ownership.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field

from .importers import norm_address
from .names import (Person, first_name_score, last_name_score, middle_agrees, norm,
                    parse_any_name)

OBITUARY_ONLY_CAP = 70
ENTITY_CAP = 50
# Recorded documents that do not move title.
NON_TRANSFER_DOCS = ("MORTGAGE", "LIEN", "RELEASE", "SATISFACTION", "LIS PENDENS", "JUDGMENT",
                     "ASSIGNMENT", "SUBORDINATION", "UCC", "POWER OF ATTORNEY", "EASEMENT")


@dataclass
class Factor:
    kind: str     # match | availability | note
    points: int
    label: str
    clue: str     # name | city | age | spouse | record | rarity | ambiguity | cap | ownership | heirs


@dataclass
class Candidate:
    parcel: sqlite3.Row
    owner: Person | None
    co_owners: list[Person]
    factors: list[Factor] = field(default_factory=list)
    match_score: int = 0
    availability: int = 0
    band: str = "possible"
    transferred: bool = False
    confirmed_by_record: bool = False
    flags: set[str] = field(default_factory=set)

    def add(self, kind, points, label, clue):
        self.factors.append(Factor(kind, points, label, clue))

    @property
    def person_key(self) -> str:
        p = self.parcel
        return norm_address(p["mailing_address"]) or f"parcel:{p['id']}"

    def factors_json(self) -> str:
        return json.dumps([f.__dict__ for f in self.factors])


@dataclass
class SubjectResult:
    subject_id: int
    candidates: list[Candidate]
    funnel: list[tuple[str, int]]
    clues_used: list[str]


def band_for(score: int) -> str:
    return "strong" if score >= 80 else "probable" if score >= 50 else "possible"


def _row_person(r) -> Person:
    return Person(first=r["first"] or "", middle=r["middle"] or "", last=r["last"] or "",
                  suffix=r["suffix"] or "", is_entity=bool(r["is_entity"]))


class Matcher:
    def __init__(self, con: sqlite3.Connection):
        self.con = con
        self._lasts: dict[str, list[str]] = {}
        for (last,) in con.execute("SELECT DISTINCT last FROM parcel_owners WHERE last <> ''"):
            self._lasts.setdefault(last[:1], []).append(last)

    def _similar_lasts(self, last: str, maiden: str = "") -> list[str]:
        out = set()
        for target in filter(None, [last, maiden]):
            for cand in self._lasts.get(target[:1], []):
                if last_name_score(cand, target) >= 0.85:
                    out.add(cand)
        return list(out)

    # ------------------------------------------------------------------ main
    def evaluate(self, subj: sqlite3.Row) -> SubjectResult:
        person = parse_any_name(subj["full_name"])
        clues = json.loads(subj["clues_json"] or "{}")
        spouse = parse_any_name(subj["spouse_name"]) if subj["spouse_name"] else None
        birth_year = _birth_year(subj)
        case = self._case_for(subj)

        clues_used = ["name"]
        if subj["residence_city"]:
            clues_used.append("city")
        if birth_year:
            clues_used.append("age")
        if spouse:
            clues_used.append("spouse")
        if case:
            clues_used.append("estate case")

        candidates = self._name_candidates(person)
        candidates += self._entity_candidates(person, {c.parcel["id"] for c in candidates})

        for c in candidates:
            self._score_name(c, person)
            self._score_city(c, subj["residence_city"])
            self._score_age(c, birth_year)
            self._score_spouse(c, spouse, subj["spouse_status"], person)
            self._score_records(c, person, subj, case)
            self._score_heir_conflict(c, clues, person)
            self._score_availability(c, subj, clues, case)

        self._score_linked_addresses(candidates, case)
        self._score_rarity_and_ambiguity(candidates, person)

        for c in candidates:
            raw = sum(f.points for f in c.factors if f.kind == "match")
            if "entity" in c.flags and raw > ENTITY_CAP:
                c.add("note", 0, f"Held by a trust or company: capped at {ENTITY_CAP} until reviewed", "cap")
                raw = ENTITY_CAP
            if not c.confirmed_by_record and raw > OBITUARY_ONLY_CAP:
                c.add("note", 0, f"Capped at {OBITUARY_ONLY_CAP} until a court case, estate sale or deed confirms it", "cap")
                raw = OBITUARY_ONLY_CAP
            c.match_score = max(0, min(100, raw))
            c.band = band_for(c.match_score)
            avail = max(0, min(100, 20 + sum(f.points for f in c.factors if f.kind == "availability")))
            if c.match_score < 50 and avail:
                # Availability evidence only matters if this is really the decedent's parcel.
                scaled = round(avail * c.match_score / 50)
                c.add("note", 0, f"Availability scaled from {avail} to {scaled} because the match is weak", "cap")
                avail = scaled
            c.availability = 0 if c.transferred else avail

        candidates.sort(key=lambda c: (-c.match_score, -c.availability))
        return SubjectResult(subj["id"], candidates, _funnel(candidates, spouse is not None), clues_used)

    # ------------------------------------------------------------ candidates
    def _name_candidates(self, person: Person) -> list[Candidate]:
        if not person.last:
            return []
        lasts = self._similar_lasts(person.last, person.maiden)
        if not lasts:
            return []
        q = ",".join("?" * len(lasts))
        rows = self.con.execute(
            f"""SELECT po.*, p.id AS pid FROM parcel_owners po JOIN parcels p ON p.id = po.parcel_id
                WHERE po.last IN ({q}) AND po.is_entity = 0""", lasts).fetchall()
        best: dict[int, tuple[float, Person]] = {}
        for r in rows:
            owner = _row_person(r)
            fs = first_name_score(owner.first, person.first, nick_b=person.nickname)
            if fs < 0.6:
                continue
            score = fs + last_name_score(owner.last, person.last)
            if r["pid"] not in best or score > best[r["pid"]][0]:
                best[r["pid"]] = (score, owner)
        out = []
        for pid, (_, owner) in best.items():
            parcel = self.con.execute("SELECT * FROM parcels WHERE id=?", (pid,)).fetchone()
            co = [_row_person(r) for r in self.con.execute(
                "SELECT * FROM parcel_owners WHERE parcel_id=? ORDER BY position", (pid,))]
            co = [p for p in co if (p.first, p.last, p.middle) != (owner.first, owner.last, owner.middle)]
            c = Candidate(parcel, owner, co)
            if self.con.execute("SELECT 1 FROM parcel_owners WHERE parcel_id=? AND is_estate=1", (pid,)).fetchone():
                c.flags.add("owner_is_estate")
            out.append(c)
        return out

    def _entity_candidates(self, person: Person, seen: set[int]) -> list[Candidate]:
        """Trusts or companies whose name contains the decedent's name."""
        if not person.last or not person.first:
            return []
        rows = self.con.execute(
            """SELECT DISTINCT p.* FROM parcels p JOIN parcel_owners po ON po.parcel_id = p.id
               WHERE po.is_entity = 1 AND p.owner_raw LIKE ? AND p.owner_raw LIKE ?""",
            (f"%{person.last}%", f"%{person.first}%")).fetchall()
        out = []
        for p in rows:
            if p["id"] in seen:
                continue
            c = Candidate(p, None, [])
            c.flags.add("entity")
            out.append(c)
        return out

    # --------------------------------------------------------------- factors
    def _score_name(self, c: Candidate, person: Person) -> None:
        if c.owner is None:
            c.add("match", 30, f"Decedent's name appears in owner \"{c.parcel['owner_raw']}\"", "name")
            return
        fs = first_name_score(c.owner.first, person.first, nick_b=person.nickname)
        ls = last_name_score(c.owner.last, person.last)
        if ls < 1 and person.maiden and last_name_score(c.owner.last, person.maiden) == 1:
            c.add("match", 25, f"Owner name matches maiden name {person.maiden.title()}", "name")
        elif fs == 1 and ls == 1:
            c.add("match", 40, f"Owner name {c.owner.display()} matches exactly", "name")
        elif fs >= 0.9:
            c.add("match", 32, f"Owner first name {c.owner.first.title()} is a nickname or variant of {person.first.title()}", "name")
        elif fs >= 0.8:
            c.add("match", 25, f"Owner first name {c.owner.first.title()} is a close spelling of {person.first.title()}", "name")
        else:
            c.add("match", 20, f"Only the first initial matches ({c.owner.first.title()})", "name")
        if 0 < ls < 1:
            c.add("match", -5, f"Last name spelled differently ({c.owner.last.title()})", "name")
        agrees = middle_agrees(c.owner.middle, person.middle)
        if agrees is True:
            c.add("match", 5, "Middle initial matches", "name")
        elif agrees is False:
            c.add("match", -15, f"Middle initial differs ({c.owner.middle[:1]} vs {person.middle[:1]})", "name")
        if c.owner.suffix and person.suffix:
            if c.owner.suffix == person.suffix:
                c.add("match", 5, f"Suffix {person.suffix} matches", "name")
            else:
                c.add("match", -20, f"Suffix differs (owner {c.owner.suffix}, decedent {person.suffix})", "name")
        elif c.owner.suffix or person.suffix:
            c.add("match", -5, "Only one name has a Jr./Sr. suffix", "name")

    def _score_city(self, c: Candidate, city: str | None) -> None:
        if not city:
            return
        p = c.parcel
        if norm(city) == norm(p["situs_city"]):
            c.add("match", 10, f"Decedent lived in {city}, where the parcel is", "city")
        elif norm(city) == norm(p["mailing_city"]):
            c.add("match", 5, f"Owner's mailing address is in {city}", "city")
        else:
            c.flags.add("city_mismatch")
            c.add("match", -10, f"Decedent lived in {city}; parcel is in {(p['situs_city'] or 'another city').title()}", "city")

    def _score_age(self, c: Candidate, birth_year: int | None) -> None:
        if not birth_year:
            return
        acquired = self._acquired_year(c)
        if acquired and acquired < birth_year + 18:
            c.flags.add("age_implausible")
            c.add("match", -30, f"Owner acquired it in {acquired}, before the decedent turned 18; likely a different person", "age")
        elif acquired:
            c.add("match", 2, f"Acquired in {acquired}, consistent with the decedent's age", "age")

    def _acquired_year(self, c: Candidate) -> int | None:
        p = c.parcel
        years = []
        if p["last_sale_date"]:
            years.append(int(p["last_sale_date"][:4]))
        if c.owner:
            for d in self.con.execute(
                    "SELECT recorded_date, grantee FROM deeds WHERE parcel_number=? AND recorded_date IS NOT NULL",
                    (p["parcel_number"],)):
                if c.owner.last and c.owner.last in norm(d["grantee"]):
                    years.append(int(d["recorded_date"][:4]))
        return min(years) if years else None

    def _score_spouse(self, c, spouse: Person | None, status: str, person: Person) -> None:
        if not spouse or c.owner is None:
            return
        for co in c.co_owners:
            first_ok = first_name_score(co.first, spouse.first, nick_b=spouse.nickname) >= 0.9
            last_ok = (not spouse.last or last_name_score(co.last, spouse.last) >= 0.85
                       or last_name_score(co.last, person.last) >= 0.85
                       or (spouse.maiden and co.last == spouse.maiden))
            if first_ok and last_ok:
                c.flags.add("spouse_on_deed")
                when = {"predeceased": " (died before the decedent)", "surviving": " (still living)"}.get(status, "")
                c.add("match", 20, f"Spouse {spouse.display()} is co-owner on the deed{when}", "spouse")
                return
        if any(not co.is_entity for co in c.co_owners):
            c.add("match", -5, "There is a co-owner, but it is not the spouse named in the obituary", "spouse")

    def _score_records(self, c: Candidate, person: Person, subj, case) -> None:
        p = c.parcel
        situs = norm_address(p["situs_address"])
        if "owner_is_estate" in c.flags:
            c.confirmed_by_record = True
            c.add("match", 15, "Assessor already lists the owner as an estate", "record")
        if case:
            if situs and norm_address(case["decedent_address"]) == situs:
                c.confirmed_by_record = True
                c.add("match", 25, f"Estate case {case['case_number']} lists this address", "record")
            elif case["decedent_city"] and norm(case["decedent_city"]) == norm(p["situs_city"]):
                c.add("match", 5, f"Estate case {case['case_number']} gives the same city", "record")
        if situs:
            for s in self.con.execute("SELECT * FROM estate_sales"):
                if norm_address(s["address"]) == situs and (not s["city"] or norm(s["city"]) == norm(p["situs_city"])):
                    c.confirmed_by_record = True
                    c.flags.add("estate_sale")
                    when = s["start_date"] or "date unknown"
                    c.add("match", 15, f"Estate sale listed at this address ({when})", "record")
                    c.add("availability", 25, f"Contents being sold: estate sale {when}", "record")
                    break
        death = subj["death_date"]
        if death:
            for d in self.con.execute(
                    "SELECT * FROM deeds WHERE parcel_number=? AND recorded_date > ? ORDER BY recorded_date",
                    (p["parcel_number"], death)):
                doc = norm(d["doc_type"])
                if any(w in doc for w in NON_TRANSFER_DOCS):
                    pts = 10 if any(w in doc for w in ("LIS PENDENS", "LIEN", "JUDGMENT")) else 0
                    c.add("availability", pts, f"{d['doc_type']} recorded {d['recorded_date']} (instrument {d['instrument_no']})", "record")
                    continue
                grantor = norm(d["grantor"])
                from_estate = person.last in grantor and any(
                    w in grantor.split() for w in ("ESTATE", "EST", "PR", "REP", "REPRESENTATIVE", "EXECUTOR", "EXECUTRIX", "ADMINISTRATOR"))
                if from_estate:
                    c.confirmed_by_record = True
                    c.add("match", 25, f"Deed {d['instrument_no']} ({d['recorded_date']}) is from the estate", "record")
                c.transferred = True
                c.add("availability", 0, f"Transferred after death: {d['doc_type'] or 'deed'} to {d['grantee']} on {d['recorded_date']}", "ownership")
                break

    def _score_heir_conflict(self, c: Candidate, clues: dict, person: Person) -> None:
        """An obituary's survivor list can explain away look-alike owners:
        'son Walter Jr. of Tempe, AZ' vs an owner WALTER E KOWAL JR mailing to Tempe."""
        if c.owner is None:
            return
        p = c.parcel
        for s in clues.get("survivors", []):
            heir = parse_any_name(s.get("name", ""))
            same_first = first_name_score(c.owner.first, heir.first, nick_b=heir.nickname) >= 0.9
            if same_first and c.owner.suffix and c.owner.suffix == heir.suffix:
                c.flags.add("heir_owned")
                c.add("match", -25, f"Obituary names a {s['relation']} {heir.first.title()} {heir.suffix.title()}; this owner is likely the {s['relation']}", "heirs")
                break
            if s.get("city") and p["mailing_city"] and norm(s["city"]) == norm(p["mailing_city"]) \
                    and norm(p["mailing_city"]) != norm(p["situs_city"]):
                c.flags.add("heir_owned")
                c.add("match", -10, f"Tax bills go to {s['city']}, where the {s['relation']} lives", "heirs")
                break

    def _score_linked_addresses(self, cands: list[Candidate], case) -> None:
        """A second parcel whose tax bills go to the decedent's confirmed home
        (a rental, a vacant lot) is very likely theirs too."""
        homes = {norm_address(c.parcel["situs_address"]): c.parcel["situs_address"]
                 for c in cands if c.confirmed_by_record and c.parcel["situs_address"]}
        if case and case["decedent_address"]:
            homes.setdefault(norm_address(case["decedent_address"]), case["decedent_address"])
        for c in cands:
            mail = norm_address(c.parcel["mailing_address"])
            if mail and mail in homes and mail != norm_address(c.parcel["situs_address"]):
                c.confirmed_by_record = True
                c.add("match", 20, f"Tax bills go to the decedent's home at {homes[mail]}", "record")

    def _score_availability(self, c: Candidate, subj, clues: dict, case) -> None:
        if c.owner is None:
            c.add("availability", -5, "Trust or company property usually passes under the trust, not probate; the trustee decides", "ownership")
            return
        people = [co for co in c.co_owners if not co.is_entity]
        status = subj["spouse_status"]
        if not people:
            c.add("availability", 25, "Decedent was the sole owner", "ownership")
        elif "spouse_on_deed" in c.flags and status == "predeceased":
            c.add("availability", 25, "Both owners on the deed have died", "ownership")
        elif "spouse_on_deed" in c.flags and status == "surviving":
            c.add("availability", -30, "Surviving spouse co-owns; title likely passes to the spouse without probate", "ownership")
        else:
            c.add("availability", -10, "Another co-owner may take title", "ownership")
        if case:
            pts = 20 if (case["case_type"] or "").upper() == "EU" else 15
            label = "unsupervised" if pts == 20 else (case["case_type"] or "estate")
            c.add("availability", pts, f"Estate case {case['case_number']} filed ({label})", "record")
        if subj["death_date"] and not c.transferred:
            c.add("availability", 5, "No deed recorded since the death", "ownership")
        heirs = [s for s in clues.get("survivors", [])
                 if s.get("relation") in {"son", "daughter", "child"} and s.get("city")]
        from .obituary import Survivor
        away = [s for s in heirs if Survivor(**s).is_local is False]
        if away:
            c.add("availability", 5, f"{len(away)} of the children live outside Lake/Porter", "heirs")
        p = c.parcel
        if p["mailing_address"] and norm_address(p["mailing_address"]) != norm_address(p["situs_address"]):
            c.add("availability", 5, "Tax bills go to a different mailing address", "ownership")

    def _score_rarity_and_ambiguity(self, cands: list[Candidate], person: Person) -> None:
        people = {}
        for c in cands:
            if c.owner is not None and c.owner.first == person.first and c.owner.last == person.last:
                people.setdefault(c.person_key, []).append(c)
        n = len(people)
        bonus = {1: 11, 2: 6, 3: 2, 4: 2}.get(n, 0)
        for group in people.values():
            for c in group:
                if bonus:
                    who = "the only owner" if n == 1 else f"one of {n} owners"
                    c.add("match", bonus, f"{who} with this exact name in the parcel data", "rarity")
        raw = {id(c): sum(f.points for f in c.factors if f.kind == "match") for c in cands}
        for c in cands:
            rivals = {o.person_key for o in cands
                      if o.person_key != c.person_key and abs(raw[id(o)] - raw[id(c)]) <= 10}
            if rivals:
                pen = -min(30, 10 * len(rivals))
                c.add("match", pen, f"{len(rivals)} other owner(s) score about the same", "ambiguity")

    def _case_for(self, subj):
        if subj["court_case_id"]:
            return self.con.execute("SELECT * FROM court_cases WHERE id=?", (subj["court_case_id"],)).fetchone()
        return None


def _birth_year(subj) -> int | None:
    if subj["birth_date"]:
        return int(subj["birth_date"][:4])
    if subj["age"] and subj["death_date"]:
        return int(subj["death_date"][:4]) - int(subj["age"])
    return None


def _funnel(cands: list[Candidate], spouse_known: bool) -> list[tuple[str, int]]:
    stages = [("Name match", list(cands))]
    cur = [c for c in cands if "city_mismatch" not in c.flags]
    stages.append(("+ city of residence", cur))
    cur = [c for c in cur if "age_implausible" not in c.flags]
    stages.append(("+ age / birth year", cur))
    spouse_hits = [c for c in cur if "spouse_on_deed" in c.flags]
    if spouse_known and spouse_hits:
        cur = spouse_hits
    stages.append(("+ spouse on deed", cur))
    confirmed = [c for c in cur if c.confirmed_by_record]
    if confirmed:
        cur = confirmed
    stages.append(("+ record confirmation", cur))
    stages.append(("Strong (80+)", [c for c in cur if c.match_score >= 80]))
    return [(label, len({c.parcel["id"] for c in group})) for label, group in stages]


def link_cases(con: sqlite3.Connection) -> list[tuple[int, sqlite3.Row, bool]]:
    """Attach unlinked estate cases to subjects with a matching name.
    Returns (subject_id, case_row, created_new_subject)."""
    from .importers import subject_from_case
    out = []
    linked = {r[0] for r in con.execute("SELECT court_case_id FROM subjects WHERE court_case_id IS NOT NULL")}
    for case in con.execute("SELECT * FROM court_cases ORDER BY id").fetchall():
        if case["id"] in linked:
            continue
        cp = parse_any_name(case["decedent_name"] or "")
        best, best_score = None, 0.0
        for s in con.execute("SELECT * FROM subjects WHERE court_case_id IS NULL AND status='watching'"):
            sp = parse_any_name(s["full_name"])
            if last_name_score(sp.last, cp.last) < 1:
                continue
            fs = first_name_score(sp.first, cp.first, nick_a=sp.nickname)
            if fs < 0.9:
                continue
            agrees = middle_agrees(sp.middle, cp.middle)
            if agrees is False:
                continue
            score = fs + (0.2 if agrees else 0)
            if s["death_date"] and case["filed_date"]:
                if case["filed_date"] < s["death_date"]:
                    continue
                score += 0.1
            if s["residence_city"] and case["decedent_city"] and norm(s["residence_city"]) == norm(case["decedent_city"]):
                score += 0.2
            if score > best_score:
                best, best_score = s, score
        if best is not None:
            con.execute("UPDATE subjects SET court_case_id=? WHERE id=?", (case["id"], best["id"]))
            out.append((best["id"], case, False))
        else:
            sid = subject_from_case(con, case)
            out.append((sid, case, True))
    con.commit()
    return out
