/* =============================================================================
   src/lib/portrait.js — SELFIE CAPTURE, FACE CROP AND PUBLICATION
   -----------------------------------------------------------------------------
   An approved editor must attach a portrait of themselves before they can use
   the workspace. This module handles the whole flow:

     1. validateSelfie(file)    check a photo the editor chose
     2. openPortraitEditor()    face-crop dialog: drag to position, wheel or
                                pinch to zoom, live circular preview
     3. cropToSquare()          render the chosen region to a square canvas
     4. publishPortrait()       upload the square, submit it for approval

   Why crop in the browser
   -----------------------
   Only the finished square is ever uploaded, so a full-length photo of a person
   never reaches the database or the storage bucket. It is also the only way to
   do this without shipping a heavyweight face-detection library to the browser,
   which would cost far more bundle size than the feature is worth at this size.

   The crop is square, not circular. A circular PNG needs transparency, which
   JPEG cannot carry, so a square is stored and the circular "sticker" look is
   applied in CSS. One file, any format, no alpha channel required.

   Privacy stance
   --------------
   A portrait is never public until BOTH the editor has submitted it AND the
   Owner has approved it. The Owner can reject it, which hides it everywhere.
   ========================================================================== */

import { config } from './config.js';
import { getSupabase } from './supabase.js';
import { byId, showToast, openDialog, closeDialog } from './dom.js';
import { getSession } from './auth.js';

const BUCKET = 'wire-media';
const MAX_BYTES = 12 * 1024 * 1024; // selfies straight off a phone camera
const OUTPUT = 512; // square edge in pixels — far more than a sticker needs

/** The single crop state, held only while the dialog is open. */
let draft = {
  file: null,
  image: null,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  baseScale: 1,
  dragging: false,
  startX: 0,
  startY: 0
};

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

const ALLOWED = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};

/**
 * @param {File} file
 * @returns {string} an error message, or '' when the file is usable
 */
export function validateSelfie(file) {
  if (!file) return 'Choose a photo of yourself first.';
  if (!ALLOWED[file.type]) return 'Use a JPEG, PNG or WebP photo.';
  if (file.size > MAX_BYTES) {
    const mb = Math.round(file.size / (1024 * 1024));
    return `That photo is ${mb} MB. The limit is 12 MB.`;
  }
  return '';
}

/* -------------------------------------------------------------------------- */
/* Image loading                                                               */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Crop painting                                                               */
/* -------------------------------------------------------------------------- */

/** Clamp the offset so the image can never be dragged inside out of frame. */
function clampOffsets() {
  const { image, scale, baseScale } = draft;
  if (!image) return;
  const slackX = Math.max(0, (image.width * scale - baseScale) / 2);
  const slackY = Math.max(0, (image.height * scale - baseScale) / 2);
  draft.offsetX = Math.max(-slackX, Math.min(slackX, draft.offsetX));
  draft.offsetY = Math.max(-slackY, Math.min(slackY, draft.offsetY));
}

/** Redraw the crop viewport and the circular live preview. */
function paint() {
  const { image, scale, offsetX, offsetY, baseScale } = draft;
  if (!image) return;

  const view = byId('portrait-canvas');
  const preview = byId('portrait-preview');
  if (!view) return;

  const box = view.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const side = Math.max(1, Math.min(box.width, box.height));

  view.width = Math.round(side * dpr);
  view.height = Math.round(side * dpr);

  const ctx = view.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, side, side);

  // Centre the scaled image, then apply the drag offset.
  const drawW = image.width * scale;
  const drawH = image.height * scale;
  const originX = (side - drawW) / 2 + offsetX;
  const originY = (side - drawH) / 2 + offsetY;

  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, originX, originY, drawW, drawH);

  // Guide ring, so the editor can see exactly what will be kept.
  ctx.beginPath();
  ctx.arc(side / 2, side / 2, side / 2 - 1.5, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // The preview mirrors the viewport and is masked to a circle by CSS.
  if (preview) {
    const pctx = preview.getContext('2d');
    const ps = preview.width;
    pctx.clearRect(0, 0, ps, ps);
    const k = ps / side;
    pctx.drawImage(image, originX * k, originY * k, drawW * k, drawH * k);
  }
}

function applyZoom(next) {
  draft.scale = Math.max(draft.baseScale, Math.min(next, draft.baseScale * 6));
  clampOffsets();
  paint();
}


function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file could not be read as an image.'));
    };
    image.src = url;
  });
}

/* -------------------------------------------------------------------------- */
/* Rendering the finished square                                               */
/* -------------------------------------------------------------------------- */

