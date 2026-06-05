const uploadedFilesRegistry = {};
const pendingGeminiPreviewResolvers = new Map();

function generateGeminiRunToken(prefix = 'gemini-run') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function waitForGeminiPreviewByToken(runToken, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    if (!runToken) {
      reject(new Error('Thiếu runToken để chờ kết quả Gemini.'));
      return;
    }

    const timeoutId = setTimeout(() => {
      pendingGeminiPreviewResolvers.delete(runToken);
      reject(new Error('Hết thời gian chờ Gemini trả kết quả cho batch hiện tại.'));
    }, Math.max(1000, timeoutMs));

    pendingGeminiPreviewResolvers.set(runToken, {
      resolve: (payload) => {
        clearTimeout(timeoutId);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timeoutId);
        reject(error instanceof Error ? error : new Error(String(error || 'Gemini run failed')));
      }
    });
  });
}

function getAudioDurationSeconds(file) {
  return new Promise((resolve) => {
    if (!(file instanceof File)) {
      resolve(0);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const audio = new Audio();

    const finalize = (value) => {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch (e) { }
      resolve(Number.isFinite(value) && value > 0 ? value : 0);
    };

    audio.preload = 'metadata';
    audio.onloadedmetadata = () => finalize(audio.duration);
    audio.onerror = () => finalize(0);
    audio.src = objectUrl;
  });
}

function getVideoDurationSeconds(file) {
  return new Promise((resolve) => {
    if (!(file instanceof File)) {
      resolve(0);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');

    const finalize = (value) => {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch (e) { }
      resolve(Number.isFinite(value) && value > 0 ? value : 0);
    };

    video.preload = 'metadata';
    video.onloadedmetadata = () => finalize(video.duration);
    video.onerror = () => finalize(0);
    video.src = objectUrl;
  });
}

function formatSecondsToTimecode(totalSeconds) {
  const value = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hh = String(Math.floor(value / 3600)).padStart(2, '0');
  const mm = String(Math.floor((value % 3600) / 60)).padStart(2, '0');
  const ss = String(value % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function stripMarkdownCodeFences(text) {
  const safe = String(text || '').trim();
  if (!safe) return '';
  return safe
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
}

function extractTopLevelJsonObjects(text) {
  const input = stripMarkdownCodeFences(text);
  if (!input) return [];

  const chunks = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
      }

      if (depth === 0 && start >= 0) {
        chunks.push(input.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return chunks;
}

function parseSceneObjectsFromText(text) {
  const rawObjects = extractTopLevelJsonObjects(text);
  const scenes = [];

  for (const raw of rawObjects) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const sceneNumber = Number(parsed.scene_number);
      if (!Number.isFinite(sceneNumber)) continue;
      scenes.push(parsed);
    } catch (e) { }
  }

  return scenes;
}

function formatSceneObjects(sceneObjects) {
  const list = Array.isArray(sceneObjects) ? sceneObjects : [];
  return list
    .map(scene => JSON.stringify(scene, null, 2))
    .join('\n\n')
    .trim();
}

function parseDurationToSeconds(durationText) {
  const raw = String(durationText || '').trim().toLowerCase();
  if (!raw) return 60;

  // Support values like: "60s", "1 phút", "5-10 phút", "3 min"
  const rangeMatch = raw.match(/(\d+(?:\.\d+)?)\s*[-~]\s*(\d+(?:\.\d+)?)/);
  const pickValue = rangeMatch
    ? Math.max(Number(rangeMatch[1]), Number(rangeMatch[2]))
    : (Number(raw.match(/\d+(?:\.\d+)?/)?.[0]) || 0);

  if (!Number.isFinite(pickValue) || pickValue <= 0) return 60;

  const isMinute = /(ph[uú]t|min|minute|minutes|m\b)/i.test(raw) && !/(ms|millisecond)/i.test(raw);
  const isSecond = /(gi[aâ]y|sec|second|seconds|s\b)/i.test(raw);

  if (isMinute && !isSecond) {
    return Math.max(8, Math.round(pickValue * 60));
  }

  return Math.max(8, Math.round(pickValue));
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('FileReader error'));
    reader.readAsDataURL(file);
  });
}

async function serializeFilesForMessage(files) {
  const list = Array.isArray(files) ? files : [];
  const result = [];

  for (const file of list) {
    if (!(file instanceof File)) continue;
    try {
      const dataUrl = await fileToDataUrl(file);
      result.push({
        name: file.name,
        type: file.type,
        size: file.size,
        lastModified: file.lastModified,
        dataUrl
      });
    } catch (e) {
      console.warn('Bỏ qua file không serialize được:', file?.name, e);
    }
  }

  return result;
}

function normalizeVideoModelValue(modelValue) {
  const raw = (modelValue || '').toLowerCase();

  if (!raw) return 'veo-3.1-fast';
  if (raw.includes('veo-2-quality')) return 'veo-3.1-quality';
  if (raw.includes('veo-2-fast')) return 'veo-3.1-fast';
  if (raw.includes('lite-lower')) return 'veo-3.1-lite-lower';
  if (raw.includes('fast-lower') || raw.includes('lower')) return 'veo-3.1-fast-lower';
  if (raw.includes('quality')) return 'veo-3.1-quality';
  if (raw.includes('lite')) return 'veo-3.1-lite';
  return 'veo-3.1-fast';
}

