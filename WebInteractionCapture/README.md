# Web Interaction Capture - Extensión Universal MV3

## 🎯 Visión

**Web Interaction Capture** es una extensión Chrome MV3 profesional que actúa como un **analizador y generador de blueprints de automatización universal**. 

Captura **TODAS** las interacciones del usuario en cualquier sitio web y genera código automático para:
- Playwright
- Puppeteer  
- Chrome Extensions
- Automa
- Actiona

## 📊 Capacidades

### Interacciones Capturadas
- ✅ Click, Double Click, Right Click
- ✅ Mouse Events (enter, leave, move, hover)
- ✅ Touch Events (start, move, end, swipe)
- ✅ Keyboard Events (keydown, keyup, keypress)
- ✅ Form Events (focus, blur, input, change, submit)
- ✅ Clipboard (copy, cut, paste)
- ✅ Drag & Drop
- ✅ Scroll, Wheel
- ✅ Zoom, Pinch

### Estrategias de Búsqueda

| Estrategia | Descripción | Ejemplo |
|-----------|-------------|---------|
| **CSS Selector** | Búsqueda estándar del DOM | `.button.primary` |
| **XPath** | Búsqueda avanzada | `//button[contains(@class, 'primary')]` |
| **Text Matching** | Buscar por texto visible | `//button[text()='Click me']` |
| **Data Attributes** | Buscar por atributos de test | `[data-testid="login-btn"]` |
| **ARIA/Role** | Accesibilidad | `[role="button"][aria-label="Submit"]` |
| **React Fiber** | Acceso a componentes React | Component name matching |
| **Shadow DOM** | Buscar dentro de Shadow Roots | `host >> .shadow-element` |

### Detección de Tecnologías

```javascript
{
  react: boolean,      // Detecta React + Fiber
  vue: boolean,        // Detecta Vue  
  angular: boolean,    // Detecta Angular
  shadowDOM: boolean,  // Detecta Shadow DOM abiertos
  webComponents: boolean, // Detecta Web Components
  iframe: boolean      // Detecta iframes
}
```

### Generación de Selectores Únicos

Para cada elemento, genera múltiples estrategias ordenadas por **estabilidad**:

1. **ID** (100% estable) - Más probable que no cambie
2. **Data-TestID** (95%) - Atributo de test
3. **Aria-Label** (85%) - Accesibilidad
4. **Role** (80%) - ARIA role
5. **ClassName** (60%) - Clases CSS
6. **Text Matching** (50%) - Buscar por texto
7. **XPath** (40%) - Last resort

## 🏗️ Arquitectura

```
WebInteractionCapture/
├── manifest.json                 # Configuración MV3
├── background.js                 # Service Worker
├── content.js                    # Content Script
│
├── src/
│   └── engines/
│       ├── recorder-engine.ts    # Grabación de interacciones
│       ├── selector-engine.ts    # Generación de selectores
│       ├── specialized-engines.ts
│       │   ├── ShadowDOMEngine
│       │   ├── ReactEngine
│       │   ├── NetworkEngine
│       │   ├── WaitDetectionEngine
│       │   └── FileTransferEngine
│       ├── export-engine.ts      # Exportación múltiple formato
│       └── page-bridge.ts        # Comunicación segura
│
├── popup/
│   ├── popup.html
│   └── popup.js
│
├── sidepanel/
│   ├── sidepanel.html
│   └── sidepanel.js
│
├── settings/
│   ├── settings.html
│   └── settings.js
│
└── images/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## 🎬 Flujo de Grabación

```
Usuario abre sitio
      ↓
Content Script inyectado
      ↓
Usuario clicks "Start Recording" (Popup)
      ↓
RecorderEngine inicializado + Observadores activados
      ↓
CADA evento → SelectorEngine genera selectores
            → ReactEngine detecta propiedades
            → ShadowDOMEngine chequea Shadow Roots
            → NetworkEngine intercepta requests
      ↓
Usuario realiza acciones (clicks, inputs, navegación)
      ↓
Toda interacción registrada con múltiples estrategias de búsqueda
      ↓
Usuario clicks "Stop Recording" + "Export"
      ↓
Markdown/JSON/CSV/YAML generado
      ↓
