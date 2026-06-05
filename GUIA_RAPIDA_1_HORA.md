# 🚀 GUÍA RÁPIDA: CREAR TU EXTENSIÓN MV3 EN 1 HORA

## Objetivo
Extensión funcional que automatiza prompts en un sitio web (estilo Gemini Automator).

## Requisitos
- VS Code
- Node.js (opcional, para bundling)
- Chrome versión 88+

---

## Paso 1: Crear Estructura Base (5 minutos)

```bash
mkdir my-automation-ext
cd my-automation-ext

# Crear archivos
touch manifest.json
touch popup.html popup.js
touch content.js
touch background.js
mkdir icons

# Para ícono, copiar un PNG 128x128 a icons/
```

## Paso 2: manifest.json (5 minutos)

```json
{
  "manifest_version": 3,
  "name": "My Automation",
  "version": "1.0",
  "description": "Automatiza prompts en tu sitio favorito",
  
  "permissions": [
    "activeTab",
    "storage",
    "downloads"
  ],
  
  "host_permissions": [
    "https://tu-sitio-web.com/*"
  ],
  
  "background": {
    "service_worker": "background.js"
  },
  
  "action": {
    "default_title": "My Automation",
    "default_popup": "popup.html",
    "default_icon": "icons/icon128.png"
  },
  
  "content_scripts": [
    {
      "matches": ["https://tu-sitio-web.com/*"],
      "js": ["content.js"]
    }
  ]
}
```

## Paso 3: popup.html (5 minutos)

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      width: 400px;
      padding: 15px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto;
      background: #f5f5f5;
    }
    h2 {
      margin-top: 0;
      color: #333;
    }
    textarea {
      width: 100%;
      height: 120px;
      padding: 8px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 12px;
      font-family: monospace;
      box-sizing: border-box;
    }
    button {
      width: 100%;
      padding: 10px;
      margin-top: 10px;
      background: #4CAF50;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      font-weight: bold;
    }
    button:hover {
      background: #45a049;
    }
    button:disabled {
      background: #ccc;
      cursor: not-allowed;
    }
    #status {
      margin-top: 15px;
      padding: 10px;
      background: white;
      border-radius: 4px;
      font-size: 13px;
      color: #666;
      text-align: center;
      min-height: 20px;
    }
    .stats {
      font-size: 11px;
      color: #999;
      margin-top: 5px;
    }
  </style>
</head>
<body>
  <h2>📝 Automation Queue</h2>
  
  <label>Prompts (uno por línea):</label>
  <textarea id="prompts" placeholder="Prompt 1&#10;Prompt 2&#10;Prompt 3"></textarea>
  
  <button id="startBtn">▶️ START</button>
  <button id="stopBtn" disabled>⏹️ STOP</button>
  
  <div id="status">Listo</div>
  <div class="stats" id="stats"></div>
  
  <script src="popup.js"></script>
</body>
</html>
```

## Paso 4: popup.js (10 minutos)

```javascript
const prompts = document.getElementById('prompts');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const status = document.getElementById('status');
const stats = document.getElementById('stats');

// Cargar estado al abrir popup
chrome.storage.local.get(['queue', 'stats'], (data) => {
  if (data.queue) {
    prompts.value = data.queue.join('\n');
  }
  if (data.stats) {
    updateStats(data.stats);
  }
  updateUI();
});

startBtn.addEventListener('click', async () => {
  const lines = prompts.value
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  
  if (lines.length === 0) {
    alert('Agrega al menos un prompt');
    return;
  }
  
  // Guardar queue
  await chrome.storage.local.set({
    queue: lines,
    running: true,
    currentIndex: 0,
    stats: { total: lines.length, completed: 0, failed: 0 }
  });
  
  // Notificar a content script
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]) {
    chrome.tabs.sendMessage(tabs[0].id, { action: 'START' });
  }
  
  updateUI();
});

stopBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ running: false });
  
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]) {
    chrome.tabs.sendMessage(tabs[0].id, { action: 'STOP' }).catch(() => {});
  }
  
  updateUI();
});

