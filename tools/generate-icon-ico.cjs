'use strict';
/* Generate src/assets/icon.ico from src/assets/icon.png (run: npm run icons) */
const fs = require('fs');
const path = require('path');

async function main() {
  const pngToIco = require('png-to-ico');
  const pngPath = path.join(__dirname, '..', 'src', 'assets', 'icon.png');
  const icoPath = path.join(__dirname, '..', 'src', 'assets', 'icon.ico');
  if (!fs.existsSync(pngPath)) {
    console.error('Missing', pngPath);
    process.exit(1);
  }
  const buf = await pngToIco(fs.readFileSync(pngPath));
  fs.writeFileSync(icoPath, buf);
  console.log('Wrote', icoPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
