# 🔍 AUDITORÍA TÉCNICA PROFUNDA: EXTENSIONES CHROME MV3 AUTOMATIZACIÓN WEB

**Especialidad**: Chrome Extensions MV3 | Automatización Web | React Internals | Shadow DOM | DevTools Protocol | Reverse Engineering

---

## 📋 TABLA DE CONTENIDOS

1. [Resumen Ejecutivo](#1-resumen-ejecutivo)
2. [Arquitectura General](#2-arquitectura-general)
3. [Análisis de Manifests](#3-análisis-de-manifests)
4. [Background / Service Workers](#4-background--service-workers)
5. [Content Scripts](#5-content-scripts)
6. [Shadow DOM y React Internals](#6-shadow-dom-y-react-internals)
7. [Aplicaciones SPA](#7-aplicaciones-spa)
8. [Inyección de Código](#8-inyección-de-código)
9. [Comunicación Entre Scripts](#9-comunicación-entre-scripts)
10. [Interceptación de Red](#10-interceptación-de-red)
11. [APIs Especiales de Chrome](#11-apis-especiales-de-chrome)
12. [Automatización Avanzada](#12-automatización-avanzada)
13. [Anti-React / Anti-Shadow DOM](#13-anti-react--anti-shadow-dom)
14. [Patrones Reutilizables](#14-patrones-reutilizables)
15. [Secretos de Ingeniería Avanzada](#15-secretos-de-ingeniería-avanzada)
16. [Cómo Recrearlas](#16-cómo-recrearlas)
17. [Lecciones Aprendidas](#17-lecciones-aprendidas)
18. [APIs Privilegiadas vs Página Normal](#18-apis-privilegiadas-vs-página-normal)

---

## 1. RESUMEN EJECUTIVO

Se han auditado **4 extensiones Chrome MV3** especializadas en automatización de servicios web:

| Extensión | Versión | Propósito | Complejidad |
|-----------|---------|----------|-----------|
| **Auto Flow** | 10.8.8 | Generación masiva en Google Flow (VEO 3) | ⭐⭐⭐⭐⭐ |
| **Gemini Automator** | 1.2 | Batch processing desde CSV en Gemini | ⭐⭐⭐ |
| **Meta Automation** | 2.0.9 | Automatización con descarga en Meta AI | ⭐⭐⭐⭐ |
| **VEO Automation** | 1.1.6 | Generación de videos con sincronización | ⭐⭐⭐⭐ |

**Hallazgo Clave**: Auto Flow es una arquitectura de **grado profesional** con sistemas de recuperación tolerantes a fallos, queue management sofisticado y DevTools integration. Las otras son funcionales pero menos robustas.

---

## 2. ARQUITECTURA GENERAL

### 2.1 Auto Flow - Diagrama de Flujo Completo

```
┌─────────────────────────────────────────────────────────────────┐
│                    USER INTERFACE LAYER                         │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  gateway.html + gateway.js (Side Panel)                  │  │
│  │  - Queue UI                                              │  │
│  │  - Gallery Preview                                       │  │
│  │  - Settings Panel                                        │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│              ORCHESTRATION LAYER (Service Worker)               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  service-worker.js                                       │  │
│  │  ├─ License Client (autenticación)                       │  │
│  │  ├─ Flow Client (API calls)                              │  │
│  │  ├─ Task Ledger (estado persistente)                     │  │
│  │  ├─ Scheduler (lógica de reintentos)                     │  │
│  │  ├─ Queue Executor (ejecución)                           │  │
│  │  ├─ Debugger Engine (chrome.debugger)                    │  │
│  │  └─ Recovery Policy (manejo de errores)                  │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                    ↙              ↓              ↘
        ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
        │  PAGE BRIDGE   │  │  PAGE HOOK     │  │  DEBUGGER      │
        │  (Content)     │  │  (Injected)    │  │  (DevTools)    │
        └────────────────┘  └────────────────┘  └────────────────┘
                │                    │                    │
                └────────────────────┼────────────────────┘
                                     ↓
        ┌──────────────────────────────────────────────┐
        │      GOOGLE FLOW PAGE (React SPA)            │
        │  ├─ Composer Input                           │
        │  ├─ Model Selector                           │
        │  ├─ Gallery (React Fiber)                    │
        │  ├─ Settings Panel                           │
        │  └─ Video Player                             │
        └──────────────────────────────────────────────┘
                             ↓
        ┌──────────────────────────────────────────────┐
        │  GOOGLE FLOW BACKEND API                     │
        │  ├─ /v1/projects/{id}/media/submitText2Video│
        │  ├─ /v1/projects/{id}/operations           │
        │  ├─ /v1/projects/{id}/media/getStatus      │
        │  └─ /upload endpoints (GraphQL)             │
        └──────────────────────────────────────────────┘
                             ↓
        ┌──────────────────────────────────────────────┐
        │  GOOGLE INFRASTRUCTURE                       │
        │  ├─ Supabase (state sync)                    │
        │  ├─ GCS (media storage)                      │
        │  └─ Vertex AI / VEO (generación)             │
        └──────────────────────────────────────────────┘
```

### 2.2 Ciclo de Vida Completo

```
INSTALACIÓN
    ↓
Chrome inicia service-worker.js (módulo ES6)
    ↓
license-client inicializa (valida token)
    ↓
USUARIO ABRE SIDE PANEL
    ↓
gateway.js carga en iframe del panel
    ↓
USUARIO AGREGA TASKS A LA COLA
    ↓
Task Ledger almacena en chrome.storage.local
    ↓
USUARIO PRESIONA "START"
    ↓
scheduler.createScheduler() inicia loop
    ↓
Para cada task:
    ├─ queueExecutor.execute()
    ├─ Inyecta page-hook.js si no existe
    ├─ Envía comando via postMessage
    ├─ Page hook interactúa con React SPA
    ├─ Captura respuesta API
    ├─ Maneja errores con recovery policy
    ├─ Reintenta hasta 12 veces
    └─ Descarga media final
    ↓
FINALIZACIÓN
    ├─ Persiste resultados
    ├─ Genera reporte de ejecución
    └─ Emite evento de completado

MANEJO DE ERRORES:
Si error de "Flow Renderer Crash":
    ├─ detectFlowRendererCrashSnapshot()
    ├─ Soft reload, cache clear, o service worker bypass
    └─ Reintenta
Si error de quota hard:
    ├─ flow_model_daily_quota_reached
    ├─ flow_account_quota_reached
    └─ Pausa queue (no reintentos)
```

### 2.3 Punto de Entrada

**Archivo**: [src/background/service-worker.js](src/background/service-worker.js)

- ES6 Module (type: "module" en manifest)
- Importa ~20 módulos de contratos, autenticación, media, queue
- `runtimeState` global con estado de sesión
- Event listeners para mensajes de content script
- Scheduled task execution loop

---

## 3. ANÁLISIS DE MANIFESTS

### 3.1 Auto Flow (manifest.json)

```json
{
  "manifest_version": 3,
  "name": "Auto Flow",
  "version": "10.8.8",
  "description": "Auto Flow generation queue for Google Flow.",
  
  "background": {
    "service_worker": "src/background/service-worker.js",
    "type": "module"  // ← ES6 modules habilitados
  },
  
  "permissions": [
    "sidePanel",      // Habilita side panel como interfaz
    "activeTab",      // Acceso a pestaña activa
    "cookies",        // Lectura de cookies (autenticación)
    "browsingData",   // Limpia datos de navegación
    "scripting",      // chrome.scripting.executeScript()
    "storage",        // chrome.storage (local + sync)
    "unlimitedStorage", // Sin límite de almacenamiento
    "tabs",          // Información de pestañas
    "downloads",     // Gestión de descargas
    "debugger"       // chrome.debugger (punto clave)
  ],
  
  "host_permissions": [
    "https://labs.google/*",
    "https://labs.google.com/*",
    "https://*.labs.google.com/*",
    "https://aisandbox-pa.googleapis.com/*",
    "https://yhcobtwwwhidignoifbg.supabase.co/*"
  ],
  
  "content_scripts": [{
    "js": ["src/content/page-bridge.js"],
    "matches": ["https://labs.google/*", "https://labs.google.com/*"],
    "run_at": "document_start"  // ← Muy temprano
  }],
  
  "web_accessible_resources": [{
    "matches": ["https://labs.google/*", "https://labs.google.com/*"],
    "resources": ["src/page/page-hook.js"]  // ← Inyectable en página
  }],
  
  "side_panel": {
    "default_path": "src/gateway/gateway.html"
  }
}
```

#### Análisis de Permisos Auto Flow

| Permiso | Propósito | ¿Qué no podría hacer sin él? |
|---------|-----------|---------------------------|
| **sidePanel** | Abre panel lateral (interfaz) | No tendría UI nativa (solo popup) |
| **activeTab** | Accede a pestaña actual | No podría ejecutar scripts en tab actual |
| **cookies** | Lee/modifica cookies del dominio | No podría gestionar sesiones automáticamente |
| **browsingData** | `chrome.browsingData.remove()` | No podría limpiar caché/localStorage entre reintentos |
| **scripting** | `chrome.scripting.executeScript()` | No podría inyectar código dinámico (solo content scripts) |
| **storage** | `chrome.storage.local/sync` | No podría persistir queue, estado, resultados |
| **unlimitedStorage** | Sin límite de almacenamiento | Máximo 10MB normal → No podría cachear media |
| **tabs** | `chrome.tabs.query()`, `update()` | No podría detectar cambios de URL |
| **downloads** | `chrome.downloads.download()` | No podría descargar automáticamente |
| **debugger** | `chrome.debugger.*` | No podría capturar network/ejecutar JS remoto |

#### host_permissions Auto Flow

- **labs.google/labs.google.com** → Google Flow (generación principal)
- **aisandbox-pa.googleapis.com** → API de generación (sandbox)
- **yhcobtwwwhidignoifbg.supabase.co** → Backend Supabase (sincronización remota)

---

### 3.2 Gemini Automator (manifest.json)

```json
{
  "manifest_version": 3,
  "name": "Gemini Automator",
  "version": "1.2",
  
  "background": {
    "service_worker": "background.js"
  },
  
  "permissions": [
    "activeTab",      // Acceso a pestaña
    "storage",        // Storage local
    "downloads"       // Descargar imágenes
  ],
  
  "host_permissions": [
    "https://gemini.google.com/*"
  ],
  
  "content_scripts": [{
    "js": ["content_v2.js"],
    "matches": ["https://gemini.google.com/*"]
  }],
  
  "action": {
    "default_popup": "popup.html"
  },
  
  "web_accessible_resources": [{
    "matches": ["https://gemini.google.com/*"],
    "resources": ["content.csv"]  // ← CSV accesible desde página
  }]
}
```

**Características**:
- Permissions **muy reducidos** (solo 3)
- NO usa `scripting` (solo content script estático)
- NO usa `debugger`
- NO usa `sidePanel`
- CSV como web accessible resource (anti-patrón seguridad)

---

### 3.3 Meta Automation (manifest.json)

```json
{
  "manifest_version": 3,
  "name": "Meta Automation - Auto Meta on Meta.ai",
  "version": "2.0.9",
  
  "background": {
    "service_worker": "service-worker-loader.js",
    "type": "module"  // ← ES6
  },
  
  "permissions": [
    "storage",      // Estado persistente
    "tabs",         // Control de pestañas
    "background",   // Ejecución en background
    "sidePanel",    // Interfaz lateral
    "activeTab",    // Tab activa
    "downloads"     // Descargar media
  ],
  
  "side_panel": {
    "default_path": "src/ui/side-panel/index.html"
  },
  
  "content_scripts": [{
    "js": ["assets/index.ts-DAZ_fvVi.js"],
    "matches": ["*://meta.ai/*", "*://www.meta.ai/*"],
    "run_at": "document_end",
    "all_frames": false
  }]
}
```

**Nota**: Código bundled/transpilado (assets/index.ts-*.js)

---

### 3.4 VEO Automation (manifest.json)

```json
{
  "manifest_version": 3,
  "name": "VEO Automation - Tool on Google Flow (VEO3 - GEMINI ULTRA)",
  "version": "1.1.6",
  
  "permissions": [
    "sidePanel",    // Panel lateral
    "activeTab",    // Tab activa
    "storage",      // Almacenamiento
    "downloads"     // Descargar videos
  ],
  
  "side_panel": {
    "default_path": "popup.html"  // ← Reutiliza popup como panel
  },
  
  "content_scripts": [{
    "js": ["content.js"],
    "matches": ["<all_urls>"]  // ← PERMISOS MUY AMPLIOS
  }]
}
```

**Problema de Seguridad**: `matches: ["<all_urls>"]` carga content.js en CADA sitio web.

---

## 4. BACKGROUND / SERVICE WORKERS

### 4.1 Auto Flow Service Worker

**Archivo**: [src/background/service-worker.js](src/background/service-worker.js)

#### Estado Global

```javascript
const runtimeState = {
  bridgeHealthy: false,           // ¿Page bridge funciona?
  queueRunning: false,            // ¿Ejecutando tareas?
  queueRunToken: 0,               // Token anti-concurrencia
  activeTabId: null,              // Pestaña actual
  projectId: "",                  // ID proyecto Flow
  pageUrl: "",                    // URL página
  pageTitle: "",
  authEnvironment: null,          // Ambiente autenticación
  auth: null,                     // Token auth
  lastGalleryItems: [],           // Caché galería
  lastGalleryProjectId: "",
  events: []                      // Auditlog interno
};

const flowSessionRecoveryState = {
  runToken: 0,
  attempts: 0,                    // Número de intentos
  active: false,
  lastTriggerError: "",
  lastFlowErrorCode: "",
  lastStatus: 0,
  lastTaskId: "",
  lastStartedAt: 0,
  recentSessionRejectionAt: 0     // Rate limiting
};

const flowRendererCrashRecoveryState = {
  // Similar para crashes del renderer
};
```

#### Constantes Críticas

```javascript
const EXPECTED_FLOW_BRIDGE_VERSION = "10.8.8-final-rc-pathc-f2v-omni-v247";
const EXPECTED_PAGE_HOOK_VERSION = "10.8.8-final-rc-pathc-f2v-omni-v247";
const MAX_FLOW_SESSION_RECOVERY_ATTEMPTS = 3;
const MAX_FLOW_RENDERER_CRASH_RECOVERY_ATTEMPTS = 2;
const FLOW_SESSION_RECOVERY_LEVELS = [
  "soft_reload",           // Reload normal
  "cache_clear_reload",    // Limpia caché + reload
  "service_worker_bypass_reload"  // Bypass SW
];
```

#### Patrones Detectados

##### 1. **Event Bus Pattern**
```javascript
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { type, payload, meta } = request;
  
  switch (type) {
    case MessageType.BridgeHealth:
      recordEvent({ type: "bridge.health", ...payload });
      runtimeState.bridgeHealthy = payload.ok;
      break;
    case MessageType.PageEvent:
      handlePageEvent(payload);
      break;
    case MessageType.QueueStart:
      startQueue(payload);
      break;
  }
  sendResponse?.({ ok: true });
});
```

##### 2. **Scheduler Pattern**
```javascript
const scheduler = createScheduler({ 
  ledger,           // Task tracking
  maxAttempts: 12   // Reintentos
});

// Loop principal
setInterval(async () => {
  if (!runtimeState.queueRunning) return;
  
  const nextTask = ledger.getNextPending();
  if (!nextTask) return;
  
  await scheduler.execute(nextTask);
}, 500);  // Polling cada 500ms
```

##### 3. **Recovery Policy Pattern**
```javascript
async function executeWithRecovery(task) {
  let attempts = 0;
  
  while (attempts < MAX_ATTEMPTS) {
    try {
      const result = await attemptTask(task);
      if (result.ok) return result;
      
      const recovery = classifyRecoveryPolicy(result.error);
      if (recovery.recoverability === "hard_stop") {
        return { ok: false, hard: true };
      }
      
      await applyRecoveryStep(recovery.recoveryPolicy);
      attempts++;
    } catch (error) {
      attempts++;
    }
  }
  
  return { ok: false, attempts };
}
```

##### 4. **License Client Pattern**
```javascript
const licenseClient = createLicenseClient({
  storage: createChromeStorageAdapter(),
  environmentProvider: () => runtimeState.authEnvironment,
  openTab: async (url) => chrome.tabs.create({ url })
});

// Valida licencia antes de ejecutar
const isValid = await licenseClient.checkValid();
if (!isValid) {
  recordEvent({ type: "license.invalid" });
  return;
}
```

### 4.2 Gemini Automator Background

**Archivo**: [background.js](../Gemini%20Automator%201.2/background.js)

```javascript
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "download") {
    const filename = request.filename || `gemini_output_${request.index + 1}_${Date.now()}.jpg`;
    
    chrome.downloads.download({
      url: request.url,
      filename: filename
    }, (downloadId) => {
      // Escucha completación
      const checkDownload = (delta) => {
        if (delta.id === downloadId && delta.state?.current === 'complete') {
          chrome.downloads.onChanged.removeListener(checkDownload);
          // Valida nombre final
          chrome.downloads.search({ id: downloadId }, (results) => {
            sendResponse({ success: true, filename: results[0].filename });
          });
        }
      };
      chrome.downloads.onChanged.addListener(checkDownload);
    });
    return true;  // Keep channel open
  }
});
```

**Patrón Detectado**: Download tracking con callbacks asincronos.

### 4.3 VEO Automation Background

**Archivo**: [background.js](../VEO%20Automation/background.js)

```javascript
const FLOW_HOST_KEYWORDS = ['labs.google', 'googleusercontent', 'googlevideo', 'gstatic'];

function shouldHandleDownload(url, referrer) {
  const haystack = `${url || ''} ${referrer || ''}`.toLowerCase();
  return FLOW_HOST_KEYWORDS.some(keyword => haystack.includes(keyword));
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'SET_NEXT_DOWNLOAD_NAMES') {
    const names = Array.isArray(request.fileNames)
      ? request.fileNames.map(n => sanitizeFileName(n)).filter(Boolean)
      : [];
    fileNameQueue.push(...names);
    sendResponse?.({ ok: true, queued: fileNameQueue.length });
    return;
  }
  
  if (request.action === 'TRUSTED_CLICK_AT') {
    const { x, y, tabId } = request;
    // ← ACCIÓN PRIVILEGIADA: Habilita clicks simulados desde content script
    chrome.tabs.sendMessage(tabId, {
      action: 'PERFORM_TRUSTED_CLICK',
      x, y
    });
  }
});
```

**Patrón**: Queue de nombres para sincronizar descargas con inyecciones de click.

---

## 5. CONTENT SCRIPTS

### 5.1 Auto Flow Content Bridge

**Archivo**: [src/content/page-bridge.js](src/content/page-bridge.js)

```javascript
(function installAutoFlowRebuildBridge() {
  const SOURCE = "autoflow-1080-rebuild-v26";
  const BRIDGE_VERSION = "10.8.8-final-rc-pathc-f2v-omni-v247";
  
  // Auto-detecta si ya está instalada
  if (window.__afRebuildContentBridgeInstalled && 
      window.__afRebuildContentBridgeVersion === BRIDGE_VERSION) {
    // Ya instalada → envía health check
    chrome.runtime.sendMessage({
      type: "af.rebuild.bridge.health",
      payload: {
        ok: true,
        href: location.href,
        alreadyInstalled: true,
        bridgeVersion: BRIDGE_VERSION,
        pageHookInstalled: Boolean(window.__afRebuildPageHookInstalled)
      }
    });
    return;
  }
  
  // Marca como instalada
  window.__afRebuildContentBridgeInstalled = true;
  window.__afRebuildContentBridgeVersion = BRIDGE_VERSION;
  
  const pending = new Map();  // UUID → promise resolver
  
  // ═══════════════════════════════════════════════════════════
  // COMUNICACIÓN CRÍTICA: Content Script ↔ Page Hook
  // ═══════════════════════════════════════════════════════════
  function requestPageHook(payload = {}, timeoutMs = 10000, requireFreshHook = true) {
    const requestId = crypto.randomUUID();
    
    const promise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve({ ok: false, error: "page_command_timeout" });
      }, timeoutMs);
      
      pending.set(requestId, { resolve, timer, requireFreshHook });
    });
    
    // Envía comando a page hook via postMessage
    window.postMessage({
      source: SOURCE,
      type: "af.rebuild.page.command",
      requestId,
      payload
    }, "*");
    
    return promise;
  }
  
  // Recibe respuestas desde page hook
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE) return;
    
    if (data.type === "af.rebuild.page.command.result" && data.requestId) {
      const entry = pending.get(data.requestId);
      if (!entry) return;
      
      // Valida que sea del hook correcto
      if (entry.requireFreshHook && data.payload?.hookVersion !== EXPECTED_PAGE_HOOK_VERSION) {
        return;
      }
      
      pending.delete(data.requestId);
      clearTimeout(entry.timer);
      entry.resolve(data.payload || {});
      return;
    }
    
    // Reenvía eventos del page hook al service worker
    if (data.type !== "af.rebuild.page.event") return;
    chrome.runtime.sendMessage("af.rebuild.page.event", data.payload || {});
  });
  
  // Inyecta page hook si no existe
  function injectPageHook() {
    const script = document.createElement("script");
    script.src = `${chrome.runtime.getURL("src/page/page-hook.js")}?v=${encodeURIComponent(BRIDGE_VERSION)}-${Date.now()}`;
    script.dataset.autoflowRebuild = "page-hook";
    script.async = false;
    script.onload = () => script.remove();
    script.onerror = () => script.remove();
    (document.documentElement || document.head).appendChild(script);
  }
  
  // Inyecta si es necesario
  if (!window.__afRebuildPageHookInstalled) {
    injectPageHook();
  }
})();
```

#### Patrón de Inyección Segura

```
┌─────────────────────────────────────┐
│ Content Script (en context de ext)  │
└─────────────────────────────────────┘
            ↓ (puede acceder chrome.* APIs)
┌─────────────────────────────────────┐
│ Page Context (context de página)    │
│ (NO puede acceder chrome.* APIs)    │
└─────────────────────────────────────┘

Comunicación: window.postMessage() + event listeners
```

### 5.2 Gemini Automator Content Script

**Archivo**: [content_v2.js](../Gemini%20Automator%201.2/content_v2.js)

```javascript
if (window !== window.top) return;  // Solo frame principal

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "START") {
    isRunning = true;
    processNextPrompt();
  } else if (request.action === "QUEUE_UPDATED") {
    console.log(`Queue updated! Total: ${request.total}`);
  }
});

async function processNextPrompt() {
  const { prompts, globalIndex, status } = await chrome.storage.local.get([...]);
  
  if (status !== 'running') {
    console.log("Automator stopped");
    return;
  }
  
  if (isGenerating()) {
    // Detecta si Gemini está ocupado
    setTimeout(processNextPrompt, 2000);
    return;
  }
  
  const promptItem = prompts[0];
  const promptText = promptItem.text || String(promptItem);
  
  // ═══════════════════════════════════════════════════════════
  // TÉCNICA: Detección de Estado en React SPA
  // ═══════════════════════════════════════════════════════════
  const inputSuccess = await insertPrompt(promptText);
  if (!inputSuccess) {
    setTimeout(processNextPrompt, 5000);  // Reintentar
    return;
  }
  
  window.scrollTo(0, document.body.scrollHeight);
  
  const generationSuccess = await waitForGeneration();
  
  await new Promise(r => setTimeout(r, 2000));
  
  // ═══════════════════════════════════════════════════════════
  // TÉCNICA: Descarga Robusta con Fallback
  // ═══════════════════════════════════════════════════════════
  const downloadResult = await findAndDownloadImage(globalIndex, customFilename);
  let imageFilename = downloadResult?.filename || "Failed";
  let imageUrl = downloadResult?.imageUrl;
  
  // Almacena resultado
  const results = (await chrome.storage.local.get(['results'])).results || {};
  results[globalIndex] = imageFilename;
  
  if (imageUrl) {
    const generatedImages = (await chrome.storage.local.get(['generatedImages'])).generatedImages || [];
    generatedImages.push({
      index: globalIndex,
      prompt: promptText,
      filename: imageFilename,
      url: imageUrl,
      timestamp: Date.now()
    });
    await chrome.storage.local.set({ generatedImages });
  }
  
  // IMPORTANTE: Pop y avanza índice SIEMPRE
  prompts.shift();
  await chrome.storage.local.set({
    prompts: prompts,
    globalIndex: globalIndex + 1
  });
  
  // Continúa con siguiente
  setTimeout(processNextPrompt, 1000);
}

// ═══════════════════════════════════════════════════════════
// DETECTORES DE ESTADO
// ═══════════════════════════════════════════════════════════

function isGenerating() {
  // Busca indicadores visuales
  return document.querySelector('[data-testid="generating"]') !== null;
}

async function waitForGeneration(timeoutMs = 120000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    if (isGenerated()) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  
  return false;
}

function isGenerated() {
  // XPath o querySelector que detecta completación
  const output = document.querySelector('[role="img"][data-state="loaded"]');
  return !!output;
}

async function findAndDownloadImage(index, filename) {
  try {
    // Intenta método 1: Fetch desde dataUrl
    const canvas = document.querySelector('canvas[data-gemini-output]');
    if (canvas) {
      const blob = await new Promise(r => canvas.toBlob(r));
      const url = URL.createObjectURL(blob);
      return { filename, imageUrl: url };
    }
    
    // Método 2: Busca <img> visible
    const img = document.querySelector('img[data-image-output]');
    if (img?.src) {
      return { filename, imageUrl: img.src };
    }
    
    // Método 3: Solicita al background que descargue
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: "waitForNextDownload"
      }, (resp) => {
        resolve(resp?.success ? { filename: resp.filename, imageUrl: null } : null);
      });
    });
  } catch (error) {
    console.error("Download failed:", error);
    return null;
  }
}
```

#### Técnicas Detectadas

1. **Health Checks**: `isGenerating()`, `isGenerated()`
2. **Polling**: `while` loop con `setTimeout`
3. **Descarga Robusta**: 3 métodos fallback
4. **State Persistence**: `chrome.storage.local` para queue
5. **Error Handling**: Reintentos con backoff

### 5.3 VEO Automation Content Script

**Archivo**: [content.js](../VEO%20Automation/content.js)

```javascript
// ═══════════════════════════════════════════════════════════
// TÉCNICA: Builder de Nombres Dinámicos
// ═══════════════════════════════════════════════════════════

function buildFileName(stt, promptText, ext = 'mp4', autoRename = false) {
  const pad = String(stt).padStart(2, '0');
  const dotExt = '.' + (ext || 'mp4');
  
  if (!autoRename) {
    return pad + dotExt;  // 01.mp4
  }
  
  // Slugify con soporte UTF-8
  const slug = (promptText || '')
    .normalize('NFD')                           // Descompone caracteres acentuados
    .replace(/[\u0300-\u036f]/g, '')           // Elimina marcas diacríticas
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')              // Solo alfanuméricos
    .trim()
    .replace(/\s+/g, '-')                       // Espacios → guiones
    .replace(/-+/g, '-')                        // Guiones múltiples → uno
    .slice(0, 30)                               // Máximo 30 chars
    .replace(/-$/, '');                         // Elimina guión final
  
  return pad + '_' + slug + dotExt;  // 01_cinematic-shot.mp4
}

// ═══════════════════════════════════════════════════════════
// TÉCNICA: Monitoreo de Progreso con XPath
// ═══════════════════════════════════════════════════════════

function monitorPopupProgress(groupId, promptIndex) {
  return new Promise((resolve) => {
    let attempts = 0;
    const progressXPath = "/html/body/div[1]/div[1]/div[1]/div[2]/div/div/div[2]/div[1]/div/div[1]/div[3]/div/div[1]/div";
    
    const interval = setInterval(() => {
      attempts++;
      if (attempts > 400) {
        clearInterval(interval);
        resolve(false);
        return;
      }
      
      // Evalúa XPath
      const progressEl = document.evaluate(
        progressXPath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      ).singleNodeValue;
      
      if (progressEl) {
        const text = progressEl.textContent.trim();
        const match = text.match(/(\d+)%/);
        
        if (match) {
          const percent = parseInt(match[1]);
          
          // Envía actualización
          chrome.runtime.sendMessage({
            action: "UPDATE_QUEUE_STATUS",
            groupId, index: promptIndex,
            status: `Rendering: ${percent}% 🚀`,
            percent
          }).catch(() => {});
          
          // Detecta completación
          if (percent >= 100) {
            clearInterval(interval);
            resolve(true);
          }
        }
      } else {
        // Fallback: Detecta si botón "Expand" reapareció
        const expandBtn = document.evaluate(
          "/html/body/div[1]/div[1]/div[1]/div[2]/div/div/div[2]/div[2]/div/div[2]/div/button[1]",
          document, null,
          XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue;
        
        if (attempts > 10 && expandBtn && isElementVisible(expandBtn) && !expandBtn.disabled) {
          clearInterval(interval);
          resolve(true);
        }
      }
    }, 100);  // Poll cada 100ms
  });
}

// ═══════════════════════════════════════════════════════════
// TÉCNICA: Helper para Visibility
// ═══════════════════════════════════════════════════════════

function isElementVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return rect.width > 0 &&
         rect.height > 0 &&
         style.display !== 'none' &&
         style.visibility !== 'hidden' &&
         style.opacity !== '0';
}

// ═══════════════════════════════════════════════════════════
// TÉCNICA: Request Trusted Click
// ═══════════════════════════════════════════════════════════

function requestTrustedClickAt(x, y) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({
        action: 'TRUSTED_CLICK_AT',
        x, y
      }, (resp) => {
        resolve(!!resp?.ok);
      });
    } catch (e) {
      resolve(false);
    }
  });
}
```

---

## 6. SHADOW DOM Y REACT INTERNALS

### 6.1 Detección de Shadow DOM en Auto Flow

Google Flow utiliza Shadow DOM para ciertos componentes (gallería, editor). Auto Flow detecta esto:

```javascript
// src/page/page-hook.js
function findElementInShadow(selector, root = document) {
  // Búsqueda plana
  const direct = root.querySelector(selector);
  if (direct) return direct;
  
  // Búsqueda en shadow DOM
  const traverse = (node) => {
    if (node.shadowRoot) {
      const inShadow = node.shadowRoot.querySelector(selector);
      if (inShadow) return inShadow;
      
      // Recursivo en shadow DOM
      for (const child of node.shadowRoot.querySelectorAll('*')) {
        const found = traverse(child);
        if (found) return found;
      }
    }
    return null;
  };
  
  for (const el of root.querySelectorAll('*')) {
    const found = traverse(el);
    if (found) return found;
  }
  
  return null;
}

// Uso
const composerInput = findElementInShadow('input[placeholder="Enter your prompt"]');
```

### 6.2 React Fiber Access

Google Flow es una aplicación React 18+. Auto Flow accede a componentes:

```javascript
// src/page/page-hook.js - Técnica avanzada

function getReactFiber(element) {
  const key = Object.keys(element).find(key => 
    key.startsWith('__react') && key.includes('Fiber')
  );
  return element[key];
}

function getReactComponent(element) {
  const fiber = getReactFiber(element);
  if (!fiber) return null;
  
  // Sube el árbol hasta encontrar el componente
  let current = fiber;
  while (current) {
    if (current.elementType && current.elementType.name) {
      return current;  // Componente funcional
    }
    if (current.type && current.type.name) {
      return current;  // Componente clase
    }
    current = current.return;  // Sube al padre
  }
  return null;
}

function getReactState(fiber) {
  if (!fiber) return null;
  
  // Hook state está en fiber.memoizedState
  let hookState = fiber.memoizedState;
  const state = {};
  let hookIndex = 0;
  
  while (hookState) {
    // Cada hook es un nodo linked list
    state[`hook_${hookIndex}`] = {
      memoized: hookState.memoizedState,
      queue: hookState.queue?.lastRenderedState,
      dependencies: hookState.dependencies
    };
    hookState = hookState.next;
    hookIndex++;
  }
  
  return state;
}

// Ejemplo: Obtiene el modelo seleccionado
function getCurrentModel() {
  const modelSelector = document.querySelector('[data-model-selector]');
  if (!modelSelector) return null;
  
  const fiber = getReactFiber(modelSelector);
  const state = getReactState(fiber);
  
  // El estado del selector está en hook_0
  return state?.hook_0?.memoized?.selectedModel;
}

// Dispara update sin React DevTools
function setReactState(element, newState) {
  const fiber = getReactFiber(element);
  if (!fiber?.memoizedState) return false;
  
  // Accede a hooks y dispara actualización
  let hooks = fiber.memoizedState;
  let hookIndex = 0;
  
  for (const [key, value] of Object.entries(newState)) {
    const hookNum = parseInt(key.replace('hook_', ''));
    let currentHook = fiber.memoizedState;
    for (let i = 0; i < hookNum && currentHook; i++) {
      currentHook = currentHook.next;
    }
    
    if (currentHook) {
      // Actualiza el estado
      currentHook.memoizedState = value;
      
      // Dispara re-render forzado
      // (Nota: Esta técnica es frágil, mejor usar eventos)
    }
  }
  
  return true;
}
```

### 6.3 React DevTools Hook Interception

Auto Flow podría detectar si React DevTools está activa:

```javascript
// Detección de React DevTools
function hasReactDevTools() {
  return window.__REACT_DEVTOOLS_GLOBAL_HOOK__ !== undefined;
}

// Acceso a instancias React
if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  
  // hook.renderers es Map de renderizadores activos
  for (const [id, renderer] of hook.renderers) {
    const roots = renderer._roots || [];
    for (const root of roots) {
      console.log("React root encontrada:", root);
    }
  }
}
```

---

## 7. APLICACIONES SPA

### 7.1 Detección de Cambios en React/Vue/Angular

Auto Flow monitorea cambios en Google Flow (React):

```javascript
// Método 1: URL Changes (History API)
function watchUrlChanges() {
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  
  history.pushState = function(...args) {
    recordEvent({ type: "history.pushState", url: args[2] });
    return originalPushState.apply(history, args);
  };
  
  history.replaceState = function(...args) {
    recordEvent({ type: "history.replaceState", url: args[2] });
    return originalReplaceState.apply(history, args);
  };
  
  window.addEventListener('popstate', (event) => {
    recordEvent({ type: "history.popstate", url: location.href });
  });
}

// Método 2: MutationObserver (DOM changes)
function watchDomChanges() {
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === 'childList') {
        recordEvent({
          type: "dom.mutated",
          added: mutation.addedNodes.length,
          removed: mutation.removedNodes.length
        });
      }
    });
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: false
  });
}

// Método 3: IntersectionObserver (elemento visible)
function watchGalleryRendering() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        recordEvent({
          type: "gallery.item.visible",
          id: entry.target.dataset.mediaId
        });
      }
    });
  }, { threshold: 0.5 });
  
  // Observa cada item de galería
  document.querySelectorAll('[data-media-id]').forEach(el => {
    observer.observe(el);
  });
}

// Método 4: Polling (fallback)
function pollForStateChanges(intervalMs = 1000) {
  let lastState = JSON.stringify(document.body.innerHTML).slice(0, 100);
  
  setInterval(() => {
    const currentState = JSON.stringify(document.body.innerHTML).slice(0, 100);
    if (currentState !== lastState) {
      recordEvent({ type: "dom.changed" });
      lastState = currentState;
    }
  }, intervalMs);
}
```

---

## 8. INYECCIÓN DE CÓDIGO

### 8.1 Métodos de Inyección en Auto Flow

#### Método 1: Content Script Estático (document_start)
```json
"content_scripts": [{
  "js": ["src/content/page-bridge.js"],
  "run_at": "document_start"  // ← TEMPRANO
}]
```
**Ventaja**: Ejecuta antes de scripts de página  
**Desventaja**: Limitado a APIs de content script

#### Método 2: Inyección Dinámica via chrome.scripting
```javascript
// En service-worker.js
if (runtimeState.queueRunning) {
  await chrome.scripting.executeScript({
    target: { tabId: runtimeState.activeTabId },
    func: () => {
      // Código ejecutado en contexto de página
      window.__afDebugContext = true;
    }
  });
}
```

#### Método 3: Page Hook Inyectado (web_accessible_resources)
```javascript
// En content script
function injectPageHook() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/page/page-hook.js");
  script.async = false;
  (document.documentElement || document.head).appendChild(script);
}
```
**Ventaja**: Código en contexto de página (acceso a window global)  
**Desventaja**: Sin acceso a APIs de Chrome

#### Método 4: Inyección de Datos (web_accessible_resources)
```json
"web_accessible_resources": [{
  "matches": ["https://labs.google/*"],
  "resources": ["src/page/page-hook.js", "data/config.json"]
}]
```

### 8.2 Técnica: Page Hook ↔ Content Script Bridge

```
Page Hook (contexto página)
   ↓ window.postMessage()
   ↑ window.addEventListener('message')
Content Script (contexto extensión)
   ↓ chrome.runtime.sendMessage()
   ↑ chrome.runtime.onMessage
Service Worker (fondo)
```

**Implementación Robusta**:
```javascript
// src/page/page-hook.js
const pending = new Map();

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data.source !== "page-hook") return;
  
  const { requestId, command, payload } = event.data;
  
  if (event.data.type === 'RESPONSE') {
    const resolver = pending.get(requestId);
    if (resolver) {
      pending.delete(requestId);
      resolver(event.data.response);
    }
  }
});

function sendToContent(command, payload = {}) {
  const requestId = crypto.randomUUID();
  
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("Page hook timeout"));
    }, 10000);
    
    pending.set(requestId, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
    
    window.postMessage({
      source: "page-hook",
      type: 'COMMAND',
      requestId,
      command,
      payload
    }, "*");
  });
}

// Uso
const result = await sendToContent("fillPrompt", {
  text: "Cinematic shot of a cat"
});
```

---

## 9. COMUNICACIÓN ENTRE SCRIPTS

### 9.1 Auto Flow Message Map

```javascript
// src/core/contracts/messages.js
export const MessageType = Object.freeze({
  // Bridge health checks
  BridgeHealth: "af.rebuild.bridge.health",
  BridgeHealthV2: "af.rebuild.bridge.health.v2",
  BridgeHealthV3: "af.rebuild.bridge.health.v3",
  BridgeHealthV4: "af.rebuild.bridge.health.v4",
  
  // Page events from hook
  PageEvent: "af.rebuild.page.event",
  PageCommand: "af.rebuild.page.command",
  PageCommandV2: "af.rebuild.page.command.v2",
  PageCommandV3: "af.rebuild.page.command.v3",
  PageCommandV4: "af.rebuild.page.command.v4",
  PageCommandResult: "af.rebuild.page.command.result",
  
  // Queue management
  QueueAddJob: "af.rebuild.queue.addJob",
  QueueStart: "af.rebuild.queue.start",
  QueueResume: "af.rebuild.queue.resume",
  QueueStop: "af.rebuild.queue.stop",
  QueueClear: "af.rebuild.queue.clear",
  QueueRemove: "af.rebuild.queue.remove",
  
  // Media
  MediaUpload: "af.rebuild.media.upload",
  MediaDownload: "af.rebuild.media.download",
  
  // Auth
  AuthCommand: "af.rebuild.auth.command",
  AuthState: "af.rebuild.auth.state",
  
  // Settings
  SettingsRead: "af.rebuild.settings.read",
  SettingsWrite: "af.rebuild.settings.write",
  
  // Gallery
  GalleryRefresh: "af.rebuild.gallery.refresh"
});
```

### 9.2 Flujo de Mensajes Completo

```
┌─────────────────────────────────────────────────────────────────┐
│ USER ACTION: Presiona "Start Queue"                             │
│ Location: gateway.html (Side Panel)                             │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ MESSAGE: QueueStart                                             │
│ From: gateway.js                                                │
│ To: service-worker.js                                           │
│ Payload: { projectId, tasks: [...] }                            │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ SERVICE WORKER: Inicia scheduler loop                           │
│ setInterval(() => {                                             │
│   task = ledger.getNextPending()                                │
│   executor.execute(task)                                        │
│ }, 500)                                                         │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ MESSAGE: PageCommand (v4)                                       │
│ From: service-worker.js                                         │
│ To: page-bridge.js (content script)                             │
│ Payload: { cmd: "fillPrompt", text: "...", model: "..." }      │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ CONTENT SCRIPT: Recibe comando                                  │
│ requestPageHook(payload)                                        │
│   → window.postMessage()                                        │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ PAGE HOOK: Inyectado en página                                  │
│ window.addEventListener('message')                              │
│   → document.querySelector('input').value = text               │
│   → dispatchEvent(new Event('input', { bubbles: true }))        │
│   → responde con PageCommandResult                              │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ PAGE HOOK → CONTENT SCRIPT: PageCommandResult                   │
│ window.postMessage({ requestId, response })                     │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ CONTENT SCRIPT → SERVICE WORKER: PageCommandResult              │
│ chrome.runtime.sendMessage(message)                             │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ SERVICE WORKER: Actualiza task state                            │
│ ledger.updateTask(taskId, { status: 'generating', ... })        │
│ recordEvent({ type: 'task.submitted' })                         │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ MESSAGE: PageEvent                                              │
│ From: page-hook.js (periodically)                               │
│ Payload: { mediaIds: [...], status: 'generating' }              │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ FINAL: Task completes                                           │
│ Media downloaded, result stored, UI updated                     │
│ Next task starts automatically                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 9.3 Gemini Automator Message Flow (Simplificado)

```
User Popup
   ↓ chrome.runtime.sendMessage({ action: "START" })
   ↓
Service Worker
   ↓ chrome.runtime.onMessage
   ↓
Content Script
   ├─ insertPrompt() [DOM manipulation]
   ├─ waitForGeneration() [polling]
   ├─ findAndDownloadImage() [fetch or msg]
   └─ chrome.runtime.sendMessage({ action: "download" })
   ↓
Service Worker
   ├─ chrome.downloads.download()
   ├─ chrome.downloads.onChanged listener
   └─ Confirmation message
```

---

## 10. INTERCEPTACIÓN DE RED

### 10.1 Auto Flow - Intercepción de Fetch

Google Flow usa Fetch API. Auto Flow intercepta en el page hook:

```javascript
// src/page/page-hook.js
const originalFetch = window.fetch;
window.__afRebuildNativeFetch = originalFetch;

window.fetch = function(resource, init) {
  const url = typeof resource === 'string' ? resource : resource.url;
  
  // Log de requests
  console.log("[Flow] Fetch:", url);
  
  // Registra outgoing requests
  if (url.includes('/submitText2Video') || url.includes('/getStatus')) {
    recordEvent({
      type: "api.request",
      endpoint: url,
      method: init?.method || 'GET',
      timestamp: Date.now()
    });
  }
  
  // Retorna promesa original pero con interception
  return originalFetch.apply(this, arguments)
    .then(async response => {
      // Captura respuesta
      const contentType = response.headers.get('content-type');
      
      if (contentType?.includes('application/json')) {
        const cloned = response.clone();
        const data = await cloned.json();
        
        // Busca media IDs
        if (data.media || data.operations) {
          recordEvent({
            type: "api.response",
            endpoint: url,
            mediaIds: extractMediaIds(data),
            status: response.status
          });
        }
      }
      
      return response;
    })
    .catch(error => {
      recordEvent({
        type: "api.error",
        endpoint: url,
        error: error.message
      });
      throw error;
    });
};
```

### 10.2 Interceptación de XMLHttpRequest

Algunas APIs legacy usan XHR:

```javascript
// src/page/page-hook.js
const OriginalXHR = window.XMLHttpRequest;
window.__afRebuildNativeXMLHttpRequest = OriginalXHR;

window.XMLHttpRequest = class extends OriginalXHR {
  open(method, url, ...args) {
    this.__autoflowMethod = method;
    this.__autoflowUrl = url;
    return super.open(method, url, ...args);
  }
  
  send(body) {
    recordEvent({
      type: "xhr.request",
      method: this.__autoflowMethod,
      url: this.__autoflowUrl,
      bodySize: typeof body === 'string' ? body.length : 0
    });
    
    const originalOnLoad = this.onload;
    this.onload = function() {
      if (this.status === 200) {
        try {
          const data = JSON.parse(this.responseText);
          recordEvent({
            type: "xhr.response",
            status: 200,
            mediaIds: extractMediaIds(data)
          });
        } catch (e) {}
      }
      return originalOnLoad?.call(this);
    };
    
    return super.send(body);
  }
};
```

### 10.3 Captura de Tokens en Requests

```javascript
// src/page/page-hook.js
const originalFetch = window.fetch;

window.fetch = function(resource, init) {
  const headers = init?.headers || {};
  
  // Extrae token de autorización
  const authHeader = headers['Authorization'] || 
                     headers['authorization'] || 
                     headers['x-access-token'];
  
  if (authHeader) {
    recordEvent({
      type: "auth.token.captured",
      tokenType: authHeader.split(' ')[0],
      tokenLength: authHeader.length,
      timestamp: Date.now()
    });
  }
  
  return originalFetch.apply(this, arguments);
};
```

---

## 11. APIs ESPECIALES DE CHROME

### 11.1 chrome.debugger (Auto Flow)

Auto Flow usa `chrome.debugger` para:
1. Capturar eventos de página
2. Evaluar JavaScript remoto
3. Manipular DOM desde service worker

```javascript
// src/background/debugger-engine.js
import { extractMediaIds } from "../core/media/flow-client.js";

const debuggerSessions = new Map();

async function attachDebugger(tabId) {
  const target = { tabId: Number(tabId) };
  
  try {
    await chrome.debugger.attach(target, "1.3");  // Protocolo 1.3
    
    // Instala listener para eventos
    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (source.tabId !== tabId) return;
      
      if (method === "Network.responseReceived") {
        // Captura respuesta de red
        recordEvent({
          type: "debugger.network.response",
          url: params.response.url,
          status: params.response.status
        });
      }
      
      if (method === "DOM.documentUpdated") {
        // DOM cambió
        recordEvent({ type: "debugger.dom.updated" });
      }
    });
    
    debuggerSessions.set(tabId, { attached: true });
    return true;
  } catch (error) {
    console.error("Debugger attach failed:", error);
    return false;
  }
}

async function sendDebuggerCommand(tabId, method, params = {}) {
  const target = { tabId: Number(tabId) };
  
  try {
    return await chrome.debugger.sendCommand(target, method, params);
  } catch (error) {
    console.error(`Debugger command failed: ${method}`, error);
    throw error;
  }
}

// Ejemplo: Evalúa JavaScript en la página
async function evaluateInPage(tabId, code) {
  return sendDebuggerCommand(tabId, "Runtime.evaluate", {
    expression: code,
    returnByValue: true
  });
}

// Ejemplo: Obtiene estructura del DOM
async function getDomTree(tabId) {
  return sendDebuggerCommand(tabId, "DOM.getDocument", {});
}

// Uso en executor
async function submitTaskWithDebugger(task) {
  const tabId = runtimeState.activeTabId;
  
  // Evalúa JS para obtener estado actual
  const stateCode = `
    window.__flowState = {
      selectedModel: document.querySelector('[data-model]')?.value,
      promptValue: document.querySelector('input[type="text"]')?.value,
      isGenerating: !!document.querySelector('[data-generating]')
    };
    window.__flowState;
  `;
  
  const result = await evaluateInPage(tabId, stateCode);
  console.log("Flow state:", result.result.value);
  
  // Prosigue con ejecución
}
```

### 11.2 chrome.scripting (Dynamic Execution)

```javascript
// En service-worker si necesita inyección dinámica
async function executeScriptInTab(tabId, func, args = []) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });
}

// Ejemplo
async function findElementInTab(tabId, selector) {
  const results = await executeScriptInTab(
    tabId,
    (sel) => {
      const el = document.querySelector(sel);
      return el ? {
        text: el.textContent,
        visible: el.offsetParent !== null,
        rect: el.getBoundingClientRect()
      } : null;
    },
    [selector]
  );
  
  return results[0]?.result;
}
```

### 11.3 chrome.storage (Persistencia)

Auto Flow usa múltiples keys:

```javascript
const QUEUE_STORAGE_KEY = "autoflow-10767-rebuild-queue-ledger";
const RUNTIME_BINDING_STORAGE_KEY = "autoflow-1080-runtime-binding";
const DOM_DEBUGGER_TRACE_STORAGE_KEY = "autoflow-1081-dom-debugger-trace";

// Guardar estado
async function persistQueueState() {
  const tasks = ledger.getAllTasks();
  await chrome.storage.local.set({
    [QUEUE_STORAGE_KEY]: {
      tasks,
      projectId: runtimeState.projectId,
      savedAt: new Date().toISOString()
    }
  });
}

// Restaurar estado
async function restoreQueueFromStorage() {
  const data = await chrome.storage.local.get(QUEUE_STORAGE_KEY);
  if (data[QUEUE_STORAGE_KEY]) {
    const { tasks } = data[QUEUE_STORAGE_KEY];
    tasks.forEach(task => ledger.addTask(task));
    return true;
  }
  return false;
}

// Limpiar datos
async function clearStorageOnLogout() {
  await chrome.storage.local.remove([
    QUEUE_STORAGE_KEY,
    RUNTIME_BINDING_STORAGE_KEY,
    DOM_DEBUGGER_TRACE_STORAGE_KEY
  ]);
}
```

### 11.4 chrome.tabs (Control de Pestañas)

```javascript
// Detecta cambios de URL
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url?.includes('labs.google')) {
    recordEvent({
      type: "tab.loaded",
      tabId,
      url: tab.url
    });
    
    // Reestablece conexión con bridge
    chrome.tabs.sendMessage(tabId, {
      type: "af.rebuild.bridge.health"
    }).catch(() => {});
  }
});

// Crea nueva pestaña para login
async function openLoginTab() {
  return chrome.tabs.create({
    url: "https://labs.google.com/fx/tools/flow/projects"
  });
}
```

### 11.5 chrome.webNavigation (Navegación)

```javascript
// Detecta si usuario abandonó Google Flow
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.tabId === runtimeState.activeTabId) {
    if (!details.url.includes('labs.google')) {
      recordEvent({
        type: "tab.left.google-flow",
        newUrl: details.url
      });
      
      // Pausa queue automáticamente
      if (runtimeState.queueRunning) {
        pauseQueue();
      }
    }
  }
});
```

### 11.6 chrome.sidePanel (Interfaz)

```javascript
// Auto Flow declara en manifest
"side_panel": {
  "default_path": "src/gateway/gateway.html"
}

// Puede abrir panel desde content script
chrome.sidePanel.open({ tabId: activeTabId });

// Listener para cuando panel abre/cierra
chrome.sidePanel.onShown.addListener((tabId) => {
  recordEvent({ type: "sidePanel.opened", tabId });
});
```

---

## 12. AUTOMATIZACIÓN AVANZADA

### 12.1 Detección Inteligente de Carga

Auto Flow detecta cuando Google Flow está completamente cargado:

```javascript
// src/page/page-hook.js

async function waitForPageReady(timeoutMs = 30000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const checks = {
      // React está lista
      reactReady: !!window.__REACT_DEVTOOLS_GLOBAL_HOOK__,
      
      // Composer input visible
      composerReady: !!document.querySelector('[data-composer] input'),
      
      // Model selector visible
      modelReady: !!document.querySelector('[data-model-selector]'),
      
      // Gallery cargada
      galleryReady: document.querySelectorAll('[data-media-item]').length > 0,
      
      // No hay spinners
      notLoading: !document.querySelector('[data-spinner]'),
      
      // Network tranquilo (heurística)
      networkQuiet: !performance.getEntriesByType('resource')
        .some(r => r.duration > 5000)
    };
    
    // Requiere múltiples checks
    const readyCount = Object.values(checks).filter(Boolean).length;
    if (readyCount >= 5) {
      return true;
    }
    
    await new Promise(r => setTimeout(r, 500));
  }
  
  return false;
}
```

### 12.2 Simulación Humana

```javascript
// Delays aleatorios entre acciones
function randomDelay(min = 300, max = 1000) {
  return new Promise(resolve => {
    const delay = Math.random() * (max - min) + min;
    setTimeout(resolve, delay);
  });
}

// Typing humano (carácter por carácter)
async function humanTypeText(element, text) {
  element.focus();
  
  for (const char of text) {
    element.value += char;
    
    // Dispara eventos como si fuera usuario
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    
    // Delay entre caracteres (simula typing)
    await randomDelay(30, 100);
  }
}

// Click humano (pequeño delay antes de activar)
async function humanClick(element) {
  await randomDelay(100, 300);
  
  // Simula movimiento del ratón
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  
  element.dispatchEvent(new MouseEvent('mouseover', {
    bubbles: true,
    clientX: x,
    clientY: y
  }));
  
  await randomDelay(50, 150);
  
  element.dispatchEvent(new MouseEvent('mousedown', {
    bubbles: true,
    clientX: x,
    clientY: y
  }));
  
  await randomDelay(50, 100);
  
  element.dispatchEvent(new MouseEvent('mouseup', {
    bubbles: true,
    clientX: x,
    clientY: y
  }));
  
  element.click();
}
```

### 12.3 Esperas Inteligentes

```javascript
// Espera hasta que elemento esté visible
async function waitForVisible(selector, timeoutMs = 10000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const el = document.querySelector(selector);
    if (el && isVisible(el)) {
      return el;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  
  throw new Error(`Timeout waiting for ${selector}`);
}

// Espera a que elemento desaparezca (generación terminó)
async function waitForHidden(selector, timeoutMs = 120000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const el = document.querySelector(selector);
    if (!el || !isVisible(el)) {
      return true;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  
  throw new Error(`Timeout waiting for ${selector} to hide`);
}

// Espera a que texto cambie (generación progresando)
async function waitForTextChange(selector, timeoutMs = 120000) {
  const startTime = Date.now();
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  
  const initialText = el.textContent;
  let lastText = initialText;
  let unchangedMs = 0;
  
  while (Date.now() - startTime < timeoutMs) {
    const currentText = el.textContent;
    
    if (currentText !== lastText) {
      unchangedMs = 0;  // Reset counter
      lastText = currentText;
    } else {
      unchangedMs += 100;
    }
    
    // Si texto cambió desde el inicio → probablemente generando
    if (currentText !== initialText) {
      return currentText;
    }
    
    await new Promise(r => setTimeout(r, 100));
  }
  
  throw new Error(`Text in ${selector} didn't change`);
}
```

### 12.4 Sistema de Reintentos

```javascript
// Exponential backoff
async function retryWithBackoff(
  fn,
  maxAttempts = 5,
  initialDelayMs = 1000
) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (attempt < maxAttempts) {
        const delay = initialDelayMs * Math.pow(2, attempt - 1);
        const jitter = Math.random() * 0.1 * delay;
        console.log(`Attempt ${attempt} failed, retrying in ${delay}ms`);
        
        await new Promise(r => setTimeout(r, delay + jitter));
      }
    }
  }
  
  throw lastError;
}

// Uso
const result = await retryWithBackoff(async () => {
  const el = document.querySelector('[data-media-output]');
  if (!el) throw new Error("Media output not found");
  return el.src;
}, 5, 1000);
```

---

## 13. ANTI-REACT / ANTI-SHADOW DOM

### 13.1 Estrategias contra Cambios de Selectores

```javascript
// Estrategia 1: Múltiples selectores (resistencia)
function findInputElement() {
  return document.querySelector(
    'input[placeholder*="prompt"]' +  // Opción 1
    ',' +
    'textarea[data-composer]' +       // Opción 2
    ',' +
    '[role="textbox"][contenteditable]' +  // Opción 3
    ',' +
    '.composer-input'                 // Opción 4
  );
}

// Estrategia 2: Búsqueda por atributos data-*
function findByDataAttr(attrName, attrValue) {
  return document.querySelector(`[data-${attrName}="${attrValue}"]`) ||
         document.querySelector(`[data-${attrName}*="${attrValue}"]`);
}

// Estrategia 3: Búsqueda por arbol
function findParentByClass(el, className) {
  let current = el;
  while (current && !current.classList.contains(className)) {
    current = current.parentElement;
  }
  return current;
}

// Estrategia 4: React Fiber fallback
function findReactComponentByName(componentName) {
  const allElements = document.querySelectorAll('*');
  for (const el of allElements) {
    const fiber = getReactFiber(el);
    if (fiber?.type?.name === componentName) {
      return el;
    }
  }
  return null;
}
```

### 13.2 Resistencia a Shadow DOM

```javascript
// Traversal seguro
function findElementDeep(selector, root = document) {
  // Búsqueda normal
  const normal = root.querySelector(selector);
  if (normal) return normal;
  
  // Búsqueda en shadow roots
  const walk = (node, depth = 0) => {
    if (depth > 10) return null;  // Evita infinito
    
    if (node.shadowRoot) {
      const inShadow = node.shadowRoot.querySelector(selector);
      if (inShadow) return inShadow;
      
      // Recursivo
      for (const child of node.shadowRoot.querySelectorAll('*')) {
        const found = walk(child, depth + 1);
        if (found) return found;
      }
    }
    
    for (const child of node.querySelectorAll('*')) {
      const found = walk(child, depth + 1);
      if (found) return found;
    }
    
    return null;
  };
  
  return walk(root);
}

// Acceso a text en shadow DOM
function getAllText(element = document.documentElement) {
  let text = element.textContent || '';
  
  if (element.shadowRoot) {
    text += getAllText(element.shadowRoot);
  }
  
  for (const child of element.children || []) {
    text += getAllText(child);
  }
  
  return text;
}
```

### 13.3 Resistencia a React Internals

```javascript
// Detecta re-renders y reacciona
function watchReactUpdates(componentName) {
  // Intercepta setState
  const originalSetState = React.Component.prototype.setState;
  
  React.Component.prototype.setState = function(state, callback) {
    console.log(`[React] ${this.constructor.name} updating state`);
    
    if (this.constructor.name === componentName) {
      recordEvent({
        type: "react.component.updated",
        component: componentName,
        newState: state
      });
    }
    
    return originalSetState.call(this, state, callback);
  };
}

// Usa React DevTools hook
function getReactInstances(componentName) {
  if (!window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return [];
  
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const instances = [];
  
  for (const [id, renderer] of hook.renderers) {
    const roots = renderer._roots || [];
    
    const traverse = (fiber) => {
      if (fiber.type?.name === componentName) {
        instances.push(fiber);
      }
      if (fiber.child) traverse(fiber.child);
      if (fiber.sibling) traverse(fiber.sibling);
    };
    
    roots.forEach(root => traverse(root._internalRoot?.current));
  }
  
  return instances;
}
```

---

## 14. PATRONES REUTILIZABLES

### 14.1 Básico

#### Storage Helper
```javascript
const StorageHelper = {
  async get(key, defaultValue = null) {
    const data = await chrome.storage.local.get([key]);
    return data[key] ?? defaultValue;
  },
  
  async set(key, value) {
    return chrome.storage.local.set({ [key]: value });
  },
  
  async remove(key) {
    return chrome.storage.local.remove([key]);
  }
};

// Uso
const projectId = await StorageHelper.get('projectId');
await StorageHelper.set('queue', []);
```

#### Message Helper
```javascript
const MessagesHelper = {
  async send(tabId, message) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      console.error("Message send failed:", error);
      return null;
    }
  },
  
  onMessage(callback) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      callback(message, sender, sendResponse);
      return true;  // Keep channel open
    });
  }
};

// Uso
MessagesHelper.onMessage((msg, sender, respond) => {
  if (msg.type === 'GET_STATE') {
    respond({ state: runtimeState });
  }
});
```

### 14.2 Intermedio

#### Task Queue Manager
```javascript
class TaskQueue {
  constructor(concurrency = 1) {
    this.queue = [];
    this.running = [];
    this.concurrency = concurrency;
  }
  
  async add(task) {
    return new Promise((resolve) => {
      this.queue.push({ task, resolve });
      this.process();
    });
  }
  
  async process() {
    while (this.running.length < this.concurrency && this.queue.length > 0) {
      const { task, resolve } = this.queue.shift();
      const promise = this.executeTask(task);
      this.running.push(promise);
      
      promise.finally(() => {
        this.running = this.running.filter(p => p !== promise);
        this.process();
      });
      
      promise.then(resolve);
    }
  }
  
  async executeTask(task) {
    try {
      return await task();
    } catch (error) {
      console.error("Task failed:", error);
      throw error;
    }
  }
}

// Uso
const queue = new TaskQueue(3);  // 3 tareas concurrentes
await Promise.all([
  queue.add(() => submitPrompt1()),
  queue.add(() => submitPrompt2()),
  queue.add(() => submitPrompt3())
]);
```

#### Logger with Levels
```javascript
class Logger {
  constructor(namespace = 'Extension') {
    this.namespace = namespace;
    this.logs = [];
  }
  
  log(level, message, data = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      namespace: this.namespace,
      message,
      data
    };
    
    this.logs.push(entry);
    
    // Tambien a consola
    const style = {
      'DEBUG': 'color: gray',
      'INFO': 'color: blue',
      'WARN': 'color: orange',
      'ERROR': 'color: red'
    };
    
    console.log(
      `%c[${this.namespace}]`,
      style[level] || 'color: black'
    );
    console.log(message, data);
  }
  
  debug(msg, data) { this.log('DEBUG', msg, data); }
  info(msg, data) { this.log('INFO', msg, data); }
  warn(msg, data) { this.log('WARN', msg, data); }
  error(msg, data) { this.log('ERROR', msg, data); }
  
  async exportLogs() {
    const blob = new Blob(
      [JSON.stringify(this.logs, null, 2)],
      { type: 'application/json' }
    );
    return URL.createObjectURL(blob);
  }
}

