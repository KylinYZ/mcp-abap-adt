import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const sourceRoot = path.resolve('src');
const violations = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

for (const file of await walk(sourceRoot)) {
  const content = await readFile(file, 'utf8');
  const relativePath = path.relative(process.cwd(), file).replaceAll('\\', '/');

  if (/['"]abap-adt-api['"]/.test(content)) {
    violations.push(`${relativePath}: imports the removed abap-adt-api package`);
  }

  // Code outside the embedded client must depend on its reviewed public entry point.
  if (!relativePath.startsWith('src/adt/') && /(?:from\s*|import\s*\(|require\s*\()['"][^'"]*\/adt\/(?!index\.js['"])[^'"]+['"]/.test(content)) {
    violations.push(`${relativePath}: imports an embedded ADT implementation module directly`);
  }
}

if (violations.length > 0) {
  console.error('ADT import audit failed:');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log('ADT import audit passed.');
}
