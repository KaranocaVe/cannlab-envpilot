// ==UserScript==
// @name         CANNLab 自动开机/抢卡助手
// @namespace    https://github.com/KaranocaVe/cannlab-envpilot
// @version      1.5.1
// @description  自动识别 CANNLab 环境；仅在明确提示资源不足时重试，Error 时先停止再恢复。
// @author       KaranocaVe
// @match        https://gitcode.com/org/cann/cannlab/environment*
// @updateURL    https://raw.githubusercontent.com/KaranocaVe/cannlab-envpilot/main/userscripts/cannlab-card-grabber.user.js
// @downloadURL  https://raw.githubusercontent.com/KaranocaVe/cannlab-envpilot/main/userscripts/cannlab-card-grabber.user.js
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'cannlab-card-grabber-settings-v1';
  const DEFAULTS = {
    intervalMs: 2500,
    retryDelayMs: 30000,
    selectedNames: ['DevEnvC_zkLx2'],
    autoConfirm: true,
    stopOnSuccess: true,
    keepAwake: true,
    collapsed: false,
  };
  const MAX_LOG_ENTRIES = 2000;
  const SELECTORS = {
    row: '.table-row.table-grid',
    name: '.env-name',
    status: '.status-text',
    dialog: '.power-confirm-modal',
  };
  const START_ACTION_LABEL = /^(?:start(?:\s+(?:instance|environment))?|power\s*on|启动|开机|启动环境|启动实例|开机启动)$/i;
  const CONFIRM_ACTION_LABEL = /^(?:start(?:\s+(?:instance|environment))?|power\s*on|启动|开机|启动环境|启动实例|确认启动|确认开机|确认|确定|是)$/i;
  const CANCEL_ACTION_LABEL = /^(?:cancel|取消|暂不|返回)$/i;
  const STOP_ACTION_LABEL = /^(?:stop(?:\s+(?:instance|environment))?|power\s*off|关机|停止|停止环境|停止实例)$/i;
  const STOP_CONFIRM_ACTION_LABEL = /^(?:stop(?:\s+(?:instance|environment))?|power\s*off|关机|停止|confirm|ok|确定|确认|yes|是)$/i;
  const START_CONFIRMATION_TEXT = /\bstart\b|\bpower\s*on\b|启动|开机/i;
  const STOP_CONFIRMATION_TEXT = /\bstop\b|\bpower\s*off\b|关机|停止/i;
  const NO_ACTION_TIMEOUT_MS = 15000;
  const START_RESULT_TIMEOUT_MS = 5000;
  const RESOURCE_SHORTAGE_TEXT = /(?:当前\s*)?资源不足|resources?\s+(?:are\s+)?(?:insufficient|unavailable)|insufficient\s+resources/i;
  const RESOURCE_NOTICE_SELECTORS = [
    '[role="alert"]',
    '[role="status"]',
    '[aria-live]',
    '[class*="toast" i]',
    '[class*="message" i]',
    '[class*="notification" i]',
    '[class*="snackbar" i]',
  ].join(', ');

  const settings = loadSettings();
  const state = {
    running: false,
    ticking: false,
    timer: null,
    timerWorker: null,
    timerWorkerUrl: null,
    nextTickAt: 0,
    retryNotBefore: 0,
    tickPending: false,
    targetRefreshTimer: null,
    observer: null,
    pendingName: null,
    pendingSince: 0,
    pendingResourceNoticeBaseline: new Set(),
    resourceShortageSeen: false,
    confirmAwaiting: false,
    manualConfirmPending: false,
    manualStopConfirmPending: false,
    recoveryName: null,
    recoverySince: 0,
    lastActionAt: 0,
    unavailableSince: 0,
    unavailableSignature: '',
    attempts: 0,
    logEntries: [],
    summaryLogs: [],
    logView: 'summary',
    wakeLock: null,
    wakeLockTimer: null,
  };

  let shadowRoot;

  function loadSettings() {
    try {
      const stored = typeof GM_getValue === 'function' ? GM_getValue(STORAGE_KEY, {}) : {};
      const merged = { ...DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
      merged.selectedNames = Array.isArray(merged.selectedNames)
        ? merged.selectedNames.filter(Boolean)
        : [...DEFAULTS.selectedNames];
      return merged;
    } catch (error) {
      console.warn('[CANNLab 抢卡助手] 读取设置失败', error);
      return { ...DEFAULTS, selectedNames: [...DEFAULTS.selectedNames] };
    }
  }

  function saveSettings() {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY, { ...settings });
    } catch (error) {
      console.warn('[CANNLab 抢卡助手] 保存设置失败', error);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && rect.width > 0
      && rect.height > 0;
  }

  function resourceShortageNotices() {
    return [...document.querySelectorAll(RESOURCE_NOTICE_SELECTORS)]
      .filter(isVisible)
      .filter((element) => RESOURCE_SHORTAGE_TEXT.test(cleanText(element.innerText || element.textContent)));
  }

  function hasNewResourceShortageNotice() {
    return resourceShortageNotices()
      .some((element) => !state.pendingResourceNoticeBaseline.has(element));
  }

  function environmentName(row) {
    const value = row.querySelector(SELECTORS.name)?.innerText || '';
    return cleanText(value.split(/\r?\n/)[0]);
  }

  function actionLabels(element) {
    return [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.innerText,
      element.textContent,
    ].map(cleanText).filter(Boolean);
  }

  function isDisabled(element) {
    return Boolean(element?.disabled || element?.getAttribute('aria-disabled') === 'true');
  }

  function findStartButton(row) {
    return [...row.querySelectorAll('button, [role="button"], a')]
      .find((element) => isVisible(element) && actionLabels(element).some((label) => START_ACTION_LABEL.test(label))) || null;
  }

  function findStopButton(row) {
    return [...row.querySelectorAll('button, [role="button"], a')]
      .find((element) => isVisible(element) && actionLabels(element).some((label) => STOP_ACTION_LABEL.test(label))) || null;
  }

  function getRows() {
    return [...document.querySelectorAll(SELECTORS.row)]
      .filter(isVisible)
      .map((row) => ({
        row,
        name: environmentName(row),
        status: cleanText(row.querySelector(SELECTORS.status)?.textContent),
        startButton: findStartButton(row),
        stopButton: findStopButton(row),
      }))
      .filter((item) => item.name);
  }

  function isSuccessStatus(status) {
    return /^(running|运行中|started|已启动|可连接)$/i.test(cleanText(status));
  }

  function isTransitionStatus(status) {
    return /configur|starting|stopping|booting|启动中|开机中|配置中|停止中|准备中/i.test(cleanText(status));
  }

  function isStoppedStatus(status) {
    return /^(stopped|已停止|已关机|关机)$/i.test(cleanText(status));
  }

  function isErrorStatus(status) {
    return /^(error|failed|启动失败|开机失败|失败|异常)$/i.test(cleanText(status));
  }

  function selectedNames() {
    return new Set(settings.selectedNames.filter(Boolean));
  }

  function getVisibleDialogs() {
    return [...document.querySelectorAll(`${SELECTORS.dialog}, [role="dialog"], dialog, .ant-modal, .el-dialog, [class*="modal"]`)]
      .filter(isVisible);
  }

  function findStartConfirmationDialog(targetName = state.pendingName) {
    return getVisibleDialogs().find((dialog) => {
      const text = cleanText(dialog.innerText);
      return Boolean(targetName && text.includes(targetName))
        && START_CONFIRMATION_TEXT.test(text);
    });
  }

  function findStartDialog(targetName = state.pendingName) {
    return getVisibleDialogs().find((dialog) => {
      const text = cleanText(dialog.innerText);
      return Boolean(targetName && text.includes(targetName))
        && START_CONFIRMATION_TEXT.test(text)
        && [...dialog.querySelectorAll('button, [role="button"]')]
          .some((button) => isVisible(button) && !isDisabled(button)
            && actionLabels(button).some((label) => CONFIRM_ACTION_LABEL.test(label)));
    });
  }

  function closeStartDialog(targetName = state.pendingName) {
    const dialog = findStartConfirmationDialog(targetName);
    if (dialog) clickDialogButton(dialog, CANCEL_ACTION_LABEL);
  }

  function isStartSubmissionInProgress(dialog) {
    const button = [...(dialog?.querySelectorAll('button, [role="button"]') || [])]
      .find((candidate) => actionLabels(candidate).some((label) => START_ACTION_LABEL.test(label)));
    return Boolean(button && (isDisabled(button)
      || button.getAttribute('aria-busy') === 'true'
      || button.hasAttribute('loading')
      || button.querySelector('svg, img, [class*="loading"], [class*="spin"]')));
  }

  function findStopDialog(targetName = state.recoveryName) {
    return getVisibleDialogs().find((dialog) => {
      const text = cleanText(dialog.innerText);
      return Boolean(targetName && text.includes(targetName))
        && STOP_CONFIRMATION_TEXT.test(text)
        && [...dialog.querySelectorAll('button, [role="button"]')]
          .some((button) => isVisible(button) && !isDisabled(button)
            && actionLabels(button).some((label) => STOP_CONFIRM_ACTION_LABEL.test(label)));
    });
  }

  function clickElement(element) {
    if (!element || !isVisible(element) || isDisabled(element)) return false;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.click();
    return true;
  }

  function clickDialogButton(dialog, labelPattern) {
    if (!dialog) return false;
    const button = [...dialog.querySelectorAll('button, [role="button"]')]
      .find((candidate) => isVisible(candidate) && !isDisabled(candidate)
        && actionLabels(candidate).some((label) => labelPattern.test(label)));
    return clickElement(button);
  }

  function log(message, kind = 'info') {
    const time = new Date().toLocaleTimeString();
    const entry = { time, message, kind };
    state.logEntries.push(entry);
    if (state.logEntries.length > MAX_LOG_ENTRIES) state.logEntries.shift();
    const key = `${kind}:${message}`;
    const last = state.summaryLogs[state.summaryLogs.length - 1];
    if (last && last.key === key) {
      last.count += 1;
      last.lastTime = time;
    } else {
      state.summaryLogs.push({ key, firstTime: time, lastTime: time, message, kind, count: 1 });
      if (state.summaryLogs.length > 400) state.summaryLogs.shift();
    }
    console.info(`[CANNLab 抢卡助手] ${message}`);
    renderLogs();
    setPanelStatus(message, kind);
  }

  function setPanelStatus(message, kind = 'info') {
    const status = shadowRoot?.querySelector('[data-role="status"]');
    if (status) {
      status.textContent = message;
      status.dataset.kind = kind;
    }
  }

  function renderLogs() {
    const box = shadowRoot?.querySelector('[data-role="log"]');
    const count = shadowRoot?.querySelector('[data-role="log-count"]');
    const toggle = shadowRoot?.querySelector('[data-action="toggle-log"]');
    if (!box) return;
    const entries = state.logView === 'full' ? state.logEntries : state.summaryLogs;
    box.replaceChildren();
    entries.forEach((entry) => {
      const line = document.createElement('div');
      const repeat = entry.count > 1 ? ` ×${entry.count}` : '';
      const time = entry.firstTime && entry.lastTime && entry.firstTime !== entry.lastTime
        ? `${entry.firstTime}–${entry.lastTime}`
        : entry.time || entry.firstTime;
      line.textContent = `${time}${repeat} ${entry.message}`;
      line.dataset.kind = entry.kind;
      box.appendChild(line);
    });
    if (count) count.textContent = `${state.logEntries.length} 条`;
    if (toggle) toggle.textContent = state.logView === 'full' ? '显示摘要' : '查看完整日志';
    box.scrollTop = box.scrollHeight;
  }

  function refreshTargetList() {
    const box = shadowRoot?.querySelector('[data-role="targets"]');
    if (!box) return;
    const chosen = selectedNames();
    const rows = getRows();
    box.replaceChildren();
    if (!rows.length) {
      box.textContent = '正在等待页面识别环境…';
      return;
    }
    rows.forEach((item) => {
      const label = document.createElement('label');
      label.className = 'target-item';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = item.name;
      checkbox.checked = chosen.has(item.name);
      checkbox.addEventListener('change', () => {
        settings.selectedNames = [...shadowRoot.querySelectorAll('[data-role="targets"] input:checked')]
          .map((input) => input.value);
        saveSettings();
        updateTargetCount();
      });
      const meta = document.createElement('span');
      meta.className = 'target-meta';
      const name = document.createElement('strong');
      name.textContent = item.name;
      const details = document.createElement('small');
      details.textContent = `${item.status || '未知状态'}${isStoppedStatus(item.status)
        ? (item.startButton && !isDisabled(item.startButton) ? ' · 可启动' : ' · 未识别可用启动按钮')
        : ''}`;
      meta.append(name, details);
      label.append(checkbox, meta);
      box.appendChild(label);
    });
    updateTargetCount();
  }

  function scheduleTargetRefresh() {
    if (state.targetRefreshTimer) return;
    state.targetRefreshTimer = setTimeout(() => {
      state.targetRefreshTimer = null;
      refreshTargetList();
    }, 150);
  }

  function updateTargetCount() {
    const count = shadowRoot?.querySelector('[data-role="target-count"]');
    if (count) count.textContent = `已选 ${selectedNames().size}`;
  }

  function setControls() {
    const start = shadowRoot?.querySelector('[data-action="start"]');
    const stop = shadowRoot?.querySelector('[data-action="stop"]');
    const autoConfirm = shadowRoot?.querySelector('[data-setting="autoConfirm"]');
    if (start) start.disabled = state.running;
    if (stop) stop.disabled = !state.running;
    if (autoConfirm) autoConfirm.disabled = state.running;
  }

  function scheduleTick(delay = Math.max(1500, Number(settings.intervalMs) || DEFAULTS.intervalMs)) {
    const requestedDelay = Math.max(50, delay);
    const wait = Math.max(requestedDelay, state.retryNotBefore - Date.now());
    state.nextTickAt = Date.now() + wait;
    clearTimeout(state.timer);
    state.timer = null;
    if (state.timerWorker) {
      state.timerWorker.postMessage({ type: 'schedule', delay: wait });
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      runScheduledTick();
    }, wait);
  }

  function cancelScheduledTick() {
    clearTimeout(state.timer);
    state.timer = null;
    if (state.timerWorker) state.timerWorker.postMessage({ type: 'cancel' });
    state.nextTickAt = 0;
  }

  function runScheduledTick() {
    if (!state.running) return;
    if (state.ticking) {
      state.tickPending = true;
      return;
    }
    tick();
  }

  function stopTimerWorker() {
    const worker = state.timerWorker;
    state.timerWorker = null;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
    if (state.timerWorkerUrl) {
      URL.revokeObjectURL(state.timerWorkerUrl);
      state.timerWorkerUrl = null;
    }
  }

  function startTimerWorker() {
    if (state.timerWorker) return true;
    if (typeof Worker !== 'function' || typeof Blob !== 'function' || !URL.createObjectURL) return false;
    try {
      const source = `
        let timer = null;
        self.onmessage = ({ data }) => {
          if (data?.type === 'cancel') {
            clearTimeout(timer);
            timer = null;
          } else if (data?.type === 'schedule') {
            clearTimeout(timer);
            timer = setTimeout(() => {
              timer = null;
              self.postMessage({ type: 'tick' });
            }, Math.max(50, Number(data.delay) || 50));
          }
        };
        self.postMessage({ type: 'ready' });
      `;
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const worker = new Worker(url);
      state.timerWorker = worker;
      state.timerWorkerUrl = url;
      worker.onmessage = ({ data }) => {
        if (data?.type === 'ready') {
          if (state.timerWorkerUrl) {
            URL.revokeObjectURL(state.timerWorkerUrl);
            state.timerWorkerUrl = null;
          }
          return;
        }
        if (data?.type === 'tick') {
          state.nextTickAt = 0;
          runScheduledTick();
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        console.warn('[CANNLab 抢卡助手] 后台 Worker 定时器不可用，改用页面定时器。');
        const remaining = Math.max(50, state.nextTickAt - Date.now());
        cancelScheduledTick();
        stopTimerWorker();
        if (state.running) {
          log('浏览器拦截了后台 Worker，已回退到页面定时器；后台检查频率可能下降。', 'warn');
          scheduleTick(remaining);
        }
      };
      return true;
    } catch (error) {
      console.warn('[CANNLab 抢卡助手] 无法创建后台 Worker 定时器，改用页面定时器。', error);
      stopTimerWorker();
      return false;
    }
  }

  function retryStartAfter(reason) {
    const delay = Math.max(5000, Number(settings.retryDelayMs) || DEFAULTS.retryDelayMs);
    state.retryNotBefore = Date.now() + delay;
    log(`${reason}，${Math.ceil(delay / 1000)} 秒后再次尝试启动。`, 'wait');
    scheduleTick(delay);
  }

  function resumeCheck() {
    if (state.running) scheduleTick(50);
  }

  function onVisibilityChange() {
    requestWakeLock();
    if (!document.hidden) resumeCheck();
  }

  async function confirmPowerOn() {
    const deadline = Date.now() + 2500;
    while (state.running && Date.now() < deadline) {
      const dialog = findStartDialog(state.pendingName);
      if (dialog) {
        if (!settings.autoConfirm) {
          state.confirmAwaiting = false;
          state.manualConfirmPending = true;
          log('已点击启动按钮，等待你手动确认。', 'wait');
          return;
        }
        if (clickDialogButton(dialog, CONFIRM_ACTION_LABEL)) {
          state.confirmAwaiting = false;
          state.manualConfirmPending = false;
          log(`已确认启动 ${state.pendingName}，等待资源结果。`, 'wait');
          return;
        }
      }
      await sleep(150);
    }
    state.confirmAwaiting = false;
    log('未找到包含目标环境名的启动确认框，本轮不会重复提交。', 'warn');
  }

  async function confirmPowerOff(targetName) {
    const deadline = Date.now() + 2500;
    while (state.running && Date.now() < deadline) {
      const dialog = getVisibleDialogs().find((candidate) =>
        STOP_CONFIRMATION_TEXT.test(cleanText(candidate.innerText)));
      if (dialog) {
        const text = cleanText(dialog.innerText);
        if (!text.includes(targetName)) {
          stop(`停止确认框中无法核对目标环境 ${targetName}，脚本已停止。`);
          return false;
        }
        if (!findStopDialog(targetName)) {
          stop(`${targetName} 的停止确认框没有可识别的确认按钮，脚本已停止；请检查页面。`);
          return false;
        }
        if (!settings.autoConfirm) {
          state.manualStopConfirmPending = true;
          log(`已点击 ${targetName} 的 Stop，等待你确认停止后继续重试。`, 'wait');
          return false;
        }
        if (clickDialogButton(dialog, STOP_CONFIRM_ACTION_LABEL)) {
          log(`已确认停止 ${targetName}，等待环境恢复到已关机状态。`, 'wait');
          return true;
        }
      }
      await sleep(150);
    }
    return true;
  }

  function clearErrorRecovery() {
    state.recoveryName = null;
    state.recoverySince = 0;
    state.manualStopConfirmPending = false;
  }

  async function recoverError(item) {
    if (!state.recoveryName) {
      closeStartDialog(item.name);
      const stopButton = item.stopButton || findStopButton(item.row);
      if (!stopButton || isDisabled(stopButton)) {
        stop(`${item.name} 处于 Error，但页面没有可用的 Stop/关机按钮；脚本已停止。`);
        return;
      }
      state.recoveryName = item.name;
      state.recoverySince = Date.now();
      state.pendingName = null;
      state.pendingSince = 0;
      state.pendingResourceNoticeBaseline = new Set();
      state.resourceShortageSeen = false;
      state.confirmAwaiting = false;
      state.manualConfirmPending = false;
      if (!clickElement(stopButton)) {
        clearErrorRecovery();
        stop(`${item.name} 的 Stop/关机按钮不可用，脚本已停止。`);
        return;
      }
      log(`${item.name} 处于 Error，已点击 Stop，等待状态恢复。`, 'action');
      const confirmed = await confirmPowerOff(item.name);
      if (!state.running) return;
      if (confirmed || state.manualStopConfirmPending) scheduleTick(1000);
      return;
    }

    if (state.recoveryName !== item.name) {
      stop(`正在恢复 ${state.recoveryName}，检测到另一个 Error 目标 ${item.name}；脚本已停止。`);
      return;
    }
    if (isStoppedStatus(item.status)) {
      clearErrorRecovery();
      state.pendingName = null;
      state.pendingSince = 0;
      retryStartAfter('Error 环境已恢复');
      return;
    }
    if (Date.now() - state.recoverySince >= 30_000) {
      stop(`${item.name} 点击 Stop 后 30 秒仍未回到已关机状态；脚本停止，不会重复点击。`);
      return;
    }
    const status = item.status || '未知状态';
    setPanelStatus(`${item.name} 已请求 Stop，当前状态「${status}」；等待环境重置后重试。`, 'wait');
    scheduleTick(1000);
  }

  function stop(reason = '已停止') {
    state.running = false;
    state.ticking = false;
    state.pendingName = null;
    state.pendingSince = 0;
    state.pendingResourceNoticeBaseline = new Set();
    state.resourceShortageSeen = false;
    state.confirmAwaiting = false;
    state.manualConfirmPending = false;
    clearErrorRecovery();
    state.tickPending = false;
    cancelScheduledTick();
    stopTimerWorker();
    stopKeepAwake();
    setControls();
    log(reason, 'info');
  }

  function targetRows() {
    const chosen = selectedNames();
    return getRows().filter((row) => chosen.has(row.name));
  }

  function chooseCandidate(rows) {
    return rows.find((row) => isStoppedStatus(row.status) && row.startButton && !isDisabled(row.startButton));
  }

  async function submitCandidate(candidate) {
    const now = Date.now();
    const interval = Math.max(1500, Number(settings.intervalMs) || DEFAULTS.intervalMs);
    if (now - state.lastActionAt < interval) return false;
    state.lastActionAt = now;
    state.attempts += 1;
    state.pendingName = candidate.name;
    state.pendingSince = now;
    state.pendingResourceNoticeBaseline = new Set(resourceShortageNotices());
    state.resourceShortageSeen = false;
    state.confirmAwaiting = clickElement(candidate.startButton);
    if (!state.confirmAwaiting) {
      state.pendingName = null;
      return false;
    }
    log(`第 ${state.attempts} 次：已点击 ${candidate.name} 的启动按钮。`, 'action');
    await confirmPowerOn();
    if (state.running) scheduleTick(1000);
    return true;
  }

  async function tick() {
    if (!state.running || state.ticking) return;
    if (Date.now() < state.retryNotBefore) {
      scheduleTick(state.retryNotBefore - Date.now());
      return;
    }
    state.ticking = true;
    try {
      const rows = targetRows();
      if (!rows.length) {
        if (state.pendingName && Date.now() - state.pendingSince < 15000) {
          scheduleTick(1000);
          return;
        }
        stop('没有找到已选目标环境，已停止。');
        return;
      }

      const success = rows.find((row) => isSuccessStatus(row.status));
      if (success) {
        if (settings.stopOnSuccess) {
          notify('CANNLab 抢卡成功', `${success.name} 当前状态：${success.status}`);
          stop(`抢卡成功：${success.name} 已 ${success.status}。`);
          return;
        }
        log(`${success.name} 已 ${success.status}。`, 'success');
      }

      if (state.manualStopConfirmPending) {
        const dialog = findStopDialog(state.recoveryName);
        if (dialog) {
          setPanelStatus(`等待你确认 ${state.recoveryName} 的 Stop，确认后将继续重试。`, 'wait');
          scheduleTick(1000);
          return;
        }
        state.manualStopConfirmPending = false;
      }
      if (state.recoveryName) {
        const recovering = rows.find((row) => row.name === state.recoveryName);
        if (!recovering) {
          stop(`找不到正在恢复的环境 ${state.recoveryName}，脚本已停止。`);
          return;
        }
        await recoverError(recovering);
        return;
      }

      const pending = state.pendingName ? rows.find((row) => row.name === state.pendingName) : null;
      if (state.confirmAwaiting) {
        await confirmPowerOn();
        if (state.running) scheduleTick(1000);
        return;
      }
      if (state.manualConfirmPending) {
        if (findStartDialog()) {
          scheduleTick(1000);
          return;
        }
        state.manualConfirmPending = false;
      }
      if (pending) {
        if (isTransitionStatus(pending.status) || isSuccessStatus(pending.status)) {
          if (Date.now() - state.pendingSince > 10 * 60 * 1000) {
            stop(`${pending.name} 的启动状态持续超过 10 分钟，请检查页面后再重试。`);
            return;
          }
          log(`${pending.name}：${pending.status}，等待页面更新。`, 'wait');
          scheduleTick();
          return;
        }
        if (isErrorStatus(pending.status)) {
          await recoverError(pending);
          return;
        }
        if (isStoppedStatus(pending.status)) {
          const startDialog = findStartConfirmationDialog(pending.name);
          if (hasNewResourceShortageNotice()) state.resourceShortageSeen = true;
          if (state.resourceShortageSeen) {
            if (startDialog) closeStartDialog(pending.name);
            state.pendingName = null;
            state.pendingSince = 0;
            state.pendingResourceNoticeBaseline = new Set();
            state.resourceShortageSeen = false;
            state.confirmAwaiting = false;
            state.manualConfirmPending = false;
            retryStartAfter(`${pending.name} 收到明确的资源不足提示`);
            return;
          }
          if (isStartSubmissionInProgress(startDialog)) {
            if (Date.now() - state.pendingSince > 10 * 60 * 1000) {
              stop(`${pending.name} 的启动请求持续超过 10 分钟，请检查页面后再试。`);
              return;
            }
            scheduleTick(1000);
            return;
          }
          if (Date.now() - state.pendingSince < START_RESULT_TIMEOUT_MS) {
            scheduleTick(1000);
            return;
          }
          if (startDialog) closeStartDialog(pending.name);
          stop(`${pending.name} 启动后仍为 Stopped，未检测到新的资源不足提示；脚本已停止，不会自动重试。`);
          return;
        }
        if (Date.now() - state.pendingSince < 15000) {
          scheduleTick(1000);
          return;
        }
        stop(`${pending.name} 点击确认后仍显示「${pending.status}」；为避免重复提交，脚本已停止。`);
        return;
      }

      const transition = rows.find((row) => isTransitionStatus(row.status));
      if (transition) {
        stop(`${transition.name} 进入过渡状态「${transition.status}」，脚本停止轮询。`);
        return;
      }
      const error = rows.find((row) => isErrorStatus(row.status));
      if (error) {
        await recoverError(error);
        return;
      }

      const candidate = chooseCandidate(rows);
      if (!candidate) {
        const stoppedRows = rows.filter((row) => isStoppedStatus(row.status));
        if (stoppedRows.length) {
          const signature = stoppedRows.map((row) => `${row.name}:${row.startButton ? 'disabled' : 'missing'}`).join('|');
          if (signature !== state.unavailableSignature) {
            state.unavailableSignature = signature;
            state.unavailableSince = Date.now();
          }
          const unavailable = stoppedRows[0];
          const reason = unavailable.startButton ? '行内启动按钮当前不可用' : '未找到可见的“启动/开机/Start”按钮';
          if (Date.now() - state.unavailableSince >= NO_ACTION_TIMEOUT_MS) {
            stop(`${unavailable.name} 已关机，但${reason}；连续 ${NO_ACTION_TIMEOUT_MS / 1000} 秒未恢复，未发送启动请求。`);
            return;
          }
          setPanelStatus(`${unavailable.name} 已关机，但${reason}；继续检查页面，已尝试 ${state.attempts} 次。`, 'warn');
        } else {
          state.unavailableSince = 0;
          state.unavailableSignature = '';
          const statuses = rows.map((row) => `${row.name}：${row.status || '未知状态'}`).join('；');
          setPanelStatus(`等待目标进入可操作状态（${statuses}）；已尝试 ${state.attempts} 次。`, 'wait');
        }
        scheduleTick();
        return;
      }
      state.unavailableSince = 0;
      state.unavailableSignature = '';
      await submitCandidate(candidate);
    } catch (error) {
      console.error('[CANNLab 抢卡助手] 运行异常', error);
      log(`运行异常：${error?.message || error}`, 'error');
      scheduleTick();
    } finally {
      state.ticking = false;
      if (state.tickPending && state.running) {
        state.tickPending = false;
        scheduleTick(50);
      }
    }
  }

  function notify(title, text) {
    try {
      if (typeof GM_notification === 'function') GM_notification({ title, text, timeout: 8000 });
      else if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body: text });
    } catch (error) {
      console.warn('[CANNLab 抢卡助手] 通知失败', error);
    }
  }

  async function requestWakeLock() {
    if (!settings.keepAwake || !state.running || document.hidden || !('wakeLock' in navigator)) return;
    try {
      if (!state.wakeLock || state.wakeLock.released) {
        state.wakeLock = await navigator.wakeLock.request('screen');
        state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
      }
    } catch (error) {
      if (!state.wakeLockTimer && state.running) {
        state.wakeLockTimer = setTimeout(() => {
          state.wakeLockTimer = null;
          requestWakeLock();
        }, 30_000);
      }
    }
  }

  function startKeepAwake() {
    requestWakeLock();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', resumeCheck);
    window.addEventListener('pageshow', resumeCheck);
  }

  function stopKeepAwake() {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('focus', resumeCheck);
    window.removeEventListener('pageshow', resumeCheck);
    clearTimeout(state.wakeLockTimer);
    state.wakeLockTimer = null;
    if (state.wakeLock) state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }

  function createPanel() {
    const host = document.createElement('div');
    host.id = 'cannlab-card-grabber-host';
    shadowRoot = host.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = `
      <style>
        :host { all: initial; }
        .panel { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; width: 340px; color: #172033; background: #fff; border: 1px solid #d8dee9; border-radius: 8px; box-shadow: 0 8px 28px rgba(24,39,75,.2); font: 13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
        .panel * { box-sizing: border-box; }
        .head { display: flex; align-items: center; justify-content: space-between; padding: 11px 12px; border-bottom: 1px solid #e7ebf2; }
        .head strong { font-size: 14px; }
        .head button, .toolbar button { min-height: 28px; padding: 4px 9px; color: #fff; background: #1677ff; border: 0; border-radius: 4px; cursor: pointer; }
        .head button { color: #526074; background: transparent; }
        .body { padding: 10px 12px 12px; }
        .collapsed .body { display: none; }
        .toolbar { display: flex; gap: 6px; margin-bottom: 8px; }
        .toolbar button[data-action="stop"] { background: #667085; }
        button:disabled { opacity: .5; cursor: not-allowed; }
        .section-title { display: flex; justify-content: space-between; margin: 6px 0; color: #526074; font-size: 12px; }
        .target-list { max-height: 150px; overflow: auto; border: 1px solid #e2e7ef; border-radius: 4px; }
        .target-item { display: flex; gap: 7px; align-items: flex-start; padding: 7px 8px; border-bottom: 1px solid #edf0f5; cursor: pointer; }
        .target-item:last-child { border-bottom: 0; }
        .target-meta { display: flex; min-width: 0; flex-direction: column; }
        .target-meta strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .target-meta small { color: #667085; }
        .settings { display: grid; grid-template-columns: 1fr 90px; gap: 7px; align-items: center; margin: 9px 0; color: #526074; }
        .settings input { width: 100%; height: 28px; padding: 3px 6px; color: #172033; background: #fff; border: 1px solid #b9c3d2; border-radius: 4px; }
        .settings label { display: contents; }
        .status { min-height: 34px; margin: 8px 0; padding: 7px 8px; color: #344054; background: #f6f8fb; border-radius: 4px; }
        .log { max-height: 115px; overflow: auto; padding: 6px 7px; color: #526074; background: #f8fafc; border-radius: 4px; font-size: 11px; white-space: pre-wrap; }
        .log [data-kind="error"] { color: #b42318; }
        .log [data-kind="success"] { color: #067647; }
        .footer { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; color: #667085; font-size: 11px; }
        .footer button { padding: 0; color: #1677ff; background: transparent; border: 0; cursor: pointer; }
        .hint { margin-top: 8px; color: #667085; font-size: 11px; }
      </style>
      <section class="panel${settings.collapsed ? ' collapsed' : ''}">
        <header class="head"><strong>CANNLab 抢卡助手</strong><button type="button" data-action="collapse">收起</button></header>
        <div class="body">
          <div class="toolbar"><button type="button" data-action="start">开始抢卡</button><button type="button" data-action="stop" disabled>停止</button></div>
          <div class="section-title"><span>目标环境</span><span data-role="target-count">已选 0</span></div>
          <div class="target-list" data-role="targets"></div>
          <div class="settings">
            <label>检查间隔（毫秒）<input data-setting="intervalMs" type="number" min="1500" max="60000" step="500"></label>
            <label>启动失败后重试（毫秒）<input data-setting="retryDelayMs" type="number" min="5000" max="300000" step="5000"></label>
            <label>自动点击确认<input data-setting="autoConfirm" type="checkbox"></label>
            <label>成功后自动停止<input data-setting="stopOnSuccess" type="checkbox"></label>
            <label>前台时保持屏幕唤醒<input data-setting="keepAwake" type="checkbox"></label>
          </div>
          <div class="status" data-role="status">脚本已加载，默认不会自动点击。</div>
          <div class="log" data-role="log"></div>
          <div class="footer"><span data-role="log-count">0 条</span><button type="button" data-action="toggle-log">查看完整日志</button></div>
          <div class="hint">后台使用 Worker 尝试保持计时，切回页面会立即补查；浏览器冻结整页时仍会暂停。遇到 Error 时会点目标行 Stop/关机，恢复已关机后继续重试。Start 后只有检测到新的“资源不足”提示才会按重试间隔再试；普通已关机状态不会自动反复启动。</div>
        </div>
      </section>
    `;
    document.body.appendChild(host);

    const panel = shadowRoot.querySelector('.panel');
    const collapse = shadowRoot.querySelector('[data-action="collapse"]');
    collapse.textContent = settings.collapsed ? '展开' : '收起';
    collapse.addEventListener('click', () => {
      settings.collapsed = !settings.collapsed;
      panel.classList.toggle('collapsed', settings.collapsed);
      collapse.textContent = settings.collapsed ? '展开' : '收起';
      saveSettings();
    });
    shadowRoot.querySelector('[data-action="start"]').addEventListener('click', start);
    shadowRoot.querySelector('[data-action="stop"]').addEventListener('click', () => stop());
    shadowRoot.querySelector('[data-action="toggle-log"]').addEventListener('click', () => {
      state.logView = state.logView === 'full' ? 'summary' : 'full';
      renderLogs();
    });
    const interval = shadowRoot.querySelector('[data-setting="intervalMs"]');
    const retryDelay = shadowRoot.querySelector('[data-setting="retryDelayMs"]');
    interval.value = String(settings.intervalMs);
    retryDelay.value = String(settings.retryDelayMs);
    interval.addEventListener('change', () => { settings.intervalMs = Math.min(60000, Math.max(1500, Number(interval.value) || DEFAULTS.intervalMs)); interval.value = settings.intervalMs; saveSettings(); });
    retryDelay.addEventListener('change', () => { settings.retryDelayMs = Math.min(300000, Math.max(5000, Number(retryDelay.value) || DEFAULTS.retryDelayMs)); retryDelay.value = settings.retryDelayMs; saveSettings(); });
    ['autoConfirm', 'stopOnSuccess', 'keepAwake'].forEach((key) => {
      const input = shadowRoot.querySelector(`[data-setting="${key}"]`);
      input.checked = Boolean(settings[key]);
      input.addEventListener('change', () => { settings[key] = input.checked; saveSettings(); });
    });
    refreshTargetList();
    renderLogs();
    setControls();
    log('脚本已加载，默认不会自动点击。', 'info');
  }

  function start() {
    if (state.running) return;
    if (!selectedNames().size) {
      log('请先在目标环境列表中勾选至少一个环境。', 'warn');
      return;
    }
    state.running = true;
    state.ticking = false;
    state.pendingName = null;
    state.pendingSince = 0;
    clearErrorRecovery();
    state.lastActionAt = 0;
    state.retryNotBefore = 0;
    state.unavailableSince = 0;
    state.unavailableSignature = '';
    state.tickPending = false;
    state.attempts = 0;
    setControls();
    const backgroundTimerAvailable = startTimerWorker();
    startKeepAwake();
    log(`开始抢卡：每 ${settings.intervalMs}ms 检查一次。${backgroundTimerAvailable ? '后台由 Worker 计时。' : '后台页面可能被浏览器降频。'}`, 'action');
    tick();
  }

  function observePage() {
    state.observer = new MutationObserver(() => {
      scheduleTargetRefresh();
      if (state.running && !state.ticking) scheduleTick(250);
    });
    state.observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'class'] });
  }

  function init() {
    createPanel();
    observePage();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
