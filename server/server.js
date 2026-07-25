const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3007;
const DATA_FILE = path.join(__dirname, 'data', 'data.json');

app.use(express.json({ limit: '1mb' }));

// CORS — allow requests from dhofstra.com
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://dhofstra.com');
  res.header('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// GET /api/homeimprovement/data — load all projects
app.get('/api/homeimprovement/data', (req, res) => {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);
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
    fs.writeFileSync(DATA_FILE, JSON.stringify(newData, null, 2), 'utf-8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`HomeImprovement API server running on port ${PORT}`);
});
