/**
 * Service Worker - Orchestration Layer
 * Maneja: Storage, Tab Management, Network Interception, Command Handling
 */

const STORAGE_KEY = 'wic_sessions';
let activeRecordings = new Map();
let networkLog = [];

// ========== EVENT LISTENERS ==========

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[ServiceWorker] Message received:', request.action);

  switch (request.action) {
    case 'START_RECORDING':
      startRecording(sender.tab.id);
      sendResponse({ status: 'recording' });
      break;

    case 'STOP_RECORDING':
      const sessionData = stopRecording(sender.tab.id);
      sendResponse({ status: 'stopped', data: sessionData });
      break;

    case 'GET_SESSION_DATA':
      sendResponse(getSessionData(sender.tab.id));
      break;

    case 'EXPORT_AUDIT':
      handleExportAudit(request.format, sender.tab.id).then(data => {
        sendResponse({ success: true, data });
      });
      return true; // Indicar que respuesta es asíncrona

    case 'CAPTURE_NETWORK':
      handleNetworkCapture(request.event);
      sendResponse({ status: 'captured' });
      break;

    case 'UPDATE_SETTINGS':
      updateSettings(request.settings);
      sendResponse({ status: 'updated' });
      break;

    default:
      sendResponse({ error: 'Unknown action' });
  }
});

// ========== RECORDING MANAGEMENT ==========

function startRecording(tabId) {
  const session = {
    tabId,
    startTime: Date.now(),
    url: null,
    interactions: [],
    technologies: {},
    networkEvents: [],
    mutations: [],
    errors: []
  };

  activeRecordings.set(tabId, session);

  // Inyectar content script para empezar a grabar
  chrome.tabs.get(tabId, tab => {
    if (tab.url) session.url = tab.url;
  });

  chrome.storage.local.get([STORAGE_KEY], result => {
    const sessions = result[STORAGE_KEY] || [];
    sessions.push(session);
    chrome.storage.local.set({ [STORAGE_KEY]: sessions });
  });

  console.log(`[Recording] Started on tab ${tabId}`);
}

function stopRecording(tabId) {
  const session = activeRecordings.get(tabId);
  if (!session) return null;

  session.endTime = Date.now();
  session.duration = session.endTime - session.startTime;

  activeRecordings.delete(tabId);

  // Guardar en storage
  chrome.storage.local.get([STORAGE_KEY], result => {
    const sessions = result[STORAGE_KEY] || [];
    const index = sessions.findIndex(s => s.tabId === tabId && !s.endTime);
    if (index !== -1) {
      sessions[index] = session;
      chrome.storage.local.set({ [STORAGE_KEY]: sessions });
    }
  });

  console.log(`[Recording] Stopped on tab ${tabId}. Duration: ${session.duration}ms`);
  return session;
}

function getSessionData(tabId) {
  return activeRecordings.get(tabId) || null;
}

// ========== EXPORT HANDLING ==========

async function handleExportAudit(format, tabId) {
  const session = getSessionData(tabId);
  if (!session) {
    throw new Error('No active session');
  }

  switch (format) {
    case 'markdown':
      return generateMarkdownAudit(session);
    case 'json':
      return JSON.stringify(session, null, 2);
    case 'yaml':
      return convertToYAML(session);
    case 'csv':
      return convertToCSV(session);
    default:
      return null;
  }
}

function generateMarkdownAudit(session) {
  const markdown = `# Web Interaction Capture Audit

## Session Info
- **URL**: ${session.url}
- **Start Time**: ${new Date(session.startTime).toISOString()}
- **Duration**: ${session.duration}ms
- **Total Interactions**: ${session.interactions.length}

## Technologies Detected
${Object.entries(session.technologies)
  .filter(([, detected]) => detected)
  .map(([tech]) => `- ${tech}`)
  .join('\n')}

## Interactions Captured (${session.interactions.length})

${session.interactions
  .map(
    (int, idx) => `
### Interaction #${idx + 1}
- **Type**: ${int.type}
- **Target**: ${int.target}
- **Timestamp**: ${new Date(int.timestamp).toISOString()}
- **Selector (CSS)**: \`${int.selectors.css}\`
- **Selector (XPath)**: \`${int.selectors.xpath}\`
- **Selector Stability**: ${int.selectors.unique[0]} (${int.selectors.stability}%)
- **Aria Label**: ${int.selectors.aria || 'N/A'}
- **Data TestID**: ${int.selectors.dataTestId || 'N/A'}
- **Value**: ${int.value || 'N/A'}
- **Text**: ${int.text || 'N/A'}
- **React Detected**: ${int.reactProps.detected ? `Yes (${int.reactProps.fiber.type})` : 'No'}
- **Shadow DOM Path**: ${int.shadowPath ? int.shadowPath.join(' > ') : 'N/A'}
`
  )
  .join('\n')}

## Network Requests (${session.networkEvents.length})

${session.networkEvents
  .map(
    (evt, idx) => `
### Request #${idx + 1}
- **Method**: ${evt.method}
- **URL**: ${evt.url}
- **Status**: ${evt.status}
- **Response Time**: ${evt.responseTime}ms
`
  )
  .join('\n')}

