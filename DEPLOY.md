# Deploying the dashboard

## GitHub Pages (recommended if `data.json` is under ~100 MB per Git rules)

1. Push `main` to GitHub (this repo).
2. **Repository → Settings → Pages → Build and deployment**
   - Source: **GitHub Actions** (not “Deploy from a branch”).
3. Open the **Actions** tab and confirm the “Deploy GitHub Pages” workflow succeeds.
4. After the first run, Pages shows the site URL (typically  
   `https://<user>.github.io/procurement-spend-dashboard/`).

`index.html` redirects to `Cummins_IDP_Dashboard.html`.  
If `data.json` fails to push because of GitHub’s **100 MB file limit**, use Netlify below or move `data.json` to **Git LFS**.

## Netlify (good for large `data.json`)

```bash
cd procurement-spend-dashboard
npx netlify-cli login
npx netlify-cli deploy --prod --dir .
```

Or drag the folder into [Netlify Drop](https://app.netlify.com/drop).  
`netlify.toml` sets the publish directory to `.`.

## Data sensitivity

Do not make the repo or site public until spend data is cleared for external hosting.
