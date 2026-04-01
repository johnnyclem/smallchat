/**
 * Registry & Bundle types — schemas for the smallchat registry website,
 * installable server metadata, and one-click bundle distribution.
 *
 * Three new concepts:
 *
 *   1. RegistryEntry — an enriched provider manifest that adds install
 *      metadata (npm package, env vars, categories, etc.). This is what
 *      the registry website indexes and displays.
 *
 *   2. RegistryIndex — a lightweight catalog of all entries, used by the
 *      website at build time to render the server picker UI.
 *
 *   3. SmallChatBundle — a self-contained, distributable package that
 *      captures a user's server selection + compiled manifest + install
 *      instructions. The output of "Compile & Download".
 */

import type { ProviderManifest, CompilerHint, ProviderCompilerHints } from './types.js';
import type { SmallChatManifest, ManifestCompilerConfig } from './manifest.js';

// ---------------------------------------------------------------------------
// 1. Registry Entry — enriched provider manifest
// ---------------------------------------------------------------------------

/**
 * How the MCP server is installed and started.
 *
 * Most MCP servers follow one of a few patterns:
 *   - npx: `npx -y @modelcontextprotocol/server-github`
 *   - npm-global: `npm install -g <pkg>` then `<command>`
 *   - pip/uvx: `uvx <pkg>` or `pip install <pkg>`
 *   - docker: `docker run <image>`
 *   - binary: download a prebuilt binary
 */
export type InstallMethod = 'npx' | 'npm' | 'pip' | 'uvx' | 'docker' | 'binary' | 'source';

export type ServerRuntime = 'node' | 'python' | 'go' | 'rust' | 'docker' | 'binary';

/**
 * Describes an environment variable that the MCP server requires or
 * optionally accepts. The installer uses this to prompt the user.
 */
export interface EnvVarSpec {
  /** Variable name, e.g. "GITHUB_TOKEN" */
  name: string;

  /** Human-readable description shown during install */
  description: string;

  /** Whether the server fails to start without this */
  required: boolean;

  /** URL where the user can create/find this credential */
  helpUrl?: string;

  /** Default value (for non-secret config like POSTGRES_PORT) */
  default?: string;

  /** If true, the value is a secret and should not be logged or displayed */
  secret?: boolean;
}

/**
 * Describes a command-line argument passed to the MCP server process.
 */
export interface ServerArgSpec {
  /** Argument name or flag, e.g. "--port" or positional like "<connection-string>" */
  name: string;

  /** Human-readable description */
  description: string;

  /** Whether this arg is required */
  required: boolean;

  /** Default value */
  default?: string;

  /** Placeholder shown in the UI, e.g. "postgresql://localhost:5432/mydb" */
  placeholder?: string;
}

/**
 * Install configuration for a single MCP server.
 * Enough information for the installer to `npm install`, `docker pull`,
 * or whatever is appropriate, then write the correct mcpServers entry.
 */
export interface ServerInstallConfig {
  /** Primary install method */
  method: InstallMethod;

  /** Package identifier — npm package name, PyPI name, Docker image, or URL */
  package: string;

  /** Runtime environment needed */
  runtime: ServerRuntime;

  /**
   * The command to start the server.
   * For npx: usually the package name or a bin alias.
   * For docker: the image name (args go in `args`).
   * If omitted, defaults to the package name.
   */
  command?: string;

  /**
   * Fixed arguments passed to the command.
   * e.g. ["--port", "3000"] or ["stdio"]
   */
  args?: string[];

  /**
   * User-configurable arguments — the installer prompts for these.
   */
  configurableArgs?: ServerArgSpec[];

  /**
   * Environment variables the server reads.
   */
  env?: EnvVarSpec[];

  /**
   * Minimum version of the runtime required, e.g. ">=20.0.0" for Node.
   */
  runtimeVersion?: string;

  /**
   * Alternative install methods (e.g. Docker fallback for a Node server).
   * Ordered by preference — first match wins.
   */
  alternatives?: Omit<ServerInstallConfig, 'alternatives'>[];
}

/**
 * RegistryEntry — a provider manifest enriched with everything the
 * registry website and installer need.
 *
 * This extends the existing ProviderManifest shape with install metadata,
 * categorization, and display information. The `tools` array is inherited
 * from ProviderManifest and remains the source of truth for compilation.
 */
export interface RegistryEntry {
  /** Must match the ProviderManifest id */
  id: string;

  /** Display name for the registry UI, e.g. "GitHub" */
  name: string;

  /** One-line description for the card/tile view */
  description: string;

  /**
   * Longer description with markdown, shown on the detail page.
   */
  longDescription?: string;

  /** Version of this registry entry (semver) */
  version: string;

