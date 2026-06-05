/**
 * Recorder Engine - Captura eventos y acciones del usuario
 * Propósito: Registrar TODAS las interacciones en el DOM
 */

export class RecorderEngine {
  constructor() {
    this.recording = false;
    this.interactions = [];
    this.currentSession = null;
    this.observers = {
      mutation: null,
      intersection: null,
      resize: null,
      performance: null
    };
  }

  start() {
    this.recording = true;
    this.currentSession = {
      startTime: Date.now(),
      url: window.location.href,
      interactions: [],
      mutations: [],
      networkEvents: [],
      reactDetected: false,
      shadowDOMDetected: false,
      webComponentsDetected: false
    };

    this.attachEventListeners();
    this.initializeObservers();
    console.log('[RecorderEngine] Recording started');
  }

  stop() {
    this.recording = false;
    this.detachEventListeners();
    this.stopObservers();
    console.log('[RecorderEngine] Recording stopped');
    return this.currentSession;
  }

  // Eventos de Mouse
  private attachEventListeners() {
    const eventTypes = [
      'click',
      'dblclick',
      'mousedown',
      'mouseup',
      'mousemove',
      'mouseover',
      'mouseenter',
      'mouseleave',
      'hover',
      'contextmenu',
      'wheel',
      'scroll'
    ];

    const touchEvents = [
      'touchstart',
      'touchmove',
      'touchend',
      'touchcancel'
    ];

    const keyboardEvents = [
      'keydown',
      'keyup',
      'keypress'
    ];

    const formEvents = [
      'focus',
      'blur',
      'input',
      'change',
      'select',
      'submit',
      'reset'
    ];

    const clipboardEvents = [
      'copy',
      'cut',
      'paste'
    ];

    const dragEvents = [
      'dragstart',
      'drag',
      'dragend',
      'dragenter',
      'dragover',
      'dragleave',
      'drop'
    ];

    const allEvents = [
      ...eventTypes,
      ...touchEvents,
      ...keyboardEvents,
      ...formEvents,
      ...clipboardEvents,
      ...dragEvents
    ];

    allEvents.forEach(eventType => {
      document.addEventListener(eventType, (e) => this.handleEvent(e), true);
    });
  }

  private detachEventListeners() {
    // En producción, usar AbortController para cleanup más limpio
    location.reload();
  }

  private handleEvent(e: Event) {
    if (!this.recording) return;

    const target = e.target as HTMLElement;
    const interaction = {
      timestamp: Date.now(),
      type: e.type,
      target: target.tagName,
      targetId: target.id || null,
      targetClass: target.className || null,
      eventPhase: e.eventPhase,
      bubbles: e.bubbles,
      cancelable: e.cancelable,
      isTrusted: e.isTrusted,
      selectors: this.captureSelectors(target),
      shadowPath: this.detectShadowPath(target),
      reactProps: this.captureReactProps(target),
      value: this.captureValue(target),
      text: this.captureText(target),
      coordinates: this.captureCoordinates(e)
    };

    this.currentSession.interactions.push(interaction);
  }

  private captureSelectors(element: HTMLElement) {
    return {
      css: this.generateCSSSelector(element),
      xpath: this.generateXPath(element),
      unique: this.generateUniqueSelector(element),
      stable: this.calculateSelectorStability(element),
      aria: element.getAttribute('aria-label') || null,
      dataTestId: element.getAttribute('data-testid') || null,
      dataQa: element.getAttribute('data-qa') || null,
      role: element.getAttribute('role') || null
    };
  }