document.addEventListener('DOMContentLoaded', () => {
  const introScreen = document.getElementById('intro-screen');
  const introEnterBtn = document.getElementById('intro-enter-btn');
  const introImageModal = document.getElementById('intro-image-modal');
  const introImageModalImg = document.getElementById('intro-image-modal-img');
  const introImageModalClose = document.getElementById('intro-image-modal-close');
  const introPopupTargets = document.querySelectorAll('[data-popup-image]');


  const autoRenameToggle = document.querySelector('.toggle-row input[type="checkbox"]');
  if (autoRenameToggle) {
    chrome.storage.local.get(['veo_auto_rename'], result => {
      if (result.veo_auto_rename !== undefined) {
        autoRenameToggle.checked = result.veo_auto_rename;
      }
    });
    autoRenameToggle.addEventListener('change', () => {
      chrome.storage.local.set({ veo_auto_rename: autoRenameToggle.checked });
    });
  }

  const openIntroImageModal = (imgSrc) => {
    if (!introImageModal || !introImageModalImg || !imgSrc) return;
    introImageModalImg.src = imgSrc;
    introImageModal.classList.remove('hidden');
  };

  const closeIntroImageModal = () => {
    if (!introImageModal || !introImageModalImg) return;
    introImageModal.classList.add('hidden');
    introImageModalImg.src = '';
  };

  if (introScreen && introEnterBtn) {
    introEnterBtn.addEventListener('click', () => {
      introScreen.classList.add('hidden');
    });
  }

  if (introPopupTargets.length > 0) {
    introPopupTargets.forEach((target) => {
      target.addEventListener('click', () => {
        const src = String(target.getAttribute('data-popup-image') || '').trim();
        openIntroImageModal(src);
      });

      target.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          const src = String(target.getAttribute('data-popup-image') || '').trim();
          openIntroImageModal(src);
        }
      });
    });
  }

  if (introImageModal) {
    introImageModal.addEventListener('click', (event) => {
      const el = event.target;
      if (el instanceof HTMLElement && el.getAttribute('data-modal-close') === 'true') {
        closeIntroImageModal();
      }
    });
  }

  if (introImageModalClose) {
    introImageModalClose.addEventListener('click', closeIntroImageModal);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && introImageModal && !introImageModal.classList.contains('hidden')) {
      closeIntroImageModal();
    }
  });

  // ==========================================
  // 1. TÍNH NĂNG CHUYỂN TAB VÀ HIỆU ỨNG THANH TRƯỢT
  // ==========================================
  const mainTabs = document.querySelectorAll('.main-tab');
  const tabContents = document.querySelectorAll('.tab-content');
  const tabSlider = document.querySelector('.tab-slider');

  // Hàm tự động đo kích thước chữ để thanh xanh trượt tới đúng vị trí
  function updateSlider(activeTab) {
    if (tabSlider && activeTab) {
      tabSlider.style.width = activeTab.offsetWidth + 'px';
      tabSlider.style.left = activeTab.offsetLeft + 'px';
    }
  }

  // Chạy ngay lúc vừa mở popup để thanh xanh đậu ở tab Control
  const initialTab = document.querySelector('.main-tab.active');
  setTimeout(() => updateSlider(initialTab), 50);

  mainTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Ẩn nội dung cũ
      mainTabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      // Hiện nội dung mới
      tab.classList.add('active');
      const targetId = tab.getAttribute('data-target');
      document.getElementById(targetId).classList.add('active');

      // Trượt thanh xanh sang tab vừa bấm
      updateSlider(tab);
    });
  });

  const settingSideBtn = document.querySelector('.setting-side-btn');
  if (settingSideBtn) {
    settingSideBtn.addEventListener('click', () => {
      mainTabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      const settingMainTab = document.querySelector('.main-tab[data-target="setting-tab"]');
      if (settingMainTab) {
        settingMainTab.classList.add('active');
        updateSlider(settingMainTab);
      }

      const settingContent = document.getElementById('setting-tab');
      if (settingContent) {
        settingContent.classList.add('active');
      }
    });
  }


  // ==========================================
  // ==========================================
  // 2. CHUYỂN ĐỔI 5 CHẾ ĐỘ (Hỗ trợ cả nút cũ và thẻ mới)
  // ==========================================
  // Dùng dấu phẩy để tìm cả 2 class: .action-btn (cũ) hoặc .action-card (mới)
  const actionBtns = document.querySelectorAll('.action-btn, .action-card');
  const modeSections = document.querySelectorAll('.mode-section');
  const dynamicNote = document.getElementById('dynamic-note');

  actionBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      // Bỏ active tất cả các nút
      actionBtns.forEach(c => c.classList.remove('active'));
      modeSections.forEach(sec => sec.classList.remove('active'));

      // Kích hoạt nút vừa được click
      btn.classList.add('active');
      const targetMode = btn.getAttribute('data-mode');
      const noteText = btn.getAttribute('data-note');
      // Toggle mode-config panels (Concurrent/Delay in wrapper)
      const modeConfigs = document.querySelectorAll('.mode-config');
      modeConfigs.forEach(mc => mc.classList.remove('active'));
      const targetModeConfig = document.querySelector(`.mode-config[data-mode-config="${targetMode}"]`);
      if (targetModeConfig) {
        targetModeConfig.classList.add('active');
      }

      // Hiện section tương ứng với nút
      const targetSection = document.getElementById(targetMode);
      if (targetSection) {
        targetSection.classList.add('active');
      }

      // Đổi dòng ghi chú dưới cùng
      if (dynamicNote && noteText) {
        dynamicNote.textContent = noteText;
      }
    });
  });

  // ==========================================
  // 3. TÍNH NĂNG TĂNG/GIẢM SỐ MAX RETRIES (+/-)
  // ==========================================
  const btnMinus = document.querySelector('.btn-minus');
  const btnPlus = document.querySelector('.btn-plus');
  const retriesInput = document.getElementById('max-retries');

  if (btnMinus && btnPlus && retriesInput) {
    btnMinus.addEventListener('click', () => {
      let val = parseInt(retriesInput.value) || 0;
      if (val > 1) retriesInput.value = val - 1;
    });
    btnPlus.addEventListener('click', () => {
      let val = parseInt(retriesInput.value) || 0;
      if (val < 20) retriesInput.value = val + 1;
    });
  }

  // ==========================================
  // 3.1 TẠO PROMPT TỪ FORM CREATE PROMPT
  // ==========================================
  const cpGoal = document.getElementById('cp-goal');
  const cpMainTopic = document.getElementById('cp-main-topic');
  const cpTone = document.getElementById('cp-tone');
  const cpLanguage = document.getElementById('cp-language');
  const cpHook = document.getElementById('cp-hook');
  const cpDuration = document.getElementById('cp-duration');
  const cpCTA = document.getElementById('cp-cta');
  const cpImageStyle = document.getElementById('cp-image-style');
  const cpSetting = document.getElementById('cp-setting');
  const cpCharacterCount = document.getElementById('cp-character-count');
  const cpCharacterNames = document.getElementById('cp-character-names');
  const cpGenerateBtn = document.getElementById('cp-generate-btn');
  const cpGenerateGeminiBtn = document.getElementById('cp-generate-gemini-btn');
  const cpOutput = document.getElementById('cp-output');
  const cpPreview = document.getElementById('cp-preview');
  const cpFeatureBtns = document.querySelectorAll('.cp-feature-btn');
  const cpFeatureSections = document.querySelectorAll('.cp-feature-section');
  const cpIdeaInput = document.getElementById('cp-idea-input');
  const cpIdeaDuration = document.getElementById('cp-idea-duration');
  const cpIdeaStyle = document.getElementById('cp-idea-style');
  const cpIdeaOutput = document.getElementById('cp-idea-output');
  const cpIdeaPreview = document.getElementById('cp-preview-idea');
  const cpIdeaGenerateBtn = document.getElementById('cp-idea-generate-btn');
  const cvFeatureBtns = document.querySelectorAll('.cv-feature-btn');
  const cvFeatureSections = document.querySelectorAll('.cv-feature-section');
  const cvAudioUploadZone = document.getElementById('cv-audio-upload-zone');
  const cvAudioFileInput = document.getElementById('cv-audio-file');
  const cvAudioFileName = document.getElementById('cv-audio-file-name');
  const cvAudioPromptPreview = document.getElementById('cv-audio-prompt-preview');
  const cvAudioNote = document.getElementById('cv-audio-note');
  const cvRunAudioBtn = document.getElementById('cv-run-audio-btn');
  const cvVideoUploadZone = document.getElementById('cv-video-upload-zone');
  const cvVideoFileInput = document.getElementById('cv-video-file');
  const cvVideoFileName = document.getElementById('cv-video-file-name');
  const cvVideoSource = document.getElementById('cv-video-source');
  const cvVideoNote = document.getElementById('cv-video-note');
  const cvVideoPromptPreview = document.getElementById('cv-video-prompt-preview');
  const cvRunVideoBtn = document.getElementById('cv-run-video-btn');

  const renderCvAudioPromptPreview = (file) => {
    if (!cvAudioPromptPreview) return;

    if (!file || !String(file.type || '').startsWith('audio/')) {
      cvAudioPromptPreview.value = '';
      return;
    }

    const fileType = String(file.type || 'audio/unknown').replace('audio/', '').toUpperCase();
    cvAudioPromptPreview.value = [
      'Hãy tạo video dựa trên audio đầu vào với yêu cầu sau:',
      `- Tên file audio: ${file.name}`,
      `- Định dạng: ${fileType}`,
      '- Phân tích nhịp điệu, cảm xúc và cao trào của audio để dựng video đồng bộ.',
      '- Tạo các scene 8 giây liên tiếp, chuyển cảnh mượt và giữ mạch kể chuyện nhất quán.',
      '- Trả về prompt chi tiết, sẵn sàng dùng cho video generation.'
    ].join('\n');
  };

  const updateCvAudioSelection = (file) => {
    if (!file || !String(file.type || '').startsWith('audio/')) {
      if (cvAudioFileName) {
        cvAudioFileName.textContent = 'Vui lòng chọn file audio hợp lệ.';
      }
      if (cvAudioUploadZone) {
        cvAudioUploadZone.classList.remove('has-file');
      }
      uploadedFilesRegistry['clone-video-audio'] = [];
      renderCvAudioPromptPreview(null);
      return;
    }

    uploadedFilesRegistry['clone-video-audio'] = [file];

    if (cvAudioFileName) {
      cvAudioFileName.textContent = `Đã chọn: ${file.name}`;
    }
    if (cvAudioUploadZone) {
      cvAudioUploadZone.classList.add('has-file');
    }
    renderCvAudioPromptPreview(file);
  };

  const updateCvVideoSelection = (file) => {
    if (!file || !String(file.type || '').startsWith('video/')) {
      uploadedFilesRegistry['clone-video-video'] = [];
      if (cvVideoFileName) {
        cvVideoFileName.textContent = 'Vui lòng chọn file video hợp lệ.';
      }
      if (cvVideoUploadZone) {
        cvVideoUploadZone.classList.remove('has-file');
      }
      return;
    }

    uploadedFilesRegistry['clone-video-video'] = [file];
    if (cvVideoFileName) {
      cvVideoFileName.textContent = `Đã chọn: ${file.name}`;
    }
    if (cvVideoUploadZone) {
      cvVideoUploadZone.classList.add('has-file');
    }
  };

  if (cvAudioUploadZone && cvAudioFileInput) {
    cvAudioUploadZone.addEventListener('click', () => {
      cvAudioFileInput.click();
    });

    cvAudioUploadZone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        cvAudioFileInput.click();
      }
    });

    cvAudioFileInput.addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0] ? event.target.files[0] : null;
      updateCvAudioSelection(file);
    });

    cvAudioUploadZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      cvAudioUploadZone.classList.add('dragover');
    });

    cvAudioUploadZone.addEventListener('dragleave', (event) => {
      event.preventDefault();
      cvAudioUploadZone.classList.remove('dragover');
    });

    cvAudioUploadZone.addEventListener('drop', (event) => {
      event.preventDefault();
      cvAudioUploadZone.classList.remove('dragover');
      const file = event.dataTransfer?.files && event.dataTransfer.files[0]
        ? event.dataTransfer.files[0]
        : null;
      updateCvAudioSelection(file);
    });
  }

  if (cvVideoUploadZone && cvVideoFileInput) {
    cvVideoUploadZone.addEventListener('click', () => {
      cvVideoFileInput.click();
    });

    cvVideoUploadZone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        cvVideoFileInput.click();
      }
    });

    cvVideoFileInput.addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0] ? event.target.files[0] : null;
      updateCvVideoSelection(file);
    });

    cvVideoUploadZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      cvVideoUploadZone.classList.add('dragover');
    });

    cvVideoUploadZone.addEventListener('dragleave', (event) => {
      event.preventDefault();
      cvVideoUploadZone.classList.remove('dragover');
    });

    cvVideoUploadZone.addEventListener('drop', (event) => {
      event.preventDefault();
      cvVideoUploadZone.classList.remove('dragover');
      const file = event.dataTransfer?.files && event.dataTransfer.files[0]
        ? event.dataTransfer.files[0]
        : null;
      updateCvVideoSelection(file);
    });
  }

  if (cvFeatureBtns.length > 0 && cvFeatureSections.length > 0) {
    cvFeatureBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        cvFeatureBtns.forEach(item => item.classList.remove('active'));
        cvFeatureSections.forEach(sec => sec.classList.remove('active'));

        btn.classList.add('active');
        const targetId = btn.getAttribute('data-cv-feature');
        const target = targetId ? document.getElementById(targetId) : null;
        if (target) {
          target.classList.add('active');
        }
      });
    });
  }

  if (cpFeatureBtns.length > 0 && cpFeatureSections.length > 0) {
    cpFeatureBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        cpFeatureBtns.forEach(item => item.classList.remove('active'));
        cpFeatureSections.forEach(sec => sec.classList.remove('active'));

        btn.classList.add('active');
        const targetId = btn.getAttribute('data-cp-feature');
        const target = targetId ? document.getElementById(targetId) : null;
        if (target) {
          target.classList.add('active');
        }
      });
    });
  }

  if (cpPreview) {
    chrome.storage.local.get(['geminiPreviewContent'], (result) => {
      const saved = String(result?.geminiPreviewContent || '').trim();
      if (saved) {
        cpPreview.value = saved;
        if (cpIdeaPreview) cpIdeaPreview.value = saved;
      }
    });
  }

  const getSafeValue = (el, fallback = '') => {
    if (!el) return fallback;
    const value = String(el.value || '').trim();
    return value || fallback;
  };

  const getToneValues = (toneEl) => {
    if (!toneEl) return [];

    return String(toneEl.value || '')
      .split(/[\n,;]+/)
      .map(item => item.trim())
      .filter(Boolean);
  };

  const sendPromptToGeminiTab = (tabId, promptText, options = {}, maxAttempts = 30, retryDelayMs = 400) => {
    return new Promise((resolve) => {
      let attempts = 0;

      const trySend = () => {
        attempts += 1;

        chrome.tabs.sendMessage(tabId, {
          action: 'AUTO_FILL_GEMINI_PROMPT',
          promptText,
          uploadedFiles: Array.isArray(options?.uploadedFiles) ? options.uploadedFiles : [],
          runToken: String(options?.runToken || '')
        }, (response) => {
          if (!chrome.runtime.lastError && response?.ok) {
            resolve({ ok: true, message: response?.message || '' });
            return;
          }

          if (attempts >= maxAttempts) {
            const runtimeError = chrome.runtime.lastError?.message || '';
            resolve({ ok: false, error: runtimeError || response?.message || 'Không gửi được lệnh auto-fill sang tab Gemini.' });
            return;
          }

          setTimeout(trySend, retryDelayMs);
        });
      };

      trySend();
    });
  };

  const openGeminiTabWithPrompt = async (promptText, options = {}) => {
    const uploadedFiles = Array.isArray(options?.uploadedFiles) ? options.uploadedFiles : [];
    const runToken = String(options?.runToken || '');

    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const flowTabId = activeTab?.id;

      await chrome.storage.local.set({
        pendingGeminiPrompt: promptText,
        pendingGeminiUploadedFiles: uploadedFiles,
        pendingGeminiRunToken: runToken,
        flowReturnTabId: flowTabId || null
      });

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(promptText);
      }

      const geminiTab = await chrome.tabs.create({ url: 'https://gemini.google.com/app' });

      if (!geminiTab?.id) {
        return { ok: true, copied: true, autoFilled: false, error: 'Không lấy được tab id của Gemini.', tabId: null };
      }

      const autoFillResult = await sendPromptToGeminiTab(geminiTab.id, promptText, { uploadedFiles, runToken });
      return {
        ok: true,
        copied: true,
        autoFilled: autoFillResult.ok,
        error: autoFillResult.ok ? '' : autoFillResult.error,
        tabId: geminiTab.id
      };
    } catch (error) {
      let fallbackTabId = null;
      try {
        const fallbackTab = await chrome.tabs.create({ url: 'https://gemini.google.com/app' });
        fallbackTabId = fallbackTab?.id || null;
      } catch (tabError) {
        return { ok: false, error: tabError?.message || String(tabError) };
      }

      if (fallbackTabId) {
        const autoFillResult = await sendPromptToGeminiTab(fallbackTabId, promptText, { uploadedFiles, runToken });
        return {
          ok: true,
          copied: false,
          autoFilled: autoFillResult.ok,
          error: autoFillResult.ok ? (error?.message || String(error)) : (autoFillResult.error || error?.message || String(error)),
          tabId: fallbackTabId
        };
      }

      return { ok: true, copied: false, autoFilled: false, error: error?.message || String(error), tabId: null };
    }
  };

  const buildCloneAudioBatchInstruction = ({
    batchSize,
    startScene,
    endScene,
    totalScenes,
    totalDurationSeconds,
    audioName,
    previousSceneContext,
    previewHint,
    noteText
  }) => {
    const safeBatchSize = Math.max(1, Number(batchSize) || 1);
    const safeStart = Math.max(1, Number(startScene) || 1);
    const safeEnd = Math.max(safeStart, Number(endScene) || safeStart);
    const safeTotalScenes = Math.max(safeEnd, Number(totalScenes) || safeEnd);
    const totalDuration = Math.max(8, Number(totalDurationSeconds) || (safeTotalScenes * 8));

    const contextBlock = previousSceneContext
      ? `\nNGỮ CẢNH CÁC SCENE ĐÃ CÓ (để giữ continuity, KHÔNG viết lại):\n${previousSceneContext}`
      : '';

    const previewBlock = previewHint
      ? `\nYÊU CẦU BỔ SUNG TỪ NGƯỜI DÙNG:\n${previewHint}`
      : '';

    const noteBlock = noteText
      ? `\nYÊU CẦU THAY ĐỔI CỦA NGƯỜI DÙNG:\n${noteText}`
      : '';

    const sceneTimecodes = [];
    for (let s = safeStart; s <= safeEnd; s++) {
      const startSec = (s - 1) * 8;
      const endSec = s * 8;
      sceneTimecodes.push(`\n- Scene ${s}: ${formatSecondsToTimecode(startSec)} - ${formatSecondsToTimecode(endSec)}`);
    }
    const timecodeLinesBlock = sceneTimecodes.length > 0
      ? `\nTIMECODE CỤ THỂ BẮT BUỘC CHO TỪNG SCENE:${sceneTimecodes.join('')}`
      : '';

    const strictSceneSchema = `{
  "scene_number": 1,
  "timecode": "00:00 - 00:08",
  "scene_setting": "...",
  "style": "...",
  "camera": "...",
  "lighting": "...",
  "sound": "...",
  "character": [
    {
      "name": "...",
      "biology_and_anatomy": "...",
      "clothing_and_materials": "...",
      "accessories": "...",
      "action": "...",
      "expression": "..."
    }
  ],
  "narration": "...",
  "dialogue": [
    {
      "character": "...",
      "line": "..."
    }
  ]
}`;

    return [
      `Bạn đang viết tiếp kịch bản video từ file audio: ${audioName}.`,
      `Tổng thời lượng audio mục tiêu: khoảng ${Math.round(totalDuration)} giây (~${Math.ceil(totalDuration / 60)} phút), tương ứng khoảng ${safeTotalScenes} scene 8 giây.`,
      `HÃY TẠO CHÍNH XÁC ${safeBatchSize} scene mới, đánh số từ scene_number ${safeStart} đến ${safeEnd}.`,
      'BẮT BUỘC continuity:',
      '- Phải nối tiếp logic của các scene trước (cốt truyện, nhịp cảm xúc, hành động).',
      '- Giữ nguyên nhận diện nhân vật xuyên suốt: biology_and_anatomy, clothing_and_materials, accessories không đổi cốt lõi.',
      '- Chỉ thay đổi trạng thái nhân vật theo tiến trình câu chuyện: action, expression, tương tác môi trường.',
      '- Bối cảnh/địa điểm phải thống nhất thế giới: mô tả chi tiết địa điểm, thời gian trong ngày, ánh sáng, âm thanh nền.',
      '- Mỗi scene phải mô tả rõ camera, lighting, sound, narration, dialogue (nếu cần).',
      'Định dạng trả về bắt buộc:',
      '- DUY NHẤT JSON hợp lệ, KHÔNG markdown, KHÔNG giải thích.',
      '- Mỗi scene là 1 JSON object độc lập, các object cách nhau đúng 1 dòng trống, KHÔNG bọc mảng [].',
      '- Mỗi scene PHẢI có đầy đủ các key: scene_number, timecode, scene_setting, style, camera, lighting, sound, character, narration, dialogue.',
      '- KHÔNG lặp lại scene cũ, KHÔNG tạo scene ngoài khoảng scene_number yêu cầu.',
      'Schema object bắt buộc cho MỖI scene:',
      strictSceneSchema
    ].join('\n') + timecodeLinesBlock + noteBlock + previewBlock + contextBlock;
  };

  const buildCloneVideoBatchInstruction = ({
    batchSize,
    startScene,
    endScene,
    totalScenes,
    totalDurationSeconds,
    videoName,
    previousSceneContext,
    noteText
  }) => {
    const safeBatchSize = Math.max(1, Number(batchSize) || 1);
    const safeStart = Math.max(1, Number(startScene) || 1);
    const safeEnd = Math.max(safeStart, Number(endScene) || safeStart);
    const safeTotalScenes = Math.max(safeEnd, Number(totalScenes) || safeEnd);
    const totalDuration = Math.max(8, Number(totalDurationSeconds) || (safeTotalScenes * 8));

    const blockStartSecond = (safeStart - 1) * 8;
    const blockEndSecond = Math.min(totalDuration, safeEnd * 8);

    const contextBlock = previousSceneContext
      ? `\nNGỮ CẢNH CÁC SCENE ĐÃ CÓ (để giữ continuity, KHÔNG viết lại):\n${previousSceneContext}`
      : '';

    const noteBlock = noteText
      ? `\nYÊU CẦU ĐỐI VỚI VIDEO CLONE:\n${noteText}`
      : '';

    const sceneTimecodes = [];
    for (let s = safeStart; s <= safeEnd; s++) {
      const startSec = (s - 1) * 8;
      const endSec = s * 8;
      sceneTimecodes.push(`\n- Scene ${s}: ${formatSecondsToTimecode(startSec)} - ${formatSecondsToTimecode(endSec)}`);
    }
    const timecodeLinesBlock = sceneTimecodes.length > 0
      ? `\nTIMECODE CỤ THỂ BẮT BUỘC CHO TỪNG SCENE:${sceneTimecodes.join('')}`
      : '';

    const strictSceneSchema = `{
  "scene_number": 1,
  "timecode": "00:00 - 00:08",
  "scene_setting": "...",
  "style": "...",
  "camera": "...",
  "lighting": "...",
  "sound": "...",
  "character": [
    {
      "name": "...",
      "biology_and_anatomy": "...",
      "clothing_and_materials": "...",
      "accessories": "...",
      "action": "...",
      "expression": "..."
    }
  ],
  "narration": "...",
  "dialogue": [
    {
      "character": "...",
      "line": "..."
    }
  ]
}`;

    return [
      `Bạn đang viết tiếp kịch bản video từ file video: ${videoName}.`,
      `Tổng thời lượng video mục tiêu: khoảng ${Math.round(totalDuration)} giây (~${Math.ceil(totalDuration / 60)} phút), tương ứng khoảng ${safeTotalScenes} scene 8 giây.`,
      `HÃY TẠO CHÍNH XÁC ${safeBatchSize} scene mới, đánh số từ scene_number ${safeStart} đến ${safeEnd}.`,
      'BẮT BUỘC continuity:',
      '- Phải nối tiếp logic của các scene trước (cốt truyện, nhịp cảm xúc, hành động).',
      '- Giữ nguyên nhận diện nhân vật xuyên suốt: biology_and_anatomy, clothing_and_materials, accessories không đổi cốt lõi.',
      '- Chỉ thay đổi trạng thái nhân vật theo tiến trình câu chuyện: action, expression, tương tác môi trường.',
      '- Bối cảnh/địa điểm phải thống nhất thế giới: mô tả chi tiết địa điểm, thời gian trong ngày, ánh sáng, âm thanh nền.',
      '- Mỗi scene phải mô tả rõ camera, lighting, sound, narration, dialogue (nếu cần).',
      'Định dạng trả về bắt buộc:',
      '- DUY NHẤT JSON hợp lệ, KHÔNG markdown, KHÔNG giải thích.',
      '- Mỗi scene là 1 JSON object độc lập, các object cách nhau đúng 1 dòng trống, KHÔNG bọc mảng [].',
      '- Mỗi scene PHẢI có đầy đủ các key: scene_number, timecode, scene_setting, style, camera, lighting, sound, character, narration, dialogue.',
      '- KHÔNG lặp lại scene cũ, KHÔNG tạo scene ngoài khoảng scene_number yêu cầu.',
      'Schema object bắt buộc cho MỖI scene:',
      strictSceneSchema
    ].join('\n') + timecodeLinesBlock + noteBlock + contextBlock;
  };

  const buildCloneAudioPromptInstruction = () => {
    const previewPrompt = String(cvAudioPromptPreview?.value || '').trim();
    if (previewPrompt) {
      return `${previewPrompt}\n\nBẮT BUỘC: Hãy phân tích trực tiếp file audio đính kèm để viết prompt video chi tiết, không bỏ qua audio input.`.trim();
    }

    return [
      'Hãy dựa trên file audio đính kèm để viết prompt video chi tiết.',
      '- Phân tích nhịp điệu, cảm xúc, cao trào và nhịp chuyển của audio.',
      '- Đề xuất prompt quay dựng điện ảnh theo các scene 8 giây liên tiếp.',
      '- Trả về prompt rõ ràng, có thể dùng ngay để generate video.',
      'BẮT BUỘC: phải dùng nội dung từ chính file audio đã đính kèm.'
    ].join('\n');
  };

  if (cvRunAudioBtn) {
    cvRunAudioBtn.addEventListener('click', async () => {
      const selectedAudio = (uploadedFilesRegistry['clone-video-audio'] || [])[0] || null;
      const noteText = String(cvAudioNote?.value || '').trim();
      if (!selectedAudio) {
        alert('Vui lòng upload file audio trước khi gửi sang Gemini.');
        return;
      }

      const serializedAudioFiles = await serializeFilesForMessage([selectedAudio]);
      if (!Array.isArray(serializedAudioFiles) || serializedAudioFiles.length === 0) {
        alert('Không thể đọc file audio. Hãy chọn lại file audio rồi thử lại.');
        return;
      }

      const audioDurationSeconds = await getAudioDurationSeconds(selectedAudio);
      const durationFallback = 300; // fallback 5 phút nếu không đọc được metadata
      const effectiveDuration = audioDurationSeconds > 0 ? audioDurationSeconds : durationFallback;
      const totalScenes = Math.max(1, Math.ceil(effectiveDuration / 8));
      const batchSize = 5;
      const totalBatches = Math.ceil(totalScenes / batchSize);

      let geminiTabId = null;
      let combinedOutput = '';
      const sceneMap = new Map();
      const previewHint = String(cvAudioPromptPreview?.value || '').trim();

      if (cvAudioPromptPreview) {
        cvAudioPromptPreview.value = `Chuẩn bị tạo ${totalScenes} scene (~${Math.round(effectiveDuration)} giây) theo ${totalBatches} batch, mỗi batch ${batchSize} scene...`;
      }

      try {
        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
          const startScene = (batchIndex * batchSize) + 1;
          const endScene = Math.min(totalScenes, startScene + batchSize - 1);
          const currentBatchSize = endScene - startScene + 1;

          let batchSuccess = false;
          let lastBatchError = null;
          const maxBatchRetries = 2;

          for (let retryAttempt = 0; retryAttempt <= maxBatchRetries && !batchSuccess; retryAttempt++) {
            try {
              const runToken = generateGeminiRunToken('clone-audio');

              const previousSceneContext = combinedOutput
                ? combinedOutput.slice(-8000)
                : '';

              const instructionPrompt = buildCloneAudioBatchInstruction({
                batchSize: currentBatchSize,
                startScene,
                endScene,
                totalScenes,
                totalDurationSeconds: effectiveDuration,
                audioName: selectedAudio.name,
                previousSceneContext,
                previewHint,
                noteText
              });

              const retryLabel = retryAttempt > 0 ? ` (Thử lại ${retryAttempt}/${maxBatchRetries})` : '';
              if (cvAudioPromptPreview) {
                cvAudioPromptPreview.value = [
                  `Đang chạy batch ${batchIndex + 1}/${totalBatches}${retryLabel}...`,
                  `Scene ${startScene}-${endScene}/${totalScenes}`,
                  '',
                  combinedOutput || '(chưa có dữ liệu scene)'
                ].join('\n');
              }

              const previewWaiter = waitForGeminiPreviewByToken(runToken, 240000);
              let submitResult = null;

              if (!geminiTabId) {
                console.log(`[Clone-Audio] Batch ${batchIndex + 1}: Mở tab Gemini mới...`);
                submitResult = await openGeminiTabWithPrompt(instructionPrompt, {
                  uploadedFiles: serializedAudioFiles,
                  runToken
                });
                if (submitResult?.tabId) {
                  geminiTabId = submitResult.tabId;
                }
              } else {
                console.log(`[Clone-Audio] Batch ${batchIndex + 1}: Gửi prompt đến tab Gemini hiện tại (tab ${geminiTabId})...`);
                submitResult = await sendPromptToGeminiTab(geminiTabId, instructionPrompt, {
                  runToken
                }, 30, 500);
              }

              if (!submitResult?.ok) {
                lastBatchError = new Error(`[Gửi Prompt Thất bại] ${submitResult?.error || submitResult?.message || `Không gửi được batch ${batchIndex + 1} sang Gemini.`}`);
                console.error(`[Clone-Audio] Batch ${batchIndex + 1}:`, lastBatchError.message);
                if (retryAttempt < maxBatchRetries) {
                  console.log(`[Clone-Audio] Batch ${batchIndex + 1}: Đợi 2 giây rồi thử lại...`);
                  await new Promise(r => setTimeout(r, 2000));
                  continue;
                }
                throw lastBatchError;
              }

              if (submitResult?.autoFilled === false) {
                lastBatchError = new Error(`[Auto-fill Không Thành Công] ${submitResult?.error || `Gemini không tự động điền prompt cho batch ${batchIndex + 1}`}`);
                console.warn(`[Clone-Audio] Batch ${batchIndex + 1}:`, lastBatchError.message);
              }

              console.log(`[Clone-Audio] Batch ${batchIndex + 1}: Chờ kết quả từ Gemini (timeout: 4 phút)...`);
              const batchPreviewPayload = await previewWaiter;
              const batchPreviewText = String(batchPreviewPayload?.previewText || '').trim();

              if (!batchPreviewText) {
                lastBatchError = new Error(`[Phản hồi Trống] Batch ${batchIndex + 1} không trả dữ liệu scene (previewText rỗng).`);
                console.error(`[Clone-Audio] Batch ${batchIndex + 1}:`, lastBatchError.message);
                if (retryAttempt < maxBatchRetries) {
                  console.log(`[Clone-Audio] Batch ${batchIndex + 1}: Đợi 2 giây rồi thử lại...`);
                  await new Promise(r => setTimeout(r, 2000));
                  continue;
                }
                throw lastBatchError;
              }

              console.log(`[Clone-Audio] Batch ${batchIndex + 1}: Nhận được ${batchPreviewText.split('{').length - 1} scene objects`);

              const parsedScenes = parseSceneObjectsFromText(batchPreviewText);
              console.log(`[Clone-Audio] Batch ${batchIndex + 1}: Parse được ${parsedScenes.length} scene objects hợp lệ`);

              const rangedScenes = parsedScenes.filter(scene => {
                const num = Number(scene?.scene_number);
                return Number.isFinite(num) && num >= startScene && num <= endScene;
              });

              console.log(`[Clone-Audio] Batch ${batchIndex + 1}: ${rangedScenes.length} scene trong phạm vi [${startScene}-${endScene}], ${parsedScenes.length - rangedScenes.length} scene ngoài phạm vi`);

              const scenesToUse = rangedScenes.length > 0 ? rangedScenes : parsedScenes;
              if (scenesToUse.length === 0) {
                lastBatchError = new Error(`[Parse Lỗi] Batch ${batchIndex + 1} trả về JSON nhưng không parse được scene_number hợp lệ.`);
                console.error(`[Clone-Audio] Batch ${batchIndex + 1}:`, lastBatchError.message);
                if (retryAttempt < maxBatchRetries) {
                  console.log(`[Clone-Audio] Batch ${batchIndex + 1}: Đợi 2 giây rồi thử lại...`);
                  await new Promise(r => setTimeout(r, 2000));
                  continue;
                }
                throw lastBatchError;
              }

              scenesToUse.forEach(scene => {
                const num = Number(scene?.scene_number);
                if (!Number.isFinite(num)) return;
                sceneMap.set(num, scene);
              });

              const orderedScenes = Array.from(sceneMap.entries())
                .sort((a, b) => a[0] - b[0])
                .map(([, scene]) => scene);

              combinedOutput = formatSceneObjects(orderedScenes);
              console.log(`[Clone-Audio] Batch ${batchIndex + 1}: Hoàn tất. Tổng cộng ${sceneMap.size} scene unique`);

              if (cvAudioPromptPreview) {
                cvAudioPromptPreview.value = combinedOutput;
              }

              batchSuccess = true;
            } catch (batchError) {
              lastBatchError = batchError;
              if (retryAttempt < maxBatchRetries) {
                console.log(`[Clone-Audio] Batch ${batchIndex + 1} Retry ${retryAttempt + 1}/${maxBatchRetries}: Lỗi: ${batchError?.message}`);
                await new Promise(r => setTimeout(r, 2000));
              } else {
                console.error(`[Clone-Audio] Batch ${batchIndex + 1}: Tất cả ${maxBatchRetries + 1} lần thử đều thất bại.`);
                throw batchError;
              }
            }
          }
        }

        if (cvAudioPromptPreview && combinedOutput) {
          cvAudioPromptPreview.value = combinedOutput;
        }

        const completionMsg = `✓ Hoàn tất! Tổng scene: ${sceneMap.size}/${totalScenes}, batch: ${totalBatches}. Dữ liệu đã được hiển thị ở ô preview.`;
        console.log(`[Clone-Audio] ${completionMsg}`);
        alert(completionMsg);
      } catch (error) {
        const errorMsg = error?.message || String(error);
        console.error(`[Clone-Audio] DỪNG (không recover được):`, errorMsg);
        if (cvAudioPromptPreview) {
          cvAudioPromptPreview.value = combinedOutput || String(cvAudioPromptPreview.value || '');
        }
        alert(`Quá trình tạo prompt theo batch bị dừng:\n\n${errorMsg}\n\nHãy mở F12 console để xem chi tiết lỗi.`);
      }
    });
  }

  if (cvRunVideoBtn) {
    cvRunVideoBtn.addEventListener('click', async () => {
      const selectedVideo = (uploadedFilesRegistry['clone-video-video'] || [])[0] || null;
      const noteText = String(cvVideoNote?.value || '').trim();

      if (!selectedVideo) {
        alert('Vui lòng upload file video trước khi gửi sang Gemini.');
        return;
      }

      const serializedVideoFiles = await serializeFilesForMessage([selectedVideo]);
      if (!Array.isArray(serializedVideoFiles) || serializedVideoFiles.length === 0) {
        alert('Không thể đọc file video. Hãy chọn lại file video rồi thử lại.');
        return;
      }

      const videoDurationSeconds = await getVideoDurationSeconds(selectedVideo);
      const durationFallback = 60; // fallback 1 phút nếu không đọc được metadata
      const effectiveDuration = videoDurationSeconds > 0 ? videoDurationSeconds : durationFallback;
      const totalScenes = Math.max(1, Math.ceil(effectiveDuration / 8));
      const batchSize = 5;
      const totalBatches = Math.ceil(totalScenes / batchSize);

      let geminiTabId = null;
      let combinedOutput = '';
      const sceneMap = new Map();

      if (cvVideoPromptPreview) {
        cvVideoPromptPreview.value = `Chuẩn bị tạo ${totalScenes} scene (~${Math.round(effectiveDuration)} giây) theo ${totalBatches} batch, mỗi batch ${batchSize} scene...`;
      }

      try {
        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
          const startScene = (batchIndex * batchSize) + 1;
          const endScene = Math.min(totalScenes, startScene + batchSize - 1);
          const currentBatchSize = endScene - startScene + 1;

          let batchSuccess = false;
          let lastBatchError = null;
          const maxBatchRetries = 2;

          for (let retryAttempt = 0; retryAttempt <= maxBatchRetries && !batchSuccess; retryAttempt++) {
            try {
              const runToken = generateGeminiRunToken('clone-video');

              const previousSceneContext = combinedOutput
                ? combinedOutput.slice(-8000)
                : '';

              const instructionPrompt = buildCloneVideoBatchInstruction({
                batchSize: currentBatchSize,
                startScene,
                endScene,
                totalScenes,
                totalDurationSeconds: effectiveDuration,
                videoName: selectedVideo.name,
                previousSceneContext,
                noteText
              });

              const retryLabel = retryAttempt > 0 ? ` (Thử lại ${retryAttempt}/${maxBatchRetries})` : '';
              if (cvVideoPromptPreview) {
                cvVideoPromptPreview.value = [
                  `Đang chạy batch ${batchIndex + 1}/${totalBatches}${retryLabel}...`,
                  `Scene ${startScene}-${endScene}/${totalScenes}`,
                  '',
                  combinedOutput || '(chưa có dữ liệu scene)'
                ].join('\n');
              }

              const previewWaiter = waitForGeminiPreviewByToken(runToken, 240000);
              let submitResult = null;

              if (!geminiTabId) {
                console.log(`[Clone-Video] Batch ${batchIndex + 1}: Mở tab Gemini mới...`);
                submitResult = await openGeminiTabWithPrompt(instructionPrompt, {
                  uploadedFiles: serializedVideoFiles,
                  runToken
                });
                if (submitResult?.tabId) {
                  geminiTabId = submitResult.tabId;
                }
              } else {
                console.log(`[Clone-Video] Batch ${batchIndex + 1}: Gửi prompt đến tab Gemini hiện tại (tab ${geminiTabId})...`);
                submitResult = await sendPromptToGeminiTab(geminiTabId, instructionPrompt, {
                  runToken
                }, 30, 500);
              }

              if (!submitResult?.ok) {
                lastBatchError = new Error(`[Gửi Prompt Thất bại] ${submitResult?.error || submitResult?.message || `Không gửi được batch ${batchIndex + 1} sang Gemini.`}`);
                console.error(`[Clone-Video] Batch ${batchIndex + 1}:`, lastBatchError.message);
                if (retryAttempt < maxBatchRetries) {
                  console.log(`[Clone-Video] Batch ${batchIndex + 1}: Đợi 2 giây rồi thử lại...`);
                  await new Promise(r => setTimeout(r, 2000));
                  continue;
                }
                throw lastBatchError;
              }

              if (submitResult?.autoFilled === false) {
                lastBatchError = new Error(`[Auto-fill Không Thành Công] ${submitResult?.error || `Gemini không tự động điền prompt cho batch ${batchIndex + 1}`}`);
                console.warn(`[Clone-Video] Batch ${batchIndex + 1}:`, lastBatchError.message);
              }

              console.log(`[Clone-Video] Batch ${batchIndex + 1}: Chờ kết quả từ Gemini (timeout: 4 phút)...`);
              const batchPreviewPayload = await previewWaiter;
              const batchPreviewText = String(batchPreviewPayload?.previewText || '').trim();

              if (!batchPreviewText) {
                lastBatchError = new Error(`[Phản hồi Trống] Batch ${batchIndex + 1} không trả dữ liệu scene (previewText rỗng).`);
                console.error(`[Clone-Video] Batch ${batchIndex + 1}:`, lastBatchError.message);
                if (retryAttempt < maxBatchRetries) {
                  console.log(`[Clone-Video] Batch ${batchIndex + 1}: Đợi 2 giây rồi thử lại...`);
                  await new Promise(r => setTimeout(r, 2000));
                  continue;
                }
                throw lastBatchError;
              }

              console.log(`[Clone-Video] Batch ${batchIndex + 1}: Nhận được ${batchPreviewText.split('{').length - 1} scene objects`);

              const parsedScenes = parseSceneObjectsFromText(batchPreviewText);
              console.log(`[Clone-Video] Batch ${batchIndex + 1}: Parse được ${parsedScenes.length} scene objects hợp lệ`);

              const rangedScenes = parsedScenes.filter(scene => {
                const num = Number(scene?.scene_number);
                return Number.isFinite(num) && num >= startScene && num <= endScene;
              });

              console.log(`[Clone-Video] Batch ${batchIndex + 1}: ${rangedScenes.length} scene trong phạm vi [${startScene}-${endScene}], ${parsedScenes.length - rangedScenes.length} scene ngoài phạm vi`);

              const scenesToUse = rangedScenes.length > 0 ? rangedScenes : parsedScenes;
              if (scenesToUse.length === 0) {
                lastBatchError = new Error(`[Parse Lỗi] Batch ${batchIndex + 1} trả về JSON nhưng không parse được scene_number hợp lệ.`);
                console.error(`[Clone-Video] Batch ${batchIndex + 1}:`, lastBatchError.message);
                if (retryAttempt < maxBatchRetries) {
                  console.log(`[Clone-Video] Batch ${batchIndex + 1}: Đợi 2 giây rồi thử lại...`);
                  await new Promise(r => setTimeout(r, 2000));
                  continue;
                }
                throw lastBatchError;
              }

              scenesToUse.forEach(scene => {
                const num = Number(scene?.scene_number);
                if (!Number.isFinite(num)) return;
                sceneMap.set(num, scene);
              });

              const orderedScenes = Array.from(sceneMap.entries())
                .sort((a, b) => a[0] - b[0])
                .map(([, scene]) => scene);

              combinedOutput = formatSceneObjects(orderedScenes);
              console.log(`[Clone-Video] Batch ${batchIndex + 1}: Hoàn tất. Tổng cộng ${sceneMap.size} scene unique`);

              if (cvVideoPromptPreview) {
                cvVideoPromptPreview.value = combinedOutput;
              }

              batchSuccess = true;
            } catch (batchError) {
              lastBatchError = batchError;
              if (retryAttempt < maxBatchRetries) {
                console.log(`[Clone-Video] Batch ${batchIndex + 1} Retry ${retryAttempt + 1}/${maxBatchRetries}: Lỗi: ${batchError?.message}`);
                await new Promise(r => setTimeout(r, 2000));
              } else {
                console.error(`[Clone-Video] Batch ${batchIndex + 1}: Tất cả ${maxBatchRetries + 1} lần thử đều thất bại.`);
                throw batchError;
              }
            }
          }
        }

        if (cvVideoPromptPreview && combinedOutput) {
          cvVideoPromptPreview.value = combinedOutput;
        }

        const completionMsg = `✓ Hoàn tất! Tổng scene: ${sceneMap.size}/${totalScenes}, batch: ${totalBatches}. Dữ liệu đã được hiển thị ở ô preview.`;
        console.log(`[Clone-Video] ${completionMsg}`);
        alert(completionMsg);
      } catch (error) {
        const errorMsg = error?.message || String(error);
        console.error(`[Clone-Video] DỪNG (không recover được):`, errorMsg);
        if (cvVideoPromptPreview) {
          cvVideoPromptPreview.value = combinedOutput || String(cvVideoPromptPreview.value || '');
        }
        alert(`Quá trình tạo prompt theo batch bị dừng:\n\n${errorMsg}\n\nHãy mở F12 console để xem chi tiết lỗi.`);
      }
    });
  }

  const renderCharacterNameInputs = () => {
    if (!cpCharacterNames || !cpCharacterCount) return;

    const count = Number.parseInt(cpCharacterCount.value, 10) || 1;
    const currentValues = Array.from(cpCharacterNames.querySelectorAll('input'))
      .map(input => String(input.value || '').trim());

    let html = '';
    for (let index = 0; index < count; index++) {
      const existingValue = currentValues[index] || '';
      html += `
        <input
          type="text"
          class="cp-character-name"
          data-index="${index + 1}"
          value="${existingValue.replace(/"/g, '&quot;')}"
          placeholder="Tên nhân vật ${index + 1}"
        />
      `;
    }

    cpCharacterNames.innerHTML = html;
  };

  if (cpCharacterCount) {
    cpCharacterCount.addEventListener('change', renderCharacterNameInputs);
    renderCharacterNameInputs();
  }

  const buildPromptFromCreateForm = () => {
    const goal = getSafeValue(cpGoal, 'Chia sẻ kiến thức');
    const mainTopic = getSafeValue(cpMainTopic, 'Mẹo nhớ từ vựng TOEIC');
    const tones = getToneValues(cpTone);
    const language = getSafeValue(cpLanguage, 'Tiếng Việt');
    const hook = getSafeValue(cpHook, 'Cảnh báo sai lầm');
    const duration = getSafeValue(cpDuration, '60s');
    const cta = getSafeValue(cpCTA, 'Nhấn link ở bio');
    const imageStyle = getSafeValue(cpImageStyle, 'Người thật (Photorealistic)');
    const setting = getSafeValue(cpSetting, 'Phòng học năng động');
    const characterCount = Number.parseInt(getSafeValue(cpCharacterCount, '1'), 10) || 1;
    const characterNames = cpCharacterNames
      ? Array.from(cpCharacterNames.querySelectorAll('.cp-character-name'))
        .map(input => String(input.value || '').trim())
        .filter(Boolean)
      : [];
    const finalCharacterNames = characterNames.length > 0
      ? characterNames
      : Array.from({ length: characterCount }, (_, index) => `Nhân vật ${index + 1}`);

    const toneText = tones.length > 0 ? tones.join(', ') : 'Kịch tính';

    const technicalParts = [];
    if (imageStyle) technicalParts.push(`Loại hình ảnh: ${imageStyle}`);
    if (setting) technicalParts.push(`Bối cảnh trong ${setting}`);
    technicalParts.push(`Số lượng nhân vật: ${characterCount}`);
    technicalParts.push(`Tên nhân vật: ${finalCharacterNames.join(', ')}`);
    const technicalCueText = technicalParts.length > 0
      ? `${technicalParts.join('. ')}.`
      : '';

    const jsonSchemaGuide = `{
  "scene_number": 1,
  "timecode": "00:00 - 00:08",
  "scene_setting": "...",
  "style": "...",
  "camera": "...",
  "lighting": "...",
  "sound": "...",
  "character": [
    {
      "name": "...",
      "biology_and_anatomy": "...",
      "clothing_and_materials": "...",
      "accessories": "...",
      "action": "...",
      "expression": "..."
    }
  ],
  "narration": "...",
  "dialogue": [
    {
      "character": "...",
      "line": "..."
    }
  ]
}`;

    const characterConsistencyRules = `
QUY TẮC ĐỒNG BỘ NHÂN VẬT (BẮT BUỘC):
- Tạo hồ sơ nhân vật chuẩn ngay từ scene đầu tiên cho từng nhân vật.
- Nếu cùng một nhân vật xuất hiện ở scene/prompt khác, các trường "biology_and_anatomy", "clothing_and_materials", "accessories" phải GIỮ NGUYÊN cốt lõi.
- Chỉ được thay đổi theo ngữ cảnh ở "action", "expression" và chi tiết môi trường bám lên nhân vật (ví dụ: ướt mưa, bám bụi), không làm đổi nhận diện nhân vật.
- Tuyệt đối không đổi tên nhân vật giữa các scene/prompt khi vẫn là cùng một người.`.trim();

    return `Viết cho tôi một kịch bản video về chủ đề ${mainTopic}. Mục tiêu là ${goal} với giai điệu câu chuyện ${toneText}. Ngôn ngữ sử dụng: ${language}. Cấu trúc kịch bản gồm: Mở đầu bằng ${hook}, nội dung chính kéo dài khoảng ${duration}, và kết thúc bằng lời kêu gọi ${cta}. ${technicalCueText} Vì mỗi prompt Veo chỉ tạo được 8 giây, hãy chia thành nhiều scene 8s liên tiếp. ${characterConsistencyRules} BẮT BUỘC trả về DUY NHẤT JSON hợp lệ (không markdown, không giải thích) theo quy tắc: mỗi prompt là 1 JSON object riêng, các object cách nhau đúng 1 dòng trống, KHÔNG bọc trong mảng []. Mỗi scene chỉ gồm nhân vật cần thiết cho scene đó, nhưng thông tin phải đầy đủ và chi tiết, đúng schema object sau:\n${jsonSchemaGuide}`.trim();
  };

  const buildCreateMainBatchInstruction = ({
    baseInstruction,
    startScene,
    endScene,
    totalScenes,
    totalDurationSeconds,
    previousSceneContext
  }) => {
    const safeStart = Math.max(1, Number(startScene) || 1);
    const safeEnd = Math.max(safeStart, Number(endScene) || safeStart);
    const safeTotalScenes = Math.max(safeEnd, Number(totalScenes) || safeEnd);
    const currentBatchSize = safeEnd - safeStart + 1;
    const totalDuration = Math.max(8, Number(totalDurationSeconds) || (safeTotalScenes * 8));

    const contextBlock = previousSceneContext
      ? `\nNGỮ CẢNH CÁC SCENE ĐÃ CÓ (để giữ continuity, KHÔNG viết lại):\n${previousSceneContext}`
      : '';

    const sceneTimecodes = [];
    for (let s = safeStart; s <= safeEnd; s++) {
      const startSec = (s - 1) * 8;
      const endSec = s * 8;
      sceneTimecodes.push(`\n- Scene ${s}: ${formatSecondsToTimecode(startSec)} - ${formatSecondsToTimecode(endSec)}`);
    }
    const timecodeLinesBlock = sceneTimecodes.length > 0
      ? `\nTIMECODE CỤ THỂ BẮT BUỘC CHO TỪNG SCENE:${sceneTimecodes.join('')}`
      : '';

    return [
      baseInstruction,
      '',
      'BỔ SUNG BẮT BUỘC CHO LẦN TẠO NÀY:',
      `- Chỉ tạo CHÍNH XÁC ${currentBatchSize} scene mới, đánh số từ scene_number ${safeStart} đến ${safeEnd}.`,
      `- Tổng số scene toàn video là ${safeTotalScenes}, không tạo scene vượt phạm vi.`,
      '- Tuyệt đối giữ continuity với scene trước đó (nhân vật, trang phục, bối cảnh, mạch hành động).',
      '- Chỉ trả về JSON object của các scene trong range yêu cầu, không thêm giải thích.'
    ].join('\n') + timecodeLinesBlock + contextBlock;
  };

  if (cpGenerateBtn && cpOutput) {
    cpGenerateBtn.addEventListener('click', () => {
      cpOutput.value = buildPromptFromCreateForm();
    });
  }

  if (cpGenerateGeminiBtn && cpOutput) {
    cpGenerateGeminiBtn.addEventListener('click', async () => {
      const baseInstruction = buildPromptFromCreateForm();
      cpOutput.value = baseInstruction;

      const totalDurationSeconds = parseDurationToSeconds(cpDuration?.value || '60s');
      const totalScenes = Math.max(1, Math.ceil(totalDurationSeconds / 8));
      const batchSize = 5;
      const totalBatches = Math.ceil(totalScenes / batchSize);

      if (cpPreview) {
        cpPreview.value = `Chuẩn bị tạo ${totalScenes} scene (~${Math.round(totalDurationSeconds)} giây) theo ${totalBatches} batch, mỗi batch tối đa ${batchSize} scene...`;
      }
      if (cpIdeaPreview) {
        cpIdeaPreview.value = cpPreview ? cpPreview.value : 'Đang chờ Gemini generate...';
      }
      chrome.storage.local.set({ geminiPreviewContent: cpPreview?.value || 'Đang chờ Gemini generate...' }).catch(() => { });

      let geminiTabId = null;
      let combinedOutput = '';
      const sceneMap = new Map();

      try {
        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
          const startScene = (batchIndex * batchSize) + 1;
          const endScene = Math.min(totalScenes, startScene + batchSize - 1);
          const currentBatchSize = endScene - startScene + 1;
          const runToken = generateGeminiRunToken('create-main');

          const previousSceneContext = combinedOutput
            ? combinedOutput.slice(-8000)
            : '';

          const batchInstruction = buildCreateMainBatchInstruction({
            baseInstruction,
            startScene,
            endScene,
            totalScenes,
            totalDurationSeconds,
            previousSceneContext
          });

          const previewWaiter = waitForGeminiPreviewByToken(runToken, 240000);
          let submitResult;

          if (cpPreview) {
            cpPreview.value = [
              `Đang chạy batch ${batchIndex + 1}/${totalBatches}...`,
              `Scene ${startScene}-${endScene}/${totalScenes}`,
              '',
              combinedOutput || '(chưa có dữ liệu scene)'
            ].join('\n');
          }

          if (!geminiTabId) {
            submitResult = await openGeminiTabWithPrompt(batchInstruction, { runToken });
            if (submitResult?.tabId) geminiTabId = submitResult.tabId;
          } else {
            submitResult = await sendPromptToGeminiTab(geminiTabId, batchInstruction, { runToken }, 30, 500);
          }

          if (!submitResult?.ok) {
            throw new Error(submitResult?.error || submitResult?.message || `Không gửi được batch ${batchIndex + 1} sang Gemini.`);
          }

          const batchPayload = await previewWaiter;
          const batchPreviewText = String(batchPayload?.previewText || '').trim();
          if (!batchPreviewText) {
            throw new Error(`Batch ${batchIndex + 1} trả kết quả rỗng.`);
          }

          const parsedScenes = parseSceneObjectsFromText(batchPreviewText);
          const rangedScenes = parsedScenes.filter(scene => {
            const num = Number(scene?.scene_number);
            return Number.isFinite(num) && num >= startScene && num <= endScene;
          });

          const scenesToUse = rangedScenes.length > 0 ? rangedScenes : parsedScenes;
          if (scenesToUse.length === 0) {
            throw new Error(`Batch ${batchIndex + 1} không parse được scene JSON hợp lệ.`);
          }

          scenesToUse.forEach(scene => {
            const num = Number(scene?.scene_number);
            if (!Number.isFinite(num)) return;
            sceneMap.set(num, scene);
          });

          const orderedScenes = Array.from(sceneMap.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([, scene]) => scene);

          combinedOutput = formatSceneObjects(orderedScenes);

          if (cpPreview) cpPreview.value = combinedOutput;
          if (cpIdeaPreview) cpIdeaPreview.value = combinedOutput;
          chrome.storage.local.set({ geminiPreviewContent: combinedOutput }).catch(() => { });

          // Nhịp ngắn để UI ổn định trước batch kế tiếp.
          await new Promise(r => setTimeout(r, 600));
        }

        const doneMsg = `✓ Hoàn tất! Đã tạo ${sceneMap.size}/${totalScenes} scene qua ${totalBatches} batch.`;
        alert(doneMsg);
      } catch (error) {
        const errorMsg = error?.message || String(error);
        if (cpPreview && !String(cpPreview.value || '').trim()) {
          cpPreview.value = combinedOutput;
        }
        if (cpIdeaPreview && !String(cpIdeaPreview.value || '').trim()) {
          cpIdeaPreview.value = combinedOutput;
        }
        alert(`Tạo kịch bản theo batch bị dừng:\n\n${errorMsg}`);
      }
    });
  }

  const buildIdeaPromptInstruction = () => {
    const userIdea = String(cpIdeaInput?.value || '').trim();
    const durationHint = String(cpIdeaDuration?.value || '').trim();
    const styleHint = String(cpIdeaStyle?.value || '').trim();

    if (!userIdea) return '';

    const schemaGuide = `{
  "scene_number": 1,
  "timecode": "00:00 - 00:08",
  "scene_setting": "...",
  "style": "...",
  "camera": "...",
  "lighting": "...",
  "sound": "...",
  "character": [
    {
      "name": "...",
      "biology_and_anatomy": "...",
      "clothing_and_materials": "...",
      "accessories": "...",
      "action": "...",
      "expression": "..."
    }
  ],
  "narration": "...",
  "dialogue": [
    {
      "character": "...",
      "line": "..."
    }
  ]
}`;

    const durationLine = durationHint
      ? `- Tổng thời lượng mong muốn: ${durationHint}. Chia đều thành các scene 8 giây liên tiếp.`
      : '- Tự đề xuất tổng thời lượng hợp lý theo nội dung, nhưng vẫn chia scene 8 giây liên tiếp.';

    const styleLine = styleHint
      ? `- Phong cách ưu tiên: ${styleHint}.`
      : '- Tự chọn phong cách hình ảnh phù hợp nhất với ý tưởng.';

    const characterConsistencyLines = [
      '- Đồng bộ nhân vật xuyên suốt toàn bộ scene/prompt.',
      '- Với cùng một nhân vật: giữ nhất quán các trường "biology_and_anatomy", "clothing_and_materials", "accessories".',
      '- Chỉ thay đổi theo bối cảnh ở "action", "expression" và chi tiết tác động môi trường; không đổi nhận diện cốt lõi.',
      '- Không đổi tên nhân vật giữa các scene nếu vẫn là cùng nhân vật.'
    ].join('\n');

    return `Dữ kiện người dùng: "${userIdea}".
  Bạn là biên kịch và đạo diễn video AI chuyên nghiệp. Hãy dựa trên dữ kiện người dùng để tự lên ý tưởng đầy đủ (bối cảnh, nhân vật, hành động, camera, ánh sáng, âm thanh, narration, dialogue) và trả về kịch bản video theo scene.
  Yêu cầu bắt buộc:
${durationLine}
${styleLine}
- Mỗi scene phải có timecode chuẩn dạng 00:00 - 00:08, 00:08 - 00:16...
${characterConsistencyLines}
- Nội dung phải logic, liền mạch, giàu chi tiết điện ảnh.
- Trả về DUY NHẤT JSON hợp lệ, KHÔNG markdown, KHÔNG giải thích thêm.
- Mỗi prompt là 1 JSON object riêng, mỗi object cách nhau đúng 1 dòng trống, KHÔNG bọc trong mảng [].
- Cấu trúc mỗi object phải đúng y hệt schema sau:
${schemaGuide}`.trim();
  };

  if (cpIdeaGenerateBtn) {
    cpIdeaGenerateBtn.addEventListener('click', async () => {
      const baseInstruction = buildIdeaPromptInstruction();
      if (!baseInstruction) {
        if (cpIdeaOutput) cpIdeaOutput.value = 'Vui lòng nhập dữ kiện ý tưởng trước khi tạo.';
        alert('Vui lòng nhập dữ kiện ý tưởng trước khi tạo.');
        return;
      }

      if (cpIdeaOutput) cpIdeaOutput.value = baseInstruction;

      const totalDurationSeconds = parseDurationToSeconds(cpIdeaDuration?.value || '60s');
      const totalScenes = Math.max(1, Math.ceil(totalDurationSeconds / 8));
      const batchSize = 5;
      const totalBatches = Math.ceil(totalScenes / batchSize);

      if (cpPreview) {
        cpPreview.value = `Chuẩn bị tạo ${totalScenes} scene (~${Math.round(totalDurationSeconds)} giây) theo ${totalBatches} batch, mỗi batch tối đa ${batchSize} scene...`;
      }
      if (cpIdeaPreview) {
        cpIdeaPreview.value = cpPreview ? cpPreview.value : 'Đang chờ Gemini generate...';
      }
      chrome.storage.local.set({ geminiPreviewContent: cpIdeaPreview?.value || 'Đang chờ Gemini generate...' }).catch(() => { });

      let geminiTabId = null;
      let combinedOutput = '';
      const sceneMap = new Map();

      try {
        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
          const startScene = (batchIndex * batchSize) + 1;
          const endScene = Math.min(totalScenes, startScene + batchSize - 1);
          const runToken = generateGeminiRunToken('create-idea');

          const previousSceneContext = combinedOutput
            ? combinedOutput.slice(-8000)
            : '';

          const batchInstruction = buildCreateMainBatchInstruction({
            baseInstruction,
            startScene,
            endScene,
            totalScenes,
            totalDurationSeconds,
            previousSceneContext
          });

          const previewWaiter = waitForGeminiPreviewByToken(runToken, 240000);
          let submitResult;

          if (cpIdeaPreview) {
            cpIdeaPreview.value = [
              `Đang chạy batch ${batchIndex + 1}/${totalBatches}...`,
              `Scene ${startScene}-${endScene}/${totalScenes}`,
              '',
              combinedOutput || '(chưa có dữ liệu scene)'
            ].join('\n');
          }

          if (!geminiTabId) {
            submitResult = await openGeminiTabWithPrompt(batchInstruction, { runToken });
            if (submitResult?.tabId) geminiTabId = submitResult.tabId;
          } else {
            submitResult = await sendPromptToGeminiTab(geminiTabId, batchInstruction, { runToken }, 30, 500);
          }

          if (!submitResult?.ok) {
            throw new Error(submitResult?.error || submitResult?.message || `Không gửi được batch ${batchIndex + 1} sang Gemini.`);
          }

          const batchPayload = await previewWaiter;
          const batchPreviewText = String(batchPayload?.previewText || '').trim();
          if (!batchPreviewText) {
            throw new Error(`Batch ${batchIndex + 1} trả kết quả rỗng.`);
          }

          const parsedScenes = parseSceneObjectsFromText(batchPreviewText);
          const rangedScenes = parsedScenes.filter(scene => {
            const num = Number(scene?.scene_number);
            return Number.isFinite(num) && num >= startScene && num <= endScene;
          });

          const scenesToUse = rangedScenes.length > 0 ? rangedScenes : parsedScenes;
          if (scenesToUse.length === 0) {
            throw new Error(`Batch ${batchIndex + 1} không parse được scene JSON hợp lệ.`);
          }

          scenesToUse.forEach(scene => {
            const num = Number(scene?.scene_number);
            if (!Number.isFinite(num)) return;
            sceneMap.set(num, scene);
          });

          const orderedScenes = Array.from(sceneMap.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([, scene]) => scene);

          combinedOutput = formatSceneObjects(orderedScenes);

          if (cpIdeaPreview) cpIdeaPreview.value = combinedOutput;
          if (cpPreview) cpPreview.value = combinedOutput;
          chrome.storage.local.set({ geminiPreviewContent: combinedOutput }).catch(() => { });

          await new Promise(r => setTimeout(r, 600));
        }

        alert(`✓ Hoàn tất! Đã tạo ${sceneMap.size}/${totalScenes} scene qua ${totalBatches} batch.`);
      } catch (error) {
        const errorMsg = error?.message || String(error);
        if (cpIdeaPreview && !String(cpIdeaPreview.value || '').trim()) {
          cpIdeaPreview.value = combinedOutput;
        }
        if (cpPreview && !String(cpPreview.value || '').trim()) {
          cpPreview.value = combinedOutput;
        }
        alert(`Tạo kịch bản từ dữ kiện theo batch bị dừng:\n\n${errorMsg}`);
      }
    });
  }

  // ==========================================
  // 4. LỆNH RUN & XỬ LÝ PROMPTS GỬI XUỐNG WEB
  // ==========================================
  const runBtns = document.querySelectorAll('.queue-card .btn-run');
  const btnClear = document.querySelector('.btn-clear');
  const queueBody = document.querySelector('.queue-body');
  const activeCount = document.querySelector('.active-count');

  const formatGroupCreatedAt = (dateObj) => {
    const date = dateObj instanceof Date ? dateObj : new Date();
    const pad = (num) => String(num).padStart(2, '0');
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());
    const day = pad(date.getDate());
    const month = pad(date.getMonth() + 1);
    const year = date.getFullYear();
    return `${hours}:${minutes}:${seconds} - ${day}/${month}/${year}`;
  };

  const refreshActiveCount = () => {
    if (!activeCount) return;
    const runningGroups = document.querySelectorAll('.queue-group:not(.completed):not(.stopped)').length;
    activeCount.textContent = `${runningGroups} active`;
  };

  const markGroupStopped = (group) => {
    if (!group) return;

    group.classList.add('stopped');

    const allItems = group.querySelectorAll('.queue-item');
    const doneItems = group.querySelectorAll('.queue-item.completed').length;
    const totalCount = allItems.length;
    const subtext = group.querySelector('.queue-group-subtext');
    const badge = group.querySelector('.badge-running');
    const stopButton = group.querySelector('.btn-stop');

    allItems.forEach((item) => {
      if (item.classList.contains('completed')) return;
      item.classList.remove('running', 'submitted');
      item.classList.add('stopped');

      const statusText = item.querySelector('.status-text');
      if (statusText) {
        statusText.textContent = 'Đã dừng ⛔';
        statusText.style.color = '#ef4444';
      }
    });

    if (subtext) {
      subtext.textContent = `${doneItems}/${totalCount} prompts • Stopped`;
    }

    if (badge) {
      badge.textContent = 'Stop';
      badge.classList.remove('badge-completed');
      badge.classList.add('badge-stopped');
    }

    if (stopButton) {
      stopButton.style.display = 'none';
    }

    refreshActiveCount();
  };

  const collectPromptImagePlanFromReview = (activeSection, promptCount) => {
    const plan = Array.from({ length: promptCount }, () => []);
    if (!activeSection) return plan;

    const reviewItems = activeSection.querySelectorAll('.review-card .review-list .review-item');
    if (!reviewItems || reviewItems.length === 0) return plan;

    reviewItems.forEach((item, index) => {
      const imageNames = Array.from(item.querySelectorAll('.review-info img[title]'))
        .map(img => (img.getAttribute('title') || '').trim())
        .filter(Boolean);
      if (index < plan.length) {
        plan[index] = imageNames;
      }
    });

    return plan;
  };

  if (btnClear && queueBody && activeCount) {
    btnClear.addEventListener('click', () => {
      queueBody.innerHTML = '';
      refreshActiveCount();
    });
  }

  if (queueBody) {
    queueBody.addEventListener('click', (event) => {
      const stopButton = event.target.closest('.btn-stop');
      if (stopButton) {
        event.preventDefault();
        event.stopPropagation();

        const group = stopButton.closest('.queue-group');
        if (!group || group.classList.contains('completed') || group.classList.contains('stopped')) {
          return;
        }

        markGroupStopped(group);

        const groupId = group.id;
        if (groupId && chrome?.tabs) {
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs || !tabs[0]) return;
            chrome.tabs.sendMessage(tabs[0].id, {
              action: 'stop_automation',
              groupId
            }, () => {
              void chrome.runtime?.lastError;
            });
          });
        }
        return;
      }

      const header = event.target.closest('.queue-group-header');
      if (!header) return;

      const group = header.closest('.queue-group');
      if (!group) return;

      group.classList.toggle('collapsed');
    });
  }

  refreshActiveCount();

  runBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      // 1. Lấy dữ liệu từ khung nhập Prompts
      const activeSection = document.querySelector('.mode-section.active');
      const textArea = activeSection ? activeSection.querySelector('textarea') : null;

      let promptList = [];
      let promptModes = []; // MẢNG MỚI ĐỂ LƯU CHẾ ĐỘ CỦA TỪNG PROMPT

      if (textArea && textArea.value.trim() !== "") {
        // Tách văn bản thành mảng dựa trên dòng trống (2 dấu xuống dòng liên tiếp)
        promptList = textArea.value.split(/\n\s*\n/).map(p => p.trim()).filter(p => p !== "");
      }

      if (promptList.length === 0) {
        alert("Vui lòng nhập ít nhất 1 prompt!");
        return;
      }

      if (typeof window.forceUpdatePreview === 'function' && textArea) {
        window.forceUpdatePreview(textArea);
      }

      const modeSelects = activeSection.querySelectorAll('.prompt-mode-select, select[id^="mode-"]');
      if (modeSelects.length > 0) {
        modeSelects.forEach(sel => promptModes.push(sel.value));
      } else {
        // Nếu không tìm thấy dropdown, mặc định tất cả là 8s (Không nối)
        promptModes = promptList.map(() => '8s');
      }

      // Kéo toàn bộ nhãn (labels) ra ngoài để dùng chung cho mọi khối lệnh
      const allLabels = activeSection.querySelectorAll('label');

      let outputCount = "2";
      const outputDialSelect = activeSection.querySelector('.output-dial-select');
      if (outputDialSelect) {
        outputCount = outputDialSelect.value;
      } else {
        // fallback: tìm qua label (backward compat)
        allLabels.forEach(label => {
          if (label.textContent.includes('Outputs per Prompt')) {
            const selectEl = label.nextElementSibling;
            if (selectEl && selectEl.tagName === 'SELECT') {
              outputCount = selectEl.value;
            }
          }
        });
      }

      let saveToFolder = 'veo-folder-1';
      const saveFolderInput = activeSection.querySelector('[id^="save-to-folder-"]');
      if (saveFolderInput) {
        const entered = String(saveFolderInput.value || '').trim();
        saveToFolder = entered || 'veo-folder-1';
      }

      let maxInputImagesPerPrompt = 3;

      // Lấy tất cả các thẻ select TRỪ cái select ẩn của vòng tròn Output
      const selectsInSection = activeSection.querySelectorAll('select:not(.output-dial-select)');

      selectsInSection.forEach(sel => {
        // Tìm thẻ select nào có chứa tùy chọn 1 ảnh và 3 ảnh (để đảm bảo đúng là dropdown chọn ảnh)
        if (sel.querySelector('option[value="1"]') && sel.querySelector('option[value="3"]')) {
          maxInputImagesPerPrompt = parseInt(sel.value, 10) || 3;
        }
      });

      // --- LẤY SỐ LƯỢNG CHẠY ĐỒNG THỜI (CONCURRENT) ---
      let concurrentCount = 2; // Mặc định luôn là 2 cho gọn!

      let concurrentSource = activeSection;
      const activeModeConfig = document.querySelector('.mode-config.active');
      if (activeModeConfig && !activeSection.querySelector('.delay-wrapper')) {
        concurrentSource = activeModeConfig;
      }

      const dialWrap = concurrentSource.querySelector('.concurrent-dial-wrap');
      if (dialWrap) {
        // Kiểm tra xem chế độ hiện tại có bị khóa (locked) về 1 không (VD: Image mode)
        if (dialWrap.classList.contains('concurrent-locked')) {
          concurrentCount = 1;
        } else {
          // Lấy số người dùng chọn (nếu có), không thì lấy số 2 mặc định
          const hiddenInput = dialWrap.querySelector('input.concurrent-value');
          if (hiddenInput && hiddenInput.value) {
            concurrentCount = parseInt(hiddenInput.value, 10) || 2;
          }
        }
      }

      // 1. Lấy thông số Delay
      let minDelay = 20;
      let maxDelay = 30;
      // Tìm delay inputs trong mode-config (wrapper) nếu không có trong activeSection
      let delaySource = activeSection;
      const activeModeConfigForDelay = document.querySelector('.mode-config.active');
      if (activeModeConfigForDelay && !activeSection.querySelector('.delay-wrapper')) {
        delaySource = activeModeConfigForDelay;
      }
      const delayInputs = delaySource.querySelectorAll('.delay-wrapper input[type="number"]');
      if (delayInputs.length >= 2) {
        minDelay = parseInt(delayInputs[0].value) || 20;
        maxDelay = parseInt(delayInputs[1].value) || 30;
      }

      // 2. Lấy thông số Default Mode từ Setting Tab
      // ==========================================
      // SỬA LẠI: ƯU TIÊN CHẾ ĐỘ ĐANG MỞ Ở TAB CONTROL
      // ==========================================
      let selectedMode = "text-to-video"; // Mặc định

      // 1. Lấy ID của tab đang mở (VD: ingredients-to-video)
      if (activeSection) {
        selectedMode = activeSection.id;
      }

      // 2. Chỉ khi nào không xác định được tab, mới dùng Default Mode trong Setting
      // const modeSelect = document.getElementById('default-mode-select');
      // if (!activeSection && modeSelect) {
      //   selectedMode = modeSelect.options[modeSelect.selectedIndex].text;
      // }

      if (!activeSection) {
        selectedMode = "text-to-video"; // Giá trị mặc định an toàn nếu không tìm thấy tab
      }

      console.log("-> Mode được chọn để gửi xuống web:", selectedMode);

      let videoModel = 'veo-3.1-fast'; // Mặc định
      let imageModel = 'nano-banana-2'; // Mặc định
      let videoAspectRatio = '16:9'; // Biến cho video
      let imageAspectRatio = '16:9'; // Biến cho ảnh
      let videoModeOption = '8 seconds'; // Mặc định

      const settingTab = document.getElementById('setting-tab');

      if (activeSection) {
        const labels = activeSection.querySelectorAll('label');
        labels.forEach(label => {
          if (label.textContent.includes('Default Video Mode Option')) {
            const sel = label.nextElementSibling;
            if (sel && sel.tagName === 'SELECT') {
              videoModeOption = sel.value;
            }
          }
        });
      }

      if (settingTab) {
        const allSelects = settingTab.querySelectorAll('select');
        allSelects.forEach(sel => {
          const label = sel.previousElementSibling;
          if (label) {
            // Phân biệt label có chữ "Model" nhưng không có chữ "Image"
            if (label.textContent.includes('Model') && !label.textContent.includes('Image')) {
              videoModel = sel.value;
            }
            // Phân biệt label Image Model
            if (label.textContent.includes('Image Model')) {
              imageModel = sel.value;
            }

            // Lấy Aspect Ratio cho Video
            if (label.textContent.includes('Default Aspect Ratio') || label.textContent.includes('Video Aspect Ratio')) {
              videoAspectRatio = sel.value;
            }
            // Lấy Aspect Ratio cho Image
            if (label.textContent.includes('Image Aspect Ratio')) {
              imageAspectRatio = sel.value;
            }
          }
        });
      }

      videoModel = normalizeVideoModelValue(videoModel);

      // 2. Cập nhật giao diện Hàng đợi (Queue) cho TẤT CẢ các prompt
      const groupId = "group-" + Date.now().toString().slice(-6);
      const groupCreatedAt = new Date();
      const groupDisplayName = `${promptList.length} prompts • ${formatGroupCreatedAt(groupCreatedAt)}`;

      let itemsHtml = '';
      promptList.forEach((promptText, index) => {
        // Cắt ngắn prompt nếu quá dài để hiển thị cho đẹp
        const shortPrompt = promptText.length > 40 ? promptText.substring(0, 40) + '...' : promptText;
        itemsHtml += `
          <div class="queue-item running" id="item-${groupId}-${index}">
            <div class="queue-item-row">
              <div class="queue-item-left">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
                ${index + 1}. ${shortPrompt}
              </div>
              <div class="status-text">Pending</div>
            </div>
          </div>
        `;
      });

      const groupHtml = `
        <div class="queue-group" id="${groupId}">
          <div class="queue-group-header">
            <div class="queue-group-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
              ${groupDisplayName}
              <span class="badge-running">Running</span>
            </div>
            <button class="btn-stop">Stop</button>
          </div>
          <div class="queue-group-subtext">0/${promptList.length} prompts</div>
          ${itemsHtml}
        </div>
      `;

      if (queueBody) {
        queueBody.insertAdjacentHTML('afterbegin', groupHtml);
        refreshActiveCount();
      }

      const serializedUploadedFiles = await serializeFilesForMessage(uploadedFilesRegistry[selectedMode] || []);
      const promptImagePlan = collectPromptImagePlanFromReview(activeSection, promptList.length);

      try {
        chrome.runtime.sendMessage({
          action: 'SET_DOWNLOAD_SUBFOLDER',
          folder: saveToFolder
        }).catch(() => { });
      } catch (e) { }

      // 3. Gửi danh sách Prompts xuống trang web hiện tại
      // 3. Gửi danh sách Prompts VÀ số lượng Output xuống trang web
      if (chrome && chrome.tabs) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs && tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
              action: "run_automation",
              groupId: groupId,
              prompts: promptList,
              promptModes: promptModes,
              outputCount: outputCount,
              concurrentCount: concurrentCount,
              minDelay: minDelay,
              maxDelay: maxDelay,
              selectedMode: selectedMode,
              videoModel: videoModel,    // Bơm Model Video xuống
              imageModel: imageModel,     // Bơm Model Hình ảnh xuống
              // aspectRatio: aspectRatio,
              aspectRatio: selectedMode.includes('image') ? imageAspectRatio : videoAspectRatio,
              videoModeOption: videoModeOption,
              uploadedFiles: serializedUploadedFiles,
              promptImagePlan: promptImagePlan,
              maxInputImagesPerPrompt: maxInputImagesPerPrompt,
              saveToFolder: saveToFolder
            }, (response) => {
              if (chrome.runtime.lastError) {
                alert("Không thể kết nối với trang web. Hãy F5 lại trang web bạn muốn chạy tool.");
              }
            });
          }
        });
      }
    });
  });

  // ==========================================
  // 5. TÍNH NĂNG UPLOAD FILE .TXT (ĐIỀN VÀO PROMPTS)
  // ==========================================
  const uploadBtns = document.querySelectorAll('.upload-btn');

  uploadBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      // Tạo một thẻ input file ẩn trong bộ nhớ
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = '.txt';

      // Lắng nghe sự kiện khi chọn file xong
      fileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) return;

        // Dùng FileReader để đọc nội dung file văn bản
        const reader = new FileReader();
        reader.onload = (e) => {
          const content = e.target.result;
          // Đổ nội dung file txt vào ô nhập liệu textarea gần nhất
          const textArea = btn.closest('.prompt-card').querySelector('textarea');
          if (textArea) {
            textArea.value = content;
          }
        };
        reader.readAsText(file);
      });

      // Kích hoạt hộp thoại chọn file của máy tính
      fileInput.click();
    });
  });

  // ==========================================
  // 6. MỞ TRANG CÀI ĐẶT DOWNLOAD CỦA CHROME
  // ==========================================
  const downloadSettingBtn = document.querySelector('.download-settings-box .icon-btn');
  if (downloadSettingBtn) {
    downloadSettingBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'chrome://settings/downloads' });
    });
  }

  // ==========================================
  // 7. HỆ THỐNG DỊCH THUẬT ĐA NGÔN NGỮ (I18N)
  // ==========================================
  // ==========================================
  // 7. HỆ THỐNG DỊCH THUẬT ĐA NGÔN NGỮ (I18N)
  // ==========================================
  const translations = {
    "vi": {
      "User Guide": "Hướng dẫn", "Control": "Điều khiển", "Setting": "Cài đặt",
      "Free plan": "Gói miễn phí", "Text to Video": "Chữ thành Video",
      "Frame to Video": "Ảnh thành Video", "Ingredients to Video": "Nguyên liệu thành Video",
      "Text to Image": "Chữ thành Ảnh", "Ingredients to Image": "Nguyên liệu thành Ảnh",
      "Concurrent Prompts": "Xử lý đồng thời", "Random Delay": "Độ trễ ngẫu nhiên",
      "Prompts": "Câu lệnh", "Outputs per Prompt": "Số kết quả mỗi lệnh",
      "Save to folder": "Lưu thư mục", "Image Processing Option": "Tùy chọn xử lý ảnh",
      "Max Input Images per Prompt": "Số ảnh tối đa mỗi lệnh",
      "Auto-add character images": "Tự động thêm ảnh nhân vật",
      "Auto change file name": "Tự động đổi tên file", "PROMPT QUEUE": "HÀNG ĐỢI LỆNH",
      "Clear": "Xóa", "Run": "Chạy", "Default Mode": "Chế độ mặc định",
      "Model": "Mô hình Video", "Image Model": "Mô hình Ảnh",
      "Default Aspect Ratio": "Tỉ lệ khung hình", "Default Video Mode Option": "Tùy chọn Video",
      "Default Image ModeOption": "Tùy chọn Ảnh", "Max Retries on Failure": "Số lần thử lại khi lỗi",
      "Auto Download Quality (Video)": "Chất lượng Video tải xuống",
      "Auto Download Quality (Image)": "Chất lượng Ảnh tải xuống",
      "Language": "Ngôn ngữ", "Download Settings": "Cài đặt tải xuống",
      "Reset Defaults": "Khôi phục gốc", "Save Settings": "Lưu cài đặt"
    },
    "zh": {
      "User Guide": "用户指南", "Control": "控制", "Setting": "设置",
      "Free plan": "免费计划", "Text to Video": "文本到视频",
      "Frame to Video": "帧到视频", "Ingredients to Video": "素材到视频",
      "Text to Image": "文本到图像", "Ingredients to Image": "素材到图像",
      "Concurrent Prompts": "并发提示", "Random Delay": "随机延迟",
      "Prompts": "提示词", "Outputs per Prompt": "每个提示的输出",
      "Save to folder": "保存到文件夹", "Image Processing Option": "图像处理选项",
      "Max Input Images per Prompt": "每个提示最大输入图像",
      "Auto-add character images": "自动添加角色图像", "Auto change file name": "自动更改文件名",
      "PROMPT QUEUE": "提示队列", "Clear": "清除", "Run": "运行",
      "Default Mode": "默认模式", "Model": "视频模型", "Image Model": "图像模型",
      "Default Aspect Ratio": "默认纵横比", "Default Video Mode Option": "默认视频模式选项",
      "Default Image ModeOption": "默认图像模式选项", "Max Retries on Failure": "失败时最大重试次数",
      "Auto Download Quality (Video)": "自动下载质量 (视频)", "Auto Download Quality (Image)": "自动下载质量 (图像)",
      "Language": "语言", "Download Settings": "下载设置",
      "Reset Defaults": "恢复默认值", "Save Settings": "保存设置"
    },
    "ko": {
      "User Guide": "사용자 가이드", "Control": "제어", "Setting": "설정",
      "Free plan": "무료 플랜", "Text to Video": "텍스트를 비디오로",
      "Frame to Video": "프레임을 비디오로", "Ingredients to Video": "재료를 비디오로",
      "Text to Image": "텍스트를 이미지로", "Ingredients to Image": "재료를 이미지로",
      "Concurrent Prompts": "동시 프롬프트", "Random Delay": "무작위 지연",
      "Prompts": "프롬프트", "Outputs per Prompt": "프롬프트 당 출력",
      "Save to folder": "폴더에 저장", "Image Processing Option": "이미지 처리 옵션",
      "Max Input Images per Prompt": "프롬프트 당 최대 입력 이미지",
      "Auto-add character images": "캐릭터 이미지 자동 추가", "Auto change file name": "파일 이름 자동 변경",
      "PROMPT QUEUE": "프롬프트 대기열", "Clear": "지우기", "Run": "실행",
      "Default Mode": "기본 모드", "Model": "비디오 모델", "Image Model": "이미지 모델",
      "Default Aspect Ratio": "기본 가로 세로 비율", "Default Video Mode Option": "기본 비디오 모드 옵션",
      "Default Image ModeOption": "기본 이미지 모드 옵션", "Max Retries on Failure": "실패 시 최대 재시도",
      "Auto Download Quality (Video)": "자동 다운로드 품질 (비디오)", "Auto Download Quality (Image)": "자동 다운로드 품질 (이미지)",
      "Language": "언어", "Download Settings": "다운로드 설정",
      "Reset Defaults": "기본값 복원", "Save Settings": "설정 저장"
    },
    "ja": {
      "User Guide": "ユーザーガイド", "Control": "コントロール", "Setting": "設定",
      "Free plan": "無料プラン", "Text to Video": "テキストから動画",
      "Frame to Video": "フレームから動画", "Ingredients to Video": "素材から動画",
      "Text to Image": "テキストから画像", "Ingredients to Image": "素材から画像",
      "Concurrent Prompts": "同時プロンプト", "Random Delay": "ランダム遅延",
      "Prompts": "プロンプト", "Outputs per Prompt": "プロンプトごとの出力",
      "Save to folder": "フォルダに保存", "Image Processing Option": "画像処理オプション",
      "Max Input Images per Prompt": "プロンプトごとの最大入力画像",
      "Auto-add character images": "キャラクター画像を自動追加", "Auto change file name": "ファイル名を自動変更",
      "PROMPT QUEUE": "プロンプトキュー", "Clear": "クリア", "Run": "実行",
      "Default Mode": "デフォルトモード", "Model": "動画モデル", "Image Model": "画像モデル",
      "Default Aspect Ratio": "デフォルトのアスペクト比", "Default Video Mode Option": "デフォルトの動画モードオプション",
      "Default Image ModeOption": "デフォルトの画像モードオプション", "Max Retries on Failure": "失敗時の最大再試行回数",
      "Auto Download Quality (Video)": "自動ダウンロード品質 (動画)", "Auto Download Quality (Image)": "自動ダウンロード品質 (画像)",
      "Language": "言語", "Download Settings": "ダウンロード設定",
      "Reset Defaults": "デフォルトに戻す", "Save Settings": "設定を保存"
    },
    "es": {
      "User Guide": "Guía del usuario", "Control": "Control", "Setting": "Ajustes",
      "Free plan": "Plan gratuito", "Text to Video": "Texto a video",
      "Frame to Video": "Fotograma a video", "Ingredients to Video": "Ingredientes a video",
      "Text to Image": "Texto a imagen", "Ingredients to Image": "Ingredientes a imagen",
      "Concurrent Prompts": "Prompts simultáneos", "Random Delay": "Retraso aleatorio",
      "Prompts": "Prompts", "Outputs per Prompt": "Salidas por prompt",
      "Save to folder": "Guardar en carpeta", "Image Processing Option": "Opción de procesamiento",
      "Max Input Images per Prompt": "Máx. imágenes por prompt",
      "Auto-add character images": "Añadir auto imágenes", "Auto change file name": "Cambio automático de archivo",
      "PROMPT QUEUE": "COLA DE PROMPTS", "Clear": "Borrar", "Run": "Ejecutar",
      "Default Mode": "Modo predeterminado", "Model": "Modelo de video", "Image Model": "Modelo de imagen",
      "Default Aspect Ratio": "Relación de aspecto", "Default Video Mode Option": "Opción de video predeterminada",
      "Default Image ModeOption": "Opción de imagen predeterminada", "Max Retries on Failure": "Máx. reintentos",
      "Auto Download Quality (Video)": "Calidad de descarga (Video)", "Auto Download Quality (Image)": "Calidad de descarga (Imagen)",
      "Language": "Idioma", "Download Settings": "Ajustes de descarga",
      "Reset Defaults": "Restablecer valores", "Save Settings": "Guardar ajustes"
    }
  };

  const originalTexts = new Map();

  function applyLanguage(lang) {
    const elements = document.querySelectorAll('.main-tab, .card-content, label, span, button, a, strong');

    elements.forEach(el => {
      el.childNodes.forEach(node => {
        if (node.nodeType === 3 && node.nodeValue.trim() !== '') {
          if (!originalTexts.has(node)) {
            originalTexts.set(node, node.nodeValue);
          }

          const original = originalTexts.get(node);
          const iconRegex = /^(⎘|⚙|⚡|🕒|📄|🗎|📁|👤|🖼️|📹|🍌|↺|📥|A文|👑|↻|✓|▷|☁️|☷)\s*/;
          const cleanKey = original.replace(iconRegex, '').trim();

          if (lang === 'en') {
            node.nodeValue = originalTexts.get(node);
          } else if (translations[lang] && translations[lang][cleanKey]) {
            const iconMatch = original.match(iconRegex);
            const icon = iconMatch ? iconMatch[0] : '';
            const spaceBefore = original.startsWith(' ') ? ' ' : '';
            const spaceAfter = original.endsWith(' ') ? ' ' : '';

            node.nodeValue = spaceBefore + icon + translations[lang][cleanKey] + spaceAfter;
          }
        }
      });
    });
  }

  const langDropdowns = document.querySelectorAll('.lang-select');
  langDropdowns.forEach(dropdown => {
    dropdown.addEventListener('change', (e) => {
      const selectedLang = e.target.value;

      // Đồng bộ các menu chọn ngôn ngữ
      langDropdowns.forEach(dd => dd.value = selectedLang);

      // Chạy dịch thuật
      applyLanguage(selectedLang);

      // Cập nhật lại thanh trượt
      const activeTab = document.querySelector('.main-tab.active');
      setTimeout(() => updateSlider(activeTab), 50);
    });
  });

});

