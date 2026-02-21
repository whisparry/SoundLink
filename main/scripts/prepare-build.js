const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..', '..');
const distDir = path.join(rootDir, 'dist');

function tryStopRunningApp() {
  if (process.platform !== 'win32') {
    return;
  }

  try {
    execSync('taskkill /IM SoundLink.exe /F /T', { stdio: 'ignore' });
  } catch {
    // No running process found (or taskkill unavailable), continue cleanup.
  }
}

function cleanDist() {
  if (!fs.existsSync(distDir)) {
    return;
  }

  try {
    fs.rmSync(distDir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error('Build precheck failed: could not clean dist directory.');
    console.error(`Path: ${distDir}`);
    console.error(`Reason: ${message}`);
    console.error('Close SoundLink, Explorer preview tabs, and antivirus scans on dist, then retry.');
    process.exit(1);
  }
}

tryStopRunningApp();
cleanDist();
