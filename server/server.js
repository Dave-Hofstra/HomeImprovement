const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3007;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const ATTACH_DIR = path.join(DATA_DIR, 'attachments');
const MAX_UPLOAD = 20 * 1024 * 1024; // 20 MB per file
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

fs.mkdirSync(ATTACH_DIR, { recursive: true });

app.use(express.json({ limit: '2mb' }));

// CORS — allow requests from dhofstra.com
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://dhofstra.com');
  res.header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ─── Data helpers ─────────────────────────────────────────
function readData() {
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  return JSON.parse(raw);
}

// data.json is bind-mounted as a single file, so it MUST be written in place
// (a tmp-file + rename would fail with EBUSY on the mount point).
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function publicAtt(att) {
  return {
    id: att.id,
    name: att.name,
    size: att.size,
    type: att.type,
    uploadedAt: att.uploadedAt
  };
}

// Multer hands us the original filename as latin1; recover UTF-8 names.
function decodeName(name) {
  if (!name) return 'document';
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return decoded.includes('\uFFFD') ? name : decoded;
  } catch (e) {
    return name;
  }
}

function cleanupFile(file) {
  try {
    if (file && file.path) fs.unlinkSync(file.path);
  } catch (e) {
    /* ignore */
  }
}

// ─── Upload config ────────────────────────────────────────
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const pid = req.params.projectId;
    if (!SAFE_ID.test(pid || '')) return cb(new Error('Invalid project id'));
    const dir = path.join(ATTACH_DIR, pid);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      return cb(e);
    }
    cb(null, dir);
  },
  filename(req, file, cb) {
    const id = crypto.randomBytes(8).toString('hex');
    let ext = path.extname(file.originalname || '').toLowerCase();
    if (!/^\.[a-z0-9]{1,8}$/.test(ext)) ext = '';
    cb(null, id + ext);
  }
});

const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD, files: 1 } });

// ─── Projects ─────────────────────────────────────────────
// GET /api/homeimprovement/data — load all projects
app.get('/api/homeimprovement/data', (req, res) => {
  try {
    const data = readData();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/homeimprovement/data — save all projects
app.put('/api/homeimprovement/data', (req, res) => {
  try {
    const newData = req.body;
    if (!newData || !newData.projects) {
      return res.status(400).json({ success: false, error: 'Invalid data format' });
    }
    writeData(newData);

    // Drop attachment folders whose project no longer exists
    try {
      const ids = new Set(newData.projects.map((p) => p.id));
      for (const name of fs.readdirSync(ATTACH_DIR)) {
        if (!ids.has(name)) {
          fs.rmSync(path.join(ATTACH_DIR, name), { recursive: true, force: true });
        }
      }
    } catch (e) {
      console.warn('attachment cleanup failed:', e.message);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Attachments ──────────────────────────────────────────
// POST /api/homeimprovement/attachments/:projectId — upload one file
app.post('/api/homeimprovement/attachments/:projectId', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'File is too large (20 MB max)'
        : err.message || 'Upload failed';
      return res.status(400).json({ success: false, error: msg });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file received' });
    }

    const pid = req.params.projectId;
    let data;
    try {
      data = readData();
    } catch (e) {
      cleanupFile(req.file);
      return res.status(500).json({ success: false, error: e.message });
    }

    const project = (data.projects || []).find((p) => p.id === pid);
    if (!project) {
      cleanupFile(req.file);
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const att = {
      id: path.parse(req.file.filename).name,
      name: decodeName(req.file.originalname),
      stored: req.file.filename,
      size: req.file.size,
      type: req.file.mimetype || 'application/octet-stream',
      uploadedAt: new Date().toISOString()
    };

    if (!Array.isArray(project.attachments)) project.attachments = [];
    project.attachments.push(att);

    try {
      writeData(data);
    } catch (e) {
      cleanupFile(req.file);
      return res.status(500).json({ success: false, error: e.message });
    }

    res.json({
      success: true,
      attachment: publicAtt(att),
      attachments: project.attachments.map(publicAtt)
    });
  });
});

// GET /api/homeimprovement/attachments/:projectId/:attId — view / download
app.get('/api/homeimprovement/attachments/:projectId/:attId', (req, res) => {
  try {
    const pid = req.params.projectId;
    const data = readData();
    const project = (data.projects || []).find((p) => p.id === pid);
    const att = project && (project.attachments || []).find((a) => a.id === req.params.attId);
    if (!att) return res.status(404).send('Attachment not found');

    const filePath = path.join(ATTACH_DIR, pid, att.stored || '');
    if (!filePath.startsWith(ATTACH_DIR + path.sep) || !fs.existsSync(filePath)) {
      return res.status(404).send('File missing on disk');
    }

    const inline = req.query.inline === '1' && /^(image\/|application\/pdf)/i.test(att.type || '');
    const filename = (att.name || 'document').replace(/["\\\r\n]/g, '_');

    res.setHeader('Content-Type', att.type || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      (inline ? 'inline' : 'attachment') +
        "; filename=\"" + filename + "\"; filename*=UTF-8''" + encodeURIComponent(filename)
    );
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// DELETE /api/homeimprovement/attachments/:projectId/:attId
app.delete('/api/homeimprovement/attachments/:projectId/:attId', (req, res) => {
  try {
    const pid = req.params.projectId;
    const data = readData();
    const project = (data.projects || []).find((p) => p.id === pid);
    if (!project) return res.status(404).json({ success: false, error: 'Project not found' });

    const list = Array.isArray(project.attachments) ? project.attachments : [];
    const att = list.find((a) => a.id === req.params.attId);
    if (!att) return res.status(404).json({ success: false, error: 'Attachment not found' });

    project.attachments = list.filter((a) => a.id !== att.id);
    writeData(data);

    try {
      const filePath = path.join(ATTACH_DIR, pid, att.stored || '');
      if (filePath.startsWith(ATTACH_DIR + path.sep) && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
      console.warn('could not remove attachment file:', e.message);
    }

    res.json({ success: true, attachments: project.attachments.map(publicAtt) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`HomeImprovement API server running on port ${PORT}`);
});
