/* Breaking News – client app. No build step, no API keys. */
(function () {
  'use strict';
  var CHECK_EVERY = 5 * 60 * 1000;
  var CACHE_URL = 'https://raw.githubusercontent.com/Ashridge-cpu/breaking-news/data/feeds.json';
  var CACHE_MAX_AGE = 30 * 60 * 1000;   // trust the cached copy if it is fresher than this
  var NEW_BADGE_FOR = 15 * 60 * 1000;   // "New" badge stays this long
  var PAGE = 120;
  var LS = { toggles: 'bn.toggles', custom: 'bn.custom', notify: 'bn.notify', seen: 'bn.seen' };
  var COLORS = { 'UK national': '#00f0ff', 'World': '#ff2bd6', 'Tech': '#b6ff3b', 'Business & markets': '#ffc93b', 'Local': '#ff8a3b', 'Science & health': '#7c8cff', 'Sport': '#3bffb0', 'Culture & other': '#ff6b9a', 'My sources': '#e8efff' };

  var builtins = [], custom = load(LS.custom, []), toggles = load(LS.toggles, {});
  var data = {};        // id -> items
  var status = {};      // id -> {ok, err, at, via}
  var firstSeen = {};   // key -> timestamp first seen in this session
  var known = null;     // Set of keys seen on previous checks (null until first check)
  var hadData = {};     // source ids that already had headlines at the previous check
  var lastChecked = 0, checking = false, shown = PAGE, deferredInstall = null;
  var $ = function (id) { return document.getElementById(id); };

  function load(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function allSources() { return builtins.concat(custom); }
  function isOn(s) { return s.id in toggles ? !!toggles[s.id] : (s.custom ? true : !!s.on); }
  function enabled() { return allSources().filter(isOn); }

  // ---------- fetching ----------
  function timeoutFetch(url, ms, opts) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 12000);
    var o = Object.assign({ cache: 'no-store' }, opts || {}); if (ctl) o.signal = ctl.signal;
    return fetch(url, o).finally(function () { clearTimeout(t); });
  }
  function okText(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }
  // Ways to fetch a cross-site URL, tried in order. The one that last worked is tried first next time.
  var ROUTES = [
    { name: 'direct', get: function (u) { return timeoutFetch(u, 9000).then(okText); } },
    { name: 'feedrapp', json: true, conv: fromFeedrapp, get: function (u) { return timeoutFetch('https://www.feedrapp.info/?num=40&q=' + encodeURIComponent(u)).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (j) { if (j.responseStatus !== 200 || !j.responseData || !j.responseData.feed) throw new Error('Not a feed'); return j; }); } },
    { name: 'allorigins', get: function (u) { return timeoutFetch('https://api.allorigins.win/raw?url=' + encodeURIComponent(u)).then(okText); } },
    { name: 'cors.lol', get: function (u) { return timeoutFetch('https://api.cors.lol/?url=' + encodeURIComponent(u)).then(okText); } },
    { name: 'codetabs', get: function (u) { return timeoutFetch('https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u)).then(okText); } },
    { name: 'everyorigin', get: function (u) { return timeoutFetch('https://everyorigin.jwvbremen.nl/api/get?url=' + encodeURIComponent(u)).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (j) { if (!j || !j.html) throw new Error('empty'); return j.html; }); } },
    { name: 'rss2json', json: true, conv: fromRss2json, get: function (u) { return timeoutFetch('https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(u)).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (j) { if (j.status !== 'ok') throw new Error(j.message || 'rss2json error'); return j; }); } }
  ];
  var preferred = load('bn.route', 'direct');
  function fetchVia(url, wantFeed) {
    var order = ROUTES.slice().sort(function (a, b) { return (b.name === preferred) - (a.name === preferred); });
    if (!wantFeed) order = order.filter(function (r) { return !r.json; });
    var i = 0, lastErr;
    function next() {
      if (i >= order.length) return Promise.reject(lastErr || new Error('No route worked'));
      var r = order[i++];
      return r.get(url).then(function (res) {
        if (wantFeed) {
          var items = r.json ? r.conv(res) : parseFeed(res);
          if (!items) throw new Error('Not a feed');
          return { items: items, via: r.name };
        }
        return { text: res, via: r.name };
      }).then(function (v) { if (r.name !== 'direct') { preferred = r.name; save('bn.route', r.name); } return v; }, function (e) { lastErr = e; return next(); });
    }
    return next();
  }

  function clean(html, n) {
    if (!html) return '';
    var d = new DOMParser().parseFromString('<body>' + html, 'text/html');
    var s = (d.body.textContent || '').replace(/\s+/g, ' ').trim();
    return s.length > (n || 260) ? s.slice(0, (n || 260) - 1) + '…' : s;
  }
  function kid(el, names) { for (var c = el.firstElementChild; c; c = c.nextElementSibling) { var ln = (c.localName || '').toLowerCase(); if (names.indexOf(ln) >= 0) return c; } return null; }
  function ktext(el, names) { var c = kid(el, names); return c ? (c.textContent || '').trim() : ''; }
  function parseFeed(text) {
    if (!text || !/<(rss|feed|rdf:RDF|channel)[\s>]/i.test(text)) return null;
    var doc = new DOMParser().parseFromString(text.replace(/^\uFEFF/, '').trim(), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return null;
    var nodes = [].slice.call(doc.getElementsByTagName('item')).concat([].slice.call(doc.getElementsByTagName('entry')));
    if (!nodes.length) { nodes = [].slice.call(doc.getElementsByTagNameNS('*', 'item')).concat([].slice.call(doc.getElementsByTagNameNS('*', 'entry'))); }
    var out = [];
    nodes.forEach(function (el) {
      var title = clean(ktext(el, ['title']), 300), link = '';
      for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
        if (c.localName === 'link') { var h = c.getAttribute('href'); var rel = c.getAttribute('rel') || 'alternate'; if (h && rel === 'alternate') { link = h; break; } if (!h && c.textContent.trim()) { link = c.textContent.trim(); break; } }
      }
      if (!link) { var g = ktext(el, ['guid', 'id']); if (/^https?:/.test(g)) link = g; }
      var sum = clean(ktext(el, ['description', 'summary', 'encoded', 'content']));
      var d = Date.parse(ktext(el, ['pubdate', 'pubDate', 'published', 'updated', 'date', 'issued'].map(function (x) { return x.toLowerCase(); }).concat(['pubDate']))) || 0;
      if (title && link) out.push({ t: title, l: link, s: sum === title ? '' : sum, d: d });
    });
    return out;
  }
  function fromRss2json(j) {
    return (j.items || []).map(function (it) { return { t: clean(it.title, 300), l: it.link, s: clean(it.description), d: Date.parse((it.pubDate || '').replace(' ', 'T') + 'Z') || 0 }; }).filter(function (i) { return i.t && i.l; });
  }
  function fromFeedrapp(j) {
    return (j.responseData.feed.entries || []).map(function (it) { return { t: clean(it.title, 300), l: it.link, s: clean(it.contentSnippet || it.content), d: Date.parse(it.publishedDate) || 0 }; }).filter(function (i) { return i.t && i.l; });
  }
  function tidy(src, items) {
    var gn = /news\.google\.com/.test(src.url);
    return items.map(function (i) { if (gn) { i.t = i.t.replace(/\s+-\s+[^-]{2,60}$/, ''); i.s = ''; } return i; })
      .sort(function (a, b) { return b.d - a.d; }).slice(0, 40);
  }
  function liveFetch(src) {
    return fetchVia(src.url, true).catch(function (e) { if (src.alt) return fetchVia(src.alt, true); throw e; })
      .then(function (r) { if (!r.items.length) throw new Error('No items'); data[src.id] = tidy(src, r.items); status[src.id] = { ok: true, at: Date.now(), via: r.via }; },
            function (e) { status[src.id] = { ok: false, at: Date.now(), err: (e && e.message) || 'Failed' }; });
  }
  function pool(tasks, n) {
    var i = 0; function w() { if (i >= tasks.length) return Promise.resolve(); var t = tasks[i++]; return t().then(w, w); }
    var ws = []; for (var k = 0; k < n; k++) ws.push(w()); return Promise.all(ws);
  }

  function check(manual) {
    if (checking) return Promise.resolve();
    checking = true; document.body.classList.add('loading'); $('refreshBtn').disabled = true; setStatus('Checking sources…');
    var on = enabled();
    var cachedP = on.some(function (s) { return !s.custom; })
      ? timeoutFetch(CACHE_URL + '?t=' + Math.floor(Date.now() / 60000), 10000).then(function (r) { if (!r.ok) throw 0; return r.json(); }).catch(function () { return null; })
      : Promise.resolve(null);
    return cachedP.then(function (cache) {
      var fresh = cache && Date.now() - cache.generated < CACHE_MAX_AGE;
      var tasks = [];
      on.forEach(function (s) {
        var c = !s.custom && cache && cache.feeds && cache.feeds[s.id];
        if (fresh && c && c.ok) { data[s.id] = c.items; status[s.id] = { ok: true, at: cache.generated, via: 'cache' }; }
        else tasks.push(function () { return liveFetch(s); });
      });
      return pool(tasks, 5);
    }).then(function () {
      lastChecked = Date.now(); checking = false; document.body.classList.remove('loading'); $('refreshBtn').disabled = false;
      render(true); renderPanel();
    });
  }

  // ---------- merge, dedupe, render ----------
  var STOP = { a: 1, an: 1, the: 1, of: 1, to: 1, in: 1, on: 1, and: 1, for: 1, is: 1, at: 1, as: 1, by: 1, with: 1, from: 1, after: 1, over: 1, be: 1, it: 1, its: 1, says: 1, said: 1, live: 1, latest: 1, news: 1, video: 1, watch: 1 };
  function words(t) { return t.toLowerCase().replace(/[‘’']/g, '').replace(/[^a-z0-9£$€% ]+/g, ' ').split(' ').filter(function (w) { return w && !STOP[w]; }); }
  function similar(a, b) { var n = 0; a.forEach(function (w) { if (b.has(w)) n++; }); return n / Math.min(a.size, b.size); }
  function keyOf(i) { return i.l.replace(/[?#].*$/, '').replace(/^https?:\/\/(www\.)?/, '') + '|' + i.t.toLowerCase().slice(0, 60); }

  function merged() {
    var on = enabled(), byId = {}, all = [];
    on.forEach(function (s) { byId[s.id] = s; (data[s.id] || []).forEach(function (i) { all.push({ t: i.t, l: i.l, s: i.s, d: i.d || 0, src: s }); }); });
    all.sort(function (a, b) { return b.d - a.d; });
    var out = [], seenLinks = {};
    all.forEach(function (it) {
      var lk = it.l.replace(/[?#].*$/, '');
      if (seenLinks[lk]) { if (seenLinks[lk].src !== it.src && seenLinks[lk].also.indexOf(it.src.name) < 0) seenLinks[lk].also.push(it.src.name); return; }
      it.w = new Set(words(it.t)); it.also = [];
      if (it.w.size >= 3) {
        for (var k = Math.max(0, out.length - 400); k < out.length; k++) {
          var o = out[k];
          if (o.w.size >= 3 && Math.abs(o.d - it.d) < 48 * 3600e3 && similar(o.w, it.w) >= 0.8) { if (o.src !== it.src && o.also.indexOf(it.src.name) < 0) o.also.push(it.src.name); seenLinks[lk] = o; return; }
        }
      }
      seenLinks[lk] = it; out.push(it);
    });
    return out;
  }

  function ago(ts) {
    if (!ts) return '';
    var s = (Date.now() - ts) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' hr ago';
    if (s < 172800) return 'yesterday';
    return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  function clock(ts) { return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }

  function render(afterCheck) {
    var items = merged(), now = Date.now(), newOnes = [];
    var keys = new Set(items.map(keyOf));
    if (afterCheck) {
      if (known) items.forEach(function (i) { var k = keyOf(i); if (hadData[i.src.id] && !known.has(k) && !firstSeen[k]) { firstSeen[k] = now; newOnes.push(i); } });
      known = known ? new Set([].concat(Array.from(known), Array.from(keys))) : keys;
      hadData = {}; Object.keys(data).forEach(function (id) { if (data[id] && data[id].length) hadData[id] = 1; });
    }
    var q = $('search').value.trim().toLowerCase(), f = $('filter').value, cf = $('catFilter').value;
    var view = items.filter(function (i) {
      if (f && i.src.id !== f) return false;
      if (cf && i.src.cat !== cf) return false;
      if (q && (i.t + ' ' + i.s + ' ' + i.src.name).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    // newly arrived items go to the very top, newest first, regardless of publish time
    var fresh = view.filter(function (i) { var t = firstSeen[keyOf(i)]; return t && now - t < NEW_BADGE_FOR; });
    fresh.sort(function (a, b) { return firstSeen[keyOf(b)] - firstSeen[keyOf(a)] || b.d - a.d; });
    var rest = view.filter(function (i) { return fresh.indexOf(i) < 0; });
    view = fresh.concat(rest);
    var just = new Set(newOnes.map(keyOf));
    $('list').innerHTML = view.slice(0, shown).map(function (i) {
      var k = keyOf(i), isNew = firstSeen[k] && now - firstSeen[k] < NEW_BADGE_FOR;
      var col = COLORS[i.src.cat] || '#00f0ff';
      return '<li class="item' + (just.has(k) ? ' fresh' : '') + '" style="--c:' + col + '">' +
        '<a class="hl" href="' + esc(i.l) + '" target="_blank" rel="noopener noreferrer">' + esc(i.t) + '</a>' +
        '<div class="meta">' + (isNew ? '<span class="badge">NEW</span>' : '') + '<span class="src">' + esc(i.src.name) + '</span>' +
        (i.d ? '<span title="' + esc(new Date(i.d).toLocaleString('en-GB')) + '">' + ago(i.d) + '</span>' : '') +
        (i.also.length ? '<span class="also">· also: ' + esc(i.also.slice(0, 3).join(', ')) + (i.also.length > 3 ? ' +' + (i.also.length - 3) : '') + '</span>' : '') + '</div>' +
        (i.s ? '<p class="sum">' + esc(i.s) + '</p>' : '') + '</li>';
    }).join('');
    $('moreBtn').hidden = view.length <= shown;
    var e = $('empty');
    if (!view.length) { e.hidden = false; e.textContent = !enabled().length ? 'No sources are switched on. Open Sources to choose some.' : (checking || !lastChecked) ? 'Loading headlines…' : 'No headlines match your search or filter.'; } else e.hidden = true;
    if (afterCheck && newOnes.length) {
      var b = $('newBanner'); b.hidden = false; b.textContent = newOnes.length + ' new headline' + (newOnes.length > 1 ? 's' : '') + ' at ' + clock(now) + ' – shown at the top, marked NEW.';
      clearTimeout(render.bt); render.bt = setTimeout(function () { b.hidden = true; }, 60000);
      notify(newOnes);
    }
    updateStatus();
    fillFilter();
  }

  function setStatus(t) { $('status').textContent = t; }
  function updateStatus() {
    if (checking) return;
    var on = enabled(), bad = on.filter(function (s) { return status[s.id] && !status[s.id].ok; }).length;
    if (!lastChecked) return setStatus('Not checked yet');
    var nextIn = Math.max(0, Math.ceil((lastChecked + CHECK_EVERY - Date.now()) / 60000));
    setStatus('Last checked ' + clock(lastChecked) + ' · next check in ' + nextIn + ' min' + (bad ? ' · ' + bad + ' source' + (bad > 1 ? 's' : '') + ' not responding' : ''));
    $('srcCount').textContent = on.length;
    document.querySelector('.live-dot').classList.toggle('off', !navigator.onLine);
  }

  function fillFilter() {
    var sel = $('filter'), cur = sel.value, on = enabled();
    var html = '<option value="">All sources (' + on.length + ')</option>' + on.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>'; }).join('');
    if (sel.innerHTML !== html) { sel.innerHTML = html; sel.value = on.some(function (s) { return s.id === cur; }) ? cur : ''; }
    var cs = $('catFilter'), cc = cs.value, cats = [];
    on.forEach(function (s) { if (cats.indexOf(s.cat) < 0) cats.push(s.cat); });
    var ch = '<option value="">All categories</option>' + cats.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');
    if (cs.innerHTML !== ch) { cs.innerHTML = ch; cs.value = cats.indexOf(cc) >= 0 ? cc : ''; }
  }

  // ---------- sources panel ----------
  function renderPanel() {
    var groups = {}, order = [];
    allSources().forEach(function (s) { if (!groups[s.cat]) { groups[s.cat] = []; order.push(s.cat); } groups[s.cat].push(s); });
    $('groups').innerHTML = order.map(function (cat) {
      return '<div class="group"><div class="group-head"><h4>' + esc(cat) + '</h4><span><button data-all="' + esc(cat) + '" data-v="1">All on</button><button data-all="' + esc(cat) + '" data-v="0">All off</button></span></div>' +
        groups[cat].map(function (s) {
          var st = status[s.id], on = isOn(s);
          var dot = !on ? '' : !st ? 'wait' : st.ok ? 'ok' : 'err';
          var tip = !on ? '' : !st ? 'Waiting for first check' : st.ok ? 'Working (' + (data[s.id] || []).length + ' headlines' + (st.via === 'cache' ? ', from cache' : st.via ? ', via ' + st.via : '') + ')' : 'Not responding: ' + st.err;
          var host = ''; try { host = new URL(s.site || s.url).hostname.replace(/^www\./, ''); } catch (e) {}
          return '<div class="row"><span class="dot ' + dot + '" title="' + esc(tip) + '"></span><span class="nm">' + esc(s.name) + '<small>' + esc(host) + '</small></span>' +
            (s.custom ? '<button class="rm" data-rm="' + esc(s.id) + '" title="Remove this source">Remove</button>' : '') +
            '<label class="sw" title="' + (on ? 'On' : 'Off') + '"><input type="checkbox" data-id="' + esc(s.id) + '"' + (on ? ' checked' : '') + ' aria-label="' + esc(s.name) + '"><span></span></label></div>';
        }).join('') + '</div>';
    }).join('');
  }
  function setToggle(id, v) {
    toggles[id] = v; save(LS.toggles, toggles);
    var s = allSources().filter(function (x) { return x.id === id; })[0];
    if (v && s && !data[s.id]) liveOrCache(s);
  }
  function liveOrCache(s) {
    // newly switched on: fetch just that source (cache first for built-ins)
    var p = s.custom ? liveFetch(s) : timeoutFetch(CACHE_URL + '?t=' + Math.floor(Date.now() / 60000), 10000).then(function (r) { return r.json(); }).then(function (c) {
      var x = c.feeds[s.id]; if (x && x.ok && Date.now() - c.generated < CACHE_MAX_AGE) { data[s.id] = x.items; status[s.id] = { ok: true, at: c.generated, via: 'cache' }; } else return liveFetch(s);
    }).catch(function () { return liveFetch(s); });
    return p.then(function () { markKnown(s); render(false); renderPanel(); });
  }
  function markKnown(s) { if (known) (data[s.id] || []).forEach(function (i) { known.add(keyOf({ t: i.t, l: i.l })); }); }

  $('groups').addEventListener('change', function (e) { var id = e.target.getAttribute('data-id'); if (id) { setToggle(id, e.target.checked); render(false); renderPanel(); } });
  $('groups').addEventListener('click', function (e) {
    var cat = e.target.getAttribute('data-all');
    if (cat) { var v = e.target.getAttribute('data-v') === '1'; allSources().forEach(function (s) { if (s.cat === cat) setToggle(s.id, v); }); render(false); renderPanel(); }
    var rm = e.target.getAttribute('data-rm');
    if (rm) {
      var s = custom.filter(function (x) { return x.id === rm; })[0];
      if (s && confirm('Remove "' + s.name + '"?')) { custom = custom.filter(function (x) { return x.id !== rm; }); save(LS.custom, custom); delete toggles[rm]; save(LS.toggles, toggles); delete data[rm]; render(false); renderPanel(); }
    }
  });
  $('resetBtn').addEventListener('click', function () { if (confirm('Switch sources back to the default selection? Your own sources are kept.')) { toggles = {}; save(LS.toggles, toggles); check(); renderPanel(); render(false); } });

  // ---------- add a custom source (with feed auto-discovery) ----------
  function discover(input) {
    var url = input.trim(); if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try { new URL(url); } catch (e) { return Promise.reject(new Error('That doesn\'t look like a web address.')); }
    var msg = $('addMsg');
    msg.className = 'msg'; msg.textContent = 'Checking ' + url + ' …';
    return fetchVia(url, false).then(function (r) {
      var items = parseFeed(r.text);
      if (items && items.length) return { url: url, items: items, title: feedTitle(r.text) };
      var doc = new DOMParser().parseFromString(r.text, 'text/html');
      var links = [].slice.call(doc.querySelectorAll('link[rel~="alternate"][href]')).filter(function (l) { return /(rss|atom|xml)/i.test(l.getAttribute('type') || ''); });
      var cands = links.map(function (l) { return new URL(l.getAttribute('href'), url).href; });
      var base = new URL(url);
      ['/feed/', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml', '/feeds/posts/default'].forEach(function (p) { cands.push(base.origin + p); });
      cands = cands.filter(function (v, i) { return cands.indexOf(v) === i; });
      var title = (doc.querySelector('meta[property="og:site_name"]') || {}).content || (doc.title || '').trim();
      msg.textContent = 'Looking for a news feed on that site…';
      var i = 0;
      function tryNext() {
        if (i >= cands.length) throw new Error('Couldn\'t find a news feed (RSS/Atom) on that site.');
        var c = cands[i++];
        return fetchVia(c, true).then(function (x) { if (!x.items.length) throw 0; return { url: c, items: x.items, title: title }; }, tryNext);
      }
      return tryNext();
    }, function () {
      // page itself unreachable through the browser: try it, and the usual feed addresses, as feeds
      var base = new URL(url), cands = [url];
      ['/feed/', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml'].forEach(function (p) { cands.push(base.origin + p); });
      msg.textContent = 'Looking for a news feed on that site…';
      var i = 0;
      function tryNext() {
        if (i >= cands.length) throw new Error('Couldn\'t find a working news feed (RSS/Atom) there. If the site lists an RSS link, paste that address instead.');
        var c = cands[i++];
        return fetchVia(c, true).then(function (x) { if (!x.items.length) throw 0; return { url: c, items: x.items, title: '' }; }, tryNext);
      }
      return tryNext();
    });
  }
  function feedTitle(t) { var m = /<title[^>]*>(?:<!\[CDATA\[)?([^<\]]+)/i.exec(t || ''); return m ? clean(m[1], 60) : ''; }
  $('addForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('addName').value.trim(), url = $('addUrl').value, msg = $('addMsg'), btn = $('addBtn');
    btn.disabled = true;
    discover(url).then(function (r) {
      if (allSources().some(function (s) { return s.url === r.url; })) throw new Error('That feed is already in your list.');
      var s = { id: 'c-' + Date.now().toString(36), name: name || r.title || new URL(r.url).hostname.replace(/^www\./, ''), cat: 'My sources', url: r.url, site: url, custom: true };
      custom.push(s); save(LS.custom, custom); toggles[s.id] = true; save(LS.toggles, toggles);
      data[s.id] = tidy(s, r.items); status[s.id] = { ok: true, at: Date.now() }; markKnown(s);
      msg.className = 'msg ok'; msg.textContent = 'Added "' + s.name + '" with ' + r.items.length + ' headlines.';
      $('addName').value = ''; $('addUrl').value = '';
      render(false); renderPanel();
    }).catch(function (err) { msg.className = 'msg err'; msg.textContent = err.message || 'Something went wrong.'; })
      .finally(function () { btn.disabled = false; });
  });

  // ---------- notifications ----------
  function notify(list) {
    if (!load(LS.notify, false) || !('Notification' in window) || Notification.permission !== 'granted') return;
    if (document.hasFocus && document.hasFocus()) return;
    try {
      var first = list[0], n = new Notification(list.length > 1 ? list.length + ' new headlines' : first.src.name, {
        body: list.length > 1 ? list.slice(0, 3).map(function (i) { return '• ' + i.t; }).join('\n') : first.t, icon: 'icon-192.png', tag: 'breaking-news'
      });
      n.onclick = function () { window.focus(); if (list.length === 1) window.open(first.l, '_blank', 'noopener'); n.close(); };
    } catch (e) {}
  }
  var nt = $('notifyToggle');
  nt.checked = load(LS.notify, false) && 'Notification' in window && Notification.permission === 'granted';
  if (!('Notification' in window)) { nt.disabled = true; nt.parentNode.title = 'This browser does not support desktop alerts'; }
  nt.addEventListener('change', function () {
    if (!nt.checked) return save(LS.notify, false);
    Notification.requestPermission().then(function (p) {
      if (p === 'granted') { save(LS.notify, true); } else { nt.checked = false; save(LS.notify, false); alert('Desktop alerts are blocked for this site. You can allow them from the padlock icon in the address bar.'); }
    });
  });

  // ---------- UI wiring ----------
  function openPanel(v) { $('panel').classList.toggle('open', v); $('panel').setAttribute('aria-hidden', !v); $('scrim').hidden = !v; $('sourcesBtn').setAttribute('aria-expanded', v); }
  $('sourcesBtn').addEventListener('click', function () { openPanel(true); });
  $('closePanel').addEventListener('click', function () { openPanel(false); });
  $('scrim').addEventListener('click', function () { openPanel(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') openPanel(false); });
  $('refreshBtn').addEventListener('click', function () { check(true); });
  $('moreBtn').addEventListener('click', function () { shown += PAGE; render(false); });
  var st; $('search').addEventListener('input', function () { clearTimeout(st); st = setTimeout(function () { shown = PAGE; render(false); }, 200); });
  $('filter').addEventListener('change', function () { shown = PAGE; render(false); });
  $('catFilter').addEventListener('change', function () { shown = PAGE; render(false); });
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredInstall = e; $('installBtn').hidden = false; });
  $('installBtn').addEventListener('click', function () { if (deferredInstall) { deferredInstall.prompt(); deferredInstall.userChoice.finally(function () { deferredInstall = null; $('installBtn').hidden = true; }); } });
  window.addEventListener('appinstalled', function () { $('installBtn').hidden = true; });
  window.addEventListener('online', function () { check(); });
  window.addEventListener('offline', updateStatus);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && Date.now() - lastChecked > CHECK_EVERY) check(); });
  setInterval(function () { if (Date.now() - lastChecked >= CHECK_EVERY - 1000) check(); }, 15000);
  setInterval(function () { if (!checking) render(false); }, 60000); // keep "x min ago" current

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});

  timeoutFetch('sources.json', 10000).then(function (r) { return r.json(); }).then(function (list) {
    builtins = list; renderPanel(); render(false); return check();
  }).catch(function () { setStatus('Could not load the source list. Try refreshing the page.'); });
})();
