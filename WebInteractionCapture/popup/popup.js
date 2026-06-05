/**
 * Popup Script - UI Logic
 */

let isRecording = false;
let sessionData = null;
let updateInterval = null;

const recordBtn = document.getElementById('recordBtn');
const stopBtn = document.getElementById('stopBtn');
const exportBtn = document.getElementById('exportBtn');
const statusText = document.getElementById('statusText');
const statusIndicator = document.getElementById('statusIndicator');
const stats = document.getElementById('stats');
const exportMenu = document.getElementById('exportMenu');
const technologies = document.getElementById('technologies');

// Event Listeners
recordBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);
exportBtn.addEventListener('click', toggleExportMenu);

document
  .getElementById('exportMarkdown')
  ?.addEventListener('click', () => exportAudit('markdown'));
document
  .getElementById('exportJSON')
  ?.addEventListener('click', () => exportAudit('json'));
document
  .getElementById('exportCSV')
  ?.addEventListener('click', () => exportAudit('csv'));
document
  .getElementById('exportYAML')
  ?.addEventListener('click', () => exportAudit('yaml'));

// Functions
function startRecording() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    chrome.tabs.sendMessage(
      tabs[0].id,
      { action: 'START_RECORDING' },
      response => {
        if (response.status === 'recording') {
          isRecording = true;
          updateUI();
          startStatsUpdate();
          sessionData = null;
        }
      }
    );
  });
}

function stopRecording() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    chrome.tabs.sendMessage(
      tabs[0].id,
      { action: 'STOP_RECORDING' },
      response => {
        if (response.status === 'stopped') {
          isRecording = false;
          sessionData = response.data;
          updateUI();
          stopStatsUpdate();
          displayTechnologies();
        }
      }
    );
  });
}

function toggleExportMenu() {
  exportMenu.classList.toggle('active');
}

function exportAudit(format) {
  if (!sessionData) {
    alert('No session data to export');
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    chrome.tabs.sendMessage(tabs[0].id, {
      action: 'EXPORT_AUDIT',
      format,
      data: sessionData
    });
  });

  exportMenu.classList.remove('active');
}

function updateUI() {
  if (isRecording) {
    recordBtn.style.display = 'none';
    stopBtn.style.display = 'block';
    statusText.textContent = '🔴 Recording...';
    statusIndicator.classList.add('recording');
    stats.style.display = 'block';
  } else {
    recordBtn.style.display = 'block';
    stopBtn.style.display = 'none';
    statusText.textContent = 'Ready to record';
    statusIndicator.classList.remove('recording');
  }
}

function startStatsUpdate() {
  updateInterval = setInterval(updateStats, 500);
}

function stopStatsUpdate() {
  if (updateInterval) {
    clearInterval(updateInterval);
  }
}

function updateStats() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    chrome.tabs.sendMessage(
      tabs[0].id,
      { action: 'GET_SESSION_DATA' },
      response => {
        if (response) {
          const data = response;
          document.getElementById('interactionCount').textContent =
            data.interactions?.length || 0;
          document.getElementById('mutationCount').textContent =
            data.mutations?.length || 0;
          document.getElementById('networkCount').textContent =
            data.networkEvents?.length || 0;

          const duration = (Date.now() - data.startTime) / 1000;
          document.getElementById('duration').textContent = `${duration.toFixed(1)}s`;
        }
      }
    );
  });
}

function displayTechnologies() {
  if (!sessionData || !sessionData.technologies) return;

  const techList = document.getElementById('techList');
  const techs = sessionData.technologies;

  let html = '';
  Object.entries(techs).forEach(([tech, detected]) => {
    if (detected) {
      html += `<span class="tech-badge detected">${tech}</span>`;
    } else {
      html += `<span class="tech-badge">${tech}</span>`;
    }
  });

  techList.innerHTML = html;
  technologies.style.display = 'block';
}

// Initialize
updateUI();

console.log('[Popup] Ready');
