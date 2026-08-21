/**
 * Chrome Translate Plugin - Background Service Worker
 * Handles API proxies, context menus, and custom translate-service backend requests.
 */

const LANGUAGE_DISPLAY_NAMES = {
  chinese_simplified: '简体中文',
  chinese_traditional: '繁体中文',
  english: '英语 (English)',
  japanese: '日语 (日本語)',
  korean: '韩语 (한국어)',
  french: '法语 (Français)',
  spanish: '西班牙语 (Español)',
  german: '德语 (Deutsch)',
  russian: '俄语 (Русский)',
  arabic: '阿拉伯语',
  portuguese: '葡萄牙语',
  italian: '意大利语'
};

function getLanguageName(code) {
  return LANGUAGE_DISPLAY_NAMES[code] || '简体中文';
}

function updateContextMenus(targetLang) {
  chrome.contextMenus.removeAll(() => {
    // Top-level selection translation
    chrome.contextMenus.create({
      id: 'ct-translate-selection',
      title: '划词翻译: "%s"',
      contexts: ['selection']
    });

    const langName = getLanguageName(targetLang || 'chinese_simplified');

    // Dynamic top-level page translation menu: 翻译当前网页: [目标语言]
    chrome.contextMenus.create({
      id: 'ct-translate-page',
      title: `翻译当前网页: ${langName}`,
      contexts: ['page']
    });
  });
}

// Initialize Context Menus on install and startup
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(['targetLanguage'], (res) => {
    updateContextMenus(res.targetLanguage || 'chinese_simplified');
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.sync.get(['targetLanguage'], (res) => {
    updateContextMenus(res.targetLanguage || 'chinese_simplified');
  });
});

// Update Context Menu dynamically when settings change in Storage
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.targetLanguage) {
    updateContextMenus(changes.targetLanguage.newValue || 'chinese_simplified');
  }
});

// Context Menu Click Handler
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id) return;

  if (info.menuItemId === 'ct-translate-selection' && info.selectionText) {
    chrome.tabs.sendMessage(tab.id, {
      action: 'showSelectionTranslation',
      text: info.selectionText
    }, () => {
      if (chrome.runtime.lastError) { /* ignore tab communication edge error */ }
    });
  } else if (info.menuItemId === 'ct-translate-page') {
    chrome.storage.sync.get(['targetLanguage'], (res) => {
      chrome.tabs.sendMessage(tab.id, {
        action: 'translatePage',
        targetLanguage: res.targetLanguage || 'chinese_simplified'
      }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    });
  }
});

// Runtime Message Listener with guaranteed response channel safety
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || !request.action) {
    return false;
  }

  if (request.action === 'proxyHttpRequest') {
    handleProxyHttpRequest(request.request)
      .then(res => {
        try { sendResponse(res); } catch (e) {}
      })
      .catch(err => {
        try { sendResponse({ success: false, error: err.message || '代理请求失败' }); } catch (e) {}
      });
    return true;
  } else if (request.action === 'translateText') {
    handleTextTranslation(request.text, request.targetLanguage, request.config)
      .then(result => {
        try { sendResponse({ success: true, translatedText: result }); } catch (e) {}
      })
      .catch(err => {
        try { sendResponse({ success: false, error: err.message || '翻译失败' }); } catch (e) {}
      });
    return true;
  } else if (request.action === 'translateBatch') {
    handleBatchTranslation(request.texts, request.from, request.targetLanguage, request.config)
      .then(results => {
        try { sendResponse({ success: true, texts: results }); } catch (e) {}
      })
      .catch(err => {
        try { sendResponse({ success: false, error: err.message || '批量翻译失败' }); } catch (e) {}
      });
    return true;
  } else if (request.action === 'testConnection') {
    testApiConnection(request.config)
      .then(res => {
        try { sendResponse(res); } catch (e) {}
      })
      .catch(err => {
        try { sendResponse({ success: false, error: err.message || '连接测试异常' }); } catch (e) {}
      });
    return true;
  }

  return false;
});

/**
 * Proxy generic HTTP requests for translate.js to completely bypass page-level CSP
 */
async function handleProxyHttpRequest(req = {}) {
  try {
    let url = req.url;
    if (!url) throw new Error('Missing URL for proxy request');
    // Ensure relative URL fix
    if (url.startsWith('//')) {
      url = 'https:' + url;
    }
    // Clean any accidental from=undefined query parameters
    url = url.replace(/from=undefined/g, 'from=').replace(/from=null/g, 'from=');

    const method = (typeof req.method === 'string' ? req.method : 'POST').toUpperCase();
    const headers = Object.assign({}, req.headers || {});
    const body = req.body;

    const fetchOptions = {
      method: method,
      headers: headers
    };

    if (method !== 'GET' && method !== 'HEAD' && body !== undefined && body !== null && body !== '') {
      fetchOptions.body = body;
    }

    const res = await fetch(url, fetchOptions);
    const text = await res.text();

    return {
      success: res.ok,
      status: res.status,
      data: text
    };
  } catch (err) {
    return {
      success: false,
      status: 0,
      error: err.message || '网络连接失败'
    };
  }
}

