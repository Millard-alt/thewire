require('dotenv').config();
const path = require('path');
const bcrypt = require('bcryptjs');

/* ============================================================================
   The Wire — storage layer
   ----------------------------------------------------------------------------
   Every route talks to one small async API:

       await db.prepare(sql).get(params)
       await db.prepare(sql).all(params)
       await db.prepare(sql).run(params)

   ...backed by EITHER:

     • Postgres (Supabase) — used automatically as soon as DATABASE_URL is set.
                             This is what Render runs against, so the newsroom
                             content survives redeploys.
     • SQLite (better-sqlite3) — the default for local work; zero setup.

   SQL is written once, with `?` (positional) or `@name` (named) placeholders,
   and rewritten to Postgres `$1, $2 …` on the fly. Placeholder-looking
   characters inside quoted literals are left alone, so 'who?' stays literal.
   ========================================================================== */

const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
// Which engine we're actually talking to. Starts as Postgres when a connection
// string is present, but init() can demote it to SQLite locally (never in
// production) if the database cannot be reached.
let backend = DATABASE_URL.length > 0 ? 'postgres' : 'sqlite';

/* ---------------------------------------------------------------- Postgres --- */

let pgPool = null;

if (DATABASE_URL.length > 0) {
  const { Pool, types } = require('pg');
  // node-postgres returns BIGINT (OID 20) as a *string*. That covers every
  // COUNT(*) and every BIGSERIAL id, so `count === 0` would silently be false on
  // a fresh database and the seed would be skipped. Hand back real numbers so
  // Postgres behaves exactly like SQLite here.
  types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));
  /* node-postgres accepts the connection string as-is, including any
   percent-encoding Supabase adds — the probe confirmed your
   `Thiongo%40123` string authenticates correctly. We therefore hand the raw
   string to pg rather than round-tripping it through decode/encode, which
   would risk double-encoding characters. */
const connectionOptions = DATABASE_URL.length
  ? { connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }
  : {};

pgPool = new Pool({
  ...connectionOptions,
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});
pgPool.on('error', (e) => console.error('[db] Postgres pool error:', e.message));

}

/* Percent-encode the user/password so a raw @, #, / or space in the database
   password cannot be mis-read as URL syntax. Decoding before encoding keeps
   this idempotent for strings Supabase already encoded. */
