/**
 * Chrome Translate Plugin - Content Script
 * 
 * Features:
 * 1. Smart Anti-Duplicate Detection (检查主页面是否已引入 translate.js，防重复加载与实例冲突)
 * 2. CSP Compliant Bridge Mechanism (通过独立 bridge.js 与 CustomEvent 通信，杜绝 CSP 拦截)
 * 3. Custom Backend & AI LLM Integration (支持自建接口 / DeepSeek & OpenAI 兼容大模型)
 * 4. Selection Word/Sentence Translation (划词悬浮弹窗翻译)
 * 5. Full Page Dynamic Translation (整页翻译与语言切换)
 */

(function () {
  'use strict';

  // Prevent multiple injections of content_script itself
  if (window.__CHROME_TRANSLATE_CONTENT_SCRIPT_LOADED__) {
    return;
  }
  window.__CHROME_TRANSLATE_CONTENT_SCRIPT_LOADED__ = true;

  // Local state
  let config = {
    targetLanguage: 'chinese_simplified',
    autoTranslate: false,
    enableSelection: true,
    serviceMode: 'default', // 'default' | 'custom_api'
    customApiHost: ''
  };

  let pageHostHasTranslate = false;
  let bridgeInjected = false;
  let currentSelectionText = '';
  let triggerBtn = null;
  let panelElem = null;

  // 1. Load configuration from chrome.storage
  function loadConfig(callback) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(config, (items) => {
        if (items) {
          config = Object.assign(config, items);
        }
        if (callback) callback(config);
      });
    } else {
      if (callback) callback(config);
    }
  }

  // 2. Ensure Main World Bridge is safely loaded via script.src (CSP compliant)
  function ensureBridgeInjected(callback) {
    if (bridgeInjected || document.getElementById('__ct_bridge__')) {
      bridgeInjected = true;
      if (callback) callback();
      return;
    }

    try {
      const script = document.createElement('script');
      script.id = '__ct_bridge__';
      script.src = chrome.runtime.getURL('bridge.js');
      script.onload = () => {
        bridgeInjected = true;
        if (callback) callback();
      };
      script.onerror = (err) => {
        console.warn('[Chrome Translate] Failed to inject bridge.js:', err);
        if (callback) callback();
      };
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      console.warn('[Chrome Translate] Bridge injection exception:', e);
      if (callback) callback();
    }
  }

  // Listen for bridge status responses
  window.addEventListener('CT_BRIDGE_STATUS_RESPONSE', (e) => {
    if (e.detail && e.detail.hasTranslate) {
      pageHostHasTranslate = true;
    }
  });

  // Translation session state tracker
  let pageTranslateState = 'idle'; // 'idle' | 'loading' | 'success' | 'error'
  let activeTargetLang = 'chinese_simplified';
  let badgeDismissTimer = null;

  // Listen for real translation lifecycle events from bridge.js
  window.addEventListener('CT_BRIDGE_TRANSLATE_EVENT', (e) => {
    const detail = e.detail || {};
    const state = detail.state;
    const lang = detail.targetLanguage || activeTargetLang || config.targetLanguage;

    if (state === 'start' || state === 'requesting') {
      pageTranslateState = 'loading';
      activeTargetLang = lang;
      updatePageStatusBadge('loading', lang);
    } else if (state === 'rendered' || state === 'finished') {
      pageTranslateState = 'success';
      activeTargetLang = lang;
      updatePageStatusBadge('success', lang);
    } else if (state === 'error') {
      // If translation has already succeeded or is idle, do not downgrade to error
      if (pageTranslateState === 'success' || pageTranslateState === 'idle') {
        return;
      }
      pageTranslateState = 'error';
      updatePageStatusBadge('error', lang, detail.error);
    }
  });

  // Proxy network requests from translate.js to background script to bypass page CSP
  window.addEventListener('CT_BRIDGE_PROXY_REQUEST', (e) => {
    const req = e.detail;
    if (!req || !req.reqId) return;

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        action: 'proxyHttpRequest',
        request: req
      }, (response) => {
        window.dispatchEvent(new CustomEvent('CT_BRIDGE_PROXY_RESPONSE', {
          detail: {
            reqId: req.reqId,
            success: response ? response.success : false,
            status: response ? response.status : 500,
            responseText: response ? response.data : null,
            error: response ? response.error : 'Background proxy error'
          }
        }));
      });
    }
  });

  // 3. Anti-duplicate Check: Detect if host page already has translate.js
  function checkHostTranslateExists() {
    // 1. Check DOM elements created by standard translate.js or existing script tags
    const existingScript = document.querySelector('script[src*="translate.js"]') ||
      document.querySelector('script#translate') ||
      document.getElementById('translate');

    const hasDomFlag = document.documentElement.hasAttribute('data-translate-installed') ||
      document.documentElement.getAttribute('data-ct-host-translate-exists') === '1' ||
      document.documentElement.getAttribute('translate') === 'no';

    if (existingScript || hasDomFlag) {
      pageHostHasTranslate = true;
    }

    // 2. Ask bridge script to check main world window.translate
    ensureBridgeInjected(() => {
      window.dispatchEvent(new CustomEvent('CT_BRIDGE_CHECK_STATUS'));
    });

    return pageHostHasTranslate;
  }

  // 4. Inject and configure translate.js in page context via bridge
  function executePageTranslation(targetLang) {
    checkHostTranslateExists();
    const lang = targetLang || config.targetLanguage;
    activeTargetLang = lang;
    pageTranslateState = 'loading';

    // Show immediate loading status indicator (never premature completion)
    updatePageStatusBadge('loading', lang);

    if (config.serviceMode === 'custom_api' && (!config.customApiHost || !config.customApiHost.trim())) {
      console.error('[Web Translate Pro] 无法启动翻译：当前配置为【自建私有后端】模式，但未提供有效的私有后端接口地址！请点击插件图标进入「后端配置」填写服务地址。');
      pageTranslateState = 'error';
      updatePageStatusBadge('error', lang, '未配置自建私有后端地址');
      ensureBridgeInjected(() => {
        window.dispatchEvent(new CustomEvent('CT_BRIDGE_EXECUTE_TRANSLATE', {
          detail: {
            targetLanguage: lang,
            serviceMode: config.serviceMode,
            customApiHost: '',
            translateScriptUrl: chrome.runtime.getURL('translate.js')
          }
        }));
      });
      return;
    }

    ensureBridgeInjected(() => {
      window.dispatchEvent(new CustomEvent('CT_BRIDGE_EXECUTE_TRANSLATE', {
        detail: {
          targetLanguage: lang,
          serviceMode: config.serviceMode,
          customApiHost: config.customApiHost || '',
          translateScriptUrl: chrome.runtime.getURL('translate.js')
        }
      }));
    });

    // Safety fallback: If within 2.5 seconds DOM translation is observed, guarantee state is marked as success
    setTimeout(() => {
      if (pageTranslateState === 'loading') {
        const hasActiveLang = document.documentElement.hasAttribute('data-translate-active-lang');
        const hasTranslateAttr = document.querySelector('[data-translate-active-lang]') || document.documentElement.getAttribute('data-translate-active-lang');
        if (hasActiveLang || hasTranslateAttr) {
          pageTranslateState = 'success';
          updatePageStatusBadge('success', lang);
        }
      }
    }, 2500);
  }

  // 5. Restore Original Page Text
  function restoreOriginalPage() {
    pageTranslateState = 'idle';
    ensureBridgeInjected(() => {
      window.dispatchEvent(new CustomEvent('CT_BRIDGE_RESTORE_PAGE'));
      hidePageStatusBadge();
    });
  }

  // 6. Floating Status Badge with Real-time Translation Lifecycle UI
  function getLangDisplayName(code) {
    const langNames = {
      chinese_simplified: '简体中文',
      chinese_traditional: '繁體中文',
      english: 'English',
      japanese: '日本語',
      korean: '한국어',
      french: 'Français',
      german: 'Deutsch',
      spanish: 'Español',
      russian: 'Русский',
      italian: 'Italiano',
      portuguese: 'Português',
      vietnamese: 'Tiếng Việt',
      thai: 'ไทย',
      arabic: 'العربية',
      hindi: 'हिन्दी'
    };
    return langNames[code] || code;
  }

  function updatePageStatusBadge(state, lang, errorMsg) {
    let badge = document.getElementById('chrome-translate-page-status');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'chrome-translate-page-status';
      document.body.appendChild(badge);
    }

    if (badgeDismissTimer) {
      clearTimeout(badgeDismissTimer);
      badgeDismissTimer = null;
    }

    const langName = getLangDisplayName(lang);

    if (state === 'loading') {
      badge.className = 'ct-badge-loading';
      badge.innerHTML = `
        <div class="ct-badge-spinner"></div>
        <span class="ct-badge-text">正在翻译页面为 <strong>${langName}</strong>...</span>
        <button id="ct-badge-cancel-btn" class="ct-badge-btn" title="取消并恢复">取消</button>
      `;
      const cancelBtn = badge.querySelector('#ct-badge-cancel-btn');
      if (cancelBtn) cancelBtn.onclick = () => restoreOriginalPage();
    } else if (state === 'success') {
      badge.className = 'ct-badge-success';
      badge.innerHTML = `
        <span class="ct-badge-dot ct-dot-green"></span>
        <span class="ct-badge-text">已翻译为 <strong>${langName}</strong></span>
        <div class="ct-badge-actions">
          <button id="ct-badge-restore-btn" class="ct-badge-btn" title="恢复网页原始语言">恢复原文</button>
          <button id="ct-badge-close-btn" class="ct-badge-icon-btn" title="关闭提示">✕</button>
        </div>
      `;
      const restoreBtn = badge.querySelector('#ct-badge-restore-btn');
      if (restoreBtn) restoreBtn.onclick = () => restoreOriginalPage();
      const closeBtn = badge.querySelector('#ct-badge-close-btn');
      if (closeBtn) closeBtn.onclick = () => hidePageStatusBadge();
    } else if (state === 'error') {
      badge.className = 'ct-badge-error';
      badge.innerHTML = `
        <span class="ct-badge-dot ct-dot-red"></span>
        <span class="ct-badge-text">⚠️ 翻译未完成: ${errorMsg || '网络响应异常'}</span>
        <div class="ct-badge-actions">
          <button id="ct-badge-retry-btn" class="ct-badge-btn" title="重新尝试翻译">重试</button>
          <button id="ct-badge-restore-btn" class="ct-badge-btn" title="恢复原文">恢复</button>
          <button id="ct-badge-close-btn" class="ct-badge-icon-btn" title="关闭提示">✕</button>
        </div>
      `;
      const retryBtn = badge.querySelector('#ct-badge-retry-btn');
      if (retryBtn) retryBtn.onclick = () => executePageTranslation(lang);
      const restoreBtn = badge.querySelector('#ct-badge-restore-btn');
      if (restoreBtn) restoreBtn.onclick = () => restoreOriginalPage();
      const closeBtn = badge.querySelector('#ct-badge-close-btn');
      if (closeBtn) closeBtn.onclick = () => hidePageStatusBadge();
    }
  }

  function hidePageStatusBadge() {
    const badge = document.getElementById('chrome-translate-page-status');
    if (badge) {
      badge.style.opacity = '0';
      badge.style.transform = 'translateY(10px)';
      setTimeout(() => {
        if (badge.parentNode) badge.parentNode.removeChild(badge);
      }, 250);
    }
  }

  // 7. Selection Translation (划词翻译)
  function setupSelectionListener() {
    document.addEventListener('mouseup', (e) => {
      if (!config.enableSelection) return;

      // Ignore if clicking inside our panel
      if (panelElem && panelElem.contains(e.target)) return;
      if (triggerBtn && triggerBtn.contains(e.target)) return;

      setTimeout(() => {
        const selection = window.getSelection();
        const text = selection ? selection.toString().trim() : '';

        if (text && text.length > 0 && text.length <= 3000) {
          currentSelectionText = text;
          showTriggerButton(e.pageX + 8, e.pageY + 8);
        } else {
          hideTriggerButton();
          if (panelElem && !panelElem.contains(e.target)) {
            hidePanel();
          }
        }
      }, 10);
    });

    document.addEventListener('mousedown', (e) => {
      if (panelElem && !panelElem.contains(e.target) && triggerBtn && !triggerBtn.contains(e.target)) {
        hideTriggerButton();
        hidePanel();
      }
    });
  }

  function showTriggerButton(x, y) {
    if (!triggerBtn) {
      triggerBtn = document.createElement('div');
      triggerBtn.id = 'chrome-translate-trigger-btn';
      triggerBtn.title = '点击翻译选中内容';
      triggerBtn.innerHTML = `
        <svg viewBox="0 0 24 24">
          <path d="M12.87 15.07l-2.54-2.51.03-.08c1.76-1.97 3-4.23 3.73-6.48H17V4h-7V2H8v2H1v2h11.17C11.5 7.9 10.46 9.87 9 11.51 8.08 10.5 7.34 9.32 6.8 8h-2c.62 1.84 1.62 3.53 2.92 5.01L2.25 18.5 3.66 19.9l5.34-5.34 3.87 3.87.03-.02c.79.79 1.95 1.59 3.1 1.59h6v-2h-6c-.72 0-1.5-.5-2.13-1.13zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
        </svg>
      `;
      triggerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = triggerBtn.getBoundingClientRect();
        showTranslationPanel(window.scrollX + rect.left, window.scrollY + rect.bottom + 8, currentSelectionText);
        hideTriggerButton();
      });
      document.body.appendChild(triggerBtn);
    }
    triggerBtn.style.left = `${x}px`;
    triggerBtn.style.top = `${y}px`;
    triggerBtn.style.display = 'flex';
  }

  function hideTriggerButton() {
    if (triggerBtn) {
      triggerBtn.style.display = 'none';
    }
  }

  function showTranslationPanel(x, y, text) {
    if (!panelElem) {
      panelElem = document.createElement('div');
      panelElem.id = 'chrome-translate-panel';
      document.body.appendChild(panelElem);
    }

    panelElem.style.left = `${Math.min(x, window.innerWidth + window.scrollX - 340)}px`;
    panelElem.style.top = `${y}px`;
    panelElem.style.display = 'block';

    const serviceBadge = config.serviceMode === 'custom_api' ? '自建私有后端' : '默认高速引擎';

    panelElem.innerHTML = `
      <div class="ct-panel-header">
        <div class="ct-panel-title">
          <span>翻译结果</span>
          <span class="ct-panel-badge">${serviceBadge}</span>
        </div>
        <div class="ct-panel-actions">
          <button class="ct-panel-btn" id="ct-copy-btn" title="复制译文">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          </button>
          <button class="ct-panel-btn" id="ct-close-btn" title="关闭">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      </div>
      <div class="ct-panel-body">
        <div class="ct-original-text">${escapeHtml(text)}</div>
        <div class="ct-translated-text" id="ct-panel-result">
          <div class="ct-loading-spinner">
            <div class="ct-spinner"></div>
            <span>正在请求翻译...</span>
          </div>
        </div>
      </div>
    `;

    panelElem.querySelector('#ct-close-btn').onclick = () => hidePanel();

    // Call background service to translate
    try {
      chrome.runtime.sendMessage({
        action: 'translateText',
        text: text,
        targetLanguage: config.targetLanguage,
        config: config
      }, (response) => {
        const resultElem = document.getElementById('ct-panel-result');
        if (!resultElem) return;

        if (chrome.runtime.lastError) {
          resultElem.innerHTML = `<span style="color:#ef4444;">翻译失败: ${chrome.runtime.lastError.message || '网络连接异常'}</span>`;
          return;
        }

        if (response && response.success) {
          resultElem.textContent = response.translatedText;
          const copyBtn = document.getElementById('ct-copy-btn');
          if (copyBtn) {
            copyBtn.onclick = () => {
              navigator.clipboard.writeText(response.translatedText);
              copyBtn.style.color = '#10b981';
              setTimeout(() => { copyBtn.style.color = ''; }, 1200);
            };
          }
        } else {
          resultElem.innerHTML = `<span style="color:#ef4444;">翻译失败: ${response ? response.error : '网络连接异常'}</span>`;
        }
      });
    } catch (err) {
      const resultElem = document.getElementById('ct-panel-result');
      if (resultElem) {
        resultElem.innerHTML = `<span style="color:#ef4444;">翻译失败: ${err.message}</span>`;
      }
    }
  }

  function hidePanel() {
    if (panelElem) {
      panelElem.style.display = 'none';
    }
  }

  function escapeHtml(string) {
    return String(string)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 8. Message listener from popup / background
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (!request || !request.action) return false;

      if (request.action === 'translatePage') {
        config.targetLanguage = request.targetLanguage || config.targetLanguage;
        executePageTranslation(config.targetLanguage);
        sendResponse({ success: true, hostHasTranslateJs: pageHostHasTranslate });
      } else if (request.action === 'restorePage') {
        restoreOriginalPage();
        sendResponse({ success: true });
      } else if (request.action === 'updateSettings') {
        config = Object.assign(config, request.settings || {});
        sendResponse({ success: true });
      } else if (request.action === 'checkPageStatus') {
        const hasHost = checkHostTranslateExists();
        const activeLang = document.documentElement.getAttribute('data-translate-active-lang');
        sendResponse({
          hostHasTranslateJs: hasHost,
          isTranslated: !!activeLang,
          activeLanguage: activeLang || null
        });
      } else if (request.action === 'showSelectionTranslation') {
        if (request.text) {
          showTranslationPanel(window.innerWidth / 2 - 160 + window.scrollX, window.innerHeight / 3 + window.scrollY, request.text);
          sendResponse({ success: true });
        }
      }
      return false;
    });
  }

  // Initialize
  loadConfig((cfg) => {
    setupSelectionListener();
    ensureBridgeInjected(() => {
      checkHostTranslateExists();
      if (cfg.autoTranslate) {
        executePageTranslation(cfg.targetLanguage);
      }
    });
  });

})();
