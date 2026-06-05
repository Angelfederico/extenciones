/**
 * Shadow DOM Engine - Detecta y navega Shadow DOM
 */

export class ShadowDOMEngine {
  static detectAllShadowRoots(root: Element = document.documentElement): Map<Element, ShadowRoot> {
    const shadowRoots = new Map<Element, ShadowRoot>();
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT,
      null
    );

    let currentNode: Element | null;
    while ((currentNode = walker.nextNode() as Element | null)) {
      if (currentNode.shadowRoot) {
        shadowRoots.set(currentNode, currentNode.shadowRoot);
      }
    }

    return shadowRoots;
  }

  static findInShadowDOM(
    selector: string,
    root: Element = document.documentElement
  ): Element[] {
    const results: Element[] = [];

    // Búsqueda normal primero
    results.push(...Array.from(root.querySelectorAll(selector)));

    // Búsqueda en shadow roots
    const shadowRoots = this.detectAllShadowRoots(root);
    shadowRoots.forEach((shadowRoot) => {
      try {
        results.push(...Array.from(shadowRoot.querySelectorAll(selector)));
      } catch (e) {
        console.warn('Error searching in closed shadow root');
      }
    });

    return results;
  }

  static getShadowPath(element: Element): string[] {
    const path: string[] = [];
    let current: Element | null = element;

    while (current) {
      const parent = current.parentElement;
      const parentRoot = (current as any).getRootNode();

      if (parentRoot instanceof ShadowRoot) {
        const host = parentRoot.host;
        path.unshift(`${host.tagName.toLowerCase()} (shadowRoot)`);
        current = host;
      } else {
        path.unshift(current.tagName.toLowerCase());
        current = parent;
      }
    }

    return path;
  }

  static inspectShadowDOM(element: Element): {
    hasOpen: boolean;
    hasClosed: boolean;
    depth: number;
    structure: any
  } {
    const structure: any = {
      tag: element.tagName,
      shadowOpen: false,
      children: []
    };

    if (element.shadowRoot) {
      structure.shadowOpen = true;
      element.shadowRoot.querySelectorAll('*').forEach(child => {
        structure.children.push(child.tagName);
      });
    }

    return {
      hasOpen: element.shadowRoot?.mode === 'open',
      hasClosed: element.shadowRoot?.mode === 'closed',
      depth: this.getShadowDepth(element),
      structure
    };
  }

  private static getShadowDepth(element: Element, depth = 0): number {
    if (!element.shadowRoot) return depth;
    const maxChildDepth = Array.from(element.shadowRoot.children).reduce(
      (max, child) => Math.max(max, this.getShadowDepth(child, depth + 1)),
      depth + 1
    );
    return maxChildDepth;
  }
}

/**
 * React Engine - Accede a internals de React
 */
export class ReactEngine {
  static getComponentName(element: Element): string {
    const fiber = this.getFiber(element);
    return fiber?.type?.name || 'Unknown';
  }

  static getFiber(element: Element): any {
    const keys = Object.keys(element);
    const key = keys.find(k => k.startsWith('__reactFiber'));
    return key ? (element as any)[key] : null;
  }

  static getComponentProps(element: Element): any {
    const fiber = this.getFiber(element);
    return fiber?.memoizedProps || {};
  }

  static getComponentState(element: Element): any {
    const fiber = this.getFiber(element);
    let state: any = null;

    let currentHook = fiber?.memoizedState;
    const states = [];

    while (currentHook) {
      states.push(currentHook.memoizedState);
      currentHook = currentHook.next;
    }

    return states;
  }

  static walkFiberTree(
    element: Element,
    callback: (fiber: any, depth: number) => void,
    depth = 0
  ) {
    const fiber = this.getFiber(element);
    if (!fiber) return;

    callback(fiber, depth);

    let child = fiber.child;
    while (child) {
      const node = child.elementInstance || child.stateNode;
      if (node instanceof Element) {
        this.walkFiberTree(node, callback, depth + 1);
      }
      child = child.sibling;
    }
  }

