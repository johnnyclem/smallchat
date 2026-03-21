---
title: Example Manifests
sidebar_label: Example Manifests
---

# Example Manifests

The `examples/` directory in the smallchat repository contains ready-to-use manifests for common providers. Below are four representative examples.

## GitHub

File: `examples/github-manifest.json`

```json
{
  "id": "github",
  "name": "GitHub",
  "transportType": "mcp",
  "tools": [
    {
      "name": "search_code",
      "description": "Search for code across GitHub repositories",
      "providerId": "github",
      "transportType": "mcp",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "Search query" },
          "language": { "type": "string", "description": "Programming language filter" },
          "repo": { "type": "string", "description": "Repository to search in" }
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
          "title": { "type": "string", "description": "Issue title" },
          "body": { "type": "string", "description": "Issue body in markdown" },
          "repo": { "type": "string", "description": "Repository (owner/name)" },
          "labels": { "type": "string", "description": "Comma-separated labels" }
        },
        "required": ["title", "repo"]
      }
    },
    {
      "name": "list_pull_requests",
      "description": "List pull requests for a repository",
      "providerId": "github",
      "transportType": "mcp",
      "inputSchema": {
        "type": "object",
        "properties": {
          "repo": { "type": "string", "description": "Repository (owner/name)" },
          "state": {
            "type": "string",
            "description": "Filter by state",
            "enum": ["open", "closed", "all"]
          },
          "sort": {
            "type": "string",
            "description": "Sort by",
            "enum": ["created", "updated", "popularity"]
          }
        },
        "required": ["repo"]
      }
    }
  ]
}
```

## Filesystem

File: `examples/filesystem-manifest.json`

```json
{
  "id": "filesystem",
  "name": "Filesystem",
  "transportType": "mcp",
  "description": "Secure file operations with configurable access controls",
  "tools": [
    {
      "name": "read_file",
      "description": "Read the complete contents of a file from the file system",
      "providerId": "filesystem",
      "transportType": "mcp",
      "inputSchema": {
        "type": "object",
        "properties": {
          "path": { "type": "string", "description": "Path to the file to read" }
        },
        "required": ["path"]
      }
    },
    {
      "name": "write_file",
      "description": "Create a new file or overwrite an existing file with new contents",
      "providerId": "filesystem",
      "transportType": "mcp",
      "inputSchema": {
        "type": "object",
        "properties": {
          "path": { "type": "string", "description": "Path to the file to write" },
          "content": { "type": "string", "description": "Content to write" }
        },
        "required": ["path", "content"]
      }
    },
    {
      "name": "search_files",
      "description": "Recursively search for files and directories matching a pattern",
      "providerId": "filesystem",
      "transportType": "mcp",
      "inputSchema": {
        "type": "object",
        "properties": {
          "path": { "type": "string", "description": "Starting directory" },
          "pattern": { "type": "string", "description": "Glob pattern" },
          "excludePatterns": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Patterns to exclude"
          }
        },
        "required": ["path", "pattern"]
      }
    },
    {
      "name": "list_directory",
      "description": "List files and directories at a given path",
      "providerId": "filesystem",
      "transportType": "mcp",
      "inputSchema": {
        "type": "object",
        "properties": {
          "path": { "type": "string", "description": "Directory path" }
        },
        "required": ["path"]
      }
    }
  ]
}
```

## Fetch

File: `examples/fetch-manifest.json`

```json
{
  "id": "fetch",
  "name": "Fetch",
  "transportType": "mcp",
  "description": "Web content fetching and conversion for efficient LLM usage",
  "tools": [
    {
      "name": "fetch",
      "description": "Fetch a URL from the internet and extract its contents as markdown",
      "providerId": "fetch",
      "transportType": "mcp",
      "inputSchema": {
        "type": "object",
        "properties": {
          "url": { "type": "string", "description": "URL to fetch" },
          "maxLength": {
            "type": "number",
            "description": "Maximum characters to return"
          },
          "startIndex": {
            "type": "number",
            "description": "Start content from this character index"
          },
          "raw": {
            "type": "boolean",
            "description": "Return raw HTML instead of markdown"
          }
        },
        "required": ["url"]
      }
    }
  ]
}
```

## Slack

File: `examples/slack-manifest.json`

```json
{
  "id": "slack",
  "name": "Slack",
  "transportType": "mcp",
  "tools": [
    {
      "name": "search_messages",
      "description": "Search for messages in Slack channels",
      "providerId": "slack",
      "transportType": "mcp",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "Search query" },
          "channel": { "type": "string", "description": "Channel to search" },
          "from": { "type": "string", "description": "Filter by sender" }
        },
        "required": ["query"]
      }
    },
    {
      "name": "send_message",
      "description": "Send a message to a Slack channel",
      "providerId": "slack",
      "transportType": "mcp",
      "inputSchema": {
        "type": "object",
        "properties": {
          "channel": { "type": "string", "description": "Channel ID or name" },
          "text": { "type": "string", "description": "Message text" }
        },
        "required": ["channel", "text"]
      }
    }
  ]
}
```

## More examples

The `examples/` directory contains 30+ manifests for popular services:

| Manifest | Provider |
|----------|---------|
| `atlassian-manifest.json` | Jira, Confluence |
| `aws-manifest.json` | AWS services |
| `elasticsearch-manifest.json` | Elasticsearch |
| `figma-manifest.json` | Figma design API |
| `git-manifest.json` | Local git operations |
| `gitlab-manifest.json` | GitLab |
| `google-drive-manifest.json` | Google Drive |
| `linear-manifest.json` | Linear issues |
| `notion-manifest.json` | Notion |
| `postgres-manifest.json` | PostgreSQL |
| `redis-manifest.json` | Redis |
| `stripe-manifest.json` | Stripe payments |

See the full list in the [`examples/`](https://github.com/johnnyclem/smallchat/tree/main/examples) directory.
