import shutil
import tempfile
import unittest
from pathlib import Path

from estate_finder import analytics, daily, obituary
from estate_finder.db import connect
from estate_finder.importers import norm_address
from estate_finder.names import first_name_score, parse_any_name, parse_owner

DEMO = Path(__file__).resolve().parent.parent / "sample_data" / "demo"


class NameTests(unittest.TestCase):
    def test_owner_last_first_with_shared_last_name(self):
        p = parse_owner("KOWAL, WALTER E & HELEN M")
        self.assertEqual([(x.first, x.middle, x.last) for x in p.persons],
                         [("WALTER", "E", "KOWAL"), ("HELEN", "M", "KOWAL")])

    def test_owner_without_comma_and_noise(self):
        p = parse_owner("PETROVICH STANLEY R & DOROTHY J H/W")
        self.assertEqual([(x.first, x.last) for x in p.persons],
                         [("STANLEY", "PETROVICH"), ("DOROTHY", "PETROVICH")])

    def test_suffix_and_entity(self):
        self.assertEqual(parse_owner("KOWAL, WALTER E JR").persons[0].suffix, "JR")
        self.assertTrue(parse_owner("ROSA M GARCIA REVOCABLE TRUST").is_entity)
        self.assertTrue(parse_owner("ESTATE OF SMITH JOHN").is_estate)

    def test_natural_name_with_nickname_and_maiden(self):
        p = parse_any_name('Helen M. (Nowak) Kowal')
        self.assertEqual((p.first, p.middle, p.last, p.maiden), ("HELEN", "M", "KOWAL", "NOWAK"))
        w = parse_any_name('Walter E. "Wally" Kowal')
        self.assertEqual((w.first, w.nickname, w.last), ("WALTER", "WALLY", "KOWAL"))

    def test_first_name_scores(self):
        self.assertEqual(first_name_score("WALTER", "WALTER"), 1.0)
        self.assertEqual(first_name_score("BILL", "WILLIAM"), 0.9)
        self.assertEqual(first_name_score("W", "WALTER"), 0.6)
        self.assertEqual(first_name_score("MARY", "ROBERT"), 0.0)

    def test_address_normalization(self):
        self.assertEqual(norm_address("2841 Testwood Drive, Apt 2"), "2841 TESTWOOD DR")
        self.assertEqual(norm_address("512 West Illustrative Way"), "512 W ILLUSTRATIVE WAY")


class ObituaryTests(unittest.TestCase):
    def test_kowal_clues(self):
        c = obituary.extract((DEMO / "day01/obituaries/kowal.txt").read_text())
        self.assertEqual(c.full_name, 'Walter E. "Wally" Kowal')
        self.assertEqual((c.age, c.residence_city), (84, "Highland"))
        self.assertEqual((c.birth_date, c.death_date), ("1942-05-02", "2026-09-28"))
        self.assertEqual((c.spouse_name, c.spouse_status), ("Helen M. (Nowak) Kowal", "predeceased"))
        self.assertEqual(c.out_of_area_heirs, 1)
        self.assertEqual(c.published, "2026-10-01")

    def test_surviving_spouse(self):
        c = obituary.extract((DEMO / "day01/obituaries/johnson.txt").read_text())
        self.assertEqual((c.spouse_name, c.spouse_status), ("Robert L. Johnson", "surviving"))
        self.assertEqual(c.birth_year, 1947)

    def test_heading_line_not_doubled(self):
        c = obituary.extract((DEMO / "day04/obituaries/petrovich.txt").read_text())
        self.assertEqual(c.full_name, "Stanley R. Petrovich")
        self.assertEqual(c.spouse_status, "predeceased")

    def test_front_matter_overrides(self):
        c = obituary.extract("---\nname: Jane Q. Doe\ncity: Dyer\nspouse_status: predeceased\n---\nShort notice.")
        self.assertEqual((c.full_name, c.residence_city, c.spouse_status), ("Jane Q. Doe", "Dyer", "predeceased"))

    def test_date_range(self):
        c = obituary.extract("John P. Doe, 70, of Gary\nMarch 3, 1956 - October 1, 2026\nHe loved fishing.")
        self.assertEqual((c.birth_date, c.death_date), ("1956-03-03", "2026-10-01"))


