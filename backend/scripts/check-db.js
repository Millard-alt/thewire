/* Diagnose DATABASE_URL. Run: npm run check-db
   It never prints your password — only the parsed host/user/port and the exact
   reason a connection fails. */
require('dotenv').config();
const dns = require('dns');
const { Pool } = require('pg');

const url = (process.env.DATABASE_URL || '').trim();
const line = (s) => process.stdout.write(s + '\n');

if (!url) {
  line('');
  line('DATABASE_URL is empty.');
  line('  -> The app will run on local SQLite (backend/data.db). Fine for local work,');
  line('     but Render\'s free tier wipes its disk on redeploy, so set DATABASE_URL');
  line('     before deploying. See README step 2.3.');
  line('');
  process.exit(0);
}

let u;
try {
  u = new URL(url);
} catch (e) {
  line('DATABASE_URL is not a valid URL: ' + e.message);
  line('  Expected: postgresql://postgres.<ref>:<password>@aws-1-<region>.pooler.supabase.com:5432/postgres');
  process.exit(1);
}

const host = u.hostname;
const port = u.port || '5432';
const user = decodeURIComponent(u.username);
const pass = decodeURIComponent(u.password);
const dbname = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres';

line('');
line('Parsed connection details');
line('  host : ' + host);
line('  port : ' + port);
line('  user : ' + user);
line('  db   : ' + dbname);
line('  password length: ' + pass.length + (pass ? '' : '  <-- MISSING'));
line('');

function advise() {
  if (/^db\.[a-z0-9]+\.supabase\.co$/i.test(host)) {
    line('HINT: `db.<ref>.supabase.co` is IPv6-only and unreachable from Render.');
    line('      Use the Session pooler host instead:');
    line('      aws-1-<region>.pooler.supabase.com  with user postgres.<ref> (port 5432)');
  }
  if (/\s/.test(pass)) {
    line('HINT: The password contains a space. Percent-encode it as %20.');
  }
  if (pass.includes('password') || pass === 'postgres') {
    line('HINT: The password still looks like a placeholder.');
  }
}

/* Supabase project refs are region-specific, and a wrong region answers
   "tenant/user ... not found" while the right one either connects or complains
   about the password specifically. Sweeping the regions turns a dead end into an
   actionable answer. */
const REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'eu-central-1', 'eu-central-2', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-north-1',
  'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2',
  'ap-south-1', 'sa-east-1', 'ca-central-1'
];

function probe({ host, port, user, password, database }, timeout = 6000) {
  const pool = new Pool({ host, port, user, password, database, ssl: { rejectUnauthorized: false }, max: 1, connectionTimeoutMillis: timeout });
  return pool.query('SELECT 1')
    .then(() => ({ state: 'connected' }))
    .catch((e) => ({ state: e.code === '28P01' ? 'password' : (e.code || 'other'), message: e.message }))
    .finally(() => pool.end().catch(() => {}));
}

async function findRegion(ref, password) {
  const hits = [];
  for (let i = 0; i < REGIONS.length; i += 5) {
    await Promise.all(REGIONS.slice(i, i + 5).map(async (region) => {
      for (const prefix of ['aws-0', 'aws-1']) {
        const h = `${prefix}-${region}.pooler.supabase.com`;
        const r = await probe({ host: h, port: 5432, user: `postgres.${ref}`, password, database: 'postgres' });
        if (r.state === 'connected' || r.state === 'password') hits.push({ host: h, state: r.state });
      }
    }));
  }
  return hits;
}

async function reportRegion(ref, password) {
  line('Searching every Supabase pooler region for project "' + ref + '" ...');
  const hits = await findRegion(ref, password);
  line('');
  if (!hits.length) {
    line('  -> No region has this project ref. The ref is wrong, or the project');
    line('     was deleted / is still being created. Copy it again from');
    line('     Supabase -> Project Settings -> General -> Reference ID.');
    return;
  }
  for (const h of hits) {
    line('  FOUND  ' + h.host + '   (' + (h.state === 'connected' ? 'CONNECTION WORKS' : 'password rejected') + ')');
  }
  line('');
  line('  Use that host in DATABASE_URL, e.g.');
  line('  postgresql://postgres.' + ref + ':<db-password>@' + hits[0].host + ':5432/postgres');
  if (hits.some((h) => h.state === 'password')) {
    line('');
    line('  The password was rejected, so also reset it in');
    line('  Supabase -> Project Settings -> Database -> Reset database password.');
  }
}

(async () => {
  await new Promise((res) => {
    dns.lookup(host, { all: true }, (err, addrs) => {
      if (err) {
        line('DNS: cannot resolve ' + host + '  (' + (err.code || err.message) + ')');
        line('  -> Check the project ref / region in the host name.');
      } else {
        line('DNS: ' + host + ' -> ' + addrs.map((a) => a.address + ' (IPv' + a.family + ')').join(', '));
        if (addrs.every((a) => a.family === 6)) {
          line('  -> IPv6 only. Render cannot reach this. Use the pooler host.');
        }
      }
      res();
    });
  });

  const pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 2,
    connectionTimeoutMillis: 15000
  });

  try {
    const r = await pool.query('SELECT current_database() AS d, version() AS v');
    line('');
    line('CONNECTED to "' + r.rows[0].d + '"');
    line('  ' + String(r.rows[0].v).split(' ').slice(0, 2).join(' '));

    const t = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
    );
    const names = t.rows.map((x) => x.table_name);
    line('  tables: ' + (names.length ? names.join(', ') : '(none yet — the app creates them on boot)'));
    line('');
    line('DATABASE_URL looks good. You can deploy.');
    line('');
    process.exit(0);
  } catch (e) {
    line('');
    line('CONNECTION FAILED: ' + (e.code || '') + ' ' + e.message);
    let ref = '';
    switch (e.code) {
      case 'ENOTFOUND':
        line('  -> Host not found. Wrong project ref / region, or a project that does not exist.');
        if (/^db\.([a-z0-9]+)\.supabase\.co$/i.test(host)) ref = host.split('.')[1];
        break;
      case '28P01':
        line('  -> Wrong database password. Reset it in Supabase:');
        line('     Project -> Settings -> Database -> Reset database password,');
        line('     then update DATABASE_URL (Supabase shows the new string).');
        break;
      case 'XX000':
        line('  -> Supabase says the tenant/user is unknown and provides no tenant id.');
        line('     Either the USER is missing its `.<project-ref>` suffix, or the HOST');
        line('     names a different region than the project actually lives in.');
        if (/^postgres\.([a-z0-9]+)$/i.test(user)) ref = user.split('.')[1];
        break;
      case 'ENOIDENTIFIER':
        line('  -> Pooler needs the project ref in the username: postgres.<project-ref>');
        if (/^postgres\.([a-z0-9]+)$/i.test(user)) ref = user.split('.')[1];
        break;
      case 'ECONNREFUSED':
      case 'ETIMEDOUT':
        line('  -> Nothing accepted the connection. Usually the direct db.<ref>.supabase.co');
        line('     host (IPv6-only) — switch to the session pooler host.');
        if (/^db\.([a-z0-9]+)\.supabase\.co$/i.test(host)) ref = host.split('.')[1];
        break;
      default:
        break;
    }
    advise();
    if (ref) {
      line('');
      await reportRegion(ref, pass);
    }
    line('');
    line('Tip: run again after fixing; the app itself refuses to start on a bad database.');
    line('');
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
})();
