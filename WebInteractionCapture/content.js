/**
 * Content Script - Ejecuta en contexto de página
 * Captura interacciones reales del usuario
 */

import { RecorderEngine } from './src/engines/recorder-engine.js';
import {
  ShadowDOMEngine,
  ReactEngine,
  NetworkEngine,
  WaitDetectionEngine,
  FileTransferEngine
} from './src/engines/specialized-engines.js';

let recorder = null;
let isRecording = false;

// ========== INITIALIZATION ==========

console.log('[ContentScript] Loaded');

// Inyectar página hook si es necesario (para acceso a window.React, etc)
injectPageHook();

function injectPageHook() {
  const script = document.createElement('script');
  script.textContent = `
    window.__wic_injected = true;
    window.__wic_react = window.React || null;
    window.__wic_vue = window.Vue || null;
    window.__wic_angular = window.ng || null;
    
    // Exponer window.fetch y XHR para debugging
    window.__wic_fetch = fetch;
    window.__wic_xhr = XMLHttpRequest;
  `;
  document.documentElement.appendChild(script);
}

// ========== MESSAGE LISTENER ==========

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[ContentScript] Message:', request.action);

  switch (request.action) {
    case 'START_RECORDING':
      startRecording();
      sendResponse({ status: 'recording' });
      break;

    case 'STOP_RECORDING':
      const sessionData = stopRecording();
      sendResponse({ status: 'stopped', data: sessionData });
      break;

    case 'GET_SESSION_DATA':
      sendResponse(recorder?.getSessionData());
      break;

    case 'DETECT_TECHNOLOGIES':
      const techs = recorder?.detectTechnologies();
      sendResponse({ technologies: techs });
      break;

    case 'FIND_ELEMENTS':
      const elements = findElements(request.selector, request.strategy);
      sendResponse({ found: elements.length, elements });
      break;

    case 'INSPECT_ELEMENT':
      const inspection = inspectElement(request.selector);
      sendResponse(inspection);
      break;

    case 'WAIT_FOR_ELEMENT':
      WaitDetectionEngine.waitForElement(
        request.selector,
        request.timeout,
        request.strategy
      ).then(element => {
        sendResponse({ found: !!element });
      });
      return true;

    case 'EXECUTE_ACTION':
      executeAction(request.action_type, request.selector);
      sendResponse({ executed: true });
      break;

    case 'OPEN_EXPORT_DIALOG':
      openExportDialog();
      sendResponse({ opened: true });
      break;

    default:
      sendResponse({ error: 'Unknown action' });
  }
});

// ========== RECORDING ==========

function startRecording() {
  if (isRecording) return;

  recorder = new RecorderEngine();
  recorder.start();

  // Inicializar network interception
  NetworkEngine.initialize();

  isRecording = true;
  console.log('[Recording] Started');

  // Mostrar indicador visual
  showRecordingIndicator();
}

function stopRecording() {
  if (!isRecording || !recorder) return null;

  const sessionData = recorder.stop();
  const technologies = recorder.detectTechnologies();
  sessionData.technologies = technologies;

  isRecording = false;
  console.log('[Recording] Stopped');

  // Remover indicador visual
  hideRecordingIndicator();

  return sessionData;
}

// ========== ELEMENT FINDING ==========