class DemoPipelineTests(unittest.TestCase):
    """Runs the fictional two-week demo and checks the progressive story."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.con = connect(cls.tmp / "t.db")
        cls.runs = {}
        for folder, as_of in [("day01", "2026-10-02"), ("day04", "2026-10-05"), ("day06", "2026-10-07"),
                              ("day09", "2026-10-10"), ("day12", "2026-10-13")]:
            cls.runs[folder] = daily.run_daily(cls.con, DEMO / folder, as_of)

    @classmethod
    def tearDownClass(cls):
        cls.con.close()
        shutil.rmtree(cls.tmp)

    def _subject(self, like):
        return self.con.execute("SELECT * FROM subjects WHERE full_name LIKE ? ORDER BY id LIMIT 1",
                                (f"%{like}%",)).fetchone()

    def _cand(self, subject_id, parcel):
        return self.con.execute(
            """SELECT c.* FROM candidates c JOIN parcels p ON p.id=c.parcel_id
               WHERE c.subject_id=? AND p.parcel_number=?""", (subject_id, parcel)).fetchone()

    def test_obituary_only_is_capped_then_rises_with_records(self):
        s = self._subject("Kowal")
        home = self.con.execute("SELECT id FROM parcels WHERE parcel_number='45-07-29-152-004.000-026'").fetchone()["id"]
        hist = analytics.progression(self.con, s["id"], home)
        self.assertEqual(hist[0]["match_score"], 70)          # obituary alone: capped
        self.assertEqual(hist[1]["match_score"], 100)         # estate case lists the address
        self.assertGreater(hist[-1]["availability"], hist[1]["availability"])  # estate sale

    def test_estate_case_links_to_obituary_subject(self):
        s = self._subject("Kowal")
        self.assertIsNotNone(s["court_case_id"])
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM subjects WHERE full_name LIKE '%Kowal%'").fetchone()[0], 1)

    def test_case_without_obituary_becomes_subject(self):
        self.assertEqual(self._subject("Garcia")["origin"], "estate_case")

    def test_son_with_same_name_is_ruled_down(self):
        s = self._subject("Kowal")
        self.assertLess(self._cand(s["id"], "45-16-08-251-007.000-042")["match_score"], 30)

    def test_age_rules_out_early_owner(self):
        s = self._subject("Johnson")
        self.assertLess(self._cand(s["id"], "45-08-14-402-033.000-004")["match_score"], 30)

    def test_surviving_spouse_lowers_availability_then_transfer_closes(self):
        s = self._subject("Johnson")
        c = self._cand(s["id"], "45-08-02-176-010.000-004")
        self.assertEqual(c["review"], "transferred")
        self.assertEqual(c["availability"], 0)

    def test_second_property_linked_by_mailing_address(self):
        s = self._subject("Petrovich")
        self.assertGreaterEqual(self._cand(s["id"], "64-06-17-401-012.000-016")["match_score"], 80)

    def test_trust_is_capped_for_review(self):
        s = self._subject("Garcia")
        self.assertLessEqual(self._cand(s["id"], "45-03-31-281-005.000-024")["match_score"], 50)

    def test_funnel_narrows(self):
        s = self._subject("Kowal")
        f = dict(analytics.subject_funnel(self.con, s["id"]))
        self.assertEqual(f["Name match"], 3)
        self.assertEqual(f["+ city of residence"], 1)

    def test_rerun_without_new_data_is_quiet(self):
        before = self.con.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        summary = daily.run_daily(self.con, DEMO / "day12", "2026-10-14")
        after = self.con.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        self.assertEqual(after, before)
        self.assertEqual(summary["new_clues"] + summary["score_changes"] + summary["new_candidates"], 0)

    def test_kpis(self):
        daily.review(self.con, self._subject("Kowal")["id"], "45-07-29-152-004.000-026", "confirmed", at="2026-10-13")
        daily.review(self.con, self._subject("Johnson")["id"], "45-12-21-330-015.000-030", "rejected", at="2026-10-13")
        k = analytics.kpis(self.con)
        self.assertEqual((k["confirmed"], k["rejected"]), (1, 1))
        self.assertEqual(k["precision"], 0.5)
        self.assertEqual(k["median_days_to_record"], 2.5)  # Kowal 3 days, Petrovich 2


if __name__ == "__main__":
    unittest.main()
