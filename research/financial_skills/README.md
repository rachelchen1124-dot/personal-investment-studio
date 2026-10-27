# Financial Skills workbench

`/financial-skills` is a browser-based adapter for 18 original financial-analysis
and equity-research workflows from `anthropics/financial-services`. It is linked
from `/tools` and the homepage fallback, within the existing Studio navigation.

Choose a workflow, enter research context, then copy or download a Markdown
brief for Claude. The brief includes the original instructions, source revision,
date guidance and, by default, all supporting text files shipped with that
workflow. Attach actual workbooks, filings and transcripts in the destination
session. Draft context lives only in React state; reloading clears it. The
workbench makes no model requests and needs no model credentials.

This does **not** deploy Claude Managed Agents, connect market-data providers,
run Python scripts, generate analyst reports, or create financial workbooks on
the website. Those capabilities depend on the destination Claude environment.
MCP subscriptions and API permissions are not transferred by copying a brief.
Other verticals and the named agents from the upstream collection are outside
this integration's scope.

## Source maintenance

The checked-in `public/financial-skills/` JSON files contain original source text,
supporting files, SHA-256 digests and pinned GitHub URLs. `LICENSE.txt`,
`NOTICE.txt` and `provenance.json` record attribution and scope. The workflow text
is unmodified; the Studio's catalog and context adapter are separate.

To update intentionally, review a clean upstream checkout and run:

```sh
node scripts/sync-financial-skills.mjs /absolute/path/to/financial-services
node --test research/financial_skills/workbench.test.mjs
```

Review the resulting source diff before deployment. No code from the upstream
workflow bundles executes during synchronization or in the browser. Updates are
pinned and deliberate, rather than fetching executable instructions at runtime.
