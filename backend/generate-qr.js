/**
 * BulkWA — WhatsApp QR Generator
 * Runs on GitHub Actions via Puppeteer
 * Generates QR code and saves session for persistence
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser';
const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');
const QR_OUTPUT = path.join(__dirname, 'qr.png');
const LOG_FILE = path.join(__dirname, 'qr.log');

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

async function main() {
  log('Starting WhatsApp QR generation...');

  const client = new Client({
    authStrategy: new LocalAuth({
      dataPath: SESSION_DIR
    }),
    puppeteer: {
      executablePath: EXECUTABLE_PATH,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-software-rasterizer'
      ]
    }
  });

  let qrGenerated = false;
  let authenticated = false;

  client.on('qr', async (qr) => {
    log('QR code received, saving as PNG...');
    try {
      await QRCode.toFile(QR_OUTPUT, qr, {
        color: { dark: '#000000', light: '#ffffff' },
        width: 256,
        margin: 2
      });
      log(`QR saved to ${QR_OUTPUT}`);
      qrGenerated = true;

      // Also output to terminal for debugging
      const qrTerminal = require('qrcode-terminal');
      qrTerminal.generate(qr, { small: true });
    } catch (err) {
      log('Error saving QR: ' + err.message);
    }
  });

  client.on('authenticated', () => {
    log('WhatsApp authenticated successfully!');
    authenticated = true;
  });

  client.on('auth_failure', (msg) => {
    log('Authentication failed: ' + msg);
    process.exit(1);
  });

  client.on('ready', () => {
    log('WhatsApp client is ready!');
    const info = client.info;
    if (info) {
      log(`Connected as: ${info.pushname} (${info.wid.user})`);
      fs.writeFileSync(path.join(__dirname, 'wa-info.json'), JSON.stringify({
        phone: info.wid.user,
        name: info.pushname,
        connectedAt: new Date().toISOString()
      }, null, 2));
    }
    // Keep alive for 2 mins to allow session save, then exit
    setTimeout(() => {
      log('Session saved. Exiting.');
      process.exit(0);
    }, 120000);
  });

  client.on('disconnected', (reason) => {
    log('Client disconnected: ' + reason);
    process.exit(1);
  });

  log('Initializing client...');
  await client.initialize();

  // Wait up to 3 minutes for QR scan
  let waited = 0;
  while (!authenticated && waited < 180) {
    await sleep(1000);
    waited++;
    if (waited % 30 === 0) log(`Waiting for scan... ${waited}s elapsed`);
  }

  if (!authenticated) {
    log('Timeout waiting for QR scan. QR image was saved as artifact.');
    // Don't exit with error — QR was generated, user just hasn't scanned yet
    process.exit(0);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
