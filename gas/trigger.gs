/**
 * BulkWA — Google Apps Script Trigger
 * Deploy this as a Web App in Google Apps Script
 * Set a time-based trigger to run checkAndTrigger() every 5-10 minutes
 *
 * HOW TO DEPLOY:
 * 1. Go to https://script.google.com → New Project
 * 2. Paste this entire file
 * 3. Click Deploy → New Deployment → Web App
 * 4. Execute as: Me | Access: Anyone
 * 5. Copy the Web App URL into BulkWA settings
 * 6. Add trigger: Triggers → + Add Trigger → checkAndTrigger → Time-driven → Every 5 minutes
 */

// ========== CONFIGURATION ==========
// Fill these in before deploying!
const GITHUB_TOKEN = 'YOUR_GITHUB_PAT_HERE';        // GitHub Personal Access Token
const GITHUB_REPO  = 'YOUR_USERNAME/YOUR_REPO';      // e.g. 'john/bulkwa-runner'
const BULKWA_API_URL = '';                            // Optional: your BulkWA backend API URL

// ========== SCHEDULED TRIGGER CHECK ==========

/**
 * Main function — called every 5-10 minutes by time trigger.
 * Checks for pending scheduled campaigns and fires GitHub Actions.
 */
function checkAndTrigger() {
  const props = PropertiesService.getScriptProperties();
  const schedulesJson = props.getProperty('bwa_schedules') || '[]';
  let schedules = JSON.parse(schedulesJson);

  const now = new Date();
  let updated = false;

  schedules.forEach(sched => {
    if (sched.status !== 'pending') return;
    if (!sched.scheduledAt) return;

    const scheduledAt = new Date(sched.scheduledAt);
    if (now >= scheduledAt) {
      Logger.log('Triggering schedule: ' + sched.name);
      const success = triggerGitHubAction(sched);
      if (success) {
        sched.status = 'running';
        sched.triggeredAt = now.toISOString();
        updated = true;
        Logger.log('✓ Triggered: ' + sched.name);
      } else {
        Logger.log('✗ Failed to trigger: ' + sched.name);
      }
    }
  });

  if (updated) {
    props.setProperty('bwa_schedules', JSON.stringify(schedules));
  }

  return schedules;
}

/**
 * Trigger GitHub Actions workflow dispatch
 */
function triggerGitHubAction(sched) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/send-messages.yml/dispatches`;

  const payload = {
    ref: 'main',
    inputs: {
      sheetId: sched.sheetId || '',
      phoneCol: String(sched.phoneCol || '0'),
      msgCol: String(sched.msgCol || '1'),
      batch: String(sched.batch || '30'),
      delayMin: String(sched.delayMin || '30'),
      delayMax: String(sched.delayMax || '60'),
      timestamp: String(sched.timestamp || 'true'),
      startRow: String(sched.startRow || '1')
    }
  };

  const options = {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + GITHUB_TOKEN,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    Logger.log('GitHub API response: ' + code);
    return code === 204;
  } catch (e) {
    Logger.log('Error triggering GitHub: ' + e.message);
    return false;
  }
}

// ========== WEB APP ENDPOINTS ==========

/**
 * HTTP GET — Returns current schedules (used by BulkWA frontend to sync)
 */
function doGet(e) {
  const props = PropertiesService.getScriptProperties();
  const schedules = JSON.parse(props.getProperty('bwa_schedules') || '[]');
  return ContentService.createTextOutput(JSON.stringify({
    ok: true,
    schedules: schedules,
    serverTime: new Date().toISOString()
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * HTTP POST — Accepts schedule data from BulkWA frontend
 * Used to create/update/delete schedules stored in Script Properties
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const props = PropertiesService.getScriptProperties();

    if (data.action === 'upsert') {
      let schedules = JSON.parse(props.getProperty('bwa_schedules') || '[]');
      const idx = schedules.findIndex(s => s.id === data.schedule.id);
      if (idx >= 0) schedules[idx] = data.schedule;
      else schedules.push(data.schedule);
      props.setProperty('bwa_schedules', JSON.stringify(schedules));
      return jsonResponse({ ok: true, action: 'upsert', id: data.schedule.id });
    }

    if (data.action === 'delete') {
      let schedules = JSON.parse(props.getProperty('bwa_schedules') || '[]');
      schedules = schedules.filter(s => s.id !== data.id);
      props.setProperty('bwa_schedules', JSON.stringify(schedules));
      return jsonResponse({ ok: true, action: 'delete' });
    }

    if (data.action === 'trigger_now') {
      const success = triggerGitHubAction(data.schedule);
      return jsonResponse({ ok: success });
    }

    return jsonResponse({ ok: false, error: 'Unknown action' });

  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ========== UTILITY: Sync schedules from localStorage-style JSON ==========

/**
 * Call this manually to import schedules from the BulkWA web app.
 * Paste your exported schedules JSON as argument.
 */
function importSchedules(jsonStr) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('bwa_schedules', jsonStr);
  Logger.log('Imported ' + JSON.parse(jsonStr).length + ' schedules');
}

/**
 * Test function — run this to verify GitHub token works
 */
function testGitHubConnection() {
  const url = `https://api.github.com/repos/${GITHUB_REPO}`;
  const options = {
    headers: {
      'Authorization': 'Bearer ' + GITHUB_TOKEN,
      'Accept': 'application/vnd.github+json'
    },
    muteHttpExceptions: true
  };
  const resp = UrlFetchApp.fetch(url, options);
  Logger.log('Status: ' + resp.getResponseCode());
  Logger.log('Repo: ' + JSON.parse(resp.getContentText()).full_name);
}
