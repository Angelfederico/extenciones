(function () {
    let isRunning = false;
    if (window !== window.top) return;

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "START") {
            console.log("Gemini Automator: Received START command");
            isRunning = true;
            processNextPrompt();
        } else if (request.action === "QUEUE_UPDATED") {
            console.log(`Gemini Automator: Queue updated! Added ${request.count} prompts. Total now: ${request.total}`);
        }
    });

    // Check status and resume on load
    chrome.storage.local.get(['status', 'prompts', 'globalIndex'], (data) => {
        console.log("Gemini Automator: Initialization check:", data);

        // ALWAYS clear queue on refresh as per user request, BUT preserve generatedImages for download
        // Reset globalIndex to 0 on refresh if that's the desired behavior for a "fresh start"
        console.log("Gemini Automator: Clearing queue on refresh (preserving images).");
        chrome.storage.local.set({ prompts: [], globalIndex: 0, status: 'idle', results: {} });

        // Update UI to show empty state
        setTimeout(updateQueueDisplay, 1000);
    });

    async function processNextPrompt() {
        const data = await chrome.storage.local.get(['prompts', 'globalIndex', 'status']);
        const prompts = data.prompts || [];
        let globalIndex = data.globalIndex || 0;

        if (data.status !== 'running') {
            console.log("Gemini Automator: Stopped.");
            return;
        }

        // SAFETY CHECK: Is Gemini already busy?
        if (isGenerating()) {
            console.log("Gemini Automator: Gemini is currently busy (generating). Waiting 2 seconds...");
            setTimeout(processNextPrompt, 2000);
            return;
        }

        if (prompts.length === 0) {
            console.log("Gemini Automator: Queue empty. All prompts finished.");
            await chrome.storage.local.set({ status: 'finished' });
            updateQueueDisplay(); // Update UI to remove "Processing" state
            return;
        }

        // Process the FIRST item in the queue
        const promptItem = prompts[0];

        // Handle both legacy string prompts and new object prompts
        let promptText = "";
        let csvFilename = null;

        if (typeof promptItem === 'object' && promptItem !== null) {
            promptText = promptItem.text || "";
            csvFilename = promptItem.filename || null;
        } else {
            promptText = String(promptItem);
        }

        // Determine config mode
        const mode = (await chrome.storage.local.get(['filenameMode'])).filenameMode || 'number'; // default
        let customFilename = null;

        // Extract potential filename parts
        const numPart = promptItem.number || String(globalIndex + 1);
        const namePart = promptItem.name || 'unknown';

        if (mode === 'number') {
            customFilename = `${numPart}.jpg`;
        } else if (mode === 'name') {
            customFilename = `${namePart}.jpg`;
        } else if (mode === 'number_name') {
            customFilename = `${numPart} - ${namePart}.jpg`;
        }
        // Fallback or explicit 'ai' mode (if we kept it, but user removed it from UI, so unlikely to be used)
        // If mode is somehow 'ai', we could keep the old logic or just default to number. 
        // Given strict requirement, let's stick to the 3 modes.

        console.log(`Gemini Automator: Processing prompt (Global Index ${globalIndex + 1}): "${promptText.substring(0, 30)}..." [Mode: ${mode}, File: ${customFilename || "Auto"}]`);
        updateQueueDisplay();

        // 1. Input Prompt
        const inputSuccess = await insertPrompt(promptText);
        if (!inputSuccess) {
            console.error("Gemini Automator: Could not find input box. Retrying in 5 seconds...");
            setTimeout(processNextPrompt, 5000);
            return;
        }

        // 2. Wait for generation
        console.log("Gemini Automator: Waiting for generation...");
        window.scrollTo(0, document.body.scrollHeight);

        const generationSuccess = await waitForGeneration();
        if (!generationSuccess) {
            console.warn("Gemini Automator: Generation timed out or failed.");
        } else {
            console.log("Gemini Automator: Generation completed successfully.");
        }

        // 3. Download Image
        await new Promise(r => setTimeout(r, 2000)); // Buffer

        // Single robust attempt (findAndDownloadImage now handles fetch/fallback internally)
        const downloadResult = await findAndDownloadImage(globalIndex, customFilename);

        let imageFilename = downloadResult ? downloadResult.filename : null;
        let imageUrl = downloadResult ? downloadResult.imageUrl : null;

        if (!imageFilename || imageFilename.startsWith("Failed")) {
            imageFilename = imageFilename || "Failed";
            console.error(`Gemini Automator: Download failed for index ${globalIndex}: ${imageFilename}`);
            // We continue anyway, as requested by user ("keep going")
        }

        // Store result
        const results = data.results || {};
        results[globalIndex] = imageFilename;

        // Store image URL for bulk download
        if (imageUrl) {
            const generatedImages = (await chrome.storage.local.get(['generatedImages'])).generatedImages || [];
            generatedImages.push({
                index: globalIndex,
                prompt: promptText,
                filename: imageFilename,
                url: imageUrl,
                timestamp: Date.now()
            });
            await chrome.storage.local.set({ generatedImages: generatedImages });
            console.log(`Gemini Automator: Saved image URL for index ${globalIndex}`);
        }

        await chrome.storage.local.set({ results: results });
        console.log(`Gemini Automator: Result stored for index ${globalIndex}: ${imageFilename}`);

        // 4. POP the prompt from the queue and increment globalIndex (ALWAYS)
        prompts.shift(); // Remove the first element
        await chrome.storage.local.set({
            prompts: prompts,
            globalIndex: globalIndex + 1
        });

        console.log("Gemini Automator: Prompt removed from queue. Moving to next...");
        processNextPrompt();
    }

    function isGenerating() {
        const stopBtn = document.querySelector('button[aria-label="Stop response"]');
        const thinkingAvatar = document.querySelector('.bard-avatar.thinking');
        const textLoader = document.querySelector('.gpi-static-text-loader');
        const processingContainer = document.querySelector('.processing-state_container--processing');
        const loadingSpan = document.querySelector('span[aria-label="Loading"]');
        const justASec = Array.from(document.querySelectorAll('span')).find(el => el.textContent.includes("Just a sec..."));

        return !!(stopBtn || thinkingAvatar || textLoader || processingContainer || loadingSpan || justASec);
    }

    function downloadResultsCSV(prompts) {
        chrome.storage.local.get(['results'], (data) => {
            const results = data.results || {};
            let csvContent = "Prompt,Image Path\n";

            prompts.forEach((prompt, index) => {
                const safePrompt = `"${prompt.replace(/"/g, '""')}"`;
                const filename = results[index] || "Not Found";
                const safeFilename = `"${filename.replace(/"/g, '""')}"`;
                csvContent += `${safePrompt},${safeFilename}\n`;
            });

            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);

            chrome.runtime.sendMessage({
                action: "download",
                url: url,
                index: "results"
            }, (response) => {
                if (response && response.success) {
                    console.log("Results CSV downloaded.");
                }
            });
        });
    }

    async function waitForGeneration() {
        let attempts = 0;
        const maxAttempts = 300; // 5 minutes
        let seenLoading = false;
        let stableCount = 0;
        const requiredStableCount = 10; // Increased from 5 to 10 seconds for better stability

        return new Promise((resolve) => {
            const interval = setInterval(() => {
                attempts++;

                // Indicators that generation is happening
                const stopBtn = document.querySelector('button[aria-label="Stop response"]');
                const thinkingAvatar = document.querySelector('.bard-avatar.thinking');
                const textLoader = document.querySelector('.gpi-static-text-loader');
                const processingContainer = document.querySelector('.processing-state_container--processing');
                const loadingSpan = document.querySelector('span[aria-label="Loading"]');

                // Check for specific text content "Just a sec..."
                const justASec = Array.from(document.querySelectorAll('span')).find(el => el.textContent.includes("Just a sec..."));

                const loadingEl = stopBtn || thinkingAvatar || textLoader || processingContainer || loadingSpan || justASec;

                // Indicators that generation is DONE (positive confirmation)
                const showMoreBtn = document.querySelector('button[aria-label*="Show more"]'); // Often appears after
                const regenerateBtn = document.querySelector('button[aria-label*="Regenerate"]'); // Often appears after
                const modifyResponseBtn = document.querySelector('button[aria-label*="Modify response"]');

                if (loadingEl) {
                    if (!seenLoading) {
                        console.log("Gemini Automator: Detected generation activity...", loadingEl);
                        seenLoading = true;
                    }
                    stableCount = 0; // Reset stability if we see loading again
                } else {
                    if (seenLoading) {
                        // We saw loading, now it's gone. Is it really done?
                        stableCount++;
                        console.log(`Gemini Automator: No loading indicator. Stability: ${stableCount}/${requiredStableCount}`);

                        // Early exit if we see positive completion indicators
                        if (showMoreBtn || regenerateBtn || modifyResponseBtn) {
                            console.log("Gemini Automator: Found completion buttons. Generation finished.");
                            clearInterval(interval);
                            resolve(true);
                            return;
                        }

                        if (stableCount >= requiredStableCount) {
                            console.log("Gemini Automator: Generation finished (stable).");
                            clearInterval(interval);
                            resolve(true);
                            return;
                        }
                    } else {
                        // Haven't seen loading yet.
                        if (attempts > 15) { // Wait 15 seconds for it to START
                            // If we see a download button, maybe we missed the loading phase?
                            const downloadBtn = document.querySelector('mat-icon[fonticon="download"]');
                            if (downloadBtn) {
                                console.log("Gemini Automator: Found download icon (fallback success).");
                                clearInterval(interval);
                                resolve(true);
                                return;
                            }
                        }
                    }
                }

                if (attempts >= maxAttempts) {
                    console.log("Gemini Automator: Timed out waiting for generation.");
                    clearInterval(interval);
                    resolve(false);
                }
            }, 1000);
        });
    }

    async function insertPrompt(text) {
        // Robust selectors based on user feedback
        const selectors = [
            '.ql-editor.textarea',
            'div[aria-label="Enter a prompt here"]',
            'div[contenteditable="true"]',
            'div[role="textbox"]',
            'rich-textarea p'
        ];

        let inputEl = null;
        for (const sel of selectors) {
            inputEl = document.querySelector(sel);
            if (inputEl) {
                console.log("Gemini Automator: Found input:", sel);
                break;
            }
        }

        if (!inputEl) return false;

        inputEl.focus();

        // Try execCommand first
        const success = document.execCommand('insertText', false, text);
        if (!success) {
            inputEl.innerText = text;
        }

        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 1200)); // Increased wait to 1.2s

        // Press Enter
        const enterEvent = new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'Enter',
            code: 'Enter',
            keyCode: 13
        });
        inputEl.dispatchEvent(enterEvent);

        // Click Send button if available (backup to Enter)
        setTimeout(() => {
            const sendBtn = document.querySelector('button[aria-label*="Send"]');
            if (sendBtn && !sendBtn.disabled) {
                console.log("Gemini Automator: Clicking Send button...");
                sendBtn.click();
            }
        }, 2000);

        return true;
    }

    async function findAndDownloadImage(index, customFilename = null) {
        console.log(`Gemini Automator: Starting image download for prompt index ${index}...`);

        let downloadBtn = null;
        let imageUrl = null;
        let responseContainer = null;

        // Wait for the image or button to appear
        for (let i = 0; i < 10; i++) {
            const responseContainers = document.querySelectorAll('response-container');
            if (responseContainers.length > 0) {
                responseContainer = responseContainers[responseContainers.length - 1];

                // 1. Try to find the image URL (Prioritize this)
                const images = responseContainer.querySelectorAll('img');
                for (const img of images) {
                    if (img.src && img.src.startsWith('http') && !img.src.includes('googleusercontent.com/a/') && !img.classList.contains('bard-avatar')) {
                        imageUrl = img.src;
                        console.log("Gemini Automator: Found candidate image URL:", imageUrl);
                        break;
                    }
                }

                // 2. Find download button as fallback
                downloadBtn = responseContainer.querySelector('button[aria-label="Download full size image"]');

                if (imageUrl || downloadBtn) break;
            }
            await new Promise(r => setTimeout(r, 1000));
        }

        // Determine final filename
        let finalFilename = `${index + 1}.jpg`;
        if (customFilename) {
            // Sanitize
            let safeName = customFilename.replace(/[^a-z0-9_\-\. ]/gi, '_');
            if (!safeName.toLowerCase().endsWith('.jpg') && !safeName.toLowerCase().endsWith('.png')) {
                safeName += '.jpg';
            }
            finalFilename = safeName;
        }

        // STRATEGY 1: Direct Download via Background Script (Bypass CORS)
        if (imageUrl) {
            console.log(`Gemini Automator: Attempting direct download for URL: ${imageUrl} as ${finalFilename}`);

            return new Promise((resolve) => {
                chrome.runtime.sendMessage({
                    action: "download",
                    url: imageUrl,
                    filename: finalFilename,
                    index: index
                }, (bgResponse) => {
                    if (chrome.runtime.lastError) {
                        console.error("Gemini Automator: Runtime error:", chrome.runtime.lastError.message);
                        // If direct download fails, try button click as fallback
                        if (downloadBtn) {
                            console.log("Gemini Automator: Direct download failed, falling back to button click...");
                            resolve(clickDownloadButton(downloadBtn));
                        } else {
                            resolve({ filename: "Failed (Runtime Error)", imageUrl: imageUrl });
                        }
                    } else if (bgResponse && bgResponse.success) {
                        console.log(`Gemini Automator: Direct download SUCCESS for ${finalFilename}`);
                        resolve({ filename: finalFilename, imageUrl: imageUrl });
                    } else {
                        console.error("Gemini Automator: Direct download FAILED:", bgResponse ? bgResponse.error : "Unknown error");
                        // If direct download fails, try button click as fallback
                        if (downloadBtn) {
                            console.log("Gemini Automator: Direct download failed, falling back to button click...");
                            resolve(clickDownloadButton(downloadBtn));
                        } else {
                            resolve({ filename: "Failed (Background Error)", imageUrl: imageUrl });
                        }
                    }
                });
            });
        }

        // STRATEGY 2: Click Download Button (Fallback)
        if (downloadBtn) {
            return clickDownloadButton(downloadBtn);
        }

        console.error("Gemini Automator: No image or download button found.");
        return { filename: "Failed (Not Found)", imageUrl: null };
    }

    async function clickDownloadButton(downloadBtn) {
        console.log("Gemini Automator: Clicking download button (Fallback)...");
        downloadBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await new Promise(r => setTimeout(r, 1000));

        if (downloadBtn.disabled) {
            console.error("Gemini Automator: Download button is disabled.");
            return { filename: "Failed (Disabled)", imageUrl: null };
        }

        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: "waitForNextDownload" }, (response) => {
                if (response && response.success) {
                    console.log("Gemini Automator: Button click download SUCCESS:", response.filename);
                    resolve({ filename: response.filename, imageUrl: null });
                } else {
                    console.error("Gemini Automator: Button click download FAILED or Timed out.");
                    resolve({ filename: "Failed (Button Click)", imageUrl: null });
                }
            });
            downloadBtn.click();
        });
    }

    console.log("Gemini Automator: Content script v2 loaded.");

    // --- Queue UI Injection ---

    function setupQueueUI() {
        // Observer to find the input area and inject UI
        const observer = new MutationObserver((mutations) => {
            const sendBtn = document.querySelector('button[aria-label*="Send"]');
            if (sendBtn && !document.getElementById('gemini-automator-queue-btn')) {
                injectQueueButton(sendBtn);
            }

            // Also try to find a place for the queue list
            // refined selector to ensure we get the main chat container area
            const inputArea = document.querySelector('.ql-editor.textarea') || document.querySelector('rich-textarea');
            if (inputArea && !document.getElementById('gemini-automator-queue-list')) {
                injectQueueList(inputArea);
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    function injectQueueButton(sendBtn) {
        console.log("Gemini Automator: Injecting Queue button...");

        // Container for our buttons
        const btnContainer = document.createElement('div');
        btnContainer.style.cssText = `
        display: flex;
        align-items: center;
        margin-right: 8px;
    `;

        // Queue Button
        const queueBtn = document.createElement('button');
        queueBtn.id = 'gemini-automator-queue-btn';
        queueBtn.textContent = 'Queue';
        queueBtn.style.cssText = `
        background: linear-gradient(135deg, #fbbc04 0%, #f9ab00 100%);
        color: #202124;
        border: none;
        border-radius: 20px;
        padding: 0 20px;
        font-weight: 600;
        cursor: pointer;
        height: 48px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-right: 8px;
        box-shadow: 0 2px 5px rgba(0,0,0,0.2);
        transition: transform 0.1s ease, box-shadow 0.1s ease;
        font-family: 'Google Sans', Roboto, sans-serif;
    `;
        queueBtn.onmouseover = () => { queueBtn.style.transform = 'translateY(-1px)'; queueBtn.style.boxShadow = '0 4px 8px rgba(0,0,0,0.3)'; };
        queueBtn.onmouseout = () => { queueBtn.style.transform = 'translateY(0)'; queueBtn.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)'; };
        queueBtn.addEventListener('click', handleQueueClick);

        // Clear Button
        const clearBtn = document.createElement('button');
        clearBtn.id = 'gemini-automator-clear-btn';
        clearBtn.textContent = 'Clear';
        clearBtn.style.cssText = `
        background-color: rgba(60, 64, 67, 0.8);
        color: #e8eaed;
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 20px;
        padding: 0 16px;
        font-weight: 500;
        cursor: pointer;
        height: 48px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-right: 8px;
        backdrop-filter: blur(4px);
        transition: background-color 0.2s;
    `;
        clearBtn.onmouseover = () => clearBtn.style.backgroundColor = 'rgba(60, 64, 67, 1)';
        clearBtn.onmouseout = () => clearBtn.style.backgroundColor = 'rgba(60, 64, 67, 0.8)';
        clearBtn.addEventListener('click', handleClearQueue);

        // Download All Button
        const downloadAllBtn = document.createElement('button');
        downloadAllBtn.id = 'gemini-automator-download-all-btn';
        downloadAllBtn.textContent = 'Download All';
        downloadAllBtn.style.cssText = `
        background: linear-gradient(135deg, #a142f4 0%, #8a2be2 100%);
        color: #ffffff;
        border: none;
        border-radius: 20px;
        padding: 0 16px;
        font-weight: 500;
        cursor: pointer;
        height: 48px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 2px 5px rgba(0,0,0,0.2);
        transition: transform 0.1s ease;
    `;
        downloadAllBtn.onmouseover = () => downloadAllBtn.style.transform = 'scale(1.02)';
        downloadAllBtn.onmouseout = () => downloadAllBtn.style.transform = 'scale(1)';
        downloadAllBtn.addEventListener('click', handleDownloadAll);

        btnContainer.appendChild(queueBtn);
        btnContainer.appendChild(clearBtn);
        btnContainer.appendChild(downloadAllBtn);

        // Insert before the send button container or the button itself
        const container = sendBtn.parentElement;
        container.insertBefore(btnContainer, sendBtn);
    }



    async function handleDownloadAll() {
        const data = await chrome.storage.local.get(['generatedImages']);
        let images = data.generatedImages || [];

        // Fallback: Scrape page if no stored images found
        if (images.length === 0) {
            console.log("Gemini Automator: No stored images. Scraping page...");
            const responseContainers = document.querySelectorAll('response-container');
            let index = 0;

            responseContainers.forEach(container => {
                const imgs = container.querySelectorAll('img');
                imgs.forEach(img => {
                    // Filter for likely generated images (large, hosted on googleusercontent, not avatars)
                    if (img.src && img.src.startsWith('http') &&
                        !img.src.includes('googleusercontent.com/a/') &&
                        !img.classList.contains('bard-avatar') &&
                        img.width > 100) { // Basic size check

                        images.push({
                            index: index++,
                            url: img.src,
                            filename: `scraped_image_${index}.jpg`
                        });
                    }
                });
            });
        }

        if (images.length === 0) {
            alert("No images found to download (checked storage and page).");
            return;
        }

        if (!confirm(`Found ${images.length} images. Download all?`)) {
            return;
        }

        console.log("Gemini Automator: Starting bulk download...", images);

        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            if (img.url) {
                console.log(`Gemini Automator: Downloading image ${i + 1}/${images.length}...`);

                // Use stored filename if available, otherwise fallback
                const filename = img.filename || `${i + 1}.jpg`;

                // Use chrome.downloads via background script
                try {
                    chrome.runtime.sendMessage({
                        action: "download",
                        url: img.url,
                        index: img.index,
                        filename: filename
                    }, (response) => {
                        if (chrome.runtime.lastError) {
                            console.error("Gemini Automator: Bulk download error:", chrome.runtime.lastError.message);
                        }
                    });
                } catch (e) {
                    console.error("Gemini Automator: Bulk download failed:", e);
                    if (e.message.includes("Extension context invalidated")) {
                        alert("Gemini Automator: Extension updated. Please refresh this page to continue.");
                        break; // Stop the loop
                    }
                }

                // Small delay to prevent overwhelming the browser
                await new Promise(r => setTimeout(r, 500));
            }
        }
    }



    function parseCSV(text) {
        // Robust CSV parser handling quoted fields with newlines
        const rows = [];
        let currentRow = [];
        let currentField = '';
        let insideQuotes = false;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            const nextChar = text[i + 1];

            if (char === '"') {
                if (insideQuotes && nextChar === '"') {
                    // Escaped quote
                    currentField += '"';
                    i++; // Skip next quote
                } else {
                    // Toggle quote state
                    insideQuotes = !insideQuotes;
                }
            } else if (char === ',' && !insideQuotes) {
                // End of field
                currentRow.push(currentField);
                currentField = '';
            } else if ((char === '\r' || char === '\n') && !insideQuotes) {
                // End of row
                if (char === '\r' && nextChar === '\n') i++; // Handle CRLF

                currentRow.push(currentField);
                if (currentRow.length > 0 && (currentRow.length > 1 || currentRow[0] !== '')) {
                    rows.push(currentRow);
                }
                currentRow = [];
                currentField = '';
            } else {
                currentField += char;
            }
        }

        // Last row
        if (currentField || currentRow.length > 0) {
            currentRow.push(currentField);
            if (currentRow.length > 0) rows.push(currentRow);
        }

        return rows;
    }

    function injectQueueList(inputArea) {
        // Try to find a good container above the input
        const container = inputArea.closest('.input-area') || inputArea.parentElement.parentElement;

        if (container) {
            const listDiv = document.createElement('div');
            listDiv.id = 'gemini-automator-queue-list';
            // Sleek, modern, glassmorphism style
            listDiv.style.cssText = `
            margin-bottom: 16px;
            padding: 16px;
            background: rgba(20, 20, 22, 0.65);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            color: #e3e3e3;
            border-radius: 16px;
            font-size: 14px;
            display: none; /* Hidden by default */
            border: 1px solid rgba(255, 255, 255, 0.08);
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
            font-family: 'Google Sans', Roboto, sans-serif;
            max-width: 800px;
            width: 100%;
            margin-left: auto;
            margin-right: auto;
            transition: all 0.3s ease;
        `;
            container.insertBefore(listDiv, container.firstChild);
            updateQueueDisplay(); // Initial check
        }
    }

    async function handleQueueClick(e) {
        e.preventDefault();
        e.stopPropagation();

        // Get text from input
        const selectors = [
            '.ql-editor.textarea',
            'div[aria-label="Enter a prompt here"]',
            'div[contenteditable="true"]',
            'div[role="textbox"]',
            'rich-textarea p'
        ];

        let inputEl = null;
        let text = "";

        for (const sel of selectors) {
            inputEl = document.querySelector(sel);
            if (inputEl && inputEl.innerText.trim()) {
                text = inputEl.innerText.trim();
                break;
            }
        }

        if (!text) {
            alert("Gemini Automator: Please enter some text to queue.");
            return;
        }

        // Detect CSV format (heuristics: multi-line AND contains commas)
        // Or if checking strictly, try parsing it.
        let newItems = [];

        // Simple heuristic: If multiple lines, try parsing as CSV
        if (text.includes('\n')) {
            const rows = parseCSV(text);
            // Expectation: Col 0 = Filename, Col 1 = Prompt
            // Verification: If rows have >= 2 columns, treat as CSV.
            // If mostly 1 column, treat as bulk prompts (1 per line).

            const hasMultipleCols = rows.some(r => r.length >= 2);

            if (hasMultipleCols) {
                console.log("Gemini Automator: Detected CSV input.");
                newItems = rows.map(row => {
                    // Configurable Format: Question, Prompt, Download_Title (3 cols)
                    // Let's stick to the user request: Question (0), Prompt (1), Title (2)

                    let promptText = "";
                    let filename = null; // Default to null, will be set if 3rd column exists

                    if (row.length >= 2) {
                        // New Logic: Col 0 = Filename, Col 1 = Prompt
                        filename = row[0] ? row[0].trim() : null;
                        promptText = row[1] ? row[1].trim() : "";
                    } else {
                        // If 1 column, treat as just a prompt
                        promptText = row[0] ? row[0].trim() : "";
                        filename = null;
                    }

                    return {
                        text: promptText,
                        filename: filename,
                        type: 'csv'
                    };
                }).filter(item => item.text && item.text.length > 0);
            } else {
                console.log("Gemini Automator: Detected bulk text input (one prompt per line).");
                newItems = rows.flat().map(t => ({
                    text: t.trim(),
                    filename: null, // Auto-generate
                    type: 'simple'
                })).filter(item => item.text.length > 0);
            }
        } else {
            // Single line
            newItems = [{
                text: text,
                filename: null,
                type: 'simple'
            }];
        }

        if (newItems.length === 0) return;

        // Add to storage
        const data = await chrome.storage.local.get(['prompts', 'status']);
        const currentPrompts = data.prompts || [];

        // Append new items
        const updatedPrompts = [...currentPrompts, ...newItems];

        // If not running, set status to running and start!
        let newStatus = data.status;
        if (data.status !== 'running') {
            newStatus = 'running';
            console.log("Gemini Automator: Queue was empty/stopped. Starting automation now!");
        }

        await chrome.storage.local.set({
            prompts: updatedPrompts,
            status: newStatus
        });

        // Clear input
        if (inputEl) {
            inputEl.innerText = '';
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        }

        console.log(`Gemini Automator: Queued ${newItems.length} items.`);
        updateQueueDisplay();

        // If we just started it, kick off the process
        if (newStatus === 'running' && data.status !== 'running') {
            processNextPrompt();
        }
    }

    async function handleClearQueue(e) {
        e.preventDefault();
        e.stopPropagation();

        if (confirm("Are you sure you want to clear the entire queue and all generated image links?")) {
            await chrome.storage.local.set({ prompts: [], globalIndex: 0, status: 'idle', results: {}, generatedImages: [] });
            updateQueueDisplay();
            console.log("Gemini Automator: Queue cleared by user.");
        }
    }

    async function updateQueueDisplay() {
        const listDiv = document.getElementById('gemini-automator-queue-list');
        if (!listDiv) return;

        const data = await chrome.storage.local.get(['prompts', 'status']);
        const prompts = data.prompts || [];
        const isRunning = data.status === 'running';

        let html = '';

        // Header with stats
        html += `<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px;">
        <span style="font-weight: 600; color: #a8c7fa; display: flex; align-items: center; gap: 6px;">
            ${isRunning ? '<span style="display:inline-block; width:8px; height:8px; background:#4caf50; border-radius:50%; box-shadow: 0 0 8px #4caf50;"></span>' : '<span style="display:inline-block; width:8px; height:8px; background:#fbbc04; border-radius:50%;"></span>'}
            ${isRunning ? 'Running' : 'Idle'}
        </span>
        <span style="font-size: 12px; color: #9aa0a6;">${prompts.length} Pending</span>
    </div>`;

        // 1. Show Active/Processing Item (The first item in the queue if running)
        if (isRunning && prompts.length > 0) {
            const currentItem = prompts[0];
            // Handle both object and string format (legacy support)
            const currentText = typeof currentItem === 'object' ? currentItem.text : currentItem;
            const currentFile = typeof currentItem === 'object' && currentItem.filename ? currentItem.filename : '(Auto)';

            const truncated = currentText.length > 80 ? currentText.substring(0, 80) + '...' : currentText;

            html += `<div style="margin-bottom: 12px; background: rgba(138, 180, 248, 0.1); border-left: 3px solid #8ab4f8; padding: 10px; border-radius: 0 8px 8px 0;">
                    <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #8ab4f8; margin-bottom: 4px; font-weight: 700;">Currently Processing</div>
                    <div style="color: #fff; font-size: 14px; line-height: 1.4;">${truncated}</div>
                    <div style="font-size: 11px; color: #9aa0a6; margin-top: 4px; display: flex; align-items: center; gap: 4px;">
                        <span style="opacity:0.7">Filename:</span> <code style="background:rgba(255,255,255,0.1); padding: 1px 4px; border-radius: 4px;">${currentFile}</code>
                    </div>
                 </div>`;
        }

        // 2. Show Pending Queue
        let queueStartIndex = isRunning ? 1 : 0;
        const queuePrompts = prompts.slice(queueStartIndex);
        const pendingCount = queuePrompts.length;

        if (pendingCount > 0) {
            html += `<div style="max-height: 150px; overflow-y: auto; padding-right: 4px;">`;

            // Show next prompts
            queuePrompts.slice(0, 5).forEach((p, i) => {
                const pText = typeof p === 'object' ? p.text : p;
                const pFile = typeof p === 'object' && p.filename ? p.filename : '';

                const truncated = pText.length > 60 ? pText.substring(0, 60) + '...' : pText;

                html += `<div style="margin-top: 6px; padding: 8px; background: rgba(255,255,255,0.03); border-radius: 8px; display: flex; flex-direction: column;">
                        <div style="display:flex; justify-content:space-between; font-size: 11px; color: #9aa0a6; margin-bottom: 2px;">
                            <span>#${queueStartIndex + i + 1}</span>
                            ${pFile ? `<span style="font-family:monospace; opacity:0.8;">${pFile}</span>` : ''}
                        </div>
                        <div style="color: #e3e3e3; font-size: 13px;">${truncated}</div>
                     </div>`;
            });

            if (queuePrompts.length > 5) {
                html += `<div style="margin-top:8px; text-align: center; font-size: 12px; color: #9aa0a6; font-style: italic;">+ ${queuePrompts.length - 5} more items...</div>`;
            }

            html += `</div>`;
        } else {
            if (!isRunning && prompts.length === 0) {
                // Completely empty and idle
                listDiv.style.display = 'none';
                return;
            } else if (isRunning && pendingCount === 0) {
                html += `<div style="margin-top:12px; text-align: center; color: #9aa0a6; font-style: italic; padding: 10px; border-radius: 8px; border: 1px dashed rgba(255,255,255,0.1);">Last item processing. Queue empty.</div>`;
            }
        }

        listDiv.style.display = 'block';
        listDiv.innerHTML = html;
    }

    // Start the UI injection
    setupQueueUI();
})();
