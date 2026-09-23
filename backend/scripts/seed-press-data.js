require('dotenv').config();
const { db, ready } = require('../db');

async function seedPressData() {
  console.log('[seed] Connecting to database...');
  await ready;
  console.log('[seed] Connected. Seeding fresh editorial content...');

  // 1. Settings
  const settings = [
    ['edition_line', 'VOL. 1 · NO. 14'],
    ['breaking_enabled', '1'],
    ['breaking_text', "Robotics team confirmed for Saturday's regional qualifier — first bid in four years."],
    ['forced_notifications', '0'],
    ['one_signal_app_id', process.env.ONESIGNAL_APP_ID || '538526a8-c1c7-41e9-a47d-d1804f8782c9'],
    ['week_rotated_at', String(Date.now())]
  ];
  for (const [k, v] of settings) {
    const exists = await db.prepare('SELECT key FROM settings WHERE key = ?').get(k);
    if (exists) {
      await db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(v, k);
    } else {
      await db.prepare('INSERT INTO settings(key, value) VALUES (?,?)').run(k, v);
    }
  }
  console.log('[seed] Updated settings (OneSignal App ID, breaking line, rotation timestamp).');

  // 2. Remove test stub articles
  await db.prepare("DELETE FROM articles WHERE title LIKE '%Bench players%' OR title LIKE '%No fallback%'").run();

  // 3. Ensure featured weekly slots have high-quality content
  // Remove existing weekly items to cleanly re-seed the 3 featured slots
  await db.prepare("DELETE FROM articles WHERE placement IN ('week_article', 'week_event', 'week_picture')").run();

  // week_article
  await db.prepare(`
    INSERT INTO articles (placement, status, kind, kicker, tag, fallback_tag, title, author, time, dek, cap, photo_url, body)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    'week_article', 'published', 'article',
    'Article of the Week', 'Science & Tech', 'Campus News',
    'Robotics Qualifies for Regionals in Nail-Biting Finish',
    'Denis Wanjiru', '4 min read',
    'After months of after-school builds, the varsity robotics squad secures its first regional qualification in four years.',
    'Denis Wanjiru and teammates fine-tuning the pneumatic arm before Saturday’s final round.',
    'https://images.unsplash.com/photo-1581092160607-ee22621dd758?auto=format&fit=crop&w=1200&q=80',
    JSON.stringify([
      "After months of intense after-school builds and late-night calibration sessions in the workshop, the Nakuru Press Club robotics team clinched their regional qualification in a dramatic final round.",
      "Team captain Denis Wanjiru noted that their redesigned pneumatic gripper held up under pressure, securing the highest autonomous scoring run of the entire tournament.",
      "The hard-fought victory marks the program's first regional qualification in four years. With new drive-code and spare gear sets in hand, preparations are already underway for this Saturday's championship showcase."
    ])
  );

  // week_event
  await db.prepare(`
    INSERT INTO articles (placement, status, kind, kicker, tag, fallback_tag, title, author, time, dek, cap, photo_url, body)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    'week_event', 'published', 'event',
    'Event of the Week', 'Campus News', 'Sports & Scores',
    'Robotics Team Heads to Regionals This Saturday',
    'Brian Otieno', '2 min read',
    'Send-off rally at 7:30 AM before the team departs for the county arena.',
    'Members of the club reviewing the event schedule and inspection checklist.',
    'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?auto=format&fit=crop&w=1200&q=80',
    JSON.stringify([
      "The regional championship gets underway this Saturday morning at the County Sports Complex, bringing together top student engineering teams from across the province.",
      "Supporters, parents, and fellow students are invited to join the morning send-off rally at 7:30 AM outside the main auditorium before team transport departs.",
      "The Wire will be reporting live from the arena floor, with continuous photo feeds and round-by-round score updates published directly to this page."
    ])
  );

  // week_picture
  await db.prepare(`
    INSERT INTO articles (placement, status, kind, kicker, tag, fallback_tag, title, author, time, dek, cap, photo_url, body)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    'week_picture', 'published', 'photo',
    'Picture of the Week', 'Photo Essays', 'Sports & Scores',
    'Sunset Over the Field, Match Point',
    'Photo: Lilian W.', '1 min read',
    null,
    'Volleyball vs. Kericho High, final set — taken in the last golden minutes of Thursday’s match.',
    'https://images.unsplash.com/photo-1612872087720-bb876e2e67d1?auto=format&fit=crop&w=1200&q=80',
    JSON.stringify([
      "Taken in the final minutes of Thursday's volleyball match, right as the last serve of the set crossed the net.",
      "The late afternoon sunlight cast dramatic silhouettes across the court just as the home bench rose in celebration of a three-game sweep."
    ])
  );
  console.log('[seed] Seeded 3 featured weekly slots (article, event, picture).');

  // 4. Update feed articles with rich editorial photos
  const feedPhotos = [
    { pattern: 'Cafeteria%', photo: 'https://images.unsplash.com/photo-1567521464027-f127ff144326?auto=format&fit=crop&w=1000&q=80' },
    { pattern: 'Girls%Football%', photo: 'https://images.unsplash.com/photo-1526232761682-d26e03ac148e?auto=format&fit=crop&w=1000&q=80' },
    { pattern: 'Opinion:%Study Hall%', photo: 'https://images.unsplash.com/photo-1497633762265-9d179a990aa6?auto=format&fit=crop&w=1000&q=80' },
    { pattern: 'Photo Essay:%Backstage%', photo: 'https://images.unsplash.com/photo-1507676184212-d03ab07a01bf?auto=format&fit=crop&w=1000&q=80' },
    { pattern: 'Debate Team%', photo: 'https://images.unsplash.com/photo-1475721027785-f74eccf877e2?auto=format&fit=crop&w=1000&q=80' },
    { pattern: 'Opinion:%Bell Schedule%', photo: 'https://images.unsplash.com/photo-1509062522246-3755977927d7?auto=format&fit=crop&w=1000&q=80' },
    { pattern: '%Drama Club%', photo: 'https://images.unsplash.com/photo-1460723237483-7a6dc9d0b212?auto=format&fit=crop&w=1000&q=80' }
  ];
  for (const fp of feedPhotos) {
    await db.prepare("UPDATE articles SET photo_url = ? WHERE title LIKE ? AND (photo_url IS NULL OR photo_url = '')").run(fp.photo, fp.pattern);
  }
  console.log('[seed] Updated feed article photos.');

  // 5. Update team members with authentic portraits
  const teamPhotos = [
    { name: 'Amara Kones', photo: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&q=80' },
    { name: 'Brian Otieno', photo: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?auto=format&fit=crop&w=400&q=80' },
    { name: 'Lilian Wambui', photo: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=400&q=80' },
    { name: 'Denis Wanjiru', photo: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=400&q=80' }
  ];
  for (const tp of teamPhotos) {
    await db.prepare('UPDATE team SET photo_url = ? WHERE name = ?').run(tp.photo, tp.name);
  }
  console.log('[seed] Updated masthead team photos.');

  // 6. Top Performers
  await db.prepare('DELETE FROM top_performers').run();
  const performers = [
    {
      name: 'Amara Kones', score: 14,
      photo: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&q=80',
      blurb: 'Lead campus investigative reporting & council policy desk'
    },
    {
      name: 'Brian Otieno', score: 12,
      photo: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?auto=format&fit=crop&w=400&q=80',
      blurb: 'Live sports coverage, match analysis & pitch interviews'
    },
    {
      name: 'Denis Wanjiru', score: 11,
      photo: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=400&q=80',
      blurb: 'Science & tech desk, robotics dispatches & student opinion'
    },
    {
      name: 'Lilian Wambui', score: 9,
      photo: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=400&q=80',
      blurb: 'Photo essays, performance arts & photojournalism curation'
    }
  ];
  let pOrder = 0;
  for (const p of performers) {
    await db.prepare(`
      INSERT INTO top_performers (author, name, score, photo_url, blurb, sort_order)
      VALUES (?,?,?,?,?,?)
    `).run(p.name, p.name, p.score, p.photo, p.blurb, pOrder++);
  }
  console.log('[seed] Seeded Top Performers (4 journalists).');

  // 7. Credits
  await db.prepare('DELETE FROM credits').run();
  const credits = [
    {
      name: 'Grace Muthoni', role: 'Faculty Advisor',
      photo: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=400&q=80'
    },
    {
      name: 'Amara Kones', role: 'Editor-in-Chief',
      photo: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&q=80'
    },
    {
      name: 'Denis Wanjiru', role: 'Managing Editor & Opinion',
      photo: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=400&q=80'
    },
    {
      name: 'Brian Otieno', role: 'Sports Editor',
      photo: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?auto=format&fit=crop&w=400&q=80'
    },
    {
      name: 'Lilian Wambui', role: 'Lead Photographer & Layout',
      photo: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=400&q=80'
    }
  ];
  let cOrder = 0;
  for (const c of credits) {
    await db.prepare(`
      INSERT INTO credits (name, role, photo_url, image_url, sort_order)
      VALUES (?,?,?,?,?)
    `).run(c.name, c.role, c.photo, c.photo, cOrder++);
  }
  console.log('[seed] Seeded Credits (5 members).');

  // 8. Pin a featured Today's Pick
  const feedStory = await db.prepare("SELECT id FROM articles WHERE placement = 'feed' AND status = 'published' ORDER BY id ASC LIMIT 1").get();
  if (feedStory) {
    const today = new Date().toISOString().slice(0, 10);
    const pickRow = await db.prepare('SELECT id FROM todays_pick WHERE id = 1').get();
    if (pickRow) {
      await db.prepare('UPDATE todays_pick SET article_id = ?, picked_at = ?, pinned = 1 WHERE id = 1').run(feedStory.id, today);
    } else {
      await db.prepare('INSERT INTO todays_pick (id, article_id, picked_at, pinned) VALUES (1, ?, ?, 1)').run(feedStory.id, today);
    }
    console.log('[seed] Today’s Pick pinned to article #' + feedStory.id);
  }

  console.log('[seed] Seeding complete! All placeholders replaced with authentic press club data.');
  process.exit(0);
}

seedPressData().catch(err => {
  console.error('[seed] Error seeding press data:', err);
  process.exit(1);
});
