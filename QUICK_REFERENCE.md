# 🎯 QUICK REFERENCE CARD - Chrome MV3 Cheat Sheet

**Print this page or save as PDF** para tenerlo a mano mientras codeas.

---

## 📌 MANIFEST.JSON Template

```json
{
  "manifest_version": 3,
  "name": "Mi Extensión",
  "version": "1.0.0",
  "permissions": ["storage", "tabs"],
  "host_permissions": ["https://ejemplo.com/*"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [{
    "matches": ["https://ejemplo.com/*"],
    "js": ["content.js"],
    "run_at": "document_end"
  }],
  "action": {
    "default_popup": "popup.html",
    "default_icon": { "16": "images/icon16.png" }
  }
}
```

---

## 📂 ESTRUCTURA MÍNIMA

```
mi-extension/
├── manifest.json
├── popup.html
├── popup.js
├── content.js
├── background.js
└── images/
    └── icon16.png
```

---

## 🔌 MESSAGE PASSING (Content ↔ Background)

### Enviar desde Content a Background
```javascript
chrome.runtime.sendMessage({ action: "DOWNLOAD", url: "..." }, response => {
  console.log("Response:", response);
});
```

### Escuchar en Background
```javascript
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "DOWNLOAD") {
    chrome.downloads.download({ url: request.url });
  }
  sendResponse({ ok: true });
});
```

---

## 💾 STORAGE API (Persistencia)

### Guardar
```javascript
chrome.storage.local.set({ key: "value" });
```

### Leer
```javascript
chrome.storage.local.get("key", (result) => {
  console.log(result.key);
});
```

### Limpiar
```javascript
chrome.storage.local.clear();
```

---

## ⏱️ ESPERAR ELEMENTOS

```javascript
async function waitForElement(selector, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = document.querySelector(selector);
    if (el) return el;
    await sleep(100);
  }
  throw new Error("Elemento no encontrado");
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
```

---

## 🖱️ CLICK / TYPE HUMANIZADO

```javascript
// Click
async function humanClick(selector) {
  const el = await waitForElement(selector);
  el.scrollIntoView({ behavior: 'smooth' });
  await sleep(300);
  el.click();
  await sleep(200);
}

// Type (carácter por carácter)
async function humanType(selector, text) {
  const el = await waitForElement(selector);
  el.focus();
  for (const char of text) {
    el.value += char;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(50 + Math.random() * 100);
  }
}
```

---

## 🌳 SHADOW DOM TRAVERSAL

```javascript
function findInShadow(node, selector) {
  // Buscar en shadowRoot actual
  if (node.shadowRoot?.querySelector(selector)) {
    return node.shadowRoot.querySelector(selector);
  }
  
  // Recursivo: buscar en children
  if (node.shadowRoot) {
    for (const child of node.shadowRoot.querySelectorAll('*')) {
      const result = findInShadow(child, selector);
      if (result) return result;
    }
  }
  
  return null;
}
```

---

## ⚙️ REACT FIBER ACCESS

```javascript
function getReactFiber(element) {
  const keys = Object.keys(element);
  const key = keys.find(k => k.startsWith('__reactFiber'));
  return element[key];
}

// Uso: acceder a props, state, hooks
const fiber = getReactFiber(element);
console.log(fiber.memoizedProps); // props del componente
```

---

## 📥 DESCARGAR ARCHIVO

### Desde Content Script
```javascript
chrome.runtime.sendMessage({
  action: "DOWNLOAD",
  url: "https://...",
  filename: "mi-archivo.zip"
});
```

### Escuchar en Background
```javascript
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "DOWNLOAD") {
    chrome.downloads.download({
      url: request.url,
      filename: request.filename
    });
  }
});
```

---

## 🔄 EXPONENTIAL BACKOFF

```javascript
async function executeWithRetry(fn, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s
      const delay = Math.pow(2, i) * 1000;
      const jitter = Math.random() * delay * 0.1; // ±10%
      
      await sleep(delay + jitter);
    }
  }
}

// Uso
await executeWithRetry(async () => {
  const response = await fetch("/api/data");
  return response.json();
});
```

---

## 📝 LOGGING CON PERSISTENCIA

```javascript
async function log(level, message) {
  const { logs = [] } = await chrome.storage.local.get('logs');
  logs.push({
    timestamp: new Date().toISOString(),
    level,
    message
  });
  
  // Limitar a últimas 100 líneas
  if (logs.length > 100) logs.shift();
  
  chrome.storage.local.set({ logs });
  console.log(`[${level}] ${message}`);
}

// Uso
await log("INFO", "Iniciando automatización");
await log("ERROR", "Elemento no encontrado");
```

---

## 🎯 STATE MACHINE SIMPLE

