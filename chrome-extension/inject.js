// inject.js —— 在页面主世界（MAIN world）执行，可访问 window.__INITIAL_STATE__
// content.js 通过 script[data-request-id] 传入参数，结果通过 postMessage 返回
(function () {
  const scriptEl = document.currentScript;
  const requestId = scriptEl?.dataset?.requestId || "";
  const targetNoteId = scriptEl?.dataset?.noteId || "";

  const send = (payload) => {
    window.postMessage({ source: "xhs-feishu-page", requestId, payload }, "*");
  };

  const pickImageUrl = (img) => {
    if (!img) return "";
    if (Array.isArray(img.infoList) && img.infoList.length > 0) {
      const sorted = [...img.infoList].sort(
        (a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
      );
      if (sorted[0]?.url) return sorted[0].url;
    }
    return img.urlDefault || img.urlPre || img.url || img.urlDefaultMini || "";
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
      noteType: noteData.type || (noteData.video ? "video" : "normal"),
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
      payload.imageUrls = noteData.imageList.map((img) => pickImageUrl(img)).filter(Boolean);
    }

    if (!payload.coverUrl && payload.imageUrls.length > 0) {
      payload.coverUrl = payload.imageUrls[0];
    }

    send(payload);
  } catch (e) {
    send(null);
  }
})();
