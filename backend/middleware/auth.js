const jwt = require('jsonwebtoken');
const { db } = require('../db');
const asyncHandler = require('../lib/asyncHandler');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const requireAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Log in to continue.' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Your session expired — log in again.' });
  }
  // Load the live user row so role / portrait status are always current.
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
  if (!user) return res.status(401).json({ error: 'Account no longer exists.' });
  req.user = user;
  next();
});

function requireOwner(req, res, next) {
  if (!req.user || req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Only the Owner can do that.' });
  }
  next();
}

/* Any staff member allowed to create content (editor OR assignment_manager). */
function requireEditor(req, res, next) {
  if (!req.user || !['editor', 'assignment_manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Staff access required.' });
  }
  next();
}

/* Editors cannot publish, submit or touch the board until the owner approves
   their self-portrait. The Owner bypasses this entirely. */
function requireApprovedPortrait(req, res, next) {
  if (req.user.role === 'owner') return next();
  if (req.user.portrait_status !== 'approved') {
    return res.status(403).json({ error: 'Upload a self-portrait and wait for Owner approval before using the newsroom.' });
  }
  next();
}

/* Assignment Board management: Owner OR an editor granted the Assignment Manager role. */
function requireAssignmentManager(req, res, next) {
  if (!req.user || !['owner', 'assignment_manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Assignment Manager access required.' });
  }
  next();
}

module.exports = { requireAuth, requireOwner, requireEditor, requireApprovedPortrait, requireAssignmentManager, JWT_SECRET };
