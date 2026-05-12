// ==UserScript==
// @name         GitHub PR Files/Lines Count
// @namespace    https://github.com/bxthings/
// @version      0.6.0
// @description  Add changed files/lines to GitHub PR list pages and individual PR pages using your existing GitHub browser session
// @match        https://github.com/*/*/pull/*
// @match        https://github.com/pulls/*
// @grant        GM_addStyle
// @homepageURL  https://github.com/bxthings/github-pr-files-lines-count
// @supportURL   https://github.com/bxthings/github-pr-files-lines-count/issues
// @downloadURL  https://raw.githubusercontent.com/bxthings/github-pr-files-lines-count/main/github-pr-files-lines-count.user.js
// @updateURL    https://raw.githubusercontent.com/bxthings/github-pr-files-lines-count/main/github-pr-files-lines-count.user.js
// ==/UserScript==

(function () {
  'use strict';

  const LOG_PREFIX = '[GhPrCount]';
  const DEBUG = false;
  const CACHE = new Map();
  const MAX_CONCURRENT = 4;
  const MIN_RUN_INTERVAL_MS = 60_000;
  const NAVIGATION_RENDER_DELAY_MS = 900;

  let scheduled = false;
  let lastSeenPageKey = getPageKey();
  const lastRunAtByPageKey = new Map();

  function log(...args) {
    if (DEBUG) console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    if (DEBUG) console.warn(LOG_PREFIX, ...args);
  }

  function error(...args) {
    console.error(LOG_PREFIX, ...args);
  }

  GM_addStyle(`
    .ghprcount-row-stats {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--fgColor-muted, #656d76);
      font-size: 12px;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }

    .ghprcount-row-stats strong {
      color: var(--fgColor-default, #1f2328);
      font-weight: 600;
    }

    .ghprcount-row-stats-inline {
      margin-left: 12px;
    }

    .ghprcount-row-metadata {
      display: flex;
      align-items: center;
    }

    .ghprcount-tab-label {
      margin-left: 0;
    }

    .ghprcount-lines-text,
    .ghprcount-changed-text {
      white-space: pre;
    }

    #ghprcount-debug-badge {
      position: fixed;
      right: 12px;
      bottom: 12px;
      z-index: 999999;
      padding: 8px 10px;
      background: var(--bgColor-default, white);
      border: 2px solid #0969da;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: #0969da;
      max-width: 420px;
    }
  `);

  function getPageKey() {
    return `${location.pathname}${location.search}`;
  }

  function ensureBadge() {
    if (!DEBUG) return null;

    let badge = document.getElementById('ghprcount-debug-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'ghprcount-debug-badge';
      badge.textContent = '[GhPrCount] booting';
      document.body.appendChild(badge);
    }
    return badge;
  }

  function setBadge(text, isError = false) {
    const badge = ensureBadge();
    if (!badge) return;

    badge.textContent = `${LOG_PREFIX} ${text}`;
    badge.style.borderColor = isError ? '#cf222e' : '#0969da';
    badge.style.color = isError ? '#cf222e' : '#0969da';
  }

  function formatNumber(n) {
    return new Intl.NumberFormat().format(n ?? 0);
  }

  function isIndividualPrPage() {
    return /^\/[^/]+\/[^/]+\/pull\/\d+/.test(location.pathname);
  }

  function isPullListPage() {
    return /^\/pulls(\/.*)?$/.test(location.pathname);
  }

  function parsePrFromPath(pathname) {
    const m = pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!m) return null;
    return {
      owner: m[1],
      repo: m[2],
      number: m[3],
      key: `${m[1]}/${m[2]}#${m[3]}`,
      basePath: `/${m[1]}/${m[2]}/pull/${m[3]}`
    };
  }

  function parsePrFromHref(href) {
    try {
      const url = new URL(href, location.origin);
      return parsePrFromPath(url.pathname);
    } catch {
      return null;
    }
  }

  async function sessionFetchText(url) {
    log('sessionFetchText start', url);

    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'X-Requested-With': 'XMLHttpRequest'
      }
    });

    const text = await response.text();

    log('sessionFetchText response', {
      url,
      status: response.status,
      contentType: response.headers.get('content-type'),
      preview: text.slice(0, 400)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    return text;
  }

  function parseHtml(html) {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  function extractLineSummary(text) {
    const normalized = text.replace(/\s+/g, ' ').trim();
    const match = normalized.match(/Lines changed:\s*([\d,]+)\s+additions?\s*&\s*([\d,]+)\s+deletions?/i);
    if (!match) return null;

    return {
      additions: Number(match[1].replace(/,/g, '')),
      deletions: Number(match[2].replace(/,/g, '')),
      summaryText: `Lines changed: ${match[1]} additions & ${match[2]} deletions`
    };
  }

  function parseFileLineChangeEntries(doc) {
    const texts = [
      ...doc.querySelectorAll('div, span, strong, h1, h2, h3, p, a, nav, summary')
    ]
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .filter((text) => text.includes('Lines changed:'));

    const entries = [];
    const seenSummaryTexts = new Set();

    for (const text of texts) {
      const extracted = extractLineSummary(text);
      if (!extracted) continue;

      if (seenSummaryTexts.has(extracted.summaryText)) continue;
      seenSummaryTexts.add(extracted.summaryText);

      entries.push(extracted);
    }

    return entries;
  }

  function parseChangedFileCount(doc, lineEntries) {
    const candidates = [
      ...doc.querySelectorAll('div, span, strong, p, summary')
    ]
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    for (const text of candidates) {
      const viewedMatch =
        text.match(/^(\d+)\s*\/\s*(\d+)\s+viewed$/i) ||
        text.match(/^(\d+)\s+of\s+(\d+)\s+files?\s+viewed$/i);

      if (viewedMatch) {
        return Number(viewedMatch[2]);
      }
    }

    return lineEntries.length;
  }

  function extractCountsFromDocument(doc) {
    const lineEntries = parseFileLineChangeEntries(doc);
    log('extractCountsFromDocument lineEntries', lineEntries);

    if (!lineEntries.length) {
      return null;
    }

    const additions = lineEntries.reduce((sum, entry) => sum + entry.additions, 0);
    const deletions = lineEntries.reduce((sum, entry) => sum + entry.deletions, 0);
    const changedFiles = parseChangedFileCount(doc, lineEntries);

    const result = {
      changedFiles,
      additions,
      deletions
    };

    log('extractCountsFromDocument aggregated result', result);
    return result;
  }

  async function getPrCounts(pr) {
    if (CACHE.has(pr.key)) {
      log('getPrCounts cache hit', pr.key);
      return CACHE.get(pr.key);
    }

    const promise = (async () => {
      const html = await sessionFetchText(`${pr.basePath}/files`);
      const doc = parseHtml(html);
      const counts = extractCountsFromDocument(doc);

      if (!counts) {
        throw new Error(`Could not extract counts from ${pr.basePath}/files`);
      }

      return {
        ...counts,
        changedLines: (counts.additions ?? 0) + (counts.deletions ?? 0)
      };
    })();

    CACHE.set(pr.key, promise);

    try {
      const result = await promise;
      log('getPrCounts resolved', pr.key, result);
      return result;
    } catch (err) {
      CACHE.delete(pr.key);
      throw err;
    }
  }

  function findFilesTab() {
    const selectors = [
      '#prs-files-anchor-tab',
      'a[href$="/changes"]',
      'a[href$="/files"]',
      'a[href*="/changes?"]',
      'a[href*="/files?"]',
      'nav a[href*="/changes"]',
      'nav a[href*="/files"]',
      '[data-testid="pr-files-changed-tab"]',
      'a[data-tab-item="files-changed-tab"]'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      log('findFilesTab selector', selector, !!el);
      if (el) return el;
    }

    return null;
  }

  function updateFilesTab(tab, counts) {
    const srLabel = `Files changed (${formatNumber(counts.changedFiles)} files, ${formatNumber(counts.changedLines)} lines)`;

    let labelSpan = tab.querySelector('.ghprcount-tab-label');
    if (!labelSpan) {
      labelSpan = document.createElement('span');
      labelSpan.className = 'ghprcount-tab-label';

      const firstCounter = tab.querySelector('[aria-hidden="true"][class*="CounterLabel"]');
      if (firstCounter) {
        tab.insertBefore(labelSpan, firstCounter);
      } else {
        const visuallyHidden = tab.querySelector('.prc-VisuallyHidden-VisuallyHidden-Q0qSB');
        if (visuallyHidden) {
          tab.insertBefore(labelSpan, visuallyHidden);
        } else {
          tab.appendChild(labelSpan);
        }
      }
    }

    labelSpan.textContent = 'Files ';

    for (const node of Array.from(tab.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
        if (
          /files changed/i.test(node.textContent) ||
          /files\s+\d+\s+lines\s+\d+\s+changed/i.test(node.textContent)
        ) {
          node.textContent = '';
        }
      }
    }

    const badges = Array.from(tab.querySelectorAll('[aria-hidden="true"][class*="CounterLabel"]'));
    let filesBadge = badges[0] || null;
    let linesBadge = tab.querySelector('.ghprcount-lines-badge');
    let linesText = tab.querySelector('.ghprcount-lines-text');
    let changedText = tab.querySelector('.ghprcount-changed-text');

    if (!filesBadge) {
      filesBadge = document.createElement('span');
      filesBadge.setAttribute('aria-hidden', 'true');
      filesBadge.setAttribute('data-variant', 'secondary');
      filesBadge.className = 'ml-2 prc-CounterLabel-CounterLabel-X-kRU';
      tab.appendChild(filesBadge);
    }

    filesBadge.textContent = formatNumber(counts.changedFiles);
    filesBadge.title = `${formatNumber(counts.changedFiles)} files changed`;

    if (!linesText) {
      linesText = document.createElement('span');
      linesText.className = 'ghprcount-lines-text';
      tab.appendChild(linesText);
    }
    linesText.textContent = ' Lines ';

    if (!linesBadge) {
      linesBadge = document.createElement('span');
      linesBadge.setAttribute('aria-hidden', 'true');
      linesBadge.setAttribute('data-variant', 'secondary');
      linesBadge.className = 'ml-2 prc-CounterLabel-CounterLabel-X-kRU ghprcount-lines-badge';
      tab.appendChild(linesBadge);
    }

    linesBadge.textContent = formatNumber(counts.changedLines);
    linesBadge.title = `${formatNumber(counts.changedLines)} lines changed`;

    if (!changedText) {
      changedText = document.createElement('span');
      changedText.className = 'ghprcount-changed-text';
      tab.appendChild(changedText);
    }
    changedText.textContent = ' changed';

    const visuallyHidden = tab.querySelector('.prc-VisuallyHidden-VisuallyHidden-Q0qSB');
    if (visuallyHidden) {
      visuallyHidden.textContent = ` (${formatNumber(counts.changedFiles)} files, ${formatNumber(counts.changedLines)} lines)`;
    }

    tab.setAttribute('data-ghprcount', 'true');
    tab.setAttribute('aria-label', srLabel);
  }

  async function renderIndividualPrPage() {
    const pr = parsePrFromPath(location.pathname);
    if (!pr) {
      warn('renderIndividualPrPage: failed to parse PR');
      setBadge('failed to parse individual PR URL', true);
      return;
    }

    setBadge(`loading ${pr.key}`);

    try {
      const counts = await getPrCounts(pr);
      const tab = findFilesTab();

      if (!tab) {
        warn('renderIndividualPrPage: files tab not found');
        setBadge('files tab not found', true);
        return;
      }

      log('renderIndividualPrPage update', {
        key: pr.key,
        originalText: tab.textContent,
        counts
      });

      updateFilesTab(tab, counts);
      setBadge(`updated ${pr.key}: files=${counts.changedFiles}, lines=${counts.changedLines}`);
    } catch (err) {
      error('renderIndividualPrPage failed', pr.key, err);
      setBadge(`individual PR failed: ${err.message || err}`, true);
    }
  }

  function findPullListItems() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/pull/"]'));
    const items = [];
    const seen = new Set();

    for (const a of anchors) {
      const pr = parsePrFromHref(a.href);
      if (!pr) continue;

      const key = pr.key;
      if (seen.has(key)) continue;
      seen.add(key);

      const row =
        a.closest('[role="row"]') ||
        a.closest('tr') ||
        a.closest('li') ||
        a.closest('div[data-testid]') ||
        a.parentElement;

      if (!row) continue;

      items.push({
        pr,
        anchor: a,
        row,
        titleText: (a.textContent || '').trim()
      });
    }

    log('findPullListItems', items.map((item) => ({
      key: item.pr.key,
      href: item.anchor.href,
      titleText: item.titleText
    })));

    return items;
  }

  function findRowMetadataContainer(row) {
    const selectors = [
      '.MetadataContainer-module__container__YDbLz',
      '[class*="MetadataContainer-module__container"]',
      '[class*="metadataContainer"]'
    ];

    for (const selector of selectors) {
      const el = row.querySelector(selector);
      if (el) return el;
    }

    return null;
  }

  function ensureMetadataRowStatsContainer(item) {
    const metadataContainer = findRowMetadataContainer(item.row);
    if (!metadataContainer) return null;

    let metadataCell = metadataContainer.querySelector(':scope > .ghprcount-row-metadata');
    if (!metadataCell) {
      metadataCell = document.createElement('div');
      metadataCell.className = 'Metadata-module__metadata__ocr9n Metadata-module__secondary__RkFvd ghprcount-row-metadata';

      const stats = document.createElement('span');
      stats.className = 'ghprcount-row-stats';
      stats.setAttribute('data-ghprcount', 'true');
      metadataCell.appendChild(stats);

      metadataContainer.insertBefore(metadataCell, metadataContainer.firstChild);
    }

    return metadataCell.querySelector('.ghprcount-row-stats');
  }

  function ensureInlineRowStatsContainer(item) {
    let stats = item.anchor.parentElement?.querySelector(':scope > .ghprcount-row-stats-inline');

    if (!stats) {
      stats = document.createElement('span');
      stats.className = 'ghprcount-row-stats ghprcount-row-stats-inline';
      stats.setAttribute('data-ghprcount', 'true');

      if (item.anchor.parentElement) {
        item.anchor.insertAdjacentElement('afterend', stats);
      } else {
        item.anchor.appendChild(stats);
      }
    }

    return stats;
  }

  function ensureRowStatsContainer(item) {
    const metadataStats = ensureMetadataRowStatsContainer(item);
    if (metadataStats) return metadataStats;

    return ensureInlineRowStatsContainer(item);
  }

  function renderStatsIntoRow(item, counts) {
    const stats = ensureRowStatsContainer(item);

    stats.innerHTML = `
      <span><strong>${formatNumber(counts.changedFiles)}</strong> files</span>
      <span>•</span>
      <span><strong>${formatNumber(counts.changedLines)}</strong> lines</span>
    `;

    item.row.setAttribute('data-ghprcount-row', 'true');
  }

  async function runWithConcurrency(items, worker, maxConcurrent = 4) {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(maxConcurrent, items.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!item) return;
        await worker(item);
      }
    });

    await Promise.all(workers);
  }

  async function renderPullListPage() {
    const items = findPullListItems();

    if (!items.length) {
      warn('renderPullListPage: no PR rows found');
      setBadge('no PR rows found', true);
      return;
    }

    let ok = 0;
    let failed = 0;
    setBadge(`loading ${items.length} PRs`);

    await runWithConcurrency(
      items,
      async (item) => {
        try {
          const counts = await getPrCounts(item.pr);
          renderStatsIntoRow(item, counts);
          ok += 1;
          setBadge(`processed ${ok}/${items.length}, failed ${failed}`);
        } catch (err) {
          failed += 1;
          error('renderPullListPage item failed', item.pr.key, err);
          setBadge(`processed ${ok}/${items.length}, failed ${failed}`, failed > 0);
        }
      },
      MAX_CONCURRENT
    );

    setBadge(`done: ok=${ok}, failed=${failed}`, failed > 0);
  }

  async function renderPage() {
    ensureBadge();

    log('renderPage start', {
      href: location.href,
      pathname: location.pathname,
      title: document.title
    });

    if (isIndividualPrPage()) {
      await renderIndividualPrPage();
      return;
    }

    if (isPullListPage()) {
      await renderPullListPage();
      return;
    }

    setBadge('page type not handled');
  }

  function shouldRunForPage(pageKey, force = false) {
    if (force) return true;

    const lastRunAt = lastRunAtByPageKey.get(pageKey) ?? 0;
    const ageMs = Date.now() - lastRunAt;

    if (ageMs < MIN_RUN_INTERVAL_MS) {
      log('skipping render due to throttle', { pageKey, ageMs, minMs: MIN_RUN_INTERVAL_MS });
      return false;
    }

    return true;
  }

  function markRunForPage(pageKey) {
    lastRunAtByPageKey.set(pageKey, Date.now());
  }

  function scheduleRender(reason, options = {}) {
    const { force = false, delayMs = NAVIGATION_RENDER_DELAY_MS } = options;
    const pageKey = getPageKey();

    if (scheduled) {
      log('scheduleRender skipped; already scheduled', { reason, pageKey });
      return;
    }

    if (!shouldRunForPage(pageKey, force)) {
      return;
    }

    scheduled = true;
    log('scheduleRender queued', { reason, pageKey, force, delayMs });

    setTimeout(async () => {
      scheduled = false;

      const currentPageKey = getPageKey();
      if (!force && !shouldRunForPage(currentPageKey, false)) {
        return;
      }

      try {
        markRunForPage(currentPageKey);
        await renderPage();
        log('render finished', { pageKey: currentPageKey, reason });
      } catch (err) {
        error('scheduled render failed', err);
        setBadge(`render failed: ${err.message || err}`, true);
      }
    }, delayMs);
  }

  function handlePotentialNavigation(reason) {
    const currentPageKey = getPageKey();
    if (currentPageKey === lastSeenPageKey) return;

    log('page changed', { from: lastSeenPageKey, to: currentPageKey, reason });
    lastSeenPageKey = currentPageKey;
    scheduleRender(reason, { force: true, delayMs: NAVIGATION_RENDER_DELAY_MS });
  }

  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    setTimeout(() => handlePotentialNavigation('history.pushState'), 0);
    return result;
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    setTimeout(() => handlePotentialNavigation('history.replaceState'), 0);
    return result;
  };

  window.addEventListener('popstate', () => {
    handlePotentialNavigation('popstate');
  });

  const observer = new MutationObserver(() => {
    handlePotentialNavigation('mutation');
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  scheduleRender('initial boot', { force: true, delayMs: 800 });
})();
