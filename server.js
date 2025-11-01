const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const rootDir = __dirname;

// Serve static files from the project root
app.use(express.static(rootDir, {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    // Disable aggressive caching for JSON
    if (path.extname(filePath) === '.json') {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// Fallback to index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(rootDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