```javascript
class TaskStateMachine {
  constructor() {
    this.state = 'IDLE';
    this.handlers = {};
  }
  
  on(state, handler) {
    this.handlers[state] = handler;
  }
  
  async transition(newState) {
    const handler = this.handlers[newState];
    if (handler) {
      this.state = newState;
      await handler();
    }
  }
}

// Uso
const sm = new TaskStateMachine();
sm.on('IDLE', () => console.log('Esperando...'));
sm.on('RUNNING', () => console.log('Ejecutando...'));
sm.on('DONE', () => console.log('Completado!'));

await sm.transition('RUNNING');
await sm.transition('DONE');
```

---

## 📋 TASK LEDGER (Simple)

```javascript
class TaskLedger {
  constructor() {
    this.tasks = [];
  }
  
  addTask(id, action) {
    this.tasks.push({
      id,
      action,
      status: 'pending',
      createdAt: Date.now()
    });
  }
  
  updateTask(id, status) {
    const task = this.tasks.find(t => t.id === id);
    if (task) task.status = status;
  }
  
  getNextPending() {
    return this.tasks.find(t => t.status === 'pending');
  }
  
  async save() {
    await chrome.storage.local.set({ ledger: this.tasks });
  }
  
  async load() {
    const { ledger = [] } = await chrome.storage.local.get('ledger');
    this.tasks = ledger;
  }
}
```

---

## 🔍 DEBUGGING CHECKLIST

### Content Script errors?
→ F12 en la página → Console

### Service Worker errors?
→ chrome://extensions/ → Find your extension → Click "Service Worker"

### Storage issues?
```javascript
chrome.storage.local.get(null, (result) => {
  console.table(result);
});
```

### Message passing not working?
1. Verifica manifest permissions
2. Verifica host_permissions
3. Usa `console.log` en ambos lados
4. Service Worker reinicia cada 5 min

### Elemento no encontrado?
```javascript
// Esperar más tiempo
await waitForElement(selector, 10000); // 10 segundos

// O buscar con XPath
const xpath = "//button[contains(text(), 'Enviar')]";
const result = document.evaluate(xpath, document);
const element = result.iterateNext();
```

---

## ✅ INSTALACIÓN EN CHROME

1. Abre `chrome://extensions/`
2. Activa "Modo de desarrollador" (arriba derecha)
3. Click "Cargar extensión sin empaquetar"
4. Selecciona carpeta con manifest.json
5. ¡Listo!

**Para recargar cambios**: F5 en chrome://extensions/

---

## 🐛 ERRORES COMUNES

| Error | Solución |
|-------|----------|
| "Cannot read property 'X' of null" | Usa `await waitForElement()` |
| Message not received | Verifica manifest permissions |
| Extension invisible | Verifica manifest.json JSON |
| Content script not running | Verifica host_permissions |
| Storage returns undefined | Usa `await chrome.storage.local.get()` |
| Element click doesn't work | Usa `element.dispatchEvent(new MouseEvent(...))` |

---

## 🔒 BEST PRACTICES

✅ DO:
- Versiona tus mensajes desde el start
- Crea task ledger para persistencia
- Implementa exponential backoff
- Logea todo (para debugging)
- Usa sleep() entre acciones
- Valida selectores con fallbacks

❌ DON'T:
- Hardcodear selectores sin fallbacks
- Reintentos infinitos (siempre max)
- Almacenar datos sensibles en logs
- Usar `<all_urls>` (seguridad + rendimiento)
- Manipular React internals directamente
- Polling sin timeout

---

## 📚 REFERENCIAS RÁPIDAS

| Tarea | Archivo | Sección |
|-------|---------|---------|
| Crear extension | STARTER_PACK.md | Pasos 1-6 |
| Entender arquitectura | AUDIT_TECNICA_COMPLETA.md | § 2-5 |
| Implementar patrón | PATRONES_REUTILIZABLES.md | Código |
| Debuggear | GUIA_RAPIDA_1_HORA.md | Troubleshooting |
| Comparar extensiones | RESUMEN_EJECUTIVO.md | Tabla |
| Encontrar respuesta | INDICE_COMPLETO.md | Map |

---

## 🎓 30 SEGUNDO PRIMER CÓDIGO

```javascript
// 1. MANIFEST.JSON
{
  "manifest_version": 3,
  "name": "Test",
  "host_permissions": ["<all_urls>"]
}

// 2. CONTENT.JS
let running = false;

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.action === "START") {
    running = true;
    console.log("Starting...");
  }
});

// 3. POPUP.HTML
<button onclick="run()">Start</button>
<script>
function run() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    chrome.tabs.sendMessage(tabs[0].id, { action: "START" });
  });
}
</script>

// 4. INSTALL
→ chrome://extensions/ → Load unpacked → Select folder
```

---

## 🚀 SIGUIENTE PASO

**Guardaste este cheat sheet?** ✅
**¿Ahora qué?**

1. Si necesitas código → Busca en PATRONES_REUTILIZABLES.md
2. Si necesitas tutorial → Lee GUIA_RAPIDA_1_HORA.md
3. Si necesitas entender → Lee AUDIT_TECNICA_COMPLETA.md

**¡Happy coding!** 🎉

---

**Versión**: 1.0  
**Último update**: 2026-06-05  
**Para versión actualizada**: Revisa README.md

