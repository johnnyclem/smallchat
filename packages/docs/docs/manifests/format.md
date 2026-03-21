---
title: Manifest Format
sidebar_label: Manifest Format
---

# Manifest Format

A **provider manifest** is a JSON file that describes a tool provider and its tools. Manifests are the input to the `compile` command and the `ToolCompiler` API.

## Full schema

```typescript
interface ProviderManifest {
  id: string;                         // Unique provider identifier (e.g. "github")
  name: string;                       // Human-readable name (e.g. "GitHub")
  transportType: TransportType;       // "mcp" | "http" | "local"
  description?: string;               // Optional provider description
  tools: ToolDefinition[];            // Array of tool definitions
}

type TransportType = 'mcp' | 'http' | 'local';

interface ToolDefinition {
  name: string;                       // Tool identifier within the provider
  description: string;                // Natural-language description (used for embedding)
  providerId: string;                 // Must match parent manifest id
  transportType: TransportType;       // Transport for this specific tool
  inputSchema: JSONSchemaObject;      // JSON Schema for input arguments
}
```

## File naming

The `compile` command looks for files matching `*-manifest.json` in the source directory. Name your files descriptively:

```
tools/
  github-manifest.json
  filesystem-manifest.json
  slack-manifest.json
```

## `description` quality matters

The `description` field on each `ToolDefinition` is the primary signal used by the semantic embedder. Well-written descriptions produce better dispatch accuracy.

**Good:**
```json
"description": "Search for code across GitHub repositories using a text query"
```

**Too vague:**
```json
"description": "Search"
```

**Too similar to another tool (causes collision):**
```json
// Tool A:
"description": "Search for source code in a repository"
// Tool B:
"description": "Search for code files in a repo"
// → These may deduplicate to the same selector
```

Guidelines:
- Describe what the tool does, not what it is
- Include the domain context (`"GitHub"`, `"filesystem"`, `"Slack"`)
- Use distinct vocabulary for tools in different domains

## `inputSchema`

The `inputSchema` field is a JSON Schema object. It is passed through verbatim to the MCP server and used by the `OverloadTable` for type-based dispatch.

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Search query"
    },
    "language": {
      "type": "string",
      "description": "Programming language filter",
      "enum": ["typescript", "python", "go", "rust"]
    },
    "maxResults": {
      "type": "number",
      "description": "Maximum number of results to return"
    }
  },
  "required": ["query"]
}
```

Supported JSON Schema types: `string`, `number`, `boolean`, `object`, `array`, `null`.

## `transportType`

| Value | Description |
|-------|-------------|
| `"mcp"` | Tool is served via MCP protocol |
| `"http"` | Tool is called via a plain HTTP endpoint |
| `"local"` | Tool is a local JavaScript function |

For most use cases with the CLI and built-in MCP server, use `"mcp"`.

## Full example manifest

```json
{
  "id": "github",
  "name": "GitHub",
  "transportType": "mcp",
  "description": "GitHub repository management, code search, and issue tracking",
  "tools": [
    {
      "name": "search_code",
      "description": "Search for code across GitHub repositories using a text query",
      "providerId": "github",
      "transportType": "mcp",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "Search query"
          },
          "language": {
            "type": "string",
            "description": "Programming language filter"
          },
          "repo": {
            "type": "string",
            "description": "Limit search to this repository (owner/name)"
          }
        },
        "required": ["query"]
      }
    },
    {
      "name": "create_issue",
      "description": "Create a new issue in a GitHub repository",
      "providerId": "github",
      "transportType": "mcp",
      "inputSchema": {
        "type": "object",
        "properties": {
          "title": {
            "type": "string",
            "description": "Issue title"
          },
          "body": {
            "type": "string",
            "description": "Issue body in markdown"
          },
          "repo": {
            "type": "string",
            "description": "Repository (owner/name)"
          },
          "labels": {
            "type": "string",
            "description": "Comma-separated label names"
          }
        },
        "required": ["title", "repo"]
      }
    }
  ]
}
```
