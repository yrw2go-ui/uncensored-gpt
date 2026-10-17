"""Pull matching clues out of obituary text.

Extraction is rule-based so every clue can be traced to the sentence it came
from. A reviewer can override any field with a front-matter block at the top
of the file:

    ---
    name: Walter E. Kowal
    city: Highland
    spouse: Helen M. Kowal
    spouse_status: predeceased
    source_url: https://example.com/obit
    ---
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import date

from .names import Person, norm, parse_natural_name

MONTHS = {
    m: i + 1
    for i, m in enumerate(
        ["january", "february", "march", "april", "may", "june", "july",
         "august", "september", "october", "november", "december"]
    )
}
MONTHS.update({k[:3]: v for k, v in list(MONTHS.items())})
MONTHS["sept"] = 9

_MONTH_RE = r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?"
DATE_RE = rf"{_MONTH_RE}\s+\d{{1,2}}(?:st|nd|rd|th)?,?\s+\d{{4}}"
_NAME_TOKEN = r"(?:[A-Z][a-z'\-]+|[A-Z]\.?|\"[A-Z][a-z]+\"|\u201c[A-Z][a-z]+\u201d|\([A-Z][a-z'\-]+\)|Jr\.?|Sr\.?|II|III)"
# 1-6 capitalized tokens: 'Walter E. "Wally" Kowal Jr.', 'Helen M. (Nowak) Kowal'
NAME_RE = rf"(?!(?:Of|And|The|In|On)\b){_NAME_TOKEN}(?:[ \t]+(?!(?:Of|And|The|In|On)\b){_NAME_TOKEN}){{0,5}}"
CITY_RE = r"[A-Z][a-z]+(?:\.?\s+[A-Z][a-z]+){0,2}"

# Lake (45) and Porter (64) County municipalities and common place names.
LOCAL_PLACES = {
    "GARY", "HAMMOND", "EAST CHICAGO", "WHITING", "CROWN POINT", "MERRILLVILLE",
    "HOBART", "LAKE STATION", "HIGHLAND", "MUNSTER", "GRIFFITH", "SCHERERVILLE",
    "DYER", "ST JOHN", "SAINT JOHN", "CEDAR LAKE", "LOWELL", "WINFIELD",
    "SCHNEIDER", "NEW CHICAGO", "LAKES OF THE FOUR SEASONS", "LEROY", "SHELBY",
    "VALPARAISO", "PORTAGE", "CHESTERTON", "PORTER", "BURNS HARBOR", "KOUTS",
    "HEBRON", "OGDEN DUNES", "BEVERLY SHORES", "DUNE ACRES", "WHEELER",
    "BOONE GROVE", "SOUTH HAVEN", "WANATAH", "UNION MILLS",
}


@dataclass
class Survivor:
    relation: str
    name: str
    city: str = ""
    state: str = ""

    @property
    def is_local(self) -> bool | None:
        if not self.city:
            return None
        if self.state and self.state.upper() not in {"IN", "INDIANA"}:
            return False
        return norm(self.city) in LOCAL_PLACES


@dataclass
class ObitClues:
    full_name: str = ""
    age: int | None = None
    birth_date: str | None = None
    death_date: str | None = None
    residence_city: str = ""
    spouse_name: str = ""
    spouse_status: str = ""  # predeceased | surviving | ""
    survivors: list[Survivor] = field(default_factory=list)
    funeral_home: str = ""
    source_url: str = ""
    published: str | None = None
    evidence: dict[str, str] = field(default_factory=dict)  # field -> sentence

    @property
    def person(self) -> Person:
        return parse_natural_name(self.full_name)

    @property
    def spouse(self) -> Person | None:
        return parse_natural_name(self.spouse_name) if self.spouse_name else None

    @property
    def birth_year(self) -> int | None:
        if self.birth_date:
            return int(self.birth_date[:4])
        if self.age and self.death_date:
            return int(self.death_date[:4]) - self.age
        return None

    @property
    def out_of_area_heirs(self) -> int:
        return sum(1 for s in self.survivors
                   if s.relation in {"son", "daughter", "child"} and s.is_local is False)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["survivors"] = [asdict(s) for s in self.survivors]
        return d


def parse_date(text: str | None) -> str | None:
    if not text:
        return None
    text = text.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return text
    m = re.match(r"([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})", text)
    if not m:
        m2 = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", text)
        if m2:
            return date(int(m2.group(3)), int(m2.group(1)), int(m2.group(2))).isoformat()
        return None
    month = MONTHS.get(m.group(1).lower().rstrip("."))
    if not month:
        return None
    try:
        return date(int(m.group(3)), month, int(m.group(2))).isoformat()
    except ValueError:
        return None


def _front_matter(text: str) -> tuple[dict[str, str], str]:
    m = re.match(r"\s*---\s*\n(.*?)\n---\s*\n", text, re.S)
    if not m:
        return {}, text
    meta = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip().lower()] = v.strip()
    return meta, text[m.end():]


def _sentence_of(text: str, pos: int) -> str:
    start = max(text.rfind(". ", 0, pos), text.rfind("\n", 0, pos)) + 1
    end_candidates = [i for i in (text.find(". ", pos), text.find("\n", pos)) if i != -1]
    end = min(end_candidates) + 1 if end_candidates else len(text)
    return text[start:end].strip()


def _clean_name(name: str) -> str:
    return re.sub(r"\s+", " ", name).strip(" ,.;")


def extract(text: str) -> ObitClues:
    meta, body = _front_matter(text)
    flat = re.sub(r"[ \t]+", " ", body)
    one_line = re.sub(r"\s*\n\s*", " ", flat).strip()
    c = ObitClues()

    # Opening line: "Walter E. Kowal, 84, of Highland, passed away ..."
    opening = rf"(?P<name>{NAME_RE}),\s*(?:age\s+)?(?P<age>\d{{1,3}}),\s*(?:of|formerly of|a resident of|late of)\s+(?P<city>{CITY_RE})"
    m = re.search(r"^[ \t]*" + opening, flat, re.M) or re.search(opening, one_line)
    if m:
        c.full_name = _clean_name(m.group("name"))
        c.age = int(m.group("age"))
        c.residence_city = m.group("city").strip()
        c.evidence["name"] = _sentence_of(m.string, m.start("name"))
    else:
        first_line = next((ln.strip() for ln in body.splitlines() if ln.strip()), "")
        first_line = re.sub(r"^(?:obituary (?:for|of)\s+)", "", first_line, flags=re.I)
        looks_like_heading = not first_line.endswith((".", "!", "?")) or re.search(r"\b[A-Z]\.$", first_line)
        if 3 < len(first_line) < 60 and looks_like_heading:
            c.full_name = _clean_name(first_line)
            c.evidence["name"] = first_line

    if c.age is None:
        m = re.search(r"\b(?:age|aged)\s+(\d{1,3})\b", one_line)
        if m:
            c.age = int(m.group(1))
            c.evidence["age"] = _sentence_of(one_line, m.start())

    # Date range "March 3, 1942 - October 3, 2026"
    m = re.search(rf"({DATE_RE})\s*[-–—~]+\s*({DATE_RE})", one_line)
    if m:
        c.birth_date, c.death_date = parse_date(m.group(1)), parse_date(m.group(2))
        c.evidence["dates"] = m.group(0)
    if not c.death_date:
        m = re.search(
            rf"(?:passed away|died|passed|entered (?:into )?(?:eternal )?rest|went home to be with (?:the|our) Lord|called home)\b[^.]{{0,80}}?({DATE_RE})",
            one_line, re.I)
        if m:
            c.death_date = parse_date(m.group(1))
            c.evidence["death_date"] = _sentence_of(one_line, m.start())
    if not c.birth_date:
        m = re.search(rf"\bborn\b[^.]{{0,60}}?({DATE_RE})", one_line, re.I)
        if m:
            c.birth_date = parse_date(m.group(1))
            c.evidence["birth_date"] = _sentence_of(one_line, m.start())

    if not c.residence_city:
        for pat in (rf"(?:lifelong|longtime|long-time|life-long)\s+resident of\s+({CITY_RE})",
                    rf"\bof\s+({CITY_RE}),\s*(?:IN|Indiana)\b",
                    rf"\bresided in\s+({CITY_RE})"):
            m = re.search(pat, one_line)
            if m:
                c.residence_city = m.group(1).strip()
                c.evidence["city"] = _sentence_of(one_line, m.start())
                break

    _extract_spouse(one_line, c)
    _extract_survivors(one_line, c)

    m = re.search(r"((?:[A-Z][A-Za-z&'.\-]+\s+){1,5}(?:Funeral Homes?|Mortuary|Funeral Chapel|Funeral Services?|Memorial Chapel))", one_line)
    if m:
        c.funeral_home = m.group(1).strip()

    # Reviewer overrides win.
    if meta.get("name"):
        c.full_name = meta["name"]
    if meta.get("age", "").isdigit():
        c.age = int(meta["age"])
    if meta.get("birth_date"):
        c.birth_date = parse_date(meta["birth_date"])
    if meta.get("death_date"):
        c.death_date = parse_date(meta["death_date"])
    if meta.get("city"):
        c.residence_city = meta["city"]
    if meta.get("spouse"):
        c.spouse_name = meta["spouse"]
    if meta.get("spouse_status"):
        c.spouse_status = meta["spouse_status"].lower()
    c.source_url = meta.get("source_url", meta.get("url", ""))
    c.published = parse_date(meta.get("published", "")) if meta.get("published") else None
    return c


_SPOUSE_WORD = r"(?:wife|husband|spouse|partner)"
_ADJ = r"(?:(?:beloved|loving|devoted|dear|dearest|cherished|late)\s+)*"


def _extract_spouse(text: str, c: ObitClues) -> None:
    patterns = [
        # preceded in death by his wife (of 52 years), Helen M. (Nowak) Kowal
        ("predeceased", rf"preceded in death by\b[^.]{{0,120}}?\b(?:his|her)\s+{_ADJ}{_SPOUSE_WORD}(?:\s+of\s+\d+\s+years)?,?\s+({NAME_RE})"),
        ("predeceased", rf"\b{_SPOUSE_WORD}\s+of\s+the\s+late\s+({NAME_RE})"),
        ("predeceased", rf"\b(?:his|her)\s+{_ADJ}{_SPOUSE_WORD}(?:\s+of\s+\d+\s+years)?,?\s+({NAME_RE}),?\s+(?:who\s+)?preceded\s+(?:him|her)\s+in\s+death"),
        ("predeceased", rf"\bwidow(?:er)?\s+of\s+({NAME_RE})"),
        ("surviving", rf"(?:survived by|leaves behind|leaves|mourned by|is survived by)\b[^.]{{0,80}}?\b(?:his|her)\s+{_ADJ}{_SPOUSE_WORD}(?:\s+of\s+\d+\s+years)?,?\s+({NAME_RE})"),
        ("", rf"\b(?:his|her)\s+{_ADJ}{_SPOUSE_WORD}(?:\s+of\s+\d+\s+years)?,\s+({NAME_RE})"),
        ("", rf"\bmarried\s+(?:the\s+(?:former\s+)?)?({NAME_RE})\s+(?:on|in)\b"),
    ]
    for status, pat in patterns:
        m = re.search(pat, text)
        if m:
            c.spouse_name = _clean_name(m.group(1))
            c.spouse_status = status
            c.evidence["spouse"] = _sentence_of(text, m.start())
            return


_CHILD_SECTION = re.compile(
    r"\b(sons?|daughters?|children|stepsons?|stepdaughters?)\b[:,]?\s+(.*?)(?=;|(?<!Jr)(?<!Sr)(?<![ (][A-Z])\.\s|\b(?:grandchildren|great[- ]grandchildren|brothers?|sisters?|siblings)\b|$)",
    re.I,
)
_PERSON_WITH_CITY = re.compile(
    rf"({NAME_RE})(?:\s+\([^)]*\))?(?:\s+[A-Z][a-z'\-]+)?\s+of\s+({CITY_RE})(?:,\s*([A-Z]{{2}}\b|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?))?"
)


def _extract_survivors(text: str, c: ObitClues) -> None:
    for sec in _CHILD_SECTION.finditer(text):
        rel_word = sec.group(1).lower()
        relation = "son" if "son" in rel_word else "daughter" if "daughter" in rel_word else "child"
        chunk = sec.group(2)
        for pm in _PERSON_WITH_CITY.finditer(chunk):
            name = _clean_name(pm.group(1))
            if norm(name) in {"HIS", "HER", "THE"}:
                continue
            c.survivors.append(Survivor(relation, name, pm.group(2).strip(), (pm.group(3) or "").strip()))
