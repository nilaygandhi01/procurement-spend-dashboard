# Deploying the dashboard

## Layout

- **Source dashboard**: `src/dashboard/index.html` (+ `harmonization-client.js`, assets).
- **Built data**: `python src/scripts/refresh_data.py` → `data/outputs/data.json`.
- **Static bundle**: copy `data.json` and PPI `*.xlsx` from `data/inputs/indexes/` into `src/dashboard/` so same-origin `fetch` works (Netlify / GitHub Actions do this in the build step).

## GitHub Pages

The **Deploy GitHub Pages** workflow installs dependencies, runs `refresh_data.py`, copies `data.json` and index workbooks into `src/dashboard/`, then publishes **only** `src/dashboard/`.

Requirements for a green build:

- A readable spend workbook (see `src/scripts/refresh_data.py`: `INPUT_XLSX`, or the default filenames under the repo root), and
- Python dependencies from `requirements.txt`.

Site URL is typically `https://<user>.github.io/procurement-spend-dashboard/`.

Root `index.html` in the repo redirects to `src/dashboard/index.html` for local servers started at the repo root; the Pages site root is the contents of `src/dashboard/`, so the main entry is `index.html` on the deployed site.

## Netlify

`netlify.toml` sets `publish = "src/dashboard"` and a **build** command that runs the pipeline and copies outputs into that folder. Use the Netlify UI or CLI against the repo root.

```bash
npx netlify-cli deploy --prod
```

## Data sensitivity

Do not make the repo or site public until spend data is cleared for external hosting.
