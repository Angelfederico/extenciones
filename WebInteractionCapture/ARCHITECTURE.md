# ARQUITECTURA TÉCNICA DETALLADA - Web Interaction Capture

## 📐 Diagrama de Flujo General

```
┌─────────────────────────────────────────────────────────────────────┐
│                         USER ACTIONS                                │
│              (Click, Input, Scroll, Touch, Keyboard)                │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      RECORDER ENGINE                                │
│  • Captura TODOS los eventos                                       │
│  • MutationObserver para DOM changes                               │
│  • Performance & Intersection Observers                            │
└────────────────────┬─────────────────────┬────────────────────────────┘
                     │                     │
         ┌───────────▼──────┬──────────────▼─────────┐
         │                  │                        │
    ┌────▼──────────┐  ┌────▼──────────┐   ┌────────▼──────┐
    │ SELECTOR      │  │ REACT ENGINE  │   │ SHADOW DOM    │
    │ ENGINE        │  │               │   │ ENGINE        │
    │ • CSS         │  │ • Fiber ops   │   │ • Detection   │
    │ • XPath       │  │ • Props/State │   │ • Traversal   │
    │ • Text Match  │  │ • Components  │   │ • Deep search │
    │ • ARIA/Role   │  │               │   │               │
    │ • Data attrs  │  │               │   │               │
    └────┬──────────┘  └────┬──────────┘   └────┬──────────┘
         │                  │                    │
         └──────────────────┼────────────────────┘
                            │
                            ▼
         ┌──────────────────────────────────┐
         │  ENRICHED INTERACTION OBJECT     │
         │                                  │
         │  {                               │
         │    type: 'click',                │
         │    target: 'button',             │
         │    timestamp: 123456,            │
         │    selectors: {                  │
         │      css: "...",                 │
         │      xpath: "...",               │
         │      unique: [...],              │
         │      stability: 90%              │
         │    },                            │
         │    react: {...},                 │
         │    shadowPath: [...],            │
         │    ...                           │
         │  }                               │
         └──────────┬───────────────────────┘
                    │
                    ▼
         ┌──────────────────────────────┐
         │  NETWORK ENGINE              │
         │  • Fetch interception        │
         │  • XHR interception          │
         │  • WebSocket capture         │
         └──────────┬───────────────────┘
                    │
                    ▼
         ┌──────────────────────────────┐
         │  SESSION DATA ACCUMULATION   │
         │  (chrome.storage.local)      │
         └──────────┬───────────────────┘
                    │
                    ▼
         ┌──────────────────────────────┐
         │  EXPORT ENGINES              │
         │  • Markdown                  │
         │  • JSON                      │
         │  • CSV                       │
         │  • YAML                      │
         └──────────┬───────────────────┘
                    │
                    ▼
         ┌──────────────────────────────┐
         │  CODE GENERATION             │
         │  • Playwright code           │
         │  • Puppeteer code            │
         │  • Extension code            │
         └──────────┬───────────────────┘
                    │
                    ▼
         ┌──────────────────────────────┐
         │  DOWNLOAD / VIEW             │
         └──────────────────────────────┘
```

## 🔌 Protocol de Mensajes

### Content Script → Service Worker

```javascript
// START RECORDING
{
  action: 'START_RECORDING'
}
↓ response
{
  status: 'recording'
}

// STOP RECORDING
{
  action: 'STOP_RECORDING'
}
↓ response
{
  status: 'stopped',
  data: { /* session data */ }
}

// GET SESSION DATA
{
  action: 'GET_SESSION_DATA'
}
↓ response
{
  interactions: [...],
  technologies: {...},
  networkEvents: [...],
  mutations: [...]
}

// EXPORT AUDIT
{
  action: 'EXPORT_AUDIT',
  format: 'markdown|json|csv|yaml'
}
↓ response (asíncrono)
{
  success: true,
  data: '# Markdown content...' || '{"json": "data"}' || ...
}
```

### Popup → Content Script

```javascript
{
  action: 'FIND_ELEMENTS',
  selector: '.button',
  strategy: 'css|xpath|shadow|react'
}
↓ response
{
  found: 3,
  elements: [Element, Element, Element]
}

{
  action: 'INSPECT_ELEMENT',
  selector: '.button'
}
↓ response
{
  tagName: 'button',
  react: { componentName: 'SubmitBtn', props: {...} },
  selectors: { css: '...', xpath: '...', ... },
  ...
}
```

