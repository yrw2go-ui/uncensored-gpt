"""Name normalization, owner-string parsing and fuzzy name comparison."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher

SUFFIXES = {"JR", "SR", "II", "III", "IV", "V"}

# Tokens that appear in assessor/deed owner strings but are not part of a name.
NOISE_TOKENS = {
    "H/W", "HW", "H&W", "ETAL", "ET", "AL", "ETUX", "UX", "ETVIR", "JT", "JTWROS",
    "JTRS", "TEN", "TENANTS", "ENT", "ENTIRETY", "ENTIRETIES", "BY", "THE", "LIFE",
    "LE", "EST", "ESTATE", "HUSBAND", "WIFE", "AND", "TIC", "COMM", "C/O",
}

ENTITY_WORDS = {
    "LLC", "INC", "CORP", "CORPORATION", "CO", "COMPANY", "TRUST", "TRUSTEE", "TRUSTEES",
    "TR", "TRS", "BANK", "LP", "LLP", "LTD", "ASSN", "ASSOCIATION", "CHURCH", "CITY",
    "TOWN", "COUNTY", "STATE", "AUTHORITY", "HOUSING", "PROPERTIES", "HOLDINGS",
    "INVESTMENTS", "PARTNERS", "MINISTRIES", "UNIVERSITY", "SCHOOL", "FEDERAL", "NATIONAL",
    "MORTGAGE", "HUD", "SECRETARY", "REVOCABLE", "LIVING", "FAMILY",
}

_NICKNAME_GROUPS = [
    "WILLIAM BILL BILLY WILL WILLIE WILLY LIAM",
    "ROBERT BOB BOBBY ROB ROBBIE BERT",
    "RICHARD RICK RICKY DICK RICH",
    "JAMES JIM JIMMY JAMIE",
    "JOHN JACK JOHNNY JON",
    "JOSEPH JOE JOEY",
    "THOMAS TOM TOMMY",
    "CHARLES CHARLIE CHUCK CHAS",
    "EDWARD ED EDDIE TED TEDDY NED",
    "MICHAEL MIKE MICKEY",
    "WALTER WALT WALLY",
    "ANTHONY TONY",
    "DONALD DON DONNIE",
    "RONALD RON RONNIE",
    "GERALD JERRY GERRY",
    "LAWRENCE LARRY",
    "LEONARD LEN LENNY LEO",
    "RAYMOND RAY",
    "STANLEY STAN",
    "STEPHEN STEVEN STEVE",
    "DANIEL DAN DANNY",
    "DAVID DAVE",
    "KENNETH KEN KENNY",
    "FRANCIS FRANK FRANKIE",
    "FRANKLIN FRANK",
    "HENRY HANK HARRY",
    "HAROLD HAL HARRY",
    "ALBERT AL BERT",
    "ALFRED AL ALFIE FRED",
    "FREDERICK FRED FREDDIE",
    "EUGENE GENE",
    "PATRICK PAT",
    "PETER PETE",
    "SAMUEL SAM SAMMY",
    "THEODORE TED TEDDY",
    "ELIZABETH BETTY BETH LIZ LIZZIE ELIZA BETSY",
    "MARGARET PEGGY MAGGIE MARGE MARGIE MEG",
    "PATRICIA PAT PATTY TRISH",
    "BARBARA BARB BARBIE",
    "DOROTHY DOT DOTTIE DOT",
    "KATHERINE KATHRYN CATHERINE KATHY CATHY KATE KATIE",
    "SUSAN SUE SUSIE",
    "DEBORAH DEBRA DEB DEBBIE",
    "JUDITH JUDY",
    "VIRGINIA GINNY",
    "HELEN NELL NELLIE",
    "MARY MOLLY MAE MAMIE",
    "ANNE ANN ANNA ANNIE NANCY",
    "FLORENCE FLO",
    "MILDRED MILLIE",
    "SHIRLEY SHIRL",
    "CHRISTINE CHRISTINA CHRIS TINA",
    "JOSEPHINE JOSIE JO",
    "THERESA TERESA TERRY TESS",
    "ALEXANDER ALEX AL",
    "BENJAMIN BEN BENNY",
    "NICHOLAS NICK",
    "VINCENT VINCE VINNY",
]

NICKNAMES: dict[str, set[str]] = {}
for _group in _NICKNAME_GROUPS:
    _names = set(_group.split())
    for _n in _names:
        NICKNAMES.setdefault(_n, set()).update(_names)


@dataclass
class Person:
    first: str = ""
    middle: str = ""
    last: str = ""
    suffix: str = ""
    nickname: str = ""
    maiden: str = ""
    is_entity: bool = False
    raw: str = ""

    @property
    def key(self) -> str:
        return f"{self.last}|{self.first}"

    def display(self) -> str:
        if self.is_entity:
            return self.raw
        parts = [self.first, self.middle, self.last, self.suffix]
        return " ".join(p for p in parts if p).title()


@dataclass
class OwnerParse:
    persons: list[Person] = field(default_factory=list)
    is_entity: bool = False
    is_estate: bool = False  # owner string already says "ESTATE OF" / "EST"
    raw: str = ""


def norm(text: str | None) -> str:
    """Uppercase, strip punctuation (keeping & and /), collapse whitespace."""
    if not text:
        return ""
    t = text.upper().replace("’", "'")
    t = re.sub(r"[^A-Z0-9&/ ]+", " ", t.replace("'", ""))
    return re.sub(r"\s+", " ", t).strip()


def is_entity(text: str) -> bool:
    tokens = set(norm(text).split())
    return bool(tokens & ENTITY_WORDS)


def _split_tokens(text: str) -> tuple[list[str], str]:
    tokens = [t for t in norm(text).split() if t not in NOISE_TOKENS]
    suffix = ""
    kept = []
    for t in tokens:
        if t in SUFFIXES and not suffix:
            suffix = t
        else:
            kept.append(t)
    return kept, suffix


def parse_natural_name(text: str) -> Person:
    """Parse a name written first-to-last, e.g. 'Walter E. "Wally" Kowal Jr.'
    or 'Helen M. (Nowak) Kowal'."""
    raw = text.strip()
    nickname = ""
    m = re.search(r"[\"“”]([^\"“”]+)[\"“”]", raw)
    if m:
        nickname = norm(m.group(1))
        raw_wo = raw[: m.start()] + raw[m.end():]
    else:
        raw_wo = raw
    maiden = ""
    m = re.search(r"\(([^)]+)\)", raw_wo)
    if m:
        maiden = norm(m.group(1))
        raw_wo = raw_wo[: m.start()] + raw_wo[m.end():]
    if is_entity(raw_wo):
        return Person(is_entity=True, raw=norm(raw))
    tokens, suffix = _split_tokens(raw_wo)
    p = Person(suffix=suffix, nickname=nickname, maiden=maiden, raw=norm(raw))
    if not tokens:
        return p
    if len(tokens) == 1:
        p.last = tokens[0]
    else:
        p.first = tokens[0]
        p.last = tokens[-1]
        p.middle = " ".join(tokens[1:-1])
    return p


def _parse_last_first(tokens: list[str]) -> Person:
    p = Person()
    if not tokens:
        return p
    p.last = tokens[0]
    if len(tokens) > 1:
        p.first = tokens[1]
    if len(tokens) > 2:
        p.middle = " ".join(tokens[2:])
    return p


def parse_owner(owner_raw: str, fmt: str = "last_first") -> OwnerParse:
    """Parse an assessor/deed owner string into people.

    Handles common Indiana formats:
      'KOWAL, WALTER E & HELEN M'   'KOWAL WALTER E & HELEN M H/W'
      'WALTER E KOWAL & HELEN M KOWAL' (fmt='first_last')
    Entities (trusts, LLCs, banks) are flagged rather than parsed.
    """
    result = OwnerParse(raw=norm(owner_raw))
    if not owner_raw or not owner_raw.strip():
        return result
    result.is_estate = bool({"ESTATE", "EST"} & set(result.raw.split()))
    if is_entity(owner_raw):
        result.is_entity = True
        result.persons.append(Person(is_entity=True, raw=norm(owner_raw)))
        return result

    text = owner_raw.upper().replace(" AND ", " & ")
    pieces = [p.strip() for p in re.split(r"&|;", text) if p.strip()]
    shared_last = ""
    for i, piece in enumerate(pieces):
        has_comma = "," in piece
        if has_comma:
            last_part, rest = piece.split(",", 1)
            last_tokens, sfx1 = _split_tokens(last_part)
            rest_tokens, sfx2 = _split_tokens(rest)
            if not last_tokens:
                continue
            person = Person(last=" ".join(last_tokens), suffix=sfx1 or sfx2)
            if rest_tokens:
                person.first = rest_tokens[0]
                person.middle = " ".join(rest_tokens[1:])
        else:
            tokens, sfx = _split_tokens(piece)
            if not tokens:
                continue
            if i > 0 and shared_last and len(tokens) <= 2:
                # 'HELEN M' after 'KOWAL, WALTER E' shares the last name
                person = Person(last=shared_last, first=tokens[0],
                                middle=" ".join(tokens[1:]), suffix=sfx)
            elif fmt == "first_last":
                person = parse_natural_name(" ".join(tokens))
                person.suffix = person.suffix or sfx
            else:
                person = _parse_last_first(tokens)
                person.suffix = sfx
        person.raw = norm(piece)
        if i == 0:
            shared_last = person.last
        result.persons.append(person)
    return result


def parse_any_name(text: str) -> Person:
    """'KOWAL, WALTER E' (court/assessor style) or 'Walter E. Kowal' (natural)."""
    if "," in (text or ""):
        parsed = parse_owner(text)
        if parsed.persons:
            return parsed.persons[0]
    return parse_natural_name(text or "")


def first_name_score(a: str, b: str, nick_a: str = "", nick_b: str = "") -> float:
    """1.0 exact, 0.9 nickname, 0.8 near-spelling, 0.6 initial-only, else 0."""
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    names_a = {a} | ({nick_a} if nick_a else set())
    names_b = {b} | ({nick_b} if nick_b else set())
    if names_a & names_b:
        return 0.95
    for x in names_a:
        if NICKNAMES.get(x, set()) & names_b:
            return 0.9
    if len(a) == 1 or len(b) == 1:
        return 0.6 if a[0] == b[0] else 0.0
    if SequenceMatcher(None, a, b).ratio() >= 0.85:
        return 0.8
    return 0.0


def last_name_score(a: str, b: str) -> float:
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    # hyphenated / two-part surnames
    if set(a.replace("-", " ").split()) & set(b.replace("-", " ").split()):
        return 0.9
    r = SequenceMatcher(None, a, b).ratio()
    return 0.85 if r >= 0.88 else 0.0


def middle_agrees(a: str, b: str) -> bool | None:
    """True/False when both have a middle name or initial, None when unknown."""
    a, b = norm(a), norm(b)
    if not a or not b:
        return None
    return a[0] == b[0]
