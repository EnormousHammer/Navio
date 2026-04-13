'use strict';
/* Square-crop + resize icon.png, write icon.ico (run: npm run icons) */
const fs = require('fs');
const path = require('path');

async function main() {
  const sharp = require('sharp');
  const pngToIco = require('png-to-ico');
  const pngPath = path.join(__dirname, '..', 'src', 'assets', 'icon.png');
  const icoPath = path.join(__dirname, '..', 'src', 'assets', 'icon.ico');
  if (!fs.existsSync(pngPath)) {
    console.error('Missing', pngPath);
    process.exit(1);
  }

  const TARGET = 512;
  let buf = fs.readFileSync(pngPath);
  const meta = await sharp(buf).metadata();
  const w = meta.width || TARGET;
  const h = meta.height || TARGET;
  if (w !== h || w !== TARGET) {
    const side = Math.min(w, h);
    buf = await sharp(buf)
      .extract({
        left: Math.max(0, Math.floor((w - side) / 2)),
        top: Math.max(0, Math.floor((h - side) / 2)),
        width: side,
        height: side
      })
      .resize(TARGET, TARGET, { fit: 'fill' })
      .png()
      .toBuffer();
    fs.writeFileSync(pngPath, buf);
    console.log('Normalized square PNG →', TARGET, '×', TARGET);
  }

  const icoBuf = await pngToIco(buf);
  fs.writeFileSync(icoPath, icoBuf);
  console.log('Wrote', icoPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
