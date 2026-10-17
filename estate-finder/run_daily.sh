#!/usr/bin/env sh
# Daily check: import whatever is in data/inbox, re-score every subject,
# write data/reports/latest.html plus a dated copy.
# cron example (7:15am every day):
#   15 7 * * * cd /path/to/estate-finder && ./run_daily.sh >> data/daily.log 2>&1
set -e
cd "$(dirname "$0")"
mkdir -p data/inbox/obituaries data/inbox/parcels data/inbox/deeds data/inbox/cases data/inbox/estate_sales data/reports
python3 -m estate_finder daily --inbox data/inbox --report data/reports/latest.html
cp data/reports/latest.html "data/reports/daily-$(date +%Y-%m-%d).html"
