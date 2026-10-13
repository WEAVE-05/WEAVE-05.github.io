/* WEAVE-0.5 public gallery. Native browser APIs only; no audit metadata is shown. */
(() => {
  'use strict';

  const setText = (element, value) => window.WeaveI18n ? window.WeaveI18n.text(element, value) : (element.textContent = value);
  const setLabel = (element, name, value) => window.WeaveI18n ? window.WeaveI18n.attribute(element, name, value) : element.setAttribute(name, value);

  const TASK_ORDER = ['joint', 'newview', 'c2v', 'v2c'];
  const TASK_COPY = {
    joint: { title: 'Joint generation', description: 'Explore corresponding RGB, depth, edge, and segmentation videos across multiple views.' },
    newview: { title: 'Cross-view completion', description: 'Explore generated viewpoints alongside the observed view.' },
    c2v: { title: 'Modality-conditioned generation', description: 'Explore RGB generation conditioned on a visual modality.' },
    v2c: { title: 'Visual modality prediction', description: 'Explore visual modality predictions alongside their RGB input.' }
  };
  const instances = {};
  let activeInstance = null;
  let pageDisposed = false;

  function claimPlayback(instance) {
    if (activeInstance && activeInstance !== instance) {
      activeInstance.pause('Paused while another example is playing.');
    }
    activeInstance = instance;
  }

  function createInstance(root, data) {
    const ids = ['demo-title', 'demo-description', 'demo-count', 'demo-prompt',
      'video-grid', 'case-strip', 'play-toggle', 'replay', 'timeline', 'time-label',
      'case-prev', 'case-next', 'gallery-status', 'demo-player'];
    const dom = {};
    const removers = [];
    const task = root.dataset.galleryTask;
    const groups = { [task]: data.cases.filter(entry => entry && entry.task === task &&
      Array.isArray(entry.streams) && entry.streams.length > 0 &&
      entry.streams.every(stream => stream && mediaURL(stream.src))) };
    let api = null;
    let caseIndex = 0;
    let videos = [];
    let clock = null;
    let epoch = 0;
    let operation = 0;
    let frame = 0;
    let wantsToPlay = false;
    let starting = false;
    let loading = false;
    let seekTarget = null;
    let failed = false;
    let disposed = false;
    let loadTimer = 0;
    let observer = null;

    function listen(target, name, handler, options) {
      target.addEventListener(name, handler, options);
      removers.push(() => target.removeEventListener(name, handler, options));
    }

    function node(tag, className, text) {
      const result = document.createElement(tag);
      if (className) result.className = className;
      if (text !== undefined) setText(result, String(text));
      return result;
    }

    function mediaURL(value) {
      if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') ||
          /^[a-z][a-z0-9+.-]*:/i.test(value) || value.split('/').includes('..')) return '';
      return value.split('/').map(encodeURIComponent).join('/');
    }

    function currentCase() { return (groups[task] || [])[caseIndex] || null; }

    function caseIdentity(entry) {
      return [entry.robot, entry.dataset].filter(value => typeof value === 'string' && value.trim()).join(' · ');
    }

    function renderIdentity(entry) {
      const container = root.querySelector('[data-gallery="case-meta"]');
      if (!container) return;
      const fragment = document.createDocumentFragment();
      for (const [key, label] of [['robot', 'Robot'], ['dataset', 'Source dataset'], ['environment', 'Scene']]) {
        if (typeof entry[key] !== 'string' || !entry[key].trim()) continue;
        const field = node('span', 'case-meta-field');
        field.append(node('span', 'case-meta-key', label), node('strong', 'case-meta-value', entry[key]));
        fragment.append(field);
      }
      container.replaceChildren(fragment);
      container.hidden = !container.childElementCount;
    }

    function duration() {
      const lengths = videos.map(video => video.duration).filter(value => Number.isFinite(value) && value > 0);
      if (lengths.length === videos.length && lengths.length) return Math.min(...lengths);
      const entry = currentCase();
      const recorded = entry ? entry.streams.map(stream => Number(stream.duration)).filter(value => Number.isFinite(value) && value > 0) : [];
      return recorded.length ? Math.min(...recorded) : 0;
    }

    function formattedTime(value) {
      const seconds = Math.max(0, Number(value) || 0);
      return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
    }

    function report(message, error = false) {
      if (!dom['gallery-status']) return;
      setText(dom['gallery-status'], message);
      dom['gallery-status'].classList.toggle('is-error', error);
    }

    function publicState() {
      return Object.freeze({ task, caseIndex, caseCount: (groups[task] || []).length,
        playing: wantsToPlay && !loading && !starting && !failed,
        loading, failed, currentTime: clock ? clock.currentTime : 0,
        duration: duration(), streamCount: videos.length });
    }

    function emit(name) {
      if (dom['demo-player']) dom['demo-player'].dispatchEvent(new CustomEvent(name, { bubbles: true, detail: publicState() }));
    }

    function updateControls() {
      const hasCase = Boolean(currentCase() && videos.length);
      dom['play-toggle'].disabled = !hasCase;
      setText(dom['play-toggle'], wantsToPlay ? 'Pause' : 'Play all');
      setLabel(dom['play-toggle'], 'aria-label', wantsToPlay ? 'Pause all videos' : 'Play all videos');
      dom['play-toggle'].setAttribute('aria-pressed', String(wantsToPlay));
      dom.replay.disabled = !hasCase;
      dom.timeline.disabled = !hasCase || duration() === 0;
      dom['demo-player'].setAttribute('aria-busy', String(loading));
      dom['case-prev'].disabled = (groups[task] || []).length < 2;
      dom['case-next'].disabled = (groups[task] || []).length < 2;
      paintTimeline();
      emit('weave:statechange');
    }

    function paintTimeline() {
      if (!dom.timeline) return;
      const total = duration();
      const time = seekTarget !== null ? seekTarget : (clock ? clock.currentTime : 0);
      dom.timeline.max = total || 1;
      dom.timeline.value = Math.min(time, total || time);
      setLabel(dom.timeline, 'aria-valuetext', `${formattedTime(time)} of ${formattedTime(total)}`);
      dom['time-label'].textContent = `${formattedTime(time)} / ${formattedTime(total)}`;
    }

    function stopMotion() {
      operation += 1;
      starting = false;
      cancelAnimationFrame(frame);
      frame = 0;
      videos.forEach(video => video.pause());
    }

    function clearLoadTimer() { clearTimeout(loadTimer); loadTimer = 0; }

    function releaseVideos() {
      epoch += 1;
      wantsToPlay = false;
      seekTarget = null;
      loading = false;
      clearLoadTimer();
      stopMotion();
      const old = videos;
      videos = [];
      clock = null;
      old.forEach(video => {
        video.removeAttribute('src');
        video.removeAttribute('poster');
        video.load();
      });
    }

    function pause(message = 'Paused.') {
      wantsToPlay = false;
      if (activeInstance === api) activeInstance = null;
      loading = false;
      clearLoadTimer();
      stopMotion();
      report(message, failed);
      updateControls();
    }

    function videoError() {
      failed = true;
      pause('A video could not be loaded. Check your connection, then press Play to retry.');
    }

    function holdForBuffer() {
      if (!wantsToPlay || failed) return;
      loading = true;
      stopMotion();
      report('Loading videos…');
      updateControls();
      queueMicrotask(tryStart);
    }

    function readyToPlay() {
      return videos.length > 0 && videos.every(video => video.readyState >= 3 && !video.seeking && !video.error);
    }

    function finishSeeking() {
      if (seekTarget === null) return true;
      const target = seekTarget;
      if (!videos.every(video => video.readyState >= 2 && !video.seeking && Math.abs(video.currentTime - target) < 0.16)) return false;
      seekTarget = null;
      paintTimeline();
      return true;
    }

    async function tryStart() {
      if (disposed || !wantsToPlay || starting || failed || !finishSeeking() || !readyToPlay()) return;
      if (!loading && videos.every(video => !video.paused)) return;
      const token = ++operation;
      const caseEpoch = epoch;
      const activeVideos = [...videos];
      starting = true;
      loading = true;
      updateControls();
      const results = await Promise.allSettled(activeVideos.map(video => video.play()));
      if (caseEpoch !== epoch || token !== operation || disposed) return;
      starting = false;
      if (results.some(result => result.status === 'rejected')) {
        pause('Playback was interrupted. Press Play to try again.');
        return;
      }
      if (!wantsToPlay || !readyToPlay()) { holdForBuffer(); return; }
      loading = false;
      clearLoadTimer();
      report('Playing.');
      updateControls();
      tick();
    }

    function tick() {
      cancelAnimationFrame(frame);
      frame = 0;
      if (!wantsToPlay || loading || !clock) return;
      const time = clock.currentTime;
      const end = duration();
      if (end && time >= end - 0.025) { pause('Playback complete. Select Replay to watch again.'); return; }
      const outOfSync = videos.some(video => video !== clock && Math.abs(video.currentTime - time) > 0.14);
      if (outOfSync) { seek(time); return; }
      paintTimeline();
      frame = requestAnimationFrame(tick);
    }

    function play() {
      if (!videos.length || disposed) return;
      claimPlayback(api);
      wantsToPlay = true;
      const retry = failed;
      failed = false;
      loading = true;
      report('Loading videos…');
      if (clock && duration() && clock.currentTime >= duration() - 0.1) seek(0);
      const caseEpoch = epoch;
      videos.forEach(video => {
        if (retry || video.preload === 'none') {
          video.preload = 'auto';
          video.load();
        }
      });
      clearLoadTimer();
      loadTimer = setTimeout(() => {
        if (epoch === caseEpoch && wantsToPlay && loading) report('Still loading this video group. You can pause or choose another example.');
      }, 18000);
      updateControls();
      tryStart();
    }

    function seek(value) {
      if (!videos.length) return;
      const total = duration();
      const target = Math.max(0, Math.min(Number(value) || 0, Math.max(0, total - 0.01)));
      stopMotion();
      seekTarget = target;
      loading = wantsToPlay;
      videos.forEach(video => {
        if (video.readyState >= 1) {
          try { video.currentTime = target; } catch (_) { /* loadedmetadata retries */ }
        } else if (video.preload === 'none') {
          video.preload = 'auto';
          video.load();
        }
      });
      updateControls();
      queueMicrotask(() => { finishSeeking(); tryStart(); });
    }

    function replay() { seek(0); play(); }

    function renderStrip() {
      const fragment = document.createDocumentFragment();
      const entries = groups[task] || [];
      entries.forEach((entry, index) => {
        const button = node('button', `case-thumb${index === caseIndex ? ' is-active' : ''}`);
        button.type = 'button';
        button.dataset.caseId = entry.id;
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(index === caseIndex));
        const identity = caseIdentity(entry);
        setLabel(button, 'aria-label', `Example ${index + 1} of ${entries.length}${identity ? ': ' + identity : ''}`);
        setLabel(button, 'title', identity || `Example ${index + 1}`);
        button.tabIndex = index === caseIndex ? 0 : -1;
        const preview = entry.streams.find(stream => stream.kind !== 'input' && stream.modality === 'rgb') || entry.streams[0];
        const poster = preview && mediaURL(preview.poster);
        if (poster) {
          const image = node('img', 'case-thumb-image');
          image.src = poster;
          image.alt = '';
          image.loading = 'lazy';
          image.decoding = 'async';
          button.append(image);
        }
        button.append(node('span', 'case-thumb-label', entry.robot || entry.dataset || `Example ${String(index + 1).padStart(2, '0')}`));
        button.addEventListener('click', () => selectCase(index));
        fragment.append(button);
      });
      dom['case-strip'].replaceChildren(fragment);
    }

    function selectCase(index, options = {}) {
      const entries = groups[task] || [];
      if (!entries.length) return;
      const requested = typeof index === 'string' ? entries.findIndex(entry => entry.id === index) : Number(index);
      if (!Number.isInteger(requested) || requested < 0 || requested >= entries.length) return;
      const resume = options.autoplay === undefined ? wantsToPlay : Boolean(options.autoplay);
      releaseVideos();
      failed = false;
      caseIndex = requested;
      const entry = currentCase();
      const activeEpoch = epoch;
      setText(dom['demo-count'], `Example ${caseIndex + 1} / ${entries.length}`);
      setText(dom['demo-prompt'], entry.prompt || '');
      renderIdentity(entry);
      dom['video-grid'].dataset.streamCount = String(entry.streams.length);
      const fragment = document.createDocumentFragment();
      entry.streams.forEach((stream, streamIndex) => {
        const card = node('figure', 'video-card');
        const head = node('div', 'video-card-header');
        const label = String(stream.label || `Video ${streamIndex + 1}`);
        const input = stream.kind === 'input';
        head.append(node('h4', 'video-label', label), node('span', `stream-kind ${input ? 'is-input' : 'is-output'}`, input ? 'Input' : 'Generated'));
        card.append(head);
        const video = node('video', 'stream-video');
        video.muted = true;
        video.defaultMuted = true;
        video.playsInline = true;
        video.preload = 'none';
        video.controls = false;
        video.disablePictureInPicture = true;
        setLabel(video, 'aria-label', `${label}, ${input ? 'conditioning input' : 'generated video'}`);
        const src = mediaURL(stream.src);
        const poster = mediaURL(stream.poster);
        if (src) video.src = src;
        if (poster) video.poster = poster;
        if (Number(stream.width) > 0) video.width = Number(stream.width);
        if (Number(stream.height) > 0) video.height = Number(stream.height);
        const active = handler => () => { if (activeEpoch === epoch && !disposed) handler(); };
        video.addEventListener('error', active(videoError));
        video.addEventListener('waiting', active(holdForBuffer));
        video.addEventListener('stalled', active(() => { if (video.readyState < 3) holdForBuffer(); }));
        video.addEventListener('canplay', active(() => { finishSeeking(); tryStart(); }));
        video.addEventListener('canplaythrough', active(tryStart));
        video.addEventListener('seeked', active(() => { finishSeeking(); tryStart(); paintTimeline(); }));
        video.addEventListener('loadedmetadata', active(() => {
          if (seekTarget !== null) { try { video.currentTime = seekTarget; } catch (_) { /* later readiness event */ } }
          paintTimeline();
          updateControls();
        }));
        video.addEventListener('timeupdate', active(paintTimeline));
        video.addEventListener('ended', active(() => { if (wantsToPlay) pause('Playback complete. Select Replay to watch again.'); }));
        card.append(video);
        fragment.append(card);
        videos.push(video);
        if (!clock && !input) clock = video;
      });
      if (!clock) clock = videos[0] || null;
      dom['video-grid'].replaceChildren(fragment);
      renderStrip();
      report('Select Play to explore this example.');
      updateControls();
      // Drop translation bindings belonging to the previous case's detached media.
      if (window.WeaveI18n) window.WeaveI18n.prune();
      emit('weave:casechange');
      if (resume) play();
    }

    function moveCase(offset, focus = false) {
      const count = (groups[task] || []).length;
      if (!count) return;
      selectCase((caseIndex + offset + count) % count);
      const active = dom['case-strip'].querySelector('[aria-selected="true"]');
      if (active) {
        if (focus) active.focus({ preventScroll: true });
        active.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest', inline: 'nearest' });
      }
    }

    function bindControls() {
      dom['case-strip'].setAttribute('role', 'listbox');
      setLabel(dom['case-strip'], 'aria-label', `Choose a ${TASK_COPY[task].title.toLowerCase()} example`);
      listen(dom['case-strip'], 'keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        if (event.key === 'Home' || event.key === 'End') {
          selectCase(event.key === 'Home' ? 0 : groups[task].length - 1);
          dom['case-strip'].querySelector('[aria-selected="true"]').focus({ preventScroll: true });
        } else moveCase(event.key === 'ArrowRight' ? 1 : -1, true);
      });
      listen(dom['play-toggle'], 'click', () => wantsToPlay ? pause() : play());
      listen(dom.replay, 'click', replay);
      listen(dom['case-prev'], 'click', () => moveCase(-1));
      listen(dom['case-next'], 'click', () => moveCase(1));
      setLabel(dom['case-prev'], 'aria-label', 'Previous example');
      setLabel(dom['case-next'], 'aria-label', 'Next example');
      dom.timeline.min = '0';
      dom.timeline.step = '0.01';
      setLabel(dom.timeline, 'aria-label', 'Video group playback position');
      listen(dom.timeline, 'input', () => seek(dom.timeline.value));
      dom['gallery-status'].setAttribute('role', 'status');
      dom['gallery-status'].setAttribute('aria-live', 'polite');
      listen(document, 'visibilitychange', () => {
        if (document.hidden && wantsToPlay) pause('Paused while this page is in the background.');
      });
      if ('IntersectionObserver' in window) {
        observer = new IntersectionObserver(entries => {
          if (entries.some(entry => !entry.isIntersecting) && wantsToPlay) pause('Paused while the gallery is off screen.');
        }, { threshold: 0 });
        observer.observe(dom['demo-player']);
      }
      listen(window, 'pagehide', () => pause());
    }

    ids.forEach(id => { dom[id] = root.querySelector(`[data-gallery="${id}"]`); });
    const missing = ids.filter(id => !dom[id]);
    if (missing.length) throw new Error(`${task} gallery containers missing: ${missing.join(', ')}`);
    api = Object.freeze({
      getState: publicState,
      selectCase,
      play,
      pause,
      seek,
      replay,
      destroy() {
        disposed = true;
        if (activeInstance === api) activeInstance = null;
        releaseVideos();
        if (observer) observer.disconnect();
        removers.splice(0).forEach(remove => remove());
      }
    });
    const copy = { ...TASK_COPY[task], ...((data.tasks || {})[task] || {}) };
    if (!dom['demo-title'].textContent.trim()) setText(dom['demo-title'], copy.title);
    if (!dom['demo-description'].textContent.trim()) setText(dom['demo-description'], copy.description);
    bindControls();
    if (groups[task].length) selectCase(0, { autoplay: false });
    else { report('No examples are currently available.'); updateControls(); }
    return api;
  }

  async function init() {
    if (document.readyState === 'loading') await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    if (pageDisposed) return false;
    const roots = [...document.querySelectorAll('[data-gallery-task]')];
    if (!roots.length) throw new Error('No gallery sections were found.');
    roots.forEach(root => {
      const status = root.querySelector('[data-gallery="gallery-status"]');
      if (status) setText(status, 'Loading examples…');
    });
    const response = await fetch('data/gallery.json', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Gallery catalog could not be loaded.');
    const payload = await response.json();
    if (window.WeaveI18n) await window.WeaveI18n.ready;
    if (pageDisposed) return false;
    if (!payload || !Array.isArray(payload.cases)) throw new Error('Gallery catalog is invalid.');
    for (const root of roots) {
      const task = root.dataset.galleryTask;
      if (!TASK_ORDER.includes(task) || instances[task]) continue;
      instances[task] = createInstance(root, payload);
    }
    return Object.freeze(instances);
  }

  const ready = init().catch(error => {
    document.querySelectorAll('[data-gallery="gallery-status"]').forEach(status => {
      setText(status, 'The gallery could not load. Please refresh the page or try again later.');
      status.classList.add('is-error');
    });
    document.querySelectorAll('[data-gallery="play-toggle"]').forEach(button => { button.disabled = true; });
    console.error('[WEAVE gallery]', error.message);
    return false;
  });

  window.WeaveGallery = Object.freeze({
    ready,
    instances,
    getState: () => Object.fromEntries(Object.entries(instances).map(([task, instance]) => [task, instance.getState()])),
    pauseAll() { Object.values(instances).forEach(instance => instance.pause()); },
    destroy() {
      pageDisposed = true;
      Object.values(instances).forEach(instance => instance.destroy());
      activeInstance = null;
    }
  });
})();
