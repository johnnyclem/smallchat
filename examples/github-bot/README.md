# GitHub Bot Example

A GitHub-integrated bot that uses smallchat to dispatch intents like "create issue",
"list pull requests", and "search code".

## Setup

```bash
cd examples/github-bot
npm install
export GITHUB_TOKEN=your_token_here
npm start
```

## Tools

- **create_issue** — Create a GitHub issue in a repository
- **list_pull_requests** — List open pull requests
- **search_code** — Search code across repositories
- **get_repo_info** — Get repository metadata

## How It Works

The bot compiles the GitHub manifest, starts a runtime, and dispatches natural
language intents to the appropriate GitHub API tool.
