# 🚀 STARTER PACK - Extensión MV3 Completa (5 minutos)

**Objetivo**: Tener una extensión funcional en 5 minutos. No es features-complete, es *working*.

## Paso 1: Crear carpeta proyecto
```bash
mkdir mi-extension
cd mi-extension
```

## Paso 2: Crear `manifest.json`
```json
{
  "manifest_version": 3,
  "name": "Mi Automatización",
  "version": "1.0.0",
  "description": "Mi primer automatización en MV3",
  "permissions": [
    "storage",
    "tabs"
  ],
  "host_permissions": [
    "https://ejemplo.com/*"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["https://ejemplo.com/*"],
      "js": ["content.js"],
      "run_at": "document_end"
    }
  ],
  "action": {
    "default_title": "Mi Automatización",
    "default_popup": "popup.html"
  }
}
```

## Paso 3: Crear `popup.html`
```html
<!DOCTYPE html>
<html>
<head>
  <style>
    body { 
      width: 300px; 
      padding: 15px; 
      font-family: Arial, sans-serif;
      background: #f5f5f5;
    }
    button {
      width: 100%;
      padding: 10px;
      background: #4CAF50;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      margin-bottom: 10px;
    }
    button:hover { background: #45a049; }
    .status {
      padding: 10px;
      background: white;
      border-radius: 4px;
      margin-top: 10px;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <h3>Mi Automatización</h3>
  <button id="start">▶ Iniciar</button>
  <button id="stop">⏹ Detener</button>
  <button id="clear">🗑 Limpiar</button>
  <div id="status" class="status">Estado: Esperando...</div>
  <script src="popup.js"></script>
</body>
</html>
```

## Paso 4: Crear `popup.js`
```javascript
// Listener de botones
document.getElementById('start').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  chrome.tabs.sendMessage(tab.id, { action: 'START' });
  updateStatus('Iniciando...');
});

document.getElementById('stop').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  chrome.tabs.sendMessage(tab.id, { action: 'STOP' });
  updateStatus('Detenido');
});

document.getElementById('clear').addEventListener('click', async () => {
  await chrome.storage.local.clear();
  updateStatus('Almacenamiento limpiado');
});

// Actualizar estado
function updateStatus(msg) {
  document.getElementById('status').textContent = `Estado: ${msg}`;
}

// Leer estado inicial
chrome.storage.local.get(['running'], (result) => {
  const status = result.running ? 'En ejecución' : 'Detenido';
  updateStatus(status);
});

// Escuchar cambios de storage
chrome.storage.onChanged.addListener((changes) => {
  if (changes.running) {
    const status = changes.running.newValue ? 'En ejecución' : 'Detenido';
    updateStatus(status);
  }
});
```

## Paso 5: Crear `content.js`
```javascript
// Variables globales
let running = false;

// Escuchar mensajes del popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'START') {
    running = true;
    chrome.storage.local.set({ running: true });
    startAutomation();
    sendResponse({ status: 'started' });
  } else if (request.action === 'STOP') {
    running = false;
    chrome.storage.local.set({ running: false });
    sendResponse({ status: 'stopped' });
  }
});

// Función principal de automatización
async function startAutomation() {
  console.log('Automatización iniciada');
  
  while (running) {
    try {
      // TODO: Reemplaza esto con tu lógica
      // 1. Buscar elemento
      // 2. Click/type
      // 3. Esperar resultado
      // 4. Guardar estado
      
      console.log('Ejecutando paso de automatización...');
      await sleep(2000); // 2 segundos entre pasos
      
    } catch (error) {
      console.error('Error en automatización:', error);
      await sleep(5000); // Esperar 5s antes de reintentar
    }
  }
  
  console.log('Automatización detenida');
}

// Helper: dormir
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper: esperar elemento
async function waitForElement(selector, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = document.querySelector(selector);
    if (el) return el;
    await sleep(100);
  }
  throw new Error(`Elemento no encontrado: ${selector}`);
}

// Helper: click humanizado (con delay)
async function humanClick(selector) {
  const el = await waitForElement(selector);
  el.scrollIntoView({ behavior: 'smooth' });
  await sleep(300);
  el.click();
  await sleep(200);
}

// Helper: tipo humanizado (carácter por carácter)
async function humanType(selector, text) {
  const el = await waitForElement(selector);
  el.focus();
  await sleep(100);
  
  for (const char of text) {
    el.value += char;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(50 + Math.random() * 100); // 50-150ms por carácter
  }
}

console.log('Content script cargado');
```