// ==========================================
// 8. TÍNH NĂNG KHÔI PHỤC GỐC (RESET DEFAULTS)
// ==========================================
const btnReset = document.querySelector('.btn-reset');

// 1. Tìm tất cả các trường nhập liệu trên giao diện
const allInputs = document.querySelectorAll('input, select, textarea');
const defaultValues = new Map();

// 2. Lưu lại trạng thái gốc của chúng ngay khi vừa mở Popup
allInputs.forEach(input => {
  if (input.type === 'checkbox') {
    defaultValues.set(input, input.checked); // Lưu trạng thái bật/tắt
  } else {
    defaultValues.set(input, input.value); // Lưu giá trị chữ/số
  }
});

// 3. Xử lý khi bấm nút "Reset Defaults"
if (btnReset) {
  btnReset.addEventListener('click', () => {
    allInputs.forEach(input => {
      // Trả lại giá trị gốc
      if (input.type === 'checkbox') {
        input.checked = defaultValues.get(input);
      } else {
        input.value = defaultValues.get(input);
      }

      // Kích hoạt sự kiện 'change' để các chức năng khác (như tự động dịch ngôn ngữ) nhận biết
      input.dispatchEvent(new Event('change'));
    });

    // Tạo hiệu ứng UX nhỏ: Đổi màu nút tạm thời để báo hiệu đã Reset thành công
    const originalBg = btnReset.style.background;
    const originalColor = btnReset.style.color;
    btnReset.style.background = 'var(--primary)';
    btnReset.style.color = '#000';

    setTimeout(() => {
      btnReset.style.background = originalBg;
      btnReset.style.color = originalColor;
    }, 500);
  });
}