async function updateUI() {
  const data = await chrome.storage.local.get(['running', 'queue', 'stats']);
  
  startBtn.disabled = data.running || !data.queue || data.queue.length === 0;
  stopBtn.disabled = !data.running;
  
  if (data.running) {
    status.textContent = '⚙️ Ejecutando...';
  } else if (data.stats?.completed > 0) {
    status.textContent = '✅ Completado';
  } else {
    status.textContent = '⏳ Listo para comenzar';
  }
}

function updateStats(st) {
  if (st) {
    stats.textContent = `${st.completed}/${st.total} completados | ${st.failed} fallidos`;
  }
}

// Actualizar UI cada 1 segundo
setInterval(updateUI, 1000);
```

## Paso 5: content.js (20 minutos)

```javascript
// IMPORTANTE: Modifica estos selectores según tu sitio
const SELECTORS = {
  promptInput: 'input[placeholder*="Enter your prompt"], textarea[data-testid="input"]',
  submitBtn: 'button[aria-label="Send"], button:contains("Send")',
  outputArea: '[role="img"], .generated-image, [data-output]',
  spinner: '[role="progressbar"], .spinner, [data-loading]'
};

let isRunning = false;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'START') {
    console.log('[Automation] START received');
    isRunning = true;
    processNextPrompt();
  } else if (request.action === 'STOP') {
    console.log('[Automation] STOP received');
    isRunning = false;
  }
});

async function processNextPrompt() {
  if (!isRunning) return;
  
  // Obtener state
  const data = await chrome.storage.local.get([
    'queue', 'currentIndex', 'running', 'stats'
  ]);
  
  if (!data.running) {
    console.log('[Automation] Queue stopped');
    return;
  }
  
  const { queue, currentIndex = 0, stats = { total: 0, completed: 0, failed: 0 } } = data;
  
  if (currentIndex >= queue.length) {
    console.log('[Automation] ✅ All done!');
    await chrome.storage.local.set({
      running: false,
      stats: { ...stats, status: 'complete' }
    });
    return;
  }
  
  const prompt = queue[currentIndex];
  console.log(`[Automation] Processing: "${prompt}" (${currentIndex + 1}/${queue.length})`);
  
  try {
    // 1️⃣ Encuentra y llena el input
    const input = document.querySelector(SELECTORS.promptInput);
    if (!input) {
      throw new Error('Input not found. Check SELECTORS');
    }
    
    input.focus();
    input.value = prompt;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    
    console.log('[Automation] Filled input');
    
    // 2️⃣ Presiona el botón
    await new Promise(r => setTimeout(r, 300));
    
    const button = document.querySelector(SELECTORS.submitBtn);
    if (!button) {
      throw new Error('Submit button not found');
    }
    
    button.click();
    console.log('[Automation] Clicked submit');
    
    // 3️⃣ Espera generación
    await waitForGeneration();
    console.log('[Automation] Generation complete');
    
    // 4️⃣ Descarga imagen (opcional)
    await downloadOutput(currentIndex);
    
    // ✅ Success
    stats.completed++;
    
  } catch (error) {
    console.error('[Automation] Error:', error.message);
    stats.failed++;
  }
  
  // Avanza a siguiente
  const nextIndex = currentIndex + 1;
  await chrome.storage.local.set({
    currentIndex: nextIndex,
    stats
  });
  
  // Delay antes de siguiente
  await new Promise(r => setTimeout(r, 2000));
  
  // Procesa siguiente
  processNextPrompt();
}

async function waitForGeneration(timeoutMs = 120000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const output = document.querySelector(SELECTORS.outputArea);
    const spinner = document.querySelector(SELECTORS.spinner);
    
    // Si hay output Y no hay spinner → terminó
    if (output && !spinner) {
      return true;
    }
    
    await new Promise(r => setTimeout(r, 1000));
  }
  
  throw new Error('Generation timeout');
}

