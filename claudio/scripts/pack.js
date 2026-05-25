// scripts/pack.js — Create a clean distribution zip
// Excludes node_modules, cache, db, secrets, and design drafts
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname, relative, basename } from 'path';
import { fileURLToPath } from 'url';
import { cpSync, rmSync, existsSync, readdirSync, statSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'claudio-dist');
const zipName = 'claudio.zip';
const zipPath = join(rootDir, zipName);

// Patterns to exclude (relative to root)
const excludePatterns = [
  /^node_modules\//,
  /^cache\//,
  /^state\.db/,           // state.db, state.db-shm, state.db-wal
  /^\.env$/,
  /^credentials\.json$/,
  /^token\.json$/,
  /^\.idea\//,
  /^\.git\//,
  /^qr\.png$/,
  /^claudio\.zip$/,
  /^claudio-dist\//,
  /^CLAUDE\.md$/,         // build plan, internal use
  /^claudio流程图\.jpg$/,   // design draft
  /^claudio-design\.md$/,
  /^claudio-example\.html$/,
  /^claudio-ui-spec\.md$/,
  /^pnpm-lock\.yaml$/,    // friend will generate their own lock file
  /^settings\.local\.json$/,  // local Claude Code settings
  /^pnpm-workspace\.yaml$/, // workspace config, not needed
];

function shouldExclude(relPath) {
  return excludePatterns.some(re => re.test(relPath.replace(/\\/g, '/')));
}

// Clean up previous
if (existsSync(distDir)) rmSync(distDir, { recursive: true });
if (existsSync(zipPath)) rmSync(zipPath);

// Collect all files to include
function collectFiles(dir, base) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const fullPath = join(dir, e.name);
    const relPath = relative(base, fullPath).replace(/\\/g, '/');

    if (shouldExclude(relPath)) continue;

    if (e.isDirectory()) {
      files.push(...collectFiles(fullPath, base));
    } else {
      files.push({ fullPath, relPath });
    }
  }
  return files;
}

console.log('Collecting files...');
const files = collectFiles(rootDir, rootDir);

if (files.length === 0) {
  console.error('No files found!');
  process.exit(1);
}

// Copy to dist directory
console.log(`Copying ${files.length} files to ${distDir}...`);
for (const { fullPath, relPath } of files) {
  const dest = join(distDir, relPath);
  cpSync(fullPath, dest, { recursive: true });
}

// Create empty cache/tts directory (needed by the app)
const cacheTtsDir = join(distDir, 'cache', 'tts');
cpSync(join(rootDir, 'cache', 'tts', '.gitkeep'), join(cacheTtsDir, '.gitkeep'));

// Zip using PowerShell (available on Windows by default)
console.log('Creating zip...');
try {
  execSync(
    `powershell -Command "Compress-Archive -Path '${distDir}\\*' -DestinationPath '${zipPath}' -Force"`,
    { stdio: 'pipe', cwd: rootDir }
  );
} catch {
  // Fallback: try tar if available (Windows 11 has it built-in)
  execSync(`tar -a -cf "${zipName}" -C "${distDir}" .`, { stdio: 'pipe', cwd: rootDir });
}

// Clean up
rmSync(distDir, { recursive: true });

// Report
const zipSize = statSync(zipPath).size;
const sizeStr = zipSize < 1024 * 1024
  ? `${(zipSize / 1024).toFixed(0)} KB`
  : `${(zipSize / (1024 * 1024)).toFixed(1)} MB`;

console.log('');
console.log(`✅  ${zipName} ready (${sizeStr}, ${files.length} files)`);
console.log('');
console.log('Send this file to your friend. They should:');
console.log('  1. Extract the zip');
console.log('  2. cd into the folder');
console.log('  3. Run: pnpm install');
console.log('  4. Edit .env with their own API keys');
console.log('  5. Run: pnpm start:all');