// ==========================================
// 9. UPLOAD NHIỀU ẢNH (Drag & Drop, Xóa ảnh, Add thêm ảnh, Sắp xếp)
// ==========================================
const uploadZones = document.querySelectorAll('.upload-zone');

uploadZones.forEach(zone => {
  let allFiles = [];
  let headerContainer = null;
  let previewContainer = zone.querySelector('.preview-container');
  const modeSection = zone.closest('.mode-section');
  const modeSectionId = modeSection ? modeSection.id : null;

  const syncRegistry = () => {
    if (!modeSectionId) return;
    uploadedFilesRegistry[modeSectionId] = [...allFiles];
  };

  if (!previewContainer) {
    previewContainer = document.createElement('div');
    previewContainer.className = 'preview-container';
    zone.appendChild(previewContainer);
  }

  // --- HÀM VẼ LẠI GIAO DIỆN CHỨA ẢNH ---
  const renderImages = (filesToRender) => {
    if (headerContainer) {
      headerContainer.querySelector('.preview-title').textContent = `Images (${filesToRender.length})`;
    }
    previewContainer.innerHTML = '';

    filesToRender.forEach((file, index) => {
      const item = document.createElement('div');
      item.className = 'preview-item';

      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.title = file.name;

      const deleteIcon = document.createElement('div');
      deleteIcon.className = 'delete-icon';
      deleteIcon.innerHTML = '🗑️';
      deleteIcon.title = 'Xóa ảnh này';

      deleteIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        const fileIndexInAllFiles = allFiles.findIndex(f => f.name === file.name && f.lastModified === file.lastModified);
        if (fileIndexInAllFiles !== -1) {
          allFiles.splice(fileIndexInAllFiles, 1);
          syncRegistry();
        }
        item.remove();

        if (headerContainer) {
          headerContainer.querySelector('.preview-title').textContent = `Images (${allFiles.length})`;
        }

        if (allFiles.length === 0) {
          zone.classList.remove('has-previews');
          if (headerContainer) headerContainer.remove();
          headerContainer = null;
          // Hiện lại chữ hướng dẫn
          const guideP = zone.querySelector('p');
          if (guideP) guideP.style.display = 'block';
        } else {
          const sortSelect = headerContainer.querySelector('.preview-sort');
          if (sortSelect) sortSelect.dispatchEvent(new Event('change'));
        }
      });

      item.appendChild(img);
      item.appendChild(deleteIcon);
      previewContainer.appendChild(item);
    });
  };

  // --- HÀM TẠO HOẶC CẬP NHẬT HEADER ---
  const createOrUpdateHeader = () => {
    if (headerContainer) return;

    const guideP = zone.querySelector('p');
    if (guideP) guideP.style.display = 'none'; // Ẩn chữ hướng dẫn

    headerContainer = document.createElement('div');
    headerContainer.className = 'preview-header';

    const title = document.createElement('div');
    title.className = 'preview-title';
    title.textContent = `Images (${allFiles.length})`;

    const actionsWrapper = document.createElement('div');
    actionsWrapper.className = 'header-actions';

    const sortSelect = document.createElement('select');
    sortSelect.className = 'preview-sort';
    sortSelect.innerHTML = `
        <option value="custom">Custom Order</option>
        <option value="az">Name A&rarr;Z</option>
        <option value="za">Name Z&rarr;A</option>
        <option value="newest">Newest</option>
        <option value="oldest">Oldest</option>
      `;

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-add-images';
    addBtn.textContent = 'Add images +';

    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const addFilesInput = document.createElement('input');
      addFilesInput.type = 'file';
      addFilesInput.multiple = true;
      addFilesInput.accept = 'image/png, image/jpeg, image/gif';
      addFilesInput.addEventListener('change', (e) => processFiles(e.target.files));
      addFilesInput.click();
    });

    sortSelect.addEventListener('change', (e) => {
      const sortType = e.target.value;
      let sortedFiles = [...allFiles];

      if (sortType === 'az') {
        sortedFiles.sort((a, b) => a.name.localeCompare(b.name));
      } else if (sortType === 'za') {
        sortedFiles.sort((a, b) => b.name.localeCompare(a.name));
      } else if (sortType === 'newest') {
        sortedFiles.sort((a, b) => b.lastModified - a.lastModified);
      } else if (sortType === 'oldest') {
        sortedFiles.sort((a, b) => a.lastModified - b.lastModified);
      }
      renderImages(sortedFiles);
    });

    actionsWrapper.appendChild(sortSelect);
    actionsWrapper.appendChild(addBtn);
    headerContainer.appendChild(title);
    headerContainer.appendChild(actionsWrapper);
    zone.insertBefore(headerContainer, previewContainer);
  };

  // --- HÀM XỬ LÝ FILE DÙNG CHUNG (CHO CẢ CLICK VÀ KÉO THẢ) ---
  const processFiles = (fileList) => {
    const newFiles = Array.from(fileList).filter(file => file.type.startsWith('image/')); // Chỉ lấy file ảnh
    if (newFiles.length === 0) return;

    allFiles = allFiles.concat(newFiles);
    syncRegistry();
    zone.classList.add('has-previews');
    createOrUpdateHeader();
    renderImages(allFiles);

    const ta = zone.closest('.mode-section').querySelector('textarea');
    if (ta) ta.dispatchEvent(new Event('input'));

    const sortSelect = headerContainer.querySelector('.preview-sort');
    if (sortSelect) sortSelect.value = 'custom';
  };

  // --- SỰ KIỆN CLICK CHỌN FILE ---
  zone.addEventListener('click', (e) => {
    if (e.target.closest('.preview-item') || e.target.closest('.preview-header')) return;
    const firstUploadInput = document.createElement('input');
    firstUploadInput.type = 'file';
    firstUploadInput.multiple = true;
    firstUploadInput.accept = 'image/png, image/jpeg, image/gif';
    firstUploadInput.addEventListener('change', (e) => processFiles(e.target.files));
    firstUploadInput.click();
  });

  // ==============================================
  // --- SỰ KIỆN KÉO THẢ FILE (DRAG & DROP) ---
  // ==============================================

  // Khi kéo file lơ lửng trên zone
  zone.addEventListener('dragover', (e) => {
    e.preventDefault(); // Rất quan trọng: Bắt buộc để cho phép drop
    zone.classList.add('dragover');
  });

  // Khi kéo file ra khỏi zone
  zone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
  });

  // Khi thả file vào zone
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');

    // Lấy danh sách file từ dataTransfer
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  });

  zone.style.cursor = 'pointer';
});

