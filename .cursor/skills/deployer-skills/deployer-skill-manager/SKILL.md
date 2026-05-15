---
name: deployer-skill-manager
description: >
  Syncs deployer skills from the Code Beyond AI DLC repository into this project.
  Fetches skills prefixed with "deployer-" from McK-Internal/code-beyond-ai-dlc and
  installs them under .cursor/skills/deployer-skills/. Runs automatically when deployer skills
  are referenced, via the deployer-skill-sync rule. Use when the user says "sync skills",
  "update deployer skills", "refresh skills", or "install deployer skills".
allowed-tools:
  - shell
---

# Deployer Skill Manager

Syncs `deployer-*` skills from the remote repository into `.cursor/skills/deployer-skills/` so they are available as project-level Cursor skills.

## Source Repository

- **Repo:** `McK-Internal/code-beyond-ai-dlc`
- **Path:** `components/skills/ai-enabled-toolkit-deployer-k8s-paas/skills`
- **Filter:** Only skill folders whose name starts with `deployer-`

## Versioning

Skills are pinned to the latest `@codebeyond/components-*` tag from the source repo. The installed version is recorded in `.cursor/skills/deployer-skills/.version`. The sync only downloads when a newer tag is available.

## Prerequisites

- **GitHub CLI** (`gh`) installed and authenticated
- Access to the `McK-Internal/code-beyond-ai-dlc` repository

## Execution Steps

Follow these steps in order. All GitHub API calls use the `gh` CLI via the Shell tool. All file reads and writes use the agent's native Read and Write tools.

### Step 1: Verify Prerequisites

Run:

```
gh auth status
```

If the command fails, inform the user:

> GitHub CLI is not authenticated. Run `gh auth login` first.

Stop execution if authentication fails.

### Step 2: Get Latest Remote Version

Run:

```
gh api repos/McK-Internal/code-beyond-ai-dlc/tags --paginate | jq -r -s 'try ([add | .[].name | select(startswith("@codebeyond/components-"))] | map(ltrimstr("@codebeyond/components-v") | split(".") | map(tonumber)) | sort | last | map(tostring) | join(".") | "@codebeyond/components-v" + .) catch empty'
```

Store the result as `LATEST_TAG`.

**Validation:** The tag must match the format `@codebeyond/components-vX.Y.Z` (e.g., `@codebeyond/components-v0.1.6`). If the command returns no output or an invalid format, stop and inform the user:

> Could not fetch latest tag from McK-Internal/code-beyond-ai-dlc. Verify you have access to the repository and that `@codebeyond/components-*` tags exist.

### Step 3: Get Local Version

Read the file `.cursor/skills/deployer-skills/.version` using the Read tool.

- If the file exists, store its contents (trimmed) as `LOCAL_VERSION`.
- If the file does not exist, set `LOCAL_VERSION` to empty (first install).

### Step 4: Compare Versions

**If `LOCAL_VERSION` equals `LATEST_TAG`:** Report up-to-date and stop.

> Skills are up to date at `<LATEST_TAG>`.

**If versions differ (or first install):**

- **Automatic trigger** (via the `deployer-skill-sync` rule): Prompt the user before proceeding.

  > Deployer skills update available: `<LOCAL_VERSION>` → `<LATEST_TAG>`. Update now?

  If the user declines, stop. If first install (no `.version` file), proceed without prompting.

- **Manual trigger** (user said "sync skills", "update deployer skills", etc.): Proceed without prompting.

### Step 5: Clean Up Legacy Skills

Earlier versions of the deployer template installed skills directly under `.cursor/skills/` (flat layout). These must be removed to avoid conflicts with the new `.cursor/skills/deployer-skills/` structure.

Check for the following legacy folders using the Glob tool:

- `.cursor/skills/convert-supabase-to-postgresql/`
- `.cursor/skills/deploy-application/`
- `.cursor/skills/dockerize-application/`
- `.cursor/skills/download-lovable-app/`
- `.cursor/skills/download-v0-project/`
- `.cursor/skills/execute-deployment-workflows/`
- `.cursor/skills/mckid-manage-stack/`
- `.cursor/skills/move-secrets-to-vault/`
- `.cursor/skills/push-to-github/`

If any legacy folders are found, list them and prompt the user for confirmation before deleting:

> The following legacy skill folders were found and will be removed to avoid conflicts with the new layout:
> - convert-supabase-to-postgresql
> - ... (list found)
>
> Proceed with removal?

