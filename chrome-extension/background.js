const DEFAULT_TABLE_URL = "https://my.feishu.cn/wiki/GkeAw1Sgci1O1qk3q8ScBjsKneg?table=tbl1k5rHZwVYwzgO&view=vew5nuMgZA";
const DEFAULT_SETTINGS = {
  feishuAppId: "",
  feishuAppSecret: "",
  tableUrl: DEFAULT_TABLE_URL,
  uploadAssets: true,
  uploadVideo: false,
};
const REQUIRED_FIELDS = ["博主", "笔记链接", "标题", "文案", "视频/图片", "封面"];

function isXiaohongshuUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith("xiaohongshu.com") || parsed.hostname.endsWith("xhslink.com");
  } catch (error) {
    return false;
  }
}

function extractNoteId(url) {
  const patterns = [
    /\/explore\/([a-fA-F0-9]{24})/,
    /\/discovery\/item\/([a-fA-F0-9]{24})/,
    /\/item\/([a-fA-F0-9]{24})/,
    /note_id=([a-fA-F0-9]{24})/,
    /\/([a-fA-F0-9]{24})\?/,
    /\/([a-fA-F0-9]{24})$/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return "";
}

function sanitizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function guessFileName(url, fallbackPrefix) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const last = parts.at(-1) || `${fallbackPrefix}`;
    
    if (last.includes(".")) {
      return last;
    }
    
    if (fallbackPrefix === "video") return `${last}.mp4`;
    // 小红书CDN常见的一些图片扩展判断
    if (parsed.pathname.toLowerCase().includes(".png")) return `${last}.png`;
    return `${last}.jpg`;
  } catch (error) {
    if (fallbackPrefix === "video") return `${fallbackPrefix}.mp4`;
    return `${fallbackPrefix}.jpg`;
  }
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return {
    feishuAppId: String(stored.feishuAppId || "").trim(),
    feishuAppSecret: String(stored.feishuAppSecret || "").trim(),
    tableUrl: String(stored.tableUrl || DEFAULT_TABLE_URL).trim(),
    uploadAssets: Boolean(stored.uploadAssets),
    uploadVideo: Boolean(stored.uploadVideo),
  };
}

async function saveSettings(input) {
  const nextSettings = {
    feishuAppId: String(input.feishuAppId || "").trim(),
    feishuAppSecret: String(input.feishuAppSecret || "").trim(),
    tableUrl: String(input.tableUrl || DEFAULT_TABLE_URL).trim(),
    uploadAssets: Boolean(input.uploadAssets),
    uploadVideo: Boolean(input.uploadVideo),
  };
  await chrome.storage.local.set(nextSettings);
  return nextSettings;
}

async function clearSecret() {
  await chrome.storage.local.set({ feishuAppSecret: "" });
}

function assertConfigured(settings) {
  if (!settings.feishuAppId || !settings.feishuAppSecret) {
    throw new Error("请先填写 FEISHU_APP_ID 和 FEISHU_APP_SECRET");
  }
  if (!settings.tableUrl) {
    throw new Error("请先填写飞书多维表链接");
  }
}

async function feishuRequest(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.msg || data.message || `请求失败: ${response.status}`);
  }
  if (Object.prototype.hasOwnProperty.call(data, "code") && data.code !== 0) {
    throw new Error(data.msg || `飞书接口返回错误: ${data.code}`);
  }
  return data;
}

async function getTenantAccessToken(settings) {
  const data = await feishuRequest("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      app_id: settings.feishuAppId,
      app_secret: settings.feishuAppSecret,
    }),
  });

  return data.tenant_access_token;
}