  static getRenderedComponents(root: Element): string[] {
    const components = new Set<string>();
    this.walkFiberTree(root, fiber => {
      if (fiber.type?.name) {
        components.add(fiber.type.name);
      }
    });
    return Array.from(components);
  }
}

/**
 * Network Engine - Captura requests/responses
 */
export class NetworkEngine {
  private static requestLog: any[] = [];

  static initialize() {
    this.interceptFetch();
    this.interceptXHR();
  }

  private static interceptFetch() {
    const originalFetch = window.fetch;
    window.fetch = function(...args: any[]) {
      const request = {
        method: args[1]?.method || 'GET',
        url: args[0],
        headers: args[1]?.headers || {},
        body: args[1]?.body || null,
        timestamp: Date.now()
      };

      return originalFetch.apply(this, args).then((response: Response) => {
        const log = {
          ...request,
          status: response.status,
          statusText: response.statusText,
          responseTime: Date.now() - request.timestamp
        };
        NetworkEngine.requestLog.push(log);
        return response;
      });
    };
  }

  private static interceptXHR() {
    const XHROpen = XMLHttpRequest.prototype.open;
    const XHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method: string, url: string) {
      (this as any)._method = method;
      (this as any)._url = url;
      (this as any)._startTime = Date.now();
      return XHROpen.apply(this, arguments as any);
    };

    XMLHttpRequest.prototype.send = function(body?: any) {
      this.addEventListener('load', () => {
        const log = {
          method: (this as any)._method,
          url: (this as any)._url,
          status: this.status,
          statusText: this.statusText,
          responseTime: Date.now() - (this as any)._startTime,
          timestamp: (this as any)._startTime
        };
        NetworkEngine.requestLog.push(log);
      });
      return XHRSend.apply(this, arguments as any);
    };
  }

  static getNetworkLog(): any[] {
    return NetworkEngine.requestLog;
  }
}

/**
 * Wait Detection Engine - Detecta automáticamente esperas
 */
export class WaitDetectionEngine {
  static async waitForElement(
    selector: string,
    timeout = 5000,
    strategy: 'css' | 'xpath' = 'css'
  ): Promise<Element | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      let element: Element | null = null;

      if (strategy === 'css') {
        element = document.querySelector(selector);
      } else if (strategy === 'xpath') {
        const result = document.evaluate(
          selector,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        );
        element = result.singleNodeValue as Element;
      }

      if (element) return element;
      await new Promise(r => setTimeout(r, 100));
    }

    return null;
  }

  static async waitForText(
    text: string,
    timeout = 5000
  ): Promise<Element | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const xpath = `//*[contains(text(), '${text}')]`;
      const result = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );

      if (result.singleNodeValue) {
        return result.singleNodeValue as Element;
      }

      await new Promise(r => setTimeout(r, 100));
    }

    return null;
  }

  static async waitForElementToDisappear(
    selector: string,
    timeout = 5000
  ): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const element = document.querySelector(selector);
      if (!element) return true;
      await new Promise(r => setTimeout(r, 100));
    }

    return false;
  }

  static async waitForNetworkIdle(timeout = 5000): Promise<boolean> {
    // Implementar con chrome.debugger para verdadera detección
    return new Promise(resolve => setTimeout(() => resolve(true), timeout));
  }
}

/**
 * Upload/Download Engine
 */
export class FileTransferEngine {
  static async detectFileUpload(element: Element): Promise<{
    type: 'input' | 'dragdrop' | 'click';
    selector: string;
    acceptedFormats: string;
  } | null> {
    if (element instanceof HTMLInputElement && element.type === 'file') {
      return {
        type: 'input',
        selector: this.getSelector(element),
        acceptedFormats: element.accept || '*'
      };
    }

    return null;
  }

  static async detectDownload(url: string): Promise<{
    url: string;
    filename: string;
    mimeType: string;
  }> {
    // Usar chrome.debugger para interceptar downloads
    return {
      url,
      filename: url.split('/').pop() || 'download',
      mimeType: 'application/octet-stream'
    };
  }

  private static getSelector(element: Element): string {
    if (element.id) return `#${element.id}`;
    if (element.className) return `.${(element.className as string).split(' ')[0]}`;
    return element.tagName.toLowerCase();
  }
}
