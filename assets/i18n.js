/* Local, reviewed translations. Never replaces a video node or sends text to a service. */
(() => {
  'use strict';
  const STORAGE_KEY = 'weave-language';
  const copy = window.WEAVE_ZH_COPY || {};
  const textBindings = new Map();
  const attributeBindings = new Map();
  const prompts = new Map();
  let language = 'en';
  const requested = new URL(location.href).searchParams.get('lang');
  try { language = requested || localStorage.getItem(STORAGE_KEY) || 'en'; } catch (_) { language = requested || 'en'; }
  if (!['en', 'zh'].includes(language)) language = 'en';

  function translate(value) {
    const source = String(value);
    if (language === 'en') return source;
    const key = source.trim();
    let result = copy[key] || prompts.get(key);
    if (!result) {
      let match;
      if ((match = key.match(/^Example (\d+) \/ (\d+)$/))) result = `案例 ${match[1]} / ${match[2]}`;
      else if ((match = key.match(/^Example (\d+) of (\d+)(.*)$/))) result = `案例 ${match[1]} / ${match[2]}${match[3].replace(/^: /, '：')}`;
      else if ((match = key.match(/^Example (\d+)$/))) result = `案例 ${match[1]}`;
      else if ((match = key.match(/^Video (\d+)$/))) result = `视频 ${match[1]}`;
      else if ((match = key.match(/^(\d+:\d+) of (\d+:\d+)$/))) result = `${match[1]}，总时长 ${match[2]}`;
      else if ((match = key.match(/^(.+), (conditioning input|generated video)$/))) result = `${translate(match[1])}，${match[2] === 'conditioning input' ? '条件输入' : '生成视频'}`;
      else if ((match = key.match(/^Choose a (.+) example$/))) {
        const name = match[1][0].toUpperCase() + match[1].slice(1);
        result = `选择${translate(name)}案例`;
      }
    }
    if (!result) return source;
    return source.slice(0, source.indexOf(key)) + result + source.slice(source.indexOf(key) + key.length);
  }

  function bindNode(node, source = node.nodeValue) {
    if (!source.trim()) { textBindings.delete(node); node.nodeValue = source; return; }
    textBindings.set(node, source);
    node.nodeValue = translate(source);
  }

  function text(element, source) {
    // Replace text only, never a parent containing media or playback controls.
    const value = String(source);
    if (element.childNodes.length === 1 && element.firstChild.nodeType === Node.TEXT_NODE) {
      bindNode(element.firstChild, value);
    } else {
      element.textContent = value;
      if (element.firstChild) bindNode(element.firstChild, value);
    }
  }

  function attribute(element, name, source) {
    if (!attributeBindings.has(element)) attributeBindings.set(element, new Map());
    attributeBindings.get(element).set(name, String(source));
    element.setAttribute(name, translate(source));
  }

  function scan(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.parentElement || node.parentElement.closest('script,style,noscript,[data-no-translate]')) continue;
      if (!textBindings.has(node)) bindNode(node);
    }
    root.querySelectorAll('[aria-label],[alt],[title]').forEach(element => {
      if (element.closest('[data-no-translate]')) return;
      for (const name of ['aria-label', 'alt', 'title']) {
        if (element.hasAttribute(name) && !attributeBindings.get(element)?.has(name)) attribute(element, name, element.getAttribute(name));
      }
    });
    const description = root.querySelector('meta[name="description"]');
    if (description && !attributeBindings.get(description)?.has('content')) attribute(description, 'content', description.content);
  }

  function prune() {
    for (const node of textBindings.keys()) if (!node.isConnected) textBindings.delete(node);
    for (const element of attributeBindings.keys()) if (!element.isConnected) attributeBindings.delete(element);
  }

  function render() {
    prune();
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    for (const [node, source] of textBindings) {
      if (!node.isConnected) { textBindings.delete(node); continue; }
      node.nodeValue = translate(source);
    }
    for (const [element, attrs] of attributeBindings) {
      if (!element.isConnected) { attributeBindings.delete(element); continue; }
      for (const [name, source] of attrs) element.setAttribute(name, translate(source));
    }
    document.querySelectorAll('[data-set-language]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.setLanguage === language));
    });
  }

  function setLanguage(next) {
    if (!['en', 'zh'].includes(next)) return;
    language = next;
    try { localStorage.setItem(STORAGE_KEY, language); } catch (_) { /* Private mode still supports switching. */ }
    const url = new URL(location.href);
    url.searchParams.set('lang', language);
    history.replaceState(null, '', url);
    render();
    window.dispatchEvent(new CustomEvent('weave:languagechange', { detail: { language } }));
  }

  scan(document);
  document.querySelectorAll('[data-set-language]').forEach(button => button.addEventListener('click', () => setLanguage(button.dataset.setLanguage)));
  render();
  // Prompts are separate so refreshing gallery data cannot silently reuse an old translation.
  const ready = fetch('data/prompts.zh.json', { credentials: 'same-origin' })
    .then(response => { if (!response.ok) throw new Error('Translation catalog unavailable'); return response.json(); })
    .then(catalog => {
      for (const entry of Object.values(catalog)) {
        if (entry && typeof entry.en === 'string' && typeof entry.zh === 'string') prompts.set(entry.en.trim(), entry.zh);
      }
      render();
    }).catch(() => { /* Original English remains available if the translation file cannot load. */ });
  window.WeaveI18n = Object.freeze({ translate, text, attribute, prune, ready, getLanguage: () => language });
})();
