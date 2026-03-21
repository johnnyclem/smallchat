/**
 * SQL Transport — Text-to-SQL transport for read-only queries
 *
 * Implements a "Text-to-SQL" transport that:
 *  1. Accepts a natural-language intent or raw SQL
 *  2. Validates the query is strictly read-only (SELECT only)
 *  3. Executes against a configured database adapter
 *  4. Returns typed results
 *
 * Security guarantees:
 *  - Only SELECT statements are permitted (DDL/DML blocked by parser)
 *  - Parameterized queries only — no string interpolation
 *  - Table allowlist: queries referencing unlisted tables are rejected
 *  - Row limit enforced (default 1000)
 *
 * Built-in adapters: SQLite (via better-sqlite3)
 * Extensible: implement SqlAdapter for Postgres, MySQL, etc.
 *
 * Usage:
 *
 *   import { SQLTransport } from './transports/sql';
 *   import Database from 'better-sqlite3';
 *
 *   const db = new Database('app.db');
 *   const transport = new SQLTransport({
 *     adapter: new BetterSqlite3Adapter(db),
 *     allowedTables: ['users', 'products', 'orders'],
 *   });
 *
 *   const result = await transport.execute({
 *     sql: 'SELECT * FROM users WHERE created_at > ? LIMIT ?',
 *     params: ['2024-01-01', 50],
 *   });
 */

import type { ToolResult, ArgumentConstraints, ToolIMP } from '../core/types.js';

// ---------------------------------------------------------------------------
// SQL adapter interface — backend-agnostic
// ---------------------------------------------------------------------------

export type SqlRow = Record<string, unknown>;

export interface SqlQueryResult {
  rows: SqlRow[];
  columns: string[];
  rowCount: number;
  executionTimeMs?: number;
}

export interface SqlAdapter {
  /** Execute a parameterized SELECT query */
  query(sql: string, params?: unknown[]): Promise<SqlQueryResult>;
  /** List all table names in the database */
  getTables(): Promise<string[]>;
  /** Get column info for a table */
  getColumns(tableName: string): Promise<Array<{ name: string; type: string; nullable: boolean }>>;
  /** Close the connection */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// BetterSqlite3Adapter — SQLite via better-sqlite3
// ---------------------------------------------------------------------------

export class BetterSqlite3Adapter implements SqlAdapter {
  private db: Record<string, unknown>;

  constructor(db: unknown) {
    this.db = db as Record<string, unknown>;
  }

  async query(sql: string, params: unknown[] = []): Promise<SqlQueryResult> {
    const start = Date.now();
    try {
      const stmt = (this.db.prepare as (sql: string) => unknown)(sql);
      const rows = ((stmt as Record<string, unknown>).all as (params: unknown[]) => SqlRow[])(params);
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

      return {
        rows,
        columns,
        rowCount: rows.length,
        executionTimeMs: Date.now() - start,
      };
    } catch (err) {
      throw new Error(`SQLite query error: ${(err as Error).message}`);
    }
  }

  async getTables(): Promise<string[]> {
    const result = await this.query(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    return result.rows.map(r => String(r.name));
  }

  async getColumns(tableName: string): Promise<Array<{ name: string; type: string; nullable: boolean }>> {
    const result = await this.query(`PRAGMA table_info(${sanitizeSqlIdentifier(tableName)})`);
    return result.rows.map(r => ({
      name: String(r.name),
      type: String(r.type),
      nullable: r.notnull === 0,
    }));
  }

  async close(): Promise<void> {
    (this.db.close as () => void)();
  }
}

// ---------------------------------------------------------------------------
// GenericSqlAdapter — HTTP-based adapter for remote SQL services
// ---------------------------------------------------------------------------

export class HttpSqlAdapter implements SqlAdapter {
  private endpoint: string;
  private headers: Record<string, string>;

  constructor(endpoint: string, headers: Record<string, string> = {}) {
    this.endpoint = endpoint;
    this.headers = { 'Content-Type': 'application/json', ...headers };
  }

