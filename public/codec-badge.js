/*! LibreTV codec badge — show H.264 / H.265 on watch & live pages */
(function () {
  'use strict';

  var BADGE_ID = 'libretv-codec-badge';
  var STYLE_ID = 'libretv-codec-badge-style';
  var childCodec = Object.create(null);
  var seenUrls = Object.create(null);
  var probing = Object.create(null);
  var lastLabel = '';
  var knownFromProbe = false;

  function onPlayerRoute() {
    var p = location.pathname || '';
    return p === '/watch' || p.indexOf('/watch/') === 0 || p === '/live' || p.indexOf('/live/') === 0;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent =
      '#' + BADGE_ID + '{' +
        'position:fixed;z-index:2147483000;top:max(12px,env(safe-area-inset-top));' +
        'right:max(12px,env(safe-area-inset-right));' +
        'max-width:min(92vw,320px);padding:6px 10px;border-radius:8px;' +
        'font:600 12px/1.35 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
        'letter-spacing:.02em;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);' +
        'box-shadow:0 4px 18px rgba(0,0,0,.28);pointer-events:none;opacity:0;' +
        'transform:translateY(-4px);transition:opacity .2s ease,transform .2s ease;' +
        'color:#fff;display:none' +
      '}' +
      '#' + BADGE_ID + '.show{display:block;opacity:1;transform:translateY(0)}' +
      '#' + BADGE_ID + '[data-kind="h264"]{background:rgba(16,122,72,.92)}' +
      '#' + BADGE_ID + '[data-kind="h265"]{background:rgba(166,90,12,.94)}' +
      '#' + BADGE_ID + '[data-kind="mixed"]{background:rgba(55,65,81,.94)}' +
      '#' + BADGE_ID + '[data-kind="other"]{background:rgba(55,65,81,.94)}' +
      '#' + BADGE_ID + '[data-kind="wait"]{background:rgba(55,65,81,.85)}' +
      '#' + BADGE_ID + ' small{display:block;font-weight:500;opacity:.9;margin-top:2px;font-size:11px}';
    (document.head || document.documentElement).appendChild(s);
  }

  function ensureBadge() {
    ensureStyle();
    var el = document.getElementById(BADGE_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = BADGE_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  function hideBadge() {
    var el = document.getElementById(BADGE_ID);
    if (!el) return;
    el.classList.remove('show');
    lastLabel = '';
  }

  function showBadge(kind, title, hint) {
    if (!onPlayerRoute()) {
      hideBadge();
      return;
    }
    var el = ensureBadge();
    var label = kind + '|' + title + '|' + (hint || '');
    if (label === lastLabel) {
      el.classList.add('show');
      return;
    }
    lastLabel = label;
    el.dataset.kind = kind;
    el.innerHTML = hint
      ? title + '<small>' + hint + '</small>'
      : title;
    el.classList.add('show');
  }

  function emptyClass() {
    return { has264: false, has265: false, hasAv1: false };
  }

  function hasAny(c) {
    return !!(c && (c.has264 || c.has265 || c.hasAv1));
  }

  function mergeClass(a, b) {
    return {
      has264: !!(a.has264 || b.has264),
      has265: !!(a.has265 || b.has265),
      hasAv1: !!(a.hasAv1 || b.hasAv1)
    };
  }

  function classifyCodecs(text) {
    var has264 = /(?:^|[",;\s/])avc[1-4]/i.test(text) || /\bh264\b/i.test(text);
    var has265 = /(?:^|[",;\s/])(?:hvc1|hev1|dvh1|dvhe)/i.test(text) || /\bhevc\b/i.test(text);
    var hasAv1 = /(?:^|[",;\s/])av01/i.test(text);
    return { has264: has264, has265: has265, hasAv1: hasAv1 };
  }

  function applyClassification(c) {
    if (!hasAny(c)) return false;
    knownFromProbe = true;
    if (c.has265 && c.has264) {
      showBadge('mixed', 'H.264 / H.265', '多码率混编 · 投屏请选 H.264 清晰度');
      return true;
    }
    if (c.has265) {
      showBadge('h265', 'H.265 (HEVC)', 'AirPlay 投屏可能只有声音');
      return true;
    }
    if (c.has264) {
      showBadge('h264', 'H.264 (AVC)', '适合 AirPlay 投屏');
      return true;
    }
    if (c.hasAv1) {
      showBadge('other', 'AV1', 'AirPlay 兼容性较差');
      return true;
    }
    return false;
  }

  function showDetecting() {
    if (knownFromProbe) return;
    showBadge('wait', '编码检测中…', '清单未声明 CODECS，正在探测分片');
  }

  function absoluteUrl(base, ref) {
    try {
      return new URL(ref, base).href;
    } catch (e) {
      return ref;
    }
  }

  function rawFetch() {
    return window.__libretvOrigFetch || window.fetch.bind(window);
  }

  function isM3u8Url(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.indexOf('blob:') === 0 || url.indexOf('data:') === 0) return false;
    var u = url.split('?')[0].toLowerCase();
    return u.indexOf('.m3u8') !== -1 || /\/m3u8\b/i.test(url) || /[?&].*m3u8/i.test(url);
  }

  function looksLikeM3u8Body(text) {
    return typeof text === 'string' && text.indexOf('#EXTM3U') !== -1;
  }

  function findFourCC(u8, ascii) {
    var a = ascii.charCodeAt(0);
    var b = ascii.charCodeAt(1);
    var c = ascii.charCodeAt(2);
    var d = ascii.charCodeAt(3);
    for (var i = 0; i < u8.length - 3; i++) {
      if (u8[i] === a && u8[i + 1] === b && u8[i + 2] === c && u8[i + 3] === d) return true;
    }
    return false;
  }

  /** Detect codec from fMP4 / MPEG-TS bytes */
  function detectFromBytes(buf) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var out = emptyClass();
    if (!u8 || u8.length < 16) return out;

    // fMP4 / ISO-BMFF brands & sample entries
    if (findFourCC(u8, 'hvc1') || findFourCC(u8, 'hev1') || findFourCC(u8, 'hvcC') || findFourCC(u8, 'dvh1') || findFourCC(u8, 'dvhe')) {
      out.has265 = true;
    }
    if (findFourCC(u8, 'avc1') || findFourCC(u8, 'avc3') || findFourCC(u8, 'avcC')) {
      out.has264 = true;
    }
    if (findFourCC(u8, 'av01') || findFourCC(u8, 'av1C')) {
      out.hasAv1 = true;
    }
    if (hasAny(out)) return out;

    // MPEG-TS: sync 0x47, packet 188
    var isTs = false;
    for (var s = 0; s < Math.min(u8.length, 188); s++) {
      if (u8[s] === 0x47 && s + 188 < u8.length && u8[s + 188] === 0x47) {
        isTs = true;
        break;
      }
    }
    if (isTs) {
      // stream_type in PMT: 0x1B=AVC, 0x24=HEVC, 0x27=AVC, 0x15 somehow
      // Heuristic scan after table_id 0x02 (PMT)
      for (var i = 0; i < u8.length - 6; i++) {
        if (u8[i] === 0x02 && (u8[i + 1] & 0xF0) === 0xB0) {
          // rough window after PMT header — collect stream_type bytes
          var end = Math.min(u8.length, i + 400);
          for (var j = i + 12; j < end; j++) {
            var st = u8[j];
            if (st === 0x1B || st === 0x20 || st === 0x27) out.has264 = true;
            if (st === 0x24 || st === 0x25) out.has265 = true;
          }
        }
      }
      // NAL start-code scan
      for (var k = 0; k < u8.length - 5; k++) {
        var nalPos = -1;
        if (u8[k] === 0 && u8[k + 1] === 0 && u8[k + 2] === 1) nalPos = k + 3;
        else if (u8[k] === 0 && u8[k + 1] === 0 && u8[k + 2] === 0 && u8[k + 3] === 1) nalPos = k + 4;
        if (nalPos < 0 || nalPos >= u8.length) continue;
        var nb = u8[nalPos];
        var hevcType = (nb >> 1) & 0x3f;
        if (hevcType === 32 || hevcType === 33 || hevcType === 34) out.has265 = true;
        var avcType = nb & 0x1f;
        if ((nb & 0x80) === 0 && (avcType === 7 || avcType === 8)) out.has264 = true;
      }
    }

    // Prefer HEVC if both heuristics fired on same TS (common false positive)
    if (out.has265 && out.has264) {
      // keep both only if fMP4 brands said so; for TS prefer the stronger HEVC VPS signal
      // already set; leave mixed — user can still see warning
    }
    return out;
  }

  function probeSegment(url) {
    if (!url || probing[url] || knownFromProbe) return;
    probing[url] = 1;
    showDetecting();
    var orig = rawFetch();
    // Prefer Range to keep traffic small
    orig(url, {
      credentials: 'omit',
      headers: { Range: 'bytes=0-262143' }
    }).then(function (res) {
      return res.arrayBuffer().then(function (buf) {
        var c = detectFromBytes(buf);
        if (hasAny(c)) {
          applyClassification(c);
          return;
        }
        // Some CDNs ignore Range and still return little; try full small segment once
        if (buf.byteLength < 1024) {
          return orig(url, { credentials: 'omit' }).then(function (r2) {
            return r2.arrayBuffer().then(function (buf2) {
              var c2 = detectFromBytes(buf2);
              if (hasAny(c2)) applyClassification(c2);
              else if (!knownFromProbe) showBadge('other', '编码未知', '无法从分片识别，清单未声明 CODECS');
            });
          });
        }
        if (!knownFromProbe) showBadge('other', '编码未知', '无法从分片识别，清单未声明 CODECS');
      });
    }).catch(function () {
      if (!knownFromProbe) showBadge('other', '编码未知', '分片探测失败');
    });
  }

  function probeMediaPlaylist(url, text) {
    var lines = text.split(/\r?\n/);
    var mapUri = null;
    var firstSeg = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var mapMatch = /#EXT-X-MAP:[^\n]*URI="([^"]+)"/i.exec(line);
      if (mapMatch) mapUri = absoluteUrl(url, mapMatch[1]);
      if (line.charAt(0) === '#') continue;
      if (!firstSeg) firstSeg = absoluteUrl(url, line);
    }
    if (mapUri) probeSegment(mapUri);
    else if (firstSeg) probeSegment(firstSeg);
  }

  function followChildPlaylist(url) {
    if (!url || seenUrls['follow:' + url]) return;
    seenUrls['follow:' + url] = 1;
    showDetecting();
    var orig = rawFetch();
    orig(url, { credentials: 'omit' }).then(function (res) {
      return res.text().then(function (t) {
        inspectResponse(res.url || url, t);
      });
    }).catch(function () {});
  }

  function ingestPlaylist(url, text) {
    if (!looksLikeM3u8Body(text)) return;

    var mapped = childCodec[url] || childCodec[String(url).split('?')[0]];
    if (mapped && hasAny(mapped)) {
      applyClassification(mapped);
      return;
    }

    var lines = text.split(/\r?\n/);
    var pending = null;
    var masterCodecs = [];
    var childUrls = [];
    var mappedAny = false;
    var isMaster = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
        pending = line;
        isMaster = true;
        continue;
      }
      if (pending && line.charAt(0) !== '#') {
        var codecsMatch = /CODECS="([^"]+)"/i.exec(pending);
        var codecs = codecsMatch ? codecsMatch[1] : '';
        var c = classifyCodecs(codecs || pending);
        masterCodecs.push(c);
        var child = absoluteUrl(url, line);
        childCodec[child] = c;
        childCodec[child.split('?')[0]] = c;
        childUrls.push(child);
        mappedAny = true;
        pending = null;
      }
    }

    if (mappedAny) {
      var agg = emptyClass();
      for (var j = 0; j < masterCodecs.length; j++) agg = mergeClass(agg, masterCodecs[j]);
      if (hasAny(agg)) {
        applyClassification(agg);
        return;
      }
      // No CODECS on master (your case) → follow first child and probe segments
      showDetecting();
      for (var k = 0; k < Math.min(childUrls.length, 2); k++) followChildPlaylist(childUrls[k]);
      return;
    }

    var bodyClass = classifyCodecs(text);
    if (hasAny(bodyClass)) {
      applyClassification(bodyClass);
      return;
    }

    // Media playlist without codec tags → probe map/segment
    if (!isMaster) probeMediaPlaylist(url, text);
  }

  function inspectResponse(url, text) {
    try {
      if (!onPlayerRoute()) return;
      if (!text) return;
      if (!isM3u8Url(url) && !looksLikeM3u8Body(text)) return;
      ingestPlaylist(String(url), text);
    } catch (e) { /* ignore */ }
  }

  function fetchPlaylist(url) {
    if (!url || seenUrls[url]) return;
    if (!isM3u8Url(url)) return;
    seenUrls[url] = 1;
    try {
      rawFetch()(url, { credentials: 'omit' }).then(function (res) {
        return res.text().then(function (t) {
          inspectResponse(res.url || url, t);
        });
      }).catch(function () {});
    } catch (e) { /* ignore */ }
  }

  function hookFetch() {
    if (typeof window.fetch !== 'function') return;
    var orig = window.fetch.bind(window);
    window.__libretvOrigFetch = orig;
    window.fetch = function () {
      var args = arguments;
      var input = args[0];
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      return orig.apply(window, args).then(function (res) {
        try {
          if (!onPlayerRoute()) return res;
          var u = url || (res && res.url) || '';
          var ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
          if (isM3u8Url(u) || /mpegurl|m3u8|application\/vnd\.apple/i.test(ct)) {
            res.clone().text().then(function (t) {
              inspectResponse(u || res.url, t);
            }).catch(function () {});
          }
        } catch (e) { /* ignore */ }
        return res;
      });
    };
  }

  function hookXHR() {
    if (typeof XMLHttpRequest === 'undefined') return;
    var open = XMLHttpRequest.prototype.open;
    var send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__libretvUrl = url;
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      xhr.addEventListener('load', function () {
        try {
          if (!onPlayerRoute()) return;
          var u = xhr.__libretvUrl || '';
          var t = typeof xhr.responseText === 'string' ? xhr.responseText : '';
          if (isM3u8Url(String(u)) || looksLikeM3u8Body(t)) {
            inspectResponse(String(u), t);
          }
        } catch (e) { /* ignore */ }
      });
      return send.apply(this, arguments);
    };
  }

  function hookMediaSource() {
    if (typeof MediaSource === 'undefined' || !MediaSource.prototype) return;
    var orig = MediaSource.prototype.addSourceBuffer;
    if (typeof orig !== 'function') return;
    MediaSource.prototype.addSourceBuffer = function (mime) {
      try {
        if (onPlayerRoute() && mime) applyClassification(classifyCodecs(String(mime)));
      } catch (e) { /* ignore */ }
      return orig.apply(this, arguments);
    };
  }

  function scanVideoSources() {
    if (!onPlayerRoute()) return;
    var videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) {
      var v = videos[i];
      var src = v.currentSrc || v.src || '';
      if (isM3u8Url(src)) fetchPlaylist(src);
      var sources = v.querySelectorAll('source[src]');
      for (var j = 0; j < sources.length; j++) {
        var s = sources[j].getAttribute('src') || '';
        if (isM3u8Url(s)) fetchPlaylist(s);
      }
    }
  }

  function hookVideoObservers() {
    if (typeof MutationObserver === 'undefined') return;
    var obs = new MutationObserver(function () {
      scanVideoSources();
    });
    var start = function () {
      if (!document.body) return;
      obs.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['src']
      });
      scanVideoSources();
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
    setInterval(scanVideoSources, 2500);
  }

  function syncRoute() {
    if (!onPlayerRoute()) {
      hideBadge();
      childCodec = Object.create(null);
      seenUrls = Object.create(null);
      probing = Object.create(null);
      knownFromProbe = false;
      return;
    }
    ensureBadge();
    scanVideoSources();
  }

  function hookHistory() {
    var wrap = function (name) {
      var orig = history[name];
      if (typeof orig !== 'function') return;
      history[name] = function () {
        var ret = orig.apply(this, arguments);
        setTimeout(syncRoute, 0);
        return ret;
      };
    };
    wrap('pushState');
    wrap('replaceState');
    window.addEventListener('popstate', syncRoute);
  }

  function boot() {
    hookFetch();
    hookXHR();
    hookMediaSource();
    hookHistory();
    hookVideoObservers();
    if (document.body) syncRoute();
    else document.addEventListener('DOMContentLoaded', syncRoute);
  }

  boot();
})();
