# @smallchat/examples

Ready-to-use MCP provider manifests for [smallchat](https://github.com/johnnyclem/smallchat), plus typed accessors for loading them programmatically.

## Usage

```ts
import { manifests, manifestList } from '@smallchat/examples';

// Look up a single provider manifest by id
const github = manifests['github'];

// Or iterate over all bundled manifests
for (const manifest of manifestList) {
  console.log(manifest.id, manifest.tools.length);
}
```

Each manifest follows the smallchat `ProviderManifest` format (`id`, `name`, `transportType`, `tools[]`) and can be compiled directly:

```bash
npx @smallchat/core compile --source ./node_modules/@smallchat/examples/manifests
```

## What's included

30+ manifests for popular MCP servers — GitHub, GitLab, Slack, Postgres, SQLite, Filesystem, Puppeteer, Google Drive/Maps, AWS, Azure, Cloudflare, Stripe, Notion, Linear, and more. See the [`manifests/`](./manifests) directory for the full list, and [`registry/`](./registry) for example registry bundles.

`github-with-hints-manifest.json` demonstrates the optional `compilerHints` field for guiding selector generation.