function normalizePgUrl(url) {
  const m = /^(postgres(?:ql)?:\/\/)([^/?#]*)([\s\S]*)$/.exec(url);
  if (!m) return url;
  const scheme = m[1];
  const authority = m[2];
  const rest = m[3];
  const at = authority.lastIndexOf('@');
  if (at === -1) return url;
  const userinfo = authority.slice(0, at);
  const hostPart = authority.slice(at);
  const colon = userinfo.indexOf(':');
  if (colon === -1) return url;
  const dec = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
  const user = encodeURIComponent(dec(userinfo.slice(0, colon)));
  const pass = encodeURIComponent(dec(userinfo.slice(colon + 1)));
  return scheme + user + ':' + pass + hostPart + rest;
}

/* Rewrites `?` / `@name` placeholders into `$1, $2 …`, skipping quoted text. */
function translate(sql, params) {
  const named = !!params && typeof params === 'object' && !Array.isArray(params);
  const positional = named
    ? null
    : (params === undefined || params === null
        ? []
        : (Array.isArray(params) ? params : [params]));

  const values = [];
  let out = '';
  let i = 0;
  let quote = null; // the open " or ' while inside a literal / identifier

  while (i < sql.length) {
    const ch = sql[i];

    if (quote) {
      out += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) { out += quote; i += 2; continue; } // doubled quote
        quote = null;
      }
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') { quote = ch; out += ch; i += 1; continue; }

    if (!named && ch === '?') {
      values.push(positional[values.length]);
      out += '$' + values.length;
      i += 1;
      continue;
    }

    if (named && ch === '@') {
      const m2 = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
      if (m2) {
        const v = params[m2[1]];
        values.push(v === undefined ? null : v);
        out += '$' + values.length;
        i += m2[0].length;
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  return { text: out, values };
}

/* Tables whose id is an auto-incrementing serial. Inserts get `RETURNING id`
   appended so routes keep reporting `lastInsertRowid` exactly like SQLite. */
const AUTO_ID_TABLES = new Set(['users', 'articles', 'team', 'calendar', 'categories', 'credits', 'top_performers']);


function pgStatement(sql) {
  const m = /^\s*insert\s+into\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(sql);
  if (m && AUTO_ID_TABLES.has(m[1].toLowerCase()) && !/\breturning\b/i.test(sql)) {
    return { text: sql.replace(/;+\s*$/, '') + ' RETURNING id', wantsId: true };
  }
  return { text: sql, wantsId: false };
}

/* Routes may call .get/.all/.run with any of these styles:
     .run(a, b, c)        variadic positionals (the better-sqlite3 idiom)
     .run([a, b, c])      one positional array
     .run({ name: 1 })    named parameters (@name placeholders)
   Normalise them so both backends accept all three. */
function normArgs(args) {
  if (args.length === 1) {
    const a = args[0];
    if (a === undefined || a === null) return [];
    if (Array.isArray(a)) return a;
    if (typeof a === 'object') return a; // named-parameter object
    return [a];
  }
  return args;
}

/* Same normalisation, but always shaped for `fn(...callArgs)`. A named-parameter
   object must stay a single argument — spreading it would throw. */
function callArgs(args) {
  const n = normArgs(args);
  return n && typeof n === 'object' && !Array.isArray(n) ? [n] : n;
}

function pgPrepare(sql) {
  const prepared = pgStatement(sql);
  const query = (args) => {
    const t = translate(prepared.text, normArgs(args));
    return pgPool.query(t.text, t.values);
  };
  return {
    async get(...args) {
      const r = await query(args);
      return r.rows[0];
    },
    async all(...args) {
      const r = await query(args);
      return r.rows;
    },
    async run(...args) {
      const r = await query(args);
      const first = r.rows[0];
      return {
        changes: r.rowCount || 0,
        lastInsertRowid: first ? first.id : undefined
      };
    }
  };
}

/* ------------------------------------------------------------------ SQLite --- */

let sqlite = null;

function openSqlite() {
  if (!sqlite) {
    const Database = require('better-sqlite3');
    sqlite = new Database(process.env.SQLITE_PATH || path.join(__dirname, 'data.db'));
    sqlite.pragma('journal_mode = WAL');
  }
  return sqlite;
}

function sqlitePrepare(sql) {
  const stmt = openSqlite().prepare(sql);
  // better-sqlite3 accepts variadic args, a single array, or a named object.
  return {
    async get(...args) { return stmt.get(...callArgs(args)); },
    async all(...args) { return stmt.all(...callArgs(args)); },
    async run(...args) {
      const info = stmt.run(...callArgs(args));
      return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
    }
  };
}

/* ---------------------------------------------------------- unified facade --- */

const db = {
  prepare: (sql) => (backend === 'postgres' ? pgPrepare(sql) : sqlitePrepare(sql)),
  async exec(sql) {
    if (backend === 'postgres') return pgPool.query(sql);
    return openSqlite().exec(sql);
  },
  async close() {
    if (backend === 'postgres') return pgPool.end();
    return openSqlite().close();
  }
};

/* Shorthands used by the seeder and by the connection self-test. */
const get = (sql, params) => db.prepare(sql).get(params);
const all = (sql, params) => db.prepare(sql).all(params);
const run = (sql, params) => db.prepare(sql).run(params);

/* One key/value settings read, returning '' when the row is missing. */
async function getSetting(key) {
  const row = await get('SELECT value FROM settings WHERE key = ?', key);
  return row ? String(row.value ?? '') : '';
}


/* ----------------------------------------------------------------- schemas --- */

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('editor','assignment_manager','owner')) DEFAULT 'editor',
  portrait_photo_url TEXT,
  portrait_status TEXT DEFAULT 'none' CHECK(portrait_status IN ('none','pending','approved','rejected')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS articles(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  placement TEXT NOT NULL DEFAULT 'feed',
  status TEXT NOT NULL DEFAULT 'published',
  kind TEXT NOT NULL DEFAULT 'article',
  kicker TEXT,
  tag TEXT,
  fallback_tag TEXT,
  title TEXT NOT NULL,
  author TEXT,
  portrait_url TEXT,
  time TEXT,
  dek TEXT,
  cap TEXT,
  body TEXT,
  photo_url TEXT,
  submitted_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(submitted_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS team(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT,
  body TEXT,
  photo_url TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS calendar(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  mon TEXT NOT NULL,
  title TEXT NOT NULL,
  time TEXT,
  tag TEXT,
  sort_order INTEGER DEFAULT 0,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS categories(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS credits(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT,
  photo_url TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS top_performers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL UNIQUE,
  score INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS weekly_rotation(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot TEXT NOT NULL UNIQUE,
  article_id INTEGER,
  picked_at TEXT
);

CREATE TABLE IF NOT EXISTS todays_pick(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  article_id INTEGER,
  picked_at TEXT
);
`;


/* Mirrors SQLITE_SCHEMA column-for-column so both backends behave identically.
   Deliberately no extra CHECK constraints beyond the ones SQLite already has,
   and `body` stays TEXT (not JSONB) so `JSON.parse` behaves the same on both. */
const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('editor','assignment_manager','owner')) DEFAULT 'editor',
  portrait_photo_url TEXT,
  portrait_status TEXT DEFAULT 'none' CHECK(portrait_status IN ('none','pending','approved','rejected')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS articles(
  id BIGSERIAL PRIMARY KEY,
  placement TEXT NOT NULL DEFAULT 'feed',
  status TEXT NOT NULL DEFAULT 'published',
  kind TEXT NOT NULL DEFAULT 'article',
  kicker TEXT,
  tag TEXT,
  fallback_tag TEXT,
  title TEXT NOT NULL,
  author TEXT,
  portrait_url TEXT,
  time TEXT,
  dek TEXT,
  cap TEXT,
  body TEXT,
  photo_url TEXT,
  submitted_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team(
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,
  body TEXT,
  photo_url TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS calendar(
  id BIGSERIAL PRIMARY KEY,
  date TEXT NOT NULL,
  mon TEXT NOT NULL,
  title TEXT NOT NULL,
  time TEXT,
  tag TEXT,
  sort_order INTEGER DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS categories(
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS credits(
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,
  photo_url TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS top_performers(
  id BIGSERIAL PRIMARY KEY,
  author TEXT NOT NULL UNIQUE,
  score INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS weekly_rotation(
  id BIGSERIAL PRIMARY KEY,
  slot TEXT NOT NULL UNIQUE,
  article_id BIGINT,
  picked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS todays_pick(
  id BIGINT PRIMARY KEY CHECK (id = 1),
  article_id BIGINT,
  picked_at TIMESTAMPTZ
);
`;


/* ---- minimal migrations for databases created before these columns existed ---- */
async function ensureColumn(table, column, ddl) {
  if (backend === 'postgres') {
    // Postgres can do this idempotently, so no information_schema round-trip.
    await pgPool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${ddl}`);
    return;
  }
  const cols = openSqlite().prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find((c) => c.name === column)) openSqlite().exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

/* ---- one-time seed, only runs against a fresh/empty database ---- */
const DEFAULT_CATEGORIES = ['Campus News', 'Sports & Scores', 'Opinion & Culture', 'Photo Essays', 'Music & Arts', 'Science & Tech', 'Community', 'Editorials'];

async function seedIfEmpty() {
  const catCount = (await get('SELECT COUNT(*) AS n FROM categories')).n;
  if (catCount === 0) {
    for (const c of DEFAULT_CATEGORIES) await run('INSERT INTO categories(name) VALUES (?)', c);
  }

  const userCount = (await get('SELECT COUNT(*) AS n FROM users')).n;
  if (userCount === 0) {
    const ownerName = process.env.OWNER_NAME || 'Owner';
    const ownerUser = process.env.OWNER_USERNAME || 'owner';
    const ownerPass = process.env.OWNER_PASSWORD || 'change-me-now';
    const hash = bcrypt.hashSync(ownerPass, 10);
    await run('INSERT INTO users(name, username, password_hash, role) VALUES (?,?,?,?)',
      [ownerName, ownerUser, hash, 'owner']);
    console.log(`[db] seeded Owner account "${ownerUser}" — change OWNER_PASSWORD in .env before going live.`);
  }

  const articleCount = (await get('SELECT COUNT(*) AS n FROM articles')).n;
  if (articleCount === 0) {
    const INSERT_ARTICLE = `INSERT INTO articles
      (placement, status, kind, kicker, tag, fallback_tag, title, author, time, dek, cap, body, photo_url)
      VALUES (@placement,@status,@kind,@kicker,@tag,@fallback_tag,@title,@author,@time,@dek,@cap,@body,@photo_url)`;

    await run(INSERT_ARTICLE, {
      placement: 'week_article', status: 'published', kind: 'article',
      kicker: 'Article of the Week', tag: 'Opinion & Culture', fallback_tag: 'Campus News',
      title: "Behind the Curtain: Drama Club's Sprint to Opening Night",
      author: 'Amara K.', time: '6 min read',
      dek: 'Three weeks out, rehearsals run six days a week — and the exhaustion shows in the best way possible.',
      cap: null, photo_url: null,
      body: JSON.stringify([
        "With three weeks until opening night, the drama club is rehearsing six days a week, and the exhaustion shows in the best way possible.",
        "Director Mr. Otieno says this year's production is the most ambitious the club has attempted, with a rotating set built entirely by student volunteers.",
        "Lead actor Grace Muthoni describes the process as equal parts terrifying and thrilling: you forget your own name is Grace by week two."
      ])
    });

    await run(INSERT_ARTICLE, {
      placement: 'week_event', status: 'published', kind: 'article',
      kicker: 'Event of the Week', tag: 'Sports & Scores', fallback_tag: 'Community',
      title: 'Robotics Team Heads to Regionals This Saturday',
      author: 'Club Desk', time: '3 min read',
      dek: "After months of after-school builds, the van leaves Friday night for Saturday's qualifier.",
      cap: null, photo_url: null,
      body: JSON.stringify([
        "After months of after-school builds, the robotics team loads up the van Friday night for Saturday's regional qualifier.",
        "Team captain Denis Wanjiru says their new arm mechanism finally works — most of the time.",
        "A win Saturday would be the program's first regional qualification in four years."
      ])
    });

    await run(INSERT_ARTICLE, {
      placement: 'week_picture', status: 'published', kind: 'photo',
      kicker: 'Picture of the Week', tag: 'Photo Essays', fallback_tag: 'Photo Essays',
      title: 'Sunset Over the Field, Match Point',
      author: 'Photo: Lilian W.', time: '',
      dek: null, cap: "Volleyball vs. Kericho High, final set — taken in the last minutes of Thursday's match.",
      photo_url: null,
      body: JSON.stringify(["Taken in the final minutes of Thursday's volleyball match, right as the last serve of the set crossed the net."])
    });

    const feedSeed = [
      { title: "Cafeteria Menu Overhaul: What's Actually Changing", author: 'Amara K.', time: '5 min read', tag: 'Campus News', body: ["Starting next month, the cafeteria is dropping three long-standing menu items in favor of a rotating chef's-pick system.", "Feedback from a student survey last spring cited repetition as the top complaint."] },
      { title: "Girls' Football Opens Season 3–0", author: 'Brian O.', time: '3 min read', tag: 'Sports & Scores', body: ["The team's new pressing style has caught opponents off guard in all three opening matches.", "Coach Achieng credits preseason conditioning for the fast start."] },
      { title: 'Opinion: We Need a Real Study Hall Space', author: 'Denis W.', time: '4 min read', tag: 'Opinion & Culture', body: ["The library closes at 3:15, right when most students actually need quiet space to work.", "A dedicated study hall — even a repurposed classroom — would solve a problem nobody seems to be addressing."] },
      { title: 'Photo Essay: A Day Backstage', author: 'Lilian W.', time: '2 min read', tag: 'Photo Essays', body: ["Six hours, one dress rehearsal, and a lot of safety pins."], cap: "Backstage during Tuesday's dress rehearsal." },
      { title: 'Debate Team Advances to Regionals', author: 'Amara K.', time: '3 min read', tag: 'Campus News', body: ['A come-from-behind win in the final round sends the varsity pair to regionals for the first time in three years.'] },
      { title: 'Opinion: The New Bell Schedule, One Month In', author: 'Brian O.', time: '5 min read', tag: 'Opinion & Culture', body: ['Shorter passing periods sounded minor in August. In practice, hallway traffic has gotten worse, not better.'] }
    ];

    for (const f of feedSeed) {
      await run(INSERT_ARTICLE, {
        placement: 'feed', status: 'published', kind: 'article',
        kicker: null, tag: f.tag, fallback_tag: null, title: f.title, author: f.author, time: f.time,
        dek: null, cap: f.cap || null, photo_url: null, body: JSON.stringify(f.body)
      });
    }
  }

  const teamCount = (await get('SELECT COUNT(*) AS n FROM team')).n;
  if (teamCount === 0) {
    const rows = [
      { name: 'Amara Kones', role: 'Editor-in-Chief', body: ['Amara has led the paper for two years and covers campus policy.'] },
      { name: 'Brian Otieno', role: 'Sports Editor', body: ['Brian covers every home game and most away ones, rain or shine.'] },
      { name: 'Lilian Wambui', role: 'Lead Photographer', body: ['Lilian shot every photo essay published this year.'] },
      { name: 'Denis Wanjiru', role: 'Opinion Editor', body: ['Denis runs the opinion desk and the robotics team, somehow.'] }
    ];
    let order = 0;
    for (const t of rows) {
      await run('INSERT INTO team(name, role, body, photo_url, sort_order) VALUES (?,?,?,?,?)',
        [t.name, t.role, JSON.stringify(t.body), null, order]);
      order += 1;
    }
  }

  const calCount = (await get('SELECT COUNT(*) AS n FROM calendar')).n;
  if (calCount === 0) {
    const rows = [
      { date: '24', mon: 'SEP', title: 'Robotics Regionals', time: '8:00 AM · Away', tag: 'SPORTS' },
      { date: '27', mon: 'SEP', title: 'Fall Play — Opening Night', time: '7:00 PM · Auditorium', tag: 'CULTURE' },
      { date: '02', mon: 'OCT', title: "Girls' Football vs. Nakuru High", time: '4:00 PM · Home field', tag: 'SPORTS' },
      { date: '05', mon: 'OCT', title: 'Student Council Elections', time: 'All day · Main hall', tag: 'NEWS' }
    ];
    let order = 0;
    for (const c of rows) {
      await run('INSERT INTO calendar(date, mon, title, time, tag, sort_order) VALUES (?,?,?,?,?,?)',
        [c.date, c.mon, c.title, c.time, c.tag, order]);
      order += 1;
    }
  }

  // Seed each default setting individually so they're always present,
  // even if week_rotated_at was inserted first by applySchemaAndSeed.
  const defaultSettings = [
    ['edition_line', 'VOL. 1 \u00b7 NO. 14'],
    ['breaking_enabled', '1'],
    ['breaking_text', "Robotics team confirmed for Saturday's regional qualifier — first bid in four years."],
    ['forced_notifications', '0'],
    ['one_signal_app_id', ''],
    ['week_rotated_at', String(Date.now())]
  ];
  for (const [k, v] of defaultSettings) {
    await run(
      `INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO NOTHING`,
      [k, v]
    );
  }
}

/* ------------------------------------------------------------------- boot --- */

async function applySchemaAndSeed() {
  await db.exec(backend === 'postgres' ? POSTGRES_SCHEMA : SQLITE_SCHEMA);

  await ensureColumn('users', 'portrait_photo_url', 'portrait_photo_url TEXT');
  await ensureColumn('users', 'portrait_status', "portrait_status TEXT DEFAULT 'none'");
  await ensureColumn('articles', 'fallback_tag', 'fallback_tag TEXT');
  await ensureColumn('articles', 'portrait_url', 'portrait_url TEXT');
  await ensureColumn('calendar', 'notes', 'notes TEXT');
  await ensureColumn('credits', 'name', 'name TEXT');
  await ensureColumn('credits', 'role', 'role TEXT');
  await ensureColumn('credits', 'image_url', 'image_url TEXT');
  await ensureColumn('credits', 'sort_order', 'sort_order INTEGER DEFAULT 0');
  await ensureColumn('top_performers', 'name', 'name TEXT');
  await ensureColumn('top_performers', 'sort_order', 'sort_order INTEGER DEFAULT 0');
  // content.js reads p.photo_url and p.blurb on every request, but nothing ever
  // created these columns — they were silently always null. Adding them for real.
  await ensureColumn('top_performers', 'photo_url', 'photo_url TEXT');
  await ensureColumn('top_performers', 'blurb', 'blurb TEXT');

  // Weekly rotation bookkeeping: when did each featured slot last change?
  await ensureColumn('settings', 'value', 'value TEXT'); // no-op guard on Postgres
  await run(`INSERT INTO settings(key, value) VALUES ('week_rotated_at', ?)
             ON CONFLICT(key) DO NOTHING`, [String(Date.now())]);

  await ensureColumn('weekly_rotation', 'picked_at', 'picked_at TEXT');
  await ensureColumn('todays_pick', 'picked_at', 'picked_at TEXT');
  // Lets the Owner lock Today's Pick to a chosen story instead of it always
  // being the daily random pull.
  await ensureColumn('todays_pick', 'pinned', 'pinned INTEGER DEFAULT 0');

  await seedIfEmpty();

  // Prove the connection really works before we start serving traffic.
  await get('SELECT COUNT(*) AS n FROM users');
}

async function init() {
  if (backend === 'postgres') {
    try {
      await applySchemaAndSeed();
      return;
    } catch (err) {
      // In production a broken DATABASE_URL must be a hard failure — silently
      // falling back to a throwaway local file would look like data loss to the
      // newsroom on the next deploy.
      if (process.env.NODE_ENV === 'production') throw err;

      console.warn('');
      console.warn('  ┌─ Postgres unreachable, falling back to local SQLite for now.');
      console.warn('  │  ' + err.message);
      console.warn('  │  Data will NOT sync to Supabase until this is fixed.');
      console.warn('  │  Check DATABASE_URL in backend/.env (password + region).');
      console.warn('  └─ Running on SQLite: backend/data.db');
      console.warn('');
      try { await pgPool.end(); } catch (e) { /* ignore */ }
      pgPool = null;
      backend = 'sqlite';
      await applySchemaAndSeed();
    }
    return;
  }
  await applySchemaAndSeed();
}

const ready = init()
  .then(() => {
    console.log(`[db] connected — ${backend === 'postgres' ? 'Postgres (Supabase)' : 'SQLite (data.db, local)'}`);
  })
  .catch((err) => {
    console.error('[db] could not initialise the database:', err.message);
    throw err;
  });

module.exports = { db, ready, DEFAULT_CATEGORIES, CATEGORIES: DEFAULT_CATEGORIES, getSetting, get backend() { return backend; }, get usingPostgres() { return backend === 'postgres'; } };


/* Exposed for the SQL-translation unit tests in tests/sql-translate.mjs. These
   are pure functions, so testing them needs no live database. */
module.exports.__internals = { translate, pgStatement, normalizePgUrl };

