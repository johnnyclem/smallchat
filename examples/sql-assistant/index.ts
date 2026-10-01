import { DispatchError, loadRuntime, registerLocalHandler } from '@smallchat/core';
import type { ToolResult } from '@smallchat/core';

// An in-memory stand-in for the database behind the tools declared in
// manifest.json (transportType 'local').
const tables: Record<string, Array<Record<string, unknown>>> = {
  users: [{ id: 1, name: 'Ada', email: 'ada@example.com', active: true }],
};
registerLocalHandler('query', async (args): Promise<ToolResult> => ({
  content: { sql: args.sql, rows: tables.users.slice(0, Number(args.limit ?? 100)) },
}));
registerLocalHandler('list_tables', async (): Promise<ToolResult> => ({ content: Object.keys(tables) }));
registerLocalHandler('describe_table', async (args): Promise<ToolResult> => ({
  content: Object.keys(tables[String(args.table)]?.[0] ?? {}),
}));
registerLocalHandler('insert_row', async (args): Promise<ToolResult> => {
  const rows = (tables[String(args.table)] ??= []);
  rows.push(args.data as Record<string, unknown>);
  return { content: { inserted: 1, table: args.table } };
});

async function main() {
  // Compile this directory's manifest in-process with the default embedder.
  const { runtime, upstreams } = await loadRuntime(import.meta.dirname);

  const intents = [
    { intent: 'execute a SQL query against the database', args: { sql: 'SELECT * FROM users WHERE active = true', limit: 10 } },
    { intent: 'list all tables in the database', args: { schema: 'public' } },
    { intent: 'insert a new row into a table', args: { table: 'users', data: { name: 'Alice', email: 'alice@example.com' } } },
    { intent: 'describe the users table schema', args: { table: 'users' } },
  ];

  try {
    for (const { intent, args } of intents) {
      console.log(`Intent: "${intent}"`);
      try {
        // execContent() returns the content of a tool that ran and succeeded,
        // and throws DispatchError for anything else.
        const content = await runtime.intent(intent).withArgs(args).execContent();
        console.log(`  Result: ${JSON.stringify(content)}\n`);
      } catch (err) {
        if (!(err instanceof DispatchError)) throw err;
        console.log(`  ${err.outcome}: ${err.message}`);
        if (err.outcome === 'needs-disambiguation' && err.candidates.length > 0) {
          // The caller chooses by exact tool id; here, the top candidate.
          const result = await runtime.dispatchById(err.candidates[0], args);
          console.log(`  ran ${err.candidates[0]} by id → ${JSON.stringify(result.content)}`);
        }
        console.log('');
      }
    }
  } finally {
    await upstreams.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
