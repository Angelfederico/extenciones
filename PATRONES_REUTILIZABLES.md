# 📚 PATRONES REUTILIZABLES - CÓDIGO LISTO PARA USAR

## Tabla de Contenidos

1. [Task Ledger](#task-ledger)
2. [Recovery Engine](#recovery-engine)
3. [Message Bus](#message-bus)
4. [DOM Utilities](#dom-utilities)
5. [State Machine](#state-machine)
6. [Queue Manager](#queue-manager)
7. [Logger](#logger)
8. [Storage Adapter](#storage-adapter)

---

## Task Ledger

Gestión de estado persistente de tareas (como Auto Flow).

```javascript
// task-ledger.js
export const TaskStatus = Object.freeze({
  pending: "pending",
  submitting: "submitting",
  generating: "generating",
  downloading: "downloading",
  complete: "complete",
  failed: "failed",
  blocked: "blocked"
});

export function createTaskLedger() {
  const tasks = new Map();  // taskId -> task
  
  function generateId() {
    return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  return {
    addTask(taskData = {}) {
      const task = {
        id: generateId(),
        status: TaskStatus.pending,
        createdAt: new Date().toISOString(),
        attempts: 0,
        error: null,
        mediaIds: [],
        ...taskData
      };
      tasks.set(task.id, task);
      return task;
    },
    
    getTask(taskId) {
      return tasks.get(taskId);
    },
    
    updateTask(taskId, patch = {}) {
      const task = tasks.get(taskId);
      if (!task) return null;
      
      const updated = {
        ...task,
        ...patch,
        updatedAt: new Date().toISOString()
      };
      tasks.set(taskId, updated);
      return updated;
    },
    
    getNextPending() {
      for (const task of tasks.values()) {
        if (task.status === TaskStatus.pending) {
          return task;
        }
      }
      return null;
    },
    
    getAllTasks() {
      return Array.from(tasks.values());
    },
    
    getByStatus(status) {
      return Array.from(tasks.values())
        .filter(t => t.status === status);
    },
    
    remove(taskId) {
      return tasks.delete(taskId);
    },
    
    clear() {
      tasks.clear();
    },
    
    getStats() {
      const all = Array.from(tasks.values());
      return {
        total: all.length,
        pending: all.filter(t => t.status === TaskStatus.pending).length,
        running: all.filter(t => t.status === TaskStatus.submitting).length
          + all.filter(t => t.status === TaskStatus.generating).length,
        complete: all.filter(t => t.status === TaskStatus.complete).length,
        failed: all.filter(t => t.status === TaskStatus.failed).length
      };
    }
  };
}

// Uso en service-worker.js
const ledger = createTaskLedger();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "TASK_ADD") {
    const task = ledger.addTask(request.payload);
    chrome.storage.local.set({ lastTaskId: task.id });
    sendResponse({ taskId: task.id });
  }
  
  if (request.type === "QUEUE_STATS") {
    sendResponse({ stats: ledger.getStats() });
  }
});
```

---

## Recovery Engine

Manejo inteligente de errores con reintentos.

```javascript
// recovery-engine.js
export const RecoveryAction = Object.freeze({
  SOFT_RELOAD: "soft_reload",
  CACHE_CLEAR_RELOAD: "cache_clear_reload",
  SERVICE_WORKER_BYPASS: "service_worker_bypass",
  MANUAL_INTERVENTION: "manual_intervention"
});

export function classifyError(error) {
  const text = String(error?.message || error || "").toLowerCase();
  
  // Hard stops (no reintentar)
  if (text.includes("quota_reached") || text.includes("access_denied")) {
    return { severity: "hard_stop", action: null };
  }
  
  // Rate limiting (esperar + reintentar)
  if (text.includes("429") || text.includes("too_many_requests")) {
    return { severity: "transient", action: RecoveryAction.SOFT_RELOAD };
  }
  
  // Crash (reload agresivo)
  if (text.includes("crash") || text.includes("snap")) {
    return { severity: "critical", action: RecoveryAction.CACHE_CLEAR_RELOAD };
  }
  
  // Unknown
  return { severity: "unknown", action: RecoveryAction.SOFT_RELOAD };
}

export async function executeWithRecovery(
  taskFn,
  { maxAttempts = 5, initialDelayMs = 1000 } = {}
) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await taskFn();
    } catch (error) {
      lastError = error;
      
      const { severity, action } = classifyError(error);
      
      if (severity === "hard_stop") {
        throw new Error(`Hard stop: ${error.message}`);
      }
      
      if (attempt < maxAttempts) {
        const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
        const jitter = Math.random() * 0.1 * delayMs;
        
        console.log(
          `Attempt ${attempt} failed (${severity}), ` +
          `retrying in ${Math.round(delayMs)}ms...`
        );
        
        await new Promise(r => setTimeout(r, delayMs + jitter));
      }
    }
  }
  
  throw lastError;
}

// Uso
async function submitPromptWithRecovery(projectId, prompt) {
  return executeWithRecovery(
    async () => {
      const response = await fetch(
        `https://api.example.com/v1/projects/${projectId}/submit`,
        {
          method: "POST",
          body: JSON.stringify({ prompt })
        }
      );
      
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      
      return response.json();
    },
    { maxAttempts: 5, initialDelayMs: 1000 }
  );
}
```

---

## Message Bus

Sistema de comunicación con versionado.

```javascript
// message-bus.js
export const MessageType = Object.freeze({
  // V1
  TaskAdd: "ext.task.add",
  TaskStart: "ext.task.start",
  TaskStop: "ext.task.stop",
  
  // V2 (backward compatible)
  TaskAddV2: "ext.task.add.v2",
  TaskStartV2: "ext.task.start.v2",
  
  // Custom
  PageEvent: "ext.page.event",
  DebugLog: "ext.debug.log"
});

export function createMessage(type, payload = {}, meta = {}) {
  return {
    type,
    payload,
    meta: {
      createdAt: new Date().toISOString(),
      version: "1.0",
      source: "extension",
      ...meta
    }
  };
}

export class MessageBus {
  constructor() {
    this.handlers = new Map();
    this.version = "1.0";
  }
  
  on(messageType, handler) {
    if (!this.handlers.has(messageType)) {
      this.handlers.set(messageType, []);
    }
    this.handlers.get(messageType).push(handler);
  }
  
  off(messageType, handler) {
    const handlers = this.handlers.get(messageType);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index !== -1) handlers.splice(index, 1);
    }
  }
  
  async emit(messageType, payload = {}, meta = {}) {
    const message = createMessage(messageType, payload, meta);
    const handlers = this.handlers.get(messageType) || [];
    
    const results = [];
    for (const handler of handlers) {
      try {
        const result = await handler(message);
        results.push(result);
      } catch (error) {
        console.error(`Handler failed for ${messageType}:`, error);
      }
    }
    
    return results;
  }
}

// Configurar en service-worker.js
const messageBus = new MessageBus();

// Listeners
messageBus.on(MessageType.TaskAdd, async (message) => {
  const task = ledger.addTask(message.payload);
  return { taskId: task.id };
});

messageBus.on(MessageType.TaskStart, async (message) => {
  const { taskId } = message.payload;
  const task = ledger.getTask(taskId);
  if (!task) throw new Error("Task not found");
  
  return await executeTask(task);
});

// Chrome runtime bridge
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (Object.values(MessageType).includes(request.type)) {
    messageBus.emit(request.type, request.payload, { tabId: sender.tab.id })
      .then(results => sendResponse({ ok: true, results }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;  // Keep channel open
  }
});
```

---

## DOM Utilities

Funciones para manipular DOM de forma robusta.

```javascript
// dom-utils.js

export const DOMUtils = {
  // Espera a que elemento esté visible
  async waitForElement(selector, timeoutMs = 10000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const el = document.querySelector(selector);
      if (el && this.isVisible(el)) {
        return el;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    
    throw new Error(`Timeout waiting for: ${selector}`);
  },
  
  // Verifica si elemento es visible
  isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    
    return rect.width > 0 &&
           rect.height > 0 &&
           style.display !== 'none' &&
           style.visibility !== 'hidden' &&
           style.opacity !== '0';
  },
  
  // Busca en shadow DOM
  findInShadow(selector, root = document) {
    const direct = root.querySelector(selector);
    if (direct) return direct;
    
    const walk = (node, depth = 0) => {
      if (depth > 10) return null;
      
      if (node.shadowRoot) {
        const inShadow = node.shadowRoot.querySelector(selector);
        if (inShadow) return inShadow;
        
        for (const child of node.shadowRoot.querySelectorAll('*')) {
          const found = walk(child, depth + 1);
          if (found) return found;
        }
      }
      
      return null;
    };
    
    for (const el of root.querySelectorAll('*')) {
      const found = walk(el);
      if (found) return found;
    }
    
    return null;
  },
  
  // Simula typing humano
  async humanType(element, text, delayMs = 50) {
    element.focus();
    
    for (const char of text) {
      element.value += char;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => 
        setTimeout(r, delayMs + Math.random() * 30)
      );
    }
    
    element.dispatchEvent(new Event('change', { bubbles: true }));
  },
  
  // Click humano
  async humanClick(element, delayMs = 150) {
    await new Promise(r => setTimeout(r, delayMs));
    
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    
    element.dispatchEvent(new MouseEvent('mouseover', {
      bubbles: true, clientX: x, clientY: y
    }));
    
    await new Promise(r => setTimeout(r, 50));
    
    element.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, clientX: x, clientY: y
    }));
    
    await new Promise(r => setTimeout(r, 50));
    
    element.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, clientX: x, clientY: y
    }));
    
    element.click();
  },
  
  // Espera a texto
  async waitForTextChange(selector, initialText = null, timeoutMs = 60000) {
    const startTime = Date.now();
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    
    const initial = initialText || el.textContent;
    
    while (Date.now() - startTime < timeoutMs) {
      if (el.textContent !== initial) {
        return el.textContent;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    
    throw new Error(`Text in ${selector} didn't change`);
  },
  
  // Obtiene React Fiber
  getReactFiber(element) {
    const key = Object.keys(element).find(k =>
      k.startsWith('__react') && k.includes('Fiber')
    );
    return element[key];
  },
  
  // Limpia interval/timeout
  clearAll() {
    for (let i = 0; i < 10000; i++) {
      clearInterval(i);
      clearTimeout(i);
    }
  }
};

// Uso en content script
const input = await DOMUtils.waitForElement('input[type="text"]');
await DOMUtils.humanType(input, "Hello World");
const button = document.querySelector('button[type="submit"]');
await DOMUtils.humanClick(button);
```

---

## State Machine

Máquina de estados para tareas.

```javascript
// state-machine.js
export class TaskStateMachine {
  constructor(task) {
    this.task = task;
    this.state = 'PENDING';
    this.history = [];
    this.handlers = new Map();
  }
  
  on(state, handler) {
    this.handlers.set(state, handler);
  }
  
  async transition(newState, data = {}) {
    const previousState = this.state;
    this.state = newState;
    
    this.history.push({
      from: previousState,
      to: newState,
      timestamp: new Date().toISOString(),
      data
    });
    
    const handler = this.handlers.get(newState);
    if (handler) {
      try {
        const result = await handler.call(this, data);
        return result;
      } catch (error) {
        console.error(`Handler failed for state ${newState}:`, error);
        await this.transition('FAILED', { error: error.message });
        throw error;
      }
    }
  }
  
  canTransition(newState) {
    // Define transiciones válidas
    const validTransitions = {
      'PENDING': ['SUBMITTING', 'CANCELLED'],
      'SUBMITTING': ['GENERATING', 'FAILED'],
      'GENERATING': ['COMPLETE', 'FAILED'],
      'COMPLETE': ['ARCHIVED'],
      'FAILED': ['SUBMITTING'],  // Reintentar
      'CANCELLED': ['ARCHIVED'],
      'ARCHIVED': []
    };
    
    return validTransitions[this.state]?.includes(newState) ?? false;
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
const sm = new TaskStateMachine({ id: '123', prompt: 'Hello' });

sm.on('SUBMITTING', async function(data) {
  console.log('Submitting task:', this.task.id);
  const response = await submitAPI(this.task);
  return response;
});

sm.on('GENERATING', async function(data) {
  console.log('Waiting for generation...');
  await waitForGeneration(data.generationId);
  return { complete: true };
});

sm.on('COMPLETE', async function(data) {
  console.log('Downloading media...');
  const mediaUrl = await downloadMedia(data.mediaId);
  return { url: mediaUrl };
});

sm.on('FAILED', async function(data) {
  console.error('Task failed:', data.error);
  recordAnalytics({ status: 'failed', error: data.error });
});

// Ejecutar flujo
await sm.transition('SUBMITTING', { projectId: '456' });
await sm.transition('GENERATING', { generationId: 'gen_789' });
await sm.transition('COMPLETE', { mediaId: 'media_000' });
```

---

## Queue Manager

Gestor de cola con ejecución secuencial.

```javascript
// queue-manager.js
export class QueueManager {
  constructor(concurrency = 1) {
    this.queue = [];
    this.running = [];
    this.concurrency = concurrency;
    this.paused = false;
    this.stats = {
      total: 0,
      completed: 0,
      failed: 0,
      startTime: null,
      endTime: null
    };
  }
  
  add(task) {
    this.queue.push({
      id: crypto.randomUUID(),
      task,
      status: 'pending',
      attempts: 0,
      error: null
    });
    this.stats.total++;
    this.process();
  }
  
  async process() {
    if (this.paused) return;
    
    while (this.running.length < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      const promise = this.executeItem(item);
      this.running.push(promise);
      
      promise.finally(() => {
        this.running = this.running.filter(p => p !== promise);
        this.process();
      });
    }
  }
  
  async executeItem(item) {
    item.status = 'running';
    
    try {
      const result = await item.task(item.id);
      item.status = 'complete';
      this.stats.completed++;
      return result;
    } catch (error) {
      item.error = error.message;
      item.attempts++;
      
      // Reintentar si no alcanzó máximo
      if (item.attempts < 3) {
        item.status = 'pending';
        this.queue.push(item);
        this.process();
      } else {
        item.status = 'failed';
        this.stats.failed++;
      }
      
      throw error;
    }
  }
  
  pause() {
    this.paused = true;
  }
  
  resume() {
    this.paused = false;
    this.process();
  }
  
  async waitAll() {
    if (this.stats.startTime === null) {
      this.stats.startTime = Date.now();
    }
    
    while (this.queue.length > 0 || this.running.length > 0) {
      await Promise.race(this.running);
    }
    
    this.stats.endTime = Date.now();
  }
  
  getStats() {
    return {
      ...this.stats,
      duration: this.stats.endTime 
        ? this.stats.endTime - this.stats.startTime 
        : Date.now() - this.stats.startTime
    };
  }
}

// Uso
const queue = new QueueManager(3);  // 3 tareas concurrentes

const prompts = ['Prompt 1', 'Prompt 2', 'Prompt 3'];
prompts.forEach(prompt => {
  queue.add(async (taskId) => {
    console.log(`[${taskId}] Processing: ${prompt}`);
    const result = await submitPrompt(prompt);
    return result;
  });
});

await queue.waitAll();
console.log('Done:', queue.getStats());
```

---

## Logger

Sistema de logging con niveles y persistencia.

```javascript
// logger.js
export class Logger {
  constructor(namespace = 'Extension', persistToStorage = false) {
    this.namespace = namespace;
    this.logs = [];
    this.persistToStorage = persistToStorage;
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
    
    // Imprime en consola
    const styles = {
      DEBUG: 'color: gray; font-weight: normal;',
      INFO: 'color: blue; font-weight: bold;',
      WARN: 'color: orange; font-weight: bold;',
      ERROR: 'color: red; font-weight: bold;'
    };
    
    const style = styles[level] || 'color: black;';
    console.log(
      `%c[${this.namespace}]`,
      style,
      message,
      data
    );
    
    // Persiste si está habilitado
    if (this.persistToStorage) {
      this.saveLogs();
    }
  }
  
  debug(msg, data) { this.log('DEBUG', msg, data); }
  info(msg, data) { this.log('INFO', msg, data); }
  warn(msg, data) { this.log('WARN', msg, data); }
  error(msg, data) { this.log('ERROR', msg, data); }
  
  async saveLogs() {
    if (this.logs.length > 10000) {
      // Mantén solo últimos 10000
      this.logs = this.logs.slice(-10000);
    }
    
    await chrome.storage.local.set({
      [`logs_${this.namespace}`]: this.logs
    });
  }
  
  async loadLogs() {
    const data = await chrome.storage.local.get([`logs_${this.namespace}`]);
    this.logs = data[`logs_${this.namespace}`] || [];
    return this.logs;
  }
  
  async exportLogs(filename = `logs_${Date.now()}.json`) {
    const blob = new Blob(
      [JSON.stringify(this.logs, null, 2)],
      { type: 'application/json' }
    );
    
    const url = URL.createObjectURL(blob);
    
    // Descarga automáticamente
    await chrome.downloads.download({
      url,
      filename
    });
  }
  
  filter(predicate) {
    return this.logs.filter(predicate);
  }
  
  getErrorLogs() {
    return this.filter(log => log.level === 'ERROR');
  }
  
  clear() {
    this.logs = [];
  }
}

// Uso en service-worker.js
const logger = new Logger('AutoFlow', true);

logger.info('Service worker started');
logger.debug('Queue initialized', { size: ledger.getAllTasks().length });

try {
  await executeTask(task);
} catch (error) {
  logger.error('Task execution failed', { taskId: task.id, error: error.message });
}

// Exportar logs para debugging
await logger.exportLogs('autoflow_logs.json');
```

---

## Storage Adapter

Abstracción sobre chrome.storage para facilitar testing.

```javascript
// storage-adapter.js
export class StorageAdapter {
  constructor(area = 'local') {
    this.area = chrome.storage[area];
  }
  
  async get(key, defaultValue = null) {
    const result = await this.area.get([key]);
    return result[key] ?? defaultValue;
  }
  
  async getMultiple(keys = []) {
    return this.area.get(keys);
  }
  
  async set(key, value) {
    return this.area.set({ [key]: value });
  }
  
  async setMultiple(data = {}) {
    return this.area.set(data);
  }
  
  async remove(key) {
    return this.area.remove([key]);
  }
  
  async removeMultiple(keys = []) {
    return this.area.remove(keys);
  }
  
  async clear() {
    return this.area.clear();
  }
  
  async keys() {
    const data = await this.area.get(null);
    return Object.keys(data);
  }
  
  // Patrón: serializa/deserializa automáticamente
  async getJSON(key, defaultValue = {}) {
    const value = await this.get(key);
    try {
      return value ? JSON.parse(value) : defaultValue;
    } catch (e) {
      return defaultValue;
    }
  }
  
  async setJSON(key, value) {
    return this.set(key, JSON.stringify(value));
  }
  
  // Patrón: increment counter
  async increment(key, amount = 1) {
    const current = (await this.get(key)) || 0;
    await this.set(key, current + amount);
    return current + amount;
  }
  
  // Patrón: append to array
  async append(key, value) {
    const current = (await this.get(key)) || [];
    const next = Array.isArray(current) ? current : [];
    next.push(value);
    await this.set(key, next);
    return next;
  }
  
  // Patrón: merge object
  async merge(key, partial = {}) {
    const current = (await this.getJSON(key)) || {};
    const merged = { ...current, ...partial };
    await this.setJSON(key, merged);
    return merged;
  }
}

// Uso
const storage = new StorageAdapter('local');

// Simple
await storage.set('projectId', '123');
const projectId = await storage.get('projectId');

// JSON
await storage.setJSON('queue', [{ id: 1, status: 'pending' }]);
const queue = await storage.getJSON('queue', []);

// Increment
const count = await storage.increment('requestCount');

// Append
await storage.append('logs', { message: 'Started', time: Date.now() });

// Merge
await storage.merge('config', { theme: 'dark', language: 'es' });
```

---

## Patrón Completo: Usar Juntos

```javascript
// service-worker.js - Ejemplo de integración

import { createTaskLedger } from './task-ledger.js';
import { executeWithRecovery } from './recovery-engine.js';
import { MessageBus, MessageType } from './message-bus.js';
import { QueueManager } from './queue-manager.js';
import { Logger } from './logger.js';
import { StorageAdapter } from './storage-adapter.js';

const storage = new StorageAdapter('local');
const logger = new Logger('AutoFlow', true);
const ledger = createTaskLedger();
const messageBus = new MessageBus();
const queue = new QueueManager(1);  // Secuencial

// Configurar handlers
messageBus.on(MessageType.TaskAdd, async (msg) => {
  const task = ledger.addTask(msg.payload);
  logger.info('Task added', { taskId: task.id });
  
  queue.add(async () => {
    return executeWithRecovery(
      () => executeTask(task),
      { maxAttempts: 5 }
    );
  });
  
  return { taskId: task.id };
});

messageBus.on(MessageType.TaskStart, async (msg) => {
  logger.info('Starting queue execution');
  await queue.waitAll();
  const stats = queue.getStats();
  logger.info('Queue complete', stats);
  return stats;
});

// Chrome runtime bridge
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  messageBus.emit(request.type, request.payload)
    .then(result => {
      sendResponse({ ok: true, result });
      logger.info('Message handled', { type: request.type });
    })
    .catch(error => {
      sendResponse({ ok: false, error: error.message });
      logger.error('Message failed', { type: request.type, error: error.message });
    });
  
  return true;
});

// Restaurar estado al iniciar
(async () => {
  const savedTasks = await storage.getJSON('queue_tasks', []);
  savedTasks.forEach(task => ledger.addTask(task));
  logger.info('Service worker ready', { taskCount: savedTasks.length });
})();

// Persist estado periodicamente
setInterval(async () => {
  await storage.setJSON('queue_tasks', ledger.getAllTasks());
}, 5000);
```

---

## Testing

Ejemplos de tests para estos patrones:

```javascript
// __tests__/task-ledger.test.js
import { createTaskLedger, TaskStatus } from '../task-ledger.js';

describe('TaskLedger', () => {
  let ledger;
  
  beforeEach(() => {
    ledger = createTaskLedger();
  });
  
  test('should add task', () => {
    const task = ledger.addTask({ prompt: 'Test' });
    expect(task.id).toBeDefined();
    expect(task.status).toBe(TaskStatus.pending);
  });
  
  test('should update task', () => {
    const task = ledger.addTask({ prompt: 'Test' });
    const updated = ledger.updateTask(task.id, { status: TaskStatus.complete });
    expect(updated.status).toBe(TaskStatus.complete);
  });
  
  test('should get next pending', () => {
    const task1 = ledger.addTask({ prompt: 'Test1' });
    ledger.updateTask(task1.id, { status: TaskStatus.complete });
    
    const task2 = ledger.addTask({ prompt: 'Test2' });
    const next = ledger.getNextPending();
    
    expect(next.id).toBe(task2.id);
  });
  
  test('should get stats', () => {
    ledger.addTask({ prompt: 'Test1' });
    ledger.addTask({ prompt: 'Test2' });
    
    const stats = ledger.getStats();
    expect(stats.total).toBe(2);
    expect(stats.pending).toBe(2);
  });
});
```

---

**Fin de Patrones Reutilizables**