/**
 * Draw the chosen region onto a square canvas at OUTPUT x OUTPUT.
 * The crop is centred on the same maths as `paint`, so what the editor framed
 * is exactly what gets stored.
 * @returns {Promise<Blob>} a JPEG blob, ready to upload
 */
function cropToSquare() {
  const { image, scale, offsetX, offsetY, baseScale } = draft;
  if (!image) return Promise.reject(new Error('No photo loaded.'));

  // Size, in source-image pixels, that maps to the whole canvas.
  const source = OUTPUT / baseScale;
  const centreX = image.width / 2 - offsetX / scale;
  const centreY = image.height / 2 - offsetY / scale;
  const sx = Math.max(0, Math.min(image.width - source, centreX - source / 2));
  const sy = Math.max(0, Math.min(image.height - source, centreY - source / 2));

  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT;
  canvas.height = OUTPUT;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, sx, sy, source, source, 0, 0, OUTPUT, OUTPUT);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not build the portrait.'))),
      'image/jpeg',
      0.86
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Publishing                                                                  */
/* -------------------------------------------------------------------------- */

/** Upload the square to Storage, returning its public URL. */
async function uploadSquare(blob, username) {
  const client = getSupabase();
  if (!client) throw new Error('Not connected to the newsroom server.');

  // A canvas blob has no filename, so give Storage a real extension.
  const file = new File([blob], `${username || 'member'}.jpg`, { type: 'image/jpeg' });
  const path = `portraits/${username || 'member'}-${Date.now().toString(36)}.jpg`;

  const { error } = await client.storage
    .from(BUCKET)
    .upload(path, file, { cacheControl: '31536000', upsert: true });
  if (error) throw error;

  const { data } = client.storage.from(BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error('Storage did not return a public URL.');
  return data.publicUrl;
}

/**
 * Submit the current crop for the Owner's approval.
 *
 * Uploading and approving are deliberately separate steps: the Owner sees the
 * portrait and decides. Until then it is invisible to readers.
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function publishPortrait() {
  const session = getSession();
  if (!session?.user) {
    return { ok: false, message: 'Sign in before uploading a portrait.' };
  }
  // The Owner is exempt: the gate exists to verify editors, and whether the
  // Owner appears publicly is already controlled by `credits_visible`.
  if (session.isAdmin) {
    return { ok: false, message: 'The Owner does not need a portrait to work.' };
  }

  if (config.demoMode) {
    return { ok: true, message: 'Demo mode: stored in this browser only.' };
  }

  try {
    const blob = await cropToSquare();
    const username = session.user.username || session.user.email;
    const url = await uploadSquare(blob, username);

    const { error } = await getSupabase().rpc('wire_submit_portrait', { p_url: url });
    if (error) throw error;

    return {
      ok: true,
      message: 'Portrait submitted. The Owner will review it before it appears.'
    };
  } catch (error) {
    // By far the likeliest cause is migration 005 not being applied yet.
    if (error.code === '42883' || /wire_submit_portrait/.test(error.message || '')) {
      return {
        ok: false,
        message:
          'The newsroom server is missing the portrait tables. Run supabase/005_portraits_and_credits.sql in the Supabase SQL editor.'
      };
    }
    return { ok: false, message: error.message || 'Could not upload the portrait.' };
  }
}

/* -------------------------------------------------------------------------- */
/* The crop dialog                                                             */
/* -------------------------------------------------------------------------- */

function resetDraft() {
  draft = {
    file: null,
    image: null,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    baseScale: 1,
    dragging: false,
    startX: 0,
    startY: 0
  };
}

/** Set the starting zoom so the image always covers the frame. */
function fitImage() {
  const view = byId('portrait-canvas');
  if (!view || !draft.image) return;
  const box = view.getBoundingClientRect();
  const side = Math.max(1, Math.min(box.width, box.height));
  // Cover, not contain: the frame must never show empty canvas.
  draft.baseScale = Math.max(side / draft.image.width, side / draft.image.height);
  draft.scale = draft.baseScale;
  draft.offsetX = 0;
  draft.offsetY = 0;
}

/** Load a File into the draft and frame it. */
async function acceptFile(file) {
  const problem = validateSelfie(file);
  if (problem) {
    showToast(problem, { type: 'error' });
    return;
  }
  try {
    const image = await loadImage(file);
    draft.file = file;
    draft.image = image;
    fitImage();
    paint();
    byId('portrait-save')?.removeAttribute('disabled');
  } catch (error) {
    showToast(error.message, { type: 'error' });
  }
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                      */
/* -------------------------------------------------------------------------- */

let wired = false;

/** Bind the dialog's controls once; the dialog lives in index.html forever. */
function wire() {
  if (wired) return;
  wired = true;

  byId('portrait-input')?.addEventListener('change', (event) => {
    acceptFile(event.target.files?.[0]);
  });

  // Clicking the empty frame is the natural way to pick a photo on desktop.
  byId('portrait-canvas')?.addEventListener('click', () => {
    byId('portrait-input')?.click();
  });

  const view = byId('portrait-canvas');

  // Drag to reposition the face.
  view?.addEventListener('pointerdown', (event) => {
    if (!draft.image) return;
    draft.dragging = true;
    draft.startX = event.clientX - draft.offsetX;
    draft.startY = event.clientY - draft.offsetY;
    view.setPointerCapture?.(event.pointerId);
  });

  view?.addEventListener('pointermove', (event) => {
    if (!draft.dragging) return;
    draft.offsetX = event.clientX - draft.startX;
    draft.offsetY = event.clientY - draft.startY;
    clampOffsets();
    paint();
  });

  const stopDrag = () => {
    draft.dragging = false;
  };
  view?.addEventListener('pointerup', stopDrag);
  view?.addEventListener('pointercancel', stopDrag);

  // Wheel and pinch to zoom.
  view?.addEventListener(
    'wheel',
    (event) => {
      if (!draft.image) return;
      event.preventDefault();
      applyZoom(draft.scale * (event.deltaY < 0 ? 1.12 : 0.89));
    },
    { passive: false }
  );

  // Trackpad pinch arrives as ctrl+wheel.
  view?.addEventListener(
    'gesturestart',
    (event) => event.preventDefault(),
    { passive: false }
  );

  // Keyboard: arrows nudge, +/- zoom. Keeps the crop usable without a mouse.
  document.addEventListener('keydown', (event) => {
    if (!document.getElementById('portrait-modal')?.classList.contains('hidden')) return;
    if (!draft.image) return;
    const step = event.shiftKey ? 12 : 3;
    const zoomKeys = ['+', '=', '-', '_'];
    if (event.key === 'ArrowLeft') draft.offsetX += step;
    else if (event.key === 'ArrowRight') draft.offsetX -= step;
    else if (event.key === 'ArrowUp') draft.offsetY += step;
    else if (event.key === 'ArrowDown') draft.offsetY -= step;
    else if (zoomKeys.includes(event.key)) {
      event.preventDefault();
      applyZoom(draft.scale * (event.key === '-' || event.key === '_' ? 0.89 : 1.12));
      return;
    } else return;
    event.preventDefault();
    clampOffsets();
    paint();
  });

  byId('portrait-save')?.addEventListener('click', async (event) => {
    if (!draft.image) {
      showToast('Choose a photo before saving.', { type: 'error' });
      return;
    }
    const button = event.currentTarget;
    button.setAttribute('disabled', '');
    try {
      const result = await publishPortrait();
      showToast(result.message, { type: result.ok ? 'success' : 'error' });
      if (result.ok) closeDialog('portrait-modal');
    } finally {
      button.removeAttribute('disabled');
    }
  });

  // Redraw when the viewport changes, so the guide ring stays aligned.
  window.addEventListener('resize', () => {
    if (draft.image && !document.getElementById('portrait-modal')?.classList.contains('hidden')) {
      fitImage();
      paint();
    }
  });
}

/**
 * Open the crop dialog. `file` pre-loads a photo (used by the file input).
 * Callers get a promise-free API: the dialog reports its own outcome to the user.
 */
export function openPortraitEditor(file) {
  wire();
  resetDraft();
  byId('portrait-save')?.setAttribute('disabled', '');
  openDialog('portrait-modal');
  if (file) acceptFile(file);
}

/* -------------------------------------------------------------------------- */
/* Gate helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Has this editor satisfied the portrait requirement?
 *
 * Returns true for the Owner (the gate exists to verify editors) and in demo
 * mode (there is no server to approve against, so blocking would be a dead end).
 */
export function portraitRequirementMet(staffRow, session) {
  if (config.demoMode) return true;
  if (session?.isAdmin) return true;
  return staffRow?.portrait_status === 'approved';
}

/**
 * Has this editor at least uploaded something, approved or not? A rejected
 * portrait still counts as "tried", which keeps the editor out of a loop where
 * the gate blocks the very screen they need to fix it.
 */
export function portraitRequirementSatisfiable(staffRow) {
  return ['pending', 'approved'].includes(staffRow?.portrait_status);
}