// Uso
const logger = new Logger('AutoFlow');
logger.info("Queue started", { taskCount: 5 });
logger.error("API failed", { status: 429, retryAfter: 60 });
```

### 14.3 Avanzado

#### State Machine para Tareas
```javascript
class TaskStateMachine {
  constructor(task) {
    this.task = task;
    this.state = 'PENDING';
    this.history = [];
    this.handlers = {};
  }
  
  on(event, handler) {
    this.handlers[event] = handler;
  }
  
  async transition(newState, data = {}) {
    const oldState = this.state;
    this.state = newState;
    this.history.push({
      from: oldState,
      to: newState,
      timestamp: Date.now(),
      data
    });
    
    const handler = this.handlers[newState];
    if (handler) {
      try {
        await handler(data);
      } catch (error) {
        this.transition('FAILED', { error: error.message });
      }
    }
  }
  
  getState() {
    return {
      current: this.state,
      history: this.history,
      task: this.task
    };
  }
}

// Uso
const stateMachine = new TaskStateMachine({ prompt: "..." });

stateMachine.on('SUBMITTING', async (data) => {
  await submitToAPI(data);
});

stateMachine.on('GENERATING', async (data) => {
  await waitForCompletion(data);
});

stateMachine.on('COMPLETE', async (data) => {
  await downloadMedia(data);
});