async function downloadOutput(index) {
  try {
    // Intenta método 1: <img> con src
    const img = document.querySelector('img[alt*="generated"], img[data-output]');
    if (img?.src) {
      const url = img.src;
      
      // Pide al background que descargue
      chrome.runtime.sendMessage({
        action: 'DOWNLOAD',
        url,
        filename: `output_${index + 1}.jpg`
      });
      return;
    }
    
    // Intenta método 2: <a> con download
    const link = document.querySelector('a[download]');
    if (link) {
      link.click();
      return;
    }
  } catch (error) {
    console.warn('[Automation] Download failed:', error.message);
  }
}
```

## Paso 6: background.js (10 minutos)

```javascript
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'DOWNLOAD') {
    const { url, filename } = request;
    
    chrome.downloads.download(
      { url, filename },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error('Download failed:', chrome.runtime.lastError);
          sendResponse({ ok: false });
        } else {
          console.log('[Background] Download started:', downloadId);
          sendResponse({ ok: true, downloadId });
        }
      }
    );
    
    return true;  // Keep channel open
  }
});

// Log cuando se activa
console.log('[Background] Service worker loaded');
```

---

## Paso 7: Instalar en Chrome (5 minutos)

1. Abre `chrome://extensions/`
2. Activa **"Developer mode"** (esquina superior derecha)
3. Haz clic en **"Load unpacked"**
4. Selecciona la carpeta `my-automation-ext`
5. ¡Listo! Ya está instalada

---

## Paso 8: Probar (5 minutos)

1. Ve a tu sitio web objetivo
2. Haz clic en el ícono de la extensión
3. Pega prompts (uno por línea)
4. Presiona "START"
5. Observa cómo se automatiza 🎉

---

## Debugging

Abre **Chrome DevTools**:

```javascript
// Para ver logs del content script:
// F12 → Console → busca "[Automation]"

// Para ver logs del background service worker:
// chrome://extensions/ → Haz clic en "service worker" en tu extensión

// Para inspeccionar storage:
// F12 → Application → Storage → Local Storage
```

---

## Mejoras Fáciles Después

### 1. Agregar Validación
```javascript
if (!input) {
  alert('No encontré el input. Modifica SELECTORS en content.js');
  return;
}
```

### 2. Agregar Configuración
```javascript
// Añade a popup.html
<label>
  <input type="number" id="delay" min="1000" max="10000" value="2000">
  Delay entre prompts (ms)
</label>

// En popup.js
const delay = parseInt(document.getElementById('delay').value);
await new Promise(r => setTimeout(r, delay));
```

### 3. Soporte para CSV
```javascript
// content.js
function parseCSV(text) {
  return text.split('\n')
    .map(line => line.trim())
    .filter(line => line);
}

// popup.html
<input type="file" id="csvFile" accept=".csv">
```

### 4. Guardar Resultados
```javascript
// Agregar a downloadOutput
const results = await chrome.storage.local.get('results');
const list = results.results || [];
list.push({ prompt, timestamp: Date.now(), filename });
await chrome.storage.local.set({ results: list });
```

---

## Checklist Final

- ✅ Modificaste `SELECTORS` según tu sitio
- ✅ Los selectores funcionan (abre DevTools, pega en console)
- ✅ Extensión instalada en `chrome://extensions/`
- ✅ Probaste manualmente en tu sitio
- ✅ Funciona automation básica (al menos 1 prompt)
- ✅ Descargas funcionan (opcional)

---

## Troubleshooting

| Problema | Solución |
|----------|----------|
| "Input not found" | Usa DevTools → Inspector para encontrar el selector correcto |
| Extensión no aparece | Ve a `chrome://extensions/`, haz reload |
| Content script no se ejecuta | Comprueba `host_permissions` en manifest.json |
| Popup no muestra status | Abre DevTools del popup (clic derecho → Inspect) |
| Descargas no funcionan | Agrega `"downloads"` en permissions |

---

## Siguiente Paso: Versionado y Recovery

Una vez que funciona básico, agrega:

1. **Health Checks** (verifica si página está lista)
2. **Recovery Logic** (reintentos si falla)
3. **Task Ledger** (persiste estado si se resetea)
4. **Message Bus** (comunicación estructurada)

Consulta `PATRONES_REUTILIZABLES.md` para código listo.

---

**¡Felicidades! Acabas de crear una extensión MV3 funcional en menos de 1 hora.**

