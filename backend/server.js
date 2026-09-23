require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const database = require('./db'); // opens the database and seeds it on first run
const { ready } = database;

const authRoutes = require('./routes/auth');
const contentRoutes = require('./routes/content');
const queueRoutes = require('./routes/queue');
const editorsRoutes = require('./routes/editors');
const uploadRoutes = require('./routes/upload');
const boardRoutes = require('./routes/board');
const settingsRoutes = require('./routes/settings');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Uploaded photos
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Handy for moving a local SQLite seed into Supabase: GET /db.js
app.get('/db.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'db.js')));

// API
app.use('/api/auth', authRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/editors', editorsRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/board', boardRoutes);
app.use('/api/settings', settingsRoutes);

// Frontend (serves ../frontend as the site itself, so the whole app is one process/one port)
const frontendDir = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next();
  res.sendFile(path.join(frontendDir, 'index.html'));
});

// Basic error handler (async route failures land here thanks to lib/asyncHandler)
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Server error.' });
});

// Don't accept traffic until the database schema is in place and reachable.
ready
  .then(() => {
    app.listen(PORT, () => {
      const backend = database.USE_POSTGRES ? 'Postgres' : 'SQLite';
      console.log(`The Wire is running at http://localhost:${PORT} [${backend}]`);
    });
  })
  .catch((err) => {
    console.error('Startup aborted — database unavailable.');
    process.exit(1);
  });
