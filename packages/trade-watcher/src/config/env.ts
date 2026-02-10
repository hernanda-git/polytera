import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  POLYGON_RPC_WSS: z
    .string()
    .url()
    .startsWith('wss://', 'Must be a WebSocket URL (wss://)'),
  POLYGON_RPC_HTTP: z
    .string()
    .url()
    .startsWith('https://', 'Must be an HTTPS URL'),
  EXPERT_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid Ethereum address'),
  DB_PATH: z.string().default('./data/trade-watcher.db'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  /** If set, all CLI output is also written to this file (plain text). */
  LOG_FILE: z.string().optional(),
  CLOB_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  HEALTH_PORT: z.coerce.number().int().positive().default(3100),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function loadEnv(): Env {
  if (_env) return _env;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment configuration:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  _env = result.data;
  return _env;
}
