/**
 * One-off safety net: export everything currently readable from the Supabase
 * project into backup/ before the schema is dropped and rebuilt.
 *
 *   node backup-before-wipe.mjs
 *
 * Uses the anon key on purpose -- it can only read what RLS already allows, so
 * this is a best-effort snapshot of the public content, not a privileged dump.
 */
import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync } from 'node:fs';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_ANON_KEY first.');
  process.exit(1);
}

const TABLES = ['articles', 'top_performers'];
const supabase = createClient(url, key, { auth: { persistSession: false } });

mkdirSync('backup', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const summary = {};

for (const table of TABLES) {
  const { data, error } = await supabase.from(table).select('*');
  if (error) {
    console.log(`  SKIP  ${table}: ${error.message}`);
    continue;
  }
  const file = `backup/${table}-${stamp}.json`;
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  summary[table] = { rows: data.length, file };
  console.log(`  OK    ${table}: ${data.length} rows -> ${file}`);
}

writeFileSync(
  `backup/manifest-${stamp}.json`,
  JSON.stringify({ exportedAt: new Date().toISOString(), project: url, ...summary }, null, 2),
  'utf8'
);

console.log('\nBackup complete. Keep the backup/ folder until the rebuild is verified.');