document.addEventListener('DOMContentLoaded', () => {
  // Tìm tất cả các ô input dạng số (Dựa theo logic 2 ô cuối là độ trễ)
  const allNumInputs = document.querySelectorAll('input[type="number"]');

  if (allNumInputs.length >= 2) {
    const minDelayInput = allNumInputs[allNumInputs.length - 2];
    const maxDelayInput = allNumInputs[allNumInputs.length - 1];

    // 1. Khi vừa mở popup: TẢI giá trị đã lưu từ bộ nhớ lên giao diện
    chrome.storage.local.get(['savedMinDelay', 'savedMaxDelay'], (result) => {
      if (result.savedMinDelay) minDelayInput.value = result.savedMinDelay;
      if (result.savedMaxDelay) maxDelayInput.value = result.savedMaxDelay;
    });

    // 2. Khi người dùng sửa số: LƯU NGAY LẬP TỨC vào bộ nhớ
    const saveDelaySettings = () => {
      chrome.storage.local.set({
        savedMinDelay: minDelayInput.value,
        savedMaxDelay: maxDelayInput.value
      });
    };

    // Bắt sự kiện 'input' để lưu ngay lúc đang gõ phím
    minDelayInput.addEventListener('input', saveDelaySettings);
    maxDelayInput.addEventListener('input', saveDelaySettings);
  }
});

