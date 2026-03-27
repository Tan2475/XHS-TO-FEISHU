// inject.js —— 在页面主世界（MAIN world）执行，可访问 window.__INITIAL_STATE__
// content.js 通过 script[data-request-id] 传入参数，结果通过 postMessage 返回
(function () {
  const scriptEl = document.currentScript;
  const requestId = scriptEl?.dataset?.requestId || "";
  const targetNoteId = scriptEl?.dataset?.noteId || "";

  const send = (payload) => {
    window.postMessage({ source: "xhs-feishu-page", requestId, payload }, "*");
  };

  const uniqueStrings = (values) => Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));

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

  function dedupeUrlsByKey(urls) {
    const seen = new Set();
    const result = [];
    for (const rawUrl of Array.isArray(urls) ? urls : []) {
      const url = String(rawUrl || '').trim();
      if (!url) continue;
      const key = getMediaUrlKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(url);
    }
    return result;
  }

  const pickImageUrl = (img) => {
    if (!img) return "";
    if (typeof img === "string") return img;

    const directCandidates = [
      img.urlDefault,
      img.urlPre,
      img.url,
      img.urlDefaultMini,
      img.masterUrl,
      img.originUrl,
      img.thumbnail,
    ];
    for (const candidate of directCandidates) {
      if (typeof candidate === "string" && candidate) {
        return candidate;
      }
    }

    const infoLists = [img.infoList, img.urlInfoList, img.imageSceneList];
    for (const list of infoLists) {
      if (Array.isArray(list) && list.length > 0) {
        const sorted = [...list].sort(
          (a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
        );
        const best = sorted.find((item) => typeof item?.url === "string" && item.url);
        if (best?.url) {
          return best.url;
        }
      }
    }

    if (img.urlMap && typeof img.urlMap === "object") {
      for (const value of Object.values(img.urlMap)) {
        if (typeof value === "string" && value) {
          return value;
        }
      }
    }

    return "";
  };

  function resolveNoteEntry(detailMap, targetId) {
    if (!detailMap) return null;
    return detailMap[targetId] || detailMap[String(targetId)] || null;
  }

  function resolveNoteData(entry) {
    if (!entry || typeof entry !== "object") return null;
    return entry.note || entry.noteCard || entry.item || entry;
  }

  function collectImageUrls(noteData) {
    const candidateLists = [
      noteData?.imageList,
      noteData?.imagesList,
      noteData?.images_list,
      noteData?.imgList,
      noteData?.noteCard?.imageList,
      noteData?.noteCard?.imagesList,
    ];

    for (const list of candidateLists) {
      if (Array.isArray(list) && list.length > 0) {
        return dedupeUrlsByKey(uniqueStrings(list.map((img) => pickImageUrl(img)).filter(Boolean)));
      }
    }

    return [];
  }

  function resolveVideoUrl(noteData) {
    const stream = noteData?.video?.media?.stream;
    if (stream) {
      for (const quality of ["h264", "h265", "av1"]) {
        const candidate = stream[quality]?.[0];
        const url = candidate?.masterUrl || candidate?.backupUrls?.[0];
        if (url) {
          return url;
        }
      }
    }

    return noteData?.video?.url || noteData?.videoUrl || "";
  }

  try {
    const state = window.__INITIAL_STATE__;
    const detailMap = state?.note?.noteDetailMap;
    const entry = resolveNoteEntry(detailMap, targetNoteId);
    const noteData = resolveNoteData(entry);

    if (!noteData) {
      send(null);
      return;
    }

    const imageUrls = collectImageUrls(noteData);
    const cover = noteData.video?.cover || noteData.cover || noteData.imageList?.[0] || imageUrls[0] || "";

    const payload = {
      sourceUrl: window.location.href,
      noteId: targetNoteId,
      noteType: noteData.type || noteData.noteType || noteData.note_type || (noteData.video ? "video" : "normal"),
      title: noteData.title || noteData.noteTitle || (noteData.desc ? noteData.desc.slice(0, 100) : ""),
      author: noteData.user?.nickname || noteData.author?.nickname || noteData.userInfo?.nickname || "",
      content: noteData.desc || noteData.content || "",
      coverUrl: typeof cover === "string" ? cover : pickImageUrl(cover),
      imageUrls,
      videoUrl: resolveVideoUrl(noteData),
    };

    if (!payload.coverUrl && payload.imageUrls.length > 0) {
      payload.coverUrl = payload.imageUrls[0];
    }

    send(payload);
  } catch (e) {
    send(null);
  }
})();