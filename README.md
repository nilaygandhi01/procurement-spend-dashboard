# Cummins IDP Dashboard

Procurement spend analytics dashboard with harmonization analysis.

## Setup Instructions

### 1. Install Python Dependencies

```bash
pip install pandas openpyxl
```

### 2. Prepare Your Data

Place your Excel spend file in the project folder. Required columns:

- part, supplier, spend, quantity, price
- category_1, category_2, category_3, category_4
- spend_type (Direct/Indirect)
- date, cummins_country or cmi_location

### 3. Generate Dashboard Data

```bash
python refresh_data.py
```

This creates `data.json` (not included in repo - generated locally).

### 4. View Dashboard

Start a local web server:

```bash
python -m http.server 8000
```

Open browser to: `http://localhost:8000/Cummins_IDP_Dashboard.html`

## Files

- `Cummins_IDP_Dashboard.html` - Main dashboard interface
- `refresh_data.py` - Data processing pipeline
- `harmonization.py` - Harmonization calculation engine
- `harmonization-client.js` - Client-side harmonization fallback
- `data.json` - Generated data file (create locally, not in repo)

## Features

- **Spend Overview**: Trends, category breakdowns, regionalized spend
- **Part Search**: Search by part number, description, L3/L4 categories
- **Harmonization Analysis**: Identify price optimization opportunities
  - Category 1: Same site, different suppliers
  - Category 2: Same supplier, different sites
- **Cleansheet Analysis**: Cost breakdown by part/category
