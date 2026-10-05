import { readFileSync } from 'node:fs';
import { db } from './database.js';

const SCHEMA_VERSION = 2;

/**
 * 版本化迁移：schema_version 表记录当前版本，按序执行未应用的迁移。
 * 设计要点：
 *   - v1 用 schema.sql（全部 IF NOT EXISTS，可安全重放）建表；
 *   - v2+ 用增量 ALTER（SQLite 无 ADD COLUMN IF NOT EXISTS，需先探测列是否存在），
 *     保证已有数据库平滑升级，不丢数据。
 */
type Migration = { version: number; name: string; up: () => void };

function columnExists(table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

function addColumnIfMissing(table: string, column: string, ddl: string): void {
  if (columnExists(table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'base schema',
    up: () => {
      const sql = readFileSync(new URL('schema.sql', import.meta.url), 'utf-8');
      db.exec(sql);
    },
  },
  {
    version: 2,
    name: 'retry/attempt columns (step-level + job-level retry)',
    up: () => {
      addColumnIfMissing('jobs', 'attempt', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing('jobs', 'max_attempts', 'INTEGER NOT NULL DEFAULT 1');
      addColumnIfMissing('steps', 'attempt', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
];

export function runMigrations(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
  const row = db.prepare(`SELECT version FROM schema_version LIMIT 1`).get() as
    | { version: number }
    | undefined;
  const current = row?.version ?? 0;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      m.up();
      db.prepare(`DELETE FROM schema_version`).run();
      db.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(m.version);
    })();
    console.log(`[migrate] applied v${m.version} — ${m.name}`);
  }
}

// 允许 `tsx src/db/migrate.ts` 单独执行
if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  runMigrations();
  console.log('[migrate] done');
}
