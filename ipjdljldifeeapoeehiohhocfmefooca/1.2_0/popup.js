// Load content.csv by default on init if queue is empty
chrome.storage.local.get(['status', 'prompts', 'currentIndex', 'filenameMode'], (data) => {
  if (data.status === 'running' || (data.prompts && data.prompts.length > 0)) {
    updateUI(data);
  }
  // Init radio button
  if (data.filenameMode) {
    const radio = document.querySelector(`input[name="filenameMode"][value="${data.filenameMode}"]`);
    if (radio) radio.checked = true;
  }
});

// Save filename mode when changed
// Save filename mode when changed and update preview
document.querySelectorAll('input[name="filenameMode"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    chrome.storage.local.set({ filenameMode: e.target.value });
    // Trigger preview update
    chrome.storage.local.get(['prompts', 'currentIndex', 'status'], (data) => {
      // Re-inject the mode into data for preview function
      data.filenameMode = e.target.value;
      updatePreview(data);
    });
  });
});

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('csvFile').click();
});

document.getElementById('csvFile').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    const text = e.target.result;
    const prompts = parseCSV(text);
    addPromptsToQueue(prompts);
    // Reset file input
    event.target.value = '';
  };
  reader.readAsText(file);
});

document.getElementById('loadDefaultBtn').addEventListener('click', () => {
  loadDefaultCSV();
});

function loadDefaultCSV() {
  fetch('content.csv')
    .then(response => {
      if (!response.ok) throw new Error("Failed to load content.csv");
      return response.text();
    })
    .then(text => {
      const prompts = parseCSV(text);
      if (prompts.length > 0) {
        addPromptsToQueue(prompts);
      } else {
        document.getElementById('status').textContent = "No prompts found in content.csv.";
      }
    })
    .catch(err => {
      console.error("Error loading default CSV:", err);
      document.getElementById('status').textContent = "Error loading content.csv.";
    });
}

function addPromptsToQueue(newPrompts) {
  if (newPrompts.length === 0) {
    document.getElementById('status').textContent = "No valid prompts found.";
    return;
  }

  // Default to 'number' if not set
  chrome.storage.local.get(['filenameMode'], (data) => {
    if (!data.filenameMode) {
      chrome.storage.local.set({ filenameMode: 'number' });
    }
  });

  chrome.storage.local.get(['prompts', 'status'], (data) => {
    const currentPrompts = data.prompts || [];
    const updatedPrompts = [...currentPrompts, ...newPrompts];

    chrome.storage.local.set({
      prompts: updatedPrompts,
      currentIndex: 0, // Reset index if we are adding new batch? Or append? User likely wants append or new batch. Let's assume append but if empty start fresh.
      status: 'idle',
      results: {}
    }, () => {
      updateUI({ status: 'idle', prompts: updatedPrompts, currentIndex: 0 });
      document.getElementById('status').textContent = `Loaded ${newPrompts.length} prompts. Click Start.`;
    });
  });
}

document.getElementById('startBtn').addEventListener('click', () => {
  const prefix = document.getElementById('prefixInput').value.trim();

  chrome.storage.local.get(['prompts'], (data) => {
    let prompts = data.prompts || [];

    if (prompts.length === 0) {
      document.getElementById('status').textContent = "No prompts loaded.";
      return;
    }

    // Apply prefix if needed (Note: this modifies the stored prompts permanently for this run)
    if (prefix) {
      prompts = prompts.map(p => {
        if (typeof p === 'object' && p !== null) {
          return { ...p, text: `${prefix} ${p.text}` };
        }
        return `${prefix} ${p}`;
      });
      chrome.storage.local.set({ prompts: prompts });
    }

    chrome.storage.local.set({ status: 'running' }, () => {
      updateUI({ status: 'running', prompts: prompts, currentIndex: 0 });

      // Send message to content script to start
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { action: "START" });
        } else {
          document.getElementById('status').textContent = "No active tab found. Please open Gemini.";
        }
      });
    });
  });
});

document.getElementById('stopBtn').addEventListener('click', () => {
  chrome.storage.local.set({ status: 'stopped' }, () => {
    updateUI({ status: 'stopped' });
  });
});

document.getElementById('supportBtn').addEventListener('click', () => {
  // Use chrome.tabs.create to open in a new tab if preferred, or window.location.href to replace popup content
  // Replacing popup content keeps it contained. External links in support.html will open new tabs.
  window.location.href = 'support.html';
});

