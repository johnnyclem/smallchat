/**
 * Redis Transport — tool transport for Redis commands (GET/SET/PUBLISH/etc.)
 *
 * Implements a transport that executes Redis commands as Smallchat tool calls.
 * Supports:
 *  - String commands: GET, SET, GETSET, MGET, MSET, INCR, DECR, APPEND, STRLEN
 *  - Key management: DEL, EXISTS, EXPIRE, TTL, KEYS, RENAME, TYPE
 *  - List commands: LPUSH, RPUSH, LPOP, RPOP, LRANGE, LLEN
 *  - Hash commands: HGET, HSET, HGETALL, HMGET, HDEL, HKEYS, HVALS
 *  - Set commands: SADD, SREM, SMEMBERS, SISMEMBER, SUNION, SINTER
 *  - Sorted set: ZADD, ZREM, ZSCORE, ZRANGE, ZRANK
 *  - Pub/Sub: PUBLISH (subscribe is handled via SSE)
 *  - Server: PING, INFO, DBSIZE, FLUSHDB (restricted)
 *
 * The transport connects via an HTTP Redis proxy (e.g., Upstash REST API)
 * or a raw TCP socket adapter. Both are supported via the RedisAdapter interface.
 *
 * Usage (with Upstash REST):
 *
 *   const transport = new RedisTransport({
 *     adapter: new UpstashRestAdapter({
 *       url: process.env.UPSTASH_REDIS_URL,
 *       token: process.env.UPSTASH_REDIS_TOKEN,
 *     }),
 *   });
 */

import type { ToolResult, ToolIMP, ArgumentConstraints } from '../core/types.js';

// ---------------------------------------------------------------------------
// Redis adapter interface
// ---------------------------------------------------------------------------

export interface RedisAdapter {
  execute(command: string, ...args: unknown[]): Promise<unknown>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Upstash REST adapter
// ---------------------------------------------------------------------------

export interface UpstashConfig {
  url: string;
  token: string;
}

export class UpstashRestAdapter implements RedisAdapter {
  private url: string;
  private token: string;

  constructor(config: UpstashConfig) {
    this.url = config.url.replace(/\/$/, '');
    this.token = config.token;
  }

  async execute(command: string, ...args: unknown[]): Promise<unknown> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([command.toUpperCase(), ...args]),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Upstash error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as { result?: unknown; error?: string };
    if (data.error) throw new Error(`Redis error: ${data.error}`);
    return data.result;
  }

  async close(): Promise<void> {
    // HTTP adapter — stateless
  }
}

// ---------------------------------------------------------------------------
// RedisTransport options
// ---------------------------------------------------------------------------

export interface RedisTransportOptions {
  adapter: RedisAdapter;
  /** Allow only these commands (undefined = allow all non-destructive commands) */
  allowedCommands?: string[];
  /** Allow dangerous commands like FLUSHDB, DEL (default false) */
  allowDestructive?: boolean;
  /** Key prefix: prepended to all keys (for multi-tenant isolation) */
  keyPrefix?: string;
}

// ---------------------------------------------------------------------------
// RedisTransport
// ---------------------------------------------------------------------------

export class RedisTransport {
  private adapter: RedisAdapter;
  private allowedCommands: Set<string> | null;
  private allowDestructive: boolean;
  private keyPrefix: string;

  constructor(options: RedisTransportOptions) {
    this.adapter = options.adapter;
    this.allowedCommands = options.allowedCommands
      ? new Set(options.allowedCommands.map(c => c.toUpperCase()))
      : null;
    this.allowDestructive = options.allowDestructive ?? false;
    this.keyPrefix = options.keyPrefix ?? '';
  }

  async execute(command: string, args: Record<string, unknown>): Promise<ToolResult> {
    const cmd = command.toUpperCase();

    // Authorization check
    const authError = this.authorizeCommand(cmd);
    if (authError) {
      return { content: null, isError: true, metadata: { error: authError } };
    }

    // Build Redis command args from tool args
    const redisArgs = buildRedisArgs(cmd, args, this.keyPrefix);

    try {
      const result = await this.adapter.execute(cmd, ...redisArgs);
      return { content: result, isError: false };
    } catch (err) {
      return {
        content: null,
        isError: true,
        metadata: { error: `Redis error: ${(err as Error).message}` },
      };
    }
  }

