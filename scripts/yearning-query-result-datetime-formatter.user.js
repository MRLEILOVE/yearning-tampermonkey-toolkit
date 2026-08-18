// ==UserScript==
// @name         Yearning 查询结果时间格式化
// @namespace    https://yearning.io/
// @version      0.1.0
// @description  将 Yearning 查询结果中的 JS Date 字符串显示为 yyyy-MM-dd HH:mm:ss
// @author       codex
// @match        *://{IP}:{PORT}/*
// @license      MIT
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const tableScopeSelector = '.ant-table-tbody td, .ant-table-tbody .ant-table-cell, .ant-table-tbody .ellipsis';
  const ignoredTagNames = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CODE', 'PRE']);
  const monthMap = {
    Jan: '01',
    Feb: '02',
    Mar: '03',
    Apr: '04',
    May: '05',
    Jun: '06',
    Jul: '07',
    Aug: '08',
    Sep: '09',
    Oct: '10',
    Nov: '11',
    Dec: '12',
  };

  const jsDatePattern = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+GMT[+-]\d{4}\s+\([^)]*\)/g;

  function formatDateText(text) {
    return text.replace(jsDatePattern, (match, month, day, year, hour, minute, second) => {
      const monthNumber = monthMap[month];
      if (!monthNumber) {
        return match;
      }

      return `${year}-${monthNumber}-${String(day).padStart(2, '0')} ${hour}:${minute}:${second}`;
    });
  }

  function formatTextNode(node) {
    const oldValue = node.nodeValue;
    if (!oldValue) {
      return;
    }

    const newValue = formatDateText(oldValue);
    if (newValue !== oldValue) {
      node.nodeValue = newValue;
    }
  }

  function formatAttributes(element) {
    ['title', 'aria-label'].forEach((name) => {
      const oldValue = element.getAttribute(name);
      if (!oldValue) {
        return;
      }

      const newValue = formatDateText(oldValue);
      if (newValue !== oldValue) {
        element.setAttribute(name, newValue);
      }
    });
  }

  function walkAndFormat(root) {
    if (!root) {
      return;
    }

    if (root.nodeType === Node.TEXT_NODE) {
      formatTextNode(root);
      return;
    }

    if (root.nodeType !== Node.ELEMENT_NODE || ignoredTagNames.has(root.tagName)) {
      return;
    }

    formatAttributes(root);

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || ignoredTagNames.has(parent.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node = walker.nextNode();
    while (node) {
      formatTextNode(node);
      node = walker.nextNode();
    }
  }

  function formatTableDates(root = document) {
    const scopes = [];

    if (root.nodeType === Node.ELEMENT_NODE && root.matches(tableScopeSelector)) {
      scopes.push(root);
    }

    if (root.querySelectorAll) {
      scopes.push(...root.querySelectorAll(tableScopeSelector));
    }

    scopes.forEach(walkAndFormat);
  }

  const pendingRoots = new Set();

  function scheduleFormat(root) {
    if (root) {
      pendingRoots.add(root);
    }

    window.clearTimeout(scheduleFormat.timer);
    scheduleFormat.timer = window.setTimeout(() => {
      if (pendingRoots.size === 0) {
        formatTableDates();
        return;
      }

      pendingRoots.forEach((pendingRoot) => formatTableDates(pendingRoot));
      pendingRoots.clear();
    }, 80);
  }

  formatTableDates();

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        formatTextNode(mutation.target);
        continue;
      }

      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          formatTextNode(node);
          return;
        }

        scheduleFormat(node);
      });
    }
  });

  observer.observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true,
  });
})();
