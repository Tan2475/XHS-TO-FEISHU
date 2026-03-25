const resultBox = document.getElementById("resultBox");
const feishuAppIdInput = document.getElementById("feishuAppId");
const feishuAppSecretInput = document.getElementById("feishuAppSecret");
const tableUrlInput = document.getElementById("tableUrl");
const uploadAssetsInput = document.getElementById("uploadAssets");
const uploadVideoInput = document.getElementById("uploadVideo");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const validateBtn = document.getElementById("validateBtn");
const collectBtn = document.getElementById("collectBtn");
const clearSecretBtn = document.getElementById("clearSecretBtn");

let activeTabId = -1;
let activeTabUrl = "";

function setBusy(isBusy) {
  saveSettingsBtn.disabled = isBusy;
  validateBtn.disabled = isBusy;
  collectBtn.disabled = isBusy;
  clearSecretBtn.disabled = isBusy;
}

function setResult(message, payload) {
  if (payload === undefined) {
    resultBox.textContent = message;
    return;
  }

  resultBox.textContent = `${message}\n\n${JSON.stringify(payload, null, 2)}`;
}

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function isXiaohongshuUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith("xiaohongshu.com") || parsed.hostname.endsWith("xhslink.com");
  } catch (error) {
    return false;
  }
}

async function loadSettings() {
  const response = await sendMessage({ type: "load-settings" });
  if (!response?.ok) {
    throw new Error(response?.error || "读取配置失败");
  }

  feishuAppIdInput.value = response.data.feishuAppId || "";
  feishuAppSecretInput.value = response.data.feishuAppSecret || "";
  tableUrlInput.value = response.data.tableUrl || "";
  uploadAssetsInput.checked = Boolean(response.data.uploadAssets);
  uploadVideoInput.checked = Boolean(response.data.uploadVideo);
}

async function saveSettings() {
  const response = await sendMessage({
    type: "save-settings",
    feishuAppId: feishuAppIdInput.value.trim(),
    feishuAppSecret: feishuAppSecretInput.value.trim(),
    tableUrl: tableUrlInput.value.trim(),
    uploadAssets: uploadAssetsInput.checked,
    uploadVideo: uploadVideoInput.checked,
  });

  if (!response?.ok) {
    throw new Error(response?.error || "保存配置失败");
  }
}

async function clearSecret() {
  const response = await sendMessage({ type: "clear-secret" });
  if (!response?.ok) {
    throw new Error(response?.error || "清空密钥失败");
  }
  feishuAppSecretInput.value = "";
}

async function detectActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? -1;
  activeTabUrl = tab?.url || "";
}

async function validateSettings() {
  const response = await sendMessage({ type: "validate-settings" });
  if (!response?.ok) {
    throw new Error(response?.error || "验证失败");
  }

  return response.data;
}

async function extractNoteFromTab() {
  if (activeTabId < 0) {
    throw new Error("未找到当前标签页");
  }

  const response = await chrome.tabs.sendMessage(activeTabId, { type: "extract-note" });
  if (!response?.ok) {
    throw new Error(response?.error || "页面内容提取失败");
  }
  return response.data;
}

async function collectCurrentTab() {
  const note = await extractNoteFromTab();
  const response = await sendMessage({ type: "save-note", note });
  if (!response?.ok) {
    throw new Error(response?.error || "收藏失败");
  }
  return response.data;
}

async function handleButtonState(btn, loadingText, actionFn) {
  const originalText = btn.textContent;
  btn.textContent = loadingText;
  setBusy(true);
  try {
    await actionFn();
    btn.textContent = "完成 ✅";
  } catch (error) {
    btn.textContent = "失败 ❌";
    setResult(`${originalText} 失败: ${error.message}`);
  } finally {
    setTimeout(() => {
      btn.textContent = originalText;
      setBusy(false);
    }, 1500);
  }
}

saveSettingsBtn.addEventListener("click", () => {
  handleButtonState(saveSettingsBtn, "保存中...", async () => {
    await saveSettings();
    setResult("配置已保存到 chrome.storage.local");
  });
});

validateBtn.addEventListener("click", () => {
  handleButtonState(validateBtn, "验证中...", async () => {
    await saveSettings();
    const result = await validateSettings();
    setResult("飞书配置验证通过", result);
  });
});

collectBtn.addEventListener("click", () => {
  handleButtonState(collectBtn, "处理中...", async () => {
    await saveSettings();
    await detectActiveTab();
    if (!isXiaohongshuUrl(activeTabUrl)) {
      throw new Error("请先打开一篇小红书笔记页面");
    }
    setResult("正在提取页面并写入飞书，请稍候...");
    const result = await collectCurrentTab();
    setResult("收藏完成", result);
  });
});

clearSecretBtn.addEventListener("click", () => {
  handleButtonState(clearSecretBtn, "清空中...", async () => {
    await clearSecret();
    setResult("已清空本地保存的 FEISHU_APP_SECRET");
  });
});

async function bootstrap() {
  try {
    await loadSettings();
    await detectActiveTab();
    setResult("准备就绪");
  } catch (error) {
    setResult(`初始化失败: ${error.message}`);
  }
}

bootstrap();
