// === CC-Web Frontend ===
(function () {
  'use strict';

  const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const RENDER_DEBOUNCE = 100;

  const SLASH_COMMANDS = [
    { cmd: '/clear', desc: '清除当前会话' },
    { cmd: '/model', desc: '查看/切换模型' },
    { cmd: '/mode', desc: '查看/切换权限模式' },
    { cmd: '/cost', desc: '查看会话费用' },
    { cmd: '/compact', desc: '压缩上下文' },
    { cmd: '/init', desc: '生成/更新 Agent 指南文件' },
    { cmd: '/github', desc: 'GitHub 操作（读取开发者配置后执行）' },
    { cmd: '/ssh', desc: 'SSH 远程操作（读取开发者配置后执行）' },
    { cmd: '/help', desc: '显示帮助' },
  ];

  const MODE_LABELS = {
    default: '默认',
    plan: 'Plan',
    yolo: 'YOLO',
  };

  const AGENT_LABELS = {
    claude: 'Claude',
    codex: 'Codex',
  };

  const DEFAULT_AGENT = 'claude';
  const SESSION_CACHE_LIMIT = 4;
  const SESSION_CACHE_MAX_WEIGHT = 1_500_000;
  const SIDEBAR_SWIPE_TRIGGER = 72;
  const SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT = 42;

  const MODEL_OPTIONS = [
    { value: 'opus', label: 'Opus', desc: '最强大，1M 上下文' },
    { value: 'sonnet', label: 'Sonnet', desc: '平衡性能，1M 上下文' },
    { value: 'haiku', label: 'Haiku', desc: '最快速，适合简单任务' },
  ];

  const MODE_PICKER_OPTIONS = [
    { value: 'yolo', label: 'YOLO', desc: '跳过所有权限检查' },
    { value: 'plan', label: 'Plan', desc: '执行前需确认计划' },
    { value: 'default', label: '默认', desc: '标准权限审批' },
  ];

  const THEME_OPTIONS = [
    {
      value: 'washi',
      label: 'Washi Warm',
      desc: '暖纸色与朱砂点缀，保留当前熟悉的 CC-Web 气质。',
      swatches: ['#faf6f0', '#f2ebe2', '#c0553a', '#5d8a54'],
    },
    {
      value: 'coolvibe',
      label: 'CoolVibe Light',
      desc: '保留 CoolVibe 的青色科技感，但改成更干净的浅色工作台。',
      swatches: ['#f7fbfc', '#eef7f9', '#0891b2', '#ffffff'],
    },
    {
      value: 'editorial',
      label: 'Editorial Sand',
      desc: '更明亮的留白和更克制的棕色强调，像编辑台一样安静。',
      swatches: ['#f6f1e8', '#efe8dc', '#8b5e3c', '#2f4b45'],
    },
  ];

  // --- State ---
  let ws = null;
  let authToken = localStorage.getItem('cc-web-token');
  let serverHomeDir = ''; // populated from auth_result, used as new-session default cwd
  let currentSessionId = null;
  let sessions = [];
  let sessionCache = new Map();
  let isGenerating = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let pendingText = '';
  let pendingThinking = '';
  let renderTimer = null;
  let activeToolCalls = new Map();
  let toolGroupCount = 0;   // 当前 .msg-tools 直接子节点数（含已有父目录）
  let hasGrouped = false;  // 本次输出是否已触发过折叠
  let cmdMenuIndex = -1;
  let currentMode = 'yolo';
  let currentModel = 'opus';
  let currentAgent = AGENT_LABELS[localStorage.getItem('cc-web-agent')] ? localStorage.getItem('cc-web-agent') : DEFAULT_AGENT;
  let currentTheme = (document.documentElement.dataset.theme || localStorage.getItem('cc-web-theme') || 'washi');
  let codexConfigCache = null;
  let loadedHistorySessionId = null;
  let activeSessionLoad = null;
  let sidebarSwipe = null;
  let pendingAttachments = [];
  let uploadingAttachments = [];
  let loginPasswordValue = ''; // store login password for force-change flow
  let currentCwd = null;
  let currentSessionRunning = false;
  let skipDeleteConfirm = localStorage.getItem('cc-web-skip-delete-confirm') === '1';
  let pendingInitialSessionLoad = false;
  let sessionListSafetyTimer = null;
  let authRetried = false;

  // --- DOM ---
  const $ = (sel) => document.querySelector(sel);
  const loginOverlay = $('#login-overlay');
  const loginForm = $('#login-form');
  const loginPassword = $('#login-password');
  const loginError = $('#login-error');
  const rememberPw = $('#remember-pw');
  const app = $('#app');
  const sessionLoadingOverlay = $('#session-loading-overlay');
  const sessionLoadingLabel = $('#session-loading-label');
  const sidebar = $('#sidebar');
  const sidebarOverlay = $('#sidebar-overlay');
  const menuBtn = $('#menu-btn');
  const chatMain = document.querySelector('.chat-main');
  const newChatSplit = sidebar.querySelector('.new-chat-split');
  const newChatBtn = $('#new-chat-btn');
  const newChatArrow = $('#new-chat-arrow');
  const newChatDropdown = $('#new-chat-dropdown');
  const importSessionBtn = $('#import-session-btn');
  const sessionList = $('#session-list');
  const chatTitle = $('#chat-title');
  const chatAgentBtn = $('#chat-agent-btn');
  const chatAgentMenu = $('#chat-agent-menu');
  const chatRuntimeState = $('#chat-runtime-state');
  const chatCwd = $('#chat-cwd');
  const costDisplay = $('#cost-display');
  const attachmentTray = $('#attachment-tray');
  const imageUploadInput = $('#image-upload-input');
  const attachBtn = $('#attach-btn');
  const messagesDiv = $('#messages');
  const msgInput = $('#msg-input');
  const inputWrapper = msgInput.closest('.input-wrapper');
  const sendBtn = $('#send-btn');
  const abortBtn = $('#abort-btn');
  const cmdMenu = $('#cmd-menu');
  const modeSelect = $('#mode-select');
  const chatAnnounce = $('#chat-announce');
  const ctxMeter = $('#ctx-meter');
  const ctxPopover = $('#ctx-popover');

  // --- Viewport height fix for mobile browsers ---
  function setVH() {
    document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
  }
  setVH();
  window.addEventListener('resize', setVH);
  window.addEventListener('orientationchange', () => setTimeout(setVH, 100));

  // --- visualViewport: inject --kb-inset when soft keyboard pushes the viewport up ---
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const updateKbInset = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--kb-inset', `${inset}px`);
    };
    vv.addEventListener('resize', updateKbInset);
    vv.addEventListener('scroll', updateKbInset);
    updateKbInset();
  }

  function buildWelcomeMarkup(agent) {
    const label = AGENT_LABELS[agent] || AGENT_LABELS.claude;
    return `<div class="welcome-msg"><div class="welcome-icon">✿</div><h3>欢迎使用 CC-Web</h3><p>开始与 ${label} 对话</p><div class="welcome-hint">按 <kbd>/</kbd> 查看指令 · <kbd>Enter</kbd> 发送 · <kbd>?</kbd> 快捷键</div></div>`;
  }

  function normalizeAgent(agent) {
    return AGENT_LABELS[agent] ? agent : DEFAULT_AGENT;
  }

  function normalizeTheme(theme) {
    return THEME_OPTIONS.some((item) => item.value === theme) ? theme : 'washi';
  }

  function getThemeOption(theme) {
    return THEME_OPTIONS.find((item) => item.value === normalizeTheme(theme)) || THEME_OPTIONS[0];
  }

  function refreshThemeSummaries() {
    const label = getThemeOption(currentTheme).label;
    document.querySelectorAll('[data-theme-summary]').forEach((node) => {
      node.textContent = label;
    });
  }

  // hljs stylesheet name for each site theme; defaults to atom-one-light.
  // (Map only needs an entry for themes that should use a different stylesheet.)
  const HLJS_THEME_FOR_SITE = {
    washi: 'atom-one-light',
    coolvibe: 'atom-one-light',
    editorial: 'atom-one-light',
  };
  function applyHighlightTheme(siteTheme) {
    const link = document.getElementById('hljs-theme-link');
    if (!link) return;
    const want = HLJS_THEME_FOR_SITE[siteTheme] || 'atom-one-light';
    const url = `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/${want}.min.css`;
    if (link.href !== url) link.href = url;
  }

  function applyTheme(theme) {
    currentTheme = normalizeTheme(theme);
    document.documentElement.dataset.theme = currentTheme;
    localStorage.setItem('cc-web-theme', currentTheme);
    applyHighlightTheme(currentTheme);
    refreshThemeSummaries();
  }

  function buildThemePickerHtml(options = {}) {
    const { showSectionTitle = true } = options;
    return `
      ${showSectionTitle ? '<div class="settings-section-title">界面主题</div>' : ''}
      <div class="theme-grid">
        ${THEME_OPTIONS.map((theme) => `
          <button class="theme-card${theme.value === currentTheme ? ' active' : ''}" type="button" data-theme-value="${theme.value}">
            <div class="theme-card-preview">
              ${theme.swatches.map((color) => `<span class="theme-card-swatch" style="background:${color}"></span>`).join('')}
            </div>
            <div class="theme-card-title">${escapeHtml(theme.label)}</div>
            <div class="theme-card-desc">${escapeHtml(theme.desc)}</div>
          </button>
        `).join('')}
      </div>
    `;
  }

  function mountThemePicker(panel) {
    panel.querySelectorAll('[data-theme-value]').forEach((button) => {
      button.addEventListener('click', () => {
        applyTheme(button.dataset.themeValue);
        panel.querySelectorAll('[data-theme-value]').forEach((item) => {
          item.classList.toggle('active', item.dataset.themeValue === currentTheme);
        });
      });
    });
  }

  function buildThemeEntryHtml() {
    return `
      <div class="settings-section-title">外观</div>
      <button class="settings-nav-card" type="button" data-open-theme-page>
        <span class="settings-nav-card-main">
          <span class="settings-nav-card-title">界面主题</span>
          <span class="settings-nav-card-meta">当前：<span data-theme-summary>${escapeHtml(getThemeOption(currentTheme).label)}</span></span>
        </span>
        <span class="settings-nav-card-arrow" aria-hidden="true">›</span>
      </button>
    `;
  }

  function buildNotifyEntryHtml(config) {
    const provider = config?.provider || 'off';
    const providerLabel = PROVIDER_OPTIONS.find(o => o.value === provider)?.label || '关闭';
    const summaryOn = config?.summary?.enabled ? '摘要已启用' : '摘要关闭';
    const meta = provider === 'off' ? '未启用' : `${providerLabel} · ${summaryOn}`;
    return `
      <div class="settings-section-title">通知</div>
      <button class="settings-nav-card" type="button" data-open-notify-page>
        <span class="settings-nav-card-main">
          <span class="settings-nav-card-title">通知设置</span>
          <span class="settings-nav-card-meta" data-notify-summary>${escapeHtml(meta)}</span>
        </span>
        <span class="settings-nav-card-arrow" aria-hidden="true">›</span>
      </button>
    `;
  }

  function openNotifySubpage() {
    send({ type: 'get_notify_config' });

    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay settings-subpage-overlay';
    overlay.style.zIndex = '10001';

    const panel = document.createElement('div');
    panel.className = 'settings-panel settings-subpage-panel';
    panel.innerHTML = `
      <div class="settings-header settings-subpage-header">
        <button class="settings-back" type="button" aria-label="返回">‹</button>
        <div class="settings-subpage-copy">
          <div class="settings-subpage-kicker">Notification</div>
          <h3>通知设置</h3>
        </div>
      </div>
      <div class="settings-field">
        <label>通知方式</label>
        <select class="settings-select" id="notify-provider">
          ${PROVIDER_OPTIONS.map(o => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join('')}
        </select>
      </div>
      <div id="notify-fields"></div>
      <div id="notify-summary-area"></div>
      <div class="settings-actions">
        <button class="btn-test" id="notify-test-btn">测试</button>
        <button class="btn-save" id="notify-save-btn">保存</button>
      </div>
      <div class="settings-status" id="notify-status"></div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const providerSelect = panel.querySelector('#notify-provider');
    const fieldsDiv = panel.querySelector('#notify-fields');
    const summaryArea = panel.querySelector('#notify-summary-area');
    const statusDiv = panel.querySelector('#notify-status');
    const testBtn = panel.querySelector('#notify-test-btn');
    const saveBtn = panel.querySelector('#notify-save-btn');

    let currentNotifyConfig = null;

    function renderFields(provider) {
      renderNotifyFields(fieldsDiv, currentNotifyConfig, provider);
      if (summaryArea) {
        summaryArea.innerHTML = buildSummarySettingsHtml(currentNotifyConfig);
        bindSummarySettingsEvents(panel);
      }
    }

    function collectConfig() {
      return collectNotifyConfigFromPanel(panel, currentNotifyConfig, providerSelect.value);
    }

    function showStatus(msg, type) {
      statusDiv.textContent = msg;
      statusDiv.className = 'settings-status ' + (type || '');
    }

    function refreshParentSummary(config) {
      const provider = config?.provider || 'off';
      const providerLabel = PROVIDER_OPTIONS.find(o => o.value === provider)?.label || '关闭';
      const summaryOn = config?.summary?.enabled ? '摘要已启用' : '摘要关闭';
      const meta = provider === 'off' ? '未启用' : `${providerLabel} · ${summaryOn}`;
      document.querySelectorAll('[data-notify-summary]').forEach(el => { el.textContent = meta; });
    }

    const savedOnNotifyConfig = _onNotifyConfig;
    _onNotifyConfig = (config) => {
      currentNotifyConfig = config;
      providerSelect.value = config.provider || 'off';
      renderFields(config.provider || 'off');
      if (savedOnNotifyConfig) savedOnNotifyConfig(config);
    };

    const savedOnNotifyTestResult = _onNotifyTestResult;
    _onNotifyTestResult = (msg) => {
      showStatus(msg.message, msg.success ? 'success' : 'error');
      if (savedOnNotifyTestResult) savedOnNotifyTestResult(msg);
    };

    providerSelect.addEventListener('change', () => renderFields(providerSelect.value));

    testBtn.addEventListener('click', () => {
      const config = collectConfig();
      send({ type: 'save_notify_config', config });
      showStatus('正在发送测试消息...', '');
      send({ type: 'test_notify' });
    });

    saveBtn.addEventListener('click', () => {
      const config = collectConfig();
      send({ type: 'save_notify_config', config });
      refreshParentSummary(config);
      showStatus('已保存', 'success');
    });

    const closeSubpage = () => {
      _onNotifyConfig = savedOnNotifyConfig;
      _onNotifyTestResult = savedOnNotifyTestResult;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    panel.querySelector('.settings-back').addEventListener('click', closeSubpage);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSubpage(); });
  }

  function openDevSettingsSubpage() {
    send({ type: 'get_dev_config' });
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay settings-subpage-overlay';
    overlay.id = 'dev-settings-subpage';
    const panel = document.createElement('div');
    panel.className = 'settings-panel';
    panel.innerHTML = `
      <div class="settings-header">
        <h3>开发者设置</h3>
        <button class="settings-close" id="dev-close">&times;</button>
      </div>
      <div class="settings-section-title">GitHub</div>
      <div class="settings-field">
        <label>Token</label>
        <input type="text" id="dev-github-token" placeholder="ghp_..." value="">
      </div>
      <div id="dev-github-repos"></div>
      <div class="settings-actions" style="margin-top:0;gap:8px">
        <button class="btn-test" id="dev-repo-add" style="padding:4px 12px">+ 添加仓库</button>
      </div>
      <div class="settings-divider"></div>
      <div class="settings-section-title">SSH 主机</div>
      <div id="dev-ssh-hosts"></div>
      <div class="settings-actions" style="margin-top:0;gap:8px">
        <button class="btn-test" id="dev-host-add" style="padding:4px 12px">+ 添加主机</button>
      </div>
      <div class="settings-divider"></div>
      <div class="settings-actions">
        <button class="btn-save" id="dev-save-btn">保存开发者配置</button>
      </div>
      <div class="settings-status" id="dev-status"></div>
    `;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    const closeBtn = panel.querySelector('#dev-close');
    closeBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    let editingRepos = [];
    let editingHosts = [];

    function renderRepos() {
      const container = panel.querySelector('#dev-github-repos');
      if (editingRepos.length === 0) {
        container.innerHTML = '<div class="settings-inline-note">暂无仓库</div>';
        return;
      }
      container.innerHTML = editingRepos.map((repo, i) => `
        <div class="settings-field" style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>${escapeHtml(repo.name || '未命名')}</strong>
            <div style="display:flex;gap:4px">
              <button class="btn-test" data-repo-edit="${i}" style="padding:2px 8px">编辑</button>
              <button class="btn-test" data-repo-del="${i}" style="padding:2px 8px">删除</button>
            </div>
          </div>
          <div style="font-size:0.85em;color:var(--text-secondary);margin-top:4px">${escapeHtml(repo.url || '')} · ${escapeHtml(repo.branch || 'main')}${repo.notes ? ' · ' + escapeHtml(repo.notes) : ''}</div>
        </div>
      `).join('');
      container.querySelectorAll('[data-repo-edit]').forEach(btn => {
        btn.addEventListener('click', () => openRepoEditModal(parseInt(btn.dataset.repoEdit)));
      });
      container.querySelectorAll('[data-repo-del]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.repoDel);
          editingRepos.splice(idx, 1);
          renderRepos();
        });
      });
    }

    function openRepoEditModal(index = -1) {
      const existing = index >= 0 ? editingRepos[index] : null;
      const draft = existing || { id: '', name: '', url: '', branch: 'main', notes: '' };
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10002';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '440px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>${existing ? '编辑仓库' : '添加仓库'}</h3>
          <button class="settings-close" id="repo-modal-close">&times;</button>
        </div>
        <div class="settings-field"><label>名称</label><input type="text" id="repo-name" placeholder="cc-web" value="${escapeHtml(draft.name)}"></div>
        <div class="settings-field"><label>URL</label><input type="text" id="repo-url" placeholder="https://github.com/user/repo" value="${escapeHtml(draft.url)}"></div>
        <div class="settings-field"><label>分支</label><input type="text" id="repo-branch" placeholder="main" value="${escapeHtml(draft.branch || 'main')}"></div>
        <div class="settings-field"><label>备注</label><input type="text" id="repo-notes" placeholder="说明" value="${escapeHtml(draft.notes || '')}"></div>
        <div class="settings-actions"><button class="btn-save" id="repo-modal-ok">确定</button></div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#repo-modal-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#repo-modal-ok').addEventListener('click', () => {
        const name = modal.querySelector('#repo-name').value.trim();
        const url = modal.querySelector('#repo-url').value.trim();
        if (!name || !url) { appAlert('请填写名称和 URL'); return; }
        const data = {
          id: draft.id || '',
          name,
          url,
          branch: modal.querySelector('#repo-branch').value.trim() || 'main',
          notes: modal.querySelector('#repo-notes').value.trim(),
        };
        if (existing) {
          editingRepos[index] = data;
        } else {
          editingRepos.push(data);
        }
        closeModal();
        renderRepos();
      });
    }

    function renderHosts() {
      const container = panel.querySelector('#dev-ssh-hosts');
      if (editingHosts.length === 0) {
        container.innerHTML = '<div class="settings-inline-note">暂无 SSH 主机</div>';
        return;
      }
      container.innerHTML = editingHosts.map((host, i) => `
        <div class="settings-field" style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>${escapeHtml(host.name || '未命名')}</strong>
            <div style="display:flex;gap:4px">
              <button class="btn-test" data-host-edit="${i}" style="padding:2px 8px">编辑</button>
              <button class="btn-test" data-host-del="${i}" style="padding:2px 8px">删除</button>
            </div>
          </div>
          <div style="font-size:0.85em;color:var(--text-secondary);margin-top:4px">${escapeHtml(host.user || '')}@${escapeHtml(host.host || '')}:${host.port || 22} · ${(host.authType || 'key') === 'password' ? '密码认证' : '密钥认证'}${host.description ? ' · ' + escapeHtml(host.description) : ''}</div>
        </div>
      `).join('');
      container.querySelectorAll('[data-host-edit]').forEach(btn => {
        btn.addEventListener('click', () => openHostEditModal(parseInt(btn.dataset.hostEdit)));
      });
      container.querySelectorAll('[data-host-del]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.hostDel);
          editingHosts.splice(idx, 1);
          renderHosts();
        });
      });
    }

    function openHostEditModal(index = -1) {
      const existing = index >= 0 ? editingHosts[index] : null;
      const draft = existing || { id: '', name: '', host: '', port: 22, user: '', authType: 'key', identityFile: '', password: '', description: '' };
      const isKey = (draft.authType || 'key') === 'key';
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10002';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '440px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>${existing ? '编辑主机' : '添加主机'}</h3>
          <button class="settings-close" id="host-modal-close">&times;</button>
        </div>
        <div class="settings-field"><label>名称</label><input type="text" id="host-name" placeholder="主机01" value="${escapeHtml(draft.name)}"></div>
        <div class="settings-field"><label>地址</label><input type="text" id="host-host" placeholder="192.168.1.100" value="${escapeHtml(draft.host)}"></div>
        <div class="settings-field"><label>端口</label><input type="number" id="host-port" placeholder="22" value="${draft.port || 22}"></div>
        <div class="settings-field"><label>用户</label><input type="text" id="host-user" placeholder="root" value="${escapeHtml(draft.user)}"></div>
        <div class="settings-field">
          <label>认证方式</label>
          <div style="display:flex;gap:12px">
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer"><input type="radio" name="host-auth-type" value="key" ${isKey ? 'checked' : ''}> 密钥</label>
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer"><input type="radio" name="host-auth-type" value="password" ${!isKey ? 'checked' : ''}> 密码</label>
          </div>
        </div>
        <div id="host-auth-key-field" class="settings-field" style="${isKey ? '' : 'display:none'}">
          <label>密钥路径</label><input type="text" id="host-identity" placeholder="~/.ssh/id_ed25519" value="${escapeHtml(draft.identityFile)}">
        </div>
        <div id="host-auth-pw-field" class="settings-field" style="${!isKey ? '' : 'display:none'}">
          <label>密码</label><input type="password" id="host-password" placeholder="SSH 登录密码" value="${escapeHtml(draft.password || '')}">
        </div>
        <div class="settings-field"><label>说明</label><input type="text" id="host-desc" placeholder="测试服务器" value="${escapeHtml(draft.description || '')}"></div>
        <div class="settings-actions"><button class="btn-save" id="host-modal-ok">确定</button></div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);

      // Toggle auth fields
      const keyField = modal.querySelector('#host-auth-key-field');
      const pwField = modal.querySelector('#host-auth-pw-field');
      modal.querySelectorAll('input[name="host-auth-type"]').forEach(radio => {
        radio.addEventListener('change', () => {
          const isKeyMode = radio.value === 'key' && radio.checked;
          keyField.style.display = isKeyMode ? '' : 'none';
          pwField.style.display = isKeyMode ? 'none' : '';
        });
      });

      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#host-modal-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#host-modal-ok').addEventListener('click', () => {
        const name = modal.querySelector('#host-name').value.trim();
        const host = modal.querySelector('#host-host').value.trim();
        if (!name || !host) { appAlert('请填写名称和地址'); return; }
        const authType = modal.querySelector('input[name="host-auth-type"]:checked')?.value || 'key';
        const data = {
          id: draft.id || '',
          name,
          host,
          port: parseInt(modal.querySelector('#host-port').value) || 22,
          user: modal.querySelector('#host-user').value.trim(),
          authType,
          identityFile: authType === 'key' ? modal.querySelector('#host-identity').value.trim() : '',
          password: authType === 'password' ? modal.querySelector('#host-password').value : '',
          description: modal.querySelector('#host-desc').value.trim(),
        };
        if (existing) {
          editingHosts[index] = data;
        } else {
          editingHosts.push(data);
        }
        closeModal();
        renderHosts();
      });
    }

    panel.querySelector('#dev-repo-add').addEventListener('click', () => openRepoEditModal());
    panel.querySelector('#dev-host-add').addEventListener('click', () => openHostEditModal());

    panel.querySelector('#dev-save-btn').addEventListener('click', () => {
      const token = panel.querySelector('#dev-github-token').value.trim();
      send({
        type: 'save_dev_config',
        config: {
          github: { token, repos: editingRepos },
          ssh: { hosts: editingHosts },
        },
      });
      panel.querySelector('#dev-status').textContent = '已保存';
      panel.querySelector('#dev-status').className = 'settings-status success';
    });

    _onDevConfig = (config) => {
      panel.querySelector('#dev-github-token').value = config.github?.token || '';
      editingRepos = (config.github?.repos || []).map(r => ({ ...r }));
      editingHosts = (config.ssh?.hosts || []).map(h => ({ ...h }));
      renderRepos();
      renderHosts();
    };
  }

  function openThemeSubpage() {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay settings-subpage-overlay';
    overlay.style.zIndex = '10001';

    const panel = document.createElement('div');
    panel.className = 'settings-panel settings-subpage-panel';
    panel.innerHTML = `
      <div class="settings-header settings-subpage-header">
        <button class="settings-back" type="button" aria-label="返回">‹</button>
        <div class="settings-subpage-copy">
          <div class="settings-subpage-kicker">Appearance</div>
          <h3>界面主题</h3>
        </div>
        <button class="settings-close" type="button" title="关闭">&times;</button>
      </div>
      ${buildThemePickerHtml({ showSectionTitle: false })}
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    mountThemePicker(panel);
    refreshThemeSummaries();

    const closeSubpage = () => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    panel.querySelector('.settings-back').addEventListener('click', closeSubpage);
    panel.querySelector('.settings-close').addEventListener('click', closeSubpage);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeSubpage();
    });
  }

  function getAgentSessionStorageKey(agent) {
    return `cc-web-session-${normalizeAgent(agent)}`;
  }

  function getAgentModeStorageKey(agent) {
    return `cc-web-mode-${normalizeAgent(agent)}`;
  }

  function getLastSessionForAgent(agent) {
    return localStorage.getItem(getAgentSessionStorageKey(agent));
  }

  function setLastSessionForAgent(agent, sessionId) {
    localStorage.setItem(getAgentSessionStorageKey(agent), sessionId);
    localStorage.setItem('cc-web-session', sessionId);
  }

  function getSessionMeta(sessionId) {
    return sessions.find((s) => s.id === sessionId) || null;
  }

  function deepClone(value) {
    if (value === null || value === undefined) return value;
    return JSON.parse(JSON.stringify(value));
  }

  // ============ App Modal API (REDESIGN-1) ============
  // Replaces native alert/confirm/prompt — those break washi theme, freeze
  // animations, show OS-system fonts/English buttons on iOS. This API reuses
  // existing .modal-overlay / .modal-panel / .modal-btn-primary / .modal-text-input
  // CSS so it inherits all 3 themes (washi/coolvibe/editorial) automatically.
  // Returns Promise<undefined|boolean|string|null>:
  //   alert   → undefined on dismiss
  //   confirm → true (OK) / false (cancel/Esc/outside-click)
  //   prompt  → string value (OK) / null (cancel/Esc/outside-click)
  function appModal({ type = 'alert', message = '', defaultValue = '', okText, cancelText } = {}) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay app-modal-overlay';
      const finalOkText = okText || (type === 'confirm' ? '确定' : '好');
      const finalCancelText = cancelText || '取消';
      const showCancel = type !== 'alert';
      overlay.innerHTML = `
        <div class="modal-panel app-modal-panel" role="dialog" aria-modal="true">
          <div class="app-modal-message"></div>
          ${type === 'prompt' ? '<input class="modal-text-input app-modal-prompt-input" autocomplete="off">' : ''}
          <div class="app-modal-footer">
            ${showCancel ? `<button class="modal-btn-secondary" data-act="cancel">${escapeHtml(finalCancelText)}</button>` : ''}
            <button class="modal-btn-primary" data-act="ok">${escapeHtml(finalOkText)}</button>
          </div>
        </div>`;
      // textContent assignment preserves \n + avoids XSS
      overlay.querySelector('.app-modal-message').textContent = message;
      const input = overlay.querySelector('.app-modal-prompt-input');
      if (input) input.value = defaultValue;
      let resolved = false;
      const close = (val) => {
        if (resolved) return;
        resolved = true;
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close(type === 'alert' ? undefined : (type === 'confirm' ? false : null));
        } else if (e.key === 'Enter' && document.activeElement !== input) {
          // Enter on the panel (not inside textarea/multiline) → OK
          e.preventDefault();
          close(type === 'alert' ? undefined : (type === 'confirm' ? true : (input ? input.value : undefined)));
        } else if (e.key === 'Enter' && input && document.activeElement === input) {
          e.preventDefault();
          close(input.value);
        }
      };
      overlay.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'ok') {
          close(type === 'alert' ? undefined : (type === 'confirm' ? true : input.value));
        } else if (act === 'cancel') {
          close(type === 'confirm' ? false : null);
        } else if (e.target === overlay) {
          // click on backdrop = cancel
          close(type === 'alert' ? undefined : (type === 'confirm' ? false : null));
        }
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
      setTimeout(() => { (input || overlay.querySelector('.modal-btn-primary')).focus(); if (input) input.select(); }, 0);
    });
  }
  const appAlert = (msg, opts) => appModal({ type: 'alert', message: msg, ...(opts || {}) });
  const appConfirm = (msg, opts) => appModal({ type: 'confirm', message: msg, ...(opts || {}) });
  const appPrompt = (msg, def = '', opts) => appModal({ type: 'prompt', message: msg, defaultValue: def, ...(opts || {}) });

  // R23: Keyboard shortcuts help dialog (WCAG 3.3.5 Help, ARIA APG dialog)
  let kbdHelpOverlay = null;
  function openKbdHelp() {
    if (kbdHelpOverlay) return;
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay app-modal-overlay';
    overlay.innerHTML = `
      <div class="modal-panel app-modal-panel" role="dialog" aria-modal="true" aria-labelledby="kbd-help-title">
        <h2 id="kbd-help-title" class="kbd-help-title">键盘快捷键</h2>
        <dl class="kbd-help-list">
          <dt><kbd>Esc</kbd></dt>          <dd>关闭弹层 / 菜单 / 模态框</dd>
          <dt><kbd>Enter</kbd></dt>        <dd>发送消息（输入框内）</dd>
          <dt><kbd>Shift</kbd>+<kbd>Enter</kbd></dt><dd>换行</dd>
          <dt><kbd>/</kbd></dt>            <dd>打开斜杠指令菜单</dd>
          <dt><kbd>↑</kbd> <kbd>↓</kbd></dt><dd>指令菜单 / 自动补全导航</dd>
          <dt><kbd>Tab</kbd></dt>          <dd>遍历所有可交互元素 / 指令菜单选中</dd>
          <dt><kbd>Enter</kbd> / <kbd>Space</kbd></dt><dd>激活当前会话条目</dd>
          <dt><kbd>?</kbd></dt>            <dd>打开本帮助</dd>
        </dl>
        <p class="kbd-help-tip">提示：在输入框内输入 <kbd>?</kbd> 字符不会触发本帮助。</p>
        <div class="app-modal-footer">
          <button class="modal-btn-primary" data-act="ok">关闭</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    kbdHelpOverlay = overlay;
    const closeBtn = overlay.querySelector('[data-act="ok"]');
    closeBtn.focus();
    const close = () => {
      if (!kbdHelpOverlay) return;
      kbdHelpOverlay.remove();
      kbdHelpOverlay = null;
      document.removeEventListener('keydown', onKey, true);
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    };
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    document.addEventListener('keydown', onKey, true);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== '?') return;
    const ae = document.activeElement;
    if (!ae) return;
    const tag = ae.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable) return;
    e.preventDefault();
    openKbdHelp();
  });

  // R28 / C5: Custom listbox replacing native <select>. Keeps the original
  // <select> hidden as the form's source-of-truth (preserves .value reads,
  // 'change' event listeners, and option lists). The visible UI is a button
  // + role=listbox dropdown that's fully theme-able and keyboard-navigable.
  function enhanceSelect(select) {
    if (!select || select.dataset.csEnhanced === '1') return;
    select.dataset.csEnhanced = '1';
    select.classList.add('cs-native');
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;

    const wrap = document.createElement('div');
    wrap.className = 'cs-wrap';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cs-btn settings-select';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    const labelSpan = document.createElement('span');
    labelSpan.className = 'cs-btn-label';
    btn.appendChild(labelSpan);
    if (select.style.cssText) btn.style.cssText = select.style.cssText;
    const list = document.createElement('ul');
    list.className = 'cs-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;

    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(btn);
    wrap.appendChild(list);
    wrap.appendChild(select);

    function refreshLabel() {
      const opt = select.options[select.selectedIndex];
      labelSpan.textContent = opt ? opt.textContent : '';
      btn.disabled = select.disabled;
    }
    function rebuildList() {
      list.innerHTML = '';
      Array.from(select.options).forEach((opt) => {
        const li = document.createElement('li');
        li.className = 'cs-option';
        li.setAttribute('role', 'option');
        li.dataset.value = opt.value;
        li.textContent = opt.textContent;
        li.tabIndex = -1;
        li.setAttribute('aria-selected', String(opt.selected));
        if (opt.selected) li.classList.add('cs-option-active');
        if (opt.disabled) { li.setAttribute('aria-disabled', 'true'); li.classList.add('cs-option-disabled'); }
        list.appendChild(li);
      });
    }
    rebuildList();
    refreshLabel();

    let outsideClickHandler = null;
    function open() {
      if (!list.hidden || select.disabled) return;
      rebuildList();
      list.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      const focusEl = list.querySelector('.cs-option-active') || list.firstElementChild;
      if (focusEl) focusEl.focus();
      outsideClickHandler = (e) => { if (!wrap.contains(e.target)) close(); };
      setTimeout(() => document.addEventListener('click', outsideClickHandler, true), 0);
    }
    function close(returnFocus) {
      if (list.hidden) return;
      list.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      if (outsideClickHandler) {
        document.removeEventListener('click', outsideClickHandler, true);
        outsideClickHandler = null;
      }
      if (returnFocus) btn.focus();
    }
    function commit(value) {
      if (select.value === value) { close(true); return; }
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      refreshLabel();
      close(true);
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (list.hidden) open(); else close(true);
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault(); open();
      }
    });
    list.addEventListener('click', (e) => {
      const li = e.target.closest('.cs-option');
      if (!li || li.classList.contains('cs-option-disabled')) return;
      commit(li.dataset.value);
    });
    list.addEventListener('keydown', (e) => {
      const cur = document.activeElement;
      if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
      if (e.key === 'Tab') { close(false); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        let next = cur && cur.nextElementSibling;
        while (next && next.classList.contains('cs-option-disabled')) next = next.nextElementSibling;
        (next || list.firstElementChild)?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        let prev = cur && cur.previousElementSibling;
        while (prev && prev.classList.contains('cs-option-disabled')) prev = prev.previousElementSibling;
        (prev || list.lastElementChild)?.focus();
      } else if (e.key === 'Home') {
        e.preventDefault(); list.firstElementChild?.focus();
      } else if (e.key === 'End') {
        e.preventDefault(); list.lastElementChild?.focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const li = cur?.closest('.cs-option');
        if (li && !li.classList.contains('cs-option-disabled')) commit(li.dataset.value);
      }
    });

    // Watch native select for external mutations (option list rebuilds, programmatic value)
    const obs = new MutationObserver(() => { rebuildList(); refreshLabel(); });
    obs.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'value'] });
    select.addEventListener('change', refreshLabel);
  }

  // Auto-enhance any .settings-select that appears in the DOM (settings panel
  // is rebuilt dynamically when entering different tabs).
  const csObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (node.matches?.('select.settings-select')) enhanceSelect(node);
        node.querySelectorAll?.('select.settings-select').forEach(enhanceSelect);
      });
    }
  });
  csObserver.observe(document.body, { childList: true, subtree: true });
  // Catch any selects already in DOM at boot
  document.querySelectorAll('select.settings-select').forEach(enhanceSelect);

  function cloneMessages(messages) {
    return Array.isArray(messages) ? deepClone(messages) : [];
  }

  function estimateSessionMessageWeight(message) {
    const content = typeof message?.content === 'string' ? message.content.length : JSON.stringify(message?.content || '').length;
    const toolCalls = Array.isArray(message?.toolCalls) ? JSON.stringify(message.toolCalls).length : 0;
    return content + toolCalls + 64;
  }

  function estimateSessionSnapshotWeight(snapshot) {
    const base = JSON.stringify({
      title: snapshot.title || '',
      mode: snapshot.mode || '',
      model: snapshot.model || '',
      agent: snapshot.agent || '',
      cwd: snapshot.cwd || '',
      updated: snapshot.updated || '',
    }).length;
    return base + (snapshot.messages || []).reduce((sum, message) => sum + estimateSessionMessageWeight(message), 0);
  }

  function normalizeSessionSnapshot(payload, options = {}) {
    return {
      sessionId: payload.sessionId,
      messages: cloneMessages(payload.messages || []),
      title: payload.title || '新会话',
      mode: payload.mode || 'yolo',
      model: payload.model || '',
      agent: normalizeAgent(payload.agent),
      hasUnread: !!payload.hasUnread,
      cwd: payload.cwd || null,
      totalCost: typeof payload.totalCost === 'number' ? payload.totalCost : 0,
      totalUsage: payload.totalUsage ? deepClone(payload.totalUsage) : null,
      updated: payload.updated || null,
      isRunning: !!payload.isRunning,
      historyPending: !!payload.historyPending,
      complete: options.complete !== undefined ? !!options.complete : !payload.historyPending,
    };
  }

  function touchSessionCache(sessionId) {
    const entry = sessionCache.get(sessionId);
    if (entry) entry.lastUsed = Date.now();
  }

  function invalidateSessionCache(sessionId) {
    if (!sessionId) return;
    sessionCache.delete(sessionId);
  }

  function pruneSessionCache() {
    let totalWeight = 0;
    for (const entry of sessionCache.values()) totalWeight += entry.weight || 0;
    while (sessionCache.size > SESSION_CACHE_LIMIT || totalWeight > SESSION_CACHE_MAX_WEIGHT) {
      let oldestId = null;
      let oldestTs = Infinity;
      for (const [sessionId, entry] of sessionCache) {
        if ((entry.lastUsed || 0) < oldestTs) {
          oldestTs = entry.lastUsed || 0;
          oldestId = sessionId;
        }
      }
      if (!oldestId) break;
      totalWeight -= sessionCache.get(oldestId)?.weight || 0;
      sessionCache.delete(oldestId);
    }
  }

  function cacheSessionSnapshot(snapshot) {
    if (!snapshot?.sessionId || !snapshot.complete) return;
    const cachedSnapshot = deepClone(snapshot);
    const weight = estimateSessionSnapshotWeight(cachedSnapshot);
    if (weight > SESSION_CACHE_MAX_WEIGHT) {
      invalidateSessionCache(cachedSnapshot.sessionId);
      return;
    }
    const meta = getSessionMeta(cachedSnapshot.sessionId);
    sessionCache.set(cachedSnapshot.sessionId, {
      snapshot: cachedSnapshot,
      version: cachedSnapshot.updated || null,
      meta: meta ? deepClone(meta) : null,
      weight,
      lastUsed: Date.now(),
    });
    pruneSessionCache();
  }

  function updateCachedSession(sessionId, updater) {
    const entry = sessionCache.get(sessionId);
    if (!entry) return;
    const nextSnapshot = deepClone(entry.snapshot);
    updater(nextSnapshot);
    entry.snapshot = nextSnapshot;
    entry.weight = estimateSessionSnapshotWeight(nextSnapshot);
    entry.lastUsed = Date.now();
    if (nextSnapshot.updated) entry.version = nextSnapshot.updated;
    pruneSessionCache();
  }

  function reconcileSessionCacheWithSessions() {
    const knownIds = new Set(sessions.map((session) => session.id));
    for (const [sessionId, entry] of sessionCache) {
      if (!knownIds.has(sessionId)) {
        sessionCache.delete(sessionId);
        continue;
      }
      const meta = getSessionMeta(sessionId);
      entry.meta = meta ? deepClone(meta) : null;
    }
  }

  function getSessionCacheDisposition(sessionId) {
    const entry = sessionCache.get(sessionId);
    const meta = getSessionMeta(sessionId);
    if (!entry?.snapshot?.complete || !meta) return 'miss';
    if (entry.version === (meta.updated || null) && !meta.hasUnread && !meta.isRunning) {
      return 'strong';
    }
    return 'weak';
  }

  function buildCachedSessionSnapshot(sessionId) {
    const entry = sessionCache.get(sessionId);
    if (!entry?.snapshot) return null;
    const snapshot = deepClone(entry.snapshot);
    const meta = getSessionMeta(sessionId) || entry.meta;
    if (meta) {
      snapshot.title = meta.title || snapshot.title;
      snapshot.agent = normalizeAgent(meta.agent || snapshot.agent);
      snapshot.hasUnread = !!meta.hasUnread;
      snapshot.updated = meta.updated || snapshot.updated;
      snapshot.isRunning = !!meta.isRunning;
    }
    return snapshot;
  }

  function formatFileSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size}B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
    return `${(size / (1024 * 1024)).toFixed(1)}MB`;
  }

  function syncAttachmentActions() {
    const uploading = uploadingAttachments.length > 0;
    if (attachBtn) attachBtn.disabled = uploading;
  }

  function replaceFileExtension(filename, ext) {
    const base = String(filename || 'image').replace(/\.[^/.]+$/, '');
    return `${base}${ext}`;
  }

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('读取图片失败'));
      };
      img.src = url;
    });
  }

  async function compressImageFile(file) {
    if (!file || !/^image\/(png|jpeg|webp)$/i.test(file.type || '')) return file;
    const img = await loadImageFromFile(file);
    const maxDimension = 2000;
    const maxOriginalBytes = 2 * 1024 * 1024;
    const largestSide = Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height);
    if (file.size <= maxOriginalBytes && largestSide <= maxDimension) {
      return file;
    }

    const scale = Math.min(1, maxDimension / largestSide);
    const width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
    const height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, width, height);

    const targetType = 'image/webp';
    const qualities = [0.9, 0.84, 0.78, 0.72];
    let bestBlob = null;
    for (const quality of qualities) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, targetType, quality));
      if (!blob) continue;
      if (!bestBlob || blob.size < bestBlob.size) bestBlob = blob;
      if (blob.size <= Math.max(maxOriginalBytes, file.size * 0.72)) break;
    }
    if (!bestBlob || bestBlob.size >= file.size) return file;
    return new File([bestBlob], replaceFileExtension(file.name || 'image', '.webp'), {
      type: bestBlob.type,
      lastModified: Date.now(),
    });
  }

  async function deleteUploadedAttachment(id) {
    if (!id) return;
    try {
      await ensureAuthenticatedWs();
      await fetch(`/api/attachments/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
    } catch {}
  }

  function ensureAuthenticatedWs() {
    return new Promise((resolve, reject) => {
      if (ws && ws.readyState === 1 && authToken) {
        resolve(authToken);
        return;
      }
      const savedPassword = localStorage.getItem('cc-web-pw');
      if (!savedPassword) {
        reject(new Error('登录状态已失效，请刷新页面后重新登录再上传图片。'));
        return;
      }
      const timeout = setTimeout(() => {
        reject(new Error('登录状态恢复超时，请刷新页面后重试。'));
      }, 8000);

      const cleanup = () => {
        clearTimeout(timeout);
        document.removeEventListener('cc-web-auth-restored', onRestored);
        document.removeEventListener('cc-web-auth-failed', onFailed);
      };
      const onRestored = () => {
        cleanup();
        resolve(authToken);
      };
      const onFailed = () => {
        cleanup();
        reject(new Error('登录状态已失效，请刷新页面后重新登录再上传图片。'));
      };
      document.addEventListener('cc-web-auth-restored', onRestored);
      document.addEventListener('cc-web-auth-failed', onFailed);

      if (!ws || ws.readyState > 1) {
        connect();
      } else if (ws.readyState === 1) {
        send({ type: 'auth', password: savedPassword });
      }
    });
  }

  function renderAttachmentLabels(attachments, options = {}) {
    if (!Array.isArray(attachments) || attachments.length === 0) return '';
    const labels = attachments.map((attachment) => {
      const stateSuffix = attachment.storageState === 'expired' ? '（已过期）' : '';
      const name = escapeHtml(attachment.filename || 'image');
      return `<span class="msg-attachment-label">图片: ${name}${stateSuffix}</span>`;
    }).join('');
    return `<div class="msg-attachments${options.compact ? ' compact' : ''}">${labels}</div>`;
  }

  function renderPendingAttachments() {
    if (!attachmentTray) return;
    if (!pendingAttachments.length && !uploadingAttachments.length) {
      attachmentTray.hidden = true;
      attachmentTray.innerHTML = '';
      syncAttachmentActions();
      return;
    }
    attachmentTray.hidden = false;
    const uploadingHtml = uploadingAttachments.map((attachment) => `
      <div class="attachment-chip uploading">
        <div class="attachment-chip-meta">
          <span class="attachment-chip-name">${escapeHtml(attachment.filename || 'image')}</span>
          <span class="attachment-chip-note">上传中 · ${formatFileSize(attachment.size)}</span>
        </div>
      </div>
    `).join('');
    const readyHtml = pendingAttachments.map((attachment, index) => `
      <div class="attachment-chip" data-index="${index}">
        <div class="attachment-chip-meta">
          <span class="attachment-chip-name">${escapeHtml(attachment.filename || 'image')}</span>
          <span class="attachment-chip-note">${formatFileSize(attachment.size)} · 将随下一条消息发送</span>
        </div>
        <button class="attachment-chip-remove" type="button" data-index="${index}" title="移除">✕</button>
      </div>
    `).join('');
    const noteHtml = [
      uploadingAttachments.length > 0
        ? '<div class="attachment-tray-note">图片上传中，此时发送不会包含尚未完成的图片。</div>'
        : '',
    ].join('');
    attachmentTray.innerHTML = `${uploadingHtml}${readyHtml}${noteHtml}`;
    attachmentTray.querySelectorAll('.attachment-chip-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = Number(btn.dataset.index);
        const [removed] = pendingAttachments.splice(index, 1);
        renderPendingAttachments();
        deleteUploadedAttachment(removed?.id);
      });
    });
    syncAttachmentActions();
  }

  async function uploadImageFile(file) {
    await ensureAuthenticatedWs();
    const headers = {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': file.type || 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name || 'image'),
    };
    const response = await fetch('/api/attachments', {
      method: 'POST',
      headers,
      body: file,
    });
    const rawText = await response.text();
    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      data = null;
    }
    if (response.status === 401) {
      throw new Error('登录状态已失效，请刷新页面后重新登录再上传图片。');
    }
    if (response.status === 413) {
      throw new Error('图片大小超过当前上传限制，请压缩到 10MB 以内后重试。');
    }
    if (!response.ok || !data?.ok) {
      throw new Error(data?.message || `上传失败 (${response.status})`);
    }
    return data.attachment;
  }

  async function handleSelectedImageFiles(fileList) {
    const files = Array.from(fileList || []).filter((file) => file && /^image\//.test(file.type || ''));
    if (!files.length) return;
    if (pendingAttachments.length + files.length > 4) {
      appendError('单条消息最多附带 4 张图片。');
      return;
    }
    const batch = files.map((file, index) => ({
      id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      filename: file.name || 'image',
      size: file.size || 0,
    }));
    uploadingAttachments.push(...batch);
    renderPendingAttachments();
    try {
      const results = await Promise.allSettled(files.map(async (file) => {
        const optimized = await compressImageFile(file);
        return uploadImageFile(optimized);
      }));
      const errors = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          pendingAttachments.push(result.value);
        } else {
          errors.push(result.reason?.message || '图片上传失败');
        }
      }
      if (errors.length > 0) {
        appendError(errors[0]);
      }
    } catch (err) {
      appendError(err.message || '图片上传失败');
    } finally {
      uploadingAttachments = uploadingAttachments.filter((item) => !batch.some((entry) => entry.id === item.id));
      renderPendingAttachments();
      if (imageUploadInput) imageUploadInput.value = '';
    }
  }

  function getVisibleSessions() {
    return sessions.filter((s) => normalizeAgent(s.agent) === currentAgent);
  }

  function shouldOverlayRuntimeBadge() {
    return window.matchMedia('(max-width: 768px), (pointer: coarse)').matches;
  }

  function updateCwdBadge() {
    if (!chatCwd) return;
    if (currentCwd) {
      const parts = currentCwd.replace(/\/+$/, '').split('/');
      const short = parts.slice(-2).join('/') || currentCwd;
      chatCwd.textContent = '~/' + short;
      chatCwd.title = currentCwd;
    } else {
      chatCwd.textContent = '';
      chatCwd.title = '';
    }
    chatCwd.hidden = !currentCwd || (currentSessionRunning && shouldOverlayRuntimeBadge());
  }

  function setCurrentSessionRunningState(isRunning) {
    const running = !!isRunning;
    currentSessionRunning = running;
    if (chatRuntimeState) {
      chatRuntimeState.hidden = !running;
      chatRuntimeState.textContent = running ? '运行中' : '';
    }
    updateCwdBadge();
  }

  function updateAgentScopedUI() {
    if (chatAgentBtn) {
      chatAgentBtn.textContent = AGENT_LABELS[currentAgent];
      chatAgentBtn.setAttribute('aria-expanded', chatAgentMenu && !chatAgentMenu.hidden ? 'true' : 'false');
    }
    if (chatAgentMenu) {
      chatAgentMenu.querySelectorAll('.chat-agent-option').forEach((btn) => {
        const active = btn.dataset.agent === currentAgent;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }
    if (importSessionBtn) {
      importSessionBtn.textContent = currentAgent === 'codex' ? '导入本地 Codex 会话' : '导入本地 Claude 会话';
    }
  }

  function setCurrentAgent(agent) {
    currentAgent = normalizeAgent(agent);
    localStorage.setItem('cc-web-agent', currentAgent);
    currentMode = localStorage.getItem(getAgentModeStorageKey(currentAgent)) || 'yolo';
    setModeSelectUI(currentMode);
    updateAgentScopedUI();
  }

  function closeAgentMenu() {
    if (!chatAgentMenu) return;
    chatAgentMenu.hidden = true;
    if (chatAgentBtn) chatAgentBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleAgentMenu() {
    if (!chatAgentMenu || !chatAgentBtn) return;
    const willOpen = chatAgentMenu.hidden;
    chatAgentMenu.hidden = !willOpen;
    chatAgentBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  }

  function resetChatView(agent) {
    setCurrentAgent(agent);
    currentSessionId = null;
    loadedHistorySessionId = null;
    clearSessionLoading();
    setCurrentSessionRunningState(false);
    currentCwd = null;
    currentModel = currentAgent === 'claude' ? 'opus' : '';
    isGenerating = false;
    pendingText = '';
    pendingAttachments = [];
    uploadingAttachments = [];
    activeToolCalls.clear();
    sendBtn.hidden = false;
    abortBtn.hidden = true;
    chatTitle.textContent = '新会话';
    updateCwdBadge();
    messagesDiv.innerHTML = buildWelcomeMarkup(currentAgent);
    setStatsDisplay(null);
    // R48: clear ctx-meter state on view reset so stale per-turn data from a
    // previous session doesn't bleed into the new one (R47 introduced
    // hydration but never cleared it).
    lastUsageDetail = null;
    if (ctxMeter) { ctxMeter.hidden = true; delete ctxMeter.dataset.level; ctxMeter.style.removeProperty('--ctx-pct'); }
    if (ctxPopover) ctxPopover.hidden = true;
    renderPendingAttachments();
    highlightActiveSession();
  }

  function applySessionSnapshot(snapshot, options = {}) {
    if (!snapshot) return;
    const preserveStreaming = !!(options.preserveStreaming && isGenerating && snapshot.sessionId === currentSessionId && snapshot.isRunning);
    if (isGenerating && !preserveStreaming) {
      isGenerating = false;
      sendBtn.hidden = false;
      abortBtn.hidden = true;
      pendingText = '';
      activeToolCalls.clear();
    }
    currentSessionId = snapshot.sessionId;
    loadedHistorySessionId = snapshot.sessionId;
    setLastSessionForAgent(snapshot.agent, currentSessionId);
    chatTitle.textContent = snapshot.title || '新会话';
    setCurrentAgent(snapshot.agent);
    setCurrentSessionRunningState(snapshot.isRunning);
    setStatsDisplay(snapshot);
    currentCwd = snapshot.cwd || null;
    updateCwdBadge();
    if (snapshot.mode && MODE_LABELS[snapshot.mode]) {
      currentMode = snapshot.mode;
      setModeSelectUI(currentMode);
      localStorage.setItem(getAgentModeStorageKey(currentAgent), currentMode);
    }
    currentModel = snapshot.model || '';
    if (!preserveStreaming) {
      renderMessages(snapshot.messages || [], { immediate: !!options.immediate });
    }
    highlightActiveSession();
    renderSessionList();
    if (!options.skipCloseSidebar) closeSidebar();
    if (snapshot.hasUnread && !options.suppressUnreadToast) {
      showToast('后台任务已完成', snapshot.sessionId);
    }
  }

  function syncViewForAgent(agent, options = {}) {
    const targetAgent = normalizeAgent(agent);
    const { preserveCurrent = true, loadLast = true } = options;
    setCurrentAgent(targetAgent);
    renderSessionList();

    const currentMeta = currentSessionId ? getSessionMeta(currentSessionId) : null;
    if (preserveCurrent && currentMeta && normalizeAgent(currentMeta.agent) === targetAgent) {
      highlightActiveSession();
      return;
    }

    if (currentSessionId && (!currentMeta || normalizeAgent(currentMeta.agent) !== targetAgent)) {
      send({ type: 'detach_view' });
    }

    resetChatView(targetAgent);

    if (!loadLast) return;
    const lastSessionId = getLastSessionForAgent(targetAgent);
    const lastMeta = lastSessionId ? getSessionMeta(lastSessionId) : null;
    if (lastMeta && normalizeAgent(lastMeta.agent) === targetAgent) {
      openSession(lastSessionId);
      return;
    }
    // Fallback: if the stored last-session is stale (deleted, renamed, agent
    // mismatch), open the most-recently-updated session for this agent instead.
    const fallback = sessions.find((s) => normalizeAgent(s.agent) === targetAgent);
    if (fallback) {
      openSession(fallback.id);
      return;
    }
    // No session at all for this agent — drop any optimistic boot overlay (R31)
    // so the welcome screen shows immediately instead of an indefinite spinner.
    clearSessionLoading();
  }

  function getSessionLoadLabel(sessionId) {
    const meta = sessionId ? getSessionMeta(sessionId) : null;
    const title = meta?.title ? `“${meta.title}”` : '所选会话';
    return `正在载入 ${title} 的完整消息记录…`;
  }

  function setSessionLoading(sessionId, options = {}) {
    const loading = !!sessionId;
    const blocking = options.blocking !== false;
    activeSessionLoad = loading ? { sessionId, blocking, snapshot: null } : null;
    const showOverlay = !!(loading && blocking);
    document.body.classList.toggle('session-loading-active', showOverlay);
    sessionLoadingOverlay.hidden = !showOverlay;
    sessionLoadingOverlay.setAttribute('aria-hidden', showOverlay ? 'false' : 'true');
    sessionLoadingLabel.textContent = loading ? (options.label || getSessionLoadLabel(sessionId)) : '正在整理消息与上下文…';
    msgInput.disabled = showOverlay;
    modeSelect.disabled = showOverlay;
    modeSelect.toggleAttribute('aria-disabled', showOverlay);
    sendBtn.disabled = showOverlay;
    abortBtn.disabled = showOverlay;
    if (showOverlay && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }

  function clearSessionLoading(sessionId) {
    if (sessionId && activeSessionLoad && activeSessionLoad.sessionId !== sessionId) return;
    setSessionLoading(null, { blocking: false });
  }

  function isBlockingSessionLoad(sessionId) {
    return !!(activeSessionLoad &&
      activeSessionLoad.blocking &&
      (!sessionId || activeSessionLoad.sessionId === sessionId));
  }

  function finishSessionSwitch(sessionId) {
    if (isBlockingSessionLoad(sessionId)) {
      scrollToBottom();
      requestAnimationFrame(() => clearSessionLoading(sessionId));
      return;
    }
    clearSessionLoading(sessionId);
  }

  function finalizeLoadedSession(sessionId) {
    if (activeSessionLoad?.sessionId === sessionId && activeSessionLoad.snapshot) {
      activeSessionLoad.snapshot.complete = true;
      cacheSessionSnapshot(activeSessionLoad.snapshot);
    }
    finishSessionSwitch(sessionId);
  }

  function beginSessionSwitch(sessionId, options = {}) {
    if (!sessionId) return;
    const blocking = options.blocking !== false;
    const force = options.force === true;
    if (!force && activeSessionLoad?.sessionId === sessionId) return;
    if (!force && sessionId === currentSessionId && !activeSessionLoad) return;
    renderEpoch++;
    loadedHistorySessionId = null;
    setSessionLoading(sessionId, { blocking, label: options.label });
    send({ type: 'load_session', sessionId });
  }

  function showCachedSession(sessionId) {
    const snapshot = buildCachedSessionSnapshot(sessionId);
    if (!snapshot) return false;
    if (currentSessionId && currentSessionId !== sessionId) {
      send({ type: 'detach_view' });
    }
    clearSessionLoading();
    touchSessionCache(sessionId);
    applySessionSnapshot(snapshot, { immediate: true, suppressUnreadToast: true });
    return true;
  }

  function openSession(sessionId, options = {}) {
    if (!sessionId) return;
    if (options.forceSync) {
      beginSessionSwitch(sessionId, { blocking: options.blocking !== false, force: true, label: options.label });
      return;
    }
    if (!options.force && sessionId === currentSessionId && !activeSessionLoad) return;

    const disposition = getSessionCacheDisposition(sessionId);
    if (disposition === 'strong') {
      showCachedSession(sessionId);
      return;
    }
    if (disposition === 'weak' && showCachedSession(sessionId)) {
      beginSessionSwitch(sessionId, { blocking: false, force: true, label: options.label });
      return;
    }
    beginSessionSwitch(sessionId, { blocking: options.blocking !== false, force: options.force === true, label: options.label });
  }

  function formatTokens(n) {
    if (!n && n !== 0) return '';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
    if (n >= 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    if (n >= 1000) return (n / 1000).toFixed(2).replace(/\.?0+$/, '') + 'k';
    return String(n);
  }
  function formatStats(totalUsage, totalCost) {
    const parts = [];
    const u = totalUsage;
    if (u && ((u.inputTokens || 0) > 0 || (u.outputTokens || 0) > 0 || (u.cacheCreationTokens || 0) > 0 || (u.cacheReadTokens || 0) > 0)) {
      const seg = [`↓${formatTokens(u.inputTokens || 0)}`];
      // R40: split cache_creation vs cache_read for CLI parity
      if (u.cacheCreationTokens) seg.push(`cc ${formatTokens(u.cacheCreationTokens)}`);
      if (u.cacheReadTokens) seg.push(`cr ${formatTokens(u.cacheReadTokens)}`);
      else if (u.cachedInputTokens && !u.cacheReadTokens && !u.cacheCreationTokens) {
        // Backward compat for sessions persisted before R40 split
        seg.push(`cache ${formatTokens(u.cachedInputTokens)}`);
      }
      seg.push(`↑${formatTokens(u.outputTokens || 0)}`);
      parts.push(seg.join(' · '));
    }
    if (typeof totalCost === 'number' && totalCost > 0) {
      parts.push(`$${totalCost.toFixed(4)}`);
    }
    return parts.join(' · ');
  }
  // R40: Context Window Meter
  let lastUsageDetail = null;
  // R48: walk messages array from newest backward to find the latest
  // assistant turn that carried usageDetail. Hydrating only this one prevents
  // older-batch renders from overwriting the meter with stale data.
  function hydrateLatestUsageDetail(messages) {
    if (!Array.isArray(messages)) return;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === 'assistant' && m.usageDetail) {
        lastUsageDetail = m.usageDetail;
        renderCtxMeter(m.usageDetail);
        return;
      }
    }
    // No persisted usageDetail in this session — clear meter to avoid bleed.
    lastUsageDetail = null;
    if (ctxMeter) { ctxMeter.hidden = true; delete ctxMeter.dataset.level; ctxMeter.style.removeProperty('--ctx-pct'); }
  }
  function renderCtxMeter(detail) {
    if (!ctxMeter || !detail) return;
    const cw = detail.contextWindow;
    const used = detail.contextUsed || 0;
    if (!cw) {
      ctxMeter.hidden = true;
      return;
    }
    const pct = Math.min(1, Math.max(0, used / cw));
    ctxMeter.style.setProperty('--ctx-pct', String(pct));
    ctxMeter.querySelector('.ctx-meter-label').textContent = `${formatTokens(used)} / ${formatTokens(cw)}`;
    ctxMeter.dataset.level = pct >= 0.8 ? 'danger' : pct >= 0.5 ? 'warn' : '';
    ctxMeter.hidden = false;
    ctxMeter.title = `${(pct * 100).toFixed(1)}% 已用`;
  }
  function closeCtxPopover() {
    if (!ctxPopover) return;
    ctxPopover.hidden = true;
    if (ctxMeter) ctxMeter.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', _onCtxOutside, true);
    document.removeEventListener('keydown', _onCtxKey, true);
  }
  function _onCtxOutside(e) {
    if (!ctxPopover.contains(e.target) && !ctxMeter.contains(e.target)) closeCtxPopover();
  }
  function _onCtxKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeCtxPopover(); }
  }
  function openCtxPopover() {
    if (!ctxPopover || !lastUsageDetail) return;
    const d = lastUsageDetail;
    const rows = [];
    if (d.contextWindow) rows.push(['上下文窗口', `${formatTokens(d.contextWindow)} (${(d.contextUsed / d.contextWindow * 100).toFixed(1)}%)`]);
    if (d.maxOutputTokens) rows.push(['最大输出', formatTokens(d.maxOutputTokens)]);
    if (d.numTurns) rows.push(['总回合数', d.numTurns]);
    if (d.ttftMs) rows.push(['首 token 延迟', `${(d.ttftMs / 1000).toFixed(2)}s`]);
    if (d.durationMs) rows.push(['总耗时', `${(d.durationMs / 1000).toFixed(2)}s`]);
    if (d.durationApiMs) rows.push(['API 耗时', `${(d.durationApiMs / 1000).toFixed(2)}s`]);
    if (d.serviceTier) rows.push(['服务等级', d.serviceTier]);
    if (d.stopReason) rows.push(['停止原因', d.stopReason]);
    if (d.terminalReason) rows.push(['终止原因', d.terminalReason]);
    // R46: permission_denials now carries the full array; expose count + list.
    const denialList = Array.isArray(d.permissionDenials) ? d.permissionDenials : [];
    const denialCount = typeof d.permissionDenials === 'number' ? d.permissionDenials : denialList.length;
    if (denialCount) rows.push(['权限拒绝次数', denialCount]);
    if (typeof d.costUsd === 'number' && d.costUsd > 0) rows.push(['本轮花费', `$${d.costUsd.toFixed(4)}`]);
    let denialMarkup = '';
    if (denialList.length) {
      const items = denialList.map((dn) => {
        const inputStr = dn.toolInput ? JSON.stringify(dn.toolInput).slice(0, 200) : '';
        const display = inputStr.length === 200 ? inputStr + '…' : inputStr;
        const fullJson = dn.toolInput ? JSON.stringify(dn.toolInput, null, 2) : '';
        return `<li class="ctx-denial-row"><span class="ctx-denial-tool">${escapeHtml(dn.toolName || '?')}</span><code class="ctx-denial-input" title="${escapeHtml(fullJson)}">${escapeHtml(display)}</code></li>`;
      }).join('');
      denialMarkup = `<section class="ctx-denials"><h4 class="ctx-denials-h">权限拒绝明细 <span class="ctx-denials-tally">${denialList.length}</span></h4><ul class="ctx-denials-list">${items}</ul></section>`;
    }
    ctxPopover.innerHTML = `<p class="ctx-popover-title">本轮用量详情</p><dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}</dl>${denialMarkup}`;
    ctxPopover.hidden = false;
    ctxMeter.setAttribute('aria-expanded', 'true');
    setTimeout(() => {
      document.addEventListener('click', _onCtxOutside, true);
      document.addEventListener('keydown', _onCtxKey, true);
    }, 0);
  }
  if (ctxMeter) {
    ctxMeter.addEventListener('click', (e) => {
      e.stopPropagation();
      if (ctxPopover.hidden) openCtxPopover();
      else closeCtxPopover();
    });
  }

  function setStatsDisplay(msg) {
    const text = formatStats(msg?.totalUsage, msg?.totalCost) || '';
    costDisplay.textContent = text;
    // The HTML `hidden` attribute is more aggressive than CSS :empty rule;
    // toggle it so the chip becomes visible whenever there's actual stats text.
    costDisplay.hidden = !text;
  }

  // --- Stream rate (B): rolling 5s window, ~chars/4 = approx tokens ---
  const streamRateEl = $('#stream-rate');
  const STREAM_WINDOW_MS = 5000;
  const streamSamples = []; // { ts, chars }
  let streamRateTimer = null;
  function recordStreamSample(text) {
    if (!text) return;
    const ts = performance.now();
    streamSamples.push({ ts, chars: text.length });
    pruneStreamSamples(ts);
    if (!streamRateTimer) {
      streamRateTimer = setInterval(updateStreamRate, 500);
      updateStreamRate();
    }
  }
  function pruneStreamSamples(now = performance.now()) {
    const cutoff = now - STREAM_WINDOW_MS;
    while (streamSamples.length && streamSamples[0].ts < cutoff) streamSamples.shift();
  }
  function updateStreamRate() {
    if (!streamRateEl) return;
    pruneStreamSamples();
    if (!isGenerating || streamSamples.length === 0) {
      stopStreamRate();
      return;
    }
    const now = performance.now();
    const oldest = streamSamples[0].ts;
    const seconds = Math.max(0.5, (now - oldest) / 1000);
    const chars = streamSamples.reduce((a, b) => a + b.chars, 0);
    const tokensPerSec = (chars / 4) / seconds; // ≈ tokens/sec
    streamRateEl.hidden = false;
    streamRateEl.textContent = `${tokensPerSec.toFixed(1)} tok/s`;
  }
  function stopStreamRate() {
    if (streamRateTimer) { clearInterval(streamRateTimer); streamRateTimer = null; }
    if (streamRateEl) { streamRateEl.hidden = true; streamRateEl.textContent = ''; }
    streamSamples.length = 0;
  }

	  function _splitCodexThinkingModel(model) {
	    const raw = String(model || '').trim();
	    if (!raw) return { base: '', level: '' };
	    const m = raw.match(/^(.*)\(([^()]+)\)\s*$/);
	    if (!m) return { base: raw, level: '' };
	    return { base: (m[1] || '').trim(), level: (m[2] || '').trim().toLowerCase() };
	  }

	  function _parseCodexModelListText(text) {
	    const seen = new Set();
	    const models = [];
	    String(text || '')
	      .split(/\r?\n|,/)
	      .map((item) => item.trim())
	      .filter(Boolean)
	      .forEach((item) => {
	        if (seen.has(item)) return;
	        seen.add(item);
	        models.push(item);
	      });
	    return models;
	  }

	  function normalizeCodexProfile(profile) {
	    const normalized = {
	      name: String(profile?.name || '').trim(),
	      apiKey: String(profile?.apiKey || ''),
	      apiBase: String(profile?.apiBase || '').trim(),
	      model: String(profile?.model || '').trim(),
	      models: [],
	    };
	    const seen = new Set();
	    function addModel(value) {
	      const model = String(value || '').trim();
	      if (!model || seen.has(model)) return;
	      seen.add(model);
	      normalized.models.push(model);
	    }
	    if (Array.isArray(profile?.models)) profile.models.forEach(addModel);
	    addModel(normalized.model);
	    return normalized;
	  }

	  function getActiveCodexProfileConfig() {
	    const config = codexConfigCache || null;
	    if (!config || config.mode !== 'custom' || !config.activeProfile) return null;
	    const profile = (config.profiles || []).find((item) => item.name === config.activeProfile) || null;
	    return profile ? normalizeCodexProfile(profile) : null;
	  }

	  function getCodexBaseModelOptions() {
	    const seen = new Set();
	    const options = [];

	    function addOption(value, label, desc) {
	      const v = (value || '').trim();
	      if (!v || seen.has(v)) return;
	      seen.add(v);
	      options.push({ value: v, label: label || v, desc: desc || 'Codex 模型' });
	    }

	    function addBaseOption(value, label, desc) {
	      const { base } = _splitCodexThinkingModel(value);
	      addOption(base, label || base, desc);
	    }

	    const activeProfile = getActiveCodexProfileConfig();
	    const configuredModels = Array.isArray(activeProfile?.models) ? activeProfile.models : [];
	    configuredModels.forEach((model) => addBaseOption(model, model, 'Profile 已配置模型'));

	    return options;
	  }

  // --- marked config ---
  const PREVIEW_LANGS = new Set(['html', 'svg']);
  const _previewCodeMap = new Map();
  let _previewCodeId = 0;

  const renderer = new marked.Renderer();
  renderer.code = function (code, language) {
    const lang = (language || 'plaintext').toLowerCase();
    let highlighted;
    try {
      if (hljs.getLanguage(lang)) {
        highlighted = hljs.highlight(code, { language: lang }).value;
      } else {
        highlighted = hljs.highlightAuto(code).value;
      }
    } catch {
      highlighted = escapeHtml(code);
    }
    const canPreview = PREVIEW_LANGS.has(lang);
    const previewBtn = canPreview
      ? `<button class="code-preview-btn" onclick="ccTogglePreview(this)">Preview</button>`
      : '';
    const previewPane = canPreview
      ? `<div class="code-preview-pane"><iframe class="code-preview-iframe" sandbox="allow-scripts" loading="lazy"></iframe></div>`
      : '';
    const cid = canPreview ? (++_previewCodeId) : 0;
    if (canPreview) _previewCodeMap.set(cid, code);
    return `<div class="code-block-wrapper${canPreview ? ' has-preview' : ''}"${canPreview ? ` data-cid="${cid}"` : ''}>
      <div class="code-block-header">
        <span>${escapeHtml(lang)}</span>
        <div class="code-block-actions">${previewBtn}<button class="code-copy-btn" onclick="ccCopyCode(this)">Copy</button></div>
      </div>
      ${previewPane}<pre><code class="hljs language-${escapeHtml(lang)}">${highlighted}</code></pre>
    </div>`;
  };
  marked.setOptions({ renderer, breaks: true, gfm: true });

  window.ccCopyCode = function (btn) {
    const wrapper = btn.closest('.code-block-wrapper');
    const cid = wrapper.dataset.cid ? Number(wrapper.dataset.cid) : 0;
    const code = (cid && _previewCodeMap.has(cid)) ? _previewCodeMap.get(cid) : wrapper.querySelector('code').textContent;
    navigator.clipboard.writeText(code).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    });
  };

  window.ccTogglePreview = function (btn) {
    const wrapper = btn.closest('.code-block-wrapper');
    const inPreview = wrapper.classList.contains('preview-mode');
    if (inPreview) {
      wrapper.classList.remove('preview-mode');
      btn.textContent = 'Preview';
    } else {
      const iframe = wrapper.querySelector('.code-preview-iframe');
      if (iframe && !iframe.dataset.loaded) {
        const cid = wrapper.dataset.cid ? Number(wrapper.dataset.cid) : 0;
        iframe.srcdoc = (cid && _previewCodeMap.has(cid)) ? _previewCodeMap.get(cid) : '';
        iframe.dataset.loaded = '1';
      }
      wrapper.classList.add('preview-mode');
      btn.textContent = 'Source';
    }
  };

  // --- WebSocket ---
  function connect() {
    if (ws && ws.readyState <= 1) return;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      reconnectAttempts = 0;
      if (authToken) {
        // R32: hint server which session to piggyback, eliminating 2 RTT for cold boot
        const lastId = localStorage.getItem(`cc-web-session-${normalizeAgent(currentAgent)}`);
        const payload = { type: 'auth', token: authToken };
        if (lastId) payload.lastSessionId = lastId;
        send(payload);
      }
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleServerMessage(msg);
    };

    ws.onclose = () => {
      clearSessionLoading();
      scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  function send(data) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
  }

  // Login auth send: must succeed even if ws is still CONNECTING.
  // Polls readyState every 80ms (max 5s); triggers connect() if ws is closed.
  // Safer than send() because it actually waits for the ws.open instead of
  // dropping the auth payload silently.
  function sendAuthWhenReady(data, maxWaitMs = 5000) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(data)); return; }
    if (!ws || ws.readyState > 1) connect();
    const start = Date.now();
    const tryFlush = () => {
      if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify(data)); } catch {}
        return;
      }
      if (Date.now() - start > maxWaitMs) return; // outer 10s timeout will catch it
      setTimeout(tryFlush, 80);
    };
    tryFlush();
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  // --- Server Message Handler ---
  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'auth_result':
        if (msg.success) {
          authToken = msg.token;
          if (msg.homeDir) serverHomeDir = msg.homeDir;
          localStorage.setItem('cc-web-token', msg.token);
          document.dispatchEvent(new CustomEvent('cc-web-auth-restored'));
          loginOverlay.hidden = true;
          app.hidden = false;
          send({ type: 'get_codex_config' });
          // Check if must change password
          if (msg.mustChangePassword) {
            showForceChangePassword();
          } else {
            pendingInitialSessionLoad = true;
            // Defensive: explicitly request session list. Server already auto-pushes
            // it after auth_result, but the second list_sessions is idempotent and
            // covers any race where the auto-pushed frame is dropped or the
            // client's onmessage isn't yet bound when it arrives.
            send({ type: 'list_sessions' });
            // Safety net: if no session_list arrives within 2s (e.g. both push
            // and request lost), retry once. Cleared inside case 'session_list'.
            if (sessionListSafetyTimer) clearTimeout(sessionListSafetyTimer);
            sessionListSafetyTimer = setTimeout(() => {
              sessionListSafetyTimer = null;
              if (pendingInitialSessionLoad && ws && ws.readyState === 1) {
                send({ type: 'list_sessions' });
              }
            }, 2000);
          }
        } else {
          authToken = null;
          localStorage.removeItem('cc-web-token');
          // Clear any optimistic boot overlay (R31) — login is now the surface
          clearSessionLoading();
          document.dispatchEvent(new CustomEvent('cc-web-auth-failed'));
          loginOverlay.hidden = false;
          app.hidden = true;
          if (msg.banned) {
            loginError.textContent = '该 IP 已被永久封禁';
            loginError.hidden = false;
            loginPassword.disabled = true;
            loginForm.querySelector('button[type="submit"]').disabled = true;
          } else {
            loginError.textContent = '密码错误';
            loginError.hidden = false;
          }
        }
        break;

      case 'session_list':
        if (sessionListSafetyTimer) { clearTimeout(sessionListSafetyTimer); sessionListSafetyTimer = null; }
        sessions = msg.sessions || [];
        reconcileSessionCacheWithSessions();
        renderSessionList();
        if (currentSessionId) {
          setCurrentSessionRunningState(!!getSessionMeta(currentSessionId)?.isRunning);
        }
        if (pendingInitialSessionLoad) {
          pendingInitialSessionLoad = false;
          // Smart agent recovery: if user's last-selected agent is empty but other
          // agent has sessions, auto-switch on boot. Without this, a refresh into
          // an empty tab can read as "session history disappeared" until the user
          // manually switches tabs (which is what triggered the second-refresh
          // recovery: setCurrentAgent on tab toggle re-renders).
          let targetAgent = currentAgent;
          const visibleForTarget = sessions.filter((s) => normalizeAgent(s.agent) === targetAgent);
          if (visibleForTarget.length === 0 && sessions.length > 0) {
            targetAgent = normalizeAgent(sessions[0].agent);
          }
          syncViewForAgent(targetAgent, { preserveCurrent: false, loadLast: true });
        } else if (currentSessionId && !getSessionMeta(currentSessionId)) {
          resetChatView(currentAgent);
        }
        break;

      case 'session_info':
        const snapshot = normalizeSessionSnapshot(msg);
        if (activeSessionLoad?.sessionId === msg.sessionId) {
          activeSessionLoad.snapshot = snapshot;
        }
        applySessionSnapshot(snapshot, {
          immediate: isBlockingSessionLoad(msg.sessionId),
          suppressUnreadToast: false,
          preserveStreaming: msg.sessionId === currentSessionId && msg.isRunning,
        });
        if (!msg.historyPending) {
          if (activeSessionLoad?.sessionId === msg.sessionId) {
            finalizeLoadedSession(msg.sessionId);
          } else {
            cacheSessionSnapshot(snapshot);
            finishSessionSwitch(msg.sessionId);
          }
        }
        break;

      case 'session_history_chunk':
        if (msg.sessionId === currentSessionId && loadedHistorySessionId === msg.sessionId) {
          const blocking = isBlockingSessionLoad(msg.sessionId);
          if (activeSessionLoad?.sessionId === msg.sessionId && activeSessionLoad.snapshot) {
            activeSessionLoad.snapshot.messages = cloneMessages(msg.messages || []).concat(activeSessionLoad.snapshot.messages);
          }
          prependHistoryMessages(msg.messages || [], {
            preserveScroll: !blocking,
            skipScrollbar: blocking,
          });
          if (!msg.remaining) {
            finalizeLoadedSession(msg.sessionId);
          }
        }
        break;

      case 'session_renamed':
        sessions = sessions.map((session) => session.id === msg.sessionId ? { ...session, title: msg.title } : session);
        updateCachedSession(msg.sessionId, (snapshot) => { snapshot.title = msg.title; });
        if (msg.sessionId === currentSessionId) {
          chatTitle.textContent = msg.title;
        }
        renderSessionList();
        break;

      case 'text_delta':
        // Cross-session isolation (loop2-12): drop in-flight deltas that
        // belong to a previous session. Server detaches old ws on switch
        // but RTT-window deltas can still arrive and would otherwise leak
        // into the new session's view, polluting pendingText / streaming bubble.
        if (msg.sessionId && currentSessionId && msg.sessionId !== currentSessionId) break;
        if (!isGenerating) startGenerating();
        pendingText += msg.text;
        recordStreamSample(msg.text || '');
        scheduleRender();
        break;

      case 'thinking_delta':
        if (msg.sessionId && currentSessionId && msg.sessionId !== currentSessionId) break;
        if (!isGenerating) startGenerating();
        pendingThinking += msg.text || '';
        recordStreamSample(msg.text || '');
        scheduleRender();
        break;

      case 'stderr_chunk':
        // Cross-session isolation (loop2-13): drop in-flight events whose sessionId
        // doesn't match the current view. Same race window as text/thinking_delta:
        // server detaches old ws on switch but RTT-window events still arrive.
        if (msg.sessionId && currentSessionId && msg.sessionId !== currentSessionId) break;
        appendStderrChunk(msg.text || '');
        break;

      case 'tool_start':
        if (msg.sessionId && currentSessionId && msg.sessionId !== currentSessionId) break;
        if (!isGenerating) startGenerating();
        activeToolCalls.set(msg.toolUseId, { name: msg.name, input: msg.input, kind: msg.kind || null, meta: msg.meta || null, done: false });
        appendToolCall(msg.toolUseId, msg.name, msg.input, false, msg.kind || null, msg.meta || null);
        break;

      case 'tool_end':
        if (msg.sessionId && currentSessionId && msg.sessionId !== currentSessionId) break;
        if (activeToolCalls.has(msg.toolUseId)) {
          const tc = activeToolCalls.get(msg.toolUseId);
          tc.done = true;
          if (msg.kind) tc.kind = msg.kind;
          if (msg.meta) tc.meta = msg.meta;
          tc.result = msg.result;
          tc.resultTruncated = !!msg.resultTruncated;
          tc.resultTotalLength = msg.resultTotalLength;
          tc.isError = !!msg.isError;
          if (Array.isArray(msg.images) && msg.images.length) tc.images = msg.images;
          // R52: capture R51 toolUseResult enrichment so updateToolCall can
          // render stdout/stderr/exitCode/interrupted/isImage panels.
          if (msg.toolUseResult) tc.toolUseResult = msg.toolUseResult;
        }
        updateToolCall(msg.toolUseId, msg.result, {
          truncated: !!msg.resultTruncated,
          totalLength: msg.resultTotalLength,
          isError: !!msg.isError,
          images: Array.isArray(msg.images) ? msg.images : null,
          toolUseResult: msg.toolUseResult || null,
        });
        break;

      case 'cost': {
        // Critical: cost/usage write to sessionCache(currentSessionId,...) which
        // PERSISTS across reload. Without sessionId guard, A's stats overwrite
        // B's snapshot in the race window — corruption survives page refresh.
        if (msg.sessionId && currentSessionId && msg.sessionId !== currentSessionId) break;
        if (currentSessionId) {
          updateCachedSession(currentSessionId, (snapshot) => { snapshot.totalCost = msg.costUsd; });
        }
        const snap = currentSessionId ? sessionCache.get(currentSessionId)?.snapshot : null;
        costDisplay.textContent = formatStats(snap?.totalUsage, msg.costUsd) || `$${(msg.costUsd || 0).toFixed(4)}`;
        break;
      }

      case 'usage': {
        if (msg.sessionId && currentSessionId && msg.sessionId !== currentSessionId) break;
        if (msg.totalUsage) {
          if (currentSessionId) {
            updateCachedSession(currentSessionId, (snapshot) => { snapshot.totalUsage = deepClone(msg.totalUsage); });
          }
          const snap = currentSessionId ? sessionCache.get(currentSessionId)?.snapshot : null;
          costDisplay.textContent = formatStats(msg.totalUsage, snap?.totalCost) || '';
        }
        break;
      }

      case 'done':
        finishGenerating(msg.sessionId);
        break;

      case 'system_message':
        if (msg.sessionId && currentSessionId && msg.sessionId !== currentSessionId) break;
        // R41: live init events carrying structured detail get rendered as
        // an expandable card; everything else stays the plain banner.
        if (msg.kind === 'init' && msg.initDetail) {
          appendInitCard(msg.message, msg.initDetail);
        } else {
          // R42 + R43 + R49: errorClass + hookEvent + warningType all forwarded.
          appendSystemMessage(msg.message, msg.kind || null, msg.errorClass || null, msg.hookEvent || null, msg.warningType || null);
        }
        break;

      case 'usage_detail':
        // R40: rich per-turn metrics from CLI 'result' event. Drives ctx-meter.
        if (msg.sessionId && currentSessionId && msg.sessionId !== currentSessionId) break;
        lastUsageDetail = msg;
        renderCtxMeter(msg);
        break;

      case 'assistant_stop':
        // R43: append a stop-reason chip to the streaming assistant bubble so
        // truncation/refusal/pause is visible at-a-glance (not hidden inside
        // the ctx-meter popover).
        if (msg.sessionId && currentSessionId && msg.sessionId !== currentSessionId) break;
        if (msg.stopReason) {
          const streamEl = document.getElementById('streaming-msg');
          if (streamEl) appendStopReasonChip(streamEl, msg.stopReason);
        }
        break;

      case 'mode_changed':
        if (msg.mode && MODE_LABELS[msg.mode]) {
          currentMode = msg.mode;
          setModeSelectUI(currentMode);
          localStorage.setItem(getAgentModeStorageKey(currentAgent), currentMode);
          if (currentSessionId) {
            updateCachedSession(currentSessionId, (snapshot) => { snapshot.mode = msg.mode; });
          }
        }
        break;

      case 'model_changed':
        if (msg.model) {
          currentModel = msg.model;
          if (currentSessionId) {
            updateCachedSession(currentSessionId, (snapshot) => { snapshot.model = msg.model; });
          }
        }
        break;

      case 'resume_generating':
        // Server has an active process for this session — resume streaming
        setCurrentSessionRunningState(true);
        if (!isGenerating || !document.getElementById('streaming-msg')) {
          startGenerating();
        } else {
          sendBtn.hidden = true;
          abortBtn.hidden = false;
          toolGroupCount = 0;
          hasGrouped = false;
          activeToolCalls.clear();
          const toolsDiv = document.querySelector('#streaming-msg .msg-tools');
          if (toolsDiv) toolsDiv.innerHTML = '';
        }
        pendingText = msg.text || '';
        flushRender();
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            // R52: preserve full tc shape (including toolUseResult, images,
            // truncation flags, elapsedMs, startedAt) so the resumed bubble
            // matches what the historical-render path would produce.
            activeToolCalls.set(tc.id, { ...tc });
            appendToolCall(tc.id, tc.name, tc.input, tc.done, tc.kind || null, tc.meta || null);
            if (tc.done) {
              updateToolCall(tc.id, tc.result, {
                truncated: !!tc.resultTruncated,
                totalLength: tc.resultTotalLength,
                isError: !!tc.isError,
                images: Array.isArray(tc.images) ? tc.images : null,
                toolUseResult: tc.toolUseResult || null,
              });
              // R47/R52: hydrate elapsed timer dataset for the resumed chip
              const tEl = document.getElementById('tool-' + tc.id);
              if (tEl) {
                if (tc.elapsedMs != null) tEl.dataset.elapsedMs = String(tc.elapsedMs);
                if (tc.startedAt && !tEl.dataset.startedAt) tEl.dataset.startedAt = String(tc.startedAt);
              }
            }
          }
        }
        break;

      case 'error':
        appendError(msg.message);
        clearSessionLoading();
        if (!isGenerating && currentSessionId) {
          setCurrentSessionRunningState(!!getSessionMeta(currentSessionId)?.isRunning);
        }
        if (isGenerating) finishGenerating();
        break;

      case 'notify_config':
        if (typeof _onNotifyConfig === 'function') _onNotifyConfig(msg.config);
        // Update summary in parent settings panel if visible
        if (msg.config) {
          const provider = msg.config.provider || 'off';
          const providerLabel = PROVIDER_OPTIONS.find(o => o.value === provider)?.label || '关闭';
          const summaryOn = msg.config.summary?.enabled ? '摘要已启用' : '摘要关闭';
          const meta = provider === 'off' ? '未启用' : `${providerLabel} · ${summaryOn}`;
          document.querySelectorAll('[data-notify-summary]').forEach(el => { el.textContent = meta; });
        }
        break;

      case 'notify_test_result':
        if (typeof _onNotifyTestResult === 'function') _onNotifyTestResult(msg);
        break;

      case 'model_config':
        if (typeof _onModelConfig === 'function') _onModelConfig(msg.config);
        break;

      case 'codex_config':
        codexConfigCache = msg.config || null;
        if (typeof _onCodexConfig === 'function') _onCodexConfig(msg.config);
        break;

      case 'claude_local_config':
        if (typeof _onClaudeLocalConfig === 'function') _onClaudeLocalConfig(msg);
        break;

      case 'codex_local_config':
        if (typeof _onCodexLocalConfig === 'function') _onCodexLocalConfig(msg);
        break;

      case 'dev_config':
        if (typeof _onDevConfig === 'function') _onDevConfig(msg.config);
        break;

      case 'fetch_models_result':
        if (typeof _onFetchModelsResult === 'function') _onFetchModelsResult(msg);
        break;

      case 'background_done':
        // A background task completed (browser was disconnected or viewing another session)
        showToast(`「${msg.title}」任务完成`, msg.sessionId);
        showBrowserNotification(msg.title);
        if (msg.sessionId === currentSessionId) {
          // Reload current session to show completed response
          openSession(msg.sessionId, { forceSync: true, blocking: false });
        } else {
          send({ type: 'list_sessions' });
        }
        break;

      case 'password_changed':
        handlePasswordChanged(msg);
        break;

      case 'native_sessions':
        if (typeof _onNativeSessions === 'function') _onNativeSessions(msg.groups || []);
        break;

      case 'codex_sessions':
        if (typeof _onCodexSessions === 'function') _onCodexSessions(msg.sessions || []);
        break;

      case 'cwd_suggestions':
        if (typeof _onCwdSuggestions === 'function') _onCwdSuggestions(msg.paths || []);
        break;

      case 'update_info':
        if (typeof window._ccOnUpdateInfo === 'function') window._ccOnUpdateInfo(msg);
        break;
    }
  }

  // --- Generating State ---
  function startGenerating() {
    isGenerating = true;
    setCurrentSessionRunningState(true);
    pendingText = '';
    pendingThinking = '';
    activeToolCalls.clear();
    toolGroupCount = 0;
    hasGrouped = false;
    sendBtn.hidden = true;
    abortBtn.hidden = false;
    // 不禁用输入框，允许用户继续输入（但无法发送）

    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();

    const msgEl = createMsgElement('assistant', '');
    msgEl.id = 'streaming-msg';
    // 流式消息 bubble 拆为 .msg-thinking, .msg-text, .msg-tools
    const bubble = msgEl.querySelector('.msg-bubble');
    bubble.innerHTML = '';
    const thinkingEl = document.createElement('details');
    thinkingEl.className = 'msg-thinking';
    thinkingEl.hidden = true;
    const thinkingSummary = document.createElement('summary');
    thinkingSummary.className = 'msg-thinking-summary';
    thinkingSummary.innerHTML = '<span class="msg-thinking-icon">✦</span><span>思考过程</span>';
    const thinkingBody = document.createElement('div');
    thinkingBody.className = 'msg-thinking-body';
    thinkingEl.appendChild(thinkingSummary);
    thinkingEl.appendChild(thinkingBody);
    const textDiv = document.createElement('div');
    textDiv.className = 'msg-text';
    textDiv.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    const toolsDiv = document.createElement('div');
    toolsDiv.className = 'msg-tools';
    bubble.appendChild(thinkingEl);
    bubble.appendChild(textDiv);
    bubble.appendChild(toolsDiv);
    messagesDiv.appendChild(msgEl);
    scrollToBottom();
  }

  function finishGenerating(sessionId) {
    isGenerating = false;
    sendBtn.hidden = false;
    abortBtn.hidden = true;
    setCurrentSessionRunningState(false);
    stopStreamRate();
    msgInput.focus();
    // R21: WCAG 4.1.3 Status Messages — announce completion exactly once per turn.
    // Clear-then-set with microdelay so SR re-reads even if last text was identical.
    if (chatAnnounce) {
      chatAnnounce.textContent = '';
      setTimeout(() => { chatAnnounce.textContent = '回复已完成'; }, 50);
    }

    if (pendingText) flushRender();

    const typing = document.querySelector('.typing-indicator');
    if (typing) typing.remove();

    const streamEl = document.getElementById('streaming-msg');
    if (streamEl) {
      // 若本轮出现过父目录，把末尾散落的 .tool-call 也一并收入同一父节点
      if (hasGrouped) {
        const toolsDiv = streamEl.querySelector('.msg-tools');
        if (toolsDiv) {
          const loose = Array.from(toolsDiv.children).filter(c => c.classList.contains('tool-call'));
          if (loose.length > 0) {
            let group = toolsDiv.querySelector(':scope > .tool-group');
            if (!group) {
              group = document.createElement('details');
              group.className = 'tool-group';
              const gs = document.createElement('summary');
              gs.className = 'tool-group-summary';
              group.appendChild(gs);
              const inner = document.createElement('div');
              inner.className = 'tool-group-inner';
              group.appendChild(inner);
              toolsDiv.insertBefore(group, toolsDiv.firstChild);
            }
            const inner = group.querySelector('.tool-group-inner');
            loose.forEach(c => inner.appendChild(c));
            _refreshGroupSummary(group);
          }
        }
      }
      streamEl.removeAttribute('id');
    }

    if (sessionId) currentSessionId = sessionId;
    pendingText = '';
    activeToolCalls.clear();
    toolGroupCount = 0;
    hasGrouped = false;
  }

  // --- Rendering ---
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      flushRender();
    }, RENDER_DEBOUNCE);
  }

  function flushRender() {
    const streamEl = document.getElementById('streaming-msg');
    if (!streamEl) return;
    const bubble = streamEl.querySelector('.msg-bubble');
    if (!bubble) return;
    const thinkingEl = bubble.querySelector('.msg-thinking');
    if (thinkingEl) {
      if (pendingThinking) {
        thinkingEl.hidden = false;
        const body = thinkingEl.querySelector('.msg-thinking-body');
        if (body) body.innerHTML = renderMarkdown(pendingThinking);
      } else {
        thinkingEl.hidden = true;
      }
    }
    let textDiv = bubble.querySelector('.msg-text');
    if (!textDiv) { textDiv = bubble; }
    textDiv.innerHTML = renderMarkdown(pendingText);
    scrollToBottom();
  }

  function renderMarkdown(text) {
    if (!text) return '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    try { return marked.parse(text); }
    catch { return escapeHtml(text); }
  }

  function createMsgElement(role, content, attachments = []) {
    const div = document.createElement('div');
    div.className = `msg ${role}${role === 'assistant' ? ' agent-' + currentAgent : ''}`;

    if (role === 'system') {
      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';
      bubble.textContent = content;
      div.appendChild(bubble);
      return div;
    }

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    if (role === 'user') {
      avatar.textContent = 'U';
    } else if (currentAgent === 'codex') {
      avatar.innerHTML = `<img src="/codex.png" width="24" height="24" style="display:block;" alt="Codex">`;
    } else {
      avatar.innerHTML = `<img src="/claude.png" width="24" height="24" style="display:block;" alt="Claude">`;
    }

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    if (role === 'user') {
      if (content) {
        const textNode = document.createElement('div');
        textNode.className = 'msg-text';
        textNode.style.whiteSpace = 'pre-wrap';
        textNode.textContent = content;
        bubble.appendChild(textNode);
      }
      if (attachments.length > 0) {
        bubble.insertAdjacentHTML('beforeend', renderAttachmentLabels(attachments));
      }
    } else {
      bubble.innerHTML = content ? renderMarkdown(content) : '';
      if (attachments.length > 0) {
        bubble.insertAdjacentHTML('beforeend', renderAttachmentLabels(attachments));
      }
    }

    div.appendChild(avatar);
    div.appendChild(bubble);
    return div;
  }

  let renderEpoch = 0;

  function toolKind(tool) {
    return tool?.kind || tool?.meta?.kind || '';
  }

  function toolTitle(tool) {
    if (tool?.meta?.title) return tool.meta.title;
    return tool?.name || 'Tool';
  }

  function toolSubtitle(tool) {
    if (tool?.meta?.subtitle) return tool.meta.subtitle;
    if (toolKind(tool) === 'command_execution') {
      return tool?.input?.command || '';
    }
    return '';
  }

  function stringifyToolValue(value) {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function toolStateLabel(tool, done) {
    if (!done) return 'Running';
    if (toolKind(tool) === 'command_execution' && typeof tool?.meta?.exitCode === 'number') {
      return `Exit ${tool.meta.exitCode}`;
    }
    return 'Done';
  }

  function toolStateClass(tool, done) {
    if (!done) return 'running';
    if (toolKind(tool) === 'command_execution' && typeof tool?.meta?.exitCode === 'number' && tool.meta.exitCode !== 0) {
      return 'error';
    }
    return 'done';
  }

  function applyToolSummary(summary, tool, done) {
    summary.innerHTML = '';
    const icon = document.createElement('span');
    icon.className = `tool-call-icon ${done ? 'done' : 'running'}`;

    const main = document.createElement('span');
    main.className = 'tool-call-summary-main';
    const label = document.createElement('span');
    label.className = 'tool-call-label';
    label.textContent = toolTitle(tool);
    main.appendChild(label);

    const subtitleText = toolSubtitle(tool);
    if (subtitleText) {
      const subtitle = document.createElement('span');
      subtitle.className = 'tool-call-subtitle';
      subtitle.textContent = subtitleText;
      main.appendChild(subtitle);
    }

    const state = document.createElement('span');
    state.className = `tool-call-state ${toolStateClass(tool, done)}`;
    state.textContent = toolStateLabel(tool, done);

    // R45: live elapsed timer chip; ticked by global startToolTimer setInterval.
    const timer = document.createElement('span');
    timer.className = 'tool-call-timer';
    timer.textContent = '';

    // R45: MCP namespace badge — shows server origin distinctly.
    if (tool?.meta?.mcpServer) {
      const badge = document.createElement('span');
      badge.className = 'tool-call-mcp-badge';
      badge.textContent = `mcp:${tool.meta.mcpServer}`;
      main.insertBefore(badge, label);
    }

    summary.appendChild(icon);
    summary.appendChild(main);
    summary.appendChild(timer);
    summary.appendChild(state);
  }
  // R45: global timer ticks every 500ms, updates .tool-call-timer text on
  // every running .tool-call. Also sets the final 'done · 1.4s' once frozen.
  function formatElapsed(ms) {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return `${m}m${s.toString().padStart(2, '0')}s`;
  }
  function tickToolTimers() {
    const now = Date.now();
    document.querySelectorAll('.tool-call').forEach((el) => {
      const timerEl = el.querySelector(':scope > summary > .tool-call-timer');
      if (!timerEl) return;
      const startedAt = Number(el.dataset.startedAt);
      if (!startedAt) { timerEl.textContent = ''; return; }
      const elapsedMs = el.dataset.elapsedMs ? Number(el.dataset.elapsedMs) : (now - startedAt);
      timerEl.textContent = formatElapsed(elapsedMs);
      // Visual escalation: warn after 30s, danger after 120s — only while running
      if (!el.dataset.elapsedMs) {
        if (elapsedMs >= 120_000) timerEl.dataset.level = 'danger';
        else if (elapsedMs >= 30_000) timerEl.dataset.level = 'warn';
        else delete timerEl.dataset.level;
      } else {
        delete timerEl.dataset.level;
      }
    });
  }
  setInterval(tickToolTimers, 500);

  function buildStructuredToolSection(labelText, bodyText) {
    const section = document.createElement('div');
    section.className = 'tool-call-section';
    const label = document.createElement('div');
    label.className = 'tool-call-section-label';
    label.textContent = labelText;
    const pre = document.createElement('pre');
    pre.className = 'tool-call-code';
    pre.textContent = bodyText;
    section.appendChild(label);
    section.appendChild(pre);
    return section;
  }

	  function buildMsgElement(m) {
	    // R41: historical init with structured detail → expandable init card.
	    if (m.role === 'system' && m.kind === 'init' && m.initDetail) {
	      return buildInitCardElement(m.content || '', m.initDetail);
	    }
	    const el = createMsgElement(m.role, m.content, m.attachments || []);
	    // R36: historical system_messages stored by R33+ (and synthesized by R34
	    // for legacy sessions) carry a kind field. Mirror appendSystemMessage's
	    // dataset.kind so .msg.system[data-kind="init"|"rate-limit"|"hook"|...]
	    // CSS variants apply identically on historical bubbles as on live ones.
	    if (m.role === 'system' && m.kind) {
	      el.dataset.kind = m.kind;
	      // R42: historical error bubbles also pick up errorClass for typed styling.
	      if (m.errorClass) el.dataset.errorClass = m.errorClass;
	      // R43: historical hook bubbles get their hookEvent → icon mapping.
	      if (m.hookEvent) el.dataset.hookEvent = m.hookEvent;
	      // R49: historical warning bubbles get warningType for icon.
	      if (m.warningType) el.dataset.warningType = m.warningType;
	    }
	    // R43: historical assistant with stopReason → append the chip at render.
	    if (m.role === 'assistant' && m.stopReason) {
	      setTimeout(() => appendStopReasonChip(el, m.stopReason), 0);
	    }
	    // R47 + R48 fix: stash usageDetail on the element so renderMessages can
	    // pick the FINAL assistant's data to hydrate ctx-meter (avoids the
	    // batched-render bug where later batches contained older assistants and
	    // overwrote lastUsageDetail with stale data).
	    if (m.role === 'assistant' && m.usageDetail) {
	      try { el.dataset.usageDetail = JSON.stringify(m.usageDetail); } catch {}
	    }
	    // R47: tool elapsed time was server-side stamped (R45 lived only on
	    // client Date.now()). Replay frozen elapsedMs onto the chip dataset so
	    // the timer span renders the correct value.
	    if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
	      setTimeout(() => {
	        for (const tc of m.toolCalls) {
	          if (!tc?.id) continue;
	          const tEl = el.querySelector(`#tool-${CSS.escape(tc.id)}`);
	          if (!tEl) continue;
	          if (tc.elapsedMs != null) tEl.dataset.elapsedMs = String(tc.elapsedMs);
	          if (tc.startedAt && !tEl.dataset.startedAt) tEl.dataset.startedAt = String(tc.startedAt);
	        }
	      }, 0);
	    }
	    if (m.role === 'assistant' && m.aborted) {
	      el.dataset.aborted = '1';
	      const bubble = el.querySelector('.msg-bubble');
	      if (bubble) {
	        const badge = document.createElement('div');
	        badge.className = 'msg-aborted-badge';
	        badge.textContent = '⏹ 已被用户中止';
	        bubble.appendChild(badge);
	      }
	    }
	    if (m.role === 'assistant' && m.thinking) {
	      const bubble = el.querySelector('.msg-bubble');
	      const det = document.createElement('details');
	      det.className = 'msg-thinking';
	      det.innerHTML = `<summary class="msg-thinking-summary"><span class="msg-thinking-icon">✦</span><span>思考过程</span></summary><div class="msg-thinking-body">${renderMarkdown(m.thinking)}</div>`;
	      bubble.insertBefore(det, bubble.firstChild);
	    }
	    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
	      const bubble = el.querySelector('.msg-bubble');
	      const FOLD_AT = 3;
	      let grouped = false;
	      for (const tc of m.toolCalls) {
	        const details = createToolCallElement(tc.id || `saved-${Math.random().toString(36).slice(2)}`, tc, true);

	        // 散落的 .tool-call 达到 FOLD_AT 个时，移入唯一 .tool-group
        const loose = Array.from(bubble.children).filter(c => c.classList.contains('tool-call'));
        if (loose.length >= FOLD_AT) {
          let group = bubble.querySelector(':scope > .tool-group');
          if (!group) {
            group = document.createElement('details');
            group.className = 'tool-group';
            const gs = document.createElement('summary');
            gs.className = 'tool-group-summary';
            group.appendChild(gs);
            const inner = document.createElement('div');
            inner.className = 'tool-group-inner';
            group.appendChild(inner);
            bubble.insertBefore(group, bubble.firstChild);
            grouped = true;
          }
          const inner = group.querySelector('.tool-group-inner');
          loose.forEach(c => inner.appendChild(c));
          _refreshGroupSummary(group);
        }
        bubble.appendChild(details);
      }
      // 结束时若出现过父目录，收尾散落项
      if (grouped) {
        const loose = Array.from(bubble.children).filter(c => c.classList.contains('tool-call'));
        if (loose.length > 0) {
          const group = bubble.querySelector(':scope > .tool-group');
          if (group) {
            const inner = group.querySelector('.tool-group-inner');
            loose.forEach(c => inner.appendChild(c));
            _refreshGroupSummary(group);
          }
        }
      }
    }
    return el;
  }

  function renderMessages(messages, options = {}) {
    renderEpoch++;
    const epoch = renderEpoch;
    messagesDiv.innerHTML = '';
    if (messages.length === 0) {
      messagesDiv.innerHTML = buildWelcomeMarkup(currentAgent);
      return;
    }
    if (options.immediate) {
      const frag = document.createDocumentFragment();
      messages.forEach((message) => frag.appendChild(buildMsgElement(message)));
      messagesDiv.appendChild(frag);
      scrollToBottom(true);
      hydrateLatestUsageDetail(messages);
      return;
    }
    // Batch render: last 10 first, then next 20, then the rest
    const batches = [];
    const len = messages.length;
    if (len <= 10) {
      batches.push([0, len]);
    } else if (len <= 30) {
      batches.push([len - 10, len]);
      batches.push([0, len - 10]);
    } else {
      batches.push([len - 10, len]);
      batches.push([len - 30, len - 10]);
      batches.push([0, len - 30]);
    }

    // Render first batch immediately
    const frag0 = document.createDocumentFragment();
    for (let i = batches[0][0]; i < batches[0][1]; i++) frag0.appendChild(buildMsgElement(messages[i]));
    messagesDiv.appendChild(frag0);
    scrollToBottom(true);
    // R48: hydrate ctx-meter from the LATEST assistant's usageDetail (in the
    // first/newest batch). Subsequent batches contain older messages which
    // intentionally do NOT touch ctx-meter — fixes R47's stale-overwrite bug.
    hydrateLatestUsageDetail(messages);

    // Render remaining batches asynchronously, prepending each
    // Use scrollHeight delta to keep current view position stable after prepend
    let delay = 0;
    for (let b = 1; b < batches.length; b++) {
      const [start, end] = batches[b];
      delay += 16;
      setTimeout(() => {
        if (renderEpoch !== epoch) return; // session switched, abort stale render
        const prevHeight = messagesDiv.scrollHeight;
        const prevScrollTop = messagesDiv.scrollTop;
        const frag = document.createDocumentFragment();
        for (let i = start; i < end; i++) frag.appendChild(buildMsgElement(messages[i]));
        messagesDiv.insertBefore(frag, messagesDiv.firstChild);
        // Compensate scrollTop so visible area stays unchanged
        messagesDiv.scrollTop = prevScrollTop + (messagesDiv.scrollHeight - prevHeight);
        updateScrollbar();
      }, delay);
    }
  }

  function prependHistoryMessages(messages, options = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return;
    const preserveScroll = options.preserveScroll !== false;
    const skipScrollbar = options.skipScrollbar === true;
    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();
    const frag = document.createDocumentFragment();
    messages.forEach((m) => frag.appendChild(buildMsgElement(m)));
    if (!preserveScroll) {
      messagesDiv.insertBefore(frag, messagesDiv.firstChild);
      if (!skipScrollbar) updateScrollbar();
      return;
    }
    const prevHeight = messagesDiv.scrollHeight;
    const prevScrollTop = messagesDiv.scrollTop;
    messagesDiv.insertBefore(frag, messagesDiv.firstChild);
    messagesDiv.scrollTop = prevScrollTop + (messagesDiv.scrollHeight - prevHeight);
    if (!skipScrollbar) updateScrollbar();
  }

  function normalizeAskUserInput(input) {
    if (input === null || input === undefined) return null;
    if (typeof input === 'string') {
      const trimmed = input.trim();
      if (!trimmed) return null;
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    }
    return input;
  }

  // --- TodoWrite (Claude) / update_plan (Codex) progress card ---
  function extractTodos(input) {
    if (!input || typeof input !== 'object') return null;
    // Claude TodoWrite: { todos: [{content, status, activeForm?}] }
    if (Array.isArray(input.todos)) return input.todos;
    // Codex update_plan: { plan: [{step, status}], explanation? }
    if (Array.isArray(input.plan)) {
      return input.plan.map((p) => ({
        content: p.step || p.content || '',
        status: p.status || '',
        activeForm: p.step || '',
      }));
    }
    return null;
  }

  const TODO_ICONS = {
    completed: { glyph: '✓', cls: 'todo-done' },
    in_progress: { glyph: '◐', cls: 'todo-doing' },
    pending: { glyph: '○', cls: 'todo-pending' },
  };

  function createTodoListView(input, result) {
    const todos = extractTodos(input);
    if (!todos || todos.length === 0) return null;
    const wrap = document.createElement('div');
    wrap.className = 'tool-call-content todo-list';
    const ul = document.createElement('ul');
    ul.className = 'todo-items';
    let doneCount = 0;
    let totalCount = todos.length;
    for (const todo of todos) {
      const status = (todo.status || 'pending').toLowerCase().replace(/[-\s]/g, '_');
      const norm = status === 'done' || status === 'completed' ? 'completed'
        : status === 'in_progress' || status === 'doing' || status === 'active' ? 'in_progress'
        : 'pending';
      if (norm === 'completed') doneCount++;
      const icon = TODO_ICONS[norm];
      const li = document.createElement('li');
      li.className = `todo-item ${icon.cls}`;
      li.innerHTML = `<span class="todo-icon">${icon.glyph}</span><span class="todo-text"></span>`;
      const textEl = li.querySelector('.todo-text');
      const display = norm === 'in_progress' && todo.activeForm ? todo.activeForm : (todo.content || '');
      textEl.textContent = display;
      ul.appendChild(li);
    }
    const bar = document.createElement('div');
    bar.className = 'todo-progress';
    const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
    bar.innerHTML = `<div class="todo-progress-track"><div class="todo-progress-fill" style="width:${pct}%"></div></div><span class="todo-progress-label">${doneCount}/${totalCount} · ${pct}%</span>`;
    wrap.appendChild(bar);
    wrap.appendChild(ul);
    return wrap;
  }

  function extractAskUserQuestions(input) {
    const parsed = normalizeAskUserInput(input);
    if (!parsed || !Array.isArray(parsed.questions)) return [];
    return parsed.questions;
  }

  function appendAskOptionToInput(question, option) {
    const header = (question?.header || '').trim() || '问题';
    const line = `【${header}】${option?.label || ''}`;
    const current = msgInput.value.trim();
    msgInput.value = current ? `${current}\n${line}` : line;
    autoResize();
    msgInput.focus();
  }

  function createAskUserQuestionView(questions) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ask-user-question';

    questions.forEach((q, idx) => {
      const card = document.createElement('div');
      card.className = 'ask-question-card';

      const header = document.createElement('div');
      header.className = 'ask-question-header';
      header.textContent = `${idx + 1}. ${q.header || '问题'}`;
      card.appendChild(header);

      const body = document.createElement('div');
      body.className = 'ask-question-text';
      body.textContent = q.question || '';
      card.appendChild(body);

      if (Array.isArray(q.options) && q.options.length > 0) {
        const hasDesc = q.options.some(o => o.description);

        // 左右分栏容器
        const layout = document.createElement('div');
        layout.className = 'ask-options-layout' + (hasDesc ? ' has-preview' : '');

        const opts = document.createElement('div');
        opts.className = 'ask-question-options';

        // 右侧预览区（仅在有 description 时创建）
        const preview = hasDesc ? document.createElement('div') : null;
        if (preview) {
          preview.className = 'ask-option-preview';
          // 默认显示第一项
          preview.textContent = q.options[0].description || '';
        }

        // 当前选中项（移动端 tap-to-preview 状态）
        let selectedOpt = null;
        let selectedBtn = null;

        q.options.forEach((opt, i) => {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'ask-option-item';

          const title = document.createElement('div');
          title.className = 'ask-option-label';
          title.textContent = `${i + 1}. ${opt.label || ''}`;
          item.appendChild(title);

          // 桌面：hover 切换预览
          if (preview) {
            item.addEventListener('mouseenter', () => {
              preview.textContent = opt.description || '';
            });
          }

          item.addEventListener('click', (e) => {
            const isTouch = item.dataset.touchActivated === '1';
            item.dataset.touchActivated = '';

            if (isTouch) {
              // 移动端：第一次 tap = 选中预览，不发送
              if (selectedBtn !== item) {
                if (selectedBtn) selectedBtn.classList.remove('ask-option-selected');
                selectedBtn = item;
                selectedOpt = opt;
                item.classList.add('ask-option-selected');
                if (preview) preview.textContent = opt.description || '';
                return;
              }
              // 第二次 tap 同一项 = 发送
            }

            // 桌面直接发送
            appendAskOptionToInput(q, opt);
          });

          item.addEventListener('touchstart', () => {
            item.dataset.touchActivated = '1';
          }, { passive: true });

          opts.appendChild(item);
        });

        layout.appendChild(opts);
        if (preview) {
          layout.appendChild(preview);
          // 预览区最小高度 = 左侧选项列表总高度（渲染后同步）
          requestAnimationFrame(() => {
            preview.style.minHeight = opts.offsetHeight + 'px';
          });
        }

        // 移动端确认按钮
        if (hasDesc) {
          const confirmBtn = document.createElement('button');
          confirmBtn.type = 'button';
          confirmBtn.className = 'ask-confirm-btn';
          confirmBtn.textContent = '确认选择';
          confirmBtn.addEventListener('click', () => {
            if (selectedOpt) {
              appendAskOptionToInput(q, selectedOpt);
            } else if (q.options.length > 0) {
              appendAskOptionToInput(q, q.options[0]);
            }
          });
          layout.appendChild(confirmBtn);
        }

        card.appendChild(layout);
      }

      wrapper.appendChild(card);
    });

    return wrapper;
  }

  // Extract { before, after, label } hunks from Edit/MultiEdit/Write/NotebookEdit input
  // (Claude shape) or Codex file_change.changes shape.
  function extractDiffHunks(toolName, input) {
    if (!input || typeof input !== 'object') return null;
    // Claude Write — single new file
    if (toolName === 'Write' && typeof input.content === 'string') {
      return [{ before: '', after: input.content, label: 'new file' }];
    }
    // Claude Edit — single old/new pair
    if (toolName === 'Edit' && (typeof input.old_string === 'string' || typeof input.new_string === 'string')) {
      return [{ before: input.old_string || '', after: input.new_string || '', label: input.replace_all ? 'replace all' : 'replace' }];
    }
    // Claude MultiEdit — array of edits
    if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
      return input.edits.map((e, i) => ({
        before: e?.old_string || '',
        after: e?.new_string || '',
        label: `edit ${i + 1}${e?.replace_all ? ' · replace all' : ''}`,
      }));
    }
    // Claude NotebookEdit
    if (toolName === 'NotebookEdit' && typeof input.new_source === 'string') {
      return [{ before: '', after: input.new_source, label: `${input.edit_mode || 'edit'} cell ${input.cell_id || ''}` }];
    }
    // Codex file_change.changes — { "<path>": { update: { old_string, new_string } } | "add" | "delete" }
    if (input.changes && typeof input.changes === 'object') {
      const out = [];
      for (const [pth, change] of Object.entries(input.changes)) {
        if (!change || typeof change !== 'object') continue;
        if (change.update) {
          out.push({ before: change.update.old_string || '', after: change.update.new_string || '', label: pth });
        } else if (change.add) {
          out.push({ before: '', after: change.add.content || change.add || '', label: `${pth} (added)` });
        } else if (typeof change === 'string') {
          out.push({ before: '', after: change, label: pth });
        }
      }
      if (out.length) return out;
    }
    return null;
  }

  // Line-level LCS (F): returns {a:[{line,changed}], b:[{line,changed}]}
  function lcsLineDiff(beforeStr, afterStr) {
    const a = beforeStr.split('\n');
    const b = afterStr.split('\n');
    const n = a.length, m = b.length;
    // O(n*m) LCS DP — capped for sanity
    if (n * m > 200000) {
      // Fallback for very large diffs: mark every line as changed
      return { a: a.map((l) => ({ line: l, changed: true })), b: b.map((l) => ({ line: l, changed: true })) };
    }
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
        else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const aOut = [], bOut = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        aOut.push({ line: a[i], changed: false });
        bOut.push({ line: b[j], changed: false });
        i++; j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        aOut.push({ line: a[i], changed: true });
        i++;
      } else {
        bOut.push({ line: b[j], changed: true });
        j++;
      }
    }
    while (i < n) { aOut.push({ line: a[i++], changed: true }); }
    while (j < m) { bOut.push({ line: b[j++], changed: true }); }
    return { a: aOut, b: bOut };
  }

  function renderDiffPane(lines, sideClass) {
    const pre = document.createElement('pre');
    pre.className = `diff-pane ${sideClass}`;
    for (const { line, changed } of lines) {
      const row = document.createElement('div');
      row.className = `diff-line${changed ? ' diff-line-changed' : ''}`;
      row.textContent = line || '​'; // zero-width to keep empty lines tall
      pre.appendChild(row);
    }
    return pre;
  }

  function renderDiffHunks(hunks) {
    if (!Array.isArray(hunks) || !hunks.length) return null;
    const root = document.createElement('div');
    root.className = 'tool-diff';
    for (const hunk of hunks) {
      const block = document.createElement('div');
      block.className = 'tool-diff-block';
      if (hunk.label) {
        const lbl = document.createElement('div');
        lbl.className = 'tool-diff-label';
        lbl.textContent = hunk.label;
        block.appendChild(lbl);
      }
      const panes = document.createElement('div');
      panes.className = 'tool-diff-panes';
      const isNew = !hunk.before;
      const isDelete = !hunk.after;
      if (!isNew && !isDelete) {
        const { a, b } = lcsLineDiff(hunk.before, hunk.after);
        panes.appendChild(renderDiffPane(a, 'removed'));
        panes.appendChild(renderDiffPane(b, 'added'));
      } else if (!isNew) {
        // Pure delete
        const lines = hunk.before.split('\n').map((l) => ({ line: l, changed: true }));
        panes.appendChild(renderDiffPane(lines, 'removed'));
      } else if (!isDelete) {
        // Pure add / new file
        const lines = hunk.after.split('\n').map((l) => ({ line: l, changed: true }));
        panes.appendChild(renderDiffPane(lines, 'added'));
      }
      block.appendChild(panes);
      root.appendChild(block);
    }
    return root;
  }

  function formatByteSize(n) {
    if (n == null || !Number.isFinite(n)) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  function appendToolDecorations(contentEl, tool) {
    if (!contentEl || !tool) return contentEl;
    // R52: surface CLI's toolUseResult enrichment (stdout/stderr/exitCode/
    // interrupted/isImage). For Bash specifically, stdout/stderr are the
    // canonical outputs; exitCode != 0 ⇒ failed; interrupted = user/timeout.
    const tur = tool.toolUseResult;
    if (tur && typeof tur === 'object') {
      if (typeof tur.exitCode === 'number') {
        const exitChip = document.createElement('div');
        exitChip.className = 'tool-result-exit';
        exitChip.dataset.ok = tur.exitCode === 0 ? '1' : '0';
        exitChip.textContent = tur.exitCode === 0 ? `✓ exit 0` : `✗ exit ${tur.exitCode}`;
        contentEl.appendChild(exitChip);
      }
      if (tur.interrupted) {
        const intChip = document.createElement('div');
        intChip.className = 'tool-result-exit';
        intChip.dataset.ok = '0';
        intChip.textContent = '⏹ 已中断';
        contentEl.appendChild(intChip);
      }
      if (typeof tur.stderr === 'string' && tur.stderr.trim()) {
        const sec = document.createElement('div');
        sec.className = 'tool-result-stderr';
        const label = document.createElement('div');
        label.className = 'tool-result-stderr-label';
        label.textContent = 'stderr';
        const body = document.createElement('pre');
        body.className = 'tool-result-stderr-body';
        body.textContent = tur.stderr;
        sec.appendChild(label);
        sec.appendChild(body);
        contentEl.appendChild(sec);
      }
    }
    // Inline images returned by tools (Claude tool_result content type:image)
    if (Array.isArray(tool.images) && tool.images.length) {
      const gallery = document.createElement('div');
      gallery.className = 'tool-result-images';
      for (const im of tool.images) {
        const src = im?.source;
        if (!src) continue;
        const url = src.type === 'base64' && src.data
          ? `data:${src.media_type || 'image/png'};base64,${src.data}`
          : (typeof src === 'string' ? src : null);
        if (!url) continue;
        const img = document.createElement('img');
        img.className = 'tool-result-image';
        img.loading = 'lazy';
        img.src = url;
        gallery.appendChild(img);
      }
      if (gallery.children.length) contentEl.appendChild(gallery);
    }
    if (tool.resultTruncated) {
      const note = document.createElement('div');
      note.className = 'tool-result-truncated';
      const shown = formatByteSize((tool.result || '').length);
      const total = formatByteSize(tool.resultTotalLength || 0);
      note.textContent = `已显示 ${shown} / 共 ${total} · 余下内容超出 64 KB 上限`;
      contentEl.appendChild(note);
    }
    return contentEl;
  }

  function buildToolContentElement(name, input) {
    const tool = typeof name === 'object' && name !== null ? name : { name, input };
    const effectiveName = tool.name || name;
    const effectiveInput = tool.input !== undefined ? tool.input : input;
    const effectiveResult = tool.result;
    const kind = toolKind(tool);
    const decorate = (el) => appendToolDecorations(el, tool);
    if (effectiveName === 'AskUserQuestion') {
      const questions = extractAskUserQuestions(effectiveInput);
      if (questions.length > 0) {
        return createAskUserQuestionView(questions);
      }
    }

    if (effectiveName === 'TodoWrite' || effectiveName === 'update_plan') {
      const view = createTodoListView(effectiveInput, effectiveResult);
      if (view) return view;
    }

    if (kind === 'command_execution') {
      const wrapper = document.createElement('div');
      wrapper.className = 'tool-call-content command';
      const stack = document.createElement('div');
      stack.className = 'tool-call-structured';
      const commandText = effectiveInput?.command || tool?.meta?.subtitle || '';
      if (commandText) stack.appendChild(buildStructuredToolSection('Command', commandText));
      if (effectiveResult) {
        stack.appendChild(buildStructuredToolSection('Output', stringifyToolValue(effectiveResult)));
      } else if (!tool.done) {
        const empty = document.createElement('div');
        empty.className = 'tool-call-empty';
        empty.textContent = '等待命令输出…';
        stack.appendChild(empty);
      }
      wrapper.appendChild(stack);
      return decorate(wrapper);
    }

    if (kind === 'reasoning') {
      const content = document.createElement('div');
      content.className = 'tool-call-content reasoning';
      const text = stringifyToolValue(effectiveResult || effectiveInput);
      content.innerHTML = text ? renderMarkdown(text) : '<div class="tool-call-empty">暂无推理内容</div>';
      return decorate(content);
    }

    // R44: ExitPlanMode → distinct plan-proposal card with rendered markdown plan.
    if (kind === 'plan_proposal') {
      const wrapper = document.createElement('div');
      wrapper.className = 'tool-call-content plan-proposal';
      const planText = (tool?.meta?.plan) || (effectiveInput && effectiveInput.plan) || '';
      const head = document.createElement('div');
      head.className = 'plan-proposal-head';
      head.innerHTML = '<span class="plan-proposal-icon" aria-hidden="true">✦</span><span class="plan-proposal-title">计划提案</span><span class="plan-proposal-hint">在 CLI 中按 <kbd>⇧Tab</kbd> 退出 Plan 模式</span>';
      wrapper.appendChild(head);
      const body = document.createElement('div');
      body.className = 'plan-proposal-body';
      try {
        body.innerHTML = renderMarkdown(String(planText || '(空)'));
      } catch {
        body.textContent = String(planText || '(空)');
      }
      wrapper.appendChild(body);
      return decorate(wrapper);
    }

    // R44: Sub-Agent (Task tool) — show subagent_type + description prominently.
    if (kind === 'sub_agent') {
      const wrapper = document.createElement('div');
      wrapper.className = 'tool-call-content sub-agent';
      const head = document.createElement('div');
      head.className = 'sub-agent-head';
      const subType = tool?.meta?.title || 'Sub-Agent';
      const desc = tool?.meta?.description || '';
      head.innerHTML = `<span class="sub-agent-icon" aria-hidden="true">↳</span><span class="sub-agent-title"></span>`;
      head.querySelector('.sub-agent-title').textContent = subType;
      wrapper.appendChild(head);
      if (desc) {
        const d = document.createElement('div');
        d.className = 'sub-agent-desc';
        d.textContent = desc;
        wrapper.appendChild(d);
      }
      // Prompt preview (first 240 chars from server)
      const prompt = tool?.meta?.prompt || '';
      if (prompt) {
        const pre = document.createElement('pre');
        pre.className = 'sub-agent-prompt';
        pre.textContent = prompt;
        wrapper.appendChild(pre);
      }
      // If sub-agent finished, show its result text below
      if (effectiveResult) {
        const resBox = document.createElement('div');
        resBox.className = 'sub-agent-result';
        resBox.appendChild(buildStructuredToolSection('结果', stringifyToolValue(effectiveResult)));
        wrapper.appendChild(resBox);
      }
      return decorate(wrapper);
    }

    if (kind === 'file_change' || kind === 'mcp_tool_call') {
      const wrapper = document.createElement('div');
      wrapper.className = `tool-call-content ${kind === 'file_change' ? 'file-change' : ''}`.trim();
      const stack = document.createElement('div');
      stack.className = 'tool-call-structured';
      if (tool?.meta?.subtitle) {
        stack.appendChild(buildStructuredToolSection(kind === 'file_change' ? 'Target' : 'Tool', tool.meta.subtitle));
      }
      // 文件类工具走 diff/added 渲染（Edit/MultiEdit/Write/NotebookEdit + Codex file_change.changes）
      if (kind === 'file_change') {
        const hunks = extractDiffHunks(effectiveName, effectiveInput);
        if (hunks && hunks.length) {
          const diffEl = renderDiffHunks(hunks);
          if (diffEl) stack.appendChild(diffEl);
        } else {
          const payloadText = stringifyToolValue(effectiveResult || effectiveInput);
          if (payloadText) stack.appendChild(buildStructuredToolSection('Payload', payloadText));
        }
      } else {
        const payloadText = stringifyToolValue(effectiveResult || effectiveInput);
        if (payloadText) stack.appendChild(buildStructuredToolSection('Payload', payloadText));
      }
      wrapper.appendChild(stack);
      return decorate(wrapper);
    }

    const inputStr = stringifyToolValue(effectiveResult || effectiveInput);
    const content = document.createElement('div');
    content.className = 'tool-call-content';
    content.textContent = inputStr;
    return decorate(content);
  }

  function createToolCallElement(toolUseId, tool, done) {
    const details = document.createElement('details');
    details.className = 'tool-call';
    details.id = `tool-${toolUseId}`;
    details.dataset.toolName = tool.name || '';
    // R45: stamp the start time so the chip can show a live elapsed timer
    // while running ('· 12s'). Frozen on tool_end into a final 'done · 1.4s'.
    if (!done) details.dataset.startedAt = String(Date.now());
    if (toolKind(tool)) {
      details.dataset.toolKind = toolKind(tool);
      details.classList.add(`codex-${toolKind(tool).replace(/_/g, '-')}`);
    }
    // Default expansion policy:
    // - Always open AskUserQuestion (it is an actionable UI).
    // - For non-Codex sessions, auto-open in-flight command execution so users can watch output.
    // - For Codex sessions, keep everything collapsed by default (less noise), including in-flight commands.
    const agent = normalizeAgent(currentAgent);
    const kind = toolKind(tool);
    if (tool.name === 'AskUserQuestion') {
      details.open = true;
    } else if (agent !== 'codex' && !done && kind === 'command_execution') {
      details.open = true;
    }

    const summary = document.createElement('summary');
    applyToolSummary(summary, tool, done);
    details.appendChild(summary);
    details.appendChild(buildToolContentElement({ ...tool, done }));
    return details;
  }

  function appendToolCall(toolUseId, name, input, done, kind = null, meta = null) {
    const streamEl = document.getElementById('streaming-msg');
    if (!streamEl) return;
    const bubble = streamEl.querySelector('.msg-bubble');
    if (!bubble) return;
    let toolsDiv = bubble.querySelector('.msg-tools');
    if (!toolsDiv) { toolsDiv = bubble; }

    const tool = { id: toolUseId, name, input, kind, meta, done };

    const details = createToolCallElement(toolUseId, tool, done);

    // 折叠策略：只维护唯一一个 .tool-group 父节点
    // 散落的 .tool-call 直接子节点达到3个时，将它们全部移入父节点；之后继续散落，再达3个再移入
    const FOLD_AT = 3;
    const looseBefore = Array.from(toolsDiv.children).filter(c => c.classList.contains('tool-call'));
    if (looseBefore.length >= FOLD_AT) {
      // 确保存在唯一的 .tool-group
      let group = toolsDiv.querySelector(':scope > .tool-group');
      if (!group) {
        group = document.createElement('details');
        group.className = 'tool-group';
        const gs = document.createElement('summary');
        gs.className = 'tool-group-summary';
        group.appendChild(gs);
        const inner = document.createElement('div');
        inner.className = 'tool-group-inner';
        group.appendChild(inner);
        toolsDiv.insertBefore(group, toolsDiv.firstChild);
        hasGrouped = true;
      }
      const inner = group.querySelector('.tool-group-inner');
      looseBefore.forEach(c => inner.appendChild(c));
      _refreshGroupSummary(group);
    }
    toolsDiv.appendChild(details);
    scrollToBottom();
  }

  function _refreshGroupSummary(group) {
    const inner = group.querySelector('.tool-group-inner');
    const count = inner ? inner.childElementCount : 0;
    const summary = group.querySelector('.tool-group-summary');
    if (summary) summary.textContent = `展开 ${count} 个工具调用`;
  }

  function updateToolCall(toolUseId, result, extras) {
    const el = document.getElementById(`tool-${toolUseId}`);
    if (!el) return;
    // R45: freeze the elapsed time at completion so the chip stops ticking.
    if (el.dataset.startedAt && !el.dataset.elapsedMs) {
      const elapsed = Date.now() - Number(el.dataset.startedAt);
      el.dataset.elapsedMs = String(elapsed);
    }
    const tool = activeToolCalls.get(toolUseId) || {
      id: toolUseId,
      name: el.dataset.toolName || '',
      kind: el.dataset.toolKind || null,
      done: true,
    };
    tool.done = true;
    if (result !== undefined) tool.result = result;
    if (extras) {
      if (extras.truncated !== undefined) tool.resultTruncated = extras.truncated;
      if (extras.totalLength !== undefined) tool.resultTotalLength = extras.totalLength;
      if (extras.isError !== undefined) tool.isError = extras.isError;
      if (extras.images) tool.images = extras.images;
      // R52: surface CLI's toolUseResult enrichment (stdout/stderr/exitCode/...)
      if (extras.toolUseResult) tool.toolUseResult = extras.toolUseResult;
    }
    if (tool.isError) el.dataset.toolError = '1'; else delete el.dataset.toolError;
    const summary = el.querySelector('summary');
    if (summary) applyToolSummary(summary, tool, true);
    if (tool.name === 'AskUserQuestion') return;
    const nextContent = buildToolContentElement(tool);
    const content = el.querySelector('.tool-call-content');
    if (content) content.replaceWith(nextContent);
  }

  function getDeleteConfirmMessage(agent) {
    const normalized = normalizeAgent(agent);
    if (normalized === 'codex') {
      return '删除本会话将同步删去本地 Codex rollout 历史与线程记录，不可恢复。确认删除？';
    }
    return '删除本会话将同步删去本地 Claude 中的会话历史，不可恢复。确认删除？';
  }

  function showDeleteConfirm(agent, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.style.zIndex = '10002';

    const box = document.createElement('div');
    box.className = 'settings-panel';
    box.innerHTML = `
      <div style="font-size:0.9em;color:var(--text-primary);margin-bottom:20px;line-height:1.7">${escapeHtml(getDeleteConfirmMessage(agent))}</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button id="del-confirm-ok" style="width:100%;padding:10px;border:none;border-radius:10px;background:var(--accent);color:#fff;font-size:0.95em;font-weight:600;cursor:pointer;font-family:inherit">确认删除</button>
        <button id="del-confirm-skip" style="width:100%;padding:9px;border:1px solid var(--border-color);border-radius:10px;background:var(--bg-tertiary);color:var(--text-secondary);font-size:0.85em;cursor:pointer;font-family:inherit">确认且不再提示</button>
        <button id="del-confirm-cancel" style="width:100%;padding:9px;border:none;border-radius:10px;background:transparent;color:var(--text-muted);font-size:0.85em;cursor:pointer;font-family:inherit">取消</button>
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = () => document.body.removeChild(overlay);
    box.querySelector('#del-confirm-ok').addEventListener('click', () => { close(); onConfirm(); });
    box.querySelector('#del-confirm-skip').addEventListener('click', () => {
      skipDeleteConfirm = true;
      localStorage.setItem('cc-web-skip-delete-confirm', '1');
      close();
      onConfirm();
    });
    box.querySelector('#del-confirm-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  }

  // --- Export current session as Markdown (D) ---
  function fenceLang(toolName) {
    const map = { Bash: 'bash', Edit: 'diff', Write: '', Read: '', MultiEdit: 'diff' };
    return map[toolName] !== undefined ? map[toolName] : '';
  }
  function escapeMd(s) {
    return String(s == null ? '' : s);
  }
  function serializeToolCall(tc) {
    const lines = [];
    const name = tc.name || '?';
    lines.push(`> 🔧 **${name}**${tc.isError ? ' · ❌ error' : ''}`);
    if (tc.meta?.subtitle) lines.push(`> \`${tc.meta.subtitle}\``);
    if (tc.input != null) {
      // Edit/MultiEdit/Write specials
      if (name === 'Edit' && tc.input?.old_string !== undefined) {
        lines.push('', '```diff');
        for (const ln of String(tc.input.old_string || '').split('\n')) lines.push('- ' + ln);
        for (const ln of String(tc.input.new_string || '').split('\n')) lines.push('+ ' + ln);
        lines.push('```');
      } else if (name === 'MultiEdit' && Array.isArray(tc.input?.edits)) {
        for (let i = 0; i < tc.input.edits.length; i++) {
          const e = tc.input.edits[i];
          lines.push('', `_edit ${i + 1}_`, '```diff');
          for (const ln of String(e?.old_string || '').split('\n')) lines.push('- ' + ln);
          for (const ln of String(e?.new_string || '').split('\n')) lines.push('+ ' + ln);
          lines.push('```');
        }
      } else if (name === 'Write' && tc.input?.content !== undefined) {
        lines.push('', '```', String(tc.input.content), '```');
      } else {
        const inputStr = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input, null, 2);
        if (inputStr && inputStr !== '{}' && inputStr !== 'null') {
          lines.push('', '```json', inputStr, '```');
        }
      }
    }
    if (tc.result) {
      const lang = fenceLang(name);
      lines.push('', `<details><summary>输出${tc.resultTruncated ? ` (已显示 ${tc.result.length}B / 共 ${tc.resultTotalLength}B)` : ''}</summary>`, '', '```' + lang, String(tc.result), '```', '', '</details>');
    }
    return lines.join('\n');
  }
  function buildSessionMarkdown(snapshot) {
    if (!snapshot) return '# (空会话)\n';
    const out = [];
    out.push(`# ${snapshot.title || snapshot.sessionId || '会话'}`);
    out.push('');
    out.push(`- agent: \`${snapshot.agent || 'claude'}\``);
    if (snapshot.cwd) out.push(`- cwd: \`${snapshot.cwd}\``);
    if (snapshot.totalCost) out.push(`- cost: $${Number(snapshot.totalCost).toFixed(4)}`);
    if (snapshot.totalUsage) {
      const u = snapshot.totalUsage;
      out.push(`- tokens: in ${u.inputTokens || 0} · out ${u.outputTokens || 0}${u.cachedInputTokens ? ' · cache ' + u.cachedInputTokens : ''}`);
    }
    out.push(`- exported: ${new Date().toISOString()}`);
    out.push('');
    out.push('---', '');
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    for (const m of messages) {
      const role = m.role || 'assistant';
      const ts = m.timestamp ? ` · _${m.timestamp}_` : '';
      out.push(`## ${role === 'user' ? '👤 user' : role === 'system' ? '🛈 system' : '🤖 assistant'}${ts}`);
      out.push('');
      if (m.thinking) {
        out.push('<details><summary>✦ 思考过程</summary>', '', '> ' + escapeMd(m.thinking).split('\n').join('\n> '), '', '</details>', '');
      }
      if (m.content) {
        out.push(escapeMd(m.content));
        out.push('');
      }
      if (Array.isArray(m.toolCalls) && m.toolCalls.length) {
        for (const tc of m.toolCalls) {
          out.push(serializeToolCall(tc));
          out.push('');
        }
      }
      if (Array.isArray(m.attachments) && m.attachments.length) {
        out.push('_附件：' + m.attachments.map((a) => a.name || a.id || 'attachment').join(', ') + '_');
        out.push('');
      }
    }
    return out.join('\n');
  }
  function exportCurrentSessionMarkdown() {
    if (!currentSessionId) {
      appendError('没有活动会话可导出');
      return;
    }
    const cached = sessionCache.get(currentSessionId);
    const snapshot = cached?.snapshot;
    if (!snapshot) {
      appendError('当前会话尚未加载完成，请稍候再试');
      return;
    }
    const md = buildSessionMarkdown(snapshot);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeTitle = (snapshot.title || snapshot.sessionId || 'session').replace(/[^\w一-龥\-_.]/g, '_').slice(0, 60);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    a.href = url;
    a.download = `cc-web-${safeTitle}-${stamp}.md`;
    document.body.appendChild(a);
    a.click();
    requestAnimationFrame(() => {
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  function appendSystemMessage(message, kind, errorClass, hookEvent, warningType) {
    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();
    const el = createMsgElement('system', message);
    if (kind) el.dataset.kind = kind;
    // R42: error-class drives 5-tier color/icon variants on .msg.system[data-kind="error"]
    if (errorClass) el.dataset.errorClass = errorClass;
    // R43: hookEvent drives per-event icon for .msg.system[data-kind="hook"]
    if (hookEvent) el.dataset.hookEvent = hookEvent;
    // R49: warningType drives icon for .msg.system[data-kind="warning"]
    if (warningType) el.dataset.warningType = warningType;
    messagesDiv.appendChild(el);
    scrollToBottom();
  }

  // R43: stop-reason chip appended at the foot of an assistant bubble.
  const STOP_REASON_LABEL = {
    max_tokens: '⤵ 输出已达 max_tokens 上限，回复未完整',
    refusal: '⛔ 模型按安全策略拒绝继续',
    pause_turn: '⏸ 回合已暂停，等待续写指令',
  };
  function appendStopReasonChip(bubbleEl, stopReason) {
    if (!bubbleEl || !stopReason) return;
    // Avoid duplicating when stream and historical render race.
    const existing = bubbleEl.querySelector(`.bubble-foot-chip[data-stop="${stopReason}"]`);
    if (existing) return;
    const bubble = bubbleEl.querySelector('.msg-bubble');
    if (!bubble) return;
    const chip = document.createElement('div');
    chip.className = 'bubble-foot-chip';
    chip.dataset.stop = stopReason;
    chip.textContent = STOP_REASON_LABEL[stopReason] || `↪ ${stopReason}`;
    bubble.appendChild(chip);
  }

  // R41: self-designed expandable init card. Summary line stays identical to
  // the plain banner; clicking the header reveals MCP / tools / slash-command
  // detail rows. Reuses .msg.system[data-kind="init"] background so visual
  // identity with R36's data-kind styling is preserved.
  function buildInitCardElement(message, detail) {
    const el = createMsgElement('system', '');
    el.dataset.kind = 'init';
    el.classList.add('init-card');
    el.dataset.collapsed = 'true';
    const bubble = el.querySelector('.msg-bubble');
    bubble.textContent = '';
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'init-card-header';
    header.setAttribute('aria-expanded', 'false');
    header.innerHTML = `
      <span class="init-card-summary"></span>
      <span class="init-card-toggle" aria-hidden="true">▸</span>
    `;
    header.querySelector('.init-card-summary').textContent = message || '';
    bubble.appendChild(header);

    const body = document.createElement('div');
    body.className = 'init-card-body';

    const sections = [];
    if (Array.isArray(detail.mcpServers) && detail.mcpServers.length) {
      const sec = document.createElement('section');
      sec.className = 'init-card-section';
      const counts = detail.mcpServers.reduce((acc, s) => { acc[s.status] = (acc[s.status]||0)+1; return acc; }, {});
      const okN = counts.connected || 0;
      const failN = counts.failed || 0;
      sec.innerHTML = `<h4 class="init-card-h">MCP 服务 <span class="init-card-tally">${okN}/${detail.mcpServers.length} 已连接${failN ? ` · ${failN} 失败` : ''}</span></h4>`;
      const list = document.createElement('ul');
      list.className = 'init-card-mcp';
      for (const s of detail.mcpServers) {
        const li = document.createElement('li');
        li.className = 'init-card-mcp-row';
        li.dataset.status = s.status || 'unknown';
        li.innerHTML = `<span class="init-card-mcp-dot" aria-hidden="true"></span><span class="init-card-mcp-name"></span>${s.error ? '<span class="init-card-mcp-error"></span>' : ''}`;
        li.querySelector('.init-card-mcp-name').textContent = s.name || '(未命名)';
        if (s.error) li.querySelector('.init-card-mcp-error').textContent = s.error;
        list.appendChild(li);
      }
      sec.appendChild(list);
      sections.push(sec);
    }
    if (Array.isArray(detail.tools) && detail.tools.length) {
      const sec = document.createElement('section');
      sec.className = 'init-card-section';
      sec.innerHTML = `<h4 class="init-card-h">工具 <span class="init-card-tally">${detail.tools.length}</span></h4>`;
      const cloud = document.createElement('div');
      cloud.className = 'init-card-cloud';
      // First 18 chips visible; rest under "+N" toggle (self-designed, no native disclosure)
      const visible = detail.tools.slice(0, 18);
      const overflow = detail.tools.slice(18);
      for (const t of visible) {
        const span = document.createElement('span');
        span.className = 'init-card-chip';
        span.textContent = t;
        cloud.appendChild(span);
      }
      if (overflow.length) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'init-card-chip init-card-more';
        more.textContent = `+${overflow.length}`;
        more.title = '展开剩余';
        more.addEventListener('click', () => {
          for (const t of overflow) {
            const span = document.createElement('span');
            span.className = 'init-card-chip';
            span.textContent = t;
            cloud.insertBefore(span, more);
          }
          more.remove();
        });
        cloud.appendChild(more);
      }
      sec.appendChild(cloud);
      sections.push(sec);
    }
    if (Array.isArray(detail.slashCommands) && detail.slashCommands.length) {
      const sec = document.createElement('section');
      sec.className = 'init-card-section';
      const customN = detail.slashCommands.filter((c) => c.isCustom).length;
      sec.innerHTML = `<h4 class="init-card-h">斜杠指令 <span class="init-card-tally">${detail.slashCommands.length}${customN ? ` · ${customN} 自定义` : ''}</span></h4>`;
      const cloud = document.createElement('div');
      cloud.className = 'init-card-cloud';
      for (const c of detail.slashCommands) {
        const span = document.createElement('span');
        span.className = 'init-card-chip' + (c.isCustom ? ' init-card-chip-custom' : '');
        span.textContent = '/' + c.name;
        cloud.appendChild(span);
      }
      sec.appendChild(cloud);
      sections.push(sec);
    }
    // Meta row (api-key source, output-style)
    if (detail.apiKeySource || detail.outputStyle) {
      const meta = document.createElement('div');
      meta.className = 'init-card-meta';
      const segs = [];
      if (detail.apiKeySource) segs.push(`API: ${detail.apiKeySource}`);
      if (detail.outputStyle) segs.push(`Output: ${detail.outputStyle}`);
      meta.textContent = segs.join(' · ');
      sections.push(meta);
    }

    for (const s of sections) body.appendChild(s);
    bubble.appendChild(body);

    header.addEventListener('click', () => {
      const collapsed = el.dataset.collapsed === 'true';
      el.dataset.collapsed = collapsed ? 'false' : 'true';
      header.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
    });

    return el;
  }
  function appendInitCard(message, detail) {
    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();
    const el = buildInitCardElement(message, detail);
    messagesDiv.appendChild(el);
    scrollToBottom();
  }

  // --- Image lightbox (C): click any tool-result image → fullscreen overlay ---
  let _lightboxEl = null;
  function openLightbox(src) {
    closeLightbox();
    const overlay = document.createElement('div');
    overlay.className = 'image-lightbox';
    overlay.tabIndex = -1;
    overlay.innerHTML = `
      <img class="image-lightbox-img" src="${src.replace(/"/g, '&quot;')}" alt="">
      <button type="button" class="image-lightbox-close" aria-label="关闭">×</button>
    `;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.classList.contains('image-lightbox-close')) closeLightbox();
    });
    let scale = 1;
    overlay.addEventListener('wheel', (e) => {
      e.preventDefault();
      scale = Math.max(0.2, Math.min(8, scale * (e.deltaY < 0 ? 1.15 : 0.87)));
      const img = overlay.querySelector('.image-lightbox-img');
      if (img) img.style.transform = `scale(${scale})`;
    }, { passive: false });
    document.body.appendChild(overlay);
    _lightboxEl = overlay;
    overlay.focus();
  }
  function closeLightbox() {
    if (_lightboxEl) { _lightboxEl.remove(); _lightboxEl = null; }
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _lightboxEl) closeLightbox();
  });
  // Event delegation on messages container
  document.addEventListener('click', (e) => {
    const img = e.target.closest && e.target.closest('.tool-result-image');
    if (img && img.src) openLightbox(img.src);
  });

  // Stream stderr chunks from the CLI subprocess (E):
  // - each chunk prefixed with [HH:MM:SS]
  // - >3s silence OR >50 lines in current panel → start new panel
  let _stderrEl = null;
  let _stderrIdleTimer = null;
  let _stderrLineCount = 0;
  const STDERR_IDLE_MS = 3000;
  const STDERR_MAX_LINES = 50;
  function stderrTimestamp(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
  }
  function appendStderrChunk(text) {
    if (!text) return;
    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();
    const incomingLines = text.split('\n').filter((l) => l.length > 0);
    if (!incomingLines.length) return;
    const stamp = stderrTimestamp();
    const stamped = incomingLines.map((l) => `${stamp} ${l}`).join('\n') + '\n';
    if (!_stderrEl || !_stderrEl.isConnected || _stderrLineCount >= STDERR_MAX_LINES) {
      _stderrEl = document.createElement('details');
      _stderrEl.className = 'msg-stderr';
      _stderrEl.open = true;
      _stderrEl.innerHTML = `<summary class="msg-stderr-summary"><span class="msg-stderr-icon">⚠</span><span>CLI stderr · ${stamp}</span></summary><pre class="msg-stderr-body"></pre>`;
      messagesDiv.appendChild(_stderrEl);
      _stderrLineCount = 0;
    }
    const body = _stderrEl.querySelector('.msg-stderr-body');
    if (body) body.textContent += stamped;
    _stderrLineCount += incomingLines.length;
    scrollToBottom();
    if (_stderrIdleTimer) clearTimeout(_stderrIdleTimer);
    _stderrIdleTimer = setTimeout(() => {
      _stderrEl = null;
      _stderrIdleTimer = null;
      _stderrLineCount = 0;
    }, STDERR_IDLE_MS);
  }

  function appendError(message) {
    const div = document.createElement('div');
    div.className = 'msg system';
    div.innerHTML = `<div class="msg-bubble" style="border-color:var(--danger);color:var(--danger)">⚠ ${escapeHtml(message)}</div>`;
    messagesDiv.appendChild(div);
    scrollToBottom();
  }

  // Auto-scroll policy: if the user scrolled up to read earlier content,
  // don't yank them back on every text_delta / tool event during streaming.
  // Threshold: ~96px from the bottom counts as "intentionally reading older
  // content". `force=true` overrides (used when switching sessions).
  const SCROLL_PIN_THRESHOLD_PX = 96;
  function isAtBottom() {
    const dist = messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight;
    return dist <= SCROLL_PIN_THRESHOLD_PX;
  }
  function scrollToBottom(force) {
    if (!force && !isAtBottom()) {
      // User is reading earlier content — only refresh the custom scrollbar
      // so its thumb tracks new content height correctly.
      updateScrollbar();
      showScrollResumeHint();
      return;
    }
    hideScrollResumeHint();
    requestAnimationFrame(() => {
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
      updateScrollbar();
    });
  }
  // Floating "↓ 跳到底部" pill that appears when auto-scroll is suppressed
  // and disappears when the user scrolls back to the bottom themselves.
  let _scrollResumePill = null;
  function showScrollResumeHint() {
    if (_scrollResumePill && _scrollResumePill.isConnected) return;
    _scrollResumePill = document.createElement('button');
    _scrollResumePill.type = 'button';
    _scrollResumePill.className = 'scroll-resume-pill';
    _scrollResumePill.textContent = '↓ 新内容';
    _scrollResumePill.addEventListener('click', () => {
      hideScrollResumeHint();
      scrollToBottom(true);
    });
    const wrap = messagesDiv.parentElement || document.body;
    wrap.appendChild(_scrollResumePill);
  }
  function hideScrollResumeHint() {
    if (_scrollResumePill && _scrollResumePill.isConnected) _scrollResumePill.remove();
    _scrollResumePill = null;
  }
  // Also hide pill when user manually scrolls back to bottom
  messagesDiv.addEventListener('scroll', () => {
    if (_scrollResumePill && isAtBottom()) hideScrollResumeHint();
  }, { passive: true });

  // --- Custom Scrollbar ---
  const scrollbarEl = document.getElementById('custom-scrollbar');
  const thumbEl = document.getElementById('custom-scrollbar-thumb');

  function updateScrollbar() {
    if (!scrollbarEl || !thumbEl) return;
    const { scrollTop, scrollHeight, clientHeight } = messagesDiv;
    if (scrollHeight <= clientHeight) {
      thumbEl.style.display = 'none';
      return;
    }
    thumbEl.style.display = '';
    const trackH = scrollbarEl.clientHeight;
    const thumbH = Math.max(30, trackH * clientHeight / scrollHeight);
    const thumbTop = (scrollTop / (scrollHeight - clientHeight)) * (trackH - thumbH);
    thumbEl.style.height = thumbH + 'px';
    thumbEl.style.top = thumbTop + 'px';
  }

  messagesDiv.addEventListener('scroll', () => {
    updateScrollbar();
    // 移动端：滚动时短暂显示滑块，停止后淡出
    scrollbarEl.classList.add('scrolling');
    clearTimeout(scrollbarEl._hideTimer);
    scrollbarEl._hideTimer = setTimeout(() => {
      if (!isDragging) scrollbarEl.classList.remove('scrolling');
    }, 1200);
  }, { passive: true });
  new ResizeObserver(updateScrollbar).observe(messagesDiv);

  // Drag logic
  let dragStartY = 0, dragStartScrollTop = 0, isDragging = false;

  function onDragStart(e) {
    isDragging = true;
    dragStartY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
    dragStartScrollTop = messagesDiv.scrollTop;
    thumbEl.classList.add('dragging');
    scrollbarEl.classList.add('active');
    e.preventDefault();
  }

  function onDragMove(e) {
    if (!isDragging) return;
    const clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
    const dy = clientY - dragStartY;
    const { scrollHeight, clientHeight } = messagesDiv;
    const trackH = scrollbarEl.clientHeight;
    const thumbH = Math.max(30, trackH * clientHeight / scrollHeight);
    const ratio = (scrollHeight - clientHeight) / (trackH - thumbH);
    messagesDiv.scrollTop = dragStartScrollTop + dy * ratio;
    e.preventDefault();
  }

  function onDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    thumbEl.classList.remove('dragging');
    scrollbarEl.classList.remove('active');
  }

  thumbEl.addEventListener('mousedown', onDragStart);
  thumbEl.addEventListener('touchstart', onDragStart, { passive: false });
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('touchmove', onDragMove, { passive: false });
  document.addEventListener('mouseup', onDragEnd);
  document.addEventListener('touchend', onDragEnd);

  updateScrollbar();


  function renderSessionList() {
    sessionList.innerHTML = '';
    const visibleSessions = getVisibleSessions();
    if (visibleSessions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'session-list-empty';
      empty.textContent = `暂无 ${AGENT_LABELS[currentAgent]} 会话，点击“新会话”开始。`;
      sessionList.appendChild(empty);
      return;
    }

    for (const s of visibleSessions) {
      const item = document.createElement('div');
      item.className = `session-item${s.id === currentSessionId ? ' active' : ''}`;
      item.dataset.id = s.id;
      item.tabIndex = 0;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(s.id === currentSessionId));
      item.setAttribute('aria-label', `${s.title || 'Untitled'}${s.isRunning ? '，运行中' : ''}${s.hasUnread ? '，有未读消息' : ''}`);
      item.innerHTML = `
        <div class="session-item-main">
          <span class="session-item-title">${escapeHtml(s.title || 'Untitled')}</span>
          ${s.isRunning ? '<span class="session-item-status">运行中</span>' : ''}
        </div>
        ${s.hasUnread ? '<span class="session-unread-dot" role="status" aria-label="有未读消息"></span>' : ''}
        <span class="session-item-time">${timeAgo(s.updated)}</span>
        <div class="session-item-actions">
          <button class="session-item-btn edit" title="重命名" aria-label="重命名会话">✎</button>
          <button class="session-item-btn delete" title="删除" aria-label="删除会话">×</button>
        </div>
      `;
      item.addEventListener('keydown', (e) => {
        if (e.target !== item) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          item.click();
        }
      });

      item.addEventListener('click', (e) => {
        const target = e.target;
        if (target.classList.contains('delete')) {
          e.stopPropagation();
          const doDelete = () => {
            if (getLastSessionForAgent(currentAgent) === s.id) {
              localStorage.removeItem(getAgentSessionStorageKey(currentAgent));
            }
            invalidateSessionCache(s.id);
            send({ type: 'delete_session', sessionId: s.id });
            if (s.id === currentSessionId) {
              resetChatView(currentAgent);
            }
          };
          if (skipDeleteConfirm) {
            doDelete();
          } else {
            showDeleteConfirm(s.agent, doDelete);
          }
          return;
        }
        if (target.classList.contains('edit')) {
          e.stopPropagation();
          startEditSessionTitle(item, s);
          return;
        }
        openSession(s.id);
      });

      sessionList.appendChild(item);
    }
  }

  function startEditSessionTitle(itemEl, session) {
    const titleEl = itemEl.querySelector('.session-item-title');
    const currentTitle = session.title || '';
    const input = document.createElement('input');
    input.className = 'session-item-edit-input';
    input.value = currentTitle;
    input.maxLength = 100;

    titleEl.replaceWith(input);
    input.focus();
    input.select();

    // Hide actions during edit
    const actions = itemEl.querySelector('.session-item-actions');
    const time = itemEl.querySelector('.session-item-time');
    if (actions) actions.style.display = 'none';
    if (time) time.style.display = 'none';

    function save() {
      const newTitle = input.value.trim() || currentTitle;
      if (newTitle !== currentTitle) {
        send({ type: 'rename_session', sessionId: session.id, title: newTitle });
      }
      // Restore
      const span = document.createElement('span');
      span.className = 'session-item-title';
      span.textContent = newTitle;
      input.replaceWith(span);
      if (actions) actions.style.display = '';
      if (time) time.style.display = '';
    }

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = currentTitle; input.blur(); }
    });
  }

  function highlightActiveSession() {
    document.querySelectorAll('.session-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.id === currentSessionId);
    });
  }

  // --- Header title editing (contenteditable) ---
  chatTitle.addEventListener('click', () => {
    if (!currentSessionId || chatTitle.contentEditable === 'true') return;
    const originalText = chatTitle.textContent;
    chatTitle.contentEditable = 'true';
    chatTitle.style.background = '#fff';
    chatTitle.style.outline = '1px solid var(--accent)';
    chatTitle.style.borderRadius = '6px';
    chatTitle.style.padding = '2px 8px';
    chatTitle.style.minWidth = '96px';
    chatTitle.style.whiteSpace = 'normal';
    chatTitle.style.overflow = 'visible';
    chatTitle.style.textOverflow = 'clip';
    chatTitle.focus();
    // Select all text
    const range = document.createRange();
    range.selectNodeContents(chatTitle);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    function finish(save) {
      chatTitle.contentEditable = 'false';
      chatTitle.style.background = '';
      chatTitle.style.outline = '';
      chatTitle.style.borderRadius = '';
      chatTitle.style.padding = '';
      chatTitle.style.minWidth = '';
      chatTitle.style.whiteSpace = '';
      chatTitle.style.overflow = '';
      chatTitle.style.textOverflow = '';
      const newTitle = chatTitle.textContent.trim() || originalText;
      chatTitle.textContent = newTitle;
      if (save && newTitle !== originalText && currentSessionId) {
        send({ type: 'rename_session', sessionId: currentSessionId, title: newTitle });
      }
    }

    chatTitle.addEventListener('blur', () => finish(true), { once: true });
    chatTitle.addEventListener('keydown', function handler(e) {
      if (e.key === 'Enter') { e.preventDefault(); chatTitle.removeEventListener('keydown', handler); chatTitle.blur(); }
      if (e.key === 'Escape') { chatTitle.textContent = originalText; chatTitle.removeEventListener('keydown', handler); chatTitle.blur(); }
    });
  });

  // --- Sidebar ---
  function openSidebar() {
    sidebar.classList.add('open');
    sidebarOverlay.hidden = false;
  }
  function closeSidebar() {
    sidebar.classList.remove('open');
    sidebarOverlay.hidden = true;
  }

  function canOpenSidebarBySwipe(target) {
    if (!window.matchMedia('(max-width: 768px), (pointer: coarse)').matches) return false;
    if (sidebar.classList.contains('open')) return false;
    if (sessionLoadingOverlay && !sessionLoadingOverlay.hidden) return false;
    if (!chatMain || !target || !chatMain.contains(target)) return false;
    if (!app.hidden && target && target.closest('input, textarea, select, button, .modal-panel, .settings-panel, .option-picker, .cmd-menu')) {
      return false;
    }
    return true;
  }

  function canCloseSidebarBySwipe(target) {
    if (!window.matchMedia('(max-width: 768px), (pointer: coarse)').matches) return false;
    if (!sidebar.classList.contains('open')) return false;
    if (!target) return false;
    return sidebar.contains(target) || target === sidebarOverlay;
  }

  function handleSidebarSwipeStart(e) {
    if (!e.touches || e.touches.length !== 1) return;
    const touch = e.touches[0];
    if (canCloseSidebarBySwipe(e.target)) {
      sidebarSwipe = {
        startX: touch.clientX,
        startY: touch.clientY,
        active: true,
        mode: 'close',
      };
      return;
    }
    if (!canOpenSidebarBySwipe(e.target)) {
      sidebarSwipe = null;
      return;
    }
    sidebarSwipe = {
      startX: touch.clientX,
      startY: touch.clientY,
      active: true,
      mode: 'open',
    };
  }

  function handleSidebarSwipeMove(e) {
    if (!sidebarSwipe?.active || !e.touches || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const deltaX = touch.clientX - sidebarSwipe.startX;
    const deltaY = touch.clientY - sidebarSwipe.startY;
    if (Math.abs(deltaY) > SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT && Math.abs(deltaY) > Math.abs(deltaX)) {
      sidebarSwipe = null;
      return;
    }
    const horizontalIntent = sidebarSwipe.mode === 'open' ? deltaX > 12 : deltaX < -12;
    if (horizontalIntent && Math.abs(deltaY) < SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT) {
      e.preventDefault();
    }
  }

  function handleSidebarSwipeEnd(e) {
    if (!sidebarSwipe?.active) return;
    const touch = e.changedTouches && e.changedTouches[0];
    const endX = touch ? touch.clientX : sidebarSwipe.startX;
    const endY = touch ? touch.clientY : sidebarSwipe.startY;
    const deltaX = endX - sidebarSwipe.startX;
    const deltaY = endY - sidebarSwipe.startY;
    const shouldOpen = sidebarSwipe.mode === 'open' &&
      deltaX >= SIDEBAR_SWIPE_TRIGGER &&
      Math.abs(deltaY) <= SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT;
    const shouldClose = sidebarSwipe.mode === 'close' &&
      deltaX <= -SIDEBAR_SWIPE_TRIGGER &&
      Math.abs(deltaY) <= SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT;
    sidebarSwipe = null;
    if (shouldOpen) {
      openSidebar();
    } else if (shouldClose) {
      closeSidebar();
    }
  }

  // --- Slash Command Menu ---
  function showCmdMenu(filter) {
    const filtered = SLASH_COMMANDS.filter(c =>
      c.cmd.startsWith(filter) || c.desc.includes(filter.slice(1))
    );
    // Exact match first (fixes /mode vs /model ambiguity)
    filtered.sort((a, b) => (b.cmd === filter ? 1 : 0) - (a.cmd === filter ? 1 : 0));
    if (filtered.length === 0) {
      hideCmdMenu();
      return;
    }
    cmdMenuIndex = 0;
    cmdMenu.innerHTML = filtered.map((c, i) =>
      `<div class="cmd-item${i === 0 ? ' active' : ''}" data-cmd="${c.cmd}">
        <span class="cmd-item-cmd">${c.cmd}</span>
        <span class="cmd-item-desc">${c.desc}</span>
      </div>`
    ).join('');
    cmdMenu.hidden = false;

    // Click handlers
    cmdMenu.querySelectorAll('.cmd-item').forEach(el => {
      el.addEventListener('click', () => {
        const cmd = el.dataset.cmd;
        if (cmd === '/model') {
          hideCmdMenu();
          msgInput.value = '';
          showModelPicker();
          return;
        }
        if (cmd === '/mode') {
          hideCmdMenu();
          msgInput.value = '';
          showModePicker();
          return;
        }
        msgInput.value = cmd + ' ';
        hideCmdMenu();
        msgInput.focus();
      });
    });
  }

  function hideCmdMenu() {
    cmdMenu.hidden = true;
    cmdMenuIndex = -1;
  }

  function navigateCmdMenu(direction) {
    const items = cmdMenu.querySelectorAll('.cmd-item');
    if (items.length === 0) return;
    items[cmdMenuIndex]?.classList.remove('active');
    cmdMenuIndex = (cmdMenuIndex + direction + items.length) % items.length;
    items[cmdMenuIndex]?.classList.add('active');
  }

  function selectCmdMenuItem() {
    const items = cmdMenu.querySelectorAll('.cmd-item');
    if (cmdMenuIndex >= 0 && items[cmdMenuIndex]) {
      const cmd = items[cmdMenuIndex].dataset.cmd;
      if (cmd === '/model') {
        hideCmdMenu();
        msgInput.value = '';
        showModelPicker();
        return;
      }
      if (cmd === '/mode') {
        hideCmdMenu();
        msgInput.value = '';
        showModePicker();
        return;
      }
      msgInput.value = cmd + ' ';
      hideCmdMenu();
      msgInput.focus();
    }
  }

  // --- Option Picker (generic) ---
  function showOptionPicker(title, options, currentValue, onSelect) {
    hideOptionPicker();

    const picker = document.createElement('div');
    picker.className = 'option-picker';
    picker.id = 'option-picker';

    picker.innerHTML = `
      <div class="option-picker-title">${escapeHtml(title)}</div>
      ${options.map(opt => `
        <div class="option-picker-item${opt.value === currentValue ? ' active' : ''}" data-value="${opt.value}">
          <div class="option-picker-item-info">
            <div class="option-picker-item-label">${escapeHtml(opt.label)}</div>
            <div class="option-picker-item-desc">${escapeHtml(opt.desc)}</div>
          </div>
          ${opt.value === currentValue ? '<span class="option-picker-item-check">✓</span>' : ''}
        </div>
      `).join('')}
    `;

    const chatMain = document.querySelector('.chat-main');
    chatMain.appendChild(picker);

	    picker.querySelectorAll('.option-picker-item').forEach(el => {
	      el.addEventListener('click', () => {
	        // Close current picker first so onSelect can safely open a nested picker.
	        const v = el.dataset.value;
	        hideOptionPicker();
	        onSelect(v);
	      });
	    });

    // Close on outside click (delayed to avoid immediate close)
    setTimeout(() => {
      document.addEventListener('click', _pickerOutsideClick);
    }, 0);
    document.addEventListener('keydown', _pickerEscape);
  }

  function hideOptionPicker() {
    const picker = document.getElementById('option-picker');
    if (picker) picker.remove();
    document.removeEventListener('click', _pickerOutsideClick);
    document.removeEventListener('keydown', _pickerEscape);
  }

  function _pickerOutsideClick(e) {
    const picker = document.getElementById('option-picker');
    if (picker && !picker.contains(e.target)) {
      hideOptionPicker();
    }
  }

  function _pickerEscape(e) {
    if (e.key === 'Escape') {
      hideOptionPicker();
    }
  }

	  function showModelPicker() {
	    if (currentAgent === 'codex') {
	      const current = _splitCodexThinkingModel(currentModel || '');
	      const baseOptions = getCodexBaseModelOptions();
	      if (baseOptions.length === 0) {
	        appendSystemMessage('当前 Codex Profile 未配置 /model 候选列表。请先在设置 -> Codex API 配置中填写模型列表，或直接输入 /model <模型名>。');
	        return;
	      }
	      showOptionPicker('选择 Codex 模型', baseOptions, current.base || '', (baseValue) => {
	        const base = String(baseValue || '').trim();
	        const thinkingOptions = [
	          { value: '', label: '无 (默认)', desc: '不附加 (medium/high/xhigh) 后缀' },
	          { value: 'medium', label: 'medium', desc: '中等 thinking' },
	          { value: 'high', label: 'high', desc: '更强 thinking' },
	          { value: 'xhigh', label: 'xhigh', desc: '最强 thinking' },
	        ];
	        showOptionPicker('选择 Thinking 强度', thinkingOptions, current.level || '', (lvl) => {
	          const level = String(lvl || '').trim().toLowerCase();
	          const full = level ? `${base}(${level})` : base;
	          send({ type: 'message', text: `/model ${full}`, sessionId: currentSessionId, mode: currentMode, agent: currentAgent });
	        });
	      });
	      return;
	    }
	    showOptionPicker('选择模型', MODEL_OPTIONS, currentModel, (value) => {
	      send({ type: 'message', text: `/model ${value}`, sessionId: currentSessionId, mode: currentMode, agent: currentAgent });
    });
  }

  function showModePicker() {
    showOptionPicker('选择权限模式', MODE_PICKER_OPTIONS, currentMode, (value) => {
      currentMode = value;
      setModeSelectUI(currentMode);
      localStorage.setItem(getAgentModeStorageKey(currentAgent), currentMode);
      if (currentSessionId) {
        send({ type: 'set_mode', sessionId: currentSessionId, mode: currentMode });
      }
    });
  }

  // --- Send Message ---
  function sendMessage() {
    const text = msgInput.value.trim();
    if ((!text && pendingAttachments.length === 0) || isGenerating || isBlockingSessionLoad()) return;
    // WS health guard: send() silently drops when readyState !== 1.
    // Without this, on mobile background→foreground (visibilitychange→connect race)
    // or any reconnect window, the user types + hits Enter, the input/attachments
    // get cleared and the typing indicator appears, but the message never reaches
    // the server. The user is stuck in a fake "generating" state.
    if (!ws || ws.readyState !== 1) {
      appendError('连接尚未就绪，正在重连…请稍候再发送（输入框已为你保留）。');
      if (!ws || ws.readyState > 1) connect();
      return;
    }
    hideCmdMenu();
    hideOptionPicker();

    // Slash commands: don't show as user bubble
    if (text.startsWith('/')) {
      if (pendingAttachments.length > 0) {
        appendError('命令消息暂不支持附带图片，请先移除图片或发送普通消息。');
        return;
      }
      // /model without argument → show interactive picker
      if (text === '/model' || text === '/model ') {
        showModelPicker();
        msgInput.value = '';
        autoResize();
        return;
      }
      // /mode without argument → show interactive picker
      if (text === '/mode' || text === '/mode ') {
        showModePicker();
        msgInput.value = '';
        autoResize();
        return;
      }
      send({ type: 'message', text, sessionId: currentSessionId, mode: currentMode, agent: currentAgent });
      msgInput.value = '';
      autoResize();
      return;
    }

    // Regular message
    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();
    const attachments = pendingAttachments.map((attachment) => ({ ...attachment }));
    messagesDiv.appendChild(createMsgElement('user', text, attachments));
    scrollToBottom();

    send({ type: 'message', text, attachments, sessionId: currentSessionId, mode: currentMode, agent: currentAgent });
    msgInput.value = '';
    pendingAttachments = [];
    renderPendingAttachments();
    autoResize();
    startGenerating();
  }

  function autoResize() {
    msgInput.style.height = 'auto';
    const max = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--input-max-height')) || 200;
    msgInput.style.height = Math.min(msgInput.scrollHeight, max) + 'px';
  }

  function isMobileInputMode() {
    return window.matchMedia('(max-width: 768px), (pointer: coarse)').matches;
  }

  // --- Login UX (BEAUTY-1): immediate click feedback ---
  // Adds button loading state, ripple effect, disabled re-clicks, shake-on-fail,
  // ✓-on-success — fixes "press login → silence → not sure if it worked".
  let loginInFlight = false;
  function setLoginLoading(loading) {
    loginInFlight = !!loading;
    const btn = loginForm.querySelector('button[type="submit"]');
    if (!btn) return;
    if (loading) {
      btn.classList.add('is-loading');
      btn.disabled = true;
      btn.dataset.label = btn.dataset.label || btn.textContent || '登录';
      btn.innerHTML = '<span class="login-btn-spinner"></span><span class="login-btn-text">正在登录…</span>';
    } else {
      btn.classList.remove('is-loading');
      btn.disabled = false;
      btn.textContent = btn.dataset.label || '登录';
    }
  }
  function loginShake() {
    const box = document.querySelector('.login-box');
    if (!box) return;
    box.classList.remove('shake');
    void box.offsetWidth; // restart animation
    box.classList.add('shake');
  }
  function loginSuccess(then) {
    const box = document.querySelector('.login-box');
    if (box) {
      box.classList.add('login-success');
      setTimeout(() => {
        if (typeof then === 'function') then();
      }, 280);
    } else if (typeof then === 'function') {
      then();
    }
  }
  // Listen to auth_result to clear loading / shake / success
  document.addEventListener('cc-web-auth-restored', () => {
    loginSuccess(() => setLoginLoading(false));
  });
  document.addEventListener('cc-web-auth-failed', () => {
    setLoginLoading(false);
    loginShake();
  });

  // Material-style ripple on the submit button (and any [data-ripple] element)
  function attachRipple(el) {
    if (!el || el.dataset.rippleAttached) return;
    el.dataset.rippleAttached = '1';
    el.addEventListener('pointerdown', (e) => {
      const rect = el.getBoundingClientRect();
      const ripple = document.createElement('span');
      ripple.className = 'ripple';
      const size = Math.max(rect.width, rect.height) * 1.4;
      ripple.style.width = ripple.style.height = size + 'px';
      ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
      ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
      el.appendChild(ripple);
      ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
    });
  }
  attachRipple(loginForm.querySelector('button[type="submit"]'));

  // --- Event Listeners ---
  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (loginInFlight) return; // de-dupe rapid clicks
    const pw = loginPassword.value;
    if (!pw) {
      loginShake();
      loginPassword.focus();
      return;
    }
    loginError.hidden = true;
    loginPasswordValue = pw;
    // Remember password
    if (rememberPw.checked) {
      localStorage.setItem('cc-web-pw', pw);
    } else {
      localStorage.removeItem('cc-web-pw');
    }
    setLoginLoading(true);
    // Safety net: if no auth_result within 10s (network dead), stop spinner
    setTimeout(() => {
      if (loginInFlight) {
        setLoginLoading(false);
        loginError.textContent = '连接超时，请检查网络后重试。';
        loginError.hidden = false;
      }
    }, 10000);
    // BEAUTY-1 hotfix: page-load → user-types-fast → ws still CONNECTING.
    // send() silently drops if readyState !== 1, leaving login spinner stuck
    // until the 10s timeout. Wait for ws.open (or trigger reconnect) before
    // sending the auth payload.
    sendAuthWhenReady({ type: 'auth', password: pw });
    // Request notification permission on first user interaction
    requestNotificationPermission();
  });

  menuBtn.addEventListener('click', () => {
    sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
  });

  sidebarOverlay.addEventListener('click', closeSidebar);
  document.addEventListener('touchstart', handleSidebarSwipeStart, { passive: true });
  document.addEventListener('touchmove', handleSidebarSwipeMove, { passive: false });
  document.addEventListener('touchend', handleSidebarSwipeEnd, { passive: true });
  document.addEventListener('touchcancel', () => { sidebarSwipe = null; }, { passive: true });

  if (chatAgentBtn && chatAgentMenu) {
    chatAgentBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAgentMenu();
    });
    chatAgentMenu.querySelectorAll('.chat-agent-option').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAgentMenu();
        const targetAgent = normalizeAgent(btn.dataset.agent);
        if (targetAgent === currentAgent) return;
        syncViewForAgent(targetAgent, { preserveCurrent: false, loadLast: true });
      });
    });
  }

  // Export current session as Markdown
  const exportBtn = $('#export-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      try { exportCurrentSessionMarkdown(); }
      catch (e) { console.error('export failed', e); appendError('导出失败：' + (e?.message || e)); }
    });
  }

  // Split new-chat button
  newChatBtn.addEventListener('click', () => showNewSessionModal());
  newChatArrow.addEventListener('click', (e) => {
    e.stopPropagation();
    newChatDropdown.hidden = !newChatDropdown.hidden;
  });
  importSessionBtn.addEventListener('click', () => {
    newChatDropdown.hidden = true;
    if (currentAgent === 'codex') {
      showImportCodexSessionModal();
    } else {
      showImportSessionModal();
    }
  });
  document.addEventListener('click', (e) => {
    if (!newChatDropdown.hidden &&
        !newChatDropdown.contains(e.target) &&
        e.target !== newChatArrow) {
      newChatDropdown.hidden = true;
    }
    if (chatAgentMenu && !chatAgentMenu.hidden &&
        !chatAgentMenu.contains(e.target) &&
        e.target !== chatAgentBtn) {
      closeAgentMenu();
    }
  });
  sendBtn.addEventListener('click', sendMessage);
  abortBtn.addEventListener('click', () => send({ type: 'abort' }));
  if (attachBtn && imageUploadInput) {
    attachBtn.addEventListener('click', () => imageUploadInput.click());
    imageUploadInput.addEventListener('change', () => {
      handleSelectedImageFiles(imageUploadInput.files);
    });
  }
  if (inputWrapper) {
    inputWrapper.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      inputWrapper.classList.add('drag-active');
    });
    // dragleave fires for every child boundary; only clear when the cursor
    // truly left the wrapper (relatedTarget outside or null = left window).
    // Without this, drag-then-cancel over textarea/buttons leaves the
    // highlighted border stuck until next drag/drop or page reload.
    inputWrapper.addEventListener('dragleave', (e) => {
      const next = e.relatedTarget;
      if (!next || !inputWrapper.contains(next)) {
        inputWrapper.classList.remove('drag-active');
      }
    });
    inputWrapper.addEventListener('drop', (e) => {
      e.preventDefault();
      inputWrapper.classList.remove('drag-active');
      handleSelectedImageFiles(e.dataTransfer?.files);
    });
  }

  // Mode selector — custom pill + dropdown menu (REDESIGN-6 C1)
  const modeMenu = $('#mode-menu');
  const MODE_LABELS_LOCAL = { yolo: 'YOLO', default: '默认', plan: 'Plan' };
  function setModeSelectUI(mode) {
    if (!modeSelect) return;
    const safe = MODE_LABELS_LOCAL[mode] ? mode : 'yolo';
    modeSelect.dataset.mode = safe;
    const label = modeSelect.querySelector('.mode-pill-label');
    if (label) label.textContent = MODE_LABELS_LOCAL[safe];
    if (modeMenu) {
      modeMenu.querySelectorAll('.mode-option').forEach((b) => {
        b.classList.toggle('active', b.dataset.mode === safe);
      });
    }
  }
  function closeModeMenu() {
    if (!modeMenu || modeMenu.hidden) return;
    modeMenu.hidden = true;
    modeSelect.setAttribute('aria-expanded', 'false');
  }
  function toggleModeMenu() {
    if (!modeMenu || modeSelect.disabled) return;
    const willOpen = modeMenu.hidden;
    modeMenu.hidden = !willOpen;
    modeSelect.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  }
  setModeSelectUI(currentMode);
  modeSelect.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleModeMenu();
  });
  if (modeMenu) {
    modeMenu.addEventListener('click', (e) => {
      const opt = e.target.closest('.mode-option');
      if (!opt) return;
      const next = opt.dataset.mode;
      if (next && next !== currentMode) {
        currentMode = next;
        setModeSelectUI(currentMode);
        localStorage.setItem(getAgentModeStorageKey(currentAgent), currentMode);
        if (currentSessionId) {
          send({ type: 'set_mode', sessionId: currentSessionId, mode: currentMode });
        }
        if (currentMode === 'default') {
          appendSystemMessage('⚠ 由于项目设计与 CLI 原生逻辑不同，默认模式的授权申请功能暂未实现，建议搭配 Plan 或 YOLO 模式使用。');
        }
      }
      closeModeMenu();
    });
  }
  document.addEventListener('click', (e) => {
    if (!modeMenu || modeMenu.hidden) return;
    if (e.target.closest('#mode-select') || e.target.closest('#mode-menu')) return;
    closeModeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modeMenu && !modeMenu.hidden) closeModeMenu();
  });

  msgInput.addEventListener('input', () => {
    autoResize();
    const val = msgInput.value;
    // Show slash command menu
    if (val.startsWith('/') && !val.includes('\n')) {
      showCmdMenu(val);
    } else {
      hideCmdMenu();
    }
  });

  msgInput.addEventListener('keydown', (e) => {
    // Command menu navigation
    if (!cmdMenu.hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); navigateCmdMenu(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); navigateCmdMenu(-1); return; }
      if (e.key === 'Tab') { e.preventDefault(); selectCmdMenuItem(); return; }
      if (e.key === 'Escape') { hideCmdMenu(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // IME composition guard: when Chinese/Japanese/Korean IME is active,
      // Enter confirms the candidate word — never send the message.
      // (`isComposing` is the modern API; `keyCode === 229` is a legacy
      // signal still emitted by some Safari/Chrome versions during composition.)
      if (e.isComposing || e.keyCode === 229) return;
      if (isMobileInputMode()) {
        if (!cmdMenu.hidden) {
          e.preventDefault();
          selectCmdMenuItem();
        }
        return;
      }

      e.preventDefault();
      if (!cmdMenu.hidden) {
        // If menu is open and user presses Enter, select the item
        selectCmdMenuItem();
      } else {
        sendMessage();
      }
    }
  });

  msgInput.addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const files = items
      .filter((item) => item.kind === 'file' && /^image\//.test(item.type || ''))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length > 0) {
      e.preventDefault();
      handleSelectedImageFiles(files);
    }
  });

  // Close cmd menu on outside click
  document.addEventListener('click', (e) => {
    if (!cmdMenu.contains(e.target) && e.target !== msgInput) {
      hideCmdMenu();
    }
  });

  // --- Toast Notification ---
  function showToast(text, sessionId) {
    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.textContent = text;
    if (sessionId) {
      toast.style.cursor = 'pointer';
      toast.addEventListener('click', () => {
        openSession(sessionId);
        toast.remove();
      });
    }
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }

  // --- Browser Notification (via Service Worker for mobile) ---
  function showBrowserNotification(title) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then((reg) => {
        reg.showNotification('CC-Web', {
          body: `「${title}」任务完成`,
          tag: 'cc-web-task',
          renotify: true,
        });
      }).catch(() => {});
    }
  }

  function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  // --- Settings Panel ---
  let _onNotifyConfig = null;
  let _onNotifyTestResult = null;
  let _onModelConfig = null;
  let _onCodexConfig = null;
  let _onFetchModelsResult = null;
  let _onCodexSessions = null;
  let _onClaudeLocalConfig = null;
  let _onCodexLocalConfig = null;
  let _onDevConfig = null;

  const settingsBtn = $('#settings-btn');

  const PROVIDER_OPTIONS = [
    { value: 'off', label: '关闭' },
    { value: 'pushplus', label: 'PushPlus' },
    { value: 'telegram', label: 'Telegram' },
    { value: 'serverchan', label: 'Server酱' },
    { value: 'feishu', label: '飞书机器人' },
    { value: 'qqbot', label: 'QQ（Qmsg）' },
  ];

  function buildNotifyFieldsHtml(config, provider) {
    if (provider === 'pushplus') {
      return `
        <div class="settings-field">
          <label>Token</label>
          <input type="text" id="notify-pushplus-token" placeholder="PushPlus Token" value="${escapeHtml(config?.pushplus?.token || '')}">
        </div>
      `;
    }
    if (provider === 'telegram') {
      return `
        <div class="settings-field">
          <label>Bot Token</label>
          <input type="text" id="notify-tg-bottoken" placeholder="123456:ABC-DEF..." value="${escapeHtml(config?.telegram?.botToken || '')}">
        </div>
        <div class="settings-field">
          <label>Chat ID</label>
          <input type="text" id="notify-tg-chatid" placeholder="Chat ID" value="${escapeHtml(config?.telegram?.chatId || '')}">
        </div>
      `;
    }
    if (provider === 'serverchan') {
      return `
        <div class="settings-field">
          <label>SendKey</label>
          <input type="text" id="notify-sc-sendkey" placeholder="Server酱 SendKey" value="${escapeHtml(config?.serverchan?.sendKey || '')}">
        </div>
      `;
    }
    if (provider === 'feishu') {
      return `
        <div class="settings-field">
          <label>Webhook 地址</label>
          <input type="text" id="notify-feishu-webhook" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxx" value="${escapeHtml(config?.feishu?.webhook || '')}">
        </div>
      `;
    }
    if (provider === 'qqbot') {
      return `
        <div class="settings-field">
          <label>Qmsg Key</label>
          <input type="text" id="notify-qmsg-key" placeholder="Qmsg 推送 Key" value="${escapeHtml(config?.qqbot?.qmsgKey || '')}">
        </div>
      `;
    }
    return '';
  }

  function buildAgentContextCard(agent, title, copy) {
    const label = AGENT_LABELS[normalizeAgent(agent)] || AGENT_LABELS.claude;
    return `
      <div class="agent-context-card">
        <div class="agent-context-kicker">${escapeHtml(label)}</div>
        ${title ? `<div class="agent-context-title">${escapeHtml(title)}</div>` : ''}
        ${copy ? `<div class="agent-context-copy">${escapeHtml(copy)}</div>` : ''}
      </div>
    `;
  }

  function renderNotifyFields(fieldsDiv, config, provider) {
    fieldsDiv.innerHTML = buildNotifyFieldsHtml(config, provider);
  }

  function collectNotifyConfigFromPanel(panel, currentConfig, provider) {
    const pp = panel.querySelector('#notify-pushplus-token');
    const tgBot = panel.querySelector('#notify-tg-bottoken');
    const tgChat = panel.querySelector('#notify-tg-chatid');
    const sc = panel.querySelector('#notify-sc-sendkey');
    const feishuWh = panel.querySelector('#notify-feishu-webhook');
    const qmsgKey = panel.querySelector('#notify-qmsg-key');
    // Summary config
    const summaryEnabled = panel.querySelector('#notify-summary-enabled');
    const summaryTrigger = panel.querySelector('#notify-summary-trigger');
    const summarySource = panel.querySelector('#notify-summary-source');
    const summaryApiBase = panel.querySelector('#notify-summary-apibase');
    const summaryApiKey = panel.querySelector('#notify-summary-apikey');
    const summaryModel = panel.querySelector('#notify-summary-model');
    const cs = currentConfig?.summary || {};
    return {
      provider,
      pushplus: { token: pp ? pp.value.trim() : (currentConfig?.pushplus?.token || '') },
      telegram: {
        botToken: tgBot ? tgBot.value.trim() : (currentConfig?.telegram?.botToken || ''),
        chatId: tgChat ? tgChat.value.trim() : (currentConfig?.telegram?.chatId || ''),
      },
      serverchan: { sendKey: sc ? sc.value.trim() : (currentConfig?.serverchan?.sendKey || '') },
      feishu: { webhook: feishuWh ? feishuWh.value.trim() : (currentConfig?.feishu?.webhook || '') },
      qqbot: { qmsgKey: qmsgKey ? qmsgKey.value.trim() : (currentConfig?.qqbot?.qmsgKey || '') },
      summary: {
        enabled: summaryEnabled ? summaryEnabled.checked : !!cs.enabled,
        trigger: summaryTrigger ? summaryTrigger.value : (cs.trigger || 'background'),
        apiSource: summarySource ? summarySource.value : (cs.apiSource || 'claude'),
        apiBase: summaryApiBase ? summaryApiBase.value.trim() : (cs.apiBase || ''),
        apiKey: summaryApiKey ? summaryApiKey.value.trim() : (cs.apiKey || ''),
        model: summaryModel ? summaryModel.value.trim() : (cs.model || ''),
      },
    };
  }

  function buildSummarySettingsHtml(config) {
    const s = config?.summary || {};
    const enabled = !!s.enabled;
    const trigger = s.trigger || 'background';
    const src = s.apiSource || 'claude';
    const customVisible = src === 'custom' ? '' : 'display:none';
    return `
      <div class="settings-divider"></div>
      <div class="settings-section-title">通知摘要</div>
      <div class="settings-field" style="flex-direction:row;align-items:center;gap:10px">
        <label style="margin:0;flex:1">启用 AI 摘要</label>
        <input type="checkbox" id="notify-summary-enabled" ${enabled ? 'checked' : ''}>
      </div>
      <div id="notify-summary-options" style="${enabled ? '' : 'display:none'}">
        <div class="settings-field">
          <label>推送时机</label>
          <select class="settings-select" id="notify-summary-trigger">
            <option value="background" ${trigger === 'background' ? 'selected' : ''}>仅后台任务</option>
            <option value="always" ${trigger === 'always' ? 'selected' : ''}>所有任务</option>
          </select>
        </div>
        <div class="settings-field">
          <label>摘要 API 来源</label>
          <select class="settings-select" id="notify-summary-source">
            <option value="claude" ${src === 'claude' ? 'selected' : ''}>Claude 活跃模板</option>
            <option value="codex" ${src === 'codex' ? 'selected' : ''}>Codex 活跃 Profile</option>
            <option value="custom" ${src === 'custom' ? 'selected' : ''}>独立配置</option>
          </select>
        </div>
        <div id="notify-summary-custom" style="${customVisible}">
          <div class="settings-field">
            <label>API Base URL</label>
            <input type="text" id="notify-summary-apibase" placeholder="https://api.example.com" value="${escapeHtml(s.apiBase || '')}">
          </div>
          <div class="settings-field">
            <label>API Key</label>
            <input type="text" id="notify-summary-apikey" placeholder="sk-..." value="${escapeHtml(s.apiKey || '')}">
          </div>
          <div class="settings-field">
            <label>模型</label>
            <input type="text" id="notify-summary-model" placeholder="claude-opus-4-6" value="${escapeHtml(s.model || '')}">
          </div>
        </div>
      </div>
    `;
  }

  function bindSummarySettingsEvents(panel) {
    const enabledCb = panel.querySelector('#notify-summary-enabled');
    const optionsDiv = panel.querySelector('#notify-summary-options');
    const sourceSelect = panel.querySelector('#notify-summary-source');
    const customDiv = panel.querySelector('#notify-summary-custom');
    if (!enabledCb || !optionsDiv || !sourceSelect || !customDiv) return;
    enabledCb.addEventListener('change', () => {
      optionsDiv.style.display = enabledCb.checked ? '' : 'none';
    });
    sourceSelect.addEventListener('change', () => {
      customDiv.style.display = sourceSelect.value === 'custom' ? '' : 'none';
    });
  }

  function openPasswordModal() {
    const pwOverlay = document.createElement('div');
    pwOverlay.className = 'settings-overlay';
    pwOverlay.style.zIndex = '10001';
    const pwModal = document.createElement('div');
    pwModal.className = 'settings-panel';
    pwModal.style.maxWidth = '400px';
    pwModal.innerHTML = `
      <div class="settings-header">
        <h3>修改密码</h3>
        <button class="settings-close" id="pw-modal-close">&times;</button>
      </div>
      <div class="settings-field">
        <label>当前密码</label>
        <input type="password" id="pw-modal-current" placeholder="当前密码" autocomplete="current-password">
      </div>
      <div class="settings-field">
        <label>新密码</label>
        <input type="password" id="pw-modal-new" placeholder="新密码" autocomplete="new-password">
        <div class="password-hint" id="pw-modal-hint">至少 8 位，包含大写/小写/数字/特殊字符中的 2 种</div>
      </div>
      <div class="settings-field">
        <label>确认新密码</label>
        <input type="password" id="pw-modal-confirm" placeholder="确认新密码" autocomplete="new-password">
      </div>
      <div class="settings-actions">
        <button class="btn-save" id="pw-modal-submit" disabled>修改密码</button>
      </div>
      <div class="settings-status" id="pw-modal-status"></div>
    `;
    pwOverlay.appendChild(pwModal);
    document.body.appendChild(pwOverlay);

    const currentPwIn = pwModal.querySelector('#pw-modal-current');
    const newPwIn = pwModal.querySelector('#pw-modal-new');
    const confirmPwIn = pwModal.querySelector('#pw-modal-confirm');
    const hint = pwModal.querySelector('#pw-modal-hint');
    const submitBtn = pwModal.querySelector('#pw-modal-submit');
    const status = pwModal.querySelector('#pw-modal-status');

    function checkPw() {
      const newPw = newPwIn.value;
      const confirmPw = confirmPwIn.value;
      const currentPw = currentPwIn.value;
      if (!newPw) {
        hint.textContent = '至少 8 位，包含大写/小写/数字/特殊字符中的 2 种';
        hint.className = 'password-hint';
        submitBtn.disabled = true;
        return;
      }
      const result = clientValidatePassword(newPw);
      if (!result.valid) {
        hint.textContent = result.message;
        hint.className = 'password-hint error';
        submitBtn.disabled = true;
        return;
      }
      hint.textContent = '密码强度符合要求';
      hint.className = 'password-hint success';
      submitBtn.disabled = !currentPw || !confirmPw || confirmPw !== newPw;
    }

    currentPwIn.addEventListener('input', checkPw);
    newPwIn.addEventListener('input', checkPw);
    confirmPwIn.addEventListener('input', checkPw);

    const closePwModal = () => { document.body.removeChild(pwOverlay); };
    pwModal.querySelector('#pw-modal-close').addEventListener('click', closePwModal);
    pwOverlay.addEventListener('click', (e) => { if (e.target === pwOverlay) closePwModal(); });

    submitBtn.addEventListener('click', () => {
      const currentPw = currentPwIn.value;
      const newPw = newPwIn.value;
      const confirmPw = confirmPwIn.value;
      if (newPw !== confirmPw) {
        status.textContent = '两次密码不一致';
        status.className = 'settings-status error';
        return;
      }
      submitBtn.disabled = true;
      status.textContent = '正在修改...';
      status.className = 'settings-status';
      _onPasswordChanged = (result) => {
        if (result.success) {
          status.textContent = result.message || '密码修改成功';
          status.className = 'settings-status success';
          setTimeout(closePwModal, 1200);
        } else {
          status.textContent = result.message || '修改失败';
          status.className = 'settings-status error';
          submitBtn.disabled = false;
        }
      };
      send({ type: 'change_password', currentPassword: currentPw, newPassword: newPw });
    });

    currentPwIn.focus();
  }

  function showSettingsPanel() {
    send({ type: 'get_model_config' });
    send({ type: 'get_codex_config' });
    send({ type: 'get_notify_config' });

    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.id = 'settings-overlay';

    const panel = document.createElement('div');
    panel.className = 'settings-panel';

    panel.innerHTML = `
      <h3>
        ⚙ 设置
        <button class="settings-close" title="关闭">&times;</button>
      </h3>

      <div class="settings-section-title">Claude API 配置</div>
      <div id="claude-config-area"></div>
      <div class="settings-actions">
        <button class="btn-save" id="model-save-btn">保存 Claude 配置</button>
      </div>
      <div class="settings-status" id="model-status"></div>

      <div class="settings-divider"></div>

      <div class="settings-section-title">Codex API 配置</div>
      <div id="codex-config-area"></div>
      <div class="settings-actions">
        <button class="btn-save" id="codex-save-btn">保存 Codex 配置</button>
      </div>
      <div class="settings-status" id="codex-status"></div>

      <div class="settings-divider"></div>

      ${buildThemeEntryHtml()}

      <div class="settings-divider"></div>

      ${buildNotifyEntryHtml(null)}

      <div class="settings-divider"></div>

      <div class="settings-section-title">开发者</div>
      <button class="settings-nav-card" type="button" data-open-dev-page>
        <span class="settings-nav-card-main">
          <span class="settings-nav-card-title">开发者设置</span>
          <span class="settings-nav-card-meta">GitHub / SSH 配置</span>
        </span>
        <span class="settings-nav-card-arrow" aria-hidden="true">›</span>
      </button>

      <div class="settings-divider"></div>

      <div class="settings-section-title">系统</div>
      <div class="settings-actions" style="margin-top:0;flex-wrap:wrap;gap:10px">
        <button class="btn-test" id="pw-open-modal-btn" style="padding:6px 16px">修改密码</button>
        <button class="btn-test" id="check-update-btn" style="padding:6px 16px">检查更新</button>
      </div>
      <div class="settings-status" id="update-status" style="margin-top:8px"></div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    const themePageBtn = panel.querySelector('[data-open-theme-page]');
    if (themePageBtn) themePageBtn.addEventListener('click', openThemeSubpage);
    const notifyPageBtn2 = panel.querySelector('[data-open-notify-page]');
    if (notifyPageBtn2) notifyPageBtn2.addEventListener('click', openNotifySubpage);
    const devPageBtn = panel.querySelector('[data-open-dev-page]');
    if (devPageBtn) devPageBtn.addEventListener('click', openDevSettingsSubpage);

    // === Claude Config UI ===
    const claudeConfigArea = panel.querySelector('#claude-config-area');
    const modelStatusDiv = panel.querySelector('#model-status');
    const modelSaveBtn = panel.querySelector('#model-save-btn');

    let modelCurrentConfig = null;
    let modelEditingTemplates = [];
    let modelActiveTemplate = '';

    function showModelStatus(msg, type) {
      modelStatusDiv.textContent = msg;
      modelStatusDiv.className = 'settings-status ' + (type || '');
    }

    function renderClaudeConfigArea() {
      const isLocal = modelActiveTemplate === '';
      const tplOptions = modelEditingTemplates.map(t =>
        `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`
      ).join('');

      if (isLocal) {
        const hasSnapshot = modelCurrentConfig?.localSnapshot && Object.keys(modelCurrentConfig.localSnapshot).length > 0
          && (modelCurrentConfig.localSnapshot.apiKey || modelCurrentConfig.localSnapshot.apiBase);
        claudeConfigArea.innerHTML = `
          <div class="settings-field">
            <label>激活模板</label>
            <div style="display:flex;gap:6px;align-items:center">
              <select class="settings-select" id="claude-tpl-select" style="flex:1">
                <option value="__local__" selected>本地配置</option>
                ${tplOptions}
                <option value="__new__">+ 新建模板</option>
              </select>
              <button class="btn-test" id="claude-info-btn" style="padding:4px 10px">说明</button>
              <button class="btn-test" id="claude-read-local-btn" style="padding:4px 10px">读取当前配置</button>
              ${hasSnapshot ? '<button class="btn-test" id="claude-restore-btn" style="padding:4px 10px">恢复快照</button>' : ''}
            </div>
          </div>
          <div class="settings-inline-note">
            Agent 直接使用本机 <code>~/.claude/settings.json</code> 中的 API 信息，不会覆盖或修改本机配置。
          </div>
        `;
        panel.querySelector('#claude-tpl-select').addEventListener('change', async (e) => {
          if (e.target.value === '__new__') {
            const newName = await appPrompt('输入新模板名称:');
            if (!newName || !newName.trim()) { e.target.value = '__local__'; return; }
            const n = newName.trim();
            if (modelEditingTemplates.find(t => t.name === n)) { appAlert('模板名称已存在'); e.target.value = '__local__'; return; }
            modelEditingTemplates.push({ name: n, apiKey: '', apiBase: '', defaultModel: '', opusModel: '', sonnetModel: '', haikuModel: '' });
            modelActiveTemplate = n;
            renderClaudeConfigArea();
            openTplEditModal();
          } else {
            modelActiveTemplate = e.target.value;
            renderClaudeConfigArea();
          }
        });
        panel.querySelector('#claude-info-btn').addEventListener('click', showClaudeLocalInfoModal);
        panel.querySelector('#claude-read-local-btn').addEventListener('click', () => send({ type: 'read_claude_local_config' }));
        const restoreBtn = panel.querySelector('#claude-restore-btn');
        if (restoreBtn) restoreBtn.addEventListener('click', () => send({ type: 'restore_claude_local_snapshot' }));
        return;
      }

      // Custom template selected
      const tpl = modelEditingTemplates.find(t => t.name === modelActiveTemplate);
      const summary = tpl ? `API Key: <code>${tpl.apiKey ? '已设置' : '未设置'}</code> · Base: <code>${escapeHtml(tpl.apiBase || '默认')}</code>` : '';
      claudeConfigArea.innerHTML = `
        <div class="settings-field">
          <label>激活模板</label>
          <div style="display:flex;gap:6px;align-items:center">
            <select class="settings-select" id="claude-tpl-select" style="flex:1">
              <option value="__local__">本地配置</option>
              ${tplOptions}
              <option value="__new__">+ 新建模板</option>
            </select>
            <button class="btn-test" id="model-tpl-edit" style="padding:4px 10px">编辑</button>
            <button class="btn-test" id="model-tpl-del" title="删除" style="padding:4px 8px">删除</button>
          </div>
        </div>
        <div class="settings-inline-note">${summary}</div>
      `;

      panel.querySelector('#claude-tpl-select').addEventListener('change', async (e) => {
        if (e.target.value === '__new__') {
          const newName = await appPrompt('输入新模板名称:');
          if (!newName || !newName.trim()) { e.target.value = escapeHtml(modelActiveTemplate); return; }
          const n = newName.trim();
          if (modelEditingTemplates.find(t => t.name === n)) { appAlert('模板名称已存在'); e.target.value = escapeHtml(modelActiveTemplate); return; }
          modelEditingTemplates.push({ name: n, apiKey: '', apiBase: '', defaultModel: '', opusModel: '', sonnetModel: '', haikuModel: '' });
          modelActiveTemplate = n;
          renderClaudeConfigArea();
          openTplEditModal();
        } else if (e.target.value === '__local__') {
          modelActiveTemplate = '';
          renderClaudeConfigArea();
        } else {
          modelActiveTemplate = e.target.value;
          renderClaudeConfigArea();
        }
      });
      panel.querySelector('#model-tpl-edit').addEventListener('click', () => openTplEditModal());
      const delBtn = panel.querySelector('#model-tpl-del');
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          if (!modelActiveTemplate) return;
          if (!(await appConfirm(`确认删除模板「${modelActiveTemplate}」?`))) return;
          modelEditingTemplates = modelEditingTemplates.filter(t => t.name !== modelActiveTemplate);
          modelActiveTemplate = modelEditingTemplates[0]?.name || '';
          renderClaudeConfigArea();
        });
      }
    }

    function openTplEditModal() {
      const tpl = modelEditingTemplates.find(t => t.name === modelActiveTemplate);
      if (!tpl) return;
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>编辑模板: ${escapeHtml(tpl.name)}</h3>
          <button class="settings-close" id="tpl-modal-close">&times;</button>
        </div>
        <div class="settings-field">
          <label>模板名称</label>
          <input type="text" id="tpl-ed-name" value="${escapeHtml(tpl.name)}">
        </div>
        <div class="settings-field">
          <label>API Key</label>
          <input type="text" id="tpl-ed-apikey" placeholder="sk-ant-..." value="${escapeHtml(tpl.apiKey || '')}">
        </div>
        <div class="settings-field">
          <label>API Base URL</label>
          <input type="text" id="tpl-ed-apibase" placeholder="https://api.anthropic.com" value="${escapeHtml(tpl.apiBase || '')}">
        </div>
        <div class="settings-divider" style="margin:12px 0"></div>
        <div class="settings-field">
          <label style="display:flex;align-items:center;gap:8px;font-weight:600">获取上游模型列表</label>
          <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
            <label style="font-size:0.85em;display:flex;align-items:center;gap:4px;cursor:pointer">
              <input type="checkbox" id="tpl-ed-custom-endpoint"> 端点
            </label>
            <input type="text" id="tpl-ed-models-endpoint" placeholder="/v1/models" style="flex:1;display:none" value="">
          </div>
          <div style="display:flex;gap:6px;margin-top:6px;align-items:center">
            <button class="btn-test" id="tpl-ed-fetch-models" style="padding:4px 12px;white-space:nowrap">获取模型</button>
            <span id="tpl-ed-fetch-status" style="font-size:0.85em;color:var(--text-secondary)"></span>
          </div>
        </div>
        <div class="settings-divider" style="margin:12px 0"></div>
        <div class="settings-field">
          <label>默认模型 (ANTHROPIC_MODEL)</label>
          <input type="text" id="tpl-ed-default" list="tpl-dl-models" placeholder="claude-opus-4-6" value="${escapeHtml(tpl.defaultModel || '')}" autocomplete="off">
        </div>
        <div class="settings-field">
          <label>Opus 模型名</label>
          <input type="text" id="tpl-ed-opus" list="tpl-dl-models" placeholder="claude-opus-4-6" value="${escapeHtml(tpl.opusModel || '')}" autocomplete="off">
        </div>
        <div class="settings-field">
          <label>Sonnet 模型名</label>
          <input type="text" id="tpl-ed-sonnet" list="tpl-dl-models" placeholder="claude-sonnet-4-6" value="${escapeHtml(tpl.sonnetModel || '')}" autocomplete="off">
        </div>
        <div class="settings-field">
          <label>Haiku 模型名</label>
          <input type="text" id="tpl-ed-haiku" list="tpl-dl-models" placeholder="claude-haiku-4-5-20251001" value="${escapeHtml(tpl.haikuModel || '')}" autocomplete="off">
        </div>
        <datalist id="tpl-dl-models"></datalist>
        <div class="settings-actions">
          <button class="btn-save" id="tpl-ed-ok">确定</button>
        </div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const customEndpointCb = modal.querySelector('#tpl-ed-custom-endpoint');
      const endpointInput = modal.querySelector('#tpl-ed-models-endpoint');
      customEndpointCb.addEventListener('change', () => {
        endpointInput.style.display = customEndpointCb.checked ? '' : 'none';
      });
      const fetchBtn = modal.querySelector('#tpl-ed-fetch-models');
      const fetchStatus = modal.querySelector('#tpl-ed-fetch-status');
      const datalist = modal.querySelector('#tpl-dl-models');
      fetchBtn.addEventListener('click', () => {
        const apiBase = modal.querySelector('#tpl-ed-apibase').value.trim();
        const apiKey = modal.querySelector('#tpl-ed-apikey').value.trim();
        if (!apiBase || !apiKey) {
          fetchStatus.textContent = '请先填写 API Base 和 API Key';
          fetchStatus.style.color = 'var(--text-error, #e85d5d)';
          return;
        }
        const modelsEndpoint = customEndpointCb.checked ? endpointInput.value.trim() : '';
        fetchBtn.disabled = true;
        fetchStatus.textContent = '正在获取...';
        fetchStatus.style.color = 'var(--text-secondary)';
        _onFetchModelsResult = (result) => {
          _onFetchModelsResult = null;
          fetchBtn.disabled = false;
          if (result.success) {
            datalist.innerHTML = result.models.map(m => `<option value="${escapeHtml(m)}">`).join('');
            fetchStatus.textContent = `获取到 ${result.models.length} 个模型`;
            fetchStatus.style.color = 'var(--text-success, #5dbe5d)';
          } else {
            fetchStatus.textContent = result.message || '获取失败';
            fetchStatus.style.color = 'var(--text-error, #e85d5d)';
          }
        };
        send({ type: 'fetch_models', apiBase, apiKey, modelsEndpoint: modelsEndpoint || undefined, templateName: tpl.name });
      });
      const closeModal = () => {
        _onFetchModelsResult = null;
        document.body.removeChild(modalOverlay);
      };
      modal.querySelector('#tpl-modal-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#tpl-ed-ok').addEventListener('click', () => {
        const newName = modal.querySelector('#tpl-ed-name').value.trim();
        if (newName && newName !== tpl.name) {
          if (modelEditingTemplates.find(t => t.name === newName && t !== tpl)) { appAlert('模板名称已存在'); return; }
          tpl.name = newName;
          modelActiveTemplate = newName;
        }
        tpl.apiKey = modal.querySelector('#tpl-ed-apikey').value.trim();
        tpl.apiBase = modal.querySelector('#tpl-ed-apibase').value.trim();
        tpl.defaultModel = modal.querySelector('#tpl-ed-default').value.trim();
        tpl.opusModel = modal.querySelector('#tpl-ed-opus').value.trim();
        tpl.sonnetModel = modal.querySelector('#tpl-ed-sonnet').value.trim();
        tpl.haikuModel = modal.querySelector('#tpl-ed-haiku').value.trim();
        closeModal();
        renderClaudeConfigArea();
      });
    }

    function showClaudeLocalInfoModal() {
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>本地配置说明</h3>
          <button class="settings-close" id="claude-info-close">&times;</button>
        </div>
        <div class="settings-inline-note">
          选中"本地配置"时，Agent 直接使用本机原生配置文件中的 API 信息，不会覆盖或修改本机配置。
          <br><br>
          <strong>• Claude：</strong>切换到自定义模板时，本机 ~/.claude/settings.json 中的 API 配置会被替换为模板值。再次切回"本地配置"时，可一键恢复之前保存的快照到 settings.json。
          <br><br>
          <strong>• Codex：</strong>自定义模板不会修改本机 ~/.codex/，切回"本地配置"时自动恢复本机直通，无需恢复操作。
        </div>
        <div class="settings-actions">
          <button class="btn-save" id="claude-info-ok">确定</button>
        </div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#claude-info-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#claude-info-ok').addEventListener('click', closeModal);
    }

    modelSaveBtn.addEventListener('click', () => {
      const isLocal = modelActiveTemplate === '';
      const config = {
        mode: isLocal ? 'local' : 'custom',
        activeTemplate: isLocal ? '' : modelActiveTemplate,
        templates: modelEditingTemplates,
        localSnapshot: modelCurrentConfig?.localSnapshot || {},
      };
      send({ type: 'save_model_config', config });
      showModelStatus('已保存', 'success');
    });

    _onModelConfig = (config) => {
      modelCurrentConfig = config;
      modelEditingTemplates = (config.templates || []).map(t => Object.assign({}, t));
      if (config.mode === 'local') {
        modelActiveTemplate = '';
      } else {
        modelActiveTemplate = config.activeTemplate || (modelEditingTemplates[0]?.name || '');
      }
      renderClaudeConfigArea();
    };

    _onClaudeLocalConfig = (msg) => {
      const config = msg.config || {};
      const hasData = config.apiKey || config.apiBase;
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      const fields = [
        ['API Key', config.apiKey || '(空)'],
        ['API Base URL', config.apiBase || '(空)'],
        ['默认模型', config.defaultModel || '(空)'],
        ['Opus 模型', config.opusModel || '(空)'],
        ['Sonnet 模型', config.sonnetModel || '(空)'],
        ['Haiku 模型', config.haikuModel || '(空)'],
      ];
      modal.innerHTML = `
        <div class="settings-header">
          <h3>当前 Claude 本地配置</h3>
          <button class="settings-close" id="read-local-close">&times;</button>
        </div>
        ${msg.sourceFound ? '' : '<div class="settings-inline-note" style="color:var(--text-warning, #e8a838)">未找到 ~/.claude/settings.json，以下为空值。</div>'}
        ${fields.map(([label, val]) => `
          <div class="settings-field">
            <label>${label}</label>
            <div style="font-size:0.9em;word-break:break-all;color:var(--text-secondary)">${escapeHtml(val)}</div>
          </div>
        `).join('')}
        ${hasData ? '<div class="settings-actions"><button class="btn-save" id="save-snapshot-btn">保存为快照</button></div>' : ''}
        <div class="settings-actions"><button class="btn-save" id="read-local-ok">关闭</button></div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#read-local-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#read-local-ok').addEventListener('click', closeModal);
      const saveBtn = modal.querySelector('#save-snapshot-btn');
      if (saveBtn) {
        saveBtn.addEventListener('click', () => {
          send({ type: 'save_local_snapshot', snapshot: config });
          closeModal();
        });
      }
    };

    // === Codex Config UI ===
    const codexConfigArea = panel.querySelector('#codex-config-area');
    const codexStatus = panel.querySelector('#codex-status');
    const codexSaveBtn = panel.querySelector('#codex-save-btn');

    let currentCodexConfig = null;
    let codexEditingProfiles = [];
    let codexActiveProfile = '';

    function showCodexStatus(msg, type) {
      codexStatus.textContent = msg;
      codexStatus.className = 'settings-status ' + (type || '');
    }

    function renderCodexConfigArea() {
      const isLocal = codexActiveProfile === '';
      const profileOptions = codexEditingProfiles.map((profile) =>
        `<option value="${escapeHtml(profile.name)}"${profile.name === codexActiveProfile ? ' selected' : ''}>${escapeHtml(profile.name)}</option>`
      ).join('');

      if (isLocal) {
        codexConfigArea.innerHTML = `
          <div class="settings-field">
            <label>激活 Profile</label>
            <div style="display:flex;gap:6px;align-items:center">
              <select class="settings-select" id="codex-profile-select" style="flex:1">
                <option value="__local__" selected>本地配置</option>
                ${profileOptions}
                <option value="__new__">+ 新建 Profile</option>
              </select>
              <button class="btn-test" id="codex-info-btn" style="padding:4px 10px">说明</button>
              <button class="btn-test" id="codex-read-local-btn" style="padding:4px 10px">读取当前配置</button>
            </div>
          </div>
          <div class="settings-inline-note">
            直接复用本机 <code>codex</code> 的登录态与 <code>~/.codex/config.toml</code>。
          </div>
        `;
        panel.querySelector('#codex-profile-select').addEventListener('change', (e) => {
          if (e.target.value === '__new__') {
            openCodexProfileModal();
          } else if (e.target.value === '__local__') {
            codexActiveProfile = '';
            renderCodexConfigArea();
          } else {
            codexActiveProfile = e.target.value;
            renderCodexConfigArea();
          }
        });
        panel.querySelector('#codex-info-btn').addEventListener('click', showClaudeLocalInfoModal);
        panel.querySelector('#codex-read-local-btn').addEventListener('click', () => send({ type: 'read_codex_local_config' }));
        return;
      }

      // Custom profile selected
      const currentProfileRaw = codexEditingProfiles.find((profile) => profile.name === codexActiveProfile);
      const currentProfile = currentProfileRaw ? normalizeCodexProfile(currentProfileRaw) : null;
      const summaryBase = currentProfile?.apiBase ? escapeHtml(currentProfile.apiBase) : '默认';
      const summaryModel = currentProfile?.model ? escapeHtml(currentProfile.model) : '未设置';
      const summaryModelsCount = Array.isArray(currentProfile?.models) ? currentProfile.models.length : 0;

      codexConfigArea.innerHTML = `
        <div class="settings-field">
          <label>激活 Profile</label>
          <div style="display:flex;gap:6px;align-items:center">
            <select class="settings-select" id="codex-profile-select" style="flex:1">
              <option value="__local__">本地配置</option>
              ${profileOptions}
              <option value="__new__">+ 新建 Profile</option>
            </select>
            <button class="btn-test" id="codex-profile-edit" style="padding:4px 10px">编辑</button>
            <button class="btn-test" id="codex-profile-del" title="删除" style="padding:4px 8px">删除</button>
          </div>
        </div>
        <div class="settings-inline-note">
          当前 Profile：<strong>${escapeHtml(currentProfile?.name || '未选择')}</strong> · API Base：<code>${summaryBase}</code> · 默认模型：<code>${summaryModel}</code> · /model 候选：<code>${summaryModelsCount}</code> 项
        </div>
      `;

      panel.querySelector('#codex-profile-select').addEventListener('change', (e) => {
        if (e.target.value === '__new__') {
          openCodexProfileModal();
        } else if (e.target.value === '__local__') {
          codexActiveProfile = '';
          renderCodexConfigArea();
        } else {
          codexActiveProfile = e.target.value;
          renderCodexConfigArea();
        }
      });
      panel.querySelector('#codex-profile-edit').addEventListener('click', () => {
        openCodexProfileModal(codexActiveProfile);
      });
      panel.querySelector('#codex-profile-del').addEventListener('click', async () => {
        if (!codexActiveProfile) return;
        if (!(await appConfirm(`确认删除 Codex Profile「${codexActiveProfile}」?`))) return;
        codexEditingProfiles = codexEditingProfiles.filter((profile) => profile.name !== codexActiveProfile);
        codexActiveProfile = codexEditingProfiles[0]?.name || '';
        renderCodexConfigArea();
      });
    }

    function openCodexProfileModal(profileName = '') {
      const current = profileName
        ? codexEditingProfiles.find((profile) => profile.name === profileName)
        : null;
      const draft = current ? normalizeCodexProfile(current) : { name: '', apiKey: '', apiBase: '', model: '', models: [] };
      const initialModelListText = Array.isArray(draft.models) ? draft.models.join('\n') : '';
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>${current ? `编辑 Profile: ${escapeHtml(current.name)}` : '新建 Codex Profile'}</h3>
          <button class="settings-close" id="codex-profile-modal-close">&times;</button>
        </div>
        <div class="settings-field">
          <label>Profile 名称</label>
          <input type="text" id="codex-profile-name" placeholder="例如 OpenRouter Work" value="${escapeHtml(draft.name || '')}">
        </div>
        <div class="settings-field">
          <label>API Key</label>
          <input type="text" id="codex-profile-apikey" placeholder="sk-..." value="${escapeHtml(draft.apiKey || '')}">
        </div>
        <div class="settings-field">
          <label>API Base URL</label>
          <input type="text" id="codex-profile-apibase" placeholder="https://api.openai.com/v1" value="${escapeHtml(draft.apiBase || '')}">
        </div>
        <div class="settings-divider" style="margin:12px 0"></div>
        <div class="settings-field">
          <label style="display:flex;align-items:center;gap:8px;font-weight:600">获取上游模型列表</label>
          <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
            <label style="font-size:0.85em;display:flex;align-items:center;gap:4px;cursor:pointer">
              <input type="checkbox" id="codex-profile-custom-endpoint"> 端点
            </label>
            <input type="text" id="codex-profile-models-endpoint" placeholder="/v1/models" style="flex:1;display:none" value="">
          </div>
          <div style="display:flex;gap:6px;margin-top:6px;align-items:center">
            <button class="btn-test" id="codex-profile-fetch-models" style="padding:4px 12px;white-space:nowrap">获取模型</button>
            <span id="codex-profile-fetch-status" style="font-size:0.85em;color:var(--text-secondary)"></span>
          </div>
        </div>
        <div class="settings-divider" style="margin:12px 0"></div>
        <div class="settings-field">
          <label>默认模型</label>
          <input type="text" id="codex-profile-model" list="codex-profile-dl-models" placeholder="gpt-5.5" value="${escapeHtml(draft.model || '')}" autocomplete="off">
        </div>
        <datalist id="codex-profile-dl-models"></datalist>
        <div class="settings-field">
          <label>/model 候选列表</label>
          <textarea id="codex-profile-model-list" rows="7" placeholder="每行一个模型，例如&#10;gpt-5.5&#10;gpt-5.4&#10;gpt-5.3-codex" style="resize:vertical">${escapeHtml(initialModelListText)}</textarea>
        </div>
        <div class="settings-inline-note">
          默认模型会用于新会话；<code>/model</code> 弹出的候选项只来自这里配置的列表。
        </div>
        <div class="settings-actions">
          <button class="btn-save" id="codex-profile-ok">确定</button>
        </div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const customEndpointCb = modal.querySelector('#codex-profile-custom-endpoint');
      const endpointInput = modal.querySelector('#codex-profile-models-endpoint');
      const fetchBtn = modal.querySelector('#codex-profile-fetch-models');
      const fetchStatus = modal.querySelector('#codex-profile-fetch-status');
      const datalist = modal.querySelector('#codex-profile-dl-models');
      const defaultModelInput = modal.querySelector('#codex-profile-model');
      const modelListTextarea = modal.querySelector('#codex-profile-model-list');
      customEndpointCb.addEventListener('change', () => {
        endpointInput.style.display = customEndpointCb.checked ? '' : 'none';
      });
      fetchBtn.addEventListener('click', async () => {
        const apiBase = modal.querySelector('#codex-profile-apibase').value.trim();
        const apiKey = modal.querySelector('#codex-profile-apikey').value.trim();
        if (!apiBase || !apiKey) {
          fetchStatus.textContent = '请先填写 API Base 和 API Key';
          fetchStatus.style.color = 'var(--text-error, #e85d5d)';
          return;
        }
        const modelsEndpoint = customEndpointCb.checked ? endpointInput.value.trim() : '';
        fetchBtn.disabled = true;
        fetchStatus.textContent = '正在获取...';
        fetchStatus.style.color = 'var(--text-secondary)';
        _onFetchModelsResult = async (result) => {
          _onFetchModelsResult = null;
          fetchBtn.disabled = false;
          if (result.success) {
            datalist.innerHTML = result.models.map((m) => `<option value="${escapeHtml(m)}">`).join('');
            const fetchedText = result.models.join('\n');
            const currentText = modelListTextarea.value.trim();
            if (!currentText) {
              modelListTextarea.value = fetchedText;
            } else if (currentText !== fetchedText && await appConfirm('是否使用拉取结果覆盖当前 /model 候选列表？')) {
              modelListTextarea.value = fetchedText;
            }
            if (!defaultModelInput.value.trim() && result.models[0]) {
              defaultModelInput.value = result.models[0];
            }
            fetchStatus.textContent = `获取到 ${result.models.length} 个模型`;
            fetchStatus.style.color = 'var(--text-success, #5dbe5d)';
          } else {
            fetchStatus.textContent = result.message || '获取失败';
            fetchStatus.style.color = 'var(--text-error, #e85d5d)';
          }
        };
        send({
          type: 'fetch_models',
          apiBase,
          apiKey,
          modelsEndpoint: modelsEndpoint || undefined,
          profileName: current?.name || modal.querySelector('#codex-profile-name').value.trim(),
        });
      });
      const closeModal = () => {
        _onFetchModelsResult = null;
        document.body.removeChild(modalOverlay);
      };
      modal.querySelector('#codex-profile-modal-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#codex-profile-ok').addEventListener('click', () => {
        const name = modal.querySelector('#codex-profile-name').value.trim();
        const apiKey = modal.querySelector('#codex-profile-apikey').value.trim();
        const apiBase = modal.querySelector('#codex-profile-apibase').value.trim();
        const model = defaultModelInput.value.trim();
        const models = _parseCodexModelListText(modelListTextarea.value);
        if (!name) { appAlert('请填写 Profile 名称'); return; }
        if (!apiKey) { appAlert('请填写 API Key'); return; }
        if (!apiBase) { appAlert('请填写 API Base URL'); return; }
        if (!model) { appAlert('请填写模型'); return; }
        if (!models.length) { appAlert('请至少填写一个 /model 候选模型'); return; }
        if (!models.includes(model)) models.unshift(model);
        const existing = codexEditingProfiles.find((profile) => profile.name === name);
        if (existing && existing !== current) { appAlert('Profile 名称已存在'); return; }
        if (current) {
          current.name = name;
          current.apiKey = apiKey;
          current.apiBase = apiBase;
          current.model = model;
          current.models = models;
        } else {
          codexEditingProfiles.push({ name, apiKey, apiBase, model, models });
        }
        codexActiveProfile = name;
        closeModal();
        renderCodexConfigArea();
      });
    }

    _onCodexConfig = (config) => {
      currentCodexConfig = config || {};
      codexEditingProfiles = (currentCodexConfig.profiles || []).map((profile) => normalizeCodexProfile(profile));
      if (currentCodexConfig.mode === 'local') {
        codexActiveProfile = '';
      } else {
        codexActiveProfile = currentCodexConfig.activeProfile || (codexEditingProfiles[0]?.name || '');
      }
      renderCodexConfigArea();
    };

    codexSaveBtn.addEventListener('click', () => {
      const isLocal = codexActiveProfile === '';
      if (!isLocal && codexEditingProfiles.length === 0) {
        showCodexStatus('自定义模式至少需要一个 Codex Profile', 'error');
        return;
      }
      const config = {
        mode: isLocal ? 'local' : 'custom',
        activeProfile: isLocal ? '' : codexActiveProfile,
        profiles: codexEditingProfiles,
        enableSearch: false,
        localSnapshot: currentCodexConfig?.localSnapshot || {},
      };
      send({ type: 'save_codex_config', config });
      showCodexStatus('已保存', 'success');
    });

    _onCodexLocalConfig = (msg) => {
      const config = msg.config || {};
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      const fields = [
        ['API Key', config.apiKey || '(空)'],
        ['API Base URL', config.apiBase || '(空)'],
        ['模型', config.model || '(空)'],
      ];
      modal.innerHTML = `
        <div class="settings-header">
          <h3>当前 Codex 本地配置</h3>
          <button class="settings-close" id="read-codex-local-close">&times;</button>
        </div>
        ${msg.warning ? `<div class="settings-inline-note" style="color:var(--text-warning, #e8a838)">${escapeHtml(msg.warning)}</div>` : ''}
        ${!msg.sourceFound ? '<div class="settings-inline-note" style="color:var(--text-warning, #e8a838)">未找到 ~/.codex/ 配置文件。</div>' : ''}
        ${fields.map(([label, val]) => `
          <div class="settings-field">
            <label>${label}</label>
            <div style="font-size:0.9em;word-break:break-all;color:var(--text-secondary)">${escapeHtml(val)}</div>
          </div>
        `).join('')}
        <div class="settings-actions"><button class="btn-save" id="read-codex-local-ok">关闭</button></div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#read-codex-local-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#read-codex-local-ok').addEventListener('click', closeModal);
    };

    // === System UI ===
    const closeBtn = panel.querySelector('.settings-close');
    const pwOpenModalBtn = panel.querySelector('#pw-open-modal-btn');
    pwOpenModalBtn.addEventListener('click', openPasswordModal);

    // Check update button
    const checkUpdateBtn = panel.querySelector('#check-update-btn');
    const updateStatusEl = panel.querySelector('#update-status');
    let _onUpdateInfo = null;
    checkUpdateBtn.addEventListener('click', () => {
      updateStatusEl.textContent = '正在检查...';
      updateStatusEl.className = 'settings-status';
      _onUpdateInfo = (info) => {
        _onUpdateInfo = null;
        if (info.error) {
          updateStatusEl.textContent = '检查失败: ' + info.error;
          updateStatusEl.className = 'settings-status error';
          return;
        }
        if (info.hasUpdate) {
          updateStatusEl.innerHTML = `有新版本 <strong>v${escapeHtml(info.latestVersion)}</strong>（当前 v${escapeHtml(info.localVersion)}）&nbsp;<a href="${escapeHtml(info.releaseUrl)}" target="_blank" style="color:var(--accent)">查看更新</a>`;
          updateStatusEl.className = 'settings-status success';
        } else {
          updateStatusEl.textContent = `已是最新版本 v${info.localVersion}`;
          updateStatusEl.className = 'settings-status success';
        }
      };
      send({ type: 'check_update' });
    });

    // Wire _onUpdateInfo into WS handler via closure
    const _origOnUpdateInfo = window._ccOnUpdateInfo;
    window._ccOnUpdateInfo = (info) => { if (_onUpdateInfo) _onUpdateInfo(info); };

    closeBtn.addEventListener('click', hideSettingsPanel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) hideSettingsPanel(); });

    document.addEventListener('keydown', _settingsEscape);
  }

  function hideSettingsPanel() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay) overlay.remove();
    document.querySelectorAll('.settings-subpage-overlay').forEach((node) => node.remove());
    _onNotifyConfig = null;
    _onNotifyTestResult = null;
    _onModelConfig = null;
    _onCodexConfig = null;
    _onFetchModelsResult = null;
    _onClaudeLocalConfig = null;
    _onCodexLocalConfig = null;
    _onDevConfig = null;
    window._ccOnUpdateInfo = null;
    document.removeEventListener('keydown', _settingsEscape);
  }

  function _settingsEscape(e) {
    if (e.key === 'Escape') hideSettingsPanel();
  }

  if (settingsBtn) {
    settingsBtn.addEventListener('click', showSettingsPanel);
  }

  // --- Force Change Password ---
  function showForceChangePassword() {
    const overlay = document.createElement('div');
    overlay.className = 'force-change-overlay';
    overlay.id = 'force-change-overlay';

    const panel = document.createElement('div');
    panel.className = 'force-change-panel';

    panel.innerHTML = `
      <div class="login-logo">CC</div>
      <h2>修改初始密码</h2>
      <p>首次登录需要设置新密码</p>
      <div class="force-change-form">
        <input type="password" id="fc-new-pw" placeholder="新密码" autocomplete="new-password">
        <div class="password-hint" id="fc-hint">至少 8 位，包含大写/小写/数字/特殊字符中的 2 种</div>
        <input type="password" id="fc-confirm-pw" placeholder="确认新密码" autocomplete="new-password">
        <button id="fc-submit-btn" class="fc-submit-btn" disabled>确认修改</button>
        <div class="fc-status" id="fc-status"></div>
      </div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const newPwInput = panel.querySelector('#fc-new-pw');
    const confirmPwInput = panel.querySelector('#fc-confirm-pw');
    const hintEl = panel.querySelector('#fc-hint');
    const submitBtn = panel.querySelector('#fc-submit-btn');
    const statusEl = panel.querySelector('#fc-status');

    function checkStrength() {
      const pw = newPwInput.value;
      const confirm = confirmPwInput.value;
      if (!pw) {
        hintEl.textContent = '至少 8 位，包含大写/小写/数字/特殊字符中的 2 种';
        hintEl.className = 'password-hint';
        submitBtn.disabled = true;
        return;
      }
      const result = clientValidatePassword(pw);
      if (!result.valid) {
        hintEl.textContent = result.message;
        hintEl.className = 'password-hint error';
        submitBtn.disabled = true;
        return;
      }
      hintEl.textContent = '密码强度符合要求';
      hintEl.className = 'password-hint success';
      submitBtn.disabled = !confirm || confirm !== pw;
    }

    newPwInput.addEventListener('input', checkStrength);
    confirmPwInput.addEventListener('input', checkStrength);

    submitBtn.addEventListener('click', () => {
      const newPw = newPwInput.value;
      const confirmPw = confirmPwInput.value;
      if (newPw !== confirmPw) {
        statusEl.textContent = '两次密码不一致';
        statusEl.className = 'fc-status error';
        return;
      }
      submitBtn.disabled = true;
      statusEl.textContent = '正在修改...';
      statusEl.className = 'fc-status';
      send({ type: 'change_password', currentPassword: loginPasswordValue || localStorage.getItem('cc-web-pw') || '', newPassword: newPw });
    });

    newPwInput.focus();
  }

  function hideForceChangePassword() {
    const overlay = document.getElementById('force-change-overlay');
    if (overlay) overlay.remove();
  }

  function clientValidatePassword(pw) {
    if (!pw || pw.length < 8) {
      return { valid: false, message: '密码长度至少 8 位' };
    }
    let types = 0;
    if (/[a-z]/.test(pw)) types++;
    if (/[A-Z]/.test(pw)) types++;
    if (/[0-9]/.test(pw)) types++;
    if (/[^a-zA-Z0-9]/.test(pw)) types++;
    if (types < 2) {
      return { valid: false, message: '需包含至少 2 种字符类型（大写/小写/数字/特殊字符）' };
    }
    return { valid: true, message: '' };
  }

  // --- Password Changed Handler ---
  let _onPasswordChanged = null;

  function handlePasswordChanged(msg) {
    if (msg.success) {
      // Update token
      authToken = msg.token;
      localStorage.setItem('cc-web-token', msg.token);
      // Update remembered password
      if (localStorage.getItem('cc-web-pw')) {
        // Clear old remembered password since it's changed
        localStorage.removeItem('cc-web-pw');
      }

      // If force-change overlay is open, close it and load sessions
      const fcOverlay = document.getElementById('force-change-overlay');
      if (fcOverlay) {
        hideForceChangePassword();
        syncViewForAgent(currentAgent, { preserveCurrent: false, loadLast: true });
        showToast('密码修改成功');
      }

      // If settings panel change password
      if (_onPasswordChanged) {
        _onPasswordChanged({ success: true, message: msg.message });
        _onPasswordChanged = null;
      }
    } else {
      // Force-change error
      const fcStatus = document.querySelector('#fc-status');
      if (fcStatus) {
        fcStatus.textContent = msg.message || '修改失败';
        fcStatus.className = 'fc-status error';
        const btn = document.querySelector('#fc-submit-btn');
        if (btn) btn.disabled = false;
      }

      // Settings panel error
      if (_onPasswordChanged) {
        _onPasswordChanged({ success: false, message: msg.message });
        _onPasswordChanged = null;
      }
    }
  }

  // --- Recent CWD memory (localStorage) ---
  const RECENT_CWD_KEY = 'cc-web-recent-cwds';
  const RECENT_CWD_MAX = 5;

  function getRecentCwds() {
    try {
      const raw = localStorage.getItem(RECENT_CWD_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function saveRecentCwd(cwd) {
    if (!cwd) return;
    let list = getRecentCwds().filter(p => p !== cwd);
    list.unshift(cwd);
    if (list.length > RECENT_CWD_MAX) list = list.slice(0, RECENT_CWD_MAX);
    try { localStorage.setItem(RECENT_CWD_KEY, JSON.stringify(list)); } catch {}
  }

  // --- Pinned CWD helpers ---
  function getPinnedCwds(agent) {
    try {
      const raw = localStorage.getItem('cc-web-pinned-cwds-' + agent);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function savePinnedCwd(agent, cwd) {
    if (!cwd) return;
    let list = getPinnedCwds(agent);
    if (list.includes(cwd)) return;
    list.unshift(cwd);
    if (list.length > 5) list = list.slice(0, 5);
    try { localStorage.setItem('cc-web-pinned-cwds-' + agent, JSON.stringify(list)); } catch {}
  }

  function removePinnedCwd(agent, cwd) {
    let list = getPinnedCwds(agent).filter(p => p !== cwd);
    try { localStorage.setItem('cc-web-pinned-cwds-' + agent, JSON.stringify(list)); } catch {}
  }

  // --- New Session Modal ---
  let _onCwdSuggestions = null;

  function showNewSessionModal() {
    const targetAgent = currentAgent;
    const targetLabel = AGENT_LABELS[targetAgent] || AGENT_LABELS.claude;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'new-session-overlay';

    overlay.innerHTML = `
      <div class="modal-panel">
        <div class="modal-header">
          <span class="modal-title">新建 ${escapeHtml(targetLabel)} 会话</span>
          <button class="modal-close-btn" id="ns-close-btn">✕</button>
        </div>
        <div class="modal-body">
          <div class="agent-context-card" style="margin-bottom:12px">
            <div class="agent-context-kicker" id="ns-task-label">${escapeHtml(targetLabel)} · 本地任务</div>
          </div>
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <button class="btn-test ns-task-tab active" id="ns-tab-local" style="flex:1;padding:6px 12px">本地任务</button>
            <button class="btn-test ns-task-tab" id="ns-tab-remote" style="flex:1;padding:6px 12px">远程任务</button>
          </div>
          <div id="ns-local-view"></div>
          <div id="ns-remote-view" style="display:none"></div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn-secondary" id="ns-cancel-btn">取消</button>
          <button class="modal-btn-primary" id="ns-create-btn">创建</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    let currentTab = 'local';
    let selectedHostId = '';
    const tabLocal = overlay.querySelector('#ns-tab-local');
    const tabRemote = overlay.querySelector('#ns-tab-remote');
    const localView = overlay.querySelector('#ns-local-view');
    const remoteView = overlay.querySelector('#ns-remote-view');
    const taskLabel = overlay.querySelector('#ns-task-label');

    function switchTab(tab) {
      currentTab = tab;
      tabLocal.classList.toggle('active', tab === 'local');
      tabRemote.classList.toggle('active', tab === 'remote');
      tabLocal.style.opacity = tab === 'local' ? '1' : '0.6';
      tabRemote.style.opacity = tab === 'remote' ? '1' : '0.6';
      localView.style.display = tab === 'local' ? '' : 'none';
      remoteView.style.display = tab === 'remote' ? '' : 'none';
      taskLabel.textContent = targetLabel + (tab === 'local' ? ' · 本地任务' : ' · 远程任务');
    }
    tabLocal.addEventListener('click', () => switchTab('local'));
    tabRemote.addEventListener('click', () => switchTab('remote'));
    switchTab('local');

    // --- Local task view ---
    const pinned = getPinnedCwds(targetAgent);
    const recent = getRecentCwds().filter(p => !pinned.includes(p));
    const dirs = [...pinned, ...recent].slice(0, 5);

    let selectedLocalIndex = 0;

    function renderLocalView() {
      const currentPinned = getPinnedCwds(targetAgent);
      const currentRecent = getRecentCwds().filter(p => !currentPinned.includes(p));
      let filledDirs = [...currentPinned, ...currentRecent].slice(0, 4);
      // First-time user: no pinned, no recent → seed with server HOME so the
      // dialog isn't an empty input box on first open.
      if (filledDirs.length === 0 && serverHomeDir) {
        filledDirs = [serverHomeDir];
      }
      const maxIndex = filledDirs.length;
      if (selectedLocalIndex > maxIndex) selectedLocalIndex = maxIndex;

      localView.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:6px">
          ${filledDirs.map((dir, i) => {
            const isPinned = currentPinned.includes(dir);
            const isSelected = selectedLocalIndex === i;
            return `
              <div class="ns-cwd-row" data-local-row="${i}" style="display:flex;gap:6px;align-items:center;padding:4px 6px;border:1px solid ${isSelected ? 'var(--accent)' : 'transparent'};border-radius:8px;background:${isSelected ? 'var(--accent-dim,rgba(100,150,255,0.08))' : 'transparent'};cursor:pointer">
                <input type="radio" name="ns-local-cwd" class="ns-cwd-radio" data-local-radio="${i}" ${isSelected ? 'checked' : ''}>
                <input type="text" class="modal-text-input ns-cwd-item" value="${escapeHtml(dir)}" data-idx="${i}" style="flex:1;${isPinned ? '' : 'opacity:0.6'}">
                <button class="btn-test ns-pin-btn" data-idx="${i}" data-cwd="${escapeHtml(dir)}" style="padding:2px 6px;font-size:0.9em;${isPinned ? 'color:var(--accent)' : ''}" title="${isPinned ? '取消固定' : '固定'}">${isPinned ? '★' : '☆'}</button>
                <button class="btn-test ns-del-dir-btn" data-idx="${i}" data-cwd="${escapeHtml(dir)}" style="padding:2px 6px;font-size:0.9em" title="移除">✕</button>
              </div>
            `;
          }).join('')}
          <div class="ns-cwd-row" data-local-row="${filledDirs.length}" style="display:flex;gap:6px;align-items:center;padding:4px 6px;border:1px solid ${selectedLocalIndex === filledDirs.length ? 'var(--accent)' : 'transparent'};border-radius:8px;background:${selectedLocalIndex === filledDirs.length ? 'var(--accent-dim,rgba(100,150,255,0.08))' : 'transparent'};cursor:pointer">
            <input type="radio" name="ns-local-cwd" class="ns-cwd-radio" data-local-radio="${filledDirs.length}" ${selectedLocalIndex === filledDirs.length ? 'checked' : ''}>
            <input type="text" id="ns-cwd-custom" class="modal-text-input" placeholder="${serverHomeDir ? '输入自定义目录，例如 ' + escapeHtml(serverHomeDir) : '输入自定义目录'}" style="flex:1">
          </div>
        </div>
      `;

      localView.querySelectorAll('[data-local-row]').forEach(row => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('.ns-pin-btn') || e.target.closest('.ns-del-dir-btn')) return;
          selectedLocalIndex = Number(row.dataset.localRow);
          renderLocalView();
        });
      });

      localView.querySelectorAll('.ns-cwd-item, #ns-cwd-custom').forEach(input => {
        input.addEventListener('focus', () => {
          const row = input.closest('[data-local-row]');
          if (!row) return;
          selectedLocalIndex = Number(row.dataset.localRow);
          renderLocalView();
          const freshInput = localView.querySelector(row.dataset.localRow === String(filledDirs.length) ? '#ns-cwd-custom' : `.ns-cwd-item[data-idx="${row.dataset.localRow}"]`);
          if (freshInput) {
            const val = freshInput.value;
            freshInput.focus();
            if (typeof freshInput.setSelectionRange === 'function') freshInput.setSelectionRange(val.length, val.length);
          }
        });
      });

      localView.querySelectorAll('.ns-pin-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const rowInput = btn.closest('[data-local-row]')?.querySelector('.ns-cwd-item');
          const cwd = rowInput?.value?.trim() || btn.dataset.cwd;
          if (!cwd) return;
          const currentPinned2 = getPinnedCwds(targetAgent);
          if (currentPinned2.includes(cwd)) {
            removePinnedCwd(targetAgent, cwd);
          } else {
            savePinnedCwd(targetAgent, cwd);
          }
          selectedLocalIndex = Number(btn.dataset.idx || 0);
          renderLocalView();
        });
      });

      localView.querySelectorAll('.ns-del-dir-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const rowInput = btn.closest('[data-local-row]')?.querySelector('.ns-cwd-item');
          const cwd = rowInput?.value?.trim() || btn.dataset.cwd;
          if (!cwd) return;
          removePinnedCwd(targetAgent, cwd);
          let recents = getRecentCwds().filter(p => p !== cwd);
          try { localStorage.setItem(RECENT_CWD_KEY, JSON.stringify(recents)); } catch {}
          if (selectedLocalIndex > 0) selectedLocalIndex -= 1;
          renderLocalView();
        });
      });
    }

    renderLocalView();

    // --- Remote task view ---
    // Fetch dev config for SSH hosts
    let sshHosts = [];
    const prevOnDevConfig = _onDevConfig;
    send({ type: 'get_dev_config' });
    _onDevConfig = (config) => {
      sshHosts = config.ssh?.hosts || [];
      renderRemoteView();
    };

    function renderRemoteView() {
      if (sshHosts.length === 0) {
        remoteView.innerHTML = '<div class="settings-inline-note" style="text-align:center">请先在 设置 > 开发者设置 中添加 SSH 主机</div>';
        return;
      }
      remoteView.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:6px">
          ${sshHosts.map((host) => `
            <div style="display:flex;gap:8px;align-items:center;padding:8px;border:1px solid var(--border);border-radius:6px;cursor:pointer;${selectedHostId === host.id ? 'border-color:var(--accent);background:var(--accent-dim,rgba(100,150,255,0.08))' : ''}" data-host-select="${host.id}">
              <input type="radio" name="ns-ssh-host" value="${escapeHtml(host.id)}" ${selectedHostId === host.id ? 'checked' : ''}>
              <div style="flex:1">
                <div style="font-weight:600">${escapeHtml(host.name || '未命名')}</div>
                <div style="font-size:0.85em;color:var(--text-secondary)">${escapeHtml(host.user || '')}@${escapeHtml(host.host || '')}:${host.port || 22}${host.description ? ' · ' + escapeHtml(host.description) : ''}</div>
              </div>
            </div>
          `).join('')}
          ${selectedHostId ? `
            <div style="margin-top:8px">
              <label class="modal-field-label" style="margin-bottom:4px">远端工作目录（可选）</label>
              <input type="text" id="ns-remote-cwd" class="modal-text-input" placeholder="留空使用 SSH 默认目录">
            </div>
          ` : ''}
        </div>
      `;

      remoteView.querySelectorAll('[data-host-select]').forEach(el => {
        el.addEventListener('click', () => {
          selectedHostId = el.dataset.hostSelect;
          renderRemoteView();
        });
      });
    }
    renderRemoteView();

    function close() {
      overlay.remove();
      _onCwdSuggestions = null;
      _onDevConfig = prevOnDevConfig;
    }

    overlay.querySelector('#ns-close-btn').addEventListener('click', close);
    overlay.querySelector('#ns-cancel-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    overlay.querySelector('#ns-create-btn').addEventListener('click', () => {
      if (currentTab === 'local') {
        const customInput = localView.querySelector('#ns-cwd-custom');
        const editedItems = Array.from(localView.querySelectorAll('.ns-cwd-item')).map(input => input.value.trim());
        let cwd = null;
        if (selectedLocalIndex === editedItems.length) {
          cwd = customInput?.value?.trim() || null;
        } else {
          cwd = editedItems[selectedLocalIndex] || null;
        }
        if (!cwd) {
          appAlert('请选择或输入工作目录');
          return;
        }
        close();
        saveRecentCwd(cwd);
        send({ type: 'new_session', cwd, agent: targetAgent, mode: currentMode, taskMode: 'local' });
      } else {
        // Remote task
        if (!selectedHostId) {
          appAlert('请选择一个 SSH 主机');
          return;
        }
        const remoteCwd = remoteView.querySelector('#ns-remote-cwd')?.value?.trim() || '';
        close();
        send({ type: 'new_session', agent: targetAgent, mode: currentMode, taskMode: 'remote', sshHostId: selectedHostId, remoteCwd });
      }
    });
  }

  // --- Import Native Session Modal ---
  let _onNativeSessions = null;

  function showImportSessionModal() {
    if (currentAgent !== 'claude') return;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'import-session-overlay';

    overlay.innerHTML = `
      <div class="modal-panel modal-panel-wide">
        <div class="modal-header">
          <span class="modal-title">导入本地 CLI 会话</span>
          <button class="modal-close-btn" id="is-close-btn">✕</button>
        </div>
        <div class="modal-body" id="is-body">
          ${buildAgentContextCard('claude', '从 Claude 原生历史导入', '读取 ~/.claude/projects/ 下的会话文件，恢复对话文本与工具调用，并保留 Claude 侧续接上下文。')}
          <div class="modal-loading">正在加载…</div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
      _onNativeSessions = null;
    }

    overlay.querySelector('#is-close-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    _onNativeSessions = (groups) => {
      const body = overlay.querySelector('#is-body');
      if (!body) return;
      if (!groups || groups.length === 0) {
        body.innerHTML = `${buildAgentContextCard('claude', '从 Claude 原生历史导入', '读取 ~/.claude/projects/ 下的会话文件，恢复对话文本与工具调用，并保留 Claude 侧续接上下文。')}<div class="modal-empty">未找到本地 CLI 会话</div>`;
        return;
      }
      body.innerHTML = buildAgentContextCard('claude', '从 Claude 原生历史导入', '读取 ~/.claude/projects/ 下的会话文件，恢复对话文本与工具调用，并保留 Claude 侧续接上下文。');
      for (const group of groups) {
        const groupEl = document.createElement('div');
        groupEl.className = 'import-group';
        // Convert slug dir to readable path
        let readablePath = group.dir.replace(/-/g, '/');
        if (!readablePath.startsWith('/')) readablePath = '/' + readablePath;
        readablePath = readablePath.replace(/\/+/g, '/');
        const groupTitle = document.createElement('div');
        groupTitle.className = 'import-group-title';
        groupTitle.textContent = readablePath;
        groupEl.appendChild(groupTitle);
        for (const sess of group.sessions) {
          const item = document.createElement('div');
          item.className = 'import-item';
          const info = document.createElement('div');
          info.className = 'import-item-info';
          const titleEl = document.createElement('div');
          titleEl.className = 'import-item-title';
          titleEl.textContent = sess.title;
          const meta = document.createElement('div');
          meta.className = 'import-item-meta';
          const cwdText = sess.cwd ? sess.cwd : '';
          const timeText = sess.updatedAt ? timeAgo(sess.updatedAt) : '';
          meta.textContent = [cwdText, timeText].filter(Boolean).join(' · ');
          info.appendChild(titleEl);
          info.appendChild(meta);
          const btn = document.createElement('button');
          btn.className = 'import-item-btn';
          btn.textContent = sess.alreadyImported ? '重新导入' : '导入';
          btn.addEventListener('click', async () => {
            if (sess.alreadyImported) {
              if (!(await appConfirm('已导入过此会话，重新导入将覆盖已有内容。确认继续？'))) return;
            } else {
              if (!(await appConfirm('由于 cc-web 与本地 CLI 的逻辑不同，导入会话需要解析后方可展示，导入后将覆盖已有内容。确认继续？'))) return;
            }
            close();
            send({ type: 'import_native_session', sessionId: sess.sessionId, projectDir: group.dir });
          });
          item.appendChild(info);
          item.appendChild(btn);
          groupEl.appendChild(item);
        }
        body.appendChild(groupEl);
      }
    };

    send({ type: 'list_native_sessions' });
  }

  function showImportCodexSessionModal() {
    if (currentAgent !== 'codex') return;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'import-codex-session-overlay';

    overlay.innerHTML = `
      <div class="modal-panel modal-panel-wide">
        <div class="modal-header">
          <span class="modal-title">导入本地 Codex 会话</span>
          <button class="modal-close-btn" id="ics-close-btn">✕</button>
        </div>
        <div class="modal-body" id="ics-body">
          ${buildAgentContextCard('codex', '从 Codex rollout 历史导入', '读取 ~/.codex/sessions/ 下的 rollout 文件，恢复用户消息、助手输出、函数调用和 token 统计。')}
          <div class="modal-loading">正在加载 Codex 本地历史…</div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
      _onCodexSessions = null;
    }

    overlay.querySelector('#ics-close-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    _onCodexSessions = (items) => {
      const body = overlay.querySelector('#ics-body');
      if (!body) return;
      if (!items || items.length === 0) {
        body.innerHTML = `${buildAgentContextCard('codex', '从 Codex rollout 历史导入', '读取 ~/.codex/sessions/ 下的 rollout 文件，恢复用户消息、助手输出、函数调用和 token 统计。')}<div class="modal-empty">未找到本地 Codex 会话</div>`;
        return;
      }

      body.innerHTML = buildAgentContextCard('codex', '从 Codex rollout 历史导入', '读取 ~/.codex/sessions/ 下的 rollout 文件，恢复用户消息、助手输出、函数调用和 token 统计。');
      items.forEach((sess) => {
        const item = document.createElement('div');
        item.className = 'import-item';

        const info = document.createElement('div');
        info.className = 'import-item-info';

        const titleEl = document.createElement('div');
        titleEl.className = 'import-item-title';
        titleEl.textContent = sess.title || sess.threadId;

        const meta = document.createElement('div');
        meta.className = 'import-item-meta';
        meta.textContent = [
          sess.cwd || '',
          sess.source ? `source:${sess.source}` : '',
          sess.updatedAt ? timeAgo(sess.updatedAt) : '',
        ].filter(Boolean).join(' · ');

        const tags = document.createElement('div');
        tags.className = 'import-item-tags';
        if (sess.cliVersion) {
          const ver = document.createElement('span');
          ver.className = 'import-item-tag';
          ver.textContent = `CLI ${sess.cliVersion}`;
          tags.appendChild(ver);
        }
        if (sess.source) {
          const source = document.createElement('span');
          source.className = 'import-item-tag';
          source.textContent = sess.source;
          tags.appendChild(source);
        }

        info.appendChild(titleEl);
        info.appendChild(meta);
        if (tags.children.length > 0) info.appendChild(tags);

        const btn = document.createElement('button');
        btn.className = 'import-item-btn';
        btn.textContent = sess.alreadyImported ? '重新导入' : '导入';
        btn.addEventListener('click', async () => {
          const confirmed = await appConfirm(sess.alreadyImported
            ? '已导入过此 Codex 会话，重新导入将覆盖已有内容。确认继续？'
            : '将解析本地 Codex rollout 历史并导入当前 Web 视图。确认继续？');
          if (!confirmed) return;
          close();
          send({ type: 'import_codex_session', threadId: sess.threadId, rolloutPath: sess.rolloutPath });
        });

        item.appendChild(info);
        item.appendChild(btn);
        body.appendChild(item);
      });
    };

    send({ type: 'list_codex_sessions' });
  }

  // --- Helpers ---
  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins}分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}天前`;
    return new Date(dateStr).toLocaleDateString('zh-CN');
  }

  // --- Init ---
  applyTheme(currentTheme);
  setCurrentAgent(currentAgent);
  renderSessionList();
  // R31: optimistic boot overlay. If localStorage remembers a last-open session
  // for the current agent, pre-paint the 'session loading' overlay BEFORE the
  // ws round-trip (auth + list_sessions, ~200ms-1.5s depending on network).
  // Without this, the chat area flashes the welcome screen for the duration of
  // the round-trip, which the user described as 'overlay doesn't trigger for a
  // while'. The login-overlay (if visible) sits on top so the user only sees
  // this loading state once they're authenticated and the chat is the active
  // surface. Session info / fallback / abort paths all call setSessionLoading
  // again with the correct id, so this pre-paint is harmless even when the
  // stored id is stale.
  const optimisticLastId = localStorage.getItem(`cc-web-session-${normalizeAgent(currentAgent)}`);
  if (optimisticLastId && authToken) {
    setSessionLoading(optimisticLastId, { blocking: true, label: '正在恢复上次会话…' });
  }
  connect();
  window.addEventListener('resize', updateCwdBadge);

  // Register Service Worker for mobile push notifications
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Restore remembered password
  const savedPw = localStorage.getItem('cc-web-pw');
  if (savedPw) {
    loginPassword.value = savedPw;
    rememberPw.checked = true;
  }

  // Visibility change: re-sync state when user returns to tab (critical for mobile)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!ws || ws.readyState > 1) {
      // WS is dead, force reconnect
      connect();
    } else if (ws.readyState === 1 && currentSessionId) {
      // Preserve active streaming UI when returning to foreground.
      if (isGenerating || currentSessionRunning) {
        send({ type: 'load_session', sessionId: currentSessionId });
      } else {
        beginSessionSwitch(currentSessionId, { blocking: false, force: true });
      }
    }
  });

  if (!authToken) {
    loginOverlay.hidden = false;
    app.hidden = true;
  } else {
    loginOverlay.hidden = true;
    app.hidden = false;
  }
})();