## 📦 Estructura de Datos

### Interaction Object

```typescript
interface Interaction {
  // Metadata
  timestamp: number;
  type: 'click' | 'input' | 'scroll' | 'keydown' | ...; // 20+ tipos
  
  // Target Information
  target: string;            // HTMLTag name
  targetId: string | null;
  targetClass: string | null;
  
  // Event Details
  eventPhase: number;
  bubbles: boolean;
  cancelable: boolean;
  isTrusted: boolean;
  
  // Selector Strategies
  selectors: {
    css: string;             // e.g., ".btn.primary"
    xpath: string;           // e.g., "//button[@class='btn primary']"
    unique: string[];        // Multiple fallback strategies
    stable: number;          // Stability score 0-100
    aria: string | null;
    dataTestId: string | null;
    dataQa: string | null;
    role: string | null;
  };
  
  // Advanced Detection
  shadowPath: string[] | null;  // Path to element through shadow roots
  reactProps: {
    detected: boolean;
    fiber?: {
      type: string;         // Component name
      props: string[];      // Prop names
      state: any;
    };
  };
  
  // Value Capture
  value: string | null;     // For inputs
  text: string | null;      // Element text content
  
  // Coordinates
  coordinates?: {
    x: number;              // pageX
    y: number;              // pageY
    clientX: number;
    clientY: number;
  };
}
```

### Session Object

```typescript
interface Session {
  // Metadata
  tabId: number;
  startTime: number;
  endTime?: number;
  duration?: number;
  url: string;
  
  // Collected Data
  interactions: Interaction[];
  technologies: {
    react: boolean;
    vue: boolean;
    angular: boolean;
    shadowDOM: boolean;
    webComponents: boolean;
    iframe: boolean;
  };
  
  // DOM Changes
  mutations: {
    type: string;           // 'childList' | 'attributes' | 'characterData'
    target: string;         // Element tag
    timestamp: number;
  }[];
  
  // Network Activity
  networkEvents: {
    method: string;
    url: string;
    status: number;
    responseTime: number;
    timestamp: number;
  }[];
  
  // Statistics
  stats?: {
    totalInteractions: number;
    interactionTypes: { [key: string]: number };
    selectorStability: number;
    mostClickedElement: string;
    mostChangedInput: string;
    avgWaitTime: number;
  };
}
```

## 🔍 Selector Strategies Detalladas

### 1. CSS Selector Strategy

```typescript
function generateCSSSelector(element: HTMLElement): string {
  const path: string[] = [];
  let current: Element | null = element;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let selector = current.tagName.toLowerCase();

    // Prioridad: ID > clase combinada > nth-of-type
    if (current.id) {
      selector += `#${current.id}`;
      path.unshift(selector);
      break;
    } else {
      if (current.className) {
        const classes = Array.from(current.classList);
        selector += `.${classes.join('.')}`;
      }

      // Agregar nth-of-type si hay hermanos con el mismo tag
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          el => el.tagName === current?.tagName
        );
        if (siblings.length > 1) {
          const index = siblings.indexOf(current as Element) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }
    }

    path.unshift(selector);
    current = current.parentElement;
  }

  return path.join(' > ');
}
```

**Ejemplo**:
```css
html > body > div#app > div.container > button.btn.primary:nth-of-type(2)
```

**Ventajas**: Simple, rápido, amplio soporte  
**Desventajas**: Puede cambiar con refactoring CSS

### 2. XPath Strategy

```typescript
function generateXPath(element: HTMLElement): string {
  const path: string[] = [];
  let current: Node | null = element;

  while (current && current.nodeType !== Node.DOCUMENT_NODE) {
    let index = 1;
    let sibling = (current as Element).previousElementSibling;

    while (sibling) {
      if (sibling.nodeName === (current as Element).nodeName) {
        index++;
      }
      sibling = sibling.previousElementSibling;
    }

    const tagName = (current as Element).nodeName.toLowerCase();
    path.unshift(`${tagName}[${index}]`);
    current = (current as Element).parentElement;
  }

  return `//${path.join('/')}`;
}
```

**Ejemplo**:
```xpath
//html[1]/body[1]/div[1]/div[2]/button[2]
```

**Ventajas**: Muy flexible, múltiples opciones  
**Desventajas**: Sensible a cambios de estructura

### 3. Data Attributes Strategy

```typescript
if (element.getAttribute('data-testid')) {
  selectors.push(`[data-testid="${element.getAttribute('data-testid')}"]`);
}