  /** Author or maintaining organization */
  author?: string;

  /** SPDX license identifier */
  license?: string;

  /** URL to the server's source repository */
  repository?: string;

  /** URL to the server's homepage or docs */
  homepage?: string;

  /** Icon identifier or URL for the registry UI */
  icon?: string;

  /**
   * Categories for filtering. Use a controlled vocabulary:
   * "developer-tools", "databases", "communication", "cloud",
   * "productivity", "ai-ml", "search", "file-systems",
   * "monitoring", "security", "finance", "design"
   */
  categories: string[];

  /**
   * Free-form tags for search, e.g. ["github", "git", "vcs", "code-review"]
   */
  tags?: string[];

  /** Install configuration */
  install: ServerInstallConfig;

  /**
   * The full provider manifest — tool definitions, transport config, etc.
   * This is what gets fed to the smallchat compiler.
   */
  manifest: ProviderManifest;

  /**
   * Default compiler hints to apply when this entry is included in a bundle.
   * Users can override these in the registry UI or in their smallchat.json.
   */
  defaultHints?: ProviderCompilerHints;

  /**
   * Per-tool default hints.
   * Keyed by tool name (not fully-qualified — the provider ID is implicit).
   */
  defaultToolHints?: Record<string, CompilerHint>;

  /**
   * MCP features this server supports.
   * Used by the UI to show capability badges.
   */
  capabilities?: ServerCapabilities;

  /**
   * Popularity/quality signals (updated periodically, not user-editable).
   */
  stats?: RegistryEntryStats;
}

export interface ServerCapabilities {
  /** Supports MCP resources */
  resources?: boolean;
  /** Supports MCP prompts */
  prompts?: boolean;
  /** Supports MCP sampling */
  sampling?: boolean;
  /** Supports streaming responses */
  streaming?: boolean;
  /** Supports OAuth authentication */
  oauth?: boolean;
}

export interface RegistryEntryStats {
  /** Number of times this entry has been included in a bundle */
  bundleCount?: number;
  /** npm weekly downloads (if applicable) */
  weeklyDownloads?: number;
  /** GitHub stars (if applicable) */
  githubStars?: number;
  /** Last updated timestamp */
  lastUpdated?: string;
}

// ---------------------------------------------------------------------------
// 2. Registry Index — lightweight catalog for the website
// ---------------------------------------------------------------------------

/**
 * A slimmed-down entry for the index — just enough for the picker UI.
 * The full RegistryEntry is loaded on demand (detail page or compile time).
 */
export interface RegistryIndexEntry {
  id: string;
  name: string;
  description: string;
  icon?: string;
  categories: string[];
  tags?: string[];
  /** Number of tools in this server */
  toolCount: number;
  /** Tool names — shown as chips/badges in the UI */
  toolNames: string[];
  /** Install method summary — shown as a badge (e.g. "npx", "docker") */
  installMethod: InstallMethod;
  /** Runtime badge */
  runtime: ServerRuntime;
  /** Capability badges */
  capabilities?: ServerCapabilities;
  /** Popularity signals for sorting */
  stats?: RegistryEntryStats;
}

/**
 * RegistryIndex — the full catalog, generated at build time.
 * Served as a static JSON file from the docs site.
 */
export interface RegistryIndex {
  /** Schema version for this index format */
  schemaVersion: '1.0.0';

  /** When this index was last generated */
  generatedAt: string;

  /** Total number of entries */
  totalEntries: number;

  /** All available categories (for the filter sidebar) */
  categories: CategoryDefinition[];

  /** The entries */
  entries: RegistryIndexEntry[];
}

export interface CategoryDefinition {
  id: string;
  label: string;
  description: string;
  icon?: string;
}

// ---------------------------------------------------------------------------
// 3. SmallChatBundle — the distributable package
// ---------------------------------------------------------------------------

/**
 * Target client application for the installer.
 * Maps to the config file locations already known by `setup.ts`.
 */
export type InstallTarget =
  | 'claude-desktop'
  | 'claude-code'
  | 'vscode'
  | 'gemini-cli'
  | 'opencode'
  | 'codex'
  | 'cursor'
  | 'windsurf';

/**
 * A resolved server in the bundle — combines the registry entry's install
 * config with any user overrides from the picker UI.
 */
export interface BundleServer {
  /** Registry entry ID */
  id: string;

  /** Display name */
  name: string;

  /** Install configuration (copied from RegistryEntry, possibly with user overrides) */
  install: ServerInstallConfig;

  /**
   * User-supplied values for configurable args.
   * Keyed by ServerArgSpec.name → value.
   * Populated when the user fills in the config form on the registry page.
   */
  configuredArgs?: Record<string, string>;

