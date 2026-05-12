Index Analysis — external index files
======================================

1. Add one or more Excel (.xlsx) files to this folder.

2. Each file should have:
   - A header row with column "observation_date" (YYYY-MM-DD or Excel dates)
   - A second column with the numeric index level (any column name, e.g. WPU10)

3. Register each filename in manifest.json under "files", for example:
   "files": ["WPU10.xlsx", "PPIACO.xlsx"]

4. Optional: replace fabricated-metal-benchmark.json with your own benchmark series
   (same date + numeric columns). The dashboard loads the benchmark path from manifest "benchmark".

5. Serve the dashboard over HTTP/S (not file://) so the browser can fetch these files.

6. Reload the dashboard page after adding or changing files.