## Paso 6: Crear `background.js`
```javascript
// Service Worker background

// Escuchar mensajes desde content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Mensaje desde content:', request);
  
  if (request.action === 'DOWNLOAD') {
    // Descargar archivo
    chrome.downloads.download({
      url: request.url,
      filename: request.filename || 'descarga.zip'
    });
  }
  
  sendResponse({ received: true });
});

// Escuchar cuando tab se cierra
chrome.tabs.onRemoved.addListener((tabId) => {
  console.log('Tab cerrada:', tabId);
  chrome.storage.local.set({ running: false });
});

console.log('Service Worker cargado');
```

---

## 🎯 Pasos para Instalar

### En Chrome
1. Abre `chrome://extensions/`
2. Activa "Modo de desarrollador" (arriba derecha)
3. Click "Cargar extensión sin empaquetar"
4. Selecciona la carpeta `mi-extension`
5. ¡Listo! Verás el icono en la barra de herramientas

### Pruebas
1. Ve a https://ejemplo.com (reemplaza con tu sitio)
2. Click en el icono de la extensión
3. Click "Iniciar"
4. Abre DevTools (F12)
5. Tab "Console" → ves los logs

---

## 📝 Estructura Final
```
mi-extension/
├── manifest.json       ← Configuración
├── popup.html         ← UI popup
├── popup.js          ← Lógica popup
├── content.js        ← Automatización (ejecuta en página)
└── background.js     ← Service Worker (fondo)
```

---

## ✅ Checklist Rápido

- [ ] Cambié "ejemplo.com" a mi sitio en manifest.json
- [ ] Archivo manifest.json es JSON válido (usa jsonlint.com)
- [ ] Carpeta tiene 5 archivos
- [ ] Instalé en chrome://extensions/
- [ ] El icono aparece en la barra de herramientas
- [ ] F12 → Console muestra "Content script cargado"
- [ ] Click en botón "Iniciar" → console muestra "Automatización iniciada"

---

## 🔧 Mejoras Fáciles (30 minutos)

### 1. Agregar Logging Persistente
En `content.js`:
```javascript
async function log(msg) {
  const { logs = [] } = await chrome.storage.local.get('logs');
  logs.push(`${new Date().toISOString()}: ${msg}`);
  chrome.storage.local.set({ logs });
  console.log(msg);
}
```

### 2. Agregar Configuración
En `popup.html` agregar:
```html
<label>
  Delay entre pasos (ms):
  <input type="number" id="delay" value="2000">
</label>
```

En `popup.js`:
```javascript
document.getElementById('delay').addEventListener('change', (e) => {
  chrome.storage.local.set({ delay: parseInt(e.target.value) });
});
```

### 3. Agregar CSV Upload
En `popup.html`:
```html
<input type="file" id="csvFile" accept=".csv">
```

### 4. Soporte para Multiple Tabs
En `background.js`:
```javascript
const activeTabs = new Set();

chrome.tabs.onActivated.addListener((activeInfo) => {
  activeTabs.add(activeInfo.tabId);
});
```

---

## ❓ Preguntas Frecuentes

**P: ¿Dónde agrego mi lógica de automatización?**
R: En la función `startAutomation()` de `content.js`. Reemplaza el `console.log` con tu código.

**P: ¿Cómo clickeo un botón?**
R: Usa `humanClick('#selector-del-boton')`

**P: ¿Cómo espero a que cargue?**
R: Usa `await waitForElement('#elemento-que-espero')`

**P: ¿Cómo escribo en un input?**
R: Usa `await humanType('#selector-input', 'texto aquí')`

**P: ¿Cómo descargo un archivo?**
R: Envía mensaje a background:
```javascript
chrome.runtime.sendMessage({
  action: 'DOWNLOAD',
  url: 'https://...',
  filename: 'mi-archivo.zip'
});
```

**P: ¿Cómo guardo datos permanentemente?**
R: `chrome.storage.local.set({ miDato: valor })`

**P: ¿Cómo me veo para ver errores?**
R: 
1. Content script errors → F12 en la página
2. Service Worker errors → chrome://extensions/ → Service Worker → console

---

## 🎓 Siguiente Paso

Una vez tengas esto funcionando:
1. Lee **PATRONES_REUTILIZABLES.md** y agrega Task Ledger
2. Estudia **AUDIT_TECNICA_COMPLETA.md** sección 12 (Automatización avanzada)
3. Implementa Recovery Policy si fallos frecuentes

---

**¡Éxito! En 5 minutos tienes extensión MV3 funcional.**

