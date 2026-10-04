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

/** The side, in CSS pixels, of the square crop frame. */
function frameSide() {
  const view = byId('portrait-canvas');
  if (!view) return 1;
  const box = view.getBoundingClientRect();
  return Math.max(1, Math.min(box.width, box.height));
}

/**
 * Clamp the drag offset so the frame can never show empty canvas.
 *
 * THE BUG THIS REPLACES
 * The old line read `(image.width * scale - baseScale) / 2`. `image.width *
 * scale` is a LENGTH in CSS pixels; `baseScale` is a SCALE FACTOR. Subtracting
 * a dimensionless number from a length produced a slack hundreds of pixels too
 * large, so the photo could be dragged most of the way out of its own ring and
 * the saved square came out largely blank.
 *
 * THE CORRECT ARITHMETIC
 * The frame is `side` CSS px on a side. The image is painted at
 * `image.width * scale` CSS px wide. It may therefore move by exactly half of
 * the amount it OVERFLOWS the frame -- `(drawW - side) / 2` -- and not one
 * pixel further. At scale === baseScale the overflow is zero on the short axis
 * and positive on the long one, which is correct: a tall photo can slide
 * vertically until either end meets the ring, but never past it.
 *
 * It also makes zoom safe for free. Slack grows with scale, so the photo stays
 * pinned to the frame at every zoom level instead of drifting outward.
 */
