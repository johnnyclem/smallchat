---
title: inspect
sidebar_label: inspect
---

# `inspect`

Inspects a compiled artifact and prints structured information about its contents.

## Usage

```bash
npx @smallchat/core inspect <file> [--providers] [--selectors]
```

## Arguments

| Argument | Description |
|----------|-------------|
| `<file>` | Path to a compiled artifact (output of `compile`) |

## Options

| Option | Description |
|--------|-------------|
| `--providers` | Print the list of providers and their tool counts |
| `--selectors` | Print the full selector table with canonical forms |

If neither `--providers` nor `--selectors` is specified, a summary is printed.

## Examples

### Summary (no flags)

```bash
npx @smallchat/core inspect tools.json
```

Output:

```
tools.json
  Version:     1
  Fingerprint: a3f2c1d8...
  Providers:   3
  Tools:       15
  Selectors:   13   (2 deduplicated)
  Overloads:   2
  Size:        48 KB
```

### Providers

```bash
npx @smallchat/core inspect tools.json --providers
```

Output:

```
Providers (3):
  github       (mcp)   3 tools
  filesystem   (mcp)  10 tools
  slack        (mcp)   2 tools
```

### Selectors

```bash
npx @smallchat/core inspect tools.json --selectors
```

Output:

```
Selectors (13):
  sel_search_code         "search for code"          → github.search_code
  sel_create_issue        "create issue"             → github.create_issue
  sel_list_prs            "list pull requests"       → github.list_pull_requests
  sel_read_file           "read file"                → filesystem.read_file
  sel_write_file          "write file"               → filesystem.write_file
  sel_list_dir            "list directory"           → filesystem.list_directory
  sel_search_files        "search files"             → filesystem.search_files
  sel_delete_file         "delete file"              → filesystem.delete_file
  sel_get_file_info       "get file info"            → filesystem.get_file_info
  sel_create_dir          "create directory"         → filesystem.create_directory
  sel_move_file           "move file"                → filesystem.move_file
  sel_search_messages     "search messages"          → slack.search_messages
  sel_send_message        "send message"             → slack.send_message
```

### Both flags

```bash
npx @smallchat/core inspect tools.json --providers --selectors
```

Prints providers followed by selectors.
