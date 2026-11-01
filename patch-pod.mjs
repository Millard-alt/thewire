import { readFileSync, writeFileSync } from 'node:fs';
const F = 'src/lib/podcasts.js';
const src = readFileSync(F, 'utf8');
const nl = src.includes('\r\n') ? '\r\n' : '\n';
const lines = src.split(/\r?\n/);
const i = lines.findIndex((l, n) => n > 460 && n < 500 && l.trim() === 'const path = objectName(file);');
if (i === -1) { console.error('anchor not found'); process.exit(1); }
// Walk back to the "// Pre-flight the bucket." comment.
let s = i;
while (!/^\s*\/\/ Pre-flight the bucket\./.test(lines[s])) s--;
// Walk forward to the getPublicUrl assignment.
let e = i;
while (!/url = urlData\?\.publicUrl/.test(lines[e])) e++;
console.log('replacing lines', s + 1, 'to', e + 1);

const replacement = [
  '    /*',
  '      UPLOAD ONLY WHEN THERE IS A FILE.',
  '',
  '      A pasted URL short-circuits the whole Storage path: there is nothing to',
  '      upload, nothing that can fail, and nothing that needs a writable bucket --',
  '      which is what lets a Writer file an episode by link on a deployment whose',
  '      Storage is misconfigured. `storage_path` stays NULL so a later purge knows',
  '      there is no object to remove rather than trying to delete one.',
  '    */',
  '    let path = null;',
  "    let url = cleanAudioUrl;",
  '',
  '    if (file) {',
  '      // Pre-flight the bucket. Uploading 25 MB to discover the bucket is missing',
  "      // wastes the writer's data allowance and their time, and the failure they see",
  "      // is a bare \"Failed to load resource\" in a console they may never open.",
  '      const ready = await checkPodcastStorage();',
  '      if (!ready.ok) return { ok: false, message: ready.message };',
  '',
  '      path = objectName(file);',
  '',
  '      const { error: uploadError } = await client.storage',
  '        .from(BUCKET)',
  '        // `contentType` is set explicitly rather than left to the browser\'s guess:',
  '        // the object is served back to an <audio> tag, and some browsers report an',
  '        // mp3 as `application/octet-stream`, which makes the response download',
  '        // rather than play. There is no multipart form here -- a supabase-js upload',
  '        // is a single binary PUT -- so nothing about this is a CORS preflight beyond',
  '        // the Authorization header the client always sends.',
  '        .upload(path, file, { cacheControl: \'31536000\', upsert: false, contentType: MP3_MIME });',
  '',
  '      if (uploadError) {',
  '        // No data-URL fallback here, unlike upload.js: an MP3 will not fit in',
  '        // localStorage and silently "succeeding" would lose a recorded episode. Say',
  "        // so plainly and leave the writer's file untouched on their device.",
  '        return {',
  '          ok: false,',
  "          message: `${describeStorageError(uploadError, 'the episode')} Your file is still on this device.`",
  '        };',
  '      }',
  '',
  '      const { data: urlData } = client.storage.from(BUCKET).getPublicUrl(path);',
  '      url = urlData?.publicUrl || \'\';',
  '    }'
];

const out = [...lines.slice(0, s), ...replacement, ...lines.slice(e + 1)];
writeFileSync(F, out.join(nl), 'utf8');
console.log('written');