/**
 * Handle translation across multiple engine modes (default & custom_api)
 */
async function handleTextTranslation(text, targetLang = 'chinese_simplified', config = {}) {
  const mode = config.serviceMode || 'default';

  // Mode 1: Custom Backend API
  if (mode === 'custom_api') {
    if (!config.customApiHost || !config.customApiHost.trim()) {
      throw new Error('未配置私有后端服务地址 (customApiHost)，请在插件设置中填写');
    }
    return await translateWithCustomBackend(text, targetLang, config.customApiHost);
  }

  // Mode 2: Default Edge API
  return await translateWithStandardEdge(text, targetLang, mode);
}

/**
 * Handle batch translation for full webpage translation with Custom API or Standard Edge
 */
async function handleBatchTranslation(texts = [], from = 'auto', targetLang = 'chinese_simplified', config = {}) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const mode = config.serviceMode || 'default';

  if (mode === 'custom_api') {
    if (!config.customApiHost || !config.customApiHost.trim()) {
      throw new Error('未配置自建私有后端服务地址 (customApiHost)！请在插件设置中填写');
    }
    return await Promise.all(
      texts.map(t => translateWithCustomBackend(t, targetLang, config.customApiHost).catch(() => t))
    );
  }

  // Standard Edge mode
  return await Promise.all(
    texts.map(t => translateWithStandardEdge(t, targetLang, mode).catch(() => t))
  );
}

/**
 * Custom Backend Translation Service (translate.service format)
 */
async function translateWithCustomBackend(text, targetLang, customHost) {
  let host = customHost.trim();
  if (!host.endsWith('/')) host += '/';
  const url = `${host}api/translate`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: text,
      to: targetLang
    })
  });

  if (!response.ok) {
    throw new Error(`自定义后端响应错误 (${response.status})`);
  }

  const data = await response.json();
  return data.result || data.text || data.translatedText || JSON.stringify(data);
}

/**
 * Standard High-Speed Edge Public Translator
 * Uses Microsoft Edge Translation API with global availability and multi-language support.
 */
const EDGE_LANG_MAP = {
  chinese_simplified: 'zh-CHS',
  chinese_traditional: 'zh-CHT',
  english: 'en',
  japanese: 'ja',
  korean: 'ko',
  french: 'fr',
  german: 'de',
  deutsch: 'de',
  spanish: 'es',
  russian: 'ru',
  italian: 'it',
  portuguese: 'pt',
  vietnamese: 'vi',
  thai: 'th',
  arabic: 'ar',
  hindi: 'hi',
  'zh-CN': 'zh-CHS',
  'zh-TW': 'zh-CHT',
  'zh-Hans': 'zh-CHS',
  'zh-Hant': 'zh-CHT'
};

async function translateWithStandardEdge(text, targetLang, mode) {
  if (!text || !text.trim()) return '';

  const to = EDGE_LANG_MAP[targetLang] || targetLang || 'zh-CHS';
  const url = `https://edge.microsoft.com/translate/translatetext?from=&to=${to}&isEnterpriseClient=false`;

  // Primary attempt: Microsoft Edge Global API
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: JSON.stringify([text])
    });

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data[0] && data[0].translations && data[0].translations[0]) {
        return data[0].translations[0].text;
      }
    }
  } catch (edgeErr) {
    console.warn('[Chrome Translate Background] Edge translate fetch failed, trying secondary fallback...', edgeErr);
  }

  // Secondary Fallback: MyMemory API
  try {
    const mmTo = (to === 'zh-CHS' ? 'zh-CN' : (to === 'zh-CHT' ? 'zh-TW' : to));
    const fallbackUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=autodetect|${mmTo}`;
    const fallbackRes = await fetch(fallbackUrl);
    if (fallbackRes.ok) {
      const fbData = await fallbackRes.json();
      if (fbData && fbData.responseData && fbData.responseData.translatedText) {
        return fbData.responseData.translatedText;
      }
    }
  } catch (fbErr) {
    console.warn('[Chrome Translate Background] Secondary fallback failed:', fbErr);
  }

  throw new Error('翻译网络请求失败，请检查网络连接或自建后端配置');
}

/**
 * Test Connection logic for popup
 */
async function testApiConnection(config) {
  const startTime = Date.now();
  try {
    const testResult = await handleTextTranslation('Hello, world! Welcome to Web Translate.', 'chinese_simplified', config);
    const duration = Date.now() - startTime;
    return {
      success: true,
      duration: duration,
      sampleResult: testResult
    };
  } catch (e) {
    return {
      success: false,
      error: e.message || '连接失败'
    };
  }
}
