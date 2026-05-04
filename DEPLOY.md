# Deploying the dashboard

## GitHub Pages (`data.json` is not in this repo)

The Actions workflow deploys **HTML/JS only**. After `python refresh_data.py`, either:

- Copy `data.json` into the repo **only for deploy** (don’t commit), add a workflow step to upload it (advanced), or  
- Use **Netlify drag-and-drop** / CLI from your machine so `data.json` is included without committing.

Baseline Pages setup:

1. Push `main` to GitHub (this repo).
2. **Repository → Settings → Pages → Build and deployment**
   - Source: **GitHub Actions**.
3. Confirm the **Deploy GitHub Pages** workflow succeeds.
4. Site URL is typically `https://<user>.github.io/procurement-spend-dashboard/`.

`index.html` redirects to `Cummins_IDP_Dashboard.html`.

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
