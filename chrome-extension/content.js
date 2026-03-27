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
    return Array.from(new Set(values.filter(Boolean)));
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

  function extractFromMetaFallback(targetNoteId) {
    const noteEl = document.querySelector(".note-container") || document.querySelector("#noteContainer") || document.querySelector(".note-detail") || document;

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

    // 视频笔记不从 DOM 提取 imageUrls，避免将评论区表情包、贴纸等误判为笔记图片
    let imageUrls = [];
    if (!hasVideoPlayer) {
      const imgs = noteEl.querySelectorAll(".swiper-slide .img, .swiper-slide img, .note-scroller img");
      let extractedImageUrls = [];
      if (imgs.length > 0) {
        for (const img of imgs) {
          let url = img.currentSrc || img.src;
          if (!url) {
            const style = img.getAttribute("style") || "";
            const match = style.match(/url\(['"]?(.*?)['"]?\)/);
            if (match) url = match[1];
          }
          if (url && /xhscdn|xiaohongshu/i.test(url) && !url.includes("avatar")) {
            extractedImageUrls.push(url);
          }
        }
      } else {
        const extraImgs = noteEl.querySelectorAll(".note-content img, picture img");
        for (const img of extraImgs) {
          const url = img.currentSrc || img.src;
          if (url && /xhscdn|xiaohongshu/i.test(url) && !url.includes("avatar") && !url.includes("emoji")) {
            extractedImageUrls.push(url);
          }
        }
      }
      imageUrls = uniqueStrings(extractedImageUrls).slice(0, 9);
    }

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

    // 视频笔记不应将 DOM fallback 的 imageUrls 混入——那些通常来自评论区表情包等噪音
    const imageUrls = isVideo
      ? uniqueStrings(fromPage?.imageUrls || [])
      : uniqueStrings([...(fromPage?.imageUrls || []), ...(fallback.imageUrls || [])]);

    const merged = {
      sourceUrl: window.location.href,
      noteId: targetNoteId,
      noteType,
      title: sanitizeText(fromPage?.title || fallback.title),
      author: sanitizeText(fromPage?.author || fallback.author),
      content: String(fromPage?.content || fallback.content || "").trim(),
      coverUrl: fromPage?.coverUrl || fallback.coverUrl,
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
