/**
 * BulkWA — WhatsApp QR Generator
 * Saves qr.b64 file — the workflow will git-push it so the dashboard can fetch it
 */ 

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser';
const SESSION_DIR   = path.join(__dirname, '.wwebjs_auth');
const QR_OUTPUT     = path.join(__dirname, 'qr.png');
const QR_B64_FILE   = path.join(__dirname, '..', 'qr.b64');  // repo root so git can commit it
const QR_READY_FLAG = path.join(__dirname, 'qr.ready');
const LOG_FILE      = path.join(__dirname, 'qr.log');

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

async function main() {
  log('Starting WhatsApp QR generation...');
  if (fs.existsSync(QR_READY_FLAG)) fs.unlinkSync(QR_READY_FLAG);

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: {
      executablePath: EXECUTABLE_PATH,
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas',
        '--no-first-run', '--no-zygote', '--disable-gpu',
        '--disable-software-rasterizer'
      ]
    }
  });

  let authenticated = false;

  client.on('qr', async (qr) => {
    log('QR token received from WhatsApp!');
    try {
      // Save as PNG
      await QRCode.toFile(QR_OUTPUT, qr, {
        color: { dark: '#000000', light: '#ffffff' },
        width: 300, margin: 2
      });
      log('qr.png saved');

      // Save as base64 data URL — this gets git-pushed so dashboard can fetch it
      const b64 = await QRCode.toDataURL(qr, {
        color: { dark: '#000000', light: '#ffffff' },
        width: 300, margin: 2
      });

      // Write to repo root as qr.b64
      fs.writeFileSync(QR_B64_FILE, b64, 'utf8');
      log('qr.b64 written to repo root');

      // Write ready flag — shell wrapper detects this and does git push
      fs.writeFileSync(QR_READY_FLAG, new Date().toISOString());
      log('qr.ready flag written — shell will now git-push');

      // Print to terminal
      try { require('qrcode-terminal').generate(qr, { small: true }); } catch(e) {}

    } catch (err) {
      log('QR save error: ' + err.message);
    }
  });

  client.on('authenticated', () => {
    log('Authenticated!');
    authenticated = true;
    // Clear qr.b64 after successful scan
    try { fs.writeFileSync(QR_B64_FILE, 'scanned', 'utf8'); } catch(e) {}
  });

  client.on('auth_failure', msg => { log('Auth failure: ' + msg); process.exit(1); });

  client.on('ready', () => {
    log('Client ready!');
    const info = client.info;
    if (info) {
      log(`Connected: ${info.pushname} (${info.wid.user})`);
      fs.writeFileSync(path.join(__dirname, 'wa-info.json'), JSON.stringify({
        phone: info.wid.user, name: info.pushname,
        connectedAt: new Date().toISOString()
      }, null, 2));
    }
    setTimeout(() => { log('Exiting after session save.'); process.exit(0); }, 30000);
  });

  client.on('disconnected', r => log('Disconnected: ' + r));

  log('Initializing Puppeteer...');
  await client.initialize();

  let waited = 0;
  while (!authenticated && waited < 180) {
    await sleep(1000);
    waited++;
    if (waited % 15 === 0) log(`Waiting for scan... ${waited}s`);
  }

  if (!authenticated) { log('Scan timeout — qr.b64 was pushed, user did not scan in time.'); process.exit(0); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
main().catch(err => { log('Fatal: ' + err.message); console.error(err); process.exit(1); });