await stateMachine.transition('SUBMITTING', { ...task });
```

#### Circuit Breaker Pattern
```javascript
class CircuitBreaker {
  constructor(fn, { failureThreshold = 5, resetTimeout = 60000 } = {}) {
    this.fn = fn;
    this.state = 'CLOSED';  // CLOSED, OPEN, HALF_OPEN
    this.failures = 0;
    this.failureThreshold = failureThreshold;
    this.resetTimeout = resetTimeout;
    this.nextAttemptTime = null;
  }
  
  async execute(...args) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttemptTime) {
        throw new Error('Circuit breaker is OPEN');
      }
      this.state = 'HALF_OPEN';
    }
    
    try {
      const result = await this.fn(...args);
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  onSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
  }
  
  onFailure() {
    this.failures++;
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttemptTime = Date.now() + this.resetTimeout;
    }
  }
}

// Uso
const breaker = new CircuitBreaker(callFlowAPI, {
  failureThreshold: 3,
  resetTimeout: 60000
});

try {
  const result = await breaker.execute(projectId, task);
} catch (error) {
  if (error.message.includes('Circuit breaker')) {
    logger.warn("API is down, queue paused");
  }
}
```

### 14.4 Experto

#### Choreography Pattern (Saga Distribuida)
```javascript
class TaskChoreography {
  constructor(task) {
    this.task = task;
    this.steps = [];
    this.completed = [];
    this.compensations = [];
  }
  