// Listen for changes
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    chrome.storage.local.get(['status', 'prompts', 'currentIndex'], (data) => {
      updateUI(data);
    });
  }
});

function updateUI(data) {
  const statusDiv = document.getElementById('status');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');

  if (data.status === 'running') {
    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusDiv.textContent = `Running: Prompt ${data.currentIndex + 1}/${(data.prompts || []).length}`;
  } else {
    startBtn.disabled = false;
    stopBtn.disabled = true;
    if (data.status === 'finished') {
      statusDiv.textContent = "Finished.";
    } else if (data.prompts && data.prompts.length > 0) {
      statusDiv.textContent = `Ready: ${data.prompts.length} prompts loaded.`;
    } else {
      statusDiv.textContent = "Ready.";
    }
  }
  // Fetch current filename mode for preview if not in data
  if (!data.filenameMode) {
    chrome.storage.local.get(['filenameMode'], (res) => {
      data.filenameMode = res.filenameMode || 'number';
      updatePreview(data);
    });
  } else {
    updatePreview(data);
  }
}

function updatePreview(data) {
  const previewDiv = document.getElementById('preview');
  const listDiv = document.getElementById('previewList');

  if (!data.prompts || data.prompts.length === 0) {
    previewDiv.style.display = 'none';
    return;
  }

  const currentIndex = data.currentIndex || 0;
  const pendingPrompts = data.prompts.slice(currentIndex);

  if (pendingPrompts.length === 0) {
    previewDiv.style.display = 'none';
    return;
  }

  previewDiv.style.display = 'block';
  let html = '';

  const toShow = pendingPrompts.slice(0, 5);
  const mode = data.filenameMode || 'number';

  toShow.forEach((p, i) => {
    const num = currentIndex + i + 1;
    let text = "";
    let displayFilename = "";

    if (typeof p === 'object') {
      text = p.text;

      // Calculate filename based on mode
      if (mode === 'number') {
        displayFilename = `${p.number || num}.jpg`;
      } else if (mode === 'name') {
        displayFilename = `${p.name || 'unknown'}.jpg`;
      } else if (mode === 'number_name') {
        displayFilename = `${p.number || num} - ${p.name || 'unknown'}.jpg`;
      }
    } else {
      text = p;
      displayFilename = `${num}.jpg`;
    }

    const truncated = text.length > 60 ? text.substring(0, 60) + '...' : text;
    html += `<div style="margin-bottom: 4px;"><strong>${num}.</strong> ${truncated}<span style="color:#1a73e8; font-size: 0.9em; margin-left: 5px;">[${displayFilename}]</span></div>`;
  });

  if (pendingPrompts.length > 5) {
    html += `<div style="font-style: italic; margin-top: 4px;">+ ${pendingPrompts.length - 5} more...</div>`;
  }

  listDiv.innerHTML = html;
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
        currentField += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === ',' && !insideQuotes) {
      currentRow.push(currentField);
      currentField = '';
    } else if ((char === '\r' || char === '\n') && !insideQuotes) {
      if (char === '\r' && nextChar === '\n') i++;
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

  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField);
    if (currentRow.length > 0) rows.push(currentRow);
  }

  if (rows.length === 0) return [];

  // Strict parsing: Number, Prompt, Name
  const parsedItems = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    // Skip header likely if it contains "prompt" or "number" text in first row and we are at index 0
    if (i === 0) {
      const rowStr = row.join('').toLowerCase();
      if (rowStr.includes('prompt') && rowStr.includes('number')) continue;
    }

    // Default structure: Col 0 = Number, Col 1 = Prompt, Col 2 = Name
    // If fewer columns, fallback generously
    let number = null;
    let pText = "";
    let name = null;

    if (row.length >= 3) {
      number = row[0].trim();
      pText = row[1].trim();
      name = row[2].trim();
    } else if (row.length === 2) {
      // Assume Number, Prompt
      number = row[0].trim();
      pText = row[1].trim();
    } else if (row.length === 1) {
      // Just Prompt
      pText = row[0].trim();
    }

    if (pText) {
      parsedItems.push({
        text: pText,
        number: number,
        name: name
      });
    }
  }

  return parsedItems;
}
