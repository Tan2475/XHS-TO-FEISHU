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
    
    // Scoped image extraction to ignore background DOM
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
      extractedImageUrls = Array.from(document.images)
        .map((img) => img.currentSrc || img.src)
        .filter((src) => /xhscdn|xiaohongshu/i.test(src || "") && !src.includes("avatar"));
    }
    
    const imageUrls = uniqueStrings(extractedImageUrls).slice(0, 9);
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
        if (event.source !== window || event.data?.source !== "xhs-feishu-page" || event.data?.requestId !== requestId) {
          return;
        }
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(event.data.payload || null);
      }

      window.addEventListener("message", onMessage);

      const script = document.createElement("script");
      script.textContent = `(() => {
        const requestId = ${JSON.stringify(requestId)};
        const targetNoteId = ${JSON.stringify(targetNoteId)};
        const pickImageUrl = (img) => {
          if (!img) return "";
          if (Array.isArray(img.infoList) && img.infoList.length > 0) {
            const sorted = [...img.infoList].sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)));
            if (sorted[0]?.url) return sorted[0].url;
          }
          return img.urlDefault || img.urlPre || img.url || img.urlDefaultMini || "";
        };

        const send = (payload) => {
          window.postMessage({ source: "xhs-feishu-page", requestId, payload }, "*");
        };

        try {
          const state = window.__INITIAL_STATE__;
          const detailMap = state?.note?.noteDetailMap;
          
          if (!detailMap || !detailMap[targetNoteId]) {
            send(null);
            return;
          }

          const noteData = detailMap[targetNoteId].note;
          if (!noteData) {
            send(null);
            return;
          }

          const payload = {
            sourceUrl: window.location.href,
            noteId: targetNoteId,
            title: noteData.title || (noteData.desc ? noteData.desc.slice(0, 100) : ""),
            author: noteData.user?.nickname || "",
            content: noteData.desc || "",
            coverUrl: "",
            imageUrls: [],
            videoUrl: "",
          };

          if (noteData.video) {
            const stream = noteData.video.media?.stream;
            if (stream) {
              for (const quality of ["h264", "h265", "av1"]) {
                const candidate = stream[quality]?.[0];
                payload.videoUrl = candidate?.masterUrl || candidate?.backupUrls?.[0] || payload.videoUrl;
                if (payload.videoUrl) break;
              }
            }
            payload.videoUrl = payload.videoUrl || noteData.video.url || "";
          }

          const cover = noteData.video?.cover || noteData.cover;
          payload.coverUrl = pickImageUrl(cover);

          if (Array.isArray(noteData.imageList)) {
            payload.imageUrls = noteData.imageList.map((item) => pickImageUrl(item)).filter(Boolean);
          }

          if (!payload.coverUrl && payload.imageUrls.length > 0) {
            payload.coverUrl = payload.imageUrls[0];
          }

          send(payload);
        } catch (error) {
          send(null);
        }
      })();`;

      (document.documentElement || document.head || document.body).appendChild(script);
      script.remove();
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
    const merged = {
      sourceUrl: window.location.href,
      noteId: targetNoteId,
      title: sanitizeText(fromPage?.title || fallback.title),
      author: sanitizeText(fromPage?.author || fallback.author),
      content: String(fromPage?.content || fallback.content || "").trim(),
      coverUrl: fromPage?.coverUrl || fallback.coverUrl,
      imageUrls: uniqueStrings([...(fromPage?.imageUrls || []), ...(fallback.imageUrls || [])]),
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
