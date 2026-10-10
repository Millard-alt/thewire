import fs from 'fs';
const NL = '\n';
const articleDup = '</h3>' + NL +
  '        ${bylineSticker(article.author, { cls: \'mt-1 text-[0.6875rem] ink-muted\' })}' + NL +
  '        ${portraitForArticle(article)' + NL +
  '          ? bylineSticker(article.author, { cls: \'mt-1 text-[0.6875rem] ink-muted\', portrait: portraitForArticle(article) })' + NL +
  '          : bylineSticker(article.author, { cls: \'mt-1 text-[0.6875rem] ink-muted\' }) }' + NL +
  '        ${renderByline(article, { cls: \'mt-1 text-[0.6875rem] ink-muted\' }) }' + NL +
  '        ${renderByline(article, { cls: \'mt-1 text-[0.6875rem] ink-muted\' }) }';
const articleFix = '</h3>' + NL +
  '        ${renderByline(article, { cls: \'mt-1 text-[0.6875rem] ink-muted\' }) }';
if (s.includes(articleDup)) { s = s.split(articleDup).join(articleFix); console.log('fixed articleCard dup'); }

// 2) Replace remaining bylineSticker calls with renderByline.
const pairs = [
  ['        ${bylineSticker(todaysPick.author, {\\n          cls: \\'mt-2 text-[0.6875rem] ink-muted\\',\\n          suffix: ` \u00b7 ${todaysPick.date}`\\n        })}', '        ${renderByline(todaysPick, {\\n          cls: \\'mt-2 text-[0.6875rem] ink-muted\\',\\n          suffix: ` \u00b7 ${todaysPick.date}`\\n        })}'],
  ['             ${bylineSticker(item.author, { cls: \\'mt-1 text-[0.6875rem] ink-muted\\' })}', '             ${renderByline(item, { cls: \\'mt-1 text-[0.6875rem] ink-muted\\' })}'],
  ['        ${bylineSticker(article.author, {\\n          cls: \\'mt-2 text-xs font-semibold tracking-wide uppercase ink-muted\\'\\n        })}', '        ${renderByline(article, {\\n          cls: \\'mt-2 text-xs font-semibold tracking-wide uppercase ink-muted\\'\\n        })}'],
  ['          ${bylineSticker(article.author, {\\n            tag: \\'span\\',\\n            cls: \\'mt-0.5 block text-[0.6875rem] ink-muted\\',\\n            suffix: ` \u00b7 ${article.date}`\\n          })}', '          ${renderByline(article, {\\n            tag: \\'span\\',\\n            cls: \\'mt-0.5 block text-[0.6875rem] ink-muted\\',\\n            suffix: ` \u00b7 ${article.date}`\\n          })}']
];
for (const [a, b] of pairs) {
  if (!s.includes(a)) { console.log('MISS: ' + a.slice(0, 60)); continue; }
  s = s.split(a).join(b);
  console.log('replaced: ' + a.slice(0, 50));
}

// 3) Add renderByline helper after the imports.
const helper = NL +
  '/**' + NL +
  ' * Resolve a byline portrait by immutable FK first, then exact name.' + NL +
  ' * This is the single place the front page / article modal / search' + NL +
  ' * strip chooses which face to show next to an author name.' + NL +
  ' */' + NL +
  'function renderByline(article, opts = {}) {' + NL +
  '  const portrait = portraitForArticle(article);' + NL +
  "  const name = article?.author || 'The Pulse staff';" + NL +
  '  return bylineSticker(name, { ...opts, portrait });' + NL +
  '}' + NL;
const importEnd = "import { bylineSticker, portraitForArticle } from '../lib/credits.js';";
if (s.includes(importEnd) && !s.includes('function renderByline')) {
  s = s.replace(importEnd, importEnd + helper);
  console.log('added renderByline helper');
}

fs.writeFileSync(p, s);
const p = 'd:/website/Finalver/src/views/public.js';
let s = fs.readFileSync(p, 'utf8');

// 1) Fix the articleCard byline section that got duplicated earlier.
const articleDup = `</h3>
        ${bylineSticker(article.author, { cls: 'mt-1 text-[0.6875rem] ink-muted' })}
        ${portraitForArticle(article)
          ? bylineSticker(article.author, { cls: 'mt-1 text-[0.6875rem] ink-muted', portrait: portraitForArticle(article) })
          : bylineSticker(article.author, { cls: 'mt-1 text-[0.6875rem] ink-muted' })}
        ${renderByline(article, { cls: 'mt-1 text-[0.6875rem] ink-muted' })}
        ${renderByline(article, { cls: 'mt-1 text-[0.6875rem] ink-muted' })}`;
const articleFix = `</h3>
        ${renderByline(article, { cls: 'mt-1 text-[0.6875rem] ink-muted' })}`;
if (s.includes(articleDup)) { s = s.split(articleDup).join(articleFix); console.log('fixed articleCard dup'); }

// 2) Replace remaining bylineSticker calls with renderByline.
const pairs = [
  ['        ${bylineSticker(todaysPick.author, {\n          cls: \'mt-2 text-[0.6875rem] ink-muted\',\n          suffix: ` \u00b7 ${todaysPick.date}`\n        })}', '        ${renderByline(todaysPick, {\n          cls: \'mt-2 text-[0.6875rem] ink-muted\',\n          suffix: ` \u00b7 ${todaysPick.date}`\n        })}'],
  ['             ${bylineSticker(item.author, { cls: \'mt-1 text-[0.6875rem] ink-muted\' })}', '             ${renderByline(item, { cls: \'mt-1 text-[0.6875rem] ink-muted\' })}'],
  ['        ${bylineSticker(article.author, {\n          cls: \'mt-2 text-xs font-semibold tracking-wide uppercase ink-muted\'\n        })}', '        ${renderByline(article, {\n          cls: \'mt-2 text-xs font-semibold tracking-wide uppercase ink-muted\'\n        })}'],
  ['          ${bylineSticker(article.author, {\n            tag: \'span\',\n            cls: \'mt-0.5 block text-[0.6875rem] ink-muted\',\n            suffix: ` \u00b7 ${article.date}`\n          })}', '          ${renderByline(article, {\n            tag: \'span\',\n            cls: \'mt-0.5 block text-[0.6875rem] ink-muted\',\n            suffix: ` \u00b7 ${article.date}`\n          })}']
];
for (const [a, b] of pairs) {
  if (!s.includes(a)) { console.log('MISS: ' + a.slice(0, 60)); continue; }
  s = s.split(a).join(b);
  console.log('replaced: ' + a.slice(0, 50));
}

// 3) Add renderByline helper after the imports.
const helper = `
/**
 * Resolve a byline portrait by immutable FK first, then exact name.
 * This is the single place the front page / article modal / search
 * strip chooses which face to show next to an author name.
 */
function renderByline(article, opts = {}) {
  const portrait = portraitForArticle(article);
  const name = article?.author || 'The Pulse staff';
  return bylineSticker(name, { ...opts, portrait });
}
`;
const importEnd = "import { bylineSticker, portraitForArticle } from '../lib/credits.js';";
if (s.includes(importEnd) && !s.includes('function renderByline')) {
  s = s.replace(importEnd, importEnd + helper);
  console.log('added renderByline helper');
}

fs.writeFileSync(p, s);