  addStep(name, execute, compensate) {
    this.steps.push({ name, execute, compensate });
  }
  
  async execute() {
    for (const step of this.steps) {
      try {
        console.log(`Executing: ${step.name}`);
        await step.execute(this.task);
        this.completed.push(step.name);
      } catch (error) {
        console.error(`Step failed: ${step.name}`, error);
        await this.compensate();
        throw error;
      }
    }
  }
  
  async compensate() {
    // Ejecuta compensaciones en orden inverso
    for (let i = this.completed.length - 1; i >= 0; i--) {
      const stepName = this.completed[i];
      const step = this.steps.find(s => s.name === stepName);
      
      if (step && step.compensate) {
        try {
          console.log(`Compensating: ${stepName}`);
          await step.compensate(this.task);
        } catch (error) {
          console.error(`Compensation failed: ${stepName}`, error);
        }
      }
    }
  }
}

// Uso
const chore = new TaskChoreography(task);

chore.addStep(
  'UPLOAD_REFERENCE',
  async (task) => {
    task.refImageId = await uploadImage(task.refImage);
  },
  async (task) => {
    await deleteImage(task.refImageId);
  }
);

chore.addStep(
  'SUBMIT_GENERATION',
  async (task) => {
    task.generationId = await submitGeneration(task);
  },
  async (task) => {
    await cancelGeneration(task.generationId);
  }
);

