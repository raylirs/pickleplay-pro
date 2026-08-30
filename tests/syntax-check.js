const fs = require('fs');
const path = require('path');

function getJsFiles(dir) {
  let files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'public') {
        files = files.concat(getJsFiles(fullPath));
      }
    } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.startsWith('main') && !entry.name.startsWith('socket') && !entry.name.startsWith('reservation')) {
      // Backend JS files
      files.push(fullPath);
    }
  }
  return files;
}

const jsFiles = getJsFiles(path.resolve(__dirname, '..'));
let errors = 0;

for (const file of jsFiles) {
  try {
    require(file);
    console.log('OK:', path.relative(path.resolve(__dirname, '..'), file));
  } catch (err) {
    console.error('ERROR in ' + file + ':', err.message);
    errors++;
  }
}

if (errors > 0) {
  console.error('\nFound ' + errors + ' errors.');
  process.exit(1);
} else {
  console.log('\nAll ' + jsFiles.length + ' backend JavaScript files loaded with 100% valid syntax!');
  process.exit(0);
}