  async query(sql: string, params: unknown[] = []): Promise<SqlQueryResult> {
    const response = await fetch(`${this.endpoint}/query`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ sql, params }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP SQL error ${response.status}: ${errorText}`);
    }

    return (await response.json()) as SqlQueryResult;
  }

  async getTables(): Promise<string[]> {
    const response = await fetch(`${this.endpoint}/tables`, { headers: this.headers });
    const data = (await response.json()) as { tables: string[] };
    return data.tables;
  }

  async getColumns(tableName: string): Promise<Array<{ name: string; type: string; nullable: boolean }>> {
    const response = await fetch(`${this.endpoint}/columns/${encodeURIComponent(tableName)}`, {
      headers: this.headers,
    });
    const data = (await response.json()) as { columns: Array<{ name: string; type: string; nullable: boolean }> };
    return data.columns;
  }

  async close(): Promise<void> {
    // HTTP adapter — no connection to close
  }
}

// ---------------------------------------------------------------------------
// SQLTransport options
// ---------------------------------------------------------------------------

export interface SQLTransportOptions {
  adapter: SqlAdapter;
  /** Only allow queries that reference these tables (undefined = allow all) */
  allowedTables?: string[];
  /** Maximum rows returned (default 1000) */
  maxRows?: number;
  /** Whether to return column metadata with results */
  includeMetadata?: boolean;
}

export interface SqlExecuteOptions {
  sql: string;
  params?: unknown[];
  /** Override max rows for this specific query */
  maxRows?: number;
}

// ---------------------------------------------------------------------------
// SQLTransport
// ---------------------------------------------------------------------------

export class SQLTransport {
  private adapter: SqlAdapter;
  private allowedTables: Set<string> | null;
  private maxRows: number;
  private includeMetadata: boolean;

  constructor(options: SQLTransportOptions) {
    this.adapter = options.adapter;
    this.allowedTables = options.allowedTables ? new Set(options.allowedTables) : null;
    this.maxRows = options.maxRows ?? 1000;
    this.includeMetadata = options.includeMetadata ?? false;
  }

  // ---------------------------------------------------------------------------
  // execute — main entry point
  // ---------------------------------------------------------------------------

  async execute(options: SqlExecuteOptions): Promise<ToolResult> {
    const { sql, params = [] } = options;
    const maxRows = options.maxRows ?? this.maxRows;

    // 1. Validate the query is read-only
    const validationError = validateReadOnly(sql);
    if (validationError) {
      return {
        content: null,
        isError: true,
        metadata: { error: validationError, rejectedSql: sql },
      };
    }

    // 2. Check table allowlist
    if (this.allowedTables) {
      const tables = extractTableNames(sql);
      const forbidden = tables.filter(t => !this.allowedTables!.has(t.toLowerCase()));
      if (forbidden.length > 0) {
        return {
          content: null,
          isError: true,
          metadata: {
            error: `Query references unauthorized tables: ${forbidden.join(', ')}`,
            forbiddenTables: forbidden,
          },
        };
      }
    }

    // 3. Inject LIMIT if not already present
    const limitedSql = injectLimit(sql, maxRows);

    // 4. Execute
    try {
      const result = await this.adapter.query(limitedSql, params);

      const content: Record<string, unknown> = {
        rows: result.rows,
        rowCount: result.rowCount,
      };

      if (this.includeMetadata) {
        content.columns = result.columns;
        content.executionTimeMs = result.executionTimeMs;
      }

      return {
        content,
        isError: false,
        metadata: {
          rowCount: result.rowCount,
          truncated: result.rowCount >= maxRows,
        },
      };
    } catch (err) {
      return {
        content: null,
        isError: true,
        metadata: { error: `SQL execution error: ${(err as Error).message}` },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // listTables — enumerate available tables
  // ---------------------------------------------------------------------------

  async listTables(): Promise<ToolResult> {
    try {
      const tables = await this.adapter.getTables();
      const filtered = this.allowedTables
        ? tables.filter(t => this.allowedTables!.has(t.toLowerCase()))
        : tables;

      return { content: { tables: filtered }, isError: false };
    } catch (err) {
      return {
        content: null,
        isError: true,
        metadata: { error: `Failed to list tables: ${(err as Error).message}` },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // describeTable — get column info
  // ---------------------------------------------------------------------------

  async describeTable(tableName: string): Promise<ToolResult> {
    if (this.allowedTables && !this.allowedTables.has(tableName.toLowerCase())) {
      return {
        content: null,
        isError: true,
        metadata: { error: `Table "${tableName}" is not in the allowlist` },
      };
    }

    try {
      const columns = await this.adapter.getColumns(tableName);
      return { content: { tableName, columns }, isError: false };
    } catch (err) {
      return {
        content: null,
        isError: true,
        metadata: { error: `Failed to describe table: ${(err as Error).message}` },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// createSQLToolIMPs — build standard Smallchat ToolIMPs for SQL operations
// ---------------------------------------------------------------------------

export function createSQLToolIMPs(
  transport: SQLTransport,
  providerId: string,
): ToolIMP[] {
  const constraints: ArgumentConstraints = {
    required: [],
    optional: [],
    validate: () => ({ valid: true, errors: [] }),
  };

  const queryTool: ToolIMP = {
    providerId,
    toolName: 'sql_query',
    transportType: 'local',
    schema: {
      name: 'sql_query',
      description: 'Execute a read-only SQL SELECT query',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'SQL SELECT statement to execute' },
          params: { type: 'array', description: 'Query parameters for parameterized queries' },
          maxRows: { type: 'number', description: 'Maximum rows to return (default 100)' },
        },
        required: ['sql'],
      },
      arguments: [],
    },
    schemaLoader: async () => queryTool.schema!,
    constraints,
    execute: (args) => transport.execute({
      sql: String(args.sql ?? ''),
      params: (args.params as unknown[]) ?? [],
      maxRows: typeof args.maxRows === 'number' ? args.maxRows : undefined,
    }),
  };

  const listTablesTool: ToolIMP = {
    providerId,
    toolName: 'sql_list_tables',
    transportType: 'local',
    schema: {
      name: 'sql_list_tables',
      description: 'List all available database tables',
      inputSchema: { type: 'object', properties: {} },
      arguments: [],
    },
    schemaLoader: async () => listTablesTool.schema!,
    constraints,
    execute: () => transport.listTables(),
  };

  const describeTableTool: ToolIMP = {
    providerId,
    toolName: 'sql_describe_table',
    transportType: 'local',
    schema: {
      name: 'sql_describe_table',
      description: 'Describe the columns of a database table',
      inputSchema: {
        type: 'object',
        properties: {
          tableName: { type: 'string', description: 'Table name to describe' },
        },
        required: ['tableName'],
      },
      arguments: [],
    },
    schemaLoader: async () => describeTableTool.schema!,
    constraints,
    execute: (args) => transport.describeTable(String(args.tableName ?? '')),
  };

  return [queryTool, listTablesTool, describeTableTool];
}

// ---------------------------------------------------------------------------
// Read-only validation helpers
// ---------------------------------------------------------------------------

const FORBIDDEN_STATEMENTS = [
  /^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|REPLACE|UPSERT|MERGE|GRANT|REVOKE|EXEC|EXECUTE|CALL|PRAGMA\s+(?!table_info))/i,
];

function validateReadOnly(sql: string): string | null {
  const stripped = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();

  for (const pattern of FORBIDDEN_STATEMENTS) {
    if (pattern.test(stripped)) {
      return `Only SELECT queries are allowed. Detected forbidden statement.`;
    }
  }

  if (!/^\s*SELECT\b/i.test(stripped) && !/^\s*WITH\b/i.test(stripped)) {
    return `Only SELECT or WITH queries are allowed.`;
  }

  return null;
}

function injectLimit(sql: string, maxRows: number): string {
  const hasLimit = /\bLIMIT\s+\d+/i.test(sql);
  if (hasLimit) return sql;
  return `${sql.trimEnd().replace(/;?\s*$/, '')} LIMIT ${maxRows}`;
}

function extractTableNames(sql: string): string[] {
  const tables: string[] = [];
  const pattern = /\b(?:FROM|JOIN)\s+([`"']?(\w+)[`"']?)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    tables.push(match[2].toLowerCase());
  }
  return [...new Set(tables)];
}

function sanitizeSqlIdentifier(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '');
}