If the user confirms, delete each folder using a platform-appropriate shell command:

- **Unix/macOS:** `rm -rf .cursor/skills/<legacy-name>`
- **Windows (PowerShell):** `Remove-Item -Recurse -Force .cursor/skills/<legacy-name>`

After deletion, report them:

> Removed N legacy skill folders:
> - convert-supabase-to-postgresql
> - ... (list removed)

If none are found, skip silently.

### Step 6: List Deployer Skills

Run:

```
gh api "repos/McK-Internal/code-beyond-ai-dlc/contents/components/skills/ai-enabled-toolkit-deployer-k8s-paas/skills?ref=<LATEST_TAG>" --jq '[.[] | select(.name | startswith("deployer-")) | .name]'
```

Replace `<LATEST_TAG>` with the actual tag value.

Store the resulting list as `SKILL_NAMES`. If the list is empty, **do not** write `.version`. Stop and warn the user:

> **No deployer skills found at `<LATEST_TAG>`.** This is unexpected — verify the remote path and tag are correct. The `.version` file was not updated so the next sync will retry.

Report the skills that will be synced:

> Found N deployer skills to sync:
> - deployer-deploy-application
> - deployer-dockerize-application
> - ... (list all)

### Step 7: Remove Stale Skills

Skills that were previously synced but no longer exist in the source repository must be removed.

**Protected files:** Never delete `deployer-platform-steering.md` or its parent directory under any circumstances. This file is a local configuration file specific to each deployer instance and is not managed by the remote repository.

Use the Glob tool to list all `deployer-*/` directories under `.cursor/skills/deployer-skills/` (e.g., glob `.cursor/skills/deployer-skills/deployer-*/`). Derive the directory name for each match to build a `LOCAL_SKILLS` list. This catches both complete and partial directories (e.g., from an interrupted sync).

Compare `LOCAL_SKILLS` against `SKILL_NAMES` (from Step 6). For each local skill that is **not** in `SKILL_NAMES`, delete its directory using a platform-appropriate shell command:

- **Unix/macOS:** `rm -rf .cursor/skills/deployer-skills/<stale-skill-name>`
- **Windows (PowerShell):** `Remove-Item -Recurse -Force .cursor/skills/deployer-skills/<stale-skill-name>`

If any were removed, report them:

> Removed N skills no longer in source:
> - deployer-old-skill
> - ... (list removed)

If none are stale, skip silently.

### Step 8: Download Each Skill

Process each skill **sequentially** (one at a time, not in parallel) to avoid race conditions. For each skill name in `SKILL_NAMES`, recursively download all files into `.cursor/skills/deployer-skills/<skill-name>/`.

Before downloading a skill, delete its existing local directory (if any) to remove stale files, then recreate it:

- **Unix/macOS:** `rm -rf .cursor/skills/deployer-skills/<SKILL_NAME> && mkdir -p .cursor/skills/deployer-skills/<SKILL_NAME>`
- **Windows (PowerShell):** `if (Test-Path .cursor/skills/deployer-skills/<SKILL_NAME>) { Remove-Item -Recurse -Force .cursor/skills/deployer-skills/<SKILL_NAME> }; New-Item -ItemType Directory -Force -Path .cursor/skills/deployer-skills/<SKILL_NAME>`

**Exception:** If `SKILL_NAME` is `deployer-skill-manager`, skip the directory deletion. Download files directly into the existing directory, overwriting in place. This avoids removing the running manager's files from disk mid-sync.

Then proceed with the fresh download.

Maintain a manifest of expected files for each skill (collected during directory listing) so they can be verified after download.

Define two variables per skill:

- `SKILL_NAME` — the skill folder name (e.g., `deployer-deploy-application`). Used as the **local** destination root: `.cursor/skills/deployer-skills/<SKILL_NAME>/`.
- `REMOTE_PREFIX` — the fixed remote base path: `components/skills/ai-enabled-toolkit-deployer-k8s-paas/skills/<SKILL_NAME>`.

**8a. List directory contents:**

```
gh api "repos/McK-Internal/code-beyond-ai-dlc/contents/<REMOTE_DIR>?ref=<LATEST_TAG>" --jq '.[] | "\(.type)\t\(.name)\t\(.path)"'
```

For the initial call, `REMOTE_DIR` equals `REMOTE_PREFIX`. Record every file path encountered (across all subdirectories) as the **expected file list** for this skill.

**8b. For each entry:**