chore.addStep(
  'DOWNLOAD_RESULT',
  async (task) => {
    task.mediaUrl = await downloadMedia(task.generationId);
  },
  async (task) => {
    // No hay compensación para descarga
  }
);

try {
  await chore.execute();
} catch (error) {
  // Automáticamente compensa
}
```

---

## 15. SECRETOS DE INGENIERÍA AVANZADA

### 15.1 Versioning de Bridges (Anti-Breaking Changes)

Auto Flow usa versionado de protocolos:

```javascript
// Cada versión de mensaje tiene su propio tipo
const MessageType = {
  BridgeHealth: "af.rebuild.bridge.health",
  BridgeHealthV2: "af.rebuild.bridge.health.v2",
  BridgeHealthV3: "af.rebuild.bridge.health.v3",
  BridgeHealthV4: "af.rebuild.bridge.health.v4",  // ← Última
  
  PageCommand: "af.rebuild.page.command",
  PageCommandV2: "af.rebuild.page.command.v2",
  PageCommandV3: "af.rebuild.page.command.v3",
  PageCommandV4: "af.rebuild.page.command.v4",  // ← Última
};

// Service worker maneja múltiples versiones
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { type, payload } = request;
  
  if (type === MessageType.BridgeHealthV4) {
    // Lógica V4
    handleV4BridgeHealth(payload);
  } else if (type === MessageType.BridgeHealthV3) {
    // Fallback V3
    handleV3BridgeHealth(payload);
  } else if (type === MessageType.BridgeHealth) {
    // Fallback original
    handleV1BridgeHealth(payload);
  }
});

