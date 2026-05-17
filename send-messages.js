/**
 * BulkWA — Bulk WhatsApp Message Sender
 * Runs on GitHub Actions
 * Reads from Google Sheets, sends with configurable delay and batch
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Config from environment (passed by GitHub Actions)
const CONFIG = {
  sheetId: process.env.SHEET_ID,
  phoneCol: parseInt(process.env.PHONE_COL || '0'),
  msgCol: parseInt(process.env.MSG_COL || '1'),
  batchSize: parseInt(process.env.BATCH_SIZE || '30'),
  delayMin: parseInt(process.env.DELAY_MIN || '30') * 1000,  // ms
  delayMax: parseInt(process.env.DELAY_MAX || '60') * 1000,  // ms
  addTimestamp: process.env.ADD_TIMESTAMP !== 'false',
  startRow: parseInt(process.env.START_ROW || '1'),
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser'
};

const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');
const LOG_FILE = path.join(__dirname, 'delivery.log');
const STATUS_FILE = path.join(__dirname, 'send-status.json');

let deliveryLog = [];

function log(msg, level = 'INFO') {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
  deliveryLog.push({ ts, level, msg });
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatTimestamp() {
  const now = new Date();
  return `\n\n_Sent: ${now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}_`;
}

function formatPhone(raw) {
  // Remove all non-digits
  let num = String(raw).replace(/\D/g, '');
  // Add country code if not present (default: India +91)
  if (num.length === 10) num = '91' + num;
  return num + '@c.us';
}

async function fetchSheetData() {
  log(`Fetching data from Google Sheet: ${CONFIG.sheetId}`);
  const url = `https://docs.google.com/spreadsheets/d/${CONFIG.sheetId}/gviz/tq?tqx=out:json`;
  try {
    const resp = await axios.get(url, { timeout: 30000 });
    const raw = resp.data.substring(47).slice(0, -2);
    const json = JSON.parse(raw);
    const rows = json.table.rows;
    log(`Fetched ${rows.length} rows from sheet`);
    return rows.map(row => ({
      phone: row.c[CONFIG.phoneCol]?.v || row.c[CONFIG.phoneCol]?.f || '',
      message: row.c[CONFIG.msgCol]?.v || row.c[CONFIG.msgCol]?.f || ''
    })).filter(r => r.phone && r.message);
  } catch (err) {
    log('Error fetching sheet: ' + err.message, 'ERROR');
    throw err;
  }
}

async function main() {
  log('=== BulkWA Message Sender Starting ===');
  log(`Config: batch=${CONFIG.batchSize}, delay=${CONFIG.delayMin/1000}-${CONFIG.delayMax/1000}s, timestamp=${CONFIG.addTimestamp}`);

  if (!CONFIG.sheetId) {
    log('ERROR: No SHEET_ID provided', 'ERROR');
    process.exit(1);
  }

  // Initialize WhatsApp client
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: {
      executablePath: CONFIG.executablePath,
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas',
        '--no-first-run', '--no-zygote', '--disable-gpu',
        '--disable-software-rasterizer'
      ]
    }
  });

  let clientReady = false;

  client.on('authenticated', () => log('WhatsApp authenticated'));
  client.on('auth_failure', msg => { log('Auth failure: ' + msg, 'ERROR'); process.exit(1); });
  client.on('qr', () => { log('QR received — no active session. Please run QR generator first.', 'ERROR'); process.exit(1); });
  client.on('ready', () => { log('WhatsApp client ready!'); clientReady = true; });
  client.on('disconnected', reason => log('Disconnected: ' + reason, 'WARN'));

  log('Initializing WhatsApp...');
  await client.initialize();

  // Wait for ready
  let waited = 0;
  while (!clientReady && waited < 60) {
    await sleep(1000);
    waited++;
  }

  if (!clientReady) {
    log('Client did not become ready in time', 'ERROR');
    process.exit(1);
  }

  // Fetch contacts and messages from Google Sheets
  const rows = await fetchSheetData();
  const batch = rows.slice(CONFIG.startRow - 1, CONFIG.startRow - 1 + CONFIG.batchSize);

  log(`Processing ${batch.length} messages (batch of ${CONFIG.batchSize} starting at row ${CONFIG.startRow})`);

  const status = {
    total: batch.length, sent: 0, failed: 0,
    startTime: new Date().toISOString(), rows: []
  };

  for (let i = 0; i < batch.length; i++) {
    const { phone, message } = batch[i];
    const formatted = formatPhone(phone);
    let finalMsg = message;
    if (CONFIG.addTimestamp) finalMsg += formatTimestamp();

    try {
      // Check if number exists on WhatsApp
      const isRegistered = await client.isRegisteredUser(formatted);
      if (!isRegistered) {
        log(`[${i+1}/${batch.length}] SKIP — ${phone} not on WhatsApp`, 'WARN');
        status.failed++;
        status.rows.push({ phone, status: 'not_registered' });
        continue;
      }

      await client.sendMessage(formatted, finalMsg);
      status.sent++;
      status.rows.push({ phone, status: 'sent', ts: new Date().toISOString() });
      log(`[${i+1}/${batch.length}] SENT → ${phone}`, 'OK');

    } catch (err) {
      status.failed++;
      status.rows.push({ phone, status: 'error', error: err.message });
      log(`[${i+1}/${batch.length}] FAILED → ${phone}: ${err.message}`, 'ERROR');
    }

    // Random delay between messages (except last)
    if (i < batch.length - 1) {
      const delay = randomDelay(CONFIG.delayMin, CONFIG.delayMax);
      log(`Waiting ${Math.round(delay/1000)}s before next message...`);
      await sleep(delay);
    }
  }

  status.endTime = new Date().toISOString();
  log(`=== Done! Sent: ${status.sent}, Failed: ${status.failed} ===`);
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));

  await client.destroy();
  log('Client destroyed. Exiting.');
  process.exit(0);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  log('Fatal error: ' + err.message, 'ERROR');
  console.error(err);
  process.exit(1);
});