function findElements(
  selector: string,
  strategy: 'css' | 'xpath' | 'shadow' | 'react' = 'css'
): Element[] {
  switch (strategy) {
    case 'css':
      return Array.from(document.querySelectorAll(selector));

    case 'xpath':
      const xpathResult = document.evaluate(
        selector,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      const elements = [];
      for (let i = 0; i < xpathResult.snapshotLength; i++) {
        elements.push(xpathResult.snapshotItem(i) as Element);
      }
      return elements;

    case 'shadow':
      return ShadowDOMEngine.findInShadowDOM(selector);

    case 'react':
      const reactElements = [];
      document.querySelectorAll('*').forEach(el => {
        const name = ReactEngine.getComponentName(el);
        if (name.includes(selector)) {
          reactElements.push(el);
        }
      });
      return reactElements;

    default:
      return [];
  }
}

// ========== ELEMENT INSPECTION ==========

function inspectElement(selector: string) {
  const elements = findElements(selector, 'css');
  if (elements.length === 0) return { error: 'Element not found' };

  const element = elements[0];

  return {
    tagName: element.tagName,
    id: element.id,
    className: element.className,
    html: (element as HTMLElement).outerHTML.substring(0, 200),
    shadowDOM: ShadowDOMEngine.inspectShadowDOM(element),
    react: {
      componentName: ReactEngine.getComponentName(element),
      props: ReactEngine.getComponentProps(element),
      state: ReactEngine.getComponentState(element)
    },
    text: (element as HTMLElement).innerText?.substring(0, 100),
    aria: element.getAttribute('aria-label'),
    role: element.getAttribute('role'),
    attributes: Array.from(element.attributes).map(attr => ({
      name: attr.name,
      value: attr.value
    }))
  };
}

// ========== ACTION EXECUTION ==========

function executeAction(actionType: string, selector: string) {
  const element = document.querySelector(selector) as HTMLElement;
  if (!element) {
    console.error(`Element not found: ${selector}`);
    return;
  }

  switch (actionType) {
    case 'click':
      element.click();
      break;

    case 'dblclick':
      const dblEvent = new MouseEvent('dblclick', { bubbles: true });
      element.dispatchEvent(dblEvent);
      break;

    case 'focus':
      (element as HTMLInputElement).focus();
      break;

    case 'blur':
      (element as HTMLInputElement).blur();
      break;

    case 'type':
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        element.focus();
        element.value = '';
        // Esperar a que el frontend procese el focus
        setTimeout(() => {
          element.value = 'test input';
          element.dispatchEvent(new Event('input', { bubbles: true }));
        }, 100);
      }
      break;

    case 'scroll-to':
      element.scrollIntoView({ behavior: 'smooth' });
      break;

    case 'hover':
      const hoverEvent = new MouseEvent('mouseenter', { bubbles: true });
      element.dispatchEvent(hoverEvent);
      break;

    default:
      console.warn(`Unknown action: ${actionType}`);
  }
}

// ========== UI HELPERS ==========

function showRecordingIndicator() {
  const indicator = document.createElement('div');
  indicator.id = 'wic-recording-indicator';
  indicator.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    background: #ff4444;
    color: white;
    padding: 10px 15px;
    border-radius: 5px;
    font-weight: bold;
    z-index: 999999;
    font-size: 12px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    animation: pulse 1s infinite;
  `;
  indicator.textContent = '⚫ RECORDING';

  const style = document.createElement('style');
  style.textContent = `
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
  `;

  document.head.appendChild(style);
  document.body.appendChild(indicator);
}

function hideRecordingIndicator() {
  const indicator = document.getElementById('wic-recording-indicator');
  if (indicator) indicator.remove();
}

// ========== EXPORT DIALOG ==========

function openExportDialog() {
  const sessionData = recorder?.getSessionData();
  if (!sessionData) {
    console.warn('No session data to export');
    return;
  }

  const dialog = document.createElement('div');
  dialog.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: white;
    padding: 20px;
    border-radius: 10px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    z-index: 1000000;
    width: 300px;
  `;

  dialog.innerHTML = `
    <h3 style="margin: 0 0 15px 0;">Export Audit</h3>
    <div style="margin: 10px 0;">
      <button id="wic-export-md" style="width: 100%; padding: 8px; margin: 5px 0; cursor: pointer;">
        📄 Markdown
      </button>
      <button id="wic-export-json" style="width: 100%; padding: 8px; margin: 5px 0; cursor: pointer;">
        {} JSON
      </button>
      <button id="wic-export-csv" style="width: 100%; padding: 8px; margin: 5px 0; cursor: pointer;">
        📊 CSV
      </button>
      <button id="wic-export-close" style="width: 100%; padding: 8px; margin: 5px 0; cursor: pointer; background: #ccc;">
        ✕ Close
      </button>
    </div>
  `;

  document.body.appendChild(dialog);

  document.getElementById('wic-export-md')?.addEventListener('click', () => {
    exportAudit('markdown', sessionData);
    dialog.remove();
  });

  document.getElementById('wic-export-json')?.addEventListener('click', () => {
    exportAudit('json', sessionData);
    dialog.remove();
  });

  document.getElementById('wic-export-csv')?.addEventListener('click', () => {
    exportAudit('csv', sessionData);
    dialog.remove();
  });

  document.getElementById('wic-export-close')?.addEventListener('click', () => {
    dialog.remove();
  });
}

function exportAudit(format: string, sessionData: any) {
  chrome.runtime.sendMessage(
    {
      action: 'EXPORT_AUDIT',
      format,
      data: sessionData
    },
    response => {
      if (response.success) {
        downloadFile(response.data, format);
      }
    }
  );
}

function downloadFile(content: string, format: string) {
  const mimeTypes = {
    markdown: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
    yaml: 'text/yaml'
  };

  const blob = new Blob([content], { type: mimeTypes[format] || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-${Date.now()}.${format === 'markdown' ? 'md' : format}`;
  a.click();
  URL.revokeObjectURL(url);
}

console.log('[ContentScript] Ready');
