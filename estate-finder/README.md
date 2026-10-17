# Estate Finder: Phase 0 validation

Starts from an obituary (the "funeral starting point"), works out which Lake or
Porter County parcel the person owned, and re-checks every day for new
evidence. Each clue moves the score, and the tool records the history. The
point of Phase 0 is to measure whether this can produce **25+ verified,
property-holding estates a month at 80%+ match precision**. The dashboard
tracks both numbers.

Python 3.10+, standard library only, SQLite. No accounts, no servers.

## Try the demo

```sh
cd estate-finder
python3 -m estate_finder demo          # builds data/demo.db from fictional sample data
open data/reports/demo.html            # or xdg-open on Linux
python3 -m estate_finder --db data/demo.db show 2
```

The demo replays two weeks:

| Day | What arrives | What the tool does |
|---|---|---|
| Oct 2 | Parcels, old deeds, obituaries for Kowal and Johnson | Kowal: 3 owners named Walter Kowal. City, middle initial, age and spouse narrow it to one, capped at 70 because only the obituary supports it. Johnson: 4 Mary Johnsons; the 1960 owner is ruled out by age. The surviving husband is on the deed, so availability is 0. |
| Oct 5 | Estate cases, Petrovich obituary | Kowal's case lists the house address: 70 → 100. Garcia has a case but no obituary, so she becomes a new subject. Her trust's parcel is held for review. |
| Oct 7 | Porter estate case | Petrovich's home confirmed. His Portage rental mails its tax bills to that home, so it is linked too. |
| Oct 10 | Estate sale listing | Kowal availability rises to 100: contents being sold. |
| Oct 13 | New deeds | Johnson: affidavit of survivorship to her husband. Lead closed as transferred. |

The obituary also clears a look-alike: an owner named WALTER E KOWAL JR,
whose tax bills go to Tempe, AZ, matches the obituary's "son Walter Jr. of
Tempe, AZ" and is scored down.

## Daily use

1. **Load parcels once, then refresh monthly.** Put a CSV in `data/inbox/parcels/`.
   Include `lake` or `porter` in the filename so the county is set. Regrid exports and most
   county downloads are recognized by column name. For other layouts:
   `python3 -m estate_finder import parcels file.csv --county Porter --map owner_raw=OWNER1`.
   A public ArcGIS parcel layer can be pulled with `fetch-parcels <layer-url>`.
2. **Each morning, paste new obituaries** as `.txt` files into `data/inbox/obituaries/`
   (NWI Times, funeral home sites). Correct anything the parser misses with a front-matter block:
   ```
   ---
   name: Walter E. Kowal
   city: Highland
   spouse: Helen M. Kowal
   spouse_status: predeceased
   source_url: https://...
   ---
   (obituary text)
   ```
3. **Drop other finds into the inbox as CSVs:** estate cases or notices to creditors
   (`cases/`), deed index exports (`deeds/`), estate-sale listings (`estate_sales/`).
   Column names are flexible; see `estate_finder/importers.py`.
4. **Run `./run_daily.sh`** (or schedule it with cron). It imports only new files, links
   estate cases to obituaries, re-scores every open subject, logs what changed, and writes
   `data/reports/latest.html`.
5. **Verify and record decisions** after checking the deed:
   `python3 -m estate_finder review <subject-id> <parcel-number> confirmed --note "..."`.
   Precision is computed from these decisions.

Other commands: `list`, `show <id>`, `stats`, `report`.

## How scoring works

Every point comes with a plain-language reason, shown in `show` and on the dashboard.

| Clue | Effect on match score |
|---|---|
| Owner name exact / nickname / near-spelling / initial | +40 / +32 / +25 / +20 |
| Middle initial agrees / differs | +5 / −15 |
| City of residence matches parcel / mailing city / neither | +10 / +5 / −10 |
| Spouse from obituary is co-owner on the deed | +20 |
| Acquired before the decedent turned 18 | −30 |
| Estate case lists this address | +25 |
| Estate sale at this address | +15 |
| Deed after death from the estate | +25 |
| Tax bills go to the decedent's confirmed home | +20 |
| Owner matches a survivor ("son Walter Jr.") or mails to a survivor's city | −25 / −10 |
| Only owner with this name / one of 2 / 3–4 | +11 / +6 / +2 |
| Other owners score within 10 points | −10 each (max −30) |
| **Caps:** obituary only, no confirming record | 70 |
| **Caps:** trust or company owner | 50 |

Bands: 80+ strong, 50–79 probable, below 50 possible.

**Availability** (0–100, base 20) is evidence that the property may change hands,
not that anyone wants to sell. It goes up for: sole owner or all owners deceased,
estate case filed (more if unsupervised), estate sale, no deed since the death,
out-of-area children, absentee mailing address. It goes down when a surviving
spouse co-owns. It is 0 once title moves after the death. For weak matches
(below 50) it is scaled down.

## Analytics on the dashboard

- **Phase 0 scorecard:** verified in the last 30 days against the target of 25;
  precision against the target of 80%; share resolved to one person's parcels;
  median days from obituary to a confirming record.
- **How each clue narrows the field:** candidates remaining after name → city
  → age → spouse → record confirmation.
- **Which clues do the work:** average points each clue type adds to the top match.
- **Score history** for each candidate (match and availability over time).

## Guardrails built in

- No contact before **90 days after the death**; the watch list shows the unlock date.
- Survivors' names are used only for matching; the dashboard shows counts, not names.
- `data/` is git-ignored. The report says it holds personal information and must not be shared.
- Scores are evidence of a possible link, never proof of ownership. Check title before any offer.

## Where the data comes from

The daily job re-checks everything you have imported. It only fetches on its own from
sources whose terms allow it (public ArcGIS parcel layers). MyCase, Legacy.com and
most listing sites prohibit automated collection, so their records come in by hand
or by approved bulk feed. See the evaluation report for the source-by-source review.

## Tests

```sh
python3 -m unittest discover -s tests
```