  private generateCSSSelector(element: HTMLElement): string {
    const path: string[] = [];
    let current: Element | null = element;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let selector = (current as HTMLElement).tagName.toLowerCase();

      if (current.id) {
        selector += `#${current.id}`;
        path.unshift(selector);
        break;
      } else {
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

  private generateXPath(element: HTMLElement): string {
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

  private generateUniqueSelector(element: HTMLElement): string[] {
    const selectors: string[] = [];

    // Estrategia 1: ID
    if (element.id) {
      selectors.push(`#${element.id}`);
    }

    // Estrategia 2: Combinación de clase + tag
    if (element.className) {
      const classes = (element.className as string).split(' ');
      if (classes.length <= 3) {
        selectors.push(`${element.tagName.toLowerCase()}.${classes.join('.')}`);
      }
    }

    // Estrategia 3: data-testid
    const testId = element.getAttribute('data-testid');
    if (testId) {
      selectors.push(`[data-testid="${testId}"]`);
    }

    // Estrategia 4: aria-label
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) {
      selectors.push(`[aria-label="${ariaLabel}"]`);
    }

    // Estrategia 5: text content (si es pequeño)
    const text = element.innerText?.trim();
    if (text && text.length < 100) {
      selectors.push(`//button[contains(text(), '${text}')]`);
    }

    return selectors;
  }

  private calculateSelectorStability(element: HTMLElement): {
    stability: number;
    strategies: { strategy: string; score: number }[]
  } {
    const strategies = [
      {
        strategy: 'ID',
        score: element.id ? 100 : 0
      },
      {
        strategy: 'data-testid',
        score: element.getAttribute('data-testid') ? 95 : 0
      },
      {
        strategy: 'aria-label',
        score: element.getAttribute('aria-label') ? 85 : 0
      },
      {
        strategy: 'role',
        score: element.getAttribute('role') ? 80 : 0
      },
      {
        strategy: 'className',
        score: element.className ? 60 : 0
      },
      {
        strategy: 'text matching',
        score: element.innerText ? 50 : 0
      },
      {
        strategy: 'XPath',
        score: 40
      }
    ];

    const avgScore =
      strategies.reduce((sum, s) => sum + s.score, 0) / strategies.length;

    return {
      stability: Math.round(avgScore),
      strategies: strategies.filter(s => s.score > 0)
    };
  }

  private detectShadowPath(element: HTMLElement): string[] | null {
    const path: string[] = [];
    let current: Element | null = element;

    while (current) {
      const parent = current.parentElement;

      if (parent && parent.shadowRoot) {
        const hostSelector = this.generateCSSSelector(parent);
        path.unshift(`${hostSelector} (shadowRoot)`);
      }

      path.unshift(this.generateCSSSelector(current));
      current = parent;
    }

    // Retornar solo si hay shadow DOM
    return path.some(p => p.includes('shadowRoot')) ? path : null;
  }

  private captureReactProps(element: HTMLElement): any {
    // Buscar __reactFiber$
    const keys = Object.keys(element);
    const fiberKey = keys.find(key => key.startsWith('__reactFiber'));

    if (fiberKey) {
      const fiber = (element as any)[fiberKey];
      return {
        detected: true,
        fiber: {
          type: fiber.type?.name || 'Unknown',
          props: fiber.memoizedProps ? Object.keys(fiber.memoizedProps) : [],
          state: fiber.memoizedState ? 'present' : null
        }
      };
    }

    return { detected: false };
  }

  private captureValue(element: HTMLElement): string | null {
    if (element instanceof HTMLInputElement) {
      return element.value;
    }
    if (element instanceof HTMLTextAreaElement) {
      return element.value;
    }
    if (element instanceof HTMLSelectElement) {
      return element.value;
    }
    return null;
  }

  private captureText(element: HTMLElement): string | null {
    const text = element.innerText?.trim();
    return text && text.length < 500 ? text : null;
  }

  private captureCoordinates(
    e: Event
  ): { x: number; y: number; clientX: number; clientY: number } | null {
    if (e instanceof MouseEvent) {
      return {
        x: e.pageX,
        y: e.pageY,
        clientX: e.clientX,
        clientY: e.clientY
      };
    }
    return null;
  }

  // Observers
  private initializeObservers() {
    this.initMutationObserver();
    this.initIntersectionObserver();
    this.initResizeObserver();
  }

  private initMutationObserver() {
    this.observers.mutation = new MutationObserver((mutations) => {
      mutations.forEach(mutation => {
        this.currentSession.mutations.push({
          type: mutation.type,
          target: (mutation.target as HTMLElement).tagName,
          timestamp: Date.now()
        });
      });
    });

    this.observers.mutation?.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: false
    });
  }

  private initIntersectionObserver() {
    this.observers.intersection = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          // Element visible
        }
      });
    });
  }

  private initResizeObserver() {
    this.observers.resize = new ResizeObserver(entries => {
      // Detectar cambios de tamaño
    });
  }

  private stopObservers() {
    Object.values(this.observers).forEach(obs => obs?.disconnect());
  }

  // Detectar tecnologías
  detectTechnologies() {
    return {
      react: this.detectReact(),
      vue: this.detectVue(),
      angular: this.detectAngular(),
      shadowDOM: this.hasShadowDOM(),
      webComponents: this.detectWebComponents(),
      iframe: document.querySelectorAll('iframe').length > 0
    };
  }

  private detectReact(): boolean {
    return !!document.body.__reactRootContainer || 
           !!document.body.__reactFiber$ ||
           !!window.React;
  }

  private detectVue(): boolean {
    return !!document.body.__vue__ || 
           !!window.Vue;
  }

  private detectAngular(): boolean {
    return !!window.ng ||
           !!document.body.getAttribute('ng-app');
  }

  private hasShadowDOM(): boolean {
    return !!document.querySelector('[role]')?.parentElement?.shadowRoot;
  }

  private detectWebComponents(): boolean {
    return !!document.querySelectorAll(':not(:defined)').length;
  }

  getSessionData() {
    return this.currentSession;
  }
}