if (element.getAttribute('data-qa')) {
  selectors.push(`[data-qa="${element.getAttribute('data-qa')}"]`);
}
```

**Ejemplo**:
```css
[data-testid="login-button"]
```

**Ventajas**: Muy estable, propósito específico  
**Desventajas**: Solo si desarrollador agregó atributos

### 4. ARIA/Role Strategy

```typescript
if (element.getAttribute('aria-label')) {
  selectors.push(`[aria-label="${element.getAttribute('aria-label')}"]`);
}

if (element.getAttribute('role')) {
  selectors.push(`[role="${element.getAttribute('role')}"]`);
}
```

**Ejemplo**:
```css
[role="button"][aria-label="Submit"]
```

**Ventajas**: Accesible, semántico  
**Desventajas**: No siempre presente

### 5. Text Matching Strategy

```typescript
const text = element.innerText?.trim();
if (text && text.length < 100) {
  // XPath que busca por texto
  selectors.push(`//button[contains(text(), '${text}')]`);
}
```

**Ejemplo**:
```xpath
//button[contains(text(), 'Click me')]
```

**Ventajas**: Muy legible  
**Desventajas**: Frágil si cambia el texto

### 6. React Fiber Strategy

```typescript
function captureReactProps(element: HTMLElement): any {
  const keys = Object.keys(element);
  const fiberKey = keys.find(key => key.startsWith('__reactFiber'));

  if (fiberKey) {
    const fiber = element[fiberKey];
    return {
      detected: true,
      componentName: fiber.type?.name,
      props: fiber.memoizedProps,
      state: fiber.memoizedState
    };
  }
}
```

**Ventajas**: Acceso a internals de React  
**Desventajas**: Solo para React

### 7. Shadow DOM Strategy

```typescript
function detectShadowPath(element: HTMLElement): string[] | null {
  const path: string[] = [];
  let current: Element | null = element;

  while (current) {
    const parent = current.parentElement;
    
    if (parent && parent.shadowRoot) {
      const hostSelector = generateCSSSelector(parent);
      path.unshift(`${hostSelector} (shadowRoot)`);
    }

    path.unshift(generateCSSSelector(current));
    current = parent;
  }

  return path.some(p => p.includes('shadowRoot')) ? path : null;
}
```

**Salida**:
```
["host-element (shadowRoot)", "div.container", "button.primary"]
```

## 🧩 Motores Especializados

### RecorderEngine

**Responsabilidades**:
- Adjuntar listeners a 20+ tipos de eventos
- Capturar timestamp, target, valores
- Inicializar observadores (Mutation, Intersection, Resize)
- Detectar tecnologías (React, Vue, Angular)
- Acumular datos en sesión

**API**:
```typescript
recorder.start();           // Inicia grabación
recorder.stop();            // Detiene y retorna sesión
recorder.detectTechnologies(); // Retorna {react: bool, ...}
recorder.getSessionData();  // Retorna datos actuales
```

### SelectorEngine

**Responsabilidades**:
- Generar múltiples estrategias para cada elemento
- Calcular estabilidad de selectores
- Crear fallbacks automáticos
- Validar selectores generados

### ReactEngine

**Responsabilidades**:
- Acceder a `__reactFiber$` de elementos
- Extraer nombre del componente
- Leer props del componente
- Acceder a estado (hooks)
- Navegar árbol de fibras

### ShadowDOMEngine

**Responsabilidades**:
- Detectar y mapear shadow roots
- Buscar elementos dentro de shadow roots
- Generar rutas completas
- Handling de shadow roots "closed"

### NetworkEngine

**Responsabilidades**:
- Interceptar `fetch()` calls
- Interceptar `XMLHttpRequest`
- Registrar requests y responses
- Capturar body, headers, status

### WaitDetectionEngine

**Responsabilidades**:
- Esperar a elementos
- Esperar a texto específico
- Esperar a que desaparezcan elementos
- Detectar red idle

## 🔐 Security Considerations

### Aislamiento de Contextos

```javascript
// page.js (injected)
window.__wic_injected = true;