  /**
   * User-supplied env var values.
   * Keyed by EnvVarSpec.name → value.
   * NOTE: Secret values should be placeholder references (e.g. "${GITHUB_TOKEN}")
   * rather than literal secrets, so bundles can be safely shared.
   */
  configuredEnv?: Record<string, string>;

  /**
   * The mcpServers entry that the installer writes to the target config.
   * Pre-computed from install + configuredArgs + configuredEnv.
   * Matches the { command, args, env } shape used by Claude Desktop et al.
   */
  mcpServerEntry: McpServerEntry;
}

/**
 * The shape of a single entry in a client's `mcpServers` config object.
 * This is the de facto standard across Claude Desktop, Claude Code, etc.
 */
export interface McpServerEntry {
  /** The command to start the server process */
  command: string;

  /** Arguments passed to the command */
  args?: string[];

  /** Environment variables set for the server process */
  env?: Record<string, string>;

  /** Working directory (optional) */
  cwd?: string;
}

/**
 * SmallChatBundle — the self-contained, distributable package.
 *
 * A user selects servers on the registry website, clicks "Compile & Download",
 * and gets this file. It contains everything needed to:
 *   1. Install the MCP servers
 *   2. Write the client config (mcpServers)
 *   3. Compile the optimized dispatch table
 *
 * Consumed by: `smallchat install <bundle.json>`
 */
export interface SmallChatBundle {
  /** Schema identifier */
  $schema?: string;

  /** Bundle format version */
  bundleVersion: '1.0.0';

  /** User-chosen name for this toolkit */
  name: string;

  /** Optional description */
  description?: string;

  /** When this bundle was created */
  createdAt: string;

  /** URL back to the registry page with the same selection (for sharing) */
  registryUrl?: string;

  // --- Servers ---

  /** The MCP servers included in this bundle */
  servers: BundleServer[];

  // --- Manifest ---

  /**
   * The smallchat.json manifest for this bundle.
   * References the servers by provider ID and includes any compiler config
   * or hint overrides the user specified in the UI.
   */
  manifest: SmallChatManifest;

  // --- Install targets ---

  /**
   * Which client(s) the installer should configure.
   * The user picks these on the registry page.
   */
  targets: InstallTarget[];

  // --- Compilation ---

  /**
   * If the server compiled the bundle at download time, the pre-compiled
   * toolkit artifact is embedded here. This lets the installer skip the
   * compile step entirely — zero-dependency install.
   *
   * When absent, the installer runs `smallchat compile` locally.
   */
  precompiled?: PrecompiledArtifact;
}

/**
 * An optional pre-compiled toolkit embedded in the bundle.
 * Same shape as the output of `smallchat compile`, but inlined.
 */
export interface PrecompiledArtifact {
  /** Compiler version that produced this artifact */
  compilerVersion: string;

  /** Embedding model used */
  embeddingModel: string;

  /** Embedding dimensions */
  embeddingDimensions: number;

  /** The compiled toolkit (same JSON structure as tools.toolkit.json) */
  toolkit: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Install plan — computed by the installer from a bundle
// ---------------------------------------------------------------------------

/**
 * InstallPlan — the installer's execution plan, shown to the user for
 * confirmation before any changes are made.
 *
 * This is not persisted in the bundle — it's computed at install time
 * based on the bundle + the user's current environment.
 */
export interface InstallPlan {
  /** Servers that need to be installed */
  installs: InstallStep[];

  /** Config files that will be created or modified */
  configWrites: ConfigWriteStep[];

  /** Whether compilation will be needed (false if precompiled) */
  needsCompilation: boolean;

  /** Environment checks that need to pass */
  prerequisites: PrerequisiteCheck[];

  /** Env vars that still need values (secrets not in the bundle) */
  pendingEnvVars: EnvVarSpec[];
}

export interface InstallStep {
  serverId: string;
  serverName: string;
  method: InstallMethod;
  /** The shell command that will be run */
  command: string;
  /** Whether this server is already installed (detected at plan time) */
  alreadyInstalled: boolean;
}

export interface ConfigWriteStep {
  /** Target client */
  target: InstallTarget;
  /** Config file path */
  filePath: string;
  /** Whether the file already exists */
  fileExists: boolean;
  /** Number of mcpServers entries that will be written */
  serverCount: number;
  /** Whether a backup will be created */
  willBackup: boolean;
}

export interface PrerequisiteCheck {
  /** What's being checked */
  label: string;
  /** e.g. "node", "python", "docker" */
  runtime: string;
  /** Required version */
  requiredVersion?: string;
  /** Whether the check passed */
  satisfied: boolean;
  /** Help text if not satisfied */
  helpText?: string;
}
