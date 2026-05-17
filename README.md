# Cummins IDP Dashboard

Procurement spend analytics dashboard with harmonization analysis.

## Project structure

| Path | Purpose |
|------|---------|
| `src/dashboard/` | Frontend: `index.html`, `harmonization-client.js`, `logo.png` |
| `src/scripts/` | Python pipeline: `refresh_data.py`, `harmonization.py`, `build_spend_data.py` |
| `data/inputs/indexes/` | PPI / index `.xlsx` files (fetched or copied next to `index.html` for local run) |
| `data/outputs/` | Generated `data.json` (not committed; created by the pipeline) |
| `data/samples/example-excels/` | Example workbooks |
| `data/inputs/index-data/` | Small JSON manifests for index tooling |
| `docs/` | Documentation (deployment, changelogs, reports) |
| `logs/` | Application logs (optional; `*.log` is gitignored) |

Root `index.html` redirects to `src/dashboard/index.html` when you serve the **repository root** with a static server.

## Setup

### 1. Install Python dependencies

```bash
pip install -r requirements.txt
```

### 2. Prepare your data

Place your Excel spend file in the **repository root** (or set `INPUT_XLSX`). Required columns include part, supplier, spend, quantity, price, categories, spend_type (Direct/Indirect), date, and location fields (see `src/scripts/refresh_data.py` header).

### 3. Generate dashboard data

From the **repository root**:

```bash
python src/scripts/refresh_data.py
```

This writes `data/outputs/data.json`.

### 4. Stage files for the dashboard folder (local)

The browser loads `./data.json` and default PPI files from the **same directory** as `index.html`:

```bash
cp data/outputs/data.json src/dashboard/
cp data/inputs/indexes/*.xlsx src/dashboard/
```

### 5. View the dashboard

```bash
cd src/dashboard
python -m http.server 8000
```

Open `http://localhost:8000/index.html` (or `http://localhost:8000/landing.html` for a short redirect).

Alternatively, from the repo root:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000/src/dashboard/index.html`.

## Documentation

- [Deployment](docs/DEPLOYMENT.md) — GitHub Pages, Netlify, and data handling
- Other notes: `docs/CHANGES.md`, `docs/AUDIT_REPORT.md`, `docs/LAZY_LOADING.md`, `docs/PERFORMANCE_REPORT.md`

## Features

- **Spend Overview**: Trends, category breakdowns, regionalized spend
- **Part Search**: Search by part number, description, L3/L4 categories
- **Harmonization Analysis**: Price harmonization opportunities (MECE categories)
- **Cleansheet Analysis**: Cost breakdown by part/category