function clampOffsets() {
  const { image, scale } = draft;
  if (!image) return;
  const side = frameSide();
  const slackX = Math.max(0, (image.width * scale - side) / 2);
  const slackY = Math.max(0, (image.height * scale - side) / 2);
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

/** Most the editor may zoom in, as a multiple of the "cover the frame" fit. */
const ZOOM_MAX = 6;

/**
 * Zoom, expressed as a 0-100 slider position, so the same control works whether
 * the editor dragged a slider, pressed +/-, pinched or scrolled.
 * @returns {number} 0 (fitted, cannot go lower) to 100 (maximum zoom)
 */
function zoomPercent() {
  if (!draft.image || draft.baseScale <= 0) return 0;
  return ((draft.scale / draft.baseScale - 1) / (ZOOM_MAX - 1)) * 100;
}

/** Push the current zoom back into the slider and the zoom readout. */
function syncZoomControl() {
  const slider = byId('portrait-zoom');
  const readout = byId('portrait-zoom-value');
  const percent = Math.round(zoomPercent());
  if (slider) {
    // Only write when it differs, or dragging the thumb fights the handler.
    if (Number(slider.value) !== percent) slider.value = String(percent);
    slider.setAttribute('aria-valuetext', `${percent}% zoom`);
  }
  if (readout) readout.textContent = `${percent}%`;
}

function applyZoom(next) {
  // The floor is baseScale: zooming OUT past "cover the frame" is exactly what
  // exposed blank canvas around the crop, so it is not offered at all.
  draft.scale = Math.max(draft.baseScale, Math.min(next, draft.baseScale * ZOOM_MAX));
  clampOffsets();
  paint();
  syncZoomControl();
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
  const { image, scale, offsetX, offsetY } = draft;
  if (!image) return Promise.reject(new Error('No photo loaded.'));

  const side = frameSide();

  // Size, in source-image pixels, of the square the frame is showing. `scale`
  // is CSS px per source px, so one CSS pixel of frame is 1/scale source
  // pixels -- OUTPUT is the ENCODED size and has no bearing on the region.
  //
  // The old code used OUTPUT / baseScale, which is unrelated to both, so the
  // crop sampled a region far larger than the ring showed and then clamped it
  // against the image edge. That is why the stored portrait could include
  // background the editor had deliberately framed out.
  const source = side / scale;

  // Same transform as paint(): the frame centre, mapped back to source pixels.
  const drawW = image.width * scale;
  const drawH = image.height * scale;
  const originX = (side - drawW) / 2 + offsetX;
  const originY = (side - drawH) / 2 + offsetY;
  const centreX = image.width / 2 + (side / 2 - originX) / scale;
  const centreY = image.height / 2 + (side / 2 - originY) / scale;

  // ClampOffsets guarantees this region lies inside the image; the clamp is
  // belt-and-braces against a float rounding error, not the boundary itself.
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
  // The Owner is exempt: the gate exists to verify writers, and whether the
  // Owner appears publicly is already controlled by `credits_visible`.
  //
  // `isOwner`, NOT `isAdmin`. Since the roles were split, `isAdmin` means "this
  // account may open the workspace at all" and is true for every active account
  // including new writers. Testing it here exempted every writer from the
  // portrait requirement entirely, which is the exact opposite of the intent.
  if (session.isOwner) {
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
  // Hide the zoom controls again: with no photo loaded they do nothing, and
  // leaving them visible between one photo and the next implies they still work.
  byId('portrait-zoom-controls')?.classList.add('hidden');
  // ...and bring the placeholder back, since there is again nothing to crop.
  byId('portrait-empty')?.classList.remove('hidden');
  byId('portrait-save')?.setAttribute('disabled', '');
  syncZoomControl();
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
  syncZoomControl();
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
    // Reveal the zoom controls only now there is something to zoom, and get the
    // "choose a photo" placeholder out of the way: it is absolutely positioned
    // over the frame, so leaving it up would print "Choose a photo" on top of
    // the very photo the writer is trying to line up.
    byId('portrait-zoom-controls')?.classList.remove('hidden');
    byId('portrait-empty')?.classList.add('hidden');
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

  // TWO-FINGER PINCH.
  // The wheel handler above covers a mouse and a trackpad, but iOS and Android
  // report a touch pinch as two pointerdowns and never send a wheel event at
  // all. Without this, touch is the one platform with no zoom -- which is most
  // of the readers of a phone-first site.
  //
  // Distance is measured between the two live touches and compared against the
  // distance when the pinch began, so the scale factor is the true ratio rather
  // than a guess. Only the zoom factor is taken from the gesture: dragging is
  // already handled by pointermove, and letting both run at once makes the
  // photo slide out from under the fingers.
  const touches = new Map();
  let pinchStartDistance = 0;
  let pinchStartScale = 0;

  view?.addEventListener(
    'pointerdown',
    (event) => {
      if (event.pointerType === 'touch') touches.set(event.pointerId, event);
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        pinchStartDistance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        pinchStartScale = draft.scale;
        // Drop any in-flight drag so the pinch does not fight it.
        draft.dragging = false;
      }
    },
    { capture: true }
  );

  view?.addEventListener(
    'pointermove',
    (event) => {
      if (event.pointerType !== 'touch' || !touches.has(event.pointerId)) return;
      touches.set(event.pointerId, event);
      if (touches.size !== 2 || !pinchStartDistance) return;
      event.preventDefault();
      const [a, b] = [...touches.values()];
      const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (distance <= 0) return;
      applyZoom(pinchStartScale * (distance / pinchStartDistance));
    },
    { passive: false, capture: true }
  );

  const endTouch = (event) => {
    touches.delete(event.pointerId);
    if (touches.size < 2) pinchStartDistance = 0;
  };
  view?.addEventListener('pointerup', endTouch, { capture: true });
  view?.addEventListener('pointercancel', endTouch, { capture: true });

  // Visible zoom controls. The slider is the precise control for a phone; the
  // two buttons are the ones that work one-handed, and they are real buttons
  // so they are reachable by keyboard and screen reader.
  const stepZoom = (factor) => () => applyZoom(draft.scale * factor);

  byId('portrait-zoom-in')?.addEventListener('click', stepZoom(1.25));
  byId('portrait-zoom-out')?.addEventListener('click', stepZoom(0.8));
  byId('portrait-zoom-reset')?.addEventListener('click', () => {
    draft.offsetX = 0;
    draft.offsetY = 0;
    applyZoom(draft.baseScale);
  });

  byId('portrait-zoom')?.addEventListener('input', (event) => {
    const percent = Math.max(0, Math.min(100, Number(event.target.value) || 0));
    // Interpolate between "cover the frame" and maximum zoom, so the slider's
    // midpoint is genuinely half-zoomed rather than half of some other scale.
    const factor = 1 + (percent / 100) * (ZOOM_MAX - 1);
    applyZoom(draft.baseScale * factor);
  });

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
 * Has this writer satisfied the portrait requirement?
 *
 * Returns true for the Owner (the gate exists to verify writers) and in demo
 * mode (there is no server to approve against, so blocking would be a dead end).
 *
 * The Owner test is `isOwner`, not `isAdmin`. `isAdmin` is true for every active
 * account since the roles were split, so using it here would exempt every writer
 * from the requirement and leave the gate permanently open.
 */
export function portraitRequirementMet(staffRow, session) {
  if (config.demoMode) return true;
  if (session?.isOwner) return true;
  return staffRow?.portrait_status === 'approved';
}

/**
 * Has this writer at least uploaded something, approved or not? A rejected
 * portrait still counts as "tried", which keeps the writer out of a loop where
 * the gate blocks the very screen they need to fix it.
 */
export function portraitRequirementSatisfiable(staffRow) {
  return ['pending', 'approved'].includes(staffRow?.portrait_status);
}

