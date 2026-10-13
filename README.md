# ECHO — Where is US inflation going?

A one-page US CPI scenario model running on live official data, with outside forecasts shown alongside for comparison.

```
public/index.html   the page
public/app.js       page logic
public/model.js     the forecast engine, shared by the page and the backtest
api/data.js         GET /api/data: live inputs from every source (cached 1 hour)
api/backtest.js     GET /api/backtest: real-time track record (cached 1 day)
lib/sources.js      fetchers + parsers, one per source (incl. ALFRED vintages)
lib/derive.js       builds the monthly panel: components, weights, seasonal factors, trailing paces
test/run.mjs        offline tests, including a look-ahead check (not deployed)
```

## Deploy to Vercel

1. Put this folder in a GitHub repo, then go to vercel.com → **Add New → Project → Import** the repo. You don't need a framework preset or a build command; `vercel.json` already points static files at `public/`.
   Or deploy from a terminal: `npm i -g vercel && vercel` in this folder.
2. Under **Project → Settings → Environment Variables**, add:

| Variable | Needed? | Where to get it |
|---|---|---|
| `FRED_API_KEY` | **Required for the track record** | Free from https://fred.stlouisfed.org/docs/api/api_key.html. The backtest reads archived data vintages (ALFRED), which only the API serves. Without it the main page still works from FRED's public CSV, but there is no track record and no error band. |
| `EIA_API_KEY` | Optional | Free from https://www.eia.gov/opendata/register.php. Sets the oil dial to the EIA's WTI forecast. Without it, the dial starts at today's spot price. |
| `CONTACT_EMAIL` | Recommended | Your email address. It goes in the User-Agent header, which BLS asks automated clients to include. |

3. Redeploy. `GET /api/data` is cached at Vercel's edge for 1 hour, and a stale copy is served for up to a day while it refreshes. Data sources are queried at most once an hour, however many people visit.

## Track record and error band

`/api/backtest` re-runs the model for every month since June 2016 as if it were that CPI release day:

- CPI and its components exactly as published on that date (ALFRED vintages, including later seasonal revisions not yet made)
- the BLS weights table that was public at the time
- dials set by the same data rule the page uses (`dataDefaults` in `public/model.js`)
- the Cleveland Fed nowcast as it stood that day, for the "nowcast start" variant

It compares each forecast with the official rate that followed and reports the typical miss at 1–12 months against "no change", the Cleveland Fed nowcast and the SPF. The page's shaded band is the range that held 80% of those errors. The nowcast start is on by default only if it lowered the 1–2 month error in this record.

Known limits, also listed on the page: the oil dial is held at spot (EIA forecast vintages aren't available), and Zillow rents use today's history because Zillow doesn't publish vintages.

## Data sources

| Feeds | Source |
|---|---|
| CPI headline (SA and NSA), food, energy goods, energy services, core goods, shelter | BLS, via FRED: `CPIAUCSL` `CPIAUCNS` `CPIUFDSL` `CUSR0000SACE` `CUSR0000SEHF` `CUSR0000SACL1E` `CUSR0000SAH1` |
| Weights | BLS relative importance, December table (`bls.gov/cpi/tables/relative-importance/YYYY.htm`). It picks up each new year's table automatically. If bls.gov blocks the request, it uses an embedded copy of the official Dec-2025 table and labels it as a fallback. |
| Oil dial | WTI daily `DCOILWTICO` (FRED) plus the EIA Short-Term Energy Outlook forecast `WTIPUUS` |
| Rent dial | Zillow Observed Rent Index, US. The timeliest measure of new-lease rents; BLS's own new-tenant rent index is quarterly and lags. |
| Outside forecasts | Cleveland Fed inflation nowcast · Cleveland Fed 1-year expected inflation `EXPINF1YR` (built from swaps, yields and surveys) · Philadelphia Fed SPF median CPI · 5-year breakeven `T5YIE` and 5y5y `T5YIFR` · Michigan 1-year `MICH` · FOMC median PCE `PCECTPIMD` |

If any of the core CPI series fails, the page shows the error and a source-status table instead of numbers. If a secondary source fails, only that card or dial default drops out, and the status table at the bottom of the page says why.

## Things to know

- **October 2025 CPI was never published** because of the government shutdown. That month is filled by geometric interpolation, and the page says so.
- **Services ex-energy ex-shelter is derived** each month as the part of headline CPI the other five components don't explain, using BLS weights rolled forward. Seasonal-adjustment quirks show up in it as noise.
- **Two parsers are written defensively against files with no published spec:** the Cleveland Fed nowcast JSON and the SPF Excel file. If either format changes, its card reads "unavailable" and the status table shows the parser error. Check both after the first deploy.
- **There are no free official one-year inflation-swap quotes.** `EXPINF1YR` is the closest official stand-in. If you have a vendor feed (Bloomberg `USSWIT1`, for example), add a fetcher in `lib/sources.js` and a card in `renderRefs()`.

## Test

`npm install && npm test` runs both endpoints offline against test inputs in each source's wire format. It checks that the derived services-ex-shelter series matches its known value, that a perfect nowcast reproduces the official rate, and that **no backtest forecast changes when data published after its date is altered** (the look-ahead check).