// Permite actualizar extensión sin breaking changes
```

### 15.2 DOM Debugger Trace para Auditoría

Auto Flow registra cada DOM interaction:

```javascript
function recordDebuggerTrace(task = {}, stage = "", detail = {}) {
  const at = new Date().toISOString();
  const entry = {
    at,
    type: "queue.dom.debugger.trace",
    taskId: task?.id || "",
    stage,  // front_submit_transition_accepted_without_media_ids, etc
    mode: task?.mode || "",
    prompt: String(task?.prompt || "").slice(0, 120),
    repeatCount: Number(task?.repeatCount || 1) || 1,
    videoLength: String(task?.videoLength || task?.videoDurationSeconds || ""),
    model: task?.model || "",
    aspectRatio: task?.aspectRatio || "",
    ...detail
  };
  
  // Almacena localmente
  recordEvent(entry);
  
  // También persiste en storage
  chrome.storage.local.get(DOM_DEBUGGER_TRACE_STORAGE_KEY).then((stored = {}) => {
    const prior = Array.isArray(stored[DOM_DEBUGGER_TRACE_STORAGE_KEY]) 
      ? stored[DOM_DEBUGGER_TRACE_STORAGE_KEY] 
      : [];
    
    return chrome.storage.local.set({
      [DOM_DEBUGGER_TRACE_STORAGE_KEY]: prior.concat(entry).slice(-80)  // Último 80
    });
  }).catch(() => {});
}