// content.js (puede acceder a window.__wic_injected)
const injected = window.__wic_injected;

// background.js (NO puede acceder a window)
// Debe usar message passing
```

### Validación de Selectores

```typescript
// Antes de guardar selector, validar que funciona
try {
  const test = document.querySelector(selector);
  if (!test) throw new Error('Selector no encontró elemento');
  // OK
} catch (e) {
  // Fallback a siguiente estrategia
}
```

### Limpieza de Listeners

```typescript
// Usar AbortController para cleanup limpio
const controller = new AbortController();

document.addEventListener('click', handler, {
  signal: controller.signal
});

// Para limpiar:
controller.abort();
```

## 📊 Estadísticas Calculadas

```javascript
function calculateStatistics(session) {
  return {
    // Conteos básicos
    totalInteractions: session.interactions.length,
    totalMutations: session.mutations.length,
    totalNetworkRequests: session.networkEvents.length,

    // Distribución de eventos
    interactionTypes: countByType(session.interactions),
    eventPerSecond: session.interactions.length / (session.duration / 1000),

    // Selectores
    selectorStability: calculateAvgStability(session.interactions),
    mostUsedSelector: getMostFrequentSelector(session.interactions),
    selectorStrategies: analyzeStrategyUsage(session.interactions),

    // Elementos
    mostClickedElement: getMostClicked(session.interactions),
    mostChangedInput: getMostChanged(session.interactions),
    uniqueElementsTouched: countUniqueElements(session.interactions),

    // Timing
    avgEventTime: calculateAvgTime(session.interactions),
    eventTimeline: generateTimeline(session.interactions),

    // Tecnologías
    technologiesDetected: session.technologies,

    // Network
    avgNetworkTime: calculateAvgNetworkTime(session.networkEvents),
    networkErrorRate: calculateErrorRate(session.networkEvents)
  };
}
```

## 🎯 Casos de Uso Específicos

### Caso 1: Google Gemini Chat

```javascript
// Detecta:
// - Shadow DOM en componente de chat
// - React componentes de mensajes
// - MutationObserver para nuevos mensajes
// - Network requests a /api/chat

// Genera selector para input:
{
  css: ".input-container > textarea.message-input",
  xpath: "//textarea[@aria-label='Type a message']",
  unique: ["[data-qa='message-input']"],
  react: {
    componentName: "MessageInput",
    props: ["value", "onChange", "disabled"]
  }
}
```

### Caso 2: Gmail Compose

```javascript
// Detecta:
// - Iframe de compose
// - ContentEditable div
// - Multiple input fields
// - Attachment uploads

// Selector strategy:
{
  // Email to:
  css: ".bCp .dL",
  xpath: "//textarea[@aria-label='To']",
  aria: "To"
}
```

### Caso 3: LinkedIn Feed

```javascript
// Detecta:
// - Infinite scroll
// - Dynamic content loading
// - React virtual list
// - Shadow DOM components

// Wait strategies:
await WaitDetectionEngine.waitForElement('.feed-item', 5000);
await WaitDetectionEngine.waitForNetworkIdle(2000);
```

## 🚀 Optimizaciones

### 1. Event Delegation
```javascript
// En vez de adjuntar listener a cada elemento
document.addEventListener('click', handler, true);
// Usar capturing phase para interceptar antes
```

### 2. Debouncing de Mutations
```javascript
// Agrupar múltiples mutations en una
const batchMutations = debounce((mutations) => {
  processedMutations.push(...mutations);
}, 100);

observer.observe(document, {
  childList: true,
  subtree: true
});
```

### 3. Lazy Loading de Datos
```javascript
// Solo calcular selectores cuando sea necesario
const selectorsLazy = new Proxy({}, {
  get(target, prop) {
    if (!target[prop]) {
      target[prop] = generateSelectors();
    }
    return target[prop];
  }
});
```

---

**Documento de Arquitectura - Web Interaction Capture v1.0**
