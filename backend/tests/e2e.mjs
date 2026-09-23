/* End-to-end API check for The Wire. Run: node tests/e2e.mjs
   Boots against whatever backend the environment selects (SQLite locally,
   Postgres when DATABASE_URL is set). */
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:4123';

const results = [];
let failures = 0;

function check(name, cond, extra = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures += 1;
}

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + '/api' + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  return { status: res.status, data };
}

const log = (s) => process.stdout.write(s + '\n');

async function main() {
  /* ---- 1. Public content from a fresh seed ---- */
  const c = await call('/content');
  check('GET /content is 200', c.status === 200);
  check('week article seeded', !!(c.data.week && c.data.week.article), (c.data.week && c.data.week.article && c.data.week.article.title) || '');
  check('week picture seeded', !!(c.data.week && c.data.week.picture));
  check('feed has stories', Array.isArray(c.data.feed) && c.data.feed.length > 0, 'n=' + (c.data.feed || []).length);
  check('tabs include new categories', (c.data.tabs || []).includes('Science & Tech') && (c.data.tabs || []).includes('Music & Arts'));
  check('editionLine present', typeof c.data.editionLine === 'string' && c.data.editionLine.length > 0, c.data.editionLine);
  check('forcedNotifications defaults false', c.data.forcedNotifications === false);
  check('breaking defaults on', c.data.breaking === true);

  /* ---- 2. Owner login ---- */
  const ownerUser = process.env.OWNER_USERNAME || 'owner';
  const ownerPass = process.env.OWNER_PASSWORD || 'change-me-now';
  const ownerLogin = await call('/auth/login', { method: 'POST', body: { username: ownerUser, password: ownerPass } });
  check('owner login works', ownerLogin.status === 200 && !!ownerLogin.data.token, 'status=' + ownerLogin.status);
  const ownerToken = ownerLogin.data.token;

  const badLogin = await call('/auth/login', { method: 'POST', body: { username: ownerUser, password: 'wrong' } });
  check('wrong password rejected', badLogin.status === 401);

  /* ---- 3. Owner creates an editor WITH a chosen password ---- */
  const uname = 'tester' + Date.now().toString().slice(-6);
  const made = await call('/editors', { method: 'POST', body: { name: 'Test Editor', username: uname, password: 'chosen-pass-123' }, token: ownerToken });
  check('owner creates editor with password', made.status === 201, 'status=' + made.status);

  const shortPass = await call('/editors', { method: 'POST', body: { name: 'X', username: 'shortpw1', password: 'abc' }, token: ownerToken });
  check('short password rejected', shortPass.status === 400);

  /* ---- 4. Editor logs in with the Owner-chosen password ---- */
  const edLogin = await call('/auth/login', { method: 'POST', body: { username: uname, password: 'chosen-pass-123' } });
  check('editor logs in with owner-set password', edLogin.status === 200, 'status=' + edLogin.status);
  const edToken = edLogin.data.token;
  check('new editor portrait_status = none', edLogin.data.portrait_status === 'none', edLogin.data.portrait_status);

  /* ---- 5. Without a portrait the editor can do nothing ---- */
  const blocked = await call('/queue', { method: 'POST', body: { kind: 'article', title: 'Blocked attempt', placement: 'feed' }, token: edToken });
  check('submission blocked without portrait', blocked.status === 403, 'status=' + blocked.status);

  const boardBlocked = await call('/board', { method: 'POST', body: { title: 'Nope' }, token: edToken });
  check('plain editor cannot touch board', boardBlocked.status === 403, 'status=' + boardBlocked.status);

  /* ---- 6. Editor submits a portrait -> pending ---- */
  const portrait = await call('/auth/me/portrait', { method: 'PUT', body: { portrait_url: 'https://example.com/me.jpg' }, token: edToken });
  check('portrait submitted -> pending', portrait.status === 200 && portrait.data.portrait_status === 'pending');

  const stillBlocked = await call('/queue', { method: 'POST', body: { kind: 'article', title: 'Still blocked', placement: 'feed' }, token: edToken });
  check('still blocked while portrait pending', stillBlocked.status === 403, 'status=' + stillBlocked.status);

  /* ---- 7. Owner approves the portrait ---- */
  const q1 = await call('/queue', { token: ownerToken });
  check('owner queue lists pending portrait', q1.status === 200 && q1.data.portraits.length === 1, 'n=' + (q1.data.portraits || []).length);
  const pendingId = q1.data.portraits[0].id;

  const approved = await call('/editors/' + pendingId + '/portrait', { method: 'PATCH', body: { action: 'approve' }, token: ownerToken });
  check('owner approves portrait', approved.status === 200 && approved.data.portrait_status === 'approved');

  const meAfter = await call('/auth/me', { token: edToken });
  check('editor now active', meAfter.data.portrait_status === 'approved', meAfter.data.portrait_status);

  /* ---- 8. A weekly feature REQUIRES a secondary category ---- */
  const noFallback = await call('/queue', { method: 'POST', body: { kind: 'article', title: 'No fallback', placement: 'week_article', tag: 'Campus News' }, token: edToken });
  check('week submission without fallback rejected', noFallback.status === 400, 'status=' + noFallback.status);

  const submit = await call('/queue', { method: 'POST', body: { kind: 'article', title: 'Bench players carry the fourth quarter', tag: 'Sports & Scores', fallback_tag: 'Community', placement: 'week_article', body: ['One.', 'Two.'] }, token: edToken });
  check('editor submits a week article', submit.status === 200 && submit.data.status === 'pending', 'status=' + submit.status);

  const mine = await call('/queue/mine', { token: edToken });
  check('editor sees own submission', Array.isArray(mine.data) && mine.data.length === 1, 'n=' + (mine.data || []).length);

  /* ---- 9. Nothing is public before approval ---- */
  const beforeApproval = await call('/content');
  check('pending story is NOT public', beforeApproval.data.week.article.title !== 'Bench players carry the fourth quarter');

  /* ---- 10. Approval rotates the outgoing weekly piece into the feed ---- */
  const q2 = await call('/queue', { token: ownerToken });
  check('owner queue lists the pending story', q2.status === 200 && q2.data.articles.length === 1, 'n=' + (q2.data.articles || []).length);
  const storyId = q2.data.articles[0].id;
  check('queue reports the submitter', q2.data.articles[0].submitted_by_name === 'Test Editor', q2.data.articles[0].submitted_by_name);

  const appr = await call('/queue/' + storyId, { method: 'PATCH', body: { action: 'approve' }, token: ownerToken });
  check('owner approves the story', appr.status === 200 && appr.data.status === 'published');
  check('outgoing weekly piece cycled out', !!appr.data.cycledOut, JSON.stringify(appr.data.cycledOut || {}));
  check('cycled piece took its own secondary category', !!appr.data.cycledOut && appr.data.cycledOut.tag === 'Campus News', appr.data.cycledOut ? appr.data.cycledOut.tag : '');

  const afterApproval = await call('/content');
  check('new article is the week headline', afterApproval.data.week.article.title === 'Bench players carry the fourth quarter');
  check('week article carries the byline portrait', afterApproval.data.week.article.portrait_url === 'https://example.com/me.jpg', afterApproval.data.week.article.portrait_url);
  const inFeed = afterApproval.data.feed.find((f) => f.title.indexOf('Drama Club') !== -1);
  check('old week article dropped into the feed', !!inFeed);
  check('old week article re-tagged to its fallback', !!inFeed && inFeed.tag === 'Campus News', inFeed ? inFeed.tag : '');

  /* ---- 11b. Owner can retire a weekly slot by hand ---- */
  const cycle = await call('/queue/cycle/week_picture', { method: 'POST', token: ownerToken });
  check('owner manually cycles out a weekly slot', cycle.status === 200 && !!cycle.data.cycledOut, 'status=' + cycle.status);
  check('manual cycle uses the secondary category', cycle.data.cycledOut && cycle.data.cycledOut.tag === 'Photo Essays', cycle.data.cycledOut ? cycle.data.cycledOut.tag : '');
  const afterCycle = await call('/content');
  check('cycled picture left the weekly slot', afterCycle.data.week.picture === null);
  check('cycled picture appeared in the feed', !!afterCycle.data.feed.find((f) => f.title.indexOf('Sunset Over the Field') !== -1));
  const cycleAgain = await call('/queue/cycle/week_picture', { method: 'POST', token: ownerToken });
  check('cycling an empty slot reports not found', cycleAgain.status === 404, 'status=' + cycleAgain.status);
  const cycleBad = await call('/queue/cycle/feed', { method: 'POST', token: ownerToken });
  check('only real weekly slots can be cycled', cycleBad.status === 400, 'status=' + cycleBad.status);

  /* ---- 11. Masthead picks up approved portraits ---- */
  const mast = afterApproval.data.team.find((t) => t.name === 'Test Editor');
  check('approved portrait appears in the masthead', !!mast && mast.photo_url === 'https://example.com/me.jpg');

  /* ---- 12. Assignment Manager role unlocks the board ---- */
  const grant = await call('/editors/' + pendingId + '/role', { method: 'PATCH', body: { role: 'assignment_manager' }, token: ownerToken });
  check('owner grants board rights', grant.status === 200 && grant.data.role === 'assignment_manager');

  const boardAdd = await call('/board', { method: 'POST', body: { date: '30', mon: 'SEP', title: 'Editorial deadline', time: '5:00 PM', tag: 'DEADLINE', notes: 'Copy due to the desk.' }, token: edToken });
  check('assignment manager can add a board item', boardAdd.status === 201, 'status=' + boardAdd.status);
  const boardId = boardAdd.data.id;

  const boardEdit = await call('/board/' + boardId, { method: 'PATCH', body: { title: 'Editorial deadline (moved)', date: '01', mon: 'OCT' }, token: edToken });
  check('assignment manager can edit a board item', boardEdit.status === 200, 'status=' + boardEdit.status);

  const manage = await call('/board/manage', { token: edToken });
  const edited = (manage.data || []).find((b) => String(b.id) === String(boardId));
  check('board edit persisted (title + date)', !!edited && edited.title === 'Editorial deadline (moved)' && edited.date === '01', edited ? edited.title + ' @ ' + edited.date : 'missing');
  check('board edit kept time/tag/notes', !!edited && edited.time === '5:00 PM' && edited.notes === 'Copy due to the desk.', edited ? edited.time + ' | ' + edited.notes : 'missing');

  const contentWithBoard = await call('/content');
  check('new board item shows on the public calendar', !!contentWithBoard.data.calendar.find((x) => x.title === 'Editorial deadline (moved)'));

  const boardDel = await call('/board/' + boardId, { method: 'DELETE', token: edToken });
  check('assignment manager can delete a board item', boardDel.status === 204, 'status=' + boardDel.status);

  /* ---- 13. Revoking board rights locks the board again ---- */
  await call('/editors/' + pendingId + '/role', { method: 'PATCH', body: { role: 'editor' }, token: ownerToken });
  const revoked = await call('/board', { method: 'POST', body: { title: 'After revoke' }, token: edToken });
  check('revoked editor cannot add board items', revoked.status === 403, 'status=' + revoked.status);

  /* ---- 14. Breaking line + forced notifications toggles ---- */
  const setOff = await call('/settings', { method: 'PUT', body: { breaking_enabled: false, breaking_text: 'Nothing to see here.' }, token: ownerToken });
  check('owner saves breaking settings', setOff.status === 200);
  const cOff = await call('/content');
  check('breaking line hidden on the site', cOff.data.breaking === false);
  check('breaking text kept for later', cOff.data.breakingText === 'Nothing to see here.');

  const setOn = await call('/settings', { method: 'PUT', body: { breaking_enabled: true, breaking_text: 'Back on air.' }, token: ownerToken });
  const cOn = await call('/content');
  check('breaking line restored with new text', setOn.status === 200 && cOn.data.breaking === true && cOn.data.breakingText === 'Back on air.');

  const forced = await call('/settings', { method: 'PUT', body: { forced_notifications: true }, token: ownerToken });
  check('owner enables forced notifications', forced.status === 200);
  const cForced = await call('/content');
  check('forced notifications exposed publicly', cForced.data.forcedNotifications === true);
  const savedSettings = await call('/settings', { token: ownerToken });
  check('settings endpoint returns the forced flag', savedSettings.data.forced_notifications === true);

  const forcedOff = await call('/settings', { method: 'PUT', body: { forced_notifications: false }, token: ownerToken });
  const cUnforced = await call('/content');
  check('forced notifications can be switched back off', forcedOff.status === 200 && cUnforced.data.forcedNotifications === false);

  /* ---- 15. Categories are Owner-managed ---- */
  const addCat = await call('/settings/categories', { method: 'POST', body: { name: 'Alumni Voices' }, token: ownerToken });
  check('owner adds a category', addCat.status === 201, 'status=' + addCat.status);
  const dupCat = await call('/settings/categories', { method: 'POST', body: { name: 'Alumni Voices' }, token: ownerToken });
  check('duplicate category rejected', dupCat.status === 409);
  const cCats = await call('/content');
  check('new category appears in the site tabs', (cCats.data.tabs || []).includes('Alumni Voices'));
  const delCat = await call('/settings/categories/' + addCat.data.id, { method: 'DELETE', token: ownerToken });
  check('owner removes a category', delCat.status === 204, 'status=' + delCat.status);

  /* ---- 16. Permission boundaries ---- */
  const edTriesOwner = await call('/queue', { token: edToken });
  check('editor cannot read the Owner queue', edTriesOwner.status === 403, 'status=' + edTriesOwner.status);
  const edTriesEditors = await call('/editors', { token: edToken });
  check('editor cannot list editor accounts', edTriesEditors.status === 403);
  const edTriesSettings = await call('/settings', { token: edToken });
  check('editor cannot read settings', edTriesSettings.status === 403);
  const noAuth = await call('/auth/me');
  check('missing token is rejected', noAuth.status === 401);
  const junkToken = await call('/auth/me', { token: 'not-a-real-token' });
  check('forged token is rejected', junkToken.status === 401);
  const ownerPortrait = await call('/auth/me/portrait', { method: 'PUT', body: { portrait_url: 'x.jpg' }, token: ownerToken });
  check('owner does not need a portrait', ownerPortrait.status === 403, 'status=' + ownerPortrait.status);

  /* ---- 17. Removing an editor keeps the archive intact ---- */
  const removed = await call('/editors/' + pendingId, { method: 'DELETE', token: ownerToken });
  check('owner removes an editor', removed.status === 204, 'status=' + removed.status);
  const afterRemove = await call('/content');
  check('published story survives editor removal', afterRemove.data.week.article.title === 'Bench players carry the fourth quarter');
  const goneLogin = await call('/auth/login', { method: 'POST', body: { username: uname, password: 'chosen-pass-123' } });
  check('removed editor cannot log in', goneLogin.status === 401);
  const ownerStillOk = await call('/queue', { token: ownerToken });
  check('owner account untouched by removal', ownerStillOk.status === 200);

  log('');
  log(results.join('\n'));
  log('');
  log(`${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { log('TEST RUNNER ERROR: ' + e.message); process.exit(1); });