## DOM Mutations (${session.mutations.length})
${session.mutations
  .map(
    mut => `- ${mut.type} on ${mut.target} at ${new Date(mut.timestamp).toISOString()}`
  )
  .join('\n')}

## Automation Recommendations

### Quick Playwright Code
\`\`\`javascript
${generatePlaywrightCode(session)}
\`\`\`

### Quick Puppeteer Code
\`\`\`javascript
${generatePuppeteerCode(session)}
\`\`\`

### Quick Chrome Extension Code
\`\`\`javascript
${generateChromeExtensionCode(session)}
\`\`\`

## Statistics
- **Most Clicked Element**: ${getMostClickedElement(session)}
- **Most Changed Input**: ${getMostChangedInput(session)}
- **Average Selector Stability**: ${getAverageSelectorStability(session)}%

---
Generated by Web Interaction Capture v1.0
`;

  return markdown;
}

function convertToYAML(session) {
  // Implementar conversión a YAML
  return JSON.stringify(session);
}

function convertToCSV(session) {
  const headers = ['Type', 'Target', 'Selector', 'Value', 'Timestamp'];
  const rows = session.interactions.map(int => [
    int.type,
    int.target,
    int.selectors.css,
    int.value || '',
    new Date(int.timestamp).toISOString()
  ]);

  const csv = [headers, ...rows]
    .map(row => row.map(cell => `"${cell}"`).join(','))
    .join('\n');

  return csv;
}

// ========== CODE GENERATION ==========

function generatePlaywrightCode(session) {
  const firstInteraction = session.interactions[0];
  return `const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('${session.url}');
  
  // Generated from capture
  await page.click('${firstInteraction.selectors.css}');
  // ... more actions
  
  await browser.close();
})();`;
}

function generatePuppeteerCode(session) {
  const firstInteraction = session.interactions[0];
  return `const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto('${session.url}');
  
  // Generated from capture
  await page.click('${firstInteraction.selectors.css}');
  // ... more actions
  
  await browser.close();
})();`;
}

function generateChromeExtensionCode(session) {
  const firstInteraction = session.interactions[0];
  return `chrome.tabs.query({active: true}, (tabs) => {
  chrome.tabs.sendMessage(tabs[0].id, {
    action: 'EXECUTE_ACTION',
    selector: '${firstInteraction.selectors.css}',
    action_type: '${firstInteraction.type}'
  });
});`;
}

// ========== HELPER FUNCTIONS ==========

function getMostClickedElement(session) {
  const clickedElements = session.interactions
    .filter(int => int.type === 'click')
    .map(int => int.selectors.css);

  if (clickedElements.length === 0) return 'N/A';

  const counts = {};
  clickedElements.forEach(el => {
    counts[el] = (counts[el] || 0) + 1;
  });

  return Object.entries(counts).sort(([, a], [, b]) => b - a)[0][0];
}

function getMostChangedInput(session) {
  const inputs = session.interactions
    .filter(int => int.type === 'input')
    .map(int => int.selectors.css);

  if (inputs.length === 0) return 'N/A';

  const counts = {};
  inputs.forEach(el => {
    counts[el] = (counts[el] || 0) + 1;
  });

  return Object.entries(counts).sort(([, a], [, b]) => b - a)[0][0];
}

function getAverageSelectorStability(session) {
  const stabilities = session.interactions.map(
    int => int.selectors.stability
  );
  const avg = stabilities.reduce((a, b) => a + b, 0) / stabilities.length;
  return Math.round(avg);
}

function updateSettings(settings) {
  chrome.storage.sync.set({ wic_settings: settings });
}

// ========== NETWORK INTERCEPTION ==========

function handleNetworkCapture(event) {
  networkLog.push({
    ...event,
    timestamp: Date.now()
  });

  // Limitar log a últimas 1000 requests
  if (networkLog.length > 1000) {
    networkLog.shift();
  }
}

// ========== KEYBOARD SHORTCUTS ==========

chrome.commands.onCommand.addListener(command => {
  console.log('Command received:', command);

  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tabId = tabs[0].id;

    if (command === 'toggle-recording') {
      const session = activeRecordings.get(tabId);
      if (session) {
        stopRecording(tabId);
      } else {
        startRecording(tabId);
      }
    }

    if (command === 'export-audit') {
      chrome.tabs.sendMessage(tabId, { action: 'OPEN_EXPORT_DIALOG' });
    }

    if (command === 'open-sidepanel') {
      chrome.sidePanel.open({ tabId });
    }
  });
});

// ========== INITIALIZATION ==========

chrome.runtime.onInstalled.addListener(() => {
  console.log('[ServiceWorker] Extension installed');
  chrome.storage.sync.set({
    wic_settings: {
      captureNetwork: true,
      captureShadowDOM: true,
      captureReact: true,
      capturePerformance: true
    }
  });
});

console.log('[ServiceWorker] Initialized');
