# EJEMPLOS DE USO - Web Interaction Capture

## 📚 Tabla de Contenidos
1. [Ejemplo 1: Automación Gmail](#ejemplo-1-automación-gmail)
2. [Ejemplo 2: Testing ChatGPT](#ejemplo-2-testing-chatgpt)
3. [Ejemplo 3: Scraping React App](#ejemplo-3-scraping-react-app)
4. [Ejemplo 4: LinkedIn Login](#ejemplo-4-linkedin-login)
5. [Ejemplo 5: File Upload](#ejemplo-5-file-upload)

---

## Ejemplo 1: Automación Gmail

### Escenario
Automatizar: "Enviar un email"

### Pasos de Grabación

1. **Click** en botón "Compose"
2. **Type** en campo "To"
3. **Click** en campo "Subject"
4. **Type** en campo "Subject"
5. **Click** en área de contenido (iframe)
6. **Type** contenido del email
7. **Click** en botón "Send"

### Salida Markdown Generada

```markdown
# Gmail Compose Automation

## Session
- URL: https://mail.google.com/mail/
- Duration: 45 seconds
- Interactions: 7

## Interactions Captured

### 1. Click Compose Button
- **Type**: click
- **Target**: button
- **Selector CSS**: `button[aria-label="Compose"]`
- **Selector XPath**: `//button[@aria-label='Compose']`
- **Stability**: 95%
- **Selector Unico**: `[aria-label="Compose"]`

### 2. Type in To Field
- **Type**: input
- **Target**: input
- **Selector CSS**: `.dL textarea`
- **XPath**: `//textarea[@aria-label='To']`
- **Stability**: 92%
- **Value Entered**: `recipient@example.com`

### 3. Click Subject Field
- **Type**: click
- **Target**: input
- **Selector CSS**: `input[aria-label="Subject"]`
- **Stability**: 90%

### 4. Type Subject
- **Type**: input
- **Value**: `Test Subject`

### 5. Click Compose Area (iframe)
- **Type**: click
- **Target**: div (contenteditable)
- **Shadow Path**: 
  - `div.dL (shadowRoot)`
  - `div.content`
  - `div[contenteditable]`
- **Stability**: 88%

### 6. Type Email Body
- **Type**: input
- **Value**: `This is the email body`

### 7. Click Send Button
- **Type**: click
- **Target**: button
- **Selector CSS**: `button[aria-label="Send"]`
- **Stability**: 94%

## Generated Playwright Code

\`\`\`javascript
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  // Navegar a Gmail
  await page.goto('https://mail.google.com/mail/');
  
  // 1. Click Compose
  await page.click('button[aria-label="Compose"]');
  
  // Esperar que aparezca el compose area
  await page.waitForSelector('textarea[aria-label="To"]', { timeout: 5000 });
  
  // 2. Type en To
  await page.fill('textarea[aria-label="To"]', 'recipient@example.com');
  
  // 3. Click Subject
  await page.click('input[aria-label="Subject"]');
  
  // 4. Type Subject
  await page.fill('input[aria-label="Subject"]', 'Test Subject');
  
  // 5. Click Body (iframe)
  // Gmail usa iframe, necesitamos acceder a él
  const frameHandle = await page.$('iframe[name="compose-iframe"]');
  const frame = await frameHandle.contentFrame();
  
  await frame.click('div[contenteditable="true"]');
  await frame.type('div[contenteditable="true"]', 'This is the email body');
  
  // 6. Click Send
  await page.click('button[aria-label="Send"]');
  
  // Esperar confirmación
  await page.waitForNavigation({ timeout: 10000 });
  
  await browser.close();
})();
\`\`\`

## Generated Puppeteer Code

\`\`\`javascript
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  await page.goto('https://mail.google.com/mail/');
  
  // Compose
  await page.click('button[aria-label="Compose"]');
  await page.waitForSelector('textarea[aria-label="To"]');
  
  // To field
  await page.type('textarea[aria-label="To"]', 'recipient@example.com');
  
  // Subject
  await page.click('input[aria-label="Subject"]');
  await page.type('input[aria-label="Subject"]', 'Test Subject');
  
  // Body (via iframe)
  const frameHandle = await page.$('iframe[name="compose-iframe"]');
  const frame = await frameHandle.contentFrame();
  
  await frame.type('div[contenteditable="true"]', 'This is the email body');
  
  // Send
  await page.click('button[aria-label="Send"]');
  await page.waitForNavigation();
  
  await browser.close();
})();
\`\`\`

## Observations

- Gmail usa **iframe** para el compose area
- Elementos tienen **aria-labels** consistentes (estables)
- La mayoría de selectores tienen **95%+ stability**
- No detectó React (Gmail usa JavaScript vanilla)
- Mutation count fue alto (muchos cambios en DOM)

---

## Ejemplo 2: Testing ChatGPT

### Escenario
Test: "Enviar un prompt a ChatGPT y verificar respuesta"

### Audit Generado

```markdown
# ChatGPT Interaction Test

## Technologies Detected
- ✅ React
- ✅ Shadow DOM (posible)
- Next.js (inferred from bundle)

## Interactions

### Input: Type Prompt
- **Selector**: 
  - CSS: `textarea.m-0.w-full.resize-none`
  - React Component: ChatInput
  - Data-qa: `message-input`
- **Stability**: 85%
- **Value**: "Explain quantum computing"

### Network Intercept
- **Request**: POST /backend-api/conversation
- **Status**: 200
- **Response Time**: 2150ms
- **Payload Detected**: 
  - model: "gpt-4"
  - messages: [...]

### Wait for Response
- **Strategy**: MutationObserver on message container
- **Timeout**: 10000ms
- **Success**: True

### Verify Response
- **Assertion**: Text "quantum" found in response
- **Method**: Element text content matching

## Test Code (Playwright)

\`\`\`javascript
const test = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  // Setup network interception
  await page.route('**/backend-api/conversation', route => {
    route.continue();
  });
  
  // Navigate
  await page.goto('https://chat.openai.com');
  
  // Find and fill textarea
  const textarea = await page.waitForSelector('textarea[placeholder="Message ChatGPT"]');
  await textarea.fill('Explain quantum computing');
  
  // Send message (Ctrl+Enter or click send)
  await page.keyboard.press('Control+Enter');
  
  // Wait for response
  const responseBox = await page.waitForSelector(
    '.group:last-child .text-white',
    { timeout: 15000 }
  );
  
  // Verify response
  const responseText = await responseBox.textContent();
  if (!responseText.includes('quantum')) {
    throw new Error('Response does not contain expected text');
  }
  
  console.log('✅ Test passed');
  await browser.close();
};

test().catch(console.error);
\`\`\`

---

## Ejemplo 3: Scraping React App

### Escenario
Extraer datos de una tabla React

### Interacciones Capturadas

```javascript
[
  {
    type: 'click',
    target: 'tr.table-row',
    react: {
      componentName: 'TableRow',
      props: ['id', 'data', 'onClick']
    },
    selectors: {
      css: 'table tbody tr:nth-child(1)',
      react_id: 'row_123'
    }
  },
  {
    type: 'scroll',
    coordinates: { x: 0, y: 2000 },
    event: 'infinite-scroll'
  }
]
```

### Salida de Datos (JSON)

```json
{
  "sessionUrl": "https://app.example.com/table",
  "totalRows": 45,
  "rowsInteracted": 3,
  "selectors": {
    "tableHeader": "table.data-table thead",
    "tableRow": "table.data-table tbody tr",
    "cellData": "table.data-table tbody tr td"
  },
  "extractedData": [
    { "id": 1, "name": "Item 1", "price": 100 },
    { "id": 2, "name": "Item 2", "price": 200 }
  ],
  "technologies": {
    "react": true,
    "virtualList": true
  }
}
```

### Script Generado (Puppeteer)

```javascript
const extractTableData = async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  await page.goto('https://app.example.com/table');
  
  // Función para scrollear y cargar todo
  await page.evaluate(() => {
    return new Promise((resolve) => {
      let lastHeight = document.body.scrollHeight;
      const interval = setInterval(() => {
        window.scrollBy(0, window.innerHeight);
        let newHeight = document.body.scrollHeight;
        if (newHeight === lastHeight) {
          clearInterval(interval);
          resolve();
        }
        lastHeight = newHeight;
      }, 1000);
    });
  });
  
  // Extraer datos de tabla
  const data = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('table tbody tr')).map(row => ({
      id: row.cells[0]?.textContent.trim(),
      name: row.cells[1]?.textContent.trim(),
      price: row.cells[2]?.textContent.trim()
    }));
  });
  
  console.log('Extracted:', data);
  await browser.close();
  return data;
};

extractTableData();
```

---

## Ejemplo 4: LinkedIn Login

### Flujo

1. Click Email Field
2. Type Email
3. Click Password Field
4. Type Password
5. Click Sign In
6. Wait for 2FA (si aplica)
7. Wait for home page

### Audit Capturado

```markdown
# LinkedIn Login Automation

## Credentials Captured
⚠️ Warning: Email and password were captured!

## Selectors

### Email Field
\`\`\`
CSS: input#username
XPath: //input[@id='username']
Aria: [aria-label='Email address']
Stability: 98%
\`\`\`

### Password Field
\`\`\`
CSS: input#password
XPath: //input[@id='password']
Aria: [aria-label='Password']
Stability: 98%
\`\`\`

### Sign In Button
\`\`\`
CSS: button.login__form_action_container button
XPath: //button[contains(., 'Sign in')]
Stability: 92%
\`\`\`

## Generated Code (SAFE)

\`\`\`javascript
const login = async (email, password) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  await page.goto('https://linkedin.com/login');
  
  // Fill email
  await page.fill('input#username', email);
  
  // Fill password
  await page.fill('input#password', password);
  
  // Click sign in
  await page.click('button.login__form_action_container button');
  
  // Wait for navigation
  await page.waitForNavigation();
  
  // Check for 2FA
  const has2FA = await page.$('input[aria-label="Verification code"]') !== null;
  if (has2FA) {
    console.log('2FA required');
    // Handle 2FA...
  }
  
  return page;
};
\`\`\`

## Security Notes
- ⚠️ Credenciales fueron capturadas en texto plano
- ✅ No se exportan credenciales en el markdown
- 🔒 Usar variables de entorno en scripts

---

## Ejemplo 5: File Upload

### Escenario
Subir un archivo a un formulario

### Interacciones

```javascript
{
  type: 'input-file',
  target: 'input[type="file"]',
  selector: 'input#file-upload',
  acceptedFormats: '.pdf,.doc,.docx',
  multiple: true,
  fileName: 'document.pdf',
  fileSize: 2048576,
  uploadProgress: [0, 25, 50, 75, 100],
  uploadTime: 3500
}
```

### Markdown Output

```markdown
# File Upload Automation

## File Input Details
- **Selector**: `input#file-upload`
- **Accepted Types**: PDF, DOC, DOCX
- **Multiple**: Yes
- **Required**: Yes

## Upload Flow

### 1. Find Input
\`\`\`javascript
const fileInput = document.querySelector('input#file-upload');
\`\`\`

### 2. Set File (Puppeteer)
\`\`\`javascript
const inputHandle = await page.$('input#file-upload');
await inputHandle.uploadFile('/path/to/file.pdf');
\`\`\`

### 3. Monitor Progress
- Start: 0%
- 1.2s: 25%
- 2.0s: 50%
- 2.8s: 75%
- 3.5s: 100%

### 4. Verify Upload
\`\`\`javascript
const successMessage = await page.waitForSelector(
  '.upload-success',
  { timeout: 5000 }
);
const text = await successMessage.textContent();
console.log(text); // "File uploaded successfully"
\`\`\`

## Automation Code

\`\`\`javascript
const uploadFile = async (filePath) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  await page.goto('https://example.com/upload');
  
  // Method 1: Input file element
  const fileInput = await page.$('input#file-upload');
  await fileInput.uploadFile(filePath);
  
  // Method 2: Drag and drop
  const dropZone = await page.$('.drop-zone');
  await dropZone.dragAndDrop(filePath);
  
  // Wait for upload to complete
  await page.waitForSelector('.upload-success', { timeout: 10000 });
  
  const message = await page.textContent('.upload-success');
  console.log(message);
  
  await browser.close();
};

uploadFile('/path/to/document.pdf');
\`\`\`
```

---

## 📊 Comparación de Métodos de Búsqueda

Para un botón de submit en una app React:

| Método | Selector | Stability | Speed | Reliability |
|--------|----------|-----------|-------|-------------|
| ID | `#submit-btn` | 100% | ⚡⚡⚡ | ✅✅✅ |
| Data-TestID | `[data-testid='submit']` | 95% | ⚡⚡⚡ | ✅✅✅ |
| Aria | `[aria-label='Submit']` | 85% | ⚡⚡ | ✅✅ |
| CSS | `.btn.btn-primary` | 70% | ⚡⚡ | ✅ |
| Text | `//button[text()='Submit']` | 50% | ⚡ | ⚠️ |
| XPath | `//form//button[1]` | 60% | ⚡ | ✅ |
| React Fiber | `ComponentName.SubmitButton` | 90% | ⚡⚡ | ✅✅ |

---

**Ejemplos de Uso - Web Interaction Capture v1.0**