- If `type` is `"dir"`, recurse into it by repeating step 8a with `REMOTE_DIR` set to the subdirectory's full remote path (from the `path` column). Keep `SKILL_NAME` and `REMOTE_PREFIX` unchanged.
- If `type` is `"file"`, download the file content. Use `--jq '.content'` to extract the base64-encoded body, decode it, and write directly to the local path. Use the platform-appropriate command:

  - **Unix/macOS/Linux:**
    ```
    gh api "repos/McK-Internal/code-beyond-ai-dlc/contents/<PATH>?ref=<LATEST_TAG>" --jq '.content' | base64 -d > .cursor/skills/deployer-skills/<SKILL_NAME>/<relative-path>
    ```

  - **Windows (PowerShell):**
    ```
    $b64 = gh api "repos/McK-Internal/code-beyond-ai-dlc/contents/<PATH>?ref=<LATEST_TAG>" --jq '.content'; [System.IO.File]::WriteAllBytes(".cursor/skills/deployer-skills/<SKILL_NAME>/<relative-path>", [System.Convert]::FromBase64String($b64))
    ```

**Important:** Do **not** use jq's `@base64d` filter or store decoded content in a shell variable — large files with special characters will be corrupted. Always pipe or write directly to file.

**Before continuing**, validate the written file:
- If the file is empty, has zero bytes, or the `gh api` command returned a non-zero exit code, **retry the download up to 2 more times** (3 attempts total) with a brief pause between attempts.
- If all 3 attempts fail, record this file as a **download failure** and continue with the remaining files.

Derive the local relative path by stripping `REMOTE_PREFIX` from the file's full remote `path`.

**8c. Verify the downloaded file:**

After each Write, immediately read the file back using the Read tool and confirm:
- The file exists and is not empty.
- If verification fails, retry the download (up to 2 more times). If it still fails, record the file as a **write failure**.

### Step 9: Verify Downloads

After all skills have been downloaded, verify that every expected file actually exists on disk. For each skill, use the Glob tool to list all files under `.cursor/skills/deployer-skills/<SKILL_NAME>/` and compare against the expected file list collected in Step 8a.

Collect any discrepancies into a `FAILED_FILES` list (files that are missing or empty).

**If `FAILED_FILES` is not empty:**

Report the failures to the user **before** recording the version:

> **Warning: Some skill files failed to download:**
> - `deployer-<name>/SKILL.md` — missing
> - `deployer-<name>/other-file` — empty
>
> Run "sync skills" again to retry, or investigate the failures above.

**Do NOT write the `.version` file** when there are failures. This ensures the next sync will re-attempt the download.

**If all files verified successfully**, proceed to Step 10.

### Step 10: Record Version and Report

Write `LATEST_TAG` (the tag string, e.g., `@codebeyond/components-v1.2.0`) to `.cursor/skills/deployer-skills/.version` using the Write tool.

Report results to the user:

> **Deployer skills synced to `<LATEST_TAG>`**
>
> Synced N skills:
> - deployer-deploy-application
> - deployer-dockerize-application
> - ... (list all)

## Installed Skills Directory

After sync, the directory structure will look like:

```
.cursor/skills/
  deployer-skills/
    .version                     # Installed tag (e.g. @codebeyond/components-v1.0.0)
    deployer-skill-manager/      # This skill (manager)
      SKILL.md
    deployer-<name>/             # Synced skill
      SKILL.md
      ...
```

## Troubleshooting

| Issue | Resolution |
|-------|------------|
| `gh: command not found` | Install GitHub CLI: https://cli.github.com/ |
| `Not authenticated` | Run `gh auth login` and authenticate |
| `Failed to list skills` | Verify you have access to `McK-Internal/code-beyond-ai-dlc` |
| `Could not fetch latest tag` | Repo may have no `@codebeyond/components-*` tags yet |
| No skills found | No `deployer-*` skills exist yet in the remote repo |
| Already at latest version | No action needed — this is normal, not an error |
| File download returned empty | Likely a transient GitHub API issue; the retry logic handles this automatically. If persistent, check `gh api` rate limits with `gh api rate_limit` |
| Some skill files failed to download | The `.version` file is intentionally not updated so the next sync retries. Run "sync skills" again. |
| File exists after Write but is empty | The Write tool may have silently failed; the post-write verification catches this and retries |
| Stale skills remain after sync | Verify Step 7 ran correctly; local `deployer-*` folders not in the remote listing are automatically removed |