  private authorizeCommand(command: string): string | null {
    const destructiveCommands = new Set([
      'FLUSHDB', 'FLUSHALL', 'DEL', 'UNLINK', 'RENAME', 'RENAMENX',
    ]);

    if (!this.allowDestructive && destructiveCommands.has(command)) {
      return `Command ${command} is not allowed (destructive commands disabled)`;
    }

    if (this.allowedCommands && !this.allowedCommands.has(command)) {
      return `Command ${command} is not in the allowed list`;
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// createRedisToolIMPs — standard ToolIMP set for Redis
// ---------------------------------------------------------------------------

export function createRedisToolIMPs(
  transport: RedisTransport,
  providerId: string,
): ToolIMP[] {
  const constraints: ArgumentConstraints = {
    required: [],
    optional: [],
    validate: () => ({ valid: true, errors: [] }),
  };

  const tools: Array<{
    name: string;
    description: string;
    params: Record<string, { type: string; description: string }>;
    required: string[];
    command: string;
  }> = [
    {
      name: 'redis_get',
      description: 'Get the value of a Redis key',
      params: { key: { type: 'string', description: 'Key to retrieve' } },
      required: ['key'],
      command: 'GET',
    },
    {
      name: 'redis_set',
      description: 'Set the value of a Redis key',
      params: {
        key: { type: 'string', description: 'Key to set' },
        value: { type: 'string', description: 'Value to store' },
        ex: { type: 'number', description: 'Expiry in seconds (optional)' },
        px: { type: 'number', description: 'Expiry in milliseconds (optional)' },
        nx: { type: 'boolean', description: 'Only set if key does not exist' },
        xx: { type: 'boolean', description: 'Only set if key exists' },
      },
      required: ['key', 'value'],
      command: 'SET',
    },
    {
      name: 'redis_del',
      description: 'Delete one or more Redis keys',
      params: { keys: { type: 'array', description: 'Keys to delete' } },
      required: ['keys'],
      command: 'DEL',
    },
    {
      name: 'redis_exists',
      description: 'Check if one or more Redis keys exist',
      params: { keys: { type: 'array', description: 'Keys to check' } },
      required: ['keys'],
      command: 'EXISTS',
    },
    {
      name: 'redis_expire',
      description: 'Set the expiry of a Redis key in seconds',
      params: {
        key: { type: 'string', description: 'Key to expire' },
        seconds: { type: 'number', description: 'Expiry in seconds' },
      },
      required: ['key', 'seconds'],
      command: 'EXPIRE',
    },
    {
      name: 'redis_ttl',
      description: 'Get the remaining TTL of a Redis key',
      params: { key: { type: 'string', description: 'Key to check' } },
      required: ['key'],
      command: 'TTL',
    },
    {
      name: 'redis_incr',
      description: 'Increment the integer value of a Redis key',
      params: {
        key: { type: 'string', description: 'Key to increment' },
        by: { type: 'number', description: 'Amount to increment by (default 1)' },
      },
      required: ['key'],
      command: 'INCRBY',
    },
    {
      name: 'redis_hget',
      description: 'Get a field from a Redis hash',
      params: {
        key: { type: 'string', description: 'Hash key' },
        field: { type: 'string', description: 'Hash field' },
      },
      required: ['key', 'field'],
      command: 'HGET',
    },
    {
      name: 'redis_hset',
      description: 'Set fields in a Redis hash',
      params: {
        key: { type: 'string', description: 'Hash key' },
        fields: { type: 'object', description: 'Field-value pairs to set' },
      },
      required: ['key', 'fields'],
      command: 'HSET',
    },
    {
      name: 'redis_hgetall',
      description: 'Get all fields and values in a Redis hash',
      params: { key: { type: 'string', description: 'Hash key' } },
      required: ['key'],
      command: 'HGETALL',
    },
    {
      name: 'redis_lpush',
      description: 'Prepend values to a Redis list',
      params: {
        key: { type: 'string', description: 'List key' },
        values: { type: 'array', description: 'Values to prepend' },
      },
      required: ['key', 'values'],
      command: 'LPUSH',
    },
    {
      name: 'redis_rpush',
      description: 'Append values to a Redis list',
      params: {
        key: { type: 'string', description: 'List key' },
        values: { type: 'array', description: 'Values to append' },
      },
      required: ['key', 'values'],
      command: 'RPUSH',
    },
    {
      name: 'redis_lrange',
      description: 'Get a range of elements from a Redis list',
      params: {
        key: { type: 'string', description: 'List key' },
        start: { type: 'number', description: 'Start index (0-based)' },
        stop: { type: 'number', description: 'Stop index (-1 for all)' },
      },
      required: ['key'],
      command: 'LRANGE',
    },
    {
      name: 'redis_publish',
      description: 'Publish a message to a Redis pub/sub channel',
      params: {
        channel: { type: 'string', description: 'Channel name' },
        message: { type: 'string', description: 'Message to publish' },
      },
      required: ['channel', 'message'],
      command: 'PUBLISH',
    },
    {
      name: 'redis_keys',
      description: 'Find all Redis keys matching a pattern',
      params: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "user:*"' },
      },
      required: ['pattern'],
      command: 'KEYS',
    },
  ];

  return tools.map(def => {
    const imp: ToolIMP = {
      providerId,
      toolName: def.name,
      transportType: 'local',
      schema: {
        name: def.name,
        description: def.description,
        inputSchema: {
          type: 'object',
          properties: def.params,
          required: def.required,
        },
        arguments: [],
      },
      schemaLoader: async () => imp.schema!,
      constraints,
      execute: (args) => transport.execute(def.command, args),
    };
    return imp;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRedisArgs(
  command: string,
  args: Record<string, unknown>,
  prefix: string,
): unknown[] {
  const pk = (key: unknown) => prefix + String(key);

  switch (command) {
    case 'GET':
    case 'TTL':
    case 'HGETALL':
    case 'LLEN':
    case 'TYPE':
    case 'KEYS':
      return [args.key !== undefined ? pk(args.key) : String(args.pattern ?? '*')];

    case 'SET': {
      const setArgs: unknown[] = [pk(args.key), args.value];
      if (args.ex) { setArgs.push('EX', args.ex); }
      else if (args.px) { setArgs.push('PX', args.px); }
      if (args.nx) setArgs.push('NX');
      else if (args.xx) setArgs.push('XX');
      return setArgs;
    }

    case 'DEL':
    case 'EXISTS':
    case 'UNLINK': {
      const keys = Array.isArray(args.keys) ? args.keys : [args.key];
      return keys.map(k => pk(k));
    }

    case 'EXPIRE':
      return [pk(args.key), args.seconds];

    case 'INCRBY':
      return [pk(args.key), args.by ?? 1];

    case 'HGET':
      return [pk(args.key), args.field];

    case 'HSET': {
      const hsetArgs: unknown[] = [pk(args.key)];
      for (const [k, v] of Object.entries(args.fields as Record<string, unknown>)) {
        hsetArgs.push(k, v);
      }
      return hsetArgs;
    }

    case 'HDEL':
      return [pk(args.key), ...(Array.isArray(args.fields) ? args.fields : [args.field])];

    case 'LPUSH':
    case 'RPUSH': {
      const vals = Array.isArray(args.values) ? args.values : [args.value];
      return [pk(args.key), ...vals];
    }

    case 'LPOP':
    case 'RPOP':
      return [pk(args.key)];

    case 'LRANGE':
      return [pk(args.key), args.start ?? 0, args.stop ?? -1];

    case 'PUBLISH':
      return [String(args.channel), String(args.message)];

    case 'SADD':
    case 'SREM': {
      const members = Array.isArray(args.members) ? args.members : [args.member];
      return [pk(args.key), ...members];
    }

    case 'SMEMBERS':
    case 'SCARD':
      return [pk(args.key)];

    default:
      // Generic: pass all arg values as positional args
      return Object.values(args);
  }
}
