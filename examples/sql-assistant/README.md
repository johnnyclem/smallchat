# SQL Assistant Example

An assistant that uses smallchat to dispatch database-related intents like
"query the database", "list tables", and "describe a table schema".

## Run

From the repository root (Node 22+):

```bash
npm install && npm run build
node --experimental-strip-types examples/sql-assistant/index.ts   # Node 24: plain `node`
```

The tools are compiled from `manifest.json` in-process with the default
(ONNX) embedder, as `smallchat serve --source examples/sql-assistant` would.

## Tools

- **query** — Execute a SQL query against the database
- **list_tables** — List all tables in the database
- **describe_table** — Get the schema/columns for a specific table
- **insert_row** — Insert a new row into a table

## How It Works

The tools are `local` handlers over an in-memory table registered in
`index.ts`, so no database is needed.

Each intent goes through the fluent API's `execContent()`, which returns the
content of a tool that ran and succeeded and throws `DispatchError` for
anything else. The error carries the `outcome` and the candidate tool ids:
for `needs-disambiguation` the example runs the top candidate by exact id,
the way a host would after the user picked it; an `unresolved` intent runs
nothing.
