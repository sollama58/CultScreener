#!/usr/bin/env node
// Generate PNG icons from SVG for PWA manifest
// Usage: node generate-pngs.js
// Requires: npm install sharp (or use the HTML generator as fallback)

const fs = require('fs');
const path = require('path');

async function generate() {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.log('sharp not installed. Install with: npm install sharp');
    console.log('Alternatively, open generate-icons.html in a browser to create PNGs manually.');
    process.exit(1);
  }

  const configs = [
    { input: 'icon.svg', output: 'icon-192.png', size: 192 },
    { input: 'icon.svg', output: 'icon-512.png', size: 512 },
    { input: 'icon-maskable.svg', output: 'icon-maskable-192.png', size: 192 },
    { input: 'icon-maskable.svg', output: 'icon-maskable-512.png', size: 512 },
  ];

  const dir = __dirname;

  for (const { input, output, size } of configs) {
    const inputPath = path.join(dir, input);
    const outputPath = path.join(dir, output);

    await sharp(inputPath)
      .resize(size, size)
      .png()
      .toFile(outputPath);

    console.log(`Created ${output} (${size}x${size})`);
  }

  console.log('Done! All PNG icons generated.');
}

generate().catch(console.error);
