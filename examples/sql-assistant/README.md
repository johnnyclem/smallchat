# SQL Assistant Example

An assistant that uses smallchat to dispatch database-related intents like
"query the database", "list tables", and "describe a table schema".

## Setup

```bash
cd examples/sql-assistant
npm install
npm start
```

## Tools

- **query** — Execute a SQL query against the database
- **list_tables** — List all tables in the database
- **describe_table** — Get the schema/columns for a specific table
- **insert_row** — Insert a new row into a table

## How It Works

This example uses the `@smallchat/testing` mock utilities to simulate
database tools without a real database connection, making it ideal for
development and testing.