// ==========================================
// LẮNG NGHE BÁO CÁO VÀ VẼ PROGRESS BAR VÀO POPUP
// ==========================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "GEMINI_PREVIEW_UPDATE") {
    const previewBox = document.getElementById('cp-preview');
    const ideaPreviewBox = document.getElementById('cp-preview-idea');
    const cloneAudioPreviewBox = document.getElementById('cv-audio-prompt-preview');
    const previewText = String(request.previewText || '');
    const runToken = String(request.runToken || '');
    const isFinal = Boolean(request.isFinal);

    if (previewBox) {
      previewBox.value = previewText;
    }
    if (ideaPreviewBox) {
      ideaPreviewBox.value = previewText;
    }
    if (cloneAudioPreviewBox && runToken.startsWith('clone-audio')) {
      cloneAudioPreviewBox.value = previewText;
    }

    if (runToken && isFinal) {
      const pending = pendingGeminiPreviewResolvers.get(runToken);
      if (pending?.resolve) {
        pendingGeminiPreviewResolvers.delete(runToken);
        pending.resolve({ previewText, isFinal: true, runToken });
      }
    }

    chrome.storage.local.set({ geminiPreviewContent: previewText }).catch(() => { });
    return;
  }

  if (request.action === "UPDATE_QUEUE_STATUS") {
    let targetItem = null;

    if (request.groupId !== undefined && request.index !== undefined) {
      targetItem = document.getElementById(`item-${request.groupId}-${request.index}`);
    }

    if (!targetItem) {
      const queueItems = document.querySelectorAll('.queue-item');
      targetItem = queueItems[request.index];
    }

    if (targetItem) {
      const parentGroup = targetItem.closest('.queue-group');
      if (parentGroup && parentGroup.classList.contains('stopped')) {
        return;
      }

      const completedIconMarkup = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 6 9 17l-5-5"></path>
        </svg>
      `;

      // MỚI: Tìm cái icon xoay ở đầu dòng (thường là thẻ svg hoặc i)
      const loadingIcon = targetItem.querySelector('svg') || targetItem.querySelector('i');
      const leftBlock = targetItem.querySelector('.queue-item-left');

      // 1. Cập nhật chữ (Pending -> Đang tạo -> Xong)
      const statusText = targetItem.querySelector('.status-text');
      if (statusText) {
        // Tạm thời ẩn phần hiển thị % trong status text, sẽ bật lại sau nếu cần.
        const statusWithoutPercent = String(request.status || '')
          .replace(/\s*\(?\d+%\)?/g, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
        statusText.textContent = statusWithoutPercent;

        if (request.status.includes("Xong")) {
          targetItem.classList.remove('running', 'submitted');
          targetItem.classList.add('completed');
          statusText.style.color = "#4fd1c5"; // Chữ màu Xanh lá

          if (leftBlock) {
            const labelText = leftBlock.textContent.replace(/^\s*/, '');
            leftBlock.innerHTML = `${completedIconMarkup}${labelText}`;
          } else if (loadingIcon) {
            loadingIcon.style.animation = "none";
            loadingIcon.style.color = "#4fd1c5";
            loadingIcon.style.stroke = "#4fd1c5";
          }

        } else if (request.status.includes("Đang")) {
          targetItem.classList.remove('completed');
          targetItem.classList.add('running');
          statusText.style.color = "#f59e0b"; // Chữ màu Cam vàng
        }
      }

      // 2. Vẽ và cập nhật Thanh Progress Bar bên trong ô màu cam
      if (request.percent !== undefined) {
        let progContainer = targetItem.querySelector('.item-progress-container');

        // Nếu chưa có thanh bar, tạo mới chèn vào dưới cùng
        if (!progContainer) {
          targetItem.insertAdjacentHTML('beforeend', `
                        <div class="item-progress-container" style="width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; margin-top: 10px; overflow: hidden;">
                            <div class="item-progress-fill" style="width: 0%; height: 100%; background: linear-gradient(90deg, #f59e0b, #4fd1c5); transition: width 0.5s ease;"></div>
                        </div>
                    `);
          progContainer = targetItem.querySelector('.item-progress-container');
        }

        // Chạy thanh màu xanh cho khớp %
        const fill = targetItem.querySelector('.item-progress-fill');
        if (fill) {
          fill.style.width = request.percent + '%';
          // Khi 100%, đổi cả thanh thành màu xanh lá cho đẹp
          if (request.percent >= 100) {
            fill.style.background = "#4fd1c5";
          }
        }
      }

      // 3. Cập nhật tiến độ tổng của group: x/y prompts
      if (parentGroup) {
        const allItems = parentGroup.querySelectorAll('.queue-item');
        const doneItems = parentGroup.querySelectorAll('.queue-item.completed');
        const subtext = parentGroup.querySelector('.queue-group-subtext');
        const badge = parentGroup.querySelector('.badge-running');
        const stopButton = parentGroup.querySelector('.btn-stop');
        const totalCount = allItems.length;
        const doneCount = doneItems.length;

        if (subtext) {
          subtext.textContent = `${doneCount}/${totalCount} prompts`;
        }

        if (totalCount > 0 && doneCount >= totalCount) {
          parentGroup.classList.add('completed');
          parentGroup.classList.remove('stopped');
          if (badge) {
            badge.textContent = 'Xong';
            badge.classList.add('badge-completed');
            badge.classList.remove('badge-stopped');
          }
          if (stopButton) {
            stopButton.style.display = 'none';
          }
        } else {
          parentGroup.classList.remove('completed');
          if (badge) {
            badge.textContent = 'Running';
            badge.classList.remove('badge-completed');
            badge.classList.remove('badge-stopped');
          }
          if (stopButton) {
            stopButton.style.display = '';
          }
        }

        const activeCountEl = document.querySelector('.active-count');
        if (activeCountEl) {
          const runningGroups = document.querySelectorAll('.queue-group:not(.completed):not(.stopped)').length;
          activeCountEl.textContent = `${runningGroups} active`;
        }
      }
    }
  }
});

// ==========================================
// XỬ LÝ LƯU TRỮ TẤT CẢ CÀI ĐẶT (TAB SETTING)
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  // Tìm các nút bấm
  const btnSave = document.querySelector('.btn-save');
  const btnReset = document.querySelector('.btn-reset');
  const settingTab = document.getElementById('setting-tab');

  if (btnSave && settingTab) {

    // --- Hàm Thu thập toàn bộ dữ liệu trên Tab Setting ---
    const getAllSettings = () => {
      const selects = settingTab.querySelectorAll('select');
      const inputs = settingTab.querySelectorAll('input');

      let settings = {};

      // Lưu tất cả giá trị của các thẻ <select>
      selects.forEach((select, index) => {
        // Tạo một key độc nhất dựa trên id hoặc thứ tự của nó
        const key = select.id || `setting_select_${index}`;
        settings[key] = select.value;
      });

      // Lưu tất cả giá trị của các thẻ <input>
      inputs.forEach((input, index) => {
        const key = input.id || `setting_input_${index}`;
        // Kiểm tra nếu là checkbox thì lưu trạng thái checked, ngược lại lưu value
        settings[key] = input.type === 'checkbox' ? input.checked : input.value;
      });

      return settings;
    };

    // --- 1. TẢI CÀI ĐẶT LÊN GIAO DIỆN KHI MỞ POPUP ---
    chrome.storage.local.get(['veo_auto_settings'], (result) => {
      if (result.veo_auto_settings) {
        const savedSettings = result.veo_auto_settings;
        const selects = settingTab.querySelectorAll('select');
        const inputs = settingTab.querySelectorAll('input');

        selects.forEach((select, index) => {
          const key = select.id || `setting_select_${index}`;
          if (savedSettings[key] !== undefined) {
            select.value = savedSettings[key];

            if (select.selectedIndex === -1) {
              const label = select.previousElementSibling;
              if (label && label.textContent.includes('Video Model')) {
                select.value = normalizeVideoModelValue(savedSettings[key]);
              } else if (select.options.length > 0) {
                select.selectedIndex = 0;
              }
            }
          }
        });

        inputs.forEach((input, index) => {
          const key = input.id || `setting_input_${index}`;
          if (savedSettings[key] !== undefined) {
            if (input.type === 'checkbox') {
              input.checked = savedSettings[key];
            } else {
              input.value = savedSettings[key];
            }
          }
        });
      }
    });

    // --- 2. BẤM NÚT SAVE SETTINGS ---
    btnSave.addEventListener('click', () => {

      // --- BƯỚC 1: ÉP HIỆU ỨNG THỊ GIÁC NGAY LẬP TỨC ---
      const originalText = btnSave.innerHTML;

      btnSave.innerHTML = "✅ Saved Successfully!";
      btnSave.style.setProperty('background-color', '#10b981', 'important');
      btnSave.style.setProperty('color', '#ffffff', 'important');
      btnSave.style.setProperty('border-color', '#10b981', 'important');

      // Trả lại trạng thái cũ sau 2 giây
      setTimeout(() => {
        btnSave.innerHTML = originalText;
        btnSave.style.removeProperty('background-color');
        btnSave.style.removeProperty('color');
        btnSave.style.removeProperty('border-color');
      }, 2000);

      // --- BƯỚC 2: TIẾN HÀNH LƯU DỮ LIỆU (Có try-catch để chặn lỗi sập web) ---
      try {
        const currentSettings = getAllSettings();
        chrome.storage.local.set({ veo_auto_settings: currentSettings }, () => {
          console.log("Đã lưu cài đặt vào bộ nhớ Chrome:", currentSettings);
        });
      } catch (error) {
        console.error("Lỗi trong quá trình lấy dữ liệu cài đặt:", error);
      }
    });

    // --- 3. BẤM NÚT RESET DEFAULTS ---
    if (btnReset) {
      btnReset.addEventListener('click', () => {
        if (confirm("Are you sure you want to reset all settings to default?")) {
          // Xóa dữ liệu trong bộ nhớ Chrome
          chrome.storage.local.remove('veo_auto_settings', () => {
            // Tải lại Popup để mọi thứ về mặc định theo file HTML gốc
            window.location.reload();
          });
        }
      });
    }
  }
});

// ==========================================
// HIỆU ỨNG PREVIEW PROMPT (ĐỒNG BỘ LOGIC CONCAT & REUSE)
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  const promptTextAreas = document.querySelectorAll('.prompt-card textarea');

  const updatePreview = (textarea) => {
    const currentSection = textarea.closest('.mode-section');
    if (!currentSection) return;

    const reviewCard = currentSection.querySelector('.review-card');
    if (!reviewCard) return;

    const reviewList = reviewCard.querySelector('.review-list');
    const rawText = textarea.value;
    const prompts = rawText.split(/\n\s*\n/).map(p => p.trim()).filter(p => p !== "");

    if (prompts.length === 0) {
      reviewCard.style.display = 'none';
      reviewList.innerHTML = '';
      return;
    }

    reviewCard.style.display = 'block';

    // KIỂM TRA ĐÂY LÀ TAB VIDEO HAY IMAGE
    const isImageMode = currentSection.id.includes('image');
    const opt1 = isImageMode ? 'Create new' : '8s';
    const opt2 = isImageMode ? 'Reuse' : 'Concat';
    const hintText = isImageMode ? 'new-image' : '8s';

    const toggleInput = currentSection.querySelector('.feature-toggle-card input[type="checkbox"]');
    const isAutoAddON = toggleInput ? toggleInput.checked : false;

    let maxInputImages = 3;
    const labelsInSection = currentSection.querySelectorAll('label');
    labelsInSection.forEach(label => {
      if (label.textContent.includes('Max Input Images per Prompt')) {
        const selectElement = label.nextElementSibling;
        if (selectElement && selectElement.tagName === 'SELECT') {
          const parsed = parseInt(selectElement.value, 10);
          if (Number.isFinite(parsed)) {
            maxInputImages = Math.max(1, Math.min(3, parsed));
          }
        }
      }
    });

    let frameProcessOpt = 'first-frame';
    if (currentSection.id === 'frame-to-video') {
      const selects = currentSection.querySelectorAll('select');
      selects.forEach(sel => { if (sel.innerHTML.includes('first-frame')) frameProcessOpt = sel.value; });
    }

    const oldSelects = reviewList.querySelectorAll('.prompt-mode-select');
    const savedModes = [];
    oldSelects.forEach(sel => savedModes[sel.dataset.index] = sel.value);

    const uploadedImages = [];
    const imageElements = currentSection.querySelectorAll('.preview-container img');
    imageElements.forEach(img => {
      let rawName = img.title || img.name || "";
      let cleanName = rawName.replace(/\.[^/.]+$/, "").toLowerCase();
      uploadedImages.push({ name: cleanName, originalName: rawName, src: img.src });
    });

    let html = '';
    let imgIndex = 0;

    prompts.forEach((prompt, index) => {
      const charCount = prompt.length;
      const shortPrompt = charCount > 40 ? prompt.substring(0, 40) + '...' : prompt;
      const lowerPrompt = prompt.toLowerCase();

      // LUẬT ĐỒNG BỘ MỚI: Chỉ prompt cuối cùng bị khóa opt1 (Create new / 8s)
      let currentMode = opt1;
      if (index === prompts.length - 1) {
        currentMode = opt1;
      } else {
        currentMode = savedModes[index] || opt1;
      }

      // LUẬT ĐỒNG BỘ MỚI: Thằng này nhận ảnh từ thằng trước nếu thằng TRƯỚC chọn opt2 (Reuse / Concat)
      const isReceivingChain = (index > 0 && savedModes[index - 1] === opt2);

      let finalImagesToRender = [];

      // TAB: FRAME TO VIDEO
      if (currentSection.id === 'frame-to-video') {
        if (isReceivingChain) {
          finalImagesToRender.push({ type: 'placeholder_last_frame' });
        } else {
          if (imgIndex < uploadedImages.length) { finalImagesToRender.push(uploadedImages[imgIndex]); imgIndex++; }
        }
        if (frameProcessOpt === 'first-last-frame' && imgIndex < uploadedImages.length && !isReceivingChain) {
          finalImagesToRender.push(uploadedImages[imgIndex]); imgIndex++;
        }
      }
      // TAB: INGREDIENTS TO VIDEO / IMAGE
      else if (currentSection.id === 'ingredients-to-video' || currentSection.id === 'ingredients-to-image') {
        if (isReceivingChain) {
          finalImagesToRender.push({ type: isImageMode ? 'placeholder_reuse' : 'placeholder_last_frame' });
        } else {
          uploadedImages.forEach(imgData => {
            if (!isAutoAddON || lowerPrompt.includes(imgData.name)) finalImagesToRender.push(imgData);
          });

          if (currentSection.id === 'ingredients-to-video') {
            finalImagesToRender = finalImagesToRender.slice(0, maxInputImages);
          }
        }
      }
      // TAB: TEXT TO VIDEO / IMAGE
      else if (currentSection.id === 'text-to-video' || currentSection.id === 'text-to-image') {
        if (isReceivingChain) {
          finalImagesToRender.push({ type: isImageMode ? 'placeholder_reuse' : 'placeholder_last_frame' });
        }
      }

      let matchedImagesHtml = '';
      let noMatchBanner = '';

      if (currentSection.id.includes('ingredients') && isAutoAddON && !isReceivingChain && finalImagesToRender.length === 0) {
        noMatchBanner = `
            <div style="width: 100%; display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); border-radius: 4px; margin-top: 4px; margin-bottom: 2px;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#aaa" stroke-width="2"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg>
              <span style="color: #aaa; font-size: 11px;">No matching character images found</span>
            </div>`;
      }

      finalImagesToRender.forEach((imgData) => {
        if (imgData.type === 'placeholder_last_frame') {
          matchedImagesHtml += `
                <div style="position: relative; margin-right: 6px; width: 44px; height: 44px; border: 1px dashed #888; border-radius: 6px; display: flex; flex-direction: column; justify-content: center; align-items: center; background: rgba(255,255,255,0.02);">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2" style="margin-bottom: 2px;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
                  <span style="color: #888; font-size: 8px; font-weight: bold; text-align: center; line-height: 1;">Last<br>Frame</span>
                </div>`;
        } else if (imgData.type === 'placeholder_reuse') {
          matchedImagesHtml += `
                <div style="position: relative; margin-right: 6px; width: 44px; height: 44px; border: 1px dashed #888; border-radius: 6px; display: flex; flex-direction: column; justify-content: center; align-items: center; background: rgba(255,255,255,0.02);">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2" style="margin-bottom: 2px;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="12" cy="10" r="3"></circle><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                  <span style="color: #888; font-size: 8px; font-weight: bold; text-align: center; line-height: 1;">Reuse</span>
                </div>`;
        } else {
          matchedImagesHtml += `
                <div style="position: relative; margin-right: 6px; width: 44px; height: 44px;">
                  <img src="${imgData.src}" title="${imgData.originalName}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 6px; border: 1px solid #4fd1c5; box-shadow: 0 2px 4px rgba(0,0,0,0.5);">
                </div>`;
        }
      });

      let imagePreviewContainer = matchedImagesHtml ? `<div style="display: flex; flex-wrap: wrap; margin-top: 6px;">${matchedImagesHtml}</div>` : '';

      // ========= TẠO DROPDOWN AUDIO =========
      // ========= TẠO DROPDOWN AUDIO =========
      let audioSelectHtml = '';
      if (currentSection.id === 'ingredients-to-video' && finalImagesToRender.length > 0) {
        audioSelectHtml = `
          <div style="position: relative; margin-top: 6px; width: 100%;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4fd1c5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="position: absolute; left: 8px; top: 50%; transform: translateY(-50%); pointer-events: none;">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
            </svg>
            <select class="prompt-audio-select" data-index="${index}" style="width: 100%; height: 30px; box-sizing: border-box; padding: 0 6px 0 26px; background: #1a1a1a; border: 1px solid #333; color: white; border-radius: 4px; outline: none; font-size: 11px; text-overflow: ellipsis;">
              <option value="">-- Không kèm --</option>
              <option value="audio_1">Bản ghi âm 1</option>
            </select>
          </div>
        `;
      }
      // ======================================

      // TẠO LỰA CHỌN CHO DROPDOWN THEO LUẬT MỚI
      let selectOptions = '';
      if (index === prompts.length - 1) {
        selectOptions = `<option value="${opt1}" selected>${opt1}</option>`;
      } else {
        selectOptions = `<option value="${opt1}" ${currentMode === opt1 ? 'selected' : ''}>${opt1}</option><option value="${opt2}" ${currentMode === opt2 ? 'selected' : ''}>${opt2}</option>`;
      }

      let dynamicHint = currentMode === opt2
        ? (isImageMode ? 'Next prompt reuses this output' : 'Concat with next prompt')
        : `${charCount} characters - <span class="mode-label" style="color: #4fd1c5;">${hintText}</span>`;

      html += `
        <div class="review-item" style="display: flex; align-items: flex-start; gap: 12px; padding: 10px 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; margin-bottom: 8px;">
          
          <div style="display: flex; flex-direction: column; width: 115px; flex-shrink: 0; margin-top: 2px;">
            <select class="prompt-mode-select" data-index="${index}" style="width: 100%; height: 30px; box-sizing: border-box; padding: 0 6px; background: #1a1a1a; border: 1px solid #333; color: white; border-radius: 4px; outline: none; font-size: 12px;">
              ${selectOptions}
            </select>
            ${audioSelectHtml}
          </div>

          <div class="review-info" style="display: flex; flex-direction: column; gap: 2px; flex: 1; overflow: hidden;">
            <strong style="color: #fff; font-size: 13px;">${index + 1}. ${shortPrompt}</strong>
            <span style="color: #888; font-size: 12px;">${dynamicHint}</span>
            ${noMatchBanner}
            ${imagePreviewContainer}
          </div>
          
        </div>
      `;
    });

    reviewList.innerHTML = html;

    const selects = reviewList.querySelectorAll('.prompt-mode-select');
    selects.forEach(sel => {
      sel.addEventListener('change', () => { updatePreview(textarea); });
    });
  };

  promptTextAreas.forEach(textarea => { textarea.addEventListener('input', () => updatePreview(textarea)); });

  const autoAddToggles = document.querySelectorAll('.feature-toggle-card input[type="checkbox"]');
  autoAddToggles.forEach(toggle => {
    toggle.addEventListener('change', (e) => {
      const currentSection = e.target.closest('.mode-section');
      if (currentSection && currentSection.querySelector('textarea')) updatePreview(currentSection.querySelector('textarea'));
    });
  });

  const processOptionSelects = document.querySelectorAll('.mode-section select');
  processOptionSelects.forEach(select => {
    select.addEventListener('change', (e) => {
      const currentSection = e.target.closest('.mode-section');
      if (currentSection && currentSection.querySelector('textarea')) updatePreview(currentSection.querySelector('textarea'));
    });
  });

  window.forceUpdatePreview = updatePreview;
});

//// ══════════════════════════════════════
// DUAL RANGE SLIDER INIT — Random Delay (min buộc ≥ 20)
// ══════════════════════════════════════
// ══════════════════════════════════════
// DUAL RANGE SLIDER INIT — Random Delay (min buộc ≥ 20)
// ══════════════════════════════════════
(function initDualRangeSliders() {
  const TRACK_MAX = 120;
  const MIN_FLOOR = 20;
  const GAP = 1;

  function setupWrapper(wrapper) {
    const inpMin = wrapper.querySelector('.delay-inputs-row input:first-child');
    const inpMax = wrapper.querySelector('.delay-inputs-row input:last-child');
    const rangeMin = wrapper.querySelector('.range-min');
    const rangeMax = wrapper.querySelector('.range-max');
    const fill = wrapper.querySelector('.slider-track-fill');

    if (!inpMin || !inpMax || !rangeMin || !rangeMax || !fill) return;

    function clamp(val, lo, hi) { return Math.max(lo, Math.min(hi, val)); }

    function updateFill() {
      const lo = parseInt(rangeMin.value);
      const hi = parseInt(rangeMax.value);
      const span = TRACK_MAX - MIN_FLOOR;
      const loPct = ((lo - MIN_FLOOR) / span * 100).toFixed(2);
      const hiPct = ((hi - MIN_FLOOR) / span * 100).toFixed(2);
      fill.style.left = loPct + '%';
      fill.style.width = (hiPct - loPct) + '%';
    }

    rangeMin.addEventListener('input', () => {
      let lo = clamp(parseInt(rangeMin.value), MIN_FLOOR, parseInt(rangeMax.value) - GAP);
      rangeMin.value = lo;
      inpMin.value = lo;
      updateFill();
    });

    rangeMax.addEventListener('input', () => {
      let hi = clamp(parseInt(rangeMax.value), parseInt(rangeMin.value) + GAP, TRACK_MAX);
      rangeMax.value = hi;
      inpMax.value = hi;
      updateFill();
    });

    inpMin.addEventListener('change', () => {
      let lo = clamp(parseInt(inpMin.value) || MIN_FLOOR, MIN_FLOOR, parseInt(inpMax.value) - GAP);
      inpMin.value = lo;
      rangeMin.value = lo;
      updateFill();
    });
    inpMin.addEventListener('blur', () => inpMin.dispatchEvent(new Event('change')));

    inpMax.addEventListener('change', () => {
      let hi = clamp(parseInt(inpMax.value) || parseInt(inpMin.value) + GAP, parseInt(inpMin.value) + GAP, TRACK_MAX);
      inpMax.value = hi;
      rangeMax.value = hi;
      updateFill();
    });
    inpMax.addEventListener('blur', () => inpMax.dispatchEvent(new Event('change')));

    updateFill();
    window.addEventListener('resize', updateFill);
  }

  function init() {
    document.querySelectorAll('.delay-wrapper').forEach(setupWrapper);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    requestAnimationFrame(init);
  }
})();

// ══════════════════════════════════════
// CONCURRENT PROMPTS — Semicircle Dial (1–6)
// ══════════════════════════════════════
(function initConcurrentDials() {
  const MIN = 1, MAX = 6;
  const START = -90, SWEEP = 180;
  const CX = 10, CY = 45, R = 32;

  function degToRad(d) { return d * Math.PI / 180; }

  function dotPos(v) {
    const pct = (v - MIN) / (MAX - MIN);
    const ang = degToRad(START + SWEEP * pct);
    return { x: CX + R * Math.cos(ang), y: CY + R * Math.sin(ang) };
  }

  function draw(canvas, value, locked) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 72, 90);

    // Track arc
    ctx.beginPath();
    ctx.arc(CX, CY, R, degToRad(START), degToRad(START + SWEEP));
    ctx.strokeStyle = '#2a1f45';
    ctx.lineWidth = 3;
    ctx.stroke();

    for (let v = MIN; v <= MAX; v++) {
      const { x, y } = dotPos(v);
      const isActive = v === value;
      const isPast = v < value;

      // Màu xám mờ khi locked, vàng bình thường khi không locked
      const activeColor = locked ? '#52525b' : '#d4af37';
      const activeFill = locked ? '#3a3a3a' : '#d4af37';
      const activeGlow = locked ? 'rgba(82,82,91,0.1)' : 'rgba(212,175,55,0.12)';
      const pastColor = locked ? '#3d2d5f' : '#7a5f2a';
      const pastFill = locked ? '#2a1f45' : '#5a4520';
      const inactiveText = locked ? '#3d2d5f' : '#52525b';
      const activeText = locked ? '#52525b' : '#0a0612';
      const pastText = locked ? '#3d2d5f' : '#c8a030';

      if (isActive) {
        ctx.beginPath();
        ctx.arc(x, y, 12, 0, Math.PI * 2);
        ctx.fillStyle = activeGlow;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(x, y, isActive ? 8 : 6, 0, Math.PI * 2);
      ctx.strokeStyle = isActive ? activeColor : (isPast ? pastColor : '#3d2d5f');
      ctx.lineWidth = isActive ? 2.5 : 1.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(x, y, isActive ? 4 : 3, 0, Math.PI * 2);
      ctx.fillStyle = isActive ? activeFill : (isPast ? pastFill : '#2a1f45');
      ctx.fill();

      ctx.fillStyle = isActive ? activeText : (isPast ? pastText : inactiveText);
      ctx.font = `bold ${isActive ? 8 : 7}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(v, x, y + 0.5);
    }
  }

  function buildNumbers(numsEl, value, onUpdate, locked) {
    numsEl.innerHTML = '';
    for (let v = MIN; v <= MAX; v++) {
      const span = document.createElement('span');
      const dist = Math.abs(v - value);
      span.className = 'concurrent-num' +
        (dist === 0 ? ' active' : dist === 1 ? ' near1' : dist === 2 ? ' near2' : '');
      span.style.fontSize = (dist === 0 ? 44 : dist === 1 ? 28 : dist === 2 ? 18 : 13) + 'px';

      // Màu xám mờ khi locked
      if (locked) {
        span.style.opacity = '0.35';
        span.style.cursor = 'not-allowed';
      }

      span.textContent = v;
      span.dataset.v = v;
      if (!locked) {
        span.addEventListener('click', () => onUpdate(parseInt(span.dataset.v)));
      }
      numsEl.appendChild(span);
    }
  }

  function hitTest(canvas, mx, my) {
    let best = null, bestD = 999;
    for (let v = MIN; v <= MAX; v++) {
      const { x, y } = dotPos(v);
      const d = Math.hypot(mx - x, my - y);
      if (d < bestD) { bestD = d; best = v; }
    }
    return bestD < 20 ? best : null;
  }

  function setupDial(wrap) {
    const numsEl = wrap.querySelector('[data-concurrent-nums]');
    const canvas = wrap.querySelector('.concurrent-arc');
    const locked = numsEl.hasAttribute('data-concurrent-locked');
    if (!numsEl || !canvas) return;

    // Locked luôn cố định value = 1
    let value = locked ? 1 : 2;

    function update(v) {
      if (locked) return;
      value = Math.max(MIN, Math.min(MAX, v));
      let hiddenInput = wrap.querySelector('input[type="hidden"].concurrent-value');
      if (!hiddenInput) {
        hiddenInput = document.createElement('input');
        hiddenInput.type = 'hidden';
        hiddenInput.className = 'concurrent-value';
        wrap.appendChild(hiddenInput);
      }
      hiddenInput.value = value;
      buildNumbers(numsEl, value, update, locked);
      draw(canvas, value, locked);
    }

    // Canvas events — bỏ qua khi locked
    let dragging = false;
    canvas.addEventListener('mousedown', e => {
      if (locked) return;
      dragging = true;
      const r = canvas.getBoundingClientRect();
      const h = hitTest(canvas, e.clientX - r.left, e.clientY - r.top);
      if (h !== null) update(h);
    });
    canvas.addEventListener('mousemove', e => {
      if (!dragging) return;
      const r = canvas.getBoundingClientRect();
      const h = hitTest(canvas, e.clientX - r.left, e.clientY - r.top);
      if (h !== null) update(h);
    });
    window.addEventListener('mouseup', () => { dragging = false; });

    canvas.addEventListener('touchstart', e => {
      if (locked) return;
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const t = e.touches[0];
      const h = hitTest(canvas, t.clientX - r.left, t.clientY - r.top);
      if (h !== null) update(h);
    }, { passive: false });
    canvas.addEventListener('touchmove', e => {
      if (locked) return;
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const t = e.touches[0];
      const h = hitTest(canvas, t.clientX - r.left, t.clientY - r.top);
      if (h !== null) update(h);
    }, { passive: false });

    // Swipe on numbers — bỏ qua khi locked
    let swipeStartX = null, swipeVal = null;
    numsEl.addEventListener('mousedown', e => {
      if (locked) return;
      swipeStartX = e.clientX; swipeVal = value;
    });
    window.addEventListener('mousemove', e => {
      if (swipeStartX === null) return;
      const step = Math.round((e.clientX - swipeStartX) / 22);
      update(Math.max(MIN, Math.min(MAX, swipeVal + step)));
    });
    window.addEventListener('mouseup', () => { swipeStartX = null; swipeVal = null; });

    numsEl.addEventListener('touchstart', e => {
      if (locked) return;
      swipeStartX = e.touches[0].clientX; swipeVal = value;
    }, { passive: true });
    numsEl.addEventListener('touchmove', e => {
      if (swipeStartX === null) return;
      const step = Math.round((e.touches[0].clientX - swipeStartX) / 22);
      update(Math.max(MIN, Math.min(MAX, swipeVal + step)));
    }, { passive: true });
    numsEl.addEventListener('touchend', () => { swipeStartX = null; swipeVal = null; });

    // Luôn render dù locked hay không
    buildNumbers(numsEl, value, update, locked);
    draw(canvas, value, locked);

    // Canvas cursor
    canvas.style.cursor = locked ? 'not-allowed' : 'pointer';
  }

  function init() {
    document.querySelectorAll('.concurrent-dial-wrap').forEach(setupDial);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    requestAnimationFrame(init);
  }
})();

