import fs from 'fs';
const p = 'd:/website/Finalver/src/views/public.js';
let s = fs.readFileSync(p, 'utf8');
const reps = [
  ['        ${bylineSticker(article.author, { cls: \'mt-1 text-[0.6875rem] ink-muted\' })}', '        ${renderByline(article, { cls: \'mt-1 text-[0.6875rem] ink-muted\' })}'],
  ['        ${bylineSticker(todaysPick.author, {\n          cls: \'mt-2 text-[0.6875rem] ink-muted\',\n          suffix: ` \u00b7 ${todaysPick.date}`\n        })}', '        ${renderByline(todaysPick, {\n          cls: \'mt-2 text-[0.6875rem] ink-muted\',\n          suffix: ` \u00b7 ${todaysPick.date}`\n        })}'],
  ['             ${bylineSticker(item.author, { cls: \'mt-1 text-[0.6875rem] ink-muted\' })}', '             ${renderByline(item, { cls: \'mt-1 text-[0.6875rem] ink-muted\' })}'],
  ['        ${bylineSticker(article.author, {\n          cls: \'mt-2 text-xs font-semibold tracking-wide uppercase ink-muted\'\n        })}', '        ${renderByline(article, {\n          cls: \'mt-2 text-xs font-semibold tracking-wide uppercase ink-muted\'\n        })}'],
  ['          ${bylineSticker(article.author, {\n            tag: \'span\',\n            cls: \'mt-0.5 block text-[0.6875rem] ink-muted\',\n            suffix: ` \u00b7 ${article.date}`\n          })}', '          ${renderByline(article, {\n            tag: \'span\',\n            cls: \'mt-0.5 block text-[0.6875rem] ink-muted\',\n            suffix: ` \u00b7 ${article.date}`\n          })}']
];
for (const [a, b] of reps) {
  if (!s.includes(a)) { console.log('MISS: ' + a.slice(0, 70)); continue; }
  s = s.split(a).join(b);
  console.log('OK: ' + a.slice(0, 70));
}
fs.writeFileSync(p, s);