---
title: CLI Reference
sidebar_label: Overview
---

# CLI Reference

The `@smallchat/core` package ships a CLI for compiling manifests, inspecting artifacts, testing dispatch resolution, and running the MCP server.

## Installation

```bash
npm install @smallchat/core
```

After installation, the `smallchat` binary is available via `npx`:

```bash
npx @smallchat/core <command> [options]
```

Or install globally:

```bash
npm install -g @smallchat/core
smallchat <command> [options]
```

## Commands

| Command | Description |
|---------|-------------|
| [`compile`](./compile) | Compile tool manifests to a dispatch artifact |
| [`inspect`](./inspect) | Inspect a compiled artifact |
| [`resolve`](./resolve) | Test dispatch resolution against an artifact |
| [`serve`](./serve) | Start a MCP 2025-11-25 compliant HTTP server |

## Global options

| Option | Description |
|--------|-------------|
| `--help`, `-h` | Show help for a command |
| `--version`, `-v` | Print the package version |

## Quick reference

```bash
# Compile all manifests in ./tools → tools.json
npx @smallchat/core compile --source ./tools --output tools.json

# Inspect what's in tools.json
npx @smallchat/core inspect tools.json --providers --selectors

# Test a dispatch
npx @smallchat/core resolve tools.json "search for code"

# Start the MCP server on port 3001
npx @smallchat/core serve --source ./tools --port 3001
```