// ══════════════════════════════════════
// CONCURRENT PROMPTS — Semicircle Dial (1–6)
// ══════════════════════════════════════
// (function initConcurrentDials() {
//   const MIN = 1, MAX = 6;
//   const START = -90, SWEEP = 180;
//   const CX = 10, CY = 45, R = 32;

//   function degToRad(d) { return d * Math.PI / 180; }

//   function dotPos(v) {
//     const pct = (v - MIN) / (MAX - MIN);
//     const ang = degToRad(START + SWEEP * pct);
//     return { x: CX + R * Math.cos(ang), y: CY + R * Math.sin(ang) };
//   }

//   function draw(canvas, value) {
//     const ctx = canvas.getContext('2d');
//     ctx.clearRect(0, 0, 72, 90);

//     ctx.beginPath();
//     ctx.arc(CX, CY, R, degToRad(START), degToRad(START + SWEEP));
//     ctx.strokeStyle = '#2a1f45';
//     ctx.lineWidth = 3;
//     ctx.stroke();

//     for (let v = MIN; v <= MAX; v++) {
//       const { x, y } = dotPos(v);
//       const isActive = v === value;
//       const isPast = v < value;

//       if (isActive) {
//         ctx.beginPath();
//         ctx.arc(x, y, 12, 0, Math.PI * 2);
//         ctx.fillStyle = 'rgba(212,175,55,0.12)';
//         ctx.fill();
//       }