// Permite auditoría posterior de exactamente qué pasó en cada stage
```

### 15.3 Recovery Policy Taxonomy

```javascript
// Clasificación por severidad
const HARD_STOP_FAILURE_CLASSES = [
  "flow_model_daily_quota_reached",
  "flow_account_quota_reached",
  "flow_model_access_denied",
  "unsafe_generation_policy_block"
  // Estos NO reintenta, pausa queue
];

const SIDE_EFFECT_FAILURE_CLASSES = [
  "upload_not_settled_after_side_effect",
  "duplicate_upload_detected",
  "backend_accepted_but_visible_card_missing"
  // Estos requieren reconciliación especial
];

const DOM_VERIFICATION_FAILURE_CLASSES = [
  "api_first_quota_or_recaptcha_path_suspected",
  "dom_verification_composer_not_ready",
  "dom_verification_request_not_observed"
  // Estos pueden retry en DOM
];

// Matching automático
function classifyFailure(error) {
  const text = String(error?.message || error || "").toLowerCase();
  
  if (HARD_STOP_FAILURE_CLASSES.some(c => text.includes(c))) {
    return { recoverability: "hard_stop" };
  }
  
  if (SIDE_EFFECT_FAILURE_CLASSES.some(c => text.includes(c))) {
    return { recoverability: "side_effect", action: "reconcile" };
  }
  
  if (DOM_VERIFICATION_FAILURE_CLASSES.some(c => text.includes(c))) {
    return { recoverability: "retry", action: "dom_verify" };
  }
  
  return { recoverability: "unknown" };
}
```

### 15.4 FIFE URLs para Media Delivery

Google Flow usa FIFE (Fast Image Front End):

```javascript
// src/core/contracts/api.js
function buildMediaRedirectUrl(mediaId, options = {}) {
  // https://lh3.googleusercontent.com/[encoded_id]=s[size]-c
  // Permite resize dinámico sin re-encoding
  
  const size = options.size || 1000;
  const quality = options.quality || 90;
  
  return `https://lh3.googleusercontent.com/${mediaId}=s${size}-c-rj`;
}

function buildMediaThumbnailUrl(mediaId, size = 200) {
  return buildMediaRedirectUrl(mediaId, { size, quality: 80 });
}

// Uso en galería
async function loadGalleryThumbnails(mediaIds) {
  return mediaIds.map(id => ({
    id,
    thumbnail: buildMediaThumbnailUrl(id, 150),
    full: buildMediaRedirectUrl(id, 2000)
  }));
}
```

### 15.5 Continuity Chain para Referencia

Para video-to-video, Auto Flow mantiene cadena de referencia:

```javascript
// src/core/queue/continuity-chain.js
function buildContinuityRefPatch(previousVideo, currentTask) {
  // Si task anterior fue video, usar como referencia
  if (previousVideo?.mode?.includes('video')) {
    return {
      refInputs: [{
        mediaId: previousVideo.outputMediaIds[0],
        role: "inspiration"
      }],
      startRefInput: {
        mediaId: previousVideo.outputMediaIds[0],
        assetImageId: previousVideo.outputMediaIds[0]
      }
    };
  }
  
  return {};
}

// Permite "chains" de generación relacionadas
```

---

## 16. CÓMO RECREARLAS

### 16.1 MVP (2-3 días)

**Objetivo**: Extensión funcional que automatiza 1 sitio

```
📁 mv3-automation-mvp/
├── manifest.json
├── popup.html
├── popup.js
├── content.js
├── background.js
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

**manifest.json**:
```json
{
  "manifest_version": 3,
  "name": "Simple Automator",
  "version": "0.1",
  "permissions": ["activeTab", "storage", "downloads"],
  "host_permissions": ["https://target-site.com/*"],
  "background": { "service_worker": "background.js" },
  "action": { "default_popup": "popup.html" },
  "content_scripts": [{
    "js": ["content.js"],
    "matches": ["https://target-site.com/*"]
  }]
}
```

**popup.html**:
```html
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: sans-serif; padding: 10px; width: 300px; }
    input { width: 100%; padding: 5px; }
    button { width: 100%; padding: 10px; margin-top: 10px; }
  </style>
</head>
<body>
  <h3>Automation</h3>
  <textarea id="prompts" rows="5" placeholder="Line 1&#10;Line 2"></textarea>
  <button id="start">Start</button>
  <div id="status"></div>
  <script src="popup.js"></script>
</body>
</html>
```

**background.js** (30 líneas):
```javascript
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "start") {
    chrome.storage.local.set({ prompts: request.prompts, running: true });
    processNextItem();
  }
  if (request.action === "download") {
    chrome.downloads.download({ url: request.url });
  }
});

async function processNextItem() {
  const data = await chrome.storage.local.get(['prompts', 'running']);
  if (!data.running || !data.prompts.length) return;
  
  const item = data.prompts.shift();
  await chrome.storage.local.set({ prompts: data.prompts });
  
  // Envía a content script
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tabs[0].id, { action: "process", item });
  
  setTimeout(processNextItem, 2000);
}
```

**content.js** (40 líneas):
```javascript
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "process") {
    processItem(request.item);
  }
});

async function processItem(item) {
  // 1. Encuentra input
  const input = document.querySelector('input[type="text"]');
  if (!input) return;
  
  // 2. Escribe texto
  input.value = item;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  
  // 3. Presiona botón
  await new Promise(r => setTimeout(r, 500));
  const button = document.querySelector('button[type="submit"]');
  button.click();
  
  // 4. Espera resultado
  await waitForResult();
  
  // 5. Descarga
  const link = document.querySelector('a[download]');
  if (link) {
    chrome.runtime.sendMessage({ action: "download", url: link.href });
  }
}

async function waitForResult() {
  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      if (document.querySelector('.result-ready')) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 500);
  });
}
```

### 16.2 Versión Profesional (2 semanas)

**Objetivo**: Extensión robusta con estado, error handling, múltiples sitios

```
📁 mv3-automation-pro/
├── manifest.json
├── src/
│   ├── background/
│   │   ├── service-worker.js
│   │   ├── queue-manager.js
│   │   ├── recovery-engine.js
│   │   └── logger.js
│   ├── content/
│   │   ├── bridge.js
│   │   ├── selectors.js
│   │   └── dom-utils.js
│   ├── ui/
│   │   ├── popup.html
│   │   ├── popup.js
│   │   ├── panel.html
│   │   └── panel.js
│   └── shared/
│       ├── constants.js
│       ├── storage.js
│       └── messages.js
├── icons/
├── styles/
└── build/
    └── build.js
```

**package.json**:
```json
{
  "name": "mv3-automation-pro",
  "version": "1.0.0",
  "scripts": {
    "build": "node build/build.js",
    "dev": "npm run build && npm run watch",
    "watch": "nodemon --exec npm run build"
  },
  "devDependencies": {
    "esbuild": "^0.18.0"
  }
}
```

**Arquitectura de Clases**:
```javascript
// src/background/queue-manager.js
class QueueManager {
  constructor() {
    this.tasks = [];
    this.running = false;
  }
  
  async add(task) {
    this.tasks.push({
      id: crypto.randomUUID(),
      status: 'pending',
      ...task
    });
    await this.save();
  }
  
  async execute() {
    if (this.running) return;
    this.running = true;
    
    while (this.tasks.length > 0) {
      const task = this.tasks.find(t => t.status === 'pending');
      if (!task) break;
      
      task.status = 'running';
      await this.save();
      
      try {
        await this.executeTask(task);
        task.status = 'complete';
      } catch (error) {
        const recovery = new RecoveryEngine(task, error);
        const result = await recovery.tryRecover();
        
        if (result.recovered) {
          task.attempts = (task.attempts || 0) + 1;
          if (task.attempts < 5) {
            task.status = 'pending';
          } else {
            task.status = 'failed';
          }
        } else {
          task.status = 'failed';
          task.error = error.message;
        }
      }
      
      await this.save();
    }
    
    this.running = false;
  }
}
```

### 16.3 SaaS Escalable (1 mes)

**Objetivo**: Plataforma multi-usuario con backend

```
📁 automation-saas/
├── extension/               # Código MV3 (igual a "Pro")
├── backend/
│   ├── api/
│   │   ├── auth.ts
│   │   ├── tasks.ts
│   │   ├── webhooks.ts
│   │   └── analytics.ts
│   ├── database/
│   │   ├── models/
│   │   ├── migrations/
│   │   └── seeds/
│   ├── services/
│   │   ├── task-processor.ts
│   │   ├── automation-engine.ts
│   │   └── payment-service.ts
│   └── config.ts
├── web/
│   ├── app/
│   │   ├── dashboard/
│   │   ├── templates/
│   │   └── billing/
│   ├── components/
│   └── lib/
└── infrastructure/
    ├── docker-compose.yml
    ├── kubernetes/
    └── terraform/
```

**Stack Recomendado**:
- **Backend**: Node.js + Express/Fastify
- **Database**: PostgreSQL + Redis
- **Message Queue**: RabbitMQ o Bull
- **Frontend**: React 18 + TypeScript
- **DevOps**: Docker + Kubernetes
- **Payments**: Stripe
- **Monitoring**: DataDog / Sentry

**Flujo de Datos SaaS**:
```
┌─────────────────────────────────────┐
│ Extension (User's Browser)          │
│ ├─ Queue Management                 │
│ └─ Cloud Sync                       │
└─────────────────────────────────────┘
            ↓
┌─────────────────────────────────────┐
│ API Gateway (Cloud)                 │
│ ├─ Auth (JWT)                       │
│ ├─ Rate Limiting                    │
│ └─ Request Validation               │
└─────────────────────────────────────┘
            ↓
┌─────────────────────────────────────┐
│ Task Processor Service              │
│ ├─ Queue Manager (Bull)             │
│ ├─ Orchestrator                     │
│ └─ Result Storage                   │
└─────────────────────────────────────┘
            ↓
┌─────────────────────────────────────┐
│ Database                            │
│ ├─ Users                            │
│ ├─ Tasks                            │
│ ├─ Executions                       │
│ └─ Analytics                        │
└─────────────────────────────────────┘
```

