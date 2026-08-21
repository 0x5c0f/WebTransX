/**
 * Chrome Translate Plugin - Popup Script
 */

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const selectTargetLang = document.getElementById('select-target-lang');
  const checkEnableSelection = document.getElementById('check-enable-selection');
  const checkAutoTranslate = document.getElementById('check-auto-translate');

  const radioModeCards = document.querySelectorAll('.radio-card');
  const subformCustomApi = document.getElementById('subform-custom-api');
  const inputCustomApiHost = document.getElementById('input-custom-api-host');

  const btnTestConnection = document.getElementById('btn-test-connection');
  const testConnectionResult = document.getElementById('test-connection-result');

  const btnSaveSettings = document.getElementById('btn-save-settings');
  const saveTip = document.getElementById('save-tip');

  const btnTranslatePage = document.getElementById('btn-translate-page');
  const btnRestorePage = document.getElementById('btn-restore-page');

  const hostStatusAlert = document.getElementById('host-status-alert');
  const hostStatusText = document.getElementById('host-status-text');

  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  // Default state
  const defaultSettings = {
    targetLanguage: 'chinese_simplified',
    enableSelection: true,
    autoTranslate: false,
    serviceMode: 'default',
    customApiHost: ''
  };

  // 1. Tab Switching
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      tabPanes.forEach(p => p.style.display = 'none');

      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.style.display = 'block';
    });
  });

  // 2. Radio Card Mode Selection
  function updateServiceModeUI(mode) {
    radioModeCards.forEach(card => {
      const radio = card.querySelector('input[type="radio"]');
      if (radio.value === mode) {
        radio.checked = true;
        card.classList.add('selected');
      } else {
        radio.checked = false;
        card.classList.remove('selected');
      }
    });

    if (subformCustomApi) {
      subformCustomApi.style.display = mode === 'custom_api' ? 'block' : 'none';
    }
  }

  radioModeCards.forEach(card => {
    card.addEventListener('click', () => {
      const radio = card.querySelector('input[type="radio"]');
      if (radio) {
        updateServiceModeUI(radio.value);
      }
    });
  });

  // 3. Load Saved Settings
  function loadSettings() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(defaultSettings, (items) => {
        applySettingsToForm(items || defaultSettings);
      });
    } else {
      applySettingsToForm(defaultSettings);
    }
  }

  function applySettingsToForm(s) {
    selectTargetLang.value = s.targetLanguage || 'chinese_simplified';
    checkEnableSelection.checked = s.enableSelection !== false;
    checkAutoTranslate.checked = !!s.autoTranslate;

    updateServiceModeUI(s.serviceMode || 'default');
    if (inputCustomApiHost) {
      inputCustomApiHost.value = s.customApiHost || '';
    }
  }

  // 4. Gather Settings from Form
  function gatherSettings() {
    const selectedRadio = document.querySelector('input[name="serviceMode"]:checked');
    return {
      targetLanguage: selectTargetLang.value,
      enableSelection: checkEnableSelection.checked,
      autoTranslate: checkAutoTranslate.checked,
      serviceMode: selectedRadio ? selectedRadio.value : 'default',
      customApiHost: inputCustomApiHost ? inputCustomApiHost.value.trim() : ''
    };
  }

  // 5. Save Settings Action
  btnSaveSettings.addEventListener('click', () => {
    const current = gatherSettings();
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set(current, () => {
        showSaveSuccess(current);
        // Notify active tab content script
        sendTabMessage({ action: 'updateSettings', settings: current });
      });
    } else {
      showSaveSuccess(current);
    }
  });

  function showSaveSuccess(cfg) {
    if (cfg && cfg.serviceMode === 'custom_api' && !cfg.customApiHost) {
      saveTip.textContent = '已保存 (⚠️ 未配置后端地址)';
      saveTip.style.color = '#dc2626';
    } else {
      saveTip.textContent = '✓ 配置已保存';
      saveTip.style.color = '#16a34a';
    }
    saveTip.classList.add('show');
    setTimeout(() => {
      saveTip.classList.remove('show');
    }, 2200);
  }

  // 6. Test Connection Button
  if (btnTestConnection) {
    btnTestConnection.addEventListener('click', () => {
      const current = gatherSettings();

      if (current.serviceMode === 'custom_api' && !current.customApiHost) {
        testConnectionResult.className = 'test-box error';
        testConnectionResult.style.display = 'block';
        testConnectionResult.innerHTML = `
          <strong>✗ 连接测试失败</strong><br>
          原因: 您选择了自建私有后端，但尚未填写后端服务地址！
        `;
        return;
      }

      testConnectionResult.className = 'test-box';
      testConnectionResult.style.display = 'block';
      testConnectionResult.innerHTML = '正在测试连接...';

      if (typeof chrome !== 'undefined' && chrome.runtime) {
        chrome.runtime.sendMessage({
          action: 'testConnection',
          config: current
        }, (response) => {
          if (response && response.success) {
            testConnectionResult.className = 'test-box success';
            testConnectionResult.innerHTML = `
              <strong>✓ 连接成功 (${response.duration}ms)</strong><br>
              测试译文: ${response.sampleResult || 'Hello -> 你好'}
            `;
          } else {
            testConnectionResult.className = 'test-box error';
            testConnectionResult.innerHTML = `
              <strong>✗ 连接失败</strong><br>
              错误信息: ${response ? response.error : '无法建立连接'}
            `;
          }
        });
      } else {
        setTimeout(() => {
          testConnectionResult.className = 'test-box success';
          testConnectionResult.innerHTML = '✓ 本地模拟连接测试成功 (120ms)';
        }, 500);
      }
    });
  }

  // 7. Page Translation & Restore Handlers
  btnTranslatePage.addEventListener('click', () => {
    const current = gatherSettings();
    if (current.serviceMode === 'custom_api' && !current.customApiHost) {
      showHostNotice('⚠️ 无法启动翻译：当前选择了「自建私有后端」，但未配置服务地址！请切换至「后端配置」填写服务地址。');
      return;
    }

    // Auto sync targetLanguage setting
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set(current);
    }

    const target = selectTargetLang.value;
    sendTabMessage({ action: 'translatePage', targetLanguage: target }, (res) => {
      if (res && res.hostHasTranslateJs) {
        showHostNotice('当前网页已存在 translate.js，已安全无冲突复用执行。');
      }
    });
  });

  selectTargetLang.addEventListener('change', () => {
    const current = gatherSettings();
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set({ targetLanguage: current.targetLanguage });
    }
  });

  btnRestorePage.addEventListener('click', () => {
    sendTabMessage({ action: 'restorePage' });
  });

  // 8. Inspect Active Tab Status for Existing translate.js
  function checkActiveTabStatus() {
    sendTabMessage({ action: 'checkPageStatus' }, (res) => {
      if (res && res.hostHasTranslateJs) {
        showHostNotice('检测到当前网页已原生支持 translate.js，已激活智能防冲突保护！');
      }
    });
  }

  function showHostNotice(text) {
    if (hostStatusAlert && hostStatusText) {
      hostStatusText.textContent = text;
      hostStatusAlert.style.display = 'flex';
    }
  }

  function sendTabMessage(msg, callback) {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0] && tabs[0].id) {
          chrome.tabs.sendMessage(tabs[0].id, msg, (response) => {
            if (chrome.runtime.lastError) {
              // Ignore standard disconnected port error
            }
            if (callback) callback(response);
          });
        }
      });
    }
  }

  // Init
  loadSettings();
  checkActiveTabStatus();
});
