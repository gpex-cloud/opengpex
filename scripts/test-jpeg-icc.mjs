/**
 * Quick diagnostic: test if ExifReader can find ICC from EXIF-embedded profiles.
 * Usage: node scripts/test-jpeg-icc.mjs /path/to/file.jpg
 */
import { readFileSync } from 'fs';
import ExifReader from 'exifreader';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/test-jpeg-icc.mjs <jpeg-file>');
  process.exit(1);
}

const fileBuffer = readFileSync(filePath);
console.log(`File: ${filePath}`);
console.log(`Size: ${fileBuffer.length} bytes\n`);

// Parse with ExifReader expanded mode
const tags = ExifReader.load(fileBuffer, { expanded: true });

console.log('─── ExifReader top-level keys ───');
console.log(Object.keys(tags));

if (tags.icc) {
  console.log('\n─── ICC from ExifReader ───');
  console.log('ICC keys:', Object.keys(tags.icc));
  if (tags.icc['ICC Description']) {
    console.log('ICC Description:', tags.icc['ICC Description']);
  }
  if (tags.icc['Device Model Description']) {
    console.log('Device Model Description:', tags.icc['Device Model Description']);
  }
  // Print all ICC fields
  for (const [k, v] of Object.entries(tags.icc)) {
    console.log(`  ${k}:`, typeof v === 'object' ? JSON.stringify(v).slice(0, 100) : v);
  }
} else {
  console.log('\n❌ No tags.icc found by ExifReader');
}

// Check ColorSpace EXIF tag
if (tags.exif?.ColorSpace) {
  console.log('\n─── EXIF ColorSpace ───');
  console.log('ColorSpace:', tags.exif.ColorSpace);
}

// Check if there's InterColorProfile or similar
if (tags.exif?.InterColorProfile) {
  console.log('\nFound InterColorProfile in EXIF!');
}

// Try with different ExifReader options
console.log('\n─── Trying ExifReader with includeUnknown ───');
const tags2 = ExifReader.load(fileBuffer, { expanded: true, includeUnknown: true });
if (tags2.icc) {
  console.log('ICC found with includeUnknown');
  console.log('ICC keys:', Object.keys(tags2.icc));
}
