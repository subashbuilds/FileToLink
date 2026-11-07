/* Audio / subtitle track switcher for the stream page.
 *
 * - Lists the audio + subtitle tracks of the file (server: /api/tracks/...).
 * - Subtitles: converted to WebVTT by the server and drawn by this script.
 * - Audio: the chosen track is streamed by the server (ffmpeg) into a hidden <audio>
 *   element that is kept in sync with the <video>, whose own sound is silenced.
 *   Choosing the file's original track switches back to the video's native audio.
 *
 * Works on top of the existing player and does not depend on Vidstack internals: it only
 * uses the <video> element that the player creates.
 */
(function () {
    'use strict';

    var cfg = window.__CINEMA_CONFIG__ || {};
    var KEY = cfg.mediaKey;
    var player = document.getElementById('player');
    if (!KEY || !player) return;

    var noop = function () {};
    var ICON_AUDIO = 'M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.2-1.75 4.45-4H15V6h4V3h-7z';
    var ICON_CC = 'M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z';
    var ICON_CHECK = 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z';

    /* ------------------------------------------------------------------ helpers */
    function el(tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
    }

    function svg(path, cls) {
        var ns = 'http://www.w3.org/2000/svg';
        var s = document.createElementNS(ns, 'svg');
        s.setAttribute('viewBox', '0 0 24 24');
        s.setAttribute('aria-hidden', 'true');
        if (cls) s.setAttribute('class', cls);
        var p = document.createElementNS(ns, 'path');
        p.setAttribute('d', path);
        s.appendChild(p);
        return s;
    }

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    function store(key, value) {
        try {
            if (value === undefined) return window.localStorage.getItem(key);
            window.localStorage.setItem(key, value);
        } catch (e) { /* storage can be blocked */ }
        return null;
    }

    function endpoint(kind, index, query) {
        return '/api/' + kind + '/' + (index != null ? index + '/' : '') + KEY + (query || '');
    }

    /* -------------------------------------------------------------------- state */
    var S = {
        data: null,          // response of /api/tracks
        tab: 'audio',
        menuOpen: false,
        audioSel: null,      // absolute stream index of the chosen audio track
        subSel: null,        // absolute stream index of the chosen subtitle, null = off
        subLoading: null,
        cues: [],
        delay: 0,            // seconds, + shows subtitles later
        size: parseFloat(store('tt.sub.size')) || 1
    };
    var video = null;
    var subToken = 0;

    /* ----------------------------------------------------------------------- UI */
    var ui = el('div', 'tt-ui');
    var launch = el('div', 'tt-launch');
    launch.hidden = true;
    var launchAudio = iconButton(ICON_AUDIO, 'Audio tracks');
    var launchSubs = iconButton(ICON_CC, 'Subtitles');
    launch.appendChild(launchAudio);
    launch.appendChild(launchSubs);

    var menu = el('div', 'tt-menu');
    menu.hidden = true;
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', 'Audio and subtitles');
    var head = el('div', 'tt-head');
    var tabAudio = el('button', 'tt-tab', 'Audio');
    var tabSubs = el('button', 'tt-tab', 'Subtitles');
    [tabAudio, tabSubs].forEach(function (t) { t.type = 'button'; t.setAttribute('role', 'tab'); });
    var closeBtn = el('button', 'tt-close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    head.appendChild(tabAudio);
    head.appendChild(tabSubs);
    head.appendChild(closeBtn);
    var body = el('div', 'tt-body');
    menu.appendChild(head);
    menu.appendChild(body);

    var statusChip = el('div', 'tt-status');
    statusChip.hidden = true;
    statusChip.setAttribute('role', 'status');
    var captions = el('div', 'tt-captions');
    captions.setAttribute('aria-hidden', 'true');

    ui.appendChild(captions);
    ui.appendChild(launch);
    ui.appendChild(menu);
    ui.appendChild(statusChip);
    player.appendChild(ui);

    function iconButton(path, label) {
        var b = el('button', 'tt-icon-btn');
        b.type = 'button';
        b.setAttribute('aria-label', label);
        b.title = label;
        b.setAttribute('aria-haspopup', 'dialog');
        b.setAttribute('aria-expanded', 'false');
        b.appendChild(svg(path));
        return b;
    }

    var statusTimer = 0;
    function showStatus(text, opts) {
        opts = opts || {};
        clearTimeout(statusTimer);
        statusChip.textContent = '';
        if (opts.busy) statusChip.appendChild(el('span', 'tt-spin'));
        statusChip.appendChild(el('span', null, text));
        statusChip.classList.toggle('tt-error', !!opts.error);
        statusChip.hidden = false;
        if (opts.timeout) statusTimer = setTimeout(hideStatus, opts.timeout);
    }
    function hideStatus() {
        clearTimeout(statusTimer);
        statusChip.hidden = true;
    }

    /* launcher visibility follows pointer activity (and always shows while paused) */
    var idleTimer = 0;
    function poke() {
        ui.classList.add('tt-active');
        clearTimeout(idleTimer);
        idleTimer = setTimeout(function () {
            if (!S.menuOpen && !(video && video.paused)) ui.classList.remove('tt-active');
        }, 3000);
    }
    ['pointermove', 'pointerdown', 'touchstart', 'keydown'].forEach(function (ev) {
        player.addEventListener(ev, poke, { passive: true });
    });

    /* keep clicks inside our UI from reaching the player's tap / key shortcuts */
    ['click', 'dblclick', 'keydown', 'keyup', 'keypress', 'wheel'].forEach(function (ev) {
        menu.addEventListener(ev, function (e) {
            if (ev === 'keydown' && e.key === 'Escape') { closeMenu(true); }
            e.stopPropagation();
        });
    });
    ['click', 'dblclick'].forEach(function (ev) {
        launch.addEventListener(ev, function (e) { e.stopPropagation(); });
    });

    /* ------------------------------------------------------------------- menu */
    var cmdAudio = document.getElementById('audioBtn');
    var cmdSubs = document.getElementById('subsBtn');

    function openMenu(tab, focus) {
        S.tab = tab;
        S.menuOpen = true;
        menu.hidden = false;
        renderMenu();
        poke();
        syncButtons();
        if (focus) {
            var target = body.querySelector('.tt-item[aria-checked="true"]') || body.querySelector('.tt-item:not([disabled])');
            if (target) target.focus({ preventScroll: true });
        }
    }
    function closeMenu(returnFocus) {
        if (!S.menuOpen) return;
        S.menuOpen = false;
        menu.hidden = true;
        syncButtons();
        if (returnFocus) {
            var btn = S.tab === 'audio' ? launchAudio : launchSubs;
            if (!launch.hidden) btn.focus({ preventScroll: true });
        }
        poke();
    }
    function toggleMenu(tab, e) {
        var viaKeyboard = e && e.detail === 0;
        if (S.menuOpen && S.tab === tab) closeMenu(false);
        else openMenu(tab, viaKeyboard);
    }
    function syncButtons() {
        var map = [[launchAudio, 'audio'], [launchSubs, 'subs'], [cmdAudio, 'audio'], [cmdSubs, 'subs']];
        map.forEach(function (pair) {
            if (!pair[0]) return;
            pair[0].setAttribute('aria-expanded', String(S.menuOpen && S.tab === pair[1]));
        });
        launchSubs.classList.toggle('tt-on', S.subSel != null);
        launchAudio.classList.toggle('tt-on', isExternalAudio());
        if (cmdSubs) cmdSubs.classList.toggle('tt-on', S.subSel != null);
    }

    launchAudio.addEventListener('click', function (e) { toggleMenu('audio', e); });
    launchSubs.addEventListener('click', function (e) { toggleMenu('subs', e); });
    if (cmdAudio) cmdAudio.addEventListener('click', function (e) { toggleMenu('audio', e); });
    if (cmdSubs) cmdSubs.addEventListener('click', function (e) { toggleMenu('subs', e); });
    closeBtn.addEventListener('click', function () { closeMenu(true); });
    tabAudio.addEventListener('click', function () { S.tab = 'audio'; renderMenu(); syncButtons(); });
    tabSubs.addEventListener('click', function () { S.tab = 'subs'; renderMenu(); syncButtons(); });

    document.addEventListener('pointerdown', function (e) {
        if (!S.menuOpen) return;
        var t = e.target;
        if (menu.contains(t) || launch.contains(t)) return;
        if ((cmdAudio && cmdAudio.contains(t)) || (cmdSubs && cmdSubs.contains(t))) return;
        closeMenu(false);
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && S.menuOpen) closeMenu(true);
    });

    /* arrow-key navigation inside the list */
    menu.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        var items = Array.prototype.slice.call(body.querySelectorAll('.tt-item:not([disabled])'));
        if (!items.length) return;
        var i = items.indexOf(document.activeElement);
        i = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
        items[i].focus();
        e.preventDefault();
    });

    function renderMenu() {
        var d = S.data;
        if (!d) return;
        var hasAudio = audioListed();
        var hasSubs = d.subtitles.length > 0;
        tabAudio.hidden = !hasAudio;
        tabSubs.hidden = !hasSubs;
        if (S.tab === 'audio' && !hasAudio) S.tab = 'subs';
        if (S.tab === 'subs' && !hasSubs) S.tab = 'audio';
        tabAudio.setAttribute('aria-selected', String(S.tab === 'audio'));
        tabSubs.setAttribute('aria-selected', String(S.tab === 'subs'));

        var focusedBefore = document.activeElement && menu.contains(document.activeElement)
            ? document.activeElement.getAttribute('data-key') : null;
        body.textContent = '';
        if (S.tab === 'audio') renderAudioTab(); else renderSubsTab();
        if (focusedBefore) {
            var again = body.querySelector('[data-key="' + focusedBefore + '"]');
            if (again) again.focus({ preventScroll: true });
        }
    }

    function item(opts) {
        var b = el('button', 'tt-item');
        b.type = 'button';
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', String(!!opts.checked));
        b.setAttribute('data-key', opts.key);
        if (opts.disabled) { b.disabled = true; if (opts.title) b.title = opts.title; }
        b.appendChild(svg(ICON_CHECK, 'tt-check'));
        var main = el('span', 'tt-main');
        main.appendChild(el('span', 'tt-label', opts.label));
        if (opts.detail) main.appendChild(el('span', 'tt-detail', opts.detail));
        b.appendChild(main);
        if (opts.loading) b.appendChild(el('span', 'tt-spin'));
        else if (opts.badge) b.appendChild(el('span', 'tt-badge', opts.badge));
        if (opts.onSelect) b.addEventListener('click', opts.onSelect);
        return b;
    }

    function renderAudioTab() {
        var list = el('div', 'tt-list');
        list.setAttribute('role', 'menu');
        S.data.audio.forEach(function (a) {
            var isOriginal = a.index === S.data.native_audio;
            list.appendChild(item({
                key: 'a' + a.index,
                label: a.label,
                detail: a.detail,
                checked: S.audioSel === a.index,
                badge: isOriginal ? 'Original' : '',
                onSelect: function () { selectAudio(a.index); }
            }));
        });
        body.appendChild(list);
        body.appendChild(el('div', 'tt-note',
            'Only the original track plays natively. Other tracks are converted by the server, ' +
            'so they take a few seconds to start after switching or seeking.'));
    }

    function renderSubsTab() {
        var list = el('div', 'tt-list');
        list.setAttribute('role', 'menu');
        list.appendChild(item({
            key: 's-off', label: 'Off', checked: S.subSel == null,
            onSelect: function () { selectSub(null); }
        }));
        S.data.subtitles.forEach(function (s) {
            list.appendChild(item({
                key: 's' + s.index,
                label: s.label,
                detail: s.supported ? s.detail : s.reason,
                checked: S.subSel === s.index,
                disabled: !s.supported,
                title: s.reason,
                loading: S.subLoading === s.index,
                badge: s.default && !s.forced ? 'Default' : (s.forced ? 'Forced' : ''),
                onSelect: function () { selectSub(s.index); }
            }));
        });
        body.appendChild(list);

        if (S.subSel != null) {
            var tune = el('div', 'tt-tune');
            tune.appendChild(stepper('Size', Math.round(S.size * 100) + '%',
                function () { setSize(S.size - 0.1); }, function () { setSize(S.size + 0.1); }));
            var delayRow = stepper('Delay', (S.delay > 0 ? '+' : '') + S.delay.toFixed(1) + 's',
                function () { setDelay(S.delay - 0.5); }, function () { setDelay(S.delay + 0.5); });
            var reset = el('button', null, 'Reset');
            reset.type = 'button';
            reset.addEventListener('click', function () { setDelay(0); });
            delayRow.querySelector('.tt-step').appendChild(reset);
            tune.appendChild(delayRow);
            body.appendChild(tune);
        }
    }

    function stepper(label, value, onMinus, onPlus) {
        var row = el('div', 'tt-tune-row');
        row.appendChild(el('span', null, label));
        var step = el('div', 'tt-step');
        var minus = el('button', null, '−');
        var plus = el('button', null, '+');
        var out = el('output', null, value);
        minus.type = plus.type = 'button';
        minus.setAttribute('aria-label', label + ' decrease');
        plus.setAttribute('aria-label', label + ' increase');
        minus.addEventListener('click', onMinus);
        plus.addEventListener('click', onPlus);
        step.appendChild(minus); step.appendChild(out); step.appendChild(plus);
        row.appendChild(step);
        return row;
    }

    function audioListed() {
        var a = S.data && S.data.audio;
        return !!a && (a.length >= 2 || (a.length === 1 && !a[0].native));
    }

    /* ---------------------------------------------------------------- subtitles */
    function parseTime(str) {
        var m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(str.trim());
        if (!m) return NaN;
        return (+m[1] || 0) * 3600 + (+m[2]) * 60 + (+m[3]) + (+((m[4] + '00').slice(0, 3))) / 1000;
    }

    function parseVTT(text) {
        var cues = [];
        var blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
        for (var i = 0; i < blocks.length; i++) {
            var lines = blocks[i].split('\n');
            var t = -1;
            for (var j = 0; j < lines.length && j < 2; j++) {
                if (lines[j].indexOf('-->') !== -1) { t = j; break; }
            }
            if (t < 0) continue;
            var parts = lines[t].split('-->');
            var start = parseTime(parts[0]);
            var end = parseTime(parts[1].trim().split(/\s+/)[0]);
            var payload = lines.slice(t + 1).join('\n').trim();
            if (isNaN(start) || isNaN(end) || !payload) continue;
            cues.push({ start: start, end: end, text: payload });
        }
        cues.sort(function (a, b) { return a.start - b.start; });
        return cues;
    }

    /* Escape everything, then allow only <i>, <b>, <u>. */
    function cueHTML(raw) {
        return raw.split(/(<\/?(?:i|b|u)>)/i).map(function (part, i) {
            if (i % 2 === 1) return part.toLowerCase();
            return part.replace(/<[^>]*>/g, '')
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }).join('');
    }

    var shownKey = '';
    function renderCaptions() {
        if (!video || !S.cues.length || S.subSel == null) {
            if (shownKey !== '') { captions.textContent = ''; shownKey = ''; }
            return;
        }
        var t = video.currentTime - S.delay;
        var cues = S.cues;
        var lo = 0, hi = cues.length - 1, last = -1;
        while (lo <= hi) {
            var mid = (lo + hi) >> 1;
            if (cues[mid].start <= t) { last = mid; lo = mid + 1; } else { hi = mid - 1; }
        }
        var active = [];
        for (var i = last; i >= 0 && i > last - 8; i--) {
            if (cues[i].end > t) active.unshift(i);
        }
        var key = active.join(',');
        if (key === shownKey) return;
        shownKey = key;
        captions.textContent = '';
        active.forEach(function (idx) {
            cues[idx].text.split('\n').forEach(function (line) {
                var span = el('span', 'tt-cue');
                span.innerHTML = cueHTML(line);
                captions.appendChild(span);
            });
        });
    }

    var raf = 0;
    function captionLoop() {
        renderCaptions();
        raf = (video && !video.paused && S.cues.length) ? requestAnimationFrame(captionLoop) : 0;
    }
    function kickCaptions() {
        renderCaptions();
        if (!raf && video && !video.paused && S.cues.length) raf = requestAnimationFrame(captionLoop);
    }

    function applyCaptionSize() {
        var w = player.clientWidth || 640;
        captions.style.fontSize = clamp(w * 0.022, 13, 42) * S.size + 'px';
    }
    function setSize(v) {
        S.size = clamp(Math.round(v * 10) / 10, 0.5, 2.5);
        store('tt.sub.size', String(S.size));
        applyCaptionSize();
        renderMenu();
    }
    function setDelay(v) {
        S.delay = clamp(Math.round(v * 10) / 10, -60, 60);
        shownKey = null;   // force a redraw
        renderCaptions();
        renderMenu();
    }
    if (window.ResizeObserver) new ResizeObserver(applyCaptionSize).observe(player);
    applyCaptionSize();

    function errorMessage(res) {
        return res.json().then(function (j) { return j && j.error; }, function () { return null; });
    }

    /* The server returns the cues found so far (X-Subtitle-Complete: 0) while it is still reading the
     * file, so subtitles start appearing within seconds and fill in as the conversion progresses. */
    async function loadSubtitle(index, token) {
        var started = Date.now();
        var gotCues = false;
        while (Date.now() - started < 45 * 60 * 1000) {
            var res = await fetch(endpoint('subtitle', index), { cache: 'no-store' });
            if (token !== subToken) return;
            if (res.status === 202) {
                await sleep(1500);
                if (token !== subToken) return;
                continue;
            }
            if (!res.ok) {
                if (gotCues) return;   // keep what we already have
                throw new Error((await errorMessage(res)) || 'Could not load this subtitle track');
            }
            var complete = res.headers.get('X-Subtitle-Complete') !== '0';
            var cues = parseVTT(await res.text());
            if (token !== subToken) return;
            S.cues = cues;
            shownKey = null;
            if (cues.length && !gotCues) {
                gotCues = true;
                showStatus(complete ? 'Subtitles ready' : 'Subtitles are loading in the background…',
                    { timeout: 3500 });
                S.subLoading = complete ? null : index;
                renderMenu();
            }
            kickCaptions();
            if (complete) {
                S.subLoading = null;
                return;
            }
            await sleep(3000);
            if (token !== subToken) return;
        }
        throw new Error('Subtitle conversion timed out');
    }

    async function selectSub(index) {
        var token = ++subToken;
        S.cues = [];
        S.delay = 0;
        shownKey = null;
        renderCaptions();
        hideStatus();
        if (index == null) {
            S.subSel = null;
            S.subLoading = null;
            renderMenu(); syncButtons();
            return;
        }
        S.subSel = index;
        S.subLoading = index;
        renderMenu(); syncButtons();
        showStatus('Reading subtitles from the file… lines appear as they are found', { busy: true });
        try {
            await loadSubtitle(index, token);
            if (token === subToken && !S.cues.length) showStatus('This subtitle track is empty', { timeout: 3500 });
        } catch (err) {
            if (token !== subToken) return;
            S.subSel = null;
            showStatus(err.message || 'Could not load subtitles', { error: true, timeout: 6000 });
        } finally {
            if (token === subToken) {
                S.subLoading = null;
                renderMenu(); syncButtons();
                kickCaptions();
            }
        }
    }

    /* -------------------------------------------------------------------- audio */
    var A = {
        el: null,
        active: false,        // an alternative (server-converted) track is playing
        track: null,
        offset: 0,            // media time (s) at which the current audio stream starts
        ready: false,
        pausedByUs: false,    // video is held paused while the audio buffers
        ignorePause: false,
        mode: null,           // 'webaudio' | 'mute'
        ctx: null,
        node: null,
        mute: null,
        retries: 0,
        reloadTimer: 0,
        slowTimer: 0,
        prevMuted: false
    };

    function isExternalAudio() { return A.active; }

    function audioEl() {
        if (A.el) return A.el;
        var a = new Audio();
        a.preload = 'auto';
        a.addEventListener('canplay', onAudioReady);
        a.addEventListener('playing', onAudioReady);
        a.addEventListener('waiting', function () {
            // The server is slower than playback: stall the video too instead of drifting.
            if (!A.active || !A.ready || !video || video.paused) return;
            A.ready = false;
            holdVideo();
            showStatus('Buffering audio…', { busy: true });
        });
        a.addEventListener('error', onAudioError);
        A.el = a;
        return a;
    }

    function holdVideo() {
        if (video && !video.paused) {
            A.ignorePause = true;
            A.pausedByUs = true;
            video.pause();
        }
    }

    function resumeVideo() {
        if (!video) return;
        A.pausedByUs = false;
        var p = video.play();
        if (p && p.catch) p.catch(noop);
    }

    function applyVolume() {
        if (!A.el || !video) return;
        A.el.volume = clamp(video.volume, 0, 1);
        A.el.muted = A.mode === 'mute' ? false : video.muted;
    }
    function applyRate(factor) {
        if (!A.el || !video) return;
        A.el.defaultPlaybackRate = clamp(video.playbackRate || 1, 0.25, 4);   // survives load()
        A.el.playbackRate = clamp((video.playbackRate || 1) * (factor || 1), 0.25, 4);
    }

    /* Silence (or restore) the video's own audio without touching the player's volume UI. */
    function initOutput() {
        if (A.mode) return;
        var sameOrigin = false;
        try { sameOrigin = new URL(video.currentSrc || video.src, location.href).origin === location.origin; } catch (e) { /* ignore */ }
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC && sameOrigin) {
            try {
                A.ctx = new AC();
                A.node = A.ctx.createMediaElementSource(video);
                A.node.connect(A.ctx.destination);
                A.mute = A.ctx.createGain();
                A.mute.gain.value = 0;
                A.mute.connect(A.ctx.destination);
                A.mode = 'webaudio';
                return;
            } catch (e) { A.ctx = A.node = null; }
        }
        A.mode = 'mute';
    }
    function routeVideoAudio(on) {
        if (A.mode === 'webaudio') {
            try { A.node.disconnect(); A.node.connect(on ? A.ctx.destination : A.mute); } catch (e) { /* already (dis)connected */ }
        } else if (A.mode === 'mute') {
            if (!on) { A.prevMuted = video.muted; video.muted = true; } else { video.muted = A.prevMuted; }
        }
    }

    function audioURL(at) {
        return endpoint('audio', A.track, '?start=' + Math.max(0, at).toFixed(2));
    }

    function loadAudio(at) {
        var a = audioEl();
        clearTimeout(A.reloadTimer);
        A.offset = at;
        A.ready = false;
        a.pause();
        a.src = audioURL(at);
        a.load();
        applyVolume();
        applyRate();
        holdVideo();
        showStatus('Switching audio…', { busy: true });
        clearTimeout(A.slowTimer);
        A.slowTimer = setTimeout(function () {
            if (A.active && !A.ready) {
                showStatus('Still loading – the server is reading this part of the file from Telegram. ' +
                    'Pick the original track to cancel.', { busy: true });
            }
        }, 8000);
    }

    function onAudioReady() {
        if (!A.active || A.ready) return;
        clearTimeout(A.slowTimer);
        A.ready = true;
        A.retries = 0;
        hideStatus();
        applyVolume();
        applyRate();
        if (A.pausedByUs) {
            resumeVideo();      // the video's 'play' handler starts the audio
        } else if (video && !video.paused) {
            A.el.play().catch(noop);
        }
    }

    function onAudioError() {
        if (!A.active) return;
        if (A.retries < 2 && video) {
            A.retries++;
            clearTimeout(A.reloadTimer);
            A.reloadTimer = setTimeout(function () { if (A.active) loadAudio(video.currentTime); }, 1200);
            return;
        }
        showStatus('Could not play that audio track – using the original', { error: true, timeout: 5000 });
        if (S.data) {
            S.audioSel = S.data.native_audio;   // straight back to the video's own audio (no retry loop)
            useNative();
            renderMenu();
            syncButtons();
        }
    }

    function useExternal(index) {
        initOutput();
        if (A.ctx && A.ctx.state === 'suspended') A.ctx.resume().catch(noop);
        var firstTime = !A.active;
        A.active = true;
        A.track = index;
        A.retries = 0;
        if (firstTime) routeVideoAudio(false);
        loadAudio(video.currentTime);
        // Selecting happens inside a click: touch the element so Safari/iOS lets us play it later.
        try { var p = A.el.play(); if (p && p.catch) p.catch(noop); A.el.pause(); } catch (e) { /* ignore */ }
    }

    function useNative() {
        if (!A.active) return;
        A.active = false;
        A.ready = false;
        clearTimeout(A.reloadTimer);
        clearTimeout(A.slowTimer);
        if (A.el) { A.el.pause(); A.el.removeAttribute('src'); A.el.load(); }
        routeVideoAudio(true);
        hideStatus();
        if (A.pausedByUs) resumeVideo();
        A.pausedByUs = false;
        A.track = null;
    }

    function selectAudio(index, silent) {
        if (!S.data || !video) return;
        var info = S.data.audio.filter(function (a) { return a.index === index; })[0];
        if (!info) return;
        S.audioSel = index;
        if (index === S.data.native_audio && info.native) useNative();
        else useExternal(index);
        if (!silent || S.menuOpen) renderMenu();
        syncButtons();
    }

    function bindVideo(v) {
        video = v;
        v.addEventListener('play', function () {
            poke();
            if (A.ctx && A.ctx.state === 'suspended') A.ctx.resume().catch(noop);
            if (A.active) {
                if (!A.ready) holdVideo();
                else A.el.play().catch(noop);
            }
            kickCaptions();
        });
        v.addEventListener('pause', function () {
            ui.classList.add('tt-active');
            if (A.active) {
                if (A.ignorePause) A.ignorePause = false; else A.pausedByUs = false;
                if (A.el) A.el.pause();
            }
        });
        v.addEventListener('waiting', function () { if (A.active && A.el) A.el.pause(); });
        v.addEventListener('playing', function () {
            if (A.active && A.ready && !v.paused && A.el.paused) A.el.play().catch(noop);
        });
        v.addEventListener('seeking', function () {
            if (A.active) { A.ready = false; if (A.el) A.el.pause(); holdVideo(); }
            shownKey = null;
        });
        v.addEventListener('seeked', function () {
            if (A.active) {
                clearTimeout(A.reloadTimer);
                A.reloadTimer = setTimeout(function () { if (A.active) loadAudio(v.currentTime); }, 150);
            }
            kickCaptions();
        });
        v.addEventListener('ratechange', function () { applyRate(); });
        v.addEventListener('volumechange', applyVolume);
        v.addEventListener('ended', function () { if (A.el) A.el.pause(); });
        v.addEventListener('timeupdate', function () {
            renderCaptions();
            if (!A.active || !A.ready || v.paused || !A.el || A.el.paused) return;
            var drift = (A.el.currentTime + A.offset) - v.currentTime;   // + : audio is ahead
            if (Math.abs(drift) > 2) { loadAudio(v.currentTime); return; }
            applyRate(Math.abs(drift) > 0.15 ? 1 - clamp(drift * 0.3, -0.06, 0.06) : 1);
        });
    }

    /* --------------------------------------------------------------------- init */
    function whenVideo(cb) {
        function find() { return player.querySelector('video, audio'); }
        var v = find();
        if (v) return cb(v);
        var mo = new MutationObserver(function () {
            var found = find();
            if (found) { mo.disconnect(); cb(found); }
        });
        mo.observe(player, { childList: true, subtree: true });
    }

    function reveal() {
        var d = S.data;
        var hasAudio = audioListed();
        var hasSubs = d.subtitles.length > 0;
        if (!hasAudio && !hasSubs) return;
        launchAudio.hidden = !hasAudio;
        launchSubs.hidden = !hasSubs;
        launch.hidden = false;
        var ac = document.getElementById('audioCmd');
        var sc = document.getElementById('subsCmd');
        if (ac) ac.hidden = !hasAudio;
        if (sc) sc.hidden = !hasSubs;
        S.audioSel = d.native_audio;
        S.tab = hasAudio ? 'audio' : 'subs';
        poke();
    }

    async function loadTracks() {
        var ctl = window.AbortController ? new AbortController() : null;
        var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 60000);
        try {
            var res = await fetch(endpoint('tracks'), { cache: 'no-cache', signal: ctl ? ctl.signal : undefined });
            if (!res.ok) return;
            var data = await res.json();
            if (!data || !data.available) return;
            S.data = data;
            reveal();
        } catch (e) { /* the page works fine without the track switcher */ }
        finally { clearTimeout(timer); }
    }

    whenVideo(bindVideo);
    loadTracks();
})();