Descarga blueprint de automatización
```

## 🔧 Uso

### Instalación

1. Clone o descargar el código
2. Abre `chrome://extensions/`
3. Activa "Developer mode"
4. Click "Load unpacked"
5. Selecciona `/WebInteractionCapture/`

### Grabación Básica

```javascript
// En la extensión:
1. Abre popup (click en icono)
2. Click "Start Recording"
3. Realiza acciones en el sitio
4. Click "Stop Recording"
5. Click "Export Audit"
6. Elige formato (Markdown, JSON, CSV)
```

### Keyboard Shortcuts

```
Ctrl+Shift+R  → Toggle Recording
Ctrl+Shift+E  → Export Audit
Ctrl+Shift+P  → Open Side Panel
```

## 📋 Salida Markdown

```markdown
# Web Interaction Capture Audit

## Session Info
- **URL**: https://example.com
- **Start Time**: 2026-06-05T10:30:00Z
- **Duration**: 45000ms
- **Total Interactions**: 12

## Technologies Detected
- React
- Shadow DOM

## Interactions Captured (12)

### Interaction #1
- **Type**: click
- **Target**: button
- **Selector (CSS)**: `.btn.primary`
- **Selector (XPath)**: `//button[@class='btn primary']`
- **Selector Stability**: 85%
- **Aria Label**: Submit Form
- **React Detected**: Yes (SubmitButton)
- **Value**: N/A

### Interaction #2
...

## Automation Code

### Playwright
\`\`\`javascript
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('https://example.com');
  
  await page.click('.btn.primary'); // From interaction #1
  await page.fill('input#email', 'test@example.com');
  
  await browser.close();
})();
\`\`\`

### Puppeteer
\`\`\`javascript
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto('https://example.com');
  
  await page.click('.btn.primary');
  await page.type('input#email', 'test@example.com');
  
  await browser.close();
})();
\`\`\`

### Chrome Extension
\`\`\`javascript
chrome.tabs.query({active: true}, (tabs) => {
  chrome.tabs.sendMessage(tabs[0].id, {
    action: 'EXECUTE_ACTIONS',
    actions: [
      { type: 'click', selector: '.btn.primary' },
      { type: 'type', selector: 'input#email', text: 'test@example.com' }
    ]
  });
});
\`\`\`
```

## 🎨 Características Avanzadas

### 1. Multi-Estrategia de Selectores

Cada elemento genera automáticamente múltiples estrategias:

```javascript
{
  css: ".container > div.item:nth-child(2)",
  xpath: "//div[@class='container']/div[@class='item'][2]",
  unique: [
    "#unique-id",
    "[data-testid='item-2']",
    "[aria-label='Item Two']"
  ],
  stability: 92,
  aria: "Item Two",
  dataTestId: "item-2"
}
```

### 2. Shadow DOM Traversal

```typescript
ShadowDOMEngine.findInShadowDOM('button.primary');
// Busca en DOM normal + TODOS los shadow roots

ShadowDOMEngine.getShadowPath(element);
// Retorna: ["html > body > host-element (shadowRoot) > button"]
```

### 3. React Component Introspection

```typescript
ReactEngine.getComponentName(element);      // "SubmitButton"
ReactEngine.getComponentProps(element);     // {disabled: false, onClick: ...}
ReactEngine.getComponentState(element);     // [...state values]
ReactEngine.walkFiberTree(root, callback);  // Navegar árbol Fiber
```

### 4. Network Interception

Automáticamente captura:
- Fetch requests
- XHR requests
- WebSocket events
- GraphQL queries

```javascript
{
  method: "POST",
  url: "/api/users",
  status: 200,
  responseTime: 150,
  timestamp: 1623456789
}
```

### 5. Wait Detection Automática

```typescript
await WaitDetectionEngine.waitForElement('.modal', 5000);
await WaitDetectionEngine.waitForText('Success!', 3000);
await WaitDetectionEngine.waitForElementToDisappear('.loader', 5000);
await WaitDetectionEngine.waitForNetworkIdle(2000);
```

## 📈 Estadísticas Generadas

```json
{
  "totalInteractions": 45,
  "interactionTypes": {
    "click": 12,
    "input": 8,
    "scroll": 5,
    "hover": 3
  },
  "selectorStability": 87.5,
  "mostClickedElement": ".btn-submit",
  "mostChangedInput": "input#email",
  "technologies": {
    "react": true,
    "shadowDOM": true,
    "webComponents": false
  },
  "avgWaitTime": 450,
  "networkRequests": 23,
  "domMutations": 156
}
```