async function parseFeishuTableContext(tableUrl, token) {
  const parsed = new URL(tableUrl);
  const tableId = parsed.searchParams.get("table");
  const viewId = parsed.searchParams.get("view");
  if (!tableId) {
    throw new Error("飞书表格链接里缺少 table 参数");
  }

  const wikiMatch = parsed.pathname.match(/\/wiki\/([a-zA-Z0-9]{15,})/);
  if (wikiMatch) {
    const wikiToken = wikiMatch[1];
    const data = await feishuRequest(`https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(wikiToken)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const node = data.data?.node;
    if (!node || node.obj_type !== "bitable") {
      throw new Error("该飞书链接未解析到多维表");
    }
    return { appToken: node.obj_token, tableId, viewId };
  }

  const baseMatch = parsed.pathname.match(/\/base\/(bascn[a-zA-Z0-9]+|[a-zA-Z0-9]{20,})/);
  if (baseMatch) {
    return { appToken: baseMatch[1], tableId, viewId };
  }

  throw new Error("暂不支持这个飞书链接格式，请使用 Wiki/Base 表格页面链接");
}

async function listTableFields(token, appToken, tableId) {
  const data = await feishuRequest(`https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  return data.data?.items || [];
}

function validateRequiredFields(fields) {
  const existing = new Set(fields.map((item) => item.field_name));
  const missing = REQUIRED_FIELDS.filter((name) => !existing.has(name));
  if (missing.length > 0) {
    throw new Error(`飞书表缺少字段: ${missing.join("、")}`);
  }
}

function extractUrlsFromFieldValue(value) {
  if (value && typeof value === "object") {
    if (typeof value.link === "string" && value.link.trim()) {
      return [value.link.trim()];
    }
    if (typeof value.text === "string") {
      return value.text.match(/https?:\/\/[^\s,，]+/g) || [];
    }
    return [];
  }

  if (typeof value === "string") {
    return value.match(/https?:\/\/[^\s,，]+/g) || [];
  }

  return [];
}

async function findExistingRecordId(token, appToken, tableId, noteId) {
  let pageToken = "";

  while (true) {
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/search`;

    const body = {
      field_names: ["笔记链接"],
      filter: {
        conjunction: "and",
        conditions: [
          {
            field_name: "笔记链接",
            operator: "contains",
            value: [noteId],
          },
        ],
      },
    };

    if (pageToken) {
      body.page_token = pageToken;
    }

    const data = await feishuRequest(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const pageData = data.data || {};
    const items = pageData.items || [];

    for (const item of items) {
      const urls = extractUrlsFromFieldValue(item.fields?.["笔记链接"]);
      for (const url of urls) {
        if (extractNoteId(url) === noteId) {
          return item.record_id;
        }
      }
    }

    if (!pageData.has_more || !pageData.page_token) {
      break;
    }
    pageToken = pageData.page_token;
  }

  return "";
}

async function fetchBlob(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`素材下载失败: ${response.status}`);
  }
  return response.blob();
}

// 单次上传阈值：超过此大小自动切换到分片上传
const MULTIPART_THRESHOLD_BYTES = 20 * 1024 * 1024; // 20 MB
// 每个分片固定 4 MB（飞书平台规定）
const CHUNK_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB

/**
 * 直接上传（适合 <= 20 MB 的文件）
 */
async function uploadAttachmentDirect(token, appToken, blob, fileName) {
  const form = new FormData();
  form.append("file_name", fileName);
  form.append("parent_type", "bitable_file");
  form.append("parent_node", appToken);
  form.append("size", String(blob.size));
  form.append("file", blob, fileName);

  const data = await feishuRequest("https://open.feishu.cn/open-apis/drive/v1/medias/upload_all", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });

  const fileToken = data.data?.file_token;
  if (!fileToken) {
    throw new Error("飞书附件上传后未返回 file_token");
  }
  return fileToken;
}

/**
 * 分片上传（适合 > 20 MB 的大文件）
 * 流程：upload_prepare → upload_part × N → upload_finish
 */
async function uploadAttachmentMultipart(token, appToken, blob, fileName) {
  // Step 1: 预上传，获取 upload_id 和分片策略
  const prepareForm = new FormData();
  prepareForm.append("file_name", fileName);
  prepareForm.append("parent_type", "bitable_file");
  prepareForm.append("parent_node", appToken);
  prepareForm.append("size", String(blob.size));

  const prepareData = await feishuRequest("https://open.feishu.cn/open-apis/drive/v1/medias/upload_prepare", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: prepareForm,
  });

  const uploadId = prepareData.data?.upload_id;
  // 飞书建议的分片大小（通常固定 4MB），取服务端返回值，fallback 到常量
  const blockSize = prepareData.data?.block_size || CHUNK_SIZE_BYTES;

  if (!uploadId) {
    throw new Error("分片上传预请求未返回 upload_id");
  }

  // Step 2: 逐片上传
  const totalSize = blob.size;
  const blockCount = Math.ceil(totalSize / blockSize);

  for (let seq = 0; seq < blockCount; seq += 1) {
    const start = seq * blockSize;
    const end = Math.min(start + blockSize, totalSize);
    const chunkBlob = blob.slice(start, end);

    const partForm = new FormData();
    partForm.append("upload_id", uploadId);
    partForm.append("seq", String(seq));
    partForm.append("size", String(chunkBlob.size));
    partForm.append("file", chunkBlob, fileName);

    await feishuRequest("https://open.feishu.cn/open-apis/drive/v1/medias/upload_part", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: partForm,
    });
  }

  // Step 3: 通知飞书合并所有分片，完成上传
  const finishData = await feishuRequest("https://open.feishu.cn/open-apis/drive/v1/medias/upload_finish", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      upload_id: uploadId,
      block_num: blockCount,
    }),
  });

  const fileToken = finishData.data?.file_token;
  if (!fileToken) {
    throw new Error("分片上传完成后未返回 file_token");
  }
  return fileToken;
}

/**
 * 自适应上传入口：小文件走直传，大文件自动切换分片
 */
async function uploadAttachmentFromUrl(token, appToken, url, fallbackPrefix) {
  const blob = await fetchBlob(url);
  const fileName = guessFileName(url, fallbackPrefix);

  const fileToken = blob.size > MULTIPART_THRESHOLD_BYTES
    ? await uploadAttachmentMultipart(token, appToken, blob, fileName)
    : await uploadAttachmentDirect(token, appToken, blob, fileName);

  return { file_token: fileToken };
}

async function uploadAttachmentList(token, appToken, urls, prefix) {
  const result = [];
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    if (!url) {
      continue;
    }
    try {
      result.push(await uploadAttachmentFromUrl(token, appToken, url, `${prefix}-${index + 1}`));
    } catch (error) {
      console.warn("Attachment upload skipped:", error);
    }
  }
  return result;
}

function buildLinkField(sourceUrl, title, content) {
  const text = sanitizeText(title) || sanitizeText(content).slice(0, 80) || "小红书笔记";
  return { text, link: sourceUrl };
}

function normalizeNote(note) {
  const sourceUrl = String(note?.sourceUrl || note?.url || "").trim();
  if (!sourceUrl || !isXiaohongshuUrl(sourceUrl)) {
    throw new Error("当前页面不是可收藏的小红书笔记页");
  }

  const noteId = String(note?.noteId || extractNoteId(sourceUrl) || "").trim();
  const imageUrls = Array.from(new Set((Array.isArray(note?.imageUrls) ? note.imageUrls : []).filter(Boolean)));
  const videoUrl = String(note?.videoUrl || "").trim();

  // 如果上游有专属 coverUrl 就直接用；否则取第一张图作为封面，
  // 此时第一张图已经充当封面，需从 imageUrls 里去掉，避免【封面】和【视频/图片】重复
  const rawCoverUrl = String(note?.coverUrl || "").trim();
  let coverUrl;
  let finalImageUrls;
  if (rawCoverUrl) {
    coverUrl = rawCoverUrl;
    finalImageUrls = imageUrls;
  } else if (imageUrls.length > 0) {
    coverUrl = imageUrls[0];
    finalImageUrls = imageUrls.slice(1);
  } else {
    coverUrl = "";
    finalImageUrls = [];
  }

  let rawType = note?.noteType;
  let finalNoteType = "image";
  if (rawType === "video" || rawType === "normal") {
    finalNoteType = rawType === "video" ? "video" : "image";
  } else {
    finalNoteType = videoUrl ? "video" : "image";
  }

  return {
    sourceUrl,
    noteId,
    title: sanitizeText(note?.title),
    author: sanitizeText(note?.author),
    content: String(note?.content || "").trim(),
    coverUrl,
    imageUrls: finalImageUrls,
    videoUrl,
    noteType: finalNoteType,
  };
}

async function buildFieldsPayload(note, settings, token, appToken) {
  const fields = {
    博主: note.author,
    笔记链接: buildLinkField(note.sourceUrl, note.title, note.content),
    标题: note.title,
    文案: note.content,
    "视频/图片": [],
    封面: [],
  };

  if (!settings.uploadAssets) {
    return fields;
  }

  if (note.coverUrl) {
    fields.封面 = await uploadAttachmentList(token, appToken, [note.coverUrl], "cover");
  }

  if (note.noteType === "video") {
    if (settings.uploadVideo && note.videoUrl) {
      fields["视频/图片"] = await uploadAttachmentList(token, appToken, [note.videoUrl], "video");
    }
  } else {
    // 图文笔记：imageUrls 是笔记全部图片，封面已单独由 coverUrl 处理，这里全量上传
    if (note.imageUrls.length > 0) {
      fields["视频/图片"] = await uploadAttachmentList(token, appToken, note.imageUrls, "image");
    }
  }

  return fields;
}

async function writeRecord(token, appToken, tableId, fieldsPayload, recordId) {
  const url = recordId
    ? `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`
    : `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;

  const data = await feishuRequest(url, {
    method: recordId ? "PUT" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: fieldsPayload }),
  });

  return data.data?.record?.record_id || recordId || "";
}

async function validateFeishuConfig() {
  const settings = await getSettings();
  assertConfigured(settings);
  const token = await getTenantAccessToken(settings);
  const context = await parseFeishuTableContext(settings.tableUrl, token);
  const fields = await listTableFields(token, context.appToken, context.tableId);
  validateRequiredFields(fields);

  return {
    tableId: context.tableId,
    appToken: context.appToken,
    fieldNames: fields.map((item) => item.field_name),
  };
}

async function saveNoteToFeishu(rawNote) {
  const settings = await getSettings();
  assertConfigured(settings);

  const note = normalizeNote(rawNote);
  if (!note.noteId) {
    throw new Error("无法从当前页面提取笔记 ID");
  }

  const token = await getTenantAccessToken(settings);
  const context = await parseFeishuTableContext(settings.tableUrl, token);
  const fields = await listTableFields(token, context.appToken, context.tableId);
  validateRequiredFields(fields);

  const recordId = await findExistingRecordId(token, context.appToken, context.tableId, note.noteId);
  const payload = await buildFieldsPayload(note, settings, token, context.appToken);
  const savedRecordId = await writeRecord(token, context.appToken, context.tableId, payload, recordId);

  return {
    success: true,
    operation: recordId ? "update" : "create",
    recordId: savedRecordId,
    noteId: note.noteId,
    title: note.title,
    author: note.author,
    sourceUrl: note.sourceUrl,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "load-settings") {
    getSettings()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "save-settings") {
    saveSettings(message)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "clear-secret") {
    clearSecret()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "validate-settings") {
    validateFeishuConfig()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "save-note") {
    saveNoteToFeishu(message.note)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
