// ==UserScript==
// @name         Yearning 查询结果视图切换
// @namespace    https://yearning.io/
// @version      1.3.0
// @description  在当前 Yearning 站点的查询结果中增加网格/表单视图，并为查询字段显示数据库 COMMENT 注释。
// @author       codex
// @match        *://{IP}:{PORT}/*
// @license      MIT
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const STATE_BY_EXPORT_BUTTON = new WeakMap();
  const ACTIVE_STATES = new Set();
  const TABLE_COMMENT_CACHE = new Map();
  const EMPTY_VALUE_TEXT = '（空）';
  const EMPTY_COMMENT_TEXT = '—';
  const TARGET_ORIGIN = window.location.origin;
  let latestQueryContext = null;
  let scanFrame = 0;

  function isTargetSite() {
    return window.location.origin === TARGET_ORIGIN;
  }

  function decodeMessagePack(data) {
    let bytes;
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      return null;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const textDecoder = new TextDecoder('utf-8');
    let offset = 0;

    function ensureAvailable(length) {
      if (offset + length > bytes.length) {
        throw new Error('MessagePack 数据不完整');
      }
    }

    function readUnsigned(length) {
      ensureAvailable(length);
      let value;
      if (length === 1) {
        value = view.getUint8(offset);
      } else if (length === 2) {
        value = view.getUint16(offset);
      } else if (length === 4) {
        value = view.getUint32(offset);
      } else {
        value = Number(view.getBigUint64(offset));
      }
      offset += length;
      return value;
    }

    function readSigned(length) {
      ensureAvailable(length);
      let value;
      if (length === 1) {
        value = view.getInt8(offset);
      } else if (length === 2) {
        value = view.getInt16(offset);
      } else if (length === 4) {
        value = view.getInt32(offset);
      } else {
        value = Number(view.getBigInt64(offset));
      }
      offset += length;
      return value;
    }

    function readString(length) {
      ensureAvailable(length);
      const value = textDecoder.decode(bytes.subarray(offset, offset + length));
      offset += length;
      return value;
    }

    function readArray(length) {
      const value = [];
      for (let index = 0; index < length; index += 1) {
        value.push(readValue());
      }
      return value;
    }

    function readMap(length) {
      const value = {};
      for (let index = 0; index < length; index += 1) {
        const key = readValue();
        value[String(key)] = readValue();
      }
      return value;
    }

    function readValue() {
      ensureAvailable(1);
      const prefix = bytes[offset];
      offset += 1;

      if (prefix <= 0x7f) {
        return prefix;
      }
      if (prefix >= 0xe0) {
        return prefix - 0x100;
      }
      if ((prefix & 0xe0) === 0xa0) {
        return readString(prefix & 0x1f);
      }
      if ((prefix & 0xf0) === 0x80) {
        return readMap(prefix & 0x0f);
      }
      if ((prefix & 0xf0) === 0x90) {
        return readArray(prefix & 0x0f);
      }

      switch (prefix) {
        case 0xc0: return null;
        case 0xc2: return false;
        case 0xc3: return true;
        case 0xca: {
          ensureAvailable(4);
          const value = view.getFloat32(offset);
          offset += 4;
          return value;
        }
        case 0xcb: {
          ensureAvailable(8);
          const value = view.getFloat64(offset);
          offset += 8;
          return value;
        }
        case 0xcc: return readUnsigned(1);
        case 0xcd: return readUnsigned(2);
        case 0xce: return readUnsigned(4);
        case 0xcf: return readUnsigned(8);
        case 0xd0: return readSigned(1);
        case 0xd1: return readSigned(2);
        case 0xd2: return readSigned(4);
        case 0xd3: return readSigned(8);
        case 0xd9: return readString(readUnsigned(1));
        case 0xda: return readString(readUnsigned(2));
        case 0xdb: return readString(readUnsigned(4));
        case 0xdc: return readArray(readUnsigned(2));
        case 0xdd: return readArray(readUnsigned(4));
        case 0xde: return readMap(readUnsigned(2));
        case 0xdf: return readMap(readUnsigned(4));
        default: return null;
      }
    }

    return bytes.length ? readValue() : null;
  }

  function captureQueryContext(data) {
    const payload = decodeMessagePack(data);
    if (!payload || payload.type !== 4 || typeof payload.sql !== 'string') {
      return;
    }

    const sql = payload.sql.trim();
    if (!sql) {
      return;
    }

    latestQueryContext = {
      sql,
      schema: typeof payload.schema === 'string' ? payload.schema.trim() : '',
      sourceId: getCurrentSourceIdFallback()
    };
    queueScan();
  }

  function installQueryContextCapture() {
    const prototype = window.WebSocket?.prototype;
    if (!prototype || prototype.__yvQueryContextCaptureInstalled) {
      return;
    }

    const originalSend = prototype.send;
    Object.defineProperty(prototype, '__yvQueryContextCaptureInstalled', {
      value: true,
      configurable: true
    });
    prototype.send = function yearningViewSend(data) {
      try {
        captureQueryContext(data);
      } catch (_error) {
        // 解析失败不影响 Yearning 原有查询消息发送。
      }
      return originalSend.apply(this, arguments);
    };
  }

  const style = document.createElement('style');
  style.textContent = `
    .yv-view-switcher {
      display: inline-flex;
      margin-left: 8px;
      vertical-align: middle;
      border: 1px solid #d9d9d9;
      border-radius: 4px;
      overflow: hidden;
      background: #fff;
    }

    .yv-view-button {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 24px;
      padding: 0 8px;
      border: 0;
      border-right: 1px solid #d9d9d9;
      background: #fff;
      color: rgba(0, 0, 0, 0.65);
      font-size: 12px;
      line-height: 22px;
      cursor: pointer;
      transition: color 0.2s, background-color 0.2s;
    }

    .yv-view-button:last-child {
      border-right: 0;
    }

    .yv-view-button:hover {
      color: #1890ff;
      background: #f5faff;
    }

    .yv-view-button:focus-visible {
      position: relative;
      z-index: 1;
      outline: 2px solid rgba(24, 144, 255, 0.35);
      outline-offset: -2px;
    }

    .yv-view-button.yv-active {
      background: #1890ff;
      color: #fff;
    }

    .yv-view-icon {
      width: 13px;
      height: 13px;
      fill: currentColor;
      flex: 0 0 auto;
    }

    .yv-grid-hidden {
      display: none !important;
    }

    .ant-table-thead th.yv-grid-header-with-comment.ant-table-cell-ellipsis {
      height: auto;
      white-space: normal;
    }

    .yv-grid-field-comment {
      display: block;
      min-height: 16px;
      margin-top: 3px;
      color: rgba(0, 0, 0, 0.42);
      font-size: 11px;
      font-weight: 400;
      line-height: 1.35;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    .yv-grid-field-comment.yv-comment-loading {
      color: rgba(0, 0, 0, 0.25);
    }

    .yv-form-view[hidden] {
      display: none !important;
    }

    .yv-form-view {
      margin-top: 16px;
      color: rgba(0, 0, 0, 0.85);
    }

    .yv-form-summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 38px;
      padding: 0 12px;
      border: 1px solid #f0f0f0;
      border-bottom: 0;
      background: #fafafa;
      font-size: 13px;
    }

    .yv-form-summary strong {
      font-weight: 600;
    }

    .yv-form-status {
      color: rgba(0, 0, 0, 0.45);
      font-size: 12px;
    }

    .yv-form-scroll {
      width: 100%;
      overflow-x: auto;
    }

    .yv-form-table {
      width: 100%;
      min-width: 760px;
      border-collapse: collapse;
      table-layout: fixed;
      background: #fff;
      font-size: 13px;
    }

    .yv-form-table th,
    .yv-form-table td {
      padding: 8px 12px;
      border: 1px solid #f0f0f0;
      text-align: left;
      vertical-align: top;
      line-height: 1.6;
    }

    .yv-form-table thead th {
      background: #fafafa;
      color: rgba(0, 0, 0, 0.85);
      font-weight: 600;
    }

    .yv-form-table tbody th {
      background: #fafafa;
      color: rgba(0, 0, 0, 0.85);
      font-weight: 500;
      overflow-wrap: anywhere;
    }

    .yv-form-table .yv-form-field-name {
      width: 200px;
    }

    .yv-form-table .yv-form-comment-heading,
    .yv-form-table .yv-form-comment-cell {
      width: 260px;
    }

    .yv-form-comment-cell {
      background: #fcfcfc;
      color: rgba(0, 0, 0, 0.55);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
      user-select: text;
    }

    .yv-form-comment-cell.yv-empty-comment,
    .yv-form-comment-cell.yv-comment-loading {
      color: rgba(0, 0, 0, 0.25);
    }

    .yv-form-value {
      min-height: 21px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
      user-select: text;
    }

    .yv-empty-value {
      color: rgba(0, 0, 0, 0.25);
      font-style: normal;
    }

    .yv-no-record {
      padding: 32px 16px;
      border: 1px solid #f0f0f0;
      color: rgba(0, 0, 0, 0.45);
      text-align: center;
      background: #fff;
    }

    .yv-form-pagination {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      min-height: 48px;
      padding: 8px 0;
      color: rgba(0, 0, 0, 0.65);
      font-size: 12px;
      flex-wrap: wrap;
    }

    .yv-pagination-total,
    .yv-pagination-size {
      white-space: nowrap;
    }

    .yv-pagination-size {
      margin-left: 4px;
      padding: 1px 7px;
      border: 1px solid #d9d9d9;
      border-radius: 2px;
      background: #fff;
    }

    .yv-page-list {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .yv-page-button,
    .yv-page-number {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 24px;
      height: 24px;
      padding: 0 6px;
      border: 1px solid #d9d9d9;
      border-radius: 2px;
      background: #fff;
      color: rgba(0, 0, 0, 0.65);
      font: inherit;
      line-height: 22px;
      cursor: pointer;
    }

    .yv-page-button:hover:not(:disabled),
    .yv-page-number:hover:not(.yv-current) {
      border-color: #1890ff;
      color: #1890ff;
    }

    .yv-page-button:disabled {
      color: rgba(0, 0, 0, 0.25);
      cursor: not-allowed;
      background: #f5f5f5;
    }

    .yv-page-number.yv-current {
      border-color: #1890ff;
      background: #1890ff;
      color: #fff;
      cursor: default;
    }

    .yv-page-ellipsis {
      min-width: 20px;
      color: rgba(0, 0, 0, 0.35);
      text-align: center;
      user-select: none;
    }

    .yv-form-view.yv-loading .yv-form-scroll {
      opacity: 0.55;
    }

    @media (max-width: 760px) {
      .yv-view-button span {
        display: none;
      }

      .yv-view-button {
        padding: 0 7px;
      }

      .yv-form-table .yv-form-field-name {
        width: 28%;
      }

      .yv-form-table .yv-form-comment-heading,
      .yv-form-table .yv-form-comment-cell {
        width: 32%;
      }
    }
  `;
  document.head.appendChild(style);

  function normalizeButtonText(button) {
    return (button.textContent || '').replace(/\s+/g, '');
  }

  function createViewButton(label, iconSvg) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'yv-view-button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = `${iconSvg}<span>${label}</span>`;
    return button;
  }

  function createNavigationButton(label, text) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'yv-page-button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.textContent = text;
    return button;
  }

  function findTableWrapper(root) {
    return root.querySelector('.ant-table-wrapper');
  }

  function findResultTable(wrapper) {
    return wrapper && (
      wrapper.querySelector('.ant-table-content > table') ||
      wrapper.querySelector('.ant-table-container table') ||
      wrapper.querySelector('table')
    );
  }

  function getDataRows(table) {
    if (!table) {
      return [];
    }

    return Array.from(table.querySelectorAll('tbody.ant-table-tbody > tr.ant-table-row'))
      .filter((row) => !row.classList.contains('ant-table-measure-row') && row.getAttribute('aria-hidden') !== 'true');
  }

  function getDirectCells(row) {
    return Array.from(row.children).filter((child) => child.tagName === 'TD');
  }

  function getHeaderText(headerCell, index) {
    const storedFieldName = headerCell.dataset.yvFieldName;
    if (storedFieldName) {
      return storedFieldName;
    }

    const title = headerCell.getAttribute('title');
    if (title && title.trim()) {
      return title.trim();
    }

    const copy = headerCell.cloneNode(true);
    copy.querySelectorAll('.ant-table-resize-handle, .yv-grid-field-comment').forEach((element) => element.remove());
    const text = (copy.textContent || '').trim();
    return text || `字段 ${index + 1}`;
  }

  function getYearningStore() {
    const appRoot = document.querySelector('#app');
    return (
      appRoot?.__vue_app__?.config?.globalProperties?.$store ||
      appRoot?.__vueParentComponent?.appContext?.config?.globalProperties?.$store ||
      null
    );
  }

  function findEditorContainer(root) {
    let current = root;
    while (current && current !== document.body) {
      if (current.querySelector('.monaco-editor')) {
        return current;
      }
      current = current.parentElement;
    }
    return document;
  }

  function getEditorSqlFallback(root) {
    const container = findEditorContainer(root);
    const editors = Array.from(container.querySelectorAll('.monaco-editor'))
      .filter((editor) => editor.offsetParent !== null);
    const editor = editors[0] || container.querySelector('.monaco-editor');
    if (!editor) {
      return '';
    }

    const lines = Array.from(editor.querySelectorAll('.view-lines .view-line'))
      .map((line) => (line.textContent || '').replace(/\u00a0/g, ' '));
    return lines.join('\n').trim();
  }

  function getPersistedSqlFallback() {
    try {
      const persistedState = JSON.parse(window.sessionStorage.getItem('vuex') || 'null');
      const history = persistedState?.order?.history;
      return Array.isArray(history) && typeof history[0] === 'string' ? history[0].trim() : '';
    } catch (_error) {
      return '';
    }
  }

  function normalizeAuthorizationToken(token) {
    const value = String(token || '').trim();
    if (!value) {
      return '';
    }
    return /^Bearer\s+/i.test(value) ? value : `Bearer ${value}`;
  }

  function getAuthorizationHeader() {
    try {
      const persistedState = JSON.parse(window.sessionStorage.getItem('vuex') || 'null');
      const accountToken = persistedState?.user?.account?.token;
      const authorization = normalizeAuthorizationToken(accountToken);
      if (authorization) {
        return authorization;
      }
    } catch (_error) {
      // 持久化状态不可读取时，继续兼容旧版 jwt 存储方式。
    }

    return normalizeAuthorizationToken(window.sessionStorage.getItem('jwt'));
  }

  function getSelectionText(selection) {
    return (selection?.getAttribute('title') || selection?.textContent || '').trim();
  }

  function getSelectedSchemaFallback(root) {
    const container = findEditorContainer(root);
    const formItems = Array.from(container.querySelectorAll('.ant-form-item'));
    const schemaItem = formItems.find((item) => {
      const label = item.querySelector('.ant-form-item-label');
      const labelText = (label?.textContent || '').replace(/[\s:：]/g, '');
      return labelText === '所选数据库' || labelText.endsWith('数据库') || /schema/i.test(labelText);
    });
    const selectionSelector = '.ant-select-selection-item, .ant-select-selection-selected-value';
    const selectedSchema = getSelectionText(schemaItem?.querySelector(selectionSelector));
    if (selectedSchema) {
      return selectedSchema;
    }

    const visibleSelections = Array.from(container.querySelectorAll(selectionSelector))
      .filter((selection) => selection.offsetParent !== null)
      .map(getSelectionText)
      .filter(Boolean);
    return visibleSelections.length === 1 ? visibleSelections[0] : '';
  }

  function getCurrentSourceIdFallback() {
    const hashContent = window.location.hash.slice(1);
    const separatorIndex = hashContent.indexOf('?');
    if (separatorIndex >= 0) {
      const sourceId = new URLSearchParams(hashContent.slice(separatorIndex + 1)).get('source_id');
      if (sourceId) {
        return sourceId.trim();
      }
    }

    return (new URLSearchParams(window.location.search).get('source_id') || '').trim();
  }

  function getQueryContext(state) {
    let sql = '';
    let schema = '';
    let sourceId = '';

    try {
      const store = getYearningStore();
      const history = store?.state?.order?.history;
      if (Array.isArray(history) && typeof history[0] === 'string') {
        sql = history[0];
      }
      schema = typeof store?.state?.common?.schema === 'string' ? store.state.common.schema : '';
      sourceId = typeof store?.state?.common?.queryInfo?.source_id === 'string'
        ? store.state.common.queryInfo.source_id
        : '';
    } catch (_error) {
      // Vue 内部状态不可访问时，继续使用页面 DOM 作为兼容回退。
    }

    const capturedContext = latestQueryContext;
    return {
      sql: capturedContext?.sql || sql.trim() || getPersistedSqlFallback() || getEditorSqlFallback(state.root),
      schema: capturedContext?.schema || schema.trim() || getSelectedSchemaFallback(state.root),
      sourceId: capturedContext?.sourceId || sourceId.trim() || getCurrentSourceIdFallback()
    };
  }

  function stripSqlLiteralsAndComments(sql) {
    let result = '';
    let mode = 'normal';

    for (let index = 0; index < sql.length; index += 1) {
      const char = sql[index];
      const next = sql[index + 1];

      if (mode === 'line-comment') {
        if (char === '\n') {
          mode = 'normal';
          result += '\n';
        } else {
          result += ' ';
        }
        continue;
      }

      if (mode === 'block-comment') {
        if (char === '*' && next === '/') {
          result += '  ';
          index += 1;
          mode = 'normal';
        } else {
          result += char === '\n' ? '\n' : ' ';
        }
        continue;
      }

      if (mode === 'single-quote' || mode === 'double-quote') {
        const quote = mode === 'single-quote' ? "'" : '"';
        if (char === '\\') {
          result += ' ';
          if (next !== undefined) {
            result += next === '\n' ? '\n' : ' ';
            index += 1;
          }
        } else if (char === quote && next === quote) {
          result += '  ';
          index += 1;
        } else if (char === quote) {
          result += ' ';
          mode = 'normal';
        } else {
          result += char === '\n' ? '\n' : ' ';
        }
        continue;
      }

      if (char === '-' && next === '-' && /\s/.test(sql[index + 2] || ' ')) {
        result += '  ';
        index += 1;
        mode = 'line-comment';
      } else if (char === '#') {
        result += ' ';
        mode = 'line-comment';
      } else if (char === '/' && next === '*') {
        result += '  ';
        index += 1;
        mode = 'block-comment';
      } else if (char === "'") {
        result += ' ';
        mode = 'single-quote';
      } else if (char === '"') {
        result += ' ';
        mode = 'double-quote';
      } else {
        result += char;
      }
    }

    return result;
  }

  function splitTopLevelComma(text) {
    const parts = [];
    let start = 0;
    let depth = 0;
    let inBacktick = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === '`') {
        if (inBacktick && text[index + 1] === '`') {
          index += 1;
        } else {
          inBacktick = !inBacktick;
        }
      } else if (!inBacktick && char === '(') {
        depth += 1;
      } else if (!inBacktick && char === ')') {
        depth = Math.max(0, depth - 1);
      } else if (!inBacktick && depth === 0 && char === ',') {
        parts.push(text.slice(start, index));
        start = index + 1;
      }
    }

    parts.push(text.slice(start));
    return parts;
  }

  function unquoteIdentifier(identifier) {
    const text = String(identifier || '').trim();
    if (text.startsWith('`') && text.endsWith('`')) {
      return text.slice(1, -1).replace(/``/g, '`');
    }
    return text;
  }

  function normalizeFieldName(fieldName) {
    const segments = String(fieldName || '').split('.');
    return unquoteIdentifier(segments[segments.length - 1]).trim().toLowerCase();
  }

  function extractFieldAliases(sql) {
    const aliases = new Map();
    const cleanedSql = stripSqlLiteralsAndComments(sql);
    const identifier = '(?:`(?:``|[^`])+`|[A-Za-z_$][\\w$]*)';
    const aliasPattern = new RegExp(
      `^(?:(${identifier})\\s*\\.\\s*)?(${identifier})\\s+(?:AS\\s+)?(${identifier})$`,
      'i'
    );
    const selectPattern = /\bSELECT\b([\s\S]*?)\bFROM\b/gi;
    let selectMatch;

    while ((selectMatch = selectPattern.exec(cleanedSql)) !== null) {
      const fields = splitTopLevelComma(selectMatch[1].replace(/^\s*DISTINCT\s+/i, ''));
      for (const fieldExpression of fields) {
        const match = fieldExpression.trim().match(aliasPattern);
        if (!match) {
          continue;
        }
        const sourceField = unquoteIdentifier(match[2]);
        const alias = unquoteIdentifier(match[3]);
        if (sourceField && alias) {
          aliases.set(alias.toLowerCase(), {
            field: sourceField.toLowerCase(),
            qualifier: unquoteIdentifier(match[1]).toLowerCase()
          });
        }
      }
    }

    return aliases;
  }

  function extractTableReferences(sql, defaultSchema) {
    const cleanedSql = stripSqlLiteralsAndComments(sql);
    const identifier = '(?:`(?:``|[^`])+`|[A-Za-z_$][\\w$]*)';
    const aliasIdentifier = `(?!(?:WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|ON|GROUP|ORDER|HAVING|LIMIT|UNION|STRAIGHT_JOIN|FOR|LOCK)\\b)${identifier}`;
    const references = new Map();
    const cteNames = new Set();
    const reservedAliases = new Set([
      'where', 'join', 'left', 'right', 'inner', 'outer', 'cross', 'on', 'group',
      'order', 'having', 'limit', 'union', 'straight_join', 'for', 'lock'
    ]);
    const ctePattern = new RegExp(`(?:\\bWITH\\s+(?:RECURSIVE\\s+)?|,)\\s*(${identifier})\\s+AS\\s*\\(`, 'gi');
    let cteMatch;

    while ((cteMatch = ctePattern.exec(cleanedSql)) !== null) {
      cteNames.add(unquoteIdentifier(cteMatch[1]).toLowerCase());
    }

    function addReference(firstIdentifier, secondIdentifier, aliasIdentifier) {
      const schema = unquoteIdentifier(secondIdentifier ? firstIdentifier : defaultSchema);
      const table = unquoteIdentifier(secondIdentifier || firstIdentifier);
      if (!schema || !table || cteNames.has(table.toLowerCase())) {
        return;
      }
      const key = `${schema.toLowerCase()}\u0000${table.toLowerCase()}`;
      const reference = references.get(key) || { schema, table, aliases: new Set([table.toLowerCase()]) };
      const alias = unquoteIdentifier(aliasIdentifier).toLowerCase();
      if (alias && !reservedAliases.has(alias)) {
        reference.aliases.add(alias);
      }
      references.set(key, reference);
    }

    const directPattern = new RegExp(
      `\\b(?:FROM|JOIN)\\s+(${identifier})(?:\\s*\\.\\s*(${identifier}))?(?:\\s+(?:AS\\s+)?(${aliasIdentifier}))?`,
      'gi'
    );
    let directMatch;
    while ((directMatch = directPattern.exec(cleanedSql)) !== null) {
      addReference(directMatch[1], directMatch[2], directMatch[3]);
    }

    const fromClausePattern = /\bFROM\b([\s\S]*?)(?=\bWHERE\b|\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b|\bLIMIT\b|\bUNION\b|;|$)/gi;
    let fromMatch;
    while ((fromMatch = fromClausePattern.exec(cleanedSql)) !== null) {
      const tableParts = splitTopLevelComma(fromMatch[1]);
      for (const tablePart of tableParts.slice(1)) {
        const commaMatch = tablePart.trim().match(new RegExp(
          `^(${identifier})(?:\\s*\\.\\s*(${identifier}))?(?:\\s+(?:AS\\s+)?(${aliasIdentifier}))?`,
          'i'
        ));
        if (commaMatch) {
          addReference(commaMatch[1], commaMatch[2], commaMatch[3]);
        }
      }
    }

    return Array.from(references.values()).map((reference) => ({
      schema: reference.schema,
      table: reference.table,
      aliases: Array.from(reference.aliases)
    }));
  }

  async function fetchTableComments(sourceId, reference) {
    const cacheKey = `${sourceId}\u0000${reference.schema.toLowerCase()}\u0000${reference.table.toLowerCase()}`;
    if (TABLE_COMMENT_CACHE.has(cacheKey)) {
      return TABLE_COMMENT_CACHE.get(cacheKey);
    }

    const request = (async () => {
      const url = new URL('/api/v2/fetch/fields', window.location.origin);
      url.searchParams.set('source_id', sourceId);
      url.searchParams.set('data_base', reference.schema);
      url.searchParams.set('table', reference.table);
      const headers = { Accept: 'application/json' };
      const authorization = getAuthorizationHeader();
      if (!authorization) {
        throw new Error('未找到 Yearning 登录令牌，请刷新页面后重试');
      }
      headers.Authorization = authorization;

      const response = await window.fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers
      });
      if (!response.ok) {
        throw new Error(`字段注释接口返回 HTTP ${response.status}`);
      }

      const body = await response.json();
      const rows = body?.payload?.rows;
      if (!Array.isArray(rows)) {
        throw new Error(body?.text || `字段注释接口未返回 rows（code: ${body?.code ?? '未知'}）`);
      }

      return rows.map((row) => ({
        schema: reference.schema,
        table: reference.table,
        field: String(row?.field || ''),
        comment: String(row?.comment || '')
      }));
    })();

    TABLE_COMMENT_CACHE.set(cacheKey, request);
    request.catch(() => TABLE_COMMENT_CACHE.delete(cacheKey));
    return request;
  }

  function getFieldCommentDisplay(state, fieldName) {
    const normalizedName = normalizeFieldName(fieldName);
    const fieldBinding = state.fieldAliases?.get(normalizedName);
    const sourceField = fieldBinding?.field || normalizedName;

    if (state.commentStatus === 'loading') {
      return { text: '加载中…', status: 'loading' };
    }

    const statusMessages = {
      'missing-source': '未识别数据源',
      'missing-sql': '未识别 SQL',
      'missing-schema': '未识别数据库',
      unsupported: '不支持该查询',
      error: '获取失败'
    };
    if (statusMessages[state.commentStatus]) {
      return {
        text: statusMessages[state.commentStatus],
        status: state.commentStatus,
        title: state.commentError || statusMessages[state.commentStatus]
      };
    }

    let matches = state.fieldComments?.get(sourceField) || [];
    if (fieldBinding?.qualifier) {
      const tableKey = state.tableAliases?.get(fieldBinding.qualifier);
      if (tableKey) {
        matches = matches.filter((item) => (
          `${item.schema.toLowerCase()}\u0000${item.table.toLowerCase()}` === tableKey
        ));
      }
    }
    const withComment = matches.filter((item) => item.comment.trim());
    if (!withComment.length) {
      return { text: EMPTY_COMMENT_TEXT, status: 'empty' };
    }

    const uniqueComments = Array.from(new Set(withComment.map((item) => item.comment.trim())));
    if (uniqueComments.length === 1) {
      return { text: uniqueComments[0], status: 'ready' };
    }

    return {
      text: withComment.map((item) => `${item.table}：${item.comment.trim()}`).join('\n'),
      status: 'ready'
    };
  }

  function enhanceGridHeaders(state) {
    const table = findResultTable(state.wrapper);
    if (!table) {
      return;
    }

    const headers = Array.from(table.querySelectorAll('thead.ant-table-thead th.ant-table-cell'));
    headers.forEach((header, index) => {
      const fieldName = getHeaderText(header, index);
      header.dataset.yvFieldName = fieldName;
      header.classList.add('yv-grid-header-with-comment');
      let commentElement = header.querySelector('.yv-grid-field-comment');
      if (!commentElement) {
        commentElement = document.createElement('span');
        commentElement.className = 'yv-grid-field-comment';
        header.appendChild(commentElement);
      }

      const display = getFieldCommentDisplay(state, fieldName);
      commentElement.classList.toggle('yv-comment-loading', display.status === 'loading');
      if (commentElement.textContent !== display.text) {
        commentElement.textContent = display.text;
      }
      commentElement.title = display.title || (display.status === 'ready' ? display.text : '');
    });
  }

  function removeGridHeaderEnhancements(state) {
    const table = findResultTable(state.wrapper);
    if (!table) {
      return;
    }

    table.querySelectorAll('thead.ant-table-thead th.ant-table-cell').forEach((header) => {
      header.querySelectorAll('.yv-grid-field-comment').forEach((comment) => comment.remove());
      header.classList.remove('yv-grid-header-with-comment');
      delete header.dataset.yvFieldName;
    });
  }

  function ensureFieldComments(state) {
    const context = getQueryContext(state);
    const contextKey = `${context.sourceId}\u0000${context.schema}\u0000${context.sql}`;
    if (state.commentContextKey === contextKey && state.commentStatus !== 'idle') {
      return;
    }

    state.commentContextKey = contextKey;
    state.commentRequestId += 1;
    const requestId = state.commentRequestId;
    state.fieldAliases = extractFieldAliases(context.sql);
    state.tableAliases = new Map();
    state.fieldComments = new Map();
    state.commentError = '';
    state.commentStatus = 'loading';
    enhanceGridHeaders(state);

    const references = extractTableReferences(context.sql, context.schema);
    for (const reference of references) {
      const tableKey = `${reference.schema.toLowerCase()}\u0000${reference.table.toLowerCase()}`;
      for (const alias of reference.aliases) {
        state.tableAliases.set(alias.toLowerCase(), tableKey);
      }
    }
    if (!context.sourceId || !context.sql || !references.length) {
      const unresolvedReferences = !context.schema && context.sql
        ? extractTableReferences(context.sql, '__yv_missing_schema__')
        : [];
      if (!context.sourceId) {
        state.commentStatus = 'missing-source';
      } else if (!context.sql) {
        state.commentStatus = 'missing-sql';
      } else if (!context.schema && unresolvedReferences.length) {
        state.commentStatus = 'missing-schema';
      } else {
        state.commentStatus = 'unsupported';
      }
      enhanceGridHeaders(state);
      if (state.view === 'form') {
        renderFormRecord(state);
      }
      return;
    }

    Promise.allSettled(references.map((reference) => fetchTableComments(context.sourceId, reference)))
      .then((results) => {
        if (requestId !== state.commentRequestId || !ACTIVE_STATES.has(state)) {
          return;
        }

        let successCount = 0;
        const errors = [];
        const fieldComments = new Map();
        for (const result of results) {
          if (result.status !== 'fulfilled') {
            errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
            continue;
          }
          successCount += 1;
          for (const item of result.value) {
            const key = normalizeFieldName(item.field);
            if (!key) {
              continue;
            }
            const items = fieldComments.get(key) || [];
            items.push(item);
            fieldComments.set(key, items);
          }
        }

        state.fieldComments = fieldComments;
        state.commentStatus = successCount ? 'ready' : 'error';
        state.commentError = errors.join('\n');
        if (!successCount && errors.length) {
          console.warn('[Yearning 视图切换] COMMENT 获取失败：', errors);
        }
        enhanceGridHeaders(state);
        if (state.view === 'form') {
          renderFormRecord(state);
        }
      });
  }

  function getCellText(cell) {
    const clipboardNode = cell.querySelector('[data-clipboard-text]');
    if (clipboardNode && clipboardNode.hasAttribute('data-clipboard-text')) {
      return clipboardNode.getAttribute('data-clipboard-text') || '';
    }

    const valueNode = cell.querySelector('.ellipsis') || cell;
    const text = (valueNode.textContent || '').replace(/\r\n?/g, '\n').trim();
    if (text) {
      return text;
    }

    const titledNode = cell.querySelector('[title]');
    return titledNode ? (titledNode.getAttribute('title') || '').trim() : '';
  }

  function readCurrentPageRecords(wrapper) {
    const table = findResultTable(wrapper);
    if (!table) {
      return [];
    }

    const headers = Array.from(table.querySelectorAll('thead.ant-table-thead th.ant-table-cell'));
    return getDataRows(table).map((row) => {
      const cells = getDirectCells(row);
      const fieldCount = Math.max(headers.length, cells.length);
      const record = [];

      for (let index = 0; index < fieldCount; index += 1) {
        record.push({
          name: headers[index] ? getHeaderText(headers[index], index) : `字段 ${index + 1}`,
          value: cells[index] ? getCellText(cells[index]) : ''
        });
      }

      return record;
    });
  }

  function parsePositiveInteger(text) {
    const match = String(text || '').match(/[\d,]+/);
    if (!match) {
      return 0;
    }
    return Number(match[0].replace(/,/g, '')) || 0;
  }

  function readPaginationInfo(state) {
    const wrapper = state.wrapper;
    const pager = wrapper && wrapper.querySelector('.ant-pagination.ant-table-pagination');
    const records = readCurrentPageRecords(wrapper);

    if (!pager) {
      return {
        pager: null,
        total: records.length,
        currentPage: 1,
        pageSize: Math.max(records.length, 1),
        records
      };
    }

    const total = parsePositiveInteger(pager.querySelector('.ant-pagination-total-text')?.textContent) || records.length;
    const currentPage = parsePositiveInteger(pager.querySelector('.ant-pagination-item-active')?.textContent) || 1;
    const pageSizeText = pager.querySelector('.ant-pagination-options-size-changer .ant-select-selection-item')?.textContent || '';
    let pageSize = parsePositiveInteger(pageSizeText);

    if (!pageSize) {
      pageSize = state.nativePageSize || 0;
    }

    if (!pageSize && records.length) {
      const numericPages = Array.from(pager.querySelectorAll('.ant-pagination-item'))
        .map((item) => parsePositiveInteger(item.getAttribute('title') || item.textContent))
        .filter(Boolean);
      const lastPage = numericPages.length ? Math.max(...numericPages) : currentPage;

      if (currentPage === lastPage && currentPage > 1) {
        const inferredSize = (total - records.length) / (currentPage - 1);
        if (Number.isInteger(inferredSize) && inferredSize > 0) {
          pageSize = inferredSize;
        }
      }
    }

    if (!pageSize) {
      pageSize = records.length || 10;
    }

    state.nativePageSize = pageSize;
    return { pager, total, currentPage, pageSize, records };
  }

  function makeGridSignature(state) {
    const info = readPaginationInfo(state);
    const firstRecord = info.records[0] || [];
    const firstValue = firstRecord.map((field) => `${field.name}:${field.value}`).join('|');
    return `${info.currentPage}/${info.pageSize}/${info.total}/${info.records.length}/${firstValue}`;
  }

  function setViewButtonState(state) {
    const isGrid = state.view === 'grid';
    state.gridButton.classList.toggle('yv-active', isGrid);
    state.formButton.classList.toggle('yv-active', !isGrid);
    state.gridButton.setAttribute('aria-pressed', String(isGrid));
    state.formButton.setAttribute('aria-pressed', String(!isGrid));
  }

  function switchView(state, view) {
    if (!state.root.isConnected) {
      return;
    }

    state.view = view;
    setViewButtonState(state);

    if (view === 'grid') {
      stopNativeNavigation(state);
      state.wrapper?.classList.remove('yv-grid-hidden');
      state.formView.hidden = true;
      return;
    }

    const info = readPaginationInfo(state);
    state.recordIndex = Math.min(
      Math.max((info.currentPage - 1) * info.pageSize, 0),
      Math.max(info.total - 1, 0)
    );
    state.pendingRecordIndex = null;
    state.wrapper?.classList.add('yv-grid-hidden');
    state.formView.hidden = false;
    renderFormRecord(state);
  }

  function createFormView(state) {
    const formView = document.createElement('section');
    formView.className = 'yv-form-view';
    formView.hidden = true;
    formView.setAttribute('aria-label', '查询结果表单视图');

    const summary = document.createElement('div');
    summary.className = 'yv-form-summary';
    const summaryTitle = document.createElement('strong');
    const status = document.createElement('span');
    status.className = 'yv-form-status';
    summary.append(summaryTitle, status);

    const scroll = document.createElement('div');
    scroll.className = 'yv-form-scroll';

    const pagination = document.createElement('nav');
    pagination.className = 'yv-form-pagination';
    pagination.setAttribute('aria-label', '表单视图分页');

    const totalText = document.createElement('span');
    totalText.className = 'yv-pagination-total';
    const firstButton = createNavigationButton('第一条', '«');
    const previousButton = createNavigationButton('上一条', '‹');
    const pageList = document.createElement('span');
    pageList.className = 'yv-page-list';
    const nextButton = createNavigationButton('下一条', '›');
    const lastButton = createNavigationButton('最后一条', '»');
    const sizeText = document.createElement('span');
    sizeText.className = 'yv-pagination-size';
    sizeText.textContent = '1 条/页';

    pagination.append(totalText, firstButton, previousButton, pageList, nextButton, lastButton, sizeText);
    formView.append(summary, scroll, pagination);

    state.formView = formView;
    state.summaryTitle = summaryTitle;
    state.status = status;
    state.scroll = scroll;
    state.totalText = totalText;
    state.firstButton = firstButton;
    state.previousButton = previousButton;
    state.pageList = pageList;
    state.nextButton = nextButton;
    state.lastButton = lastButton;

    firstButton.addEventListener('click', () => requestRecord(state, 0));
    previousButton.addEventListener('click', () => requestRecord(state, state.recordIndex - 1));
    nextButton.addEventListener('click', () => requestRecord(state, state.recordIndex + 1));
    lastButton.addEventListener('click', () => requestRecord(state, state.total - 1));

    return formView;
  }

  function buildVisibleRecordPages(currentPage, totalPages) {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, index) => index + 1);
    }

    if (currentPage <= 4) {
      return [1, 2, 3, 4, 5, 'ellipsis', totalPages];
    }

    if (currentPage >= totalPages - 3) {
      return [1, 'ellipsis', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    }

    return [1, 'ellipsis', currentPage - 1, currentPage, currentPage + 1, 'ellipsis', totalPages];
  }

  function renderRecordPagination(state, total) {
    const currentPage = total ? state.recordIndex + 1 : 0;
    state.totalText.textContent = `共 ${total} 条`;
    state.pageList.replaceChildren();

    for (const page of buildVisibleRecordPages(currentPage, total)) {
      if (page === 'ellipsis') {
        const ellipsis = document.createElement('span');
        ellipsis.className = 'yv-page-ellipsis';
        ellipsis.textContent = '•••';
        state.pageList.appendChild(ellipsis);
        continue;
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'yv-page-number';
      button.textContent = String(page);
      button.title = `第 ${page} 条`;
      button.setAttribute('aria-label', `第 ${page} 条`);

      if (page === currentPage) {
        button.classList.add('yv-current');
        button.setAttribute('aria-current', 'page');
        button.disabled = true;
      } else {
        button.addEventListener('click', () => requestRecord(state, page - 1));
      }

      state.pageList.appendChild(button);
    }

    const disabledAtStart = !total || currentPage <= 1 || state.loadingGrid;
    const disabledAtEnd = !total || currentPage >= total || state.loadingGrid;
    state.firstButton.disabled = disabledAtStart;
    state.previousButton.disabled = disabledAtStart;
    state.nextButton.disabled = disabledAtEnd;
    state.lastButton.disabled = disabledAtEnd;
  }

  function renderFormRecord(state) {
    if (state.view !== 'form' || !state.wrapper?.isConnected) {
      return;
    }

    const info = readPaginationInfo(state);
    state.total = info.total;
    state.recordIndex = Math.min(Math.max(state.recordIndex, 0), Math.max(info.total - 1, 0));
    const expectedNativePage = info.total ? Math.floor(state.recordIndex / info.pageSize) + 1 : 1;

    if (info.total && expectedNativePage !== info.currentPage) {
      navigateToRecordPage(state, expectedNativePage);
      return;
    }

    const localIndex = info.total ? state.recordIndex - ((info.currentPage - 1) * info.pageSize) : 0;
    const record = info.records[localIndex];
    state.formView.classList.toggle('yv-loading', Boolean(state.loadingGrid));
    state.formView.setAttribute('aria-busy', String(Boolean(state.loadingGrid)));
    state.summaryTitle.textContent = info.total ? `记录 ${state.recordIndex + 1} / ${info.total}` : '暂无查询结果';
    state.status.textContent = state.loadingGrid ? `正在加载第 ${state.recordIndex + 1} 条…` : '表单视图 · 每页 1 条';
    state.scroll.replaceChildren();

    if (!record) {
      const empty = document.createElement('div');
      empty.className = 'yv-no-record';
      empty.textContent = state.loadingGrid ? '正在读取记录…' : '暂无数据';
      state.scroll.appendChild(empty);
    } else {
      const table = document.createElement('table');
      table.className = 'yv-form-table';
      const head = document.createElement('thead');
      const headingRow = document.createElement('tr');
      const fieldHeading = document.createElement('th');
      fieldHeading.className = 'yv-form-field-name';
      fieldHeading.scope = 'col';
      fieldHeading.textContent = '字段';
      const commentHeading = document.createElement('th');
      commentHeading.className = 'yv-form-comment-heading';
      commentHeading.scope = 'col';
      commentHeading.textContent = 'COMMENT';
      const valueHeading = document.createElement('th');
      valueHeading.scope = 'col';
      valueHeading.textContent = '值';
      headingRow.append(fieldHeading, commentHeading, valueHeading);
      head.appendChild(headingRow);
      const body = document.createElement('tbody');

      for (const field of record) {
        const row = document.createElement('tr');
        const nameCell = document.createElement('th');
        nameCell.className = 'yv-form-field-name';
        nameCell.scope = 'row';
        nameCell.textContent = field.name;
        const commentCell = document.createElement('td');
        commentCell.className = 'yv-form-comment-cell';
        const commentDisplay = getFieldCommentDisplay(state, field.name);
        commentCell.textContent = commentDisplay.text;
        commentCell.classList.toggle('yv-empty-comment', commentDisplay.status === 'empty');
        commentCell.classList.toggle('yv-comment-loading', commentDisplay.status === 'loading');
        commentCell.title = commentDisplay.status === 'ready' ? commentDisplay.text : '';
        const valueCell = document.createElement('td');
        const value = document.createElement('div');
        value.className = 'yv-form-value';

        if (field.value === '') {
          value.classList.add('yv-empty-value');
          value.textContent = EMPTY_VALUE_TEXT;
        } else {
          value.textContent = field.value;
        }

        valueCell.appendChild(value);
        row.append(nameCell, commentCell, valueCell);
        body.appendChild(row);
      }

      table.append(head, body);
      state.scroll.appendChild(table);
    }

    renderRecordPagination(state, info.total);
    state.lastGridSignature = makeGridSignature(state);
  }

  function requestRecord(state, requestedIndex) {
    if (state.view !== 'form' || state.loadingGrid || !state.total) {
      return;
    }

    const targetIndex = Math.min(Math.max(requestedIndex, 0), state.total - 1);
    if (targetIndex === state.recordIndex) {
      return;
    }

    state.recordIndex = targetIndex;
    state.pendingRecordIndex = targetIndex;
    const info = readPaginationInfo(state);
    const targetNativePage = Math.floor(targetIndex / info.pageSize) + 1;

    if (targetNativePage === info.currentPage) {
      state.pendingRecordIndex = null;
      renderFormRecord(state);
      return;
    }

    navigateToRecordPage(state, targetNativePage);
  }

  function findNativePageControl(info, targetPage) {
    if (!info.pager) {
      return null;
    }

    const exactPage = Array.from(info.pager.querySelectorAll('.ant-pagination-item'))
      .find((item) => parsePositiveInteger(item.getAttribute('title') || item.textContent) === targetPage);

    if (exactPage) {
      return exactPage.querySelector('a, button') || exactPage;
    }

    const directionClass = targetPage > info.currentPage ? '.ant-pagination-next' : '.ant-pagination-prev';
    const directionItem = info.pager.querySelector(directionClass);
    if (!directionItem || directionItem.classList.contains('ant-pagination-disabled')) {
      return null;
    }

    return directionItem.querySelector('button, a') || directionItem;
  }

  function navigateToRecordPage(state, targetNativePage) {
    if (state.loadingGrid || state.view !== 'form') {
      return;
    }

    const info = readPaginationInfo(state);
    if (info.currentPage === targetNativePage) {
      state.pendingRecordIndex = null;
      renderFormRecord(state);
      return;
    }

    const control = findNativePageControl(info, targetNativePage);
    if (!control) {
      state.status.textContent = '无法切换到对应记录，请返回网格视图后重试';
      return;
    }

    state.loadingGrid = true;
    state.loadingFromPage = info.currentPage;
    state.targetNativePage = targetNativePage;
    state.formView.classList.add('yv-loading');
    state.formView.setAttribute('aria-busy', 'true');
    state.status.textContent = `正在加载第 ${state.recordIndex + 1} 条…`;
    renderRecordPagination(state, info.total);
    control.click();
    waitForNativePageChange(state, 0);
  }

  function waitForNativePageChange(state, attempt) {
    clearTimeout(state.navigationTimer);
    state.navigationTimer = window.setTimeout(() => {
      if (state.view !== 'form' || !state.wrapper?.isConnected) {
        stopNativeNavigation(state);
        return;
      }

      const info = readPaginationInfo(state);
      if (info.currentPage !== state.loadingFromPage) {
        state.loadingGrid = false;
        state.loadingFromPage = null;
        state.lastGridSignature = makeGridSignature(state);

        if (info.currentPage === state.targetNativePage) {
          state.pendingRecordIndex = null;
          state.targetNativePage = null;
          window.setTimeout(() => renderFormRecord(state), 50);
        } else {
          const nextTarget = state.targetNativePage;
          state.targetNativePage = null;
          navigateToRecordPage(state, nextTarget);
        }
        return;
      }

      if (attempt < 50) {
        waitForNativePageChange(state, attempt + 1);
        return;
      }

      state.loadingGrid = false;
      state.loadingFromPage = null;
      state.targetNativePage = null;
      state.formView.classList.remove('yv-loading');
      state.formView.setAttribute('aria-busy', 'false');
      state.status.textContent = '记录加载超时，请返回网格视图后重试';
      renderRecordPagination(state, info.total);
    }, 100);
  }

  function stopNativeNavigation(state) {
    clearTimeout(state.navigationTimer);
    state.navigationTimer = 0;
    state.loadingGrid = false;
    state.loadingFromPage = null;
    state.targetNativePage = null;
    state.pendingRecordIndex = null;
    state.formView?.classList.remove('yv-loading');
    state.formView?.setAttribute('aria-busy', 'false');
  }

  function createState(exportButton, root, wrapper) {
    const gridIcon = '<svg class="yv-view-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1 1h6v6H1V1Zm8 0h6v6H9V1ZM1 9h6v6H1V9Zm8 0h6v6H9V9ZM2.5 2.5v3h3v-3h-3Zm8 0v3h3v-3h-3Zm-8 8v3h3v-3h-3Zm8 0v3h3v-3h-3Z"/></svg>';
    const formIcon = '<svg class="yv-view-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1 1h14v14H1V1Zm1.5 1.5v3h3v-3h-3Zm4.5 0V4h6.5V2.5H7Zm0 3V7h6.5V5.5H7Zm-4.5 2v2h3v-2h-3Zm4.5 0V9h6.5V7.5H7Zm0 3v1.5h6.5v-1.5H7Zm-4.5.5v1.5h3V11h-3Z"/></svg>';
    const switcher = document.createElement('span');
    switcher.className = 'yv-view-switcher';
    switcher.setAttribute('role', 'group');
    switcher.setAttribute('aria-label', '查询结果视图切换');
    const gridButton = createViewButton('网格视图', gridIcon);
    const formButton = createViewButton('表单视图', formIcon);
    switcher.append(gridButton, formButton);

    const state = {
      exportButton,
      root,
      wrapper,
      switcher,
      gridButton,
      formButton,
      view: 'grid',
      recordIndex: 0,
      total: 0,
      nativePageSize: 0,
      loadingGrid: false,
      navigationTimer: 0,
      lastGridSignature: '',
      fieldComments: new Map(),
      fieldAliases: new Map(),
      tableAliases: new Map(),
      commentStatus: 'idle',
      commentError: '',
      commentContextKey: '',
      commentRequestId: 0
    };

    const formView = createFormView(state);
    exportButton.after(switcher);
    wrapper.after(formView);
    gridButton.addEventListener('click', () => switchView(state, 'grid'));
    formButton.addEventListener('click', () => switchView(state, 'form'));
    setViewButtonState(state);
    state.lastGridSignature = makeGridSignature(state);
    ACTIVE_STATES.add(state);
    ensureFieldComments(state);
    return state;
  }

  function removeState(state) {
    stopNativeNavigation(state);
    state.commentRequestId += 1;
    state.wrapper?.classList.remove('yv-grid-hidden');
    removeGridHeaderEnhancements(state);
    state.switcher?.remove();
    state.formView?.remove();
    STATE_BY_EXPORT_BUTTON.delete(state.exportButton);
    ACTIVE_STATES.delete(state);
  }

  function removeAllStates() {
    for (const state of Array.from(ACTIVE_STATES)) {
      removeState(state);
    }
  }

  function refreshState(state) {
    if (!state.exportButton.isConnected || !state.root.isConnected) {
      removeState(state);
      return;
    }

    const currentWrapper = findTableWrapper(state.root);
    if (!currentWrapper) {
      return;
    }

    if (!state.switcher.isConnected) {
      state.exportButton.after(state.switcher);
    }

    if (currentWrapper !== state.wrapper) {
      state.wrapper?.classList.remove('yv-grid-hidden');
      state.wrapper = currentWrapper;
      state.nativePageSize = 0;
      state.lastGridSignature = '';
    }

    if (!state.formView.isConnected || state.formView.previousElementSibling !== state.wrapper) {
      state.wrapper.after(state.formView);
    }

    ensureFieldComments(state);
    enhanceGridHeaders(state);

    if (state.view === 'form') {
      state.wrapper.classList.add('yv-grid-hidden');
      state.formView.hidden = false;
      const signature = makeGridSignature(state);
      if (!state.loadingGrid && signature !== state.lastGridSignature) {
        state.lastGridSignature = signature;
        renderFormRecord(state);
      }
    }
  }

  function scanQueryResults() {
    scanFrame = 0;
    if (!isTargetSite()) {
      removeAllStates();
      return;
    }

    const buttons = Array.from(document.querySelectorAll('button.ant-btn'))
      .filter((button) => normalizeButtonText(button) === '导出');

    for (const exportButton of buttons) {
      const existingState = STATE_BY_EXPORT_BUTTON.get(exportButton);
      if (existingState) {
        refreshState(existingState);
        continue;
      }

      const root = exportButton.parentElement;
      const wrapper = root && findTableWrapper(root);
      if (!root || !wrapper || !findResultTable(wrapper)) {
        continue;
      }

      const state = createState(exportButton, root, wrapper);
      STATE_BY_EXPORT_BUTTON.set(exportButton, state);
    }
  }

  function queueScan() {
    if (scanFrame) {
      return;
    }
    scanFrame = window.requestAnimationFrame(scanQueryResults);
  }

  function handleLocationChange() {
    latestQueryContext = null;
    queueScan();
  }

  installQueryContextCapture();
  const observer = new MutationObserver(queueScan);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener('hashchange', handleLocationChange);
  scanQueryResults();
})();