## 🚀 Casos de Uso

### 1. Automatización Web
Grabar acciones en cualquier sitio, generar código Playwright/Puppeteer

### 2. Testing
Generar test cases automáticos de E2E

### 3. RPA
Capturar procesos manuales, convertir a automáticos

### 4. API Documentation
Registrar todas las APIs llamadas durante interacciones

### 5. Reverse Engineering
Entender exactamente cómo funciona una app

### 6. Debugging
Auditoría completa de qué pasó durante una sesión

## 🔐 Privacidad & Seguridad

✅ **Sin servidor**: Todos los datos se procesan localmente  
✅ **Sin tracking**: No se envía información afuera  
✅ **Open source**: Código completamente transparente  
✅ **Aislamiento**: Content script separado del page context  

## 📦 Formatos de Exportación

### Markdown (.md)
- Legible por humanos
- Perfecta para documentación
- Incluye código automático

### JSON (.json)
- Estructura completa
- Importable en otros tools
- Para procesamiento programático

### CSV (.csv)
- Importable en Excel/Sheets
- Formato tabular
- Para análisis de datos

### YAML (.yaml)
- Formato Kubernetes
- Infraestructura como código
- Para CI/CD

## 🛠️ API Interna

### RecorderEngine

```typescript
const recorder = new RecorderEngine();
recorder.start();
// ... usuario realiza acciones ...
const session = recorder.stop();

session.interactions; // Array de interacciones
session.technologies; // Objeto con techs detectadas
```

### SelectorEngine

```typescript
const selectors = generateSelectorsFor(element);
// {
//   css: "...",
//   xpath: "...",
//   unique: [...],
//   stability: 90,
//   ...
// }
```

### Export Engine

```typescript
const markdown = generateMarkdownAudit(sessionData);
const json = JSON.stringify(sessionData);
const csv = convertToCSV(sessionData);
```

## 🎯 Roadmap

- [ ] Soporte para Automa
- [ ] Soporte para Actiona  
- [ ] Recording en video
- [ ] AI-powered naming
- [ ] Conditional logic generation
- [ ] Loop/retry logic
- [ ] Integración con GitHub
- [ ] UI mejorada con side panel
- [ ] Settings avanzadas

## 📝 Configuración

En `chrome://extensions` → WIC → Options:

```javascript
{
  captureNetwork: true,           // Capturar requests
  captureShadowDOM: true,         // Detectar Shadow DOM
  captureReact: true,             // Acceder a React Fiber
  capturePerformance: true,       // Metrics de performance
  selectorStability: 'balanced',  // 'aggressive', 'balanced', 'safe'
  exportFormat: 'markdown',       // Default export
  autoDownload: true              // Auto-descargar
}
```

## 🧠 Arquitectura Detallada

### Message Protocol

```javascript
// Content → Background
{
  action: 'START_RECORDING'
  // o
  action: 'STOP_RECORDING'
  // o
  action: 'EXPORT_AUDIT',
  format: 'markdown' | 'json' | 'csv' | 'yaml'
}

// Background → Content (response)
{
  status: 'success' | 'error',
  data: {...}
}
```

### Storage Structure

```javascript
// chrome.storage.local
{
  wic_sessions: [
    {
      tabId: 123,
      startTime: 1623456789,
      endTime: 1623456845,
      url: "https://example.com",
      interactions: [...],
      technologies: {...},
      networkEvents: [...],
      mutations: [...]
    }
  ],
  wic_settings: {
    captureNetwork: true,
    ...
  }
}
```

## 🔍 Debugging

### Ver logs en Console

```javascript
// En Content Script console
chrome://extensions → WIC → inspect views → service worker console

// Searchear por [ContentScript], [RecorderEngine], etc
```

### Ver datos de sesión

```javascript
// En DevTools
chrome.storage.local.get('wic_sessions', console.log);
```

## 📞 Soporte

Para reportar bugs o sugerir features, abrir issue en GitHub.

---

**Web Interaction Capture v1.0**  
*Universal Web Automation Blueprint Generator*