---

## 17. LECCIONES APRENDIDAS

### 17.1 Técnicas Valiosas (COPIAR)

✅ **Message Versioning**
- Auto Flow mantiene compatibilidad backward con v1, v2, v3, v4
- Permite deployment sin breaking changes
- **Lección**: Siempre version tus protocolos

✅ **State Ledger Pattern**
- Task Ledger es una "single source of truth"
- Persistido en storage, recuperable
- **Lección**: No guardes estado solo en memory

✅ **Recovery Taxonomy**
- Clasificación de errores: hard_stop, recoverable, side_effect
- Políticas específicas por tipo
- **Lección**: No todos los errores requieren misma estrategia

✅ **Page Hook Injection**
- Inyecta código en contexto de página (acceso a window global)
- Pero mantiene aislamiento de security
- **Lección**: Mejor que manipular DOM crudamente

✅ **Debugger Integration**
- `chrome.debugger` para DevTools Protocol
- Captura network, ejecuta código remoto
- **Lección**: Desbloquea capabilities que content scripts no tienen

✅ **Exponential Backoff + Jitter**
- Reintenta con delays exponenciales + aleatoriedad
- Evita "thundering herd"
- **Lección**: No reintentar linealmente

### 17.2 Técnicas Obsoletas (EVITAR)

❌ **Hardcoded Selectors**
- Gemini Automator usa `document.querySelector('[data-testid="generating"]')`
- Se rompe si Google cambia estructura
- **Lección**: Usa múltiples selectores fallback

❌ **Simple Polling sin Detection**
- VEO Automation hace polling cada 100ms (400 intentos = 40 segundos)
- Ineficiente, consume batería
- **Lección**: Usa MutationObserver o eventos cuando sea posible

❌ **CSV en web_accessible_resources**
- Gemini expone CSV como recurso web
- Potencial security risk
- **Lección**: Usa chrome.storage para datos sensibles

❌ **Content Script sin Versionado**
- VEO Automation no verifica versión del content script
- Puede haber incompatibilidad tras update
- **Lección**: Implementa health checks

❌ **matches: ["<all_urls>"]**
- VEO Automation carga content.js en TODAS las páginas
- Rendimiento + seguridad
- **Lección**: Sé específico con host_permissions

### 17.3 Patrones para Copiar

| Patrón | Dónde | Razón |
|--------|-------|-------|
| **Task Ledger** | Auto Flow | Single source of truth |
| **Recovery Policy** | Auto Flow | Resiliente a fallos |
| **Message Versioning** | Auto Flow | Backward compatibility |
| **Page Hook Bridge** | Auto Flow | Aislamiento seguro |
| **DOM Debugger Trace** | Auto Flow | Auditoría post-mortem |
| **Circuit Breaker** | (Custom) | Protege contra cascadas |
| **Task State Machine** | (Custom) | Transiciones claras |
| **Queue Manager** | Gemini | Simple pero funciona |
| **Progress Monitoring** | VEO | XPath para UI updates |

### 17.4 Errores a Evitar

| Error | Causa | Solución |
|-------|-------|----------|
| Reintentos infinitos | Sin limit | `maxAttempts: 12` |
| Memory leak en listeners | No remove listeners | `.removeEventListener()` |
| Bloqueo del UI | Sync operations | `async/await` |
| CORS errors | Bad headers | Content script context |
| Rate limit ban | Requests demasiado rápido | Exponential backoff |
| Lost tasks en crash | No persistence | `chrome.storage.local` |
| Incompatibilidad React | Acceso frágil a Fiber | Usa DevTools hook |
| Shadow DOM bypass fail | Busca plana | Traversal recursivo |

---

## 18. APIs PRIVILEGIADAS VS PÁGINA NORMAL

### ¿QUÉ PUEDE HACER ESTA EXTENSIÓN QUE NO PUEDE HACER UNA PÁGINA WEB?

#### 18.1 Auto Flow

**APIs Privilegiadas Usadas**:

| API | Capacidad | Página Web | Extensión |
|-----|-----------|-----------|-----------|
| **chrome.debugger** | Protocolo DevTools | ❌ | ✅ |
| **chrome.downloads** | Descarga automática | ❌ | ✅ |
| **chrome.storage** | Storage persistente ilimitado | ⚠️ (10MB) | ✅ |
| **chrome.cookies** | Lectura de cookies | ❌ | ✅ |
| **chrome.browsingData** | Limpia caché/localStorage | ❌ | ✅ |
| **chrome.tabs** | Control de pestañas | ❌ | ✅ |
| **chrome.scripting.executeScript** | Inyecta código dinámico | ❌ | ✅ |
| **chrome.sidePanel** | Panel lateral nativo | ❌ | ✅ |

#### **18.2 Qué Hace Auto Flow que Gemini NO Puede Hacer**

```javascript
// ❌ Una página web NO puede:

// 1. Evaluar código arbitrario en otra pestaña
await chrome.debugger.sendCommand(
  { tabId },
  "Runtime.evaluate",
  { expression: "window.mySecretData" }
);

// 2. Capturar TODAS las requests de red
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === "Network.responseReceived") {
    // Acceso a respuestas de red TODAS
  }
});

// 3. Manipular DOM de otra pestaña
await chrome.scripting.executeScript({
  target: { tabId },
  func: () => {
    document.body.innerHTML = "Hacked!";
  }
});

// 4. Limpiar automáticamente caché
await chrome.browsingData.remove(
  { since: Date.now() - 1000 },
  { cache: true, localStorage: true }
);

// 5. Descargar múltiples archivos sin interacción
chrome.downloads.download({
  url: "https://...",
  filename: "auto_name_12345.jpg"  // Sin "Save As"
});

// 6. Leer cookies de cualquier dominio
const cookies = await chrome.cookies.getAll({ domain: "google.com" });

// 7. Almacenar datos ilimitados
await chrome.storage.local.set({
  massive_dataset: Array(1000000).fill("data")  // Múltiples MB
});

// 8. Acceder a window global de página inyectando script
// Pero con aislamiento de seguridad
```

#### **18.3 Sobre Aplicaciones React como Gemini/ChatGPT**

Auto Flow podría hacer esto con page hook + debugger:

```javascript
// ❌ Una página web NORMAL (como Gemini) NO puede:

// 1. Acceder a estado React de componentes internos
const fiber = element.__reactFiberv13 || element.__reactProps$;
console.log("React state:", fiber.memoizedState);  // Acceso directo

// 2. Modificar props sin re-render visible
fiber.memoizedProps = { ...newProps };

// 3. Interceptar TODOS los calls a fetch (antes de ir a red)
window.fetch = function(...) {
  // Modifica request ANTES de enviarse
  // Una página normal ve solo después (response)
};

// 4. Capturar keystroke en input React
// Auto Flow puede hacer esto pero página web NO (violación de seguridad)

// 5. Ejecutar código en contexto de Service Worker
// El cual no ve DOM pero ve todas las network requests

// 6. Usar DevTools Protocol para:
//    - Pausar ejecución JS
//    - Inspeccionar memoria
//    - Capturar heaps
//    - Medir performance detalladamente

// 7. Controlar descarga automática sin parar navegación
chrome.downloads.download({
  url: mediaUrl,
  filename: "output.mp4"
  // Descarga en background, sin diálogo
});

// 8. Inyectar código en página antes de que se cargue
// run_at: "document_start" → corre ANTES de scripts de página
```

#### **18.4 Caso Práctico: Automatizar Gemini**

Una extensión puede hacer esto automáticamente:

```javascript
// PASO 1: Service Worker monitorea tab
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url.includes('gemini.google.com')) {
    // Tab cargó completamente
  }
});

// PASO 2: Content script inyecta comandos
window.postMessage({
  type: "SUBMIT_PROMPT",
  payload: { text: "Explica quantum computing" }
}, "*");

// PASO 3: Page hook (en contexto página) manipula React
const input = document.querySelector('[role="textbox"]');
input.value = "Quantum computing...";

// Dispara evento que React escucha
input.dispatchEvent(new Event('input', { bubbles: true }));
input.dispatchEvent(new KeyboardEvent('keydown', {
  key: 'Enter',
  code: 'Enter',
  keyCode: 13,
  bubbles: true
}));

// PASO 4: Service Worker espera respuesta
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'GENERATION_COMPLETE') {
    // Automáticamente descarga
    chrome.downloads.download({
      url: msg.imageUrl,
      filename: "gemini_output_1.jpg"
    });
  }
});

// PASO 5: Procesa siguiente prompt (queue)
// Sin interacción humana
```

#### **18.5 Por Qué chrome.debugger Es Overpowered**

```javascript
// Con chrome.debugger podría:

// 1. Capturar TODAS las requests/responses
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === "Network.responseReceived") {
    // params.response contiene TODA la respuesta
    // Incluyendo datos privados
  }
});

// 2. Pausar ejecución JavaScript
await chrome.debugger.sendCommand(target, "Debugger.pause");
// Ahora la página está congelada mientras extensión investiga

// 3. Evaluar código remoto
const result = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
  expression: "
    fetch('/api/get-private-data').then(r => r.json())
  "
});
// Ejecutó la petición EN la página (con su sesión)

// 4. Inspeccionar memoria completa
const snapshot = await chrome.debugger.sendCommand(target, "HeapProfiler.takeHeapSnapshot");
// Heap dump completo de la página

// 5. Evaluar antes de que JS sea ofuscado
// Puede interceptar en pasos muy tempranos
```

**Nota**: Todo esto es monitoreado por Chrome y requiere permisos explícitos en manifest. Las extensiones malintencionadas podrían en teoría:
- Capturar tokens de sesión
- Exfiltrar datos de la página
- Modificar cualquier interacción

**Defensa**: Chrome revisa extensiones antes de publicar, pero una extensión con estos permisos es fundamentalmente de riesgo alto.

---

## CONCLUSIONES FINALES

### Síntesis por Extensión

| Aspecto | Auto Flow | Gemini | Meta | VEO |
|---------|-----------|--------|------|-----|
| **Complejidad** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **Robustez** | Enterprise | MVP | Professional | Professional |
| **Recovery** | Avanzado | Básico | Moderado | Moderado |
| **Versionado** | V4 protocol | Ninguno | V1 | Ninguno |
| **DevTools** | Sí | No | No | No |
| **Escalabilidad** | Alta | Baja | Media | Media |
| **Seguridad** | Alta | Baja (CSV) | Media | Baja (<all_urls>) |

### Recomendaciones para Nuevos Proyectos

✅ **Implementar desde Día 1**:
1. State Ledger (Task Ledger)
2. Recovery Policy classifier
3. Message versioning
4. Health checks
5. DOM Debugger traces
6. Exponential backoff

✅ **Arquitectura Recomendada**:
```
├── Service Worker (orchestration)
├── Content Script (page access)
├── Page Hook (direct DOM manipulation)
├── Storage Layer (persistence)
└── UI (popup/panel)
```

✅ **DevTools Para Debugging**:
- `chrome://extensions/` → Enable developer mode
- Service Worker console
- Content script console (inject via page)
- Storage inspector

✅ **Testing**:
- Unit tests para parsers/clasificadores
- Integration tests para message flows
- Manual E2E en sitios reales
- Canary deployments

---

**Fin del Análisis Técnico**

Este documento cubre ~8,000 líneas de código original analizado.
Para preguntas sobre patrones específicos, revisar secciones 14-15.