//       ctx.beginPath();
//       ctx.arc(x, y, isActive ? 8 : 6, 0, Math.PI * 2);
//       ctx.strokeStyle = isActive ? '#d4af37' : (isPast ? '#7a5f2a' : '#3d2d5f');
//       ctx.lineWidth = isActive ? 2.5 : 1.5;
//       ctx.stroke();

//       ctx.beginPath();
//       ctx.arc(x, y, isActive ? 4 : 3, 0, Math.PI * 2);
//       ctx.fillStyle = isActive ? '#d4af37' : (isPast ? '#5a4520' : '#2a1f45');
//       ctx.fill();

//       ctx.fillStyle = isActive ? '#0a0612' : (isPast ? '#c8a030' : '#52525b');
//       ctx.font = `bold ${isActive ? 8 : 7}px system-ui`;
//       ctx.textAlign = 'center';
//       ctx.textBaseline = 'middle';
//       ctx.fillText(v, x, y + 0.5);
//     }
//   }

//   function buildNumbers(numsEl, value, onUpdate) {
//     numsEl.innerHTML = '';
//     for (let v = MIN; v <= MAX; v++) {
//       const span = document.createElement('span');
//       const dist = Math.abs(v - value);
//       span.className = 'concurrent-num' +
//         (dist === 0 ? ' active' : dist === 1 ? ' near1' : dist === 2 ? ' near2' : '');
//       span.style.fontSize = (dist === 0 ? 44 : dist === 1 ? 28 : dist === 2 ? 18 : 13) + 'px';
//       span.textContent = v;
//       span.dataset.v = v;
//       span.addEventListener('click', () => onUpdate(parseInt(span.dataset.v)));
//       numsEl.appendChild(span);
//     }
//   }

//   function hitTest(canvas, mx, my) {
//     let best = null, bestD = 999;
//     for (let v = MIN; v <= MAX; v++) {
//       const { x, y } = dotPos(v);
//       const d = Math.hypot(mx - x, my - y);
//       if (d < bestD) { bestD = d; best = v; }
//     }
//     return bestD < 20 ? best : null;
//   }

//   function setupDial(wrap) {
//     const numsEl = wrap.querySelector('[data-concurrent-nums]');
//     const canvas = wrap.querySelector('.concurrent-arc');
//     const locked = numsEl.hasAttribute('data-concurrent-locked');
//     if (!numsEl || !canvas) return;

//     let value = locked ? 1 : 2;

//     function update(v) {
//       if (locked) return;
//       value = Math.max(MIN, Math.min(MAX, v));
//       // Sync hidden input value for popup.js to read
//       let hiddenInput = wrap.querySelector('input[type="hidden"].concurrent-value');
//       if (!hiddenInput) {
//         hiddenInput = document.createElement('input');
//         hiddenInput.type = 'hidden';
//         hiddenInput.className = 'concurrent-value';
//         wrap.appendChild(hiddenInput);
//       }
//       hiddenInput.value = value;
//       buildNumbers(numsEl, value, update);
//       draw(canvas, value);
//     }

//     // Canvas events
//     let dragging = false;
//     canvas.addEventListener('mousedown', e => {
//       if (locked) return;
//       dragging = true;
//       const r = canvas.getBoundingClientRect();
//       const h = hitTest(canvas, e.clientX - r.left, e.clientY - r.top);
//       if (h !== null) update(h);
//     });
//     canvas.addEventListener('mousemove', e => {
//       if (!dragging) return;
//       const r = canvas.getBoundingClientRect();
//       const h = hitTest(canvas, e.clientX - r.left, e.clientY - r.top);
//       if (h !== null) update(h);
//     });
//     window.addEventListener('mouseup', () => { dragging = false; });

//     canvas.addEventListener('touchstart', e => {
//       if (locked) return;
//       e.preventDefault();
//       const r = canvas.getBoundingClientRect();
//       const t = e.touches[0];
//       const h = hitTest(canvas, t.clientX - r.left, t.clientY - r.top);
//       if (h !== null) update(h);
//     }, { passive: false });
//     canvas.addEventListener('touchmove', e => {
//       e.preventDefault();
//       const r = canvas.getBoundingClientRect();
//       const t = e.touches[0];
//       const h = hitTest(canvas, t.clientX - r.left, t.clientY - r.top);
//       if (h !== null) update(h);
//     }, { passive: false });

//     // Swipe on numbers
//     let swipeStartX = null, swipeVal = null;
//     numsEl.addEventListener('mousedown', e => { swipeStartX = e.clientX; swipeVal = value; });
//     window.addEventListener('mousemove', e => {
//       if (swipeStartX === null) return;
//       const step = Math.round((e.clientX - swipeStartX) / 22);
//       update(Math.max(MIN, Math.min(MAX, swipeVal + step)));
//     });
//     window.addEventListener('mouseup', () => { swipeStartX = null; swipeVal = null; });

//     numsEl.addEventListener('touchstart', e => {
//       swipeStartX = e.touches[0].clientX; swipeVal = value;
//     }, { passive: true });
//     numsEl.addEventListener('touchmove', e => {
//       if (swipeStartX === null) return;
//       const step = Math.round((e.touches[0].clientX - swipeStartX) / 22);
//       update(Math.max(MIN, Math.min(MAX, swipeVal + step)));
//     }, { passive: true });
//     numsEl.addEventListener('touchend', () => { swipeStartX = null; swipeVal = null; });

//     update(value);
//   }

//   function init() {
//     document.querySelectorAll('.concurrent-dial-wrap').forEach(setupDial);
//   }

//   if (document.readyState === 'loading') {
//     document.addEventListener('DOMContentLoaded', init);
//   } else {
//     requestAnimationFrame(init);
//   }
// })();

(function initOutputDials() {
  'use strict';

  const VALS = [1, 2, 3, 4];
  const TAU = Math.PI * 2;

  // Arc: starts bottom-left (225°), sweeps 270° clockwise to bottom-right
  const START_ANG = (Math.PI / 180) * 225;
  const SWEEP = (Math.PI / 180) * 270;

  function valToAngle(val) {
    const idx = VALS.indexOf(val);
    if (idx < 0) return START_ANG;
    return START_ANG + (idx / (VALS.length - 1)) * SWEEP;
  }

  function drawDial(canvas, val, locked) {
    const DPR = window.devicePixelRatio || 1;
    const SIZE = 130;
    canvas.width = SIZE * DPR;
    canvas.height = SIZE * DPR;
    canvas.style.width = SIZE + 'px';
    canvas.style.height = SIZE + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);
    ctx.clearRect(0, 0, SIZE, SIZE);

    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const R = SIZE / 2 - 18;

    const activeAng = valToAngle(val);
    const goldColor = '#fbbf24';
    const trackColor = '#2a1a4a';

    // ── 1. Vẽ vòng viền trang trí mờ bên ngoài ──────────────────
    ctx.beginPath();
    ctx.arc(cx, cy, R + 8, START_ANG, START_ANG + SWEEP);
    ctx.strokeStyle = 'rgba(61, 45, 95, 0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // ── 2. Vẽ vòng background track (Đường ray chính) ──────────────────
    ctx.beginPath();
    ctx.arc(cx, cy, R, START_ANG, START_ANG + SWEEP);
    ctx.strokeStyle = trackColor;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.stroke();

    // ── 3. Vẽ các Marker (Nút bấm) ──────────────────
    for (let i = 0; i < VALS.length; i++) {
      const markerAng = valToAngle(VALS[i]);
      const mX = cx + R * Math.cos(markerAng);
      const mY = cy + R * Math.sin(markerAng);

      ctx.beginPath();
      ctx.arc(mX, mY, 4.5, 0, TAU);
      ctx.fillStyle = '#0a0612';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(mX, mY, 4.5, 0, TAU);
      // Đã sửa: Luôn hiện màu vàng cho giá trị active bất kể bị khóa hay không
      ctx.strokeStyle = (VALS[i] <= val) ? goldColor : '#4a3076';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // ── 4. Vẽ vòng cung hoạt động (Vàng phát sáng) ────────────────────────
    if (val > VALS[0] || val === VALS[0]) {
      ctx.beginPath();
      ctx.arc(cx, cy, R, START_ANG, activeAng);
      // Đã sửa: Luôn dùng màu vàng
      ctx.strokeStyle = goldColor;
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';

      // Đã sửa: Luôn bật hiệu ứng Glow
      ctx.shadowBlur = 12;
      ctx.shadowColor = goldColor;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // ── 5. Vẽ cục handle (Tay cầm bọc đầu phát sáng) ───────────────────────────────
    const dotX = cx + R * Math.cos(activeAng);
    const dotY = cy + R * Math.sin(activeAng);

    // Đã sửa: Xóa điều kiện if(!locked) để tay cầm luôn hiện lên
    ctx.beginPath();
    ctx.arc(dotX, dotY, 14, 0, TAU);
    ctx.fillStyle = 'rgba(251, 191, 36, 0.25)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(dotX, dotY, 7.5, 0, TAU);
    ctx.fillStyle = goldColor;
    ctx.shadowBlur = 8;
    ctx.shadowColor = goldColor;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.beginPath();
    ctx.arc(dotX, dotY, 3, 0, TAU);
    ctx.fillStyle = '#0a0612';
    ctx.fill();
  }

  function setupDial(card) {
    const canvas = card.querySelector('.output-dial-canvas');
    const numEl = card.querySelector('.output-dial-num');
    const select = card.querySelector('.output-dial-select');
    const btns = card.querySelectorAll('.output-val-btn');
    const locked = card.classList.contains('output-dial-locked');

    if (!canvas || !numEl || !select) return;

    let val = parseInt(select.value) || 2;

    function commit(newVal) {
      if (locked) return;
      val = newVal;
      select.value = String(val);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      numEl.textContent = String(val);
      drawDial(canvas, val, locked);
      btns.forEach(b => {
        const bv = parseInt(b.getAttribute('data-val'));
        b.classList.toggle('dial-btn-active', bv === val);
      });
    }

    // Init render
    numEl.textContent = String(val);
    drawDial(canvas, val, locked);
    btns.forEach(b => {
      const bv = parseInt(b.getAttribute('data-val'));
      b.classList.toggle('dial-btn-active', bv === val);
    });

    if (locked) {
      canvas.style.opacity = '0.45';
      // numEl.style.opacity = '0.45';
      return;
    }

    // ── Button clicks ─────────────────────
    btns.forEach(btn => {
      btn.addEventListener('click', () => {
        commit(parseInt(btn.getAttribute('data-val')));
      });
    });

    // ── Canvas arc drag ───────────────────
    let dragging = false;

    function angleFromPointer(ex, ey) {
      const r = canvas.getBoundingClientRect();
      const dx = (ex - r.left) - r.width / 2;
      const dy = (ey - r.top) - r.height / 2;
      return Math.atan2(dy, dx);
    }

    function valFromAngle(ang) {
      let rel = ang - START_ANG;
      // normalise to [0, TAU)
      while (rel < 0) rel += TAU;
      while (rel > TAU) rel -= TAU;
      if (rel > SWEEP + 0.25) return val; // click outside arc gap
      const frac = Math.min(1, rel / SWEEP);
      const idx = Math.round(frac * (VALS.length - 1));
      return VALS[Math.max(0, Math.min(VALS.length - 1, idx))];
    }

    canvas.addEventListener('mousedown', e => {
      dragging = true;
      const v = valFromAngle(angleFromPointer(e.clientX, e.clientY));
      commit(v);
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const v = valFromAngle(angleFromPointer(e.clientX, e.clientY));
      if (v !== val) commit(v);
    });
    window.addEventListener('mouseup', () => { dragging = false; });

    canvas.addEventListener('touchstart', e => {
      e.preventDefault();
      const t = e.touches[0];
      commit(valFromAngle(angleFromPointer(t.clientX, t.clientY)));
    }, { passive: false });
    canvas.addEventListener('touchmove', e => {
      e.preventDefault();
      const t = e.touches[0];
      const v = valFromAngle(angleFromPointer(t.clientX, t.clientY));
      if (v !== val) commit(v);
    }, { passive: false });

    // ── Swipe on number ───────────────────
    let swipeStartX = null, swipeStartVal = val;
    numEl.style.cursor = 'ew-resize';
    numEl.addEventListener('mousedown', e => {
      swipeStartX = e.clientX;
      swipeStartVal = val;
    });
    window.addEventListener('mousemove', e => {
      if (swipeStartX === null || e.buttons !== 1) return;
      const step = Math.round((e.clientX - swipeStartX) / 28);
      const newIdx = Math.max(0, Math.min(VALS.length - 1, VALS.indexOf(swipeStartVal) + step));
      if (VALS[newIdx] !== val) commit(VALS[newIdx]);
    });
    window.addEventListener('mouseup', () => { swipeStartX = null; });
  }

  // ── User Guide modal & Back arrow ─────
  function initGuideModal() {
    const openBtn = document.getElementById('guide-btn-open');
    const closeBtn = document.getElementById('guide-btn-close');
    const backdrop = document.getElementById('guide-backdrop');
    const modal = document.getElementById('user-guide-modal');
    const backBtn = document.getElementById('back-to-intro-btn');
    const introScreen = document.getElementById('intro-screen');

    if (openBtn && modal) openBtn.addEventListener('click', () => modal.classList.remove('hidden'));
    if (closeBtn && modal) closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
    if (backdrop && modal) backdrop.addEventListener('click', () => modal.classList.add('hidden'));

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modal && !modal.classList.contains('hidden'))
        modal.classList.add('hidden');
    });

    if (backBtn && introScreen)
      backBtn.addEventListener('click', () => introScreen.classList.remove('hidden'));
  }

  function init() {
    document.querySelectorAll('.output-dial-card').forEach(setupDial);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); initGuideModal(); });
  } else {
    requestAnimationFrame(() => { init(); initGuideModal(); });
  }
})();