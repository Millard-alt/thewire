/* =============================================================================
   src/lib/upload.js — IMAGE UPLOADS
   -----------------------------------------------------------------------------
   Editors pick a file from their device; this module puts it in Supabase
   Storage and hands back a public URL that is written into the article or media
   row. It also works offline by falling back to a data URL, so the form is
   never blocked just because Storage is unreachable.

   Why Supabase Storage and not an external service:
     * It is already part of the project, so there is no new vendor account,
       no new billing surface and no second set of credentials to leak.
     * The free tier is far larger than a small newsroom needs.
     * The URL is served from the same origin as the API, so no extra CSP
       allowance and no ad-blocker rule to trip over.
   ========================================================================== */

import { config } from './config.js';
import { getSupabase } from './supabase.js';

const BUCKET = 'wire-media';

/** Only image types, and a hard 8 MB ceiling (Storage's per-object limit). */
const MAX_BYTES = 8 * 1024 * 1024;

const ALLOWED = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif'
};

/**
 * Validate a File the editor chose.
 * @param {File} file
 * @returns {string} the error message, or '' when the file is acceptable
 */
export function validateImageFile(file) {
  if (!file) return 'Choose an image from your device first.';
  if (!ALLOWED[file.type]) {
    return 'Use a JPEG, PNG, WebP, GIF or AVIF image.';
  }
  if (file.size > MAX_BYTES) {
    const mb = Math.round(file.size / (1024 * 1024));
    return `That image is ${mb} MB. The limit is 8 MB.`;
  }
  return '';
}

/** A collision-resistant object name that keeps the original extension. */
function objectName(file) {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}.${ALLOWED[file.type]}`;
}

/**
 * Upload an image and return a URL to store in the database.
 * Falls back to an inline data URL when Storage is unavailable, so the editor
 * is never stuck; `isLocal` in the result says which path was taken.
 * @param {File} file
 * @returns {Promise<{url: string, isLocal: boolean}>}
 */
export async function uploadImage(file) {
  const problem = validateImageFile(file);
  if (problem) throw new Error(problem);

  const client = config.demoMode ? null : getSupabase();

  if (client) {
    try {
      const path = objectName(file);
      const { error } = await client.storage
        .from(BUCKET)
        .upload(path, file, { cacheControl: '31536000', upsert: false });

      if (error) throw error;

      // public=true makes the bucket return a stable public URL, which is what
      // goes in `image_url`.
      const { data } = client.storage.from(BUCKET).getPublicUrl(path);
      if (data?.publicUrl) return { url: data.publicUrl, isLocal: false };
      throw new Error('Storage did not return a public URL.');
    } catch (error) {
      console.warn('[upload] Storage unavailable, using local copy', error);
      // fall through to the data URL so the editor can still publish
    }
  }

  const url = await readAsDataUrl(file);
  return { url, isLocal: true };
}

/** Read a File into a base64 data URL. */
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Wire a file input so choosing a file immediately fills the paired URL field
 * and shows a thumbnail. Mobile friendly: the input is styled as a button and
 * the image is previewed at a comfortable size.
 * @param {HTMLInputElement} fileInput  type="file" accept="image/*"
 * @param {HTMLInputElement} urlInput   the text field that receives the URL
 * @param {(url: string) => void} [onUploaded]
 */
export function bindImagePicker(fileInput, urlInput, onUploaded) {
  if (!fileInput || !urlInput) return;

  const status = document.createElement('p');
  status.className = 'text-[0.7rem] text-ink-muted mt-1';
  fileInput.insertAdjacentElement('afterend', status);

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    const problem = validateImageFile(file);
    if (problem) {
      status.textContent = problem;
      status.classList.add('text-newsred');
      return;
    }

    status.textContent = 'Uploading…';
    status.classList.remove('text-newsred');

    try {
      const { url, isLocal } = await uploadImage(file);
      urlInput.value = url;
      status.textContent = isLocal
        ? 'Stored in this browser only. Configure Supabase Storage to share it.'
        : 'Uploaded. Remember to save the article.';
      status.classList.toggle('text-newsgold', isLocal);
      onUploaded?.(url);
    } catch (error) {
      status.textContent = error.message || 'Upload failed.';
      status.classList.add('text-newsred');
    }
  });
}
