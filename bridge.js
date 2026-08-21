/**
 * Chrome Translate Plugin - Main World Bridge Script
 * 
 * Runs in the webpage's MAIN world context without violating Content Security Policy (CSP).
 * - Proxies outbound network requests from translate.js through Extension Background Service Worker
 * - Handles Custom translate-service backend requests
 * - Validates Custom API backend configuration and outputs clear console/UI warnings
 */
(function() {
  'use strict';

  if (window.__CHROME_TRANSLATE_BRIDGE_INITIALIZED__) {
    return;
  }
  window.__CHROME_TRANSLATE_BRIDGE_INITIALIZED__ = true;

  // Global state
  var reqIdCounter = 1;
  var pendingRequests = new Map();
  var currentServiceMode = 'default';
  var currentCustomApiHost = '';
  var currentTargetLanguage = 'chinese_simplified';

  // Standard Language List fallback
  var STANDARD_LANGUAGES = [
    { id: "chinese_simplified", name: "简体中文", serviceId: "zh-CHS" },
    { id: "chinese_traditional", name: "繁體中文", serviceId: "zh-CHT" },
    { id: "english", name: "English", serviceId: "en" },
    { id: "japanese", name: "日本語", serviceId: "ja" },
    { id: "korean", name: "한국어", serviceId: "ko" },
    { id: "french", name: "Français", serviceId: "fr" },
    { id: "german", name: "Deutsch", serviceId: "de" },
    { id: "spanish", name: "Español", serviceId: "es" },
    { id: "russian", name: "Русский язык", serviceId: "ru" },
    { id: "italian", name: "italiano", serviceId: "it" },
    { id: "portuguese", name: "português", serviceId: "pt" },
    { id: "vietnamese", name: "Tiếng Việt", serviceId: "vi" },
    { id: "thai", name: "คนไทย", serviceId: "th" },
    { id: "arabic", name: "بالعربية", serviceId: "ar" },
    { id: "hindi", name: "हिन्दी", serviceId: "hi" }
  ];

  // Extended Language Code Map for Edge Service
  var EDGE_LANG_MAP = {
    'chinese_simplified': 'zh-CHS',
    'zh-cn': 'zh-CHS',
    'zh-chs': 'zh-CHS',
    'zh-hans': 'zh-CHS',
    'zh': 'zh-CHS',
    'chinese_traditional': 'zh-CHT',
    'zh-tw': 'zh-CHT',
    'zh-hk': 'zh-CHT',
    'zh-cht': 'zh-CHT',
    'zh-hant': 'zh-CHT',
    'english': 'en',
    'en': 'en',
    'en-us': 'en',
    'en-gb': 'en',
    'japanese': 'ja',
    'ja': 'ja',
    'korean': 'ko',
    'ko': 'ko',
    'french': 'fr',
    'fr': 'fr',
    'german': 'de',
    'deutsch': 'de',
    'de': 'de',
    'spanish': 'es',
    'es': 'es',
    'russian': 'ru',
    'ru': 'ru',
    'italian': 'it',
    'it': 'it',
    'portuguese': 'pt',
    'pt': 'pt',
    'vietnamese': 'vi',
    'vi': 'vi',
    'thai': 'th',
    'th': 'th',
    'arabic': 'ar',
    'ar': 'ar',
    'hindi': 'hi',
    'hi': 'hi'
  };

  function normalizeEdgeLanguageCode(lang) {
    if (!lang) return '';
    var lower = String(lang).toLowerCase().trim();
    if (lower === 'auto') return '';
    return EDGE_LANG_MAP[lower] || lower;
  }

  // Helper: Display floating toast notice on webpage
  function showBridgeToast(message, type) {
    try {
      var existing = document.getElementById('ct-bridge-toast-banner');
      if (existing) existing.remove();

      var toast = document.createElement('div');
      toast.id = 'ct-bridge-toast-banner';
      toast.style.cssText = [
        'position: fixed',
        'top: 20px',
        'right: 20px',
        'z-index: 2147483647',
        'padding: 12px 18px',
        'border-radius: 8px',
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        'font-size: 13px',
        'font-weight: 500',
        'line-height: 1.5',
        'max-width: 380px',
        'box-shadow: 0 10px 25px -5px rgba(0,0,0,0.2), 0 8px 10px -6px rgba(0,0,0,0.1)',
        'display: flex',
        'align-items: center',
        'gap: 10px',
        'transition: opacity 0.3s ease, transform 0.3s ease',
        'transform: translateY(-10px)',
        'opacity: 0'
      ].join(';');

      if (type === 'error' || type === 'warning') {
        toast.style.backgroundColor = '#fef2f2';
        toast.style.color = '#991b1b';
        toast.style.border = '1px solid #fecaca';
      } else if (type === 'success') {
        toast.style.backgroundColor = '#f0fdf4';
        toast.style.color = '#166534';
        toast.style.border = '1px solid #bbf7d0';
      } else {
        toast.style.backgroundColor = '#eff6ff';
        toast.style.color = '#1e40af';
        toast.style.border = '1px solid #bfdbfe';
      }

      toast.innerHTML = '<span>' + message + '</span>';
      (document.body || document.documentElement).appendChild(toast);

      setTimeout(function() {
        toast.style.transform = 'translateY(0)';
        toast.style.opacity = '1';
      }, 20);

      setTimeout(function() {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-10px)';
        setTimeout(function() {
          if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 300);
      }, 4000);
    } catch (e) {}
  }

  // Dispatch lifecycle progress events to content script
  function notifyTranslateLifecycle(state, extra) {
    try {
      window.dispatchEvent(new CustomEvent('CT_BRIDGE_TRANSLATE_EVENT', {
        detail: Object.assign({
          state: state,
          targetLanguage: currentTargetLanguage,
          timestamp: Date.now()
        }, extra || {})
      }));
    } catch (e) {}
  }

  // Listen for Proxy Responses from content_script.js
  window.addEventListener('CT_BRIDGE_PROXY_RESPONSE', function(e) {
    var detail = e.detail;
    if (!detail || !detail.reqId) return;
    var pending = pendingRequests.get(detail.reqId);
    if (!pending) return;
    pendingRequests.delete(detail.reqId);

    if (detail.success) {
      var rawText = detail.responseText;
      var parsed = null;
      try {
        if (typeof rawText === 'object' && rawText !== null) {
          parsed = rawText;
        } else if (typeof rawText === 'string') {
          var trimmed = rawText.trim();
          if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            parsed = JSON.parse(trimmed);
          }
        }
      } catch (err) {
        parsed = null;
      }

      var mockXhr = {
        status: detail.status || 200,
        readyState: 4,
        responseText: typeof rawText === 'string' ? rawText : JSON.stringify(rawText),
        data: pending.xhrData || pending.data
      };

      try {
        if (typeof pending.successCallback === 'function') {
          var resultData = (parsed !== null) ? parsed : rawText;
          pending.successCallback(resultData, pending.xhrData || pending.data, mockXhr);
        }
      } catch (cbErr) {
        console.error('[Chrome Translate Bridge] Callback execution error:', cbErr);
        if (pending.isTranslationPayload) {
          notifyTranslateLifecycle('error', { error: cbErr.message });
        }
      }
    } else {
      if (typeof pending.errorCallback === 'function') {
        try {
          pending.errorCallback(detail.error || 'Network request failed');
        } catch (err) {}
      }
      // CRITICAL: Only dispatch lifecycle error if this request was an actual translation payload
      if (pending.isTranslationPayload) {
        notifyTranslateLifecycle('error', { error: detail.error || '翻译接口响应失败' });
      }
    }
  });

  // Install network proxy hook and lifecycle handlers onto translate.js
  function installTranslateRequestHook() {
    if (typeof window.translate === 'undefined') return;

    // 1. Defensively patch versionStringToInt to prevent undefined.split exceptions
    if (window.translate.util && typeof window.translate.util.versionStringToInt === 'function' && !window.translate.util.__ct_guarded__) {
      window.translate.util.__ct_guarded__ = true;
      var originalVersionStringToInt = window.translate.util.versionStringToInt;
      window.translate.util.versionStringToInt = function(vStr) {
        if (!vStr || typeof vStr !== 'string') return 0;
        try {
          return originalVersionStringToInt.call(this, vStr);
        } catch (e) {
          return 0;
        }
      };
    }

    // 2. Hook Lifecycle Events for Progress Tracking
    if (window.translate.lifecycle && !window.translate.lifecycle.__ct_hooked__) {
      window.translate.lifecycle.__ct_hooked__ = true;

      if (window.translate.lifecycle.execute) {
        window.translate.lifecycle.execute.start.push(function(uuid, to) {
          notifyTranslateLifecycle('start', { uuid: uuid, targetLanguage: to || currentTargetLanguage });
        });

        window.translate.lifecycle.execute.translateNetworkBefore.push(function(info) {
          notifyTranslateLifecycle('requesting', { uuid: info ? info.uuid : null });
        });

        window.translate.lifecycle.execute.translateNetworkAfter.push(function(info) {
          notifyTranslateLifecycle('received', { uuid: info ? info.uuid : null });
        });

        window.translate.lifecycle.execute.renderFinish.push(function(uuid, to) {
          notifyTranslateLifecycle('rendered', { uuid: uuid, targetLanguage: to || currentTargetLanguage });
        });

        window.translate.lifecycle.execute.finally.push(function(info) {
          notifyTranslateLifecycle('finished', { info: info, targetLanguage: (info && info.to) || currentTargetLanguage });
        });
      }
    }

    if (!window.translate.request || window.translate.request.__hooked_by_extension__) return;
    window.translate.request.__hooked_by_extension__ = true;

    var originalSend = window.translate.request.send;
    var originalPost = window.translate.request.post;

    // 2. Direct Edge Service Method Implementation
    if (window.translate.service && window.translate.service.edge) {
      window.translate.service.edge.translate = function(url, requestData, successCallback, errorCallback) {
        try {
          var textArray = [];
          if (requestData && requestData.text) {
            try {
              textArray = JSON.parse(decodeURIComponent(requestData.text));
            } catch (pErr) {
              textArray = [requestData.text];
            }
          }

          var fromLang = normalizeEdgeLanguageCode(requestData.from);
          var toLang = normalizeEdgeLanguageCode(requestData.to || currentTargetLanguage);

          // If from is same as to, clear from so Edge auto-detects
          if (fromLang === toLang) {
            fromLang = '';
          }

          var edgeUrl = 'https://edge.microsoft.com/translate/translatetext?from=' + encodeURIComponent(fromLang) + '&to=' + encodeURIComponent(toLang) + '&isEnterpriseClient=false';

          var reqId = 'req_' + (reqIdCounter++) + '_' + Date.now();
          var xhrData = { from: requestData.from + '', to: requestData.to, text: requestData.text };

          pendingRequests.set(reqId, {
            isTranslationPayload: true,
            data: JSON.stringify(textArray),
            xhrData: xhrData,
            successCallback: function(res) {
              // Format standard translate.js response
              var standardResult = {
                info: 'SUCCESS',
                result: 1,
                from: requestData.from,
                to: requestData.to,
                text: []
              };

              if (Array.isArray(res)) {
                for (var i = 0; i < res.length; i++) {
                  if (res[i] && res[i].translations && res[i].translations[0]) {
                    standardResult.text.push(res[i].translations[0].text);
                  } else {
                    standardResult.text.push(textArray[i] || '');
                  }
                }
              }

              if (typeof successCallback === 'function') {
                successCallback(standardResult, xhrData);
              }
              // Successfully translated batch
              notifyTranslateLifecycle('rendered', { targetLanguage: requestData.to || currentTargetLanguage });
            },
            errorCallback: function(err) {
              if (typeof errorCallback === 'function') {
                errorCallback(err);
              }
              notifyTranslateLifecycle('error', { error: (typeof err === 'string' ? err : (err && err.message)) || 'Edge 翻译接口请求失败' });
            }
          });

          window.dispatchEvent(new CustomEvent('CT_BRIDGE_PROXY_REQUEST', {
            detail: {
              reqId: reqId,
              url: edgeUrl,
              method: 'POST',
              body: JSON.stringify(textArray),
              headers: { 'Content-Type': 'application/json' }
            }
          }));
        } catch (edgeErr) {
          console.error('[Chrome Translate Bridge] Edge translate dispatch error:', edgeErr);
          if (typeof errorCallback === 'function') errorCallback(edgeErr);
        }
      };
    }

    // 3. Hook translate.request.post for standard delegation
    window.translate.request.post = function(url, params, successCallback, errorCallback) {
      // Mock language list and diagnostics instantly for zero network lag
      if (url === window.translate.request.api.language || (typeof url === 'string' && url.indexOf('language.json') !== -1)) {
        if (typeof successCallback === 'function') {
          return void successCallback({
            info: 'SUCCESS',
            result: 1,
            list: STANDARD_LANGUAGES
          });
        }
      }
      if (url === window.translate.request.api.ip || (typeof url === 'string' && url.indexOf('ip.json') !== -1)) {
        if (typeof successCallback === 'function') {
          return void successCallback({
            info: 'SUCCESS',
            result: 1,
            country: 'CN'
          });
        }
      }

      // Default Edge Service Mode
      if (currentServiceMode === 'default' || (window.translate.service && window.translate.service.name === 'client.edge')) {
        if (url === window.translate.request.api.translate) {
          return void window.translate.service.edge.translate(url, params, successCallback, errorCallback);
        }
      }

      // Fallback to standard post behavior (which triggers translate.request.send)
      if (typeof originalPost === 'function') {
        return originalPost.call(this, url, params, successCallback, errorCallback);
      }
    };

    // 4. Fully Polymorphic Hook for translate.request.send
    window.translate.request.send = function() {
      var args = Array.prototype.slice.call(arguments);
      var url = args[0];
      var data = args[1];
      var xhrData = null;
      var successCallback = null;
      var method = 'POST';
      var isAsync = true;
      var headers = {};
      var errorCallback = null;

      // Extract parameters polymorphically
      for (var i = 2; i < args.length; i++) {
        var arg = args[i];
        if (typeof arg === 'function') {
          if (!successCallback) {
            successCallback = arg;
          } else if (!errorCallback) {
            errorCallback = arg;
          }
        } else if (typeof arg === 'string') {
          var upper = arg.toUpperCase();
          if (upper === 'POST' || upper === 'GET' || upper === 'PUT' || upper === 'DELETE' || upper === 'HEAD') {
            method = upper;
          }
        } else if (typeof arg === 'boolean') {
          isAsync = arg;
        } else if (typeof arg === 'object' && arg !== null && !Array.isArray(arg)) {
          if (arg['Content-Type'] || arg['content-type'] || arg['Accept'] || arg['accept'] || arg['currentpage']) {
            headers = Object.assign({}, headers, arg);
          } else if (!xhrData) {
            xhrData = arg;
          }
        }
      }

      // Fast mock response for auxiliary requests like init.json or connectTest
      if (typeof url === 'string') {
        if (url.indexOf('init.json') !== -1 || (window.translate.request.api && url === window.translate.request.api.init)) {
          if (typeof successCallback === 'function') {
            var currentVer = (window.translate && window.translate.version) ? String(window.translate.version).replace(/^v/i, '') : '3.5.0';
            return void setTimeout(function() {
              successCallback({
                info: 'SUCCESS',
                result: 1,
                version: currentVer
              }, xhrData || data, { status: 200, readyState: 4 });
            }, 0);
          }
        }
        if (url.indexOf('connectTest') !== -1) {
          if (typeof successCallback === 'function') {
            return void setTimeout(function() {
              successCallback({ info: 'SUCCESS', result: 1 }, xhrData || data, { status: 200, readyState: 4 });
            }, 0);
          }
        }
      }

      var reqId = 'req_' + (reqIdCounter++) + '_' + Date.now();

      // Transform URL for relative paths
      var finalUrl = url;
      if (typeof finalUrl === 'string' && finalUrl.indexOf('//') === -1) {
        if (currentServiceMode === 'custom_api' && currentCustomApiHost) {
          var base = currentCustomApiHost;
          if (!base.endsWith('/')) base += '/';
          var path = finalUrl.startsWith('/') ? finalUrl.substring(1) : finalUrl;
          finalUrl = base + path;
        }
      }

      // Clean invalid from=undefined or to=undefined in URL
      if (typeof finalUrl === 'string') {
        finalUrl = finalUrl.replace(/from=undefined/g, 'from=').replace(/from=null/g, 'from=');
      }

      // Format payload data
      var bodyData = data;
      var requestHeaders = Object.assign({}, headers);
      if (typeof data === 'object' && data !== null && !(data instanceof FormData)) {
        var queryParams = [];
        for (var k in data) {
          if (Object.prototype.hasOwnProperty.call(data, k)) {
            queryParams.push(encodeURIComponent(k) + '=' + encodeURIComponent(data[k]));
          }
        }
        bodyData = queryParams.join('&');
        if (!requestHeaders['Content-Type'] && !requestHeaders['content-type']) {
          requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        }
      }

      var isTranslatePayload = typeof finalUrl === 'string' && (finalUrl.indexOf('translate') !== -1);

      pendingRequests.set(reqId, {
        isTranslationPayload: isTranslatePayload,
        data: data,
        xhrData: xhrData || data,
        successCallback: successCallback,
        errorCallback: errorCallback
      });

      // Dispatch to Content Script in Isolated World
      window.dispatchEvent(new CustomEvent('CT_BRIDGE_PROXY_REQUEST', {
        detail: {
          reqId: reqId,
          url: finalUrl,
          method: method,
          body: bodyData,
          headers: requestHeaders
        }
      }));
    };
  }

  // Helper: Patch edge language map with common aliases
  function patchEdgeLanguageMap() {
    try {
      if (window.translate && window.translate.service && window.translate.service.edge && window.translate.service.edge.language) {
        if (typeof window.translate.service.edge.language.getMap === 'function') {
          var map = window.translate.service.edge.language.getMap();
          if (map) {
            for (var k in EDGE_LANG_MAP) {
              if (EDGE_LANG_MAP.hasOwnProperty(k)) {
                map[k] = EDGE_LANG_MAP[k];
              }
            }
          }
        }
      }
    } catch (e) {}
  }

  // Helper: Clear any hanging or waiting execution queues in translate.js
  function clearTranslateQueuesAndState() {
    try {
      if (typeof window.translate !== 'undefined') {
        if (window.translate.waitingExecute) {
          window.translate.waitingExecute.queue = [];
          if (window.translate.waitingExecute.intervalId) {
            clearInterval(window.translate.waitingExecute.intervalId);
            window.translate.waitingExecute.intervalId = null;
          }
        }
        window.translate.state = 0;
        if (typeof window.translate.clearTasks === 'function') {
          window.translate.clearTasks();
        }
      }
    } catch (e) {}
  }

  // 1. Detect if host page already has translate.js
  function checkTranslateStatus() {
    var hasTranslate = typeof window.translate !== 'undefined' && typeof window.translate.version === 'string';
    window.dispatchEvent(new CustomEvent('CT_BRIDGE_STATUS_RESPONSE', {
      detail: {
        hasTranslate: hasTranslate,
        version: hasTranslate ? window.translate.version : null,
        isExecute: hasTranslate ? !!window.translate.executeTriggerNumber : false,
        currentLanguage: hasTranslate ? (window.translate.to || window.translate.currentLanguage) : null
      }
    }));
    return hasTranslate;
  }

  // 2. Perform or apply translation
  function doExecuteTranslation(payload) {
    var target = payload.targetLanguage || 'chinese_simplified';
    var mode = payload.serviceMode || 'default';
    var customHost = payload.customApiHost || '';

    currentServiceMode = mode;
    currentCustomApiHost = customHost;
    currentTargetLanguage = target;

    // Strict validation for custom_api mode
    if (mode === 'custom_api' && (!customHost || !customHost.trim())) {
      var msg = '[Web Translate Pro] 无法启动翻译：当前已选择【自建私有后端】模式，但未配置有效的私有服务地址 (customApiHost)！请在插件设置中填写您的自建后端接口地址 (例如 http://127.0.0.1:8080)。';
      console.error(msg);
      showBridgeToast('⚠️ 无法翻译：已选择自建私有后端，但未配置服务地址。请在插件设置中填写服务地址！', 'error');
      return;
    }

    function applyConfigAndTranslate() {
      if (typeof window.translate === 'undefined') {
        console.error('[Chrome Translate Bridge] window.translate is undefined after load.');
        showBridgeToast('⚠️ translate.js 引擎加载失败，请刷新页面重试', 'error');
        return;
      }

      // Install CSP Proxy hooks & language map patches
      installTranslateRequestHook();
      patchEdgeLanguageMap();

      // Configure Backend Service Mode
      try {
        if (mode === 'custom_api' && customHost) {
          if (window.translate.service && typeof window.translate.service.use === 'function') {
            window.translate.service.use(customHost);
          }
          if (window.translate.request && window.translate.request.api) {
            window.translate.request.api.host = customHost;
          }
        } else {
          // Default Microsoft Edge client mode
          if (window.translate.service && typeof window.translate.service.use === 'function') {
            window.translate.service.use('client.edge');
          }
        }
      } catch (err) {
        console.warn('[Chrome Translate Bridge] Service config error:', err);
      }

      // Clear any waiting tasks/jammed queues before executing new language
      clearTranslateQueuesAndState();

      // Allow multi-language and cross-language translation
      if (window.translate.language) {
        window.translate.language.translateLocal = true;
      }
      if (window.translate.selectLanguageTag) {
        window.translate.selectLanguageTag.show = false;
      }

      // Normalize language name
      var normalizedLang = target;
      if (normalizedLang === 'german') normalizedLang = 'deutsch';

      // Execute or change language
      try {
        if (typeof window.translate.changeLanguage === 'function') {
          window.translate.changeLanguage(normalizedLang);
        } else {
          window.translate.to = normalizedLang;
          window.translate.execute();
        }
        document.documentElement.setAttribute('data-translate-active-lang', target);
      } catch (err) {
        console.error('[Chrome Translate Bridge] Execution error:', err);
        showBridgeToast('⚠️ 页面翻译执行失败: ' + err.message, 'error');
      }
    }

    if (typeof window.translate !== 'undefined' && typeof window.translate.version === 'string') {
      applyConfigAndTranslate();
    } else {
      // Load translate.js via script tag src
      if (payload.translateScriptUrl) {
        var script = document.createElement('script');
        script.src = payload.translateScriptUrl;
        script.onload = function() {
          applyConfigAndTranslate();
        };
        script.onerror = function(err) {
          console.error('[Chrome Translate Bridge] Failed to load translate.js:', err);
          showBridgeToast('⚠️ translate.js 资源加载失败，请检查网络或刷新重试', 'error');
        };
        (document.head || document.documentElement).appendChild(script);
      } else {
        console.error('[Chrome Translate Bridge] No translateScriptUrl provided.');
      }
    }
  }

  // 3. Restore original page text
  function doRestoreOriginalPage() {
    if (typeof window.translate !== 'undefined') {
      try {
        clearTranslateQueuesAndState();
        if (typeof window.translate.reset === 'function') {
          window.translate.reset();
        } else if (typeof window.translate.changeLanguage === 'function') {
          var original = (window.translate.language && window.translate.language.getLocal()) || 'chinese_simplified';
          window.translate.changeLanguage(original);
        }
        document.documentElement.removeAttribute('data-translate-active-lang');
        showBridgeToast('✓ 已恢复网页原始语言', 'success');
      } catch (e) {
        console.error('[Chrome Translate Bridge] Restore error:', e);
      }
    }
  }

  // Event Listeners for Content Script Requests
  window.addEventListener('CT_BRIDGE_CHECK_STATUS', function() {
    checkTranslateStatus();
  });

  window.addEventListener('CT_BRIDGE_EXECUTE_TRANSLATE', function(e) {
    doExecuteTranslation(e.detail || {});
  });

  window.addEventListener('CT_BRIDGE_RESTORE_PAGE', function() {
    doRestoreOriginalPage();
  });

  window.addEventListener('CT_BRIDGE_CLEAR_TASKS', function() {
    clearTranslateQueuesAndState();
  });

  // Initial self check & hook
  checkTranslateStatus();
})();
