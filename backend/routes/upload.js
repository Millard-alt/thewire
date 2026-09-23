const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const CLOUDINARY_CONFIGURED = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

let storage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  }
});
// When Cloudinary is set up we don't need to keep a local copy — stream straight to it.
if (CLOUDINARY_CONFIGURED) storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, WEBP or GIF images are allowed.'));
    }
    cb(null, true);
  }
});

async function uploadToCloudinary(buffer, originalFilename) {
  const cloudinary = require('cloudinary').v2;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'the-wire', resource_type: 'image', format: 'jpg' },
      (error, result) => (error ? reject(error) : resolve(result.secure_url))
    );
    stream.end(buffer);
  });
}

router.post('/', requireAuth, async (req, res) => {
  upload.single('photo')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No photo was uploaded.' });
    try {
      let url;
      if (CLOUDINARY_CONFIGURED) {
        url = await uploadToCloudinary(req.file.buffer, req.file.originalname);
      } else {
        url = '/uploads/' + req.file.filename;
      }
      res.json({ url });
    } catch (e) {
      console.error('Upload failed:', e);
      res.status(500).json({ error: 'Upload failed.' });
    }
  });
});

module.exports = router;
