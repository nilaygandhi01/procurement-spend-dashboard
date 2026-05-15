# Deployer Skill Sync — How It Works

```
┌─────────────────────────────────────────────────────────┐
│  User opens any conversation                            │
│  (rule is alwaysApply: true)                            │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
               ┌──────────────┐
               │ .version     │
               │ file exists? │
               └──┬───────┬───┘
                  │       │
             NO   │       │  YES
                  ▼       ▼
    ┌──────────────┐  ┌──────────────────────────────────┐
    │  FIRST RUN   │  │ Conversation involves             │
    │              │  │ deployer-* skills?                 │
    │  Auto-sync   │  └──────┬───────────────┬────────────┘
    │  (no prompt) │         │               │
    └──────┬───────┘    YES  │          NO   │
           │                 ▼               ▼
           │   ┌─────────────────────┐  ┌─────────┐
           │   │ Agent runs          │  │ Nothing │
           │   │ Step 2 (get tag)    │  │ happens │
           │   │ + Step 3 (read      │  └─────────┘
           │   │   .version)         │
           │   │ → compare           │
           │   └──┬──────────┬───┬───┘
           │      │          │   │
           │      ▼          │   ▼
           │ ┌─────────┐    │ ┌───────────┐
           │ │UP_TO_DATE│    │ │Check fails│
           │ │ Silent.  │    │ │Silent skip│
           │ │ Done.    │    │ └───────────┘
           │ └─────────┘    │
           │                ▼
           │   ┌─────────────────────────┐
           │   │  Prompt user:            │
           │   │  "v1.1.0 available,      │
           │   │   currently on v1.0.0.   │
           │   │   Update?"               │
           │   └─────┬──────────┬────────┘
           │         │          │
           │         ▼          ▼
           │   ┌─────────┐ ┌────────────┐
           │   │  Skip   │ │Yes, update │
           │   │  Done.  │ └─────┬──────┘
           │   └─────────┘       │
           │                     │
           ▼                     ▼
┌─────────────────────────────────────────┐
│  Agent executes sync (Steps 5–10)      │
│                                         │
│  1. Clean up legacy flat-layout skills  │
│  2. gh api → list skills at tag         │
│  3. Remove stale local skills           │
│  4. gh api → download each file         │
│     (retry up to 3× on failure)        │
│  5. Verify each file after write        │
│  6. Final manifest verification         │
│  7. Write tool → record .version       │
│     (only if all files verified)        │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│  Confirm to user:                        │
│  First run  → "Skills initialized at     │
│                <version>"                │
│  Update     → "Updated to <version>"    │
│  + list of synced skill names            │
└─────────────────────────────────────────┘
```

## Components

| File | Role |
|------|------|
| `.cursor/rules/deployer-skill-sync.mdc` | Always-applied rule — bootstraps on first run, checks for updates on deployer-skill conversations |
| `.cursor/skills/deployer-skills/deployer-skill-manager/SKILL.md` | Agent instructions — version check, skill download, and file I/O via `gh` CLI and agent-native Read/Write tools |
| `.cursor/skills/deployer-skills/.version` | Stores the installed `@codebeyond/components-*` tag; absence triggers first-run auto-sync |
| `McK-Internal/code-beyond-ai-dlc` tags | Source of truth for available versions |
| `components/skills/ai-enabled-toolkit-deployer-k8s-paas/skills/deployer-*` | Remote skill folders that get pulled down |

## OS Compatibility

The sync is fully OS-agnostic:
- **GitHub API calls** use the `gh` CLI, which is a cross-platform Go binary (Windows, macOS, Linux)
- **File I/O** uses the agent's native Read and Write tools (no shell file operations)
- **Filtering, sorting, and base64 decoding** are handled by `gh --jq` (jq is bundled with `gh`)
- No bash, no Unix-only tools, no shell scripts
