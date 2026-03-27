(function () {
  const ROOT_ID = "xhs-feishu-floating-root";
  const REQUEST_TIMEOUT_MS = 2500;

  function isXiaohongshuUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.endsWith("xiaohongshu.com") || parsed.hostname.endsWith("xhslink.com");
    } catch (error) {
      return false;
    }
  }

  function sanitizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function uniqueStrings(values) {
    return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
  }

  function getXhsAssetId(url) {
    try {
      const parsed = new URL(url);
      if (!/xhscdn|xiaohongshu/i.test(parsed.hostname)) {
        return '';
      }
      const lastSegment = parsed.pathname.split('/').filter(Boolean).at(-1) || '';
      const assetId = lastSegment.split('!')[0];
      return assetId || '';
    } catch {
      return '';
    }
  }

  function getMediaUrlKey(url) {
    const xhsAssetId = getXhsAssetId(url);
    if (xhsAssetId) {
      return `xhs:${xhsAssetId}`;
    }

    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch {
      return String(url || '');
    }
  }

  function dedupeMediaUrls(values) {
    const seen = new Set();
    const result = [];
    for (const rawValue of Array.isArray(values) ? values : []) {
      const value = String(rawValue || '').trim();
      if (!value) continue;
      const key = getMediaUrlKey(value);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(value);
    }
    return result;
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

  function pickMeta(selectors) {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const value = element?.content || element?.getAttribute?.("content") || "";
      if (value) {
        return value;
      }
    }
    return "";
  }

  function looksLikeXhsAssetUrl(url) {
    return /xhscdn|xiaohongshu/i.test(String(url || ""));
  }

  function isLikelyNoiseImageUrl(url) {
    const lowerUrl = String(url || "").toLowerCase();
    return ["avatar", "emoji", "emoticon", "sticker", "profile", "icon"].some((token) => lowerUrl.includes(token));
  }

  function getNodeTokenText(node) {
    if (!node) return "";
    const className = typeof node.className === "string" ? node.className : "";
    const id = typeof node.id === "string" ? node.id : "";
    return `${className} ${id}`.toLowerCase();
  }

  function isInsideExcludedContainer(node, boundary) {
    const blockedTokens = ["comment", "comments", "reply", "emoji", "emoticon", "sticker", "avatar", "author", "user", "profile", "sidebar", "recommend", "related"];
    let current = node?.parentElement || null;
    while (current && current !== boundary) {
      const tokenText = getNodeTokenText(current);
      if (blockedTokens.some((token) => tokenText.includes(token))) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  function readImageUrlFromNode(node) {
    if (!node) return "";
    if (node.tagName === "IMG") {
      return node.currentSrc || node.src || "";
    }
    const style = node.getAttribute?.("style") || "";
    const match = style.match(/url\(['"]?(.*?)['"]?\)/);
    return match?.[1] || "";
  }

  function collectPrimaryImageNodes(noteRoot) {
    if (!noteRoot) {
      return [];
    }

    const selectors = [
      ".media-container .swiper-slide img",
      ".media-container .swiper-slide .img",
      ".swiper-slide img",
      ".swiper-slide .img",
      ".media-container img",
      ".media-container .img",
      ".note-scroller img",
      ".note-scroller .img",
      "[class*='media'] img",
      "[class*='swiper'] img",
    ];

    const nodes = [];
    const seen = new Set();
    for (const selector of selectors) {
      for (const node of noteRoot.querySelectorAll(selector)) {
        if (seen.has(node)) continue;
        seen.add(node);
        nodes.push(node);
      }
    }
    return nodes;
  }

  function collectNoteImagesFromDom(noteRoot) {
    if (!noteRoot) {
      return [];
    }

    const urls = [];
    for (const node of collectPrimaryImageNodes(noteRoot)) {
      if (isInsideExcludedContainer(node, noteRoot)) {
        continue;
      }

      const url = readImageUrlFromNode(node);
      if (!url || !looksLikeXhsAssetUrl(url) || isLikelyNoiseImageUrl(url)) {
        continue;
      }

      const width = Number(node.naturalWidth || node.clientWidth || node.width || 0);
      const height = Number(node.naturalHeight || node.clientHeight || node.height || 0);
      if ((width > 0 && width < 120) || (height > 0 && height < 120)) {
        continue;
      }

      urls.push(url);
    }

    return dedupeMediaUrls(urls).slice(0, 9);
  }

  function getNoteRoot() {
    return (
      document.querySelector(".note-container") ||
      document.querySelector("#noteContainer") ||
      document.querySelector(".note-detail") ||
      document.querySelector("[class*='note'][class*='detail']") ||
      document.querySelector("[class*='note'][class*='container']") ||
      document.querySelector("main") ||
      document.body ||
      document.documentElement ||
      document
    );
  }

  function extractFromMetaFallback(targetNoteId) {
    const noteEl = getNoteRoot();

    // 通过 xg-poster（视频播放器海报节点）或 video 元素来判断是否是视频笔记
    const hasVideoPlayer = !!(
      noteEl.querySelector("xg-poster") ||
      noteEl.querySelector(".video-player-media") ||
      noteEl.querySelector(".media-container xg-poster") ||
      noteEl.querySelector("video")
    );

    const title = sanitizeText(
      noteEl.querySelector("#detail-title")?.textContent ||
      noteEl.querySelector(".title")?.textContent ||
      pickMeta(["meta[property='og:title']", "meta[name='og:title']"]) ||
      document.title.replace(/\s*-\s*小红书.*$/, "")
    );
    const content = sanitizeText(
      noteEl.querySelector("#detail-desc")?.textContent ||
      noteEl.querySelector(".desc")?.textContent ||
      pickMeta(["meta[property='og:description']", "meta[name='description']"]) ||
      ""
    );
    let coverUrl = pickMeta(["meta[property='og:image']", "meta[name='og:image']"]);

    // 仅在主数据源不可用时才依赖 DOM 提取，而且只限定在笔记主体媒体区域内抓图。
    const imageUrls = hasVideoPlayer ? [] : collectNoteImagesFromDom(noteEl);

    if (!coverUrl && imageUrls.length > 0) {
      coverUrl = imageUrls[0];
    }

    const video = noteEl.querySelector("video");
    const videoUrl = video?.currentSrc || video?.src || "";

    let authorText = noteEl.querySelector(".author-info .name")?.textContent ||
                     noteEl.querySelector("[class*='author']")?.textContent ||
                     pickMeta(["meta[name='author']"]);
    if (!authorText) {
      const profileLinks = noteEl.querySelectorAll("a[href*='/user/profile']");
      for (const link of profileLinks) {
        const text = link.textContent?.trim();
        if (text && text !== "我") {
          authorText = text;
          break;
        }
      }
    }
    const author = sanitizeText(authorText || "");

    return {
      sourceUrl: window.location.href,
      noteId: targetNoteId,
      // 将 DOM 侧的视频判断暴露出去，供 merge 阶段使用
      isVideoNote: hasVideoPlayer,
      title,
      author,
      content,
      coverUrl,
      imageUrls,
      videoUrl,
    };
  }

  function extractFromPageContext(targetNoteId) {
    return new Promise((resolve) => {
      const requestId = `xhs-feishu-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const timer = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve(null);
      }, REQUEST_TIMEOUT_MS);

      function onMessage(event) {
        if (
          event.source !== window ||
          event.data?.source !== "xhs-feishu-page" ||
          event.data?.requestId !== requestId
        ) {
          return;
        }
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(event.data.payload || null);
      }

      window.addEventListener("message", onMessage);

      // 使用外置 inject.js（通过 src 注入），避免 inline script 被 CSP 拦截
      // 参数通过 dataset 传入，inject.js 读取 document.currentScript.dataset
      const injectUrl = chrome.runtime.getURL("inject.js");
      if (!injectUrl || injectUrl.includes("chrome-extension://invalid/")) {
        // 扩展上下文失效或 URL 生成失败，降级到 DOM 提取
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(null);
        return;
      }

      const script = document.createElement("script");
      script.src = injectUrl;
      script.dataset.requestId = requestId;
      script.dataset.noteId = targetNoteId;
      script.onload = () => {
        // 脚本执行是同步的，但 postMessage 是异步的
        // 给 100ms 让 inject.js 完成 postMessage，然后清理
        setTimeout(() => script.remove(), 100);
      };
      script.onerror = (err) => {
        console.warn("[XHS-Feishu] inject.js 加载失败:", injectUrl, err);
        script.remove();
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(null);
      };
      (document.documentElement || document.head || document.body).appendChild(script);
    });
  }

  function hasImageUrls(note) {
    return Array.isArray(note?.imageUrls) && note.imageUrls.some((item) => String(item || "").trim());
  }

  async function extractNote() {
    if (!isXiaohongshuUrl(window.location.href)) {
      throw new Error("当前页面不是小红书笔记页");
    }

    const targetNoteId = extractNoteId(window.location.href);
    if (!targetNoteId) {
      throw new Error("无法从链接识别笔记 ID");
    }

    const fromPage = await extractFromPageContext(targetNoteId);
    const fallback = extractFromMetaFallback(targetNoteId);

    // 综合两路信号判断是否是视频笔记：
    //   主路径明确标注 "video"、有 videoUrl，或 DOM 侧检测到视频播放器节点
    const isVideo =
      fromPage?.noteType === "video" ||
      !!fromPage?.videoUrl ||
      fallback.isVideoNote;

    const noteType = fromPage?.noteType || (isVideo ? "video" : "");

    // 页面主数据源可用时只信任主数据，避免把评论区表情包、推荐区图片混入正文素材。
    const imageUrls = isVideo
      ? dedupeMediaUrls(fromPage?.imageUrls || [])
      : hasImageUrls(fromPage)
        ? dedupeMediaUrls(fromPage.imageUrls)
        : dedupeMediaUrls(fallback.imageUrls || []);

    const merged = {
      sourceUrl: window.location.href,
      noteId: targetNoteId,
      noteType,
      title: sanitizeText(fromPage?.title || fallback.title),
      author: sanitizeText(fromPage?.author || fallback.author),
      content: String(fromPage?.content || fallback.content || "").trim(),
      coverUrl: String(fromPage?.coverUrl || fallback.coverUrl || "").trim(),
      imageUrls,
      videoUrl: fromPage?.videoUrl || fallback.videoUrl,
    };

    if (!merged.title && !merged.content) {
      throw new Error("未能从页面提取到笔记内容，请刷新页面后重试");
    }

    return merged;
  }

  if (!isXiaohongshuUrl(window.location.href) || document.getElementById(ROOT_ID)) {
    return;
  }

  const root = document.createElement("div");
  root.id = ROOT_ID;

  const stack = document.createElement("div");
  stack.className = "xhs-feishu-stack";

  const toast = document.createElement("div");
  toast.className = "xhs-feishu-toast";
  toast.textContent = "准备就绪";
  toast.dataset.visible = "false";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "xhs-feishu-button";
  button.innerHTML = `
    <span class="xhs-feishu-button-badge">F</span>
    <span>收藏到飞书</span>
  `;

  let toastTimer = null;

  function showToast(message, persistent = false) {
    toast.textContent = message;
    toast.dataset.visible = "true";
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (!persistent) {
      toastTimer = window.setTimeout(() => {
        toast.dataset.visible = "false";
      }, 2600);
    }
  }

  async function saveCurrentPage() {
    button.disabled = true;
    showToast("正在收藏到飞书，请稍候...", true);

    try {
      const note = await extractNote();
      const response = await chrome.runtime.sendMessage({
        type: "save-note",
        note,
      });

      if (!response?.ok) {
        throw new Error(response?.error || "收藏失败");
      }

      const title = response.data?.title ? `《${response.data.title}》` : "当前笔记";
      const action = response.data?.operation === "update" ? "已更新" : "已收藏";
      showToast(`${title}${action}到飞书`);
    } catch (error) {
      showToast(`收藏失败：${error.message}`);
    } finally {
      button.disabled = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "extract-note") {
      extractNote()
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    return false;
  });

  button.addEventListener("click", saveCurrentPage);

  stack.appendChild(toast);
  stack.appendChild(button);
  root.appendChild(stack);
  document.documentElement.appendChild(root);
})();