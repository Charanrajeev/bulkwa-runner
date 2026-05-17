/**
 * BulkWA — WhatsApp QR Generator
 * Immediately pushes QR as base64 to a GitHub Gist so dashboard can display it in real-time
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const https = require('https');

const EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser';
const SESSION_DIR     = path.join(__dirname, '.wwebjs_auth');
const QR_OUTPUT       = path.join(__dirname, 'qr.png');
const QR_B64_FILE     = path.join(__dirname, 'qr.b64');
const QR_READY_FLAG   = path.join(__dirname, 'qr.ready');
const LOG_FILE        = path.join(__dirname, 'qr.log');

// These come from GitHub Actions environment
const GH_TOKEN  = process.env.GH_TOKEN  || '';
const GIST_ID   = process.env.GIST_ID   || '';  // optional pre-created gist
const REPO      = process.env.REPO      || '';

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function pushQRToGist(b64DataUrl) {
  if (!GH_TOKEN) { log('No GH_TOKEN — skipping Gist push'); return null; }

  const content = JSON.stringify({
    qr: b64DataUrl,
    ts: new Date().toISOString(),
    repo: REPO
  });

  const payload = JSON.stringify({
    description: 'BulkWA QR Code',
    public: false,
    files: { 'bulkwa-qr.json': { content } }
  });

  try {
    let result;
    if (GIST_ID) {
      // Update existing gist
      result = await httpsRequest({
        hostname: 'api.github.com',
        path: `/gists/${GIST_ID}`,
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${GH_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'BulkWA',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, payload);
    } else {
      // Create new gist
      result = await httpsRequest({
        hostname: 'api.github.com',
        path: '/gists',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GH_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'BulkWA',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, payload);
    }

    if (result.status === 200 || result.status === 201) {
      const gist = JSON.parse(result.body);
      log(`QR pushed to Gist: ${gist.id}`);
      // Save gist ID to file so workflow step can output it
      fs.writeFileSync(path.join(__dirname, 'gist.id'), gist.id);
      return gist.id;
    } else {
      log(`Gist push failed: ${result.status} — ${result.body.slice(0,200)}`);
      return null;
    }
  } catch(e) {
    log('Gist push error: ' + e.message);
    return null;
  }
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
      // Save as PNG file
      await QRCode.toFile(QR_OUTPUT, qr, {
        color: { dark: '#000000', light: '#ffffff' },
        width: 300, margin: 2
      });
      log('qr.png saved');

      // Save as base64 data URL for Gist/inline display
      const b64 = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
      fs.writeFileSync(QR_B64_FILE, b64);
      log('qr.b64 saved');

      // Write ready flag
      fs.writeFileSync(QR_READY_FLAG, new Date().toISOString());

      // Push to GitHub Gist immediately — dashboard polls this
      const gistId = await pushQRToGist(b64);
      if (gistId) {
        log(`Dashboard can now fetch QR from Gist: ${gistId}`);
      }

      // Also print to terminal
      try { require('qrcode-terminal').generate(qr, { small: true }); } catch(e) {}

    } catch (err) {
      log('QR save error: ' + err.message);
    }
  });

  client.on('authenticated', () => { log('Authenticated!'); authenticated = true; });
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
    // Clear the QR from gist now that we're connected
    if (GH_TOKEN && fs.existsSync(path.join(__dirname,'gist.id'))) {
      const gid = fs.readFileSync(path.join(__dirname,'gist.id'),'utf8').trim();
      const p = JSON.stringify({ files: { 'bulkwa-qr.json': { content: JSON.stringify({status:'connected',ts:new Date().toISOString()}) } } });
      httpsRequest({ hostname:'api.github.com', path:`/gists/${gid}`, method:'PATCH',
        headers:{'Authorization':`Bearer ${GH_TOKEN}`,'Accept':'application/vnd.github+json','User-Agent':'BulkWA','Content-Type':'application/json','Content-Length':Buffer.byteLength(p)} }, p)
        .catch(()=>{});
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
  if (!authenticated) { log('Scan timeout.'); process.exit(0); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
main().catch(err => { console.error(err); process.exit(1); });
