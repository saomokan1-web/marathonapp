# Marathon Readiness

A personal, browser-only training tracker that estimates when you'll be ready
to run a **2:45 marathon** (3:54 / km).

Upload a CSV exported from **Strava** or **Garmin Connect** and the app will
render a dashboard of:

1. Weekly mileage (bar chart)
2. Pace trend — every run plus a 4-week rolling average, with the 3:54/km
   target drawn in
3. Long run progression — longest run of each week
4. **Estimated readiness date** — linear projection of your pace trend to the
   target, updated on every upload

## Usage

Just open `index.html` in a desktop browser. No build step, no server, no
login — everything runs locally and nothing leaves your machine.

```
python3 -m http.server 8000
# then visit http://localhost:8000
```

(or simply double-click `index.html`).

## CSV support

- **Strava**: the `activities.csv` from the bulk account export
- **Garmin Connect**: the `Activities.csv` export from the activities list

The parser is tolerant: it looks for columns such as `Activity Type`, `Date` /
`Activity Date`, `Distance`, `Moving Time` / `Elapsed Time` / `Time`, and
`Avg Pace`. Non-running activities (cycling, swimming, walking, …) are
filtered out. All distances and paces are shown in km.

## Readiness projection — how it works

The app looks at runs ≥ 10 km (or all runs if you don't have enough long
ones), computes a weekly distance-weighted average pace, and fits a linear
regression over the most recent ~26 weeks. It then projects when that trend
line crosses 3:54 / km and reports the date. If your trend is flat or
worsening, it will say so instead of inventing a number.
