// ==UserScript==
// @name         Yearning SQL变更行数检测
// @namespace    https://yearning.io/
// @version      1.1.11
// @description  将选中的或全部 UPDATE/DELETE/INSERT SELECT SQL（含多表 JOIN）转换为只读 COUNT 查询，检测实际变更行数
// @author       codex
// @match        *://{IP}:{PORT}/*
// @require      https://unpkg.com/@msgpack/msgpack@3.1.2/dist.umd/msgpack.min.js
// @license      MIT
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

/* global MessagePack */

(function () {
  'use strict';

  const BUTTON_ID = 'sql-change-row-check-button';
  const BUTTON_TEXT = 'SQL变更行数检测';
  const SCRIPT_VERSION = '1.1.11';
  const UNSUPPORTED_MESSAGE = '无法识别 SQL 语法，请确认选中内容完整且多条语句使用分号分隔';
  const QUERY_TIMEOUT = 30000;
  const primaryKeyCache = new Map();
  const capturedMonacoEditors = new Set();
  const hookedMonacoEditorApis = new WeakSet();
  let monacoHookError = '';

  function captureMonacoEditor(editor) {
    capturedMonacoEditors.add(editor);
    if (editor && typeof editor.onDidDispose === 'function') {
      editor.onDidDispose(() => capturedMonacoEditors.delete(editor));
    }
  }

  function hookMonacoEditorApi(editorApi) {
    if (!editorApi || hookedMonacoEditorApis.has(editorApi)) {
      return;
    }
    if (typeof editorApi.onDidCreateEditor !== 'function') {
      monacoHookError = 'Monaco editor API 缺少 onDidCreateEditor 方法';
      return;
    }
    try {
      editorApi.onDidCreateEditor(captureMonacoEditor);
      hookedMonacoEditorApis.add(editorApi);
    } catch (error) {
      monacoHookError = '订阅 Monaco Editor 创建事件失败：' + (error.message || '未知错误');
    }
  }

  function enableMonacoGlobalApi() {
    const monacoEnvironment = window.MonacoEnvironment || {};
    monacoEnvironment.globalAPI = true;
    window.MonacoEnvironment = monacoEnvironment;
    if (window.monaco && window.monaco.editor) {
      hookMonacoEditorApi(window.monaco.editor);
      return;
    }
    try {
      let monacoValue = window.monaco;
      const monacoDescriptor = Object.getOwnPropertyDescriptor(window, 'monaco');
      if (monacoDescriptor && !monacoDescriptor.configurable) {
        monacoHookError = 'window.monaco 属性不可监听';
        return;
      }
      Object.defineProperty(window, 'monaco', {
        configurable: true,
        enumerable: true,
        get() {
          return monacoValue;
        },
        set(value) {
          monacoValue = value;
          hookMonacoEditorApi(value && value.editor);
        }
      });
    } catch (error) {
      monacoHookError = '监听 window.monaco 失败：' + (error.message || '未知错误');
    }
  }

  enableMonacoGlobalApi();

  function addStyle() {
    if (document.getElementById('sql-change-row-check-style')) {
      return;
    }
    const style = document.createElement('style');
    style.id = 'sql-change-row-check-style';
    style.textContent = [
      '.sql-change-row-modal-mask {',
      '  align-items: center;',
      '  background: rgba(0, 0, 0, 0.45);',
      '  display: flex;',
      '  inset: 0;',
      '  justify-content: center;',
      '  position: fixed;',
      '  z-index: 100001;',
      '}',
      '.sql-change-row-modal {',
      '  background: #fff;',
      '  border-radius: 4px;',
      '  box-shadow: 0 3px 6px -4px rgba(0, 0, 0, 0.12), 0 6px 16px rgba(0, 0, 0, 0.08), 0 9px 28px 8px rgba(0, 0, 0, 0.05);',
      '  max-height: 80vh;',
      '  max-width: 920px;',
      '  overflow: hidden;',
      '  width: calc(100vw - 48px);',
      '}',
      '.sql-change-row-modal-header,',
      '.sql-change-row-modal-footer {',
      '  align-items: center;',
      '  display: flex;',
      '  justify-content: space-between;',
      '  padding: 16px 24px;',
      '}',
      '.sql-change-row-modal-header {',
      '  border-bottom: 1px solid #f0f0f0;',
      '  font-size: 16px;',
      '  font-weight: 500;',
      '}',
      '.sql-change-row-modal-body {',
      '  max-height: calc(80vh - 114px);',
      '  overflow: auto;',
      '  padding: 20px 24px;',
      '}',
      '.sql-change-row-modal-footer {',
      '  border-top: 1px solid #f0f0f0;',
      '  justify-content: flex-end;',
      '}',
      '.sql-change-row-result {',
      '  border: 1px solid #f0f0f0;',
      '  border-radius: 4px;',
      '  margin-bottom: 16px;',
      '  padding: 14px 16px;',
      '}',
      '.sql-change-row-result:last-child {',
      '  margin-bottom: 0;',
      '}',
      '.sql-change-row-result-count {',
      '  color: #1890ff;',
      '  font-size: 22px;',
      '  font-weight: 600;',
      '  margin-bottom: 10px;',
      '}',
      '.sql-change-row-result-error {',
      '  color: #ff4d4f;',
      '  font-size: 16px;',
      '}',
      '.sql-change-row-result-label {',
      '  color: #8c8c8c;',
      '  font-size: 12px;',
      '  margin-top: 8px;',
      '}',
      '.sql-change-row-result pre {',
      '  background: #fafafa;',
      '  border-radius: 3px;',
      '  margin: 4px 0 0;',
      '  overflow: auto;',
      '  padding: 8px 10px;',
      '  white-space: pre-wrap;',
      '  word-break: break-all;',
      '}',
      '.sql-change-row-toast {',
      '  background: #fff;',
      '  border-left: 3px solid #ff4d4f;',
      '  border-radius: 4px;',
      '  box-shadow: 0 3px 6px -4px rgba(0, 0, 0, 0.12), 0 6px 16px rgba(0, 0, 0, 0.08), 0 9px 28px 8px rgba(0, 0, 0, 0.05);',
      '  left: 50%;',
      '  max-width: calc(100vw - 48px);',
      '  padding: 10px 16px;',
      '  position: fixed;',
      '  top: 24px;',
      '  transform: translateX(-50%);',
      '  z-index: 100002;',
      '}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function showToast(message) {
    const existingToast = document.querySelector('.sql-change-row-toast');
    if (existingToast) {
      existingToast.remove();
    }
    const toast = document.createElement('div');
    toast.className = 'sql-change-row-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    window.setTimeout(() => toast.remove(), 4000);
  }

  function createTextBlock(parent, label, text) {
    const labelElement = document.createElement('div');
    labelElement.className = 'sql-change-row-result-label';
    labelElement.textContent = label;
    const valueElement = document.createElement('pre');
    valueElement.textContent = text;
    parent.appendChild(labelElement);
    parent.appendChild(valueElement);
  }

  function showResults(results, schema) {
    const existingMask = document.querySelector('.sql-change-row-modal-mask');
    if (existingMask) {
      existingMask.remove();
    }
    const mask = document.createElement('div');
    mask.className = 'sql-change-row-modal-mask';
    const modal = document.createElement('div');
    modal.className = 'sql-change-row-modal';
    const header = document.createElement('div');
    header.className = 'sql-change-row-modal-header';
    header.textContent = 'SQL变更行数检测结果（' + schema + '）';
    const body = document.createElement('div');
    body.className = 'sql-change-row-modal-body';
    results.forEach((result, index) => {
      const item = document.createElement('div');
      item.className = 'sql-change-row-result';
      const count = document.createElement('div');
      count.className = 'sql-change-row-result-count';
      if (result.error) {
        count.className += ' sql-change-row-result-error';
        count.textContent = '第 ' + (index + 1) + ' 条：' + result.stage;
        item.appendChild(count);
        createTextBlock(item, '实际拆分出的原 SQL', result.originalSql);
        createTextBlock(item, '失败原因', result.error);
        if (result.querySql) {
          createTextBlock(item, '生成的只读查询', result.querySql);
        }
        body.appendChild(item);
        return;
      }
      count.textContent = '第 ' + (index + 1) + ' 条：预计变更 ' + result.rowCount + ' 行';
      item.appendChild(count);
      if (result.targetCounts && result.targetCounts.length) {
        const targetCount = document.createElement('div');
        targetCount.className = 'sql-change-row-result-label';
        targetCount.textContent = '目标表明细：' + result.targetCounts.map(target => target.alias + ' ' + target.rowCount + ' 行').join('；');
        item.appendChild(targetCount);
      }
      createTextBlock(item, '原 SQL', result.originalSql);
      createTextBlock(item, '实际执行的只读查询', result.querySql);
      if (result.queryTime !== null && result.queryTime !== undefined) {
        const time = document.createElement('div');
        time.className = 'sql-change-row-result-label';
        time.textContent = '查询耗时：' + result.queryTime + ' ms';
        item.appendChild(time);
      }
      body.appendChild(item);
    });
    const footer = document.createElement('div');
    footer.className = 'sql-change-row-modal-footer';
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'ant-btn ant-btn-primary';
    closeButton.textContent = '确 定';
    closeButton.addEventListener('click', () => mask.remove());
    footer.appendChild(closeButton);
    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    mask.appendChild(modal);
    mask.addEventListener('click', event => {
      if (event.target === mask) {
        mask.remove();
      }
    });
    document.body.appendChild(mask);
  }

  function scanTopLevelWords(sql) {
    const words = [];
    let state = 'normal';
    let depth = 0;
    for (let index = 0; index < sql.length;) {
      const char = sql[index];
      const next = sql[index + 1];
      if (state === 'line-comment') {
        if (char === '\n' || char === '\r') {
          state = 'normal';
        }
        index++;
        continue;
      }
      if (state === 'block-comment') {
        if (char === '*' && next === '/') {
          state = 'normal';
          index += 2;
        } else {
          index++;
        }
        continue;
      }
      if (state === 'single-quote' || state === 'double-quote' || state === 'backtick') {
        const quote = state === 'single-quote' ? "'" : state === 'double-quote' ? '"' : '`';
        if (char === '\\' && state !== 'backtick') {
          index += 2;
          continue;
        }
        if (char === quote) {
          if (next === quote) {
            index += 2;
            continue;
          }
          state = 'normal';
        }
        index++;
        continue;
      }
      if (char === '-' && next === '-') {
        state = 'line-comment';
        index += 2;
        continue;
      }
      if (char === '#') {
        state = 'line-comment';
        index++;
        continue;
      }
      if (char === '/' && next === '*') {
        state = 'block-comment';
        index += 2;
        continue;
      }
      if (char === "'") {
        state = 'single-quote';
        index++;
        continue;
      }
      if (char === '"') {
        state = 'double-quote';
        index++;
        continue;
      }
      if (char === '`') {
        state = 'backtick';
        index++;
        continue;
      }
      if (char === '(') {
        depth++;
        index++;
        continue;
      }
      if (char === ')') {
        depth = Math.max(0, depth - 1);
        index++;
        continue;
      }
      if (depth === 0 && /[A-Za-z_]/.test(char)) {
        const start = index;
        index++;
        while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index])) {
          index++;
        }
        words.push({word: sql.slice(start, index).toLowerCase(), start, end: index});
        continue;
      }
      index++;
    }
    return words;
  }

  function splitStatements(sql) {
    const statements = [];
    let state = 'normal';
    let depth = 0;
    let start = 0;
    for (let index = 0; index < sql.length; index++) {
      const char = sql[index];
      const next = sql[index + 1];
      if (state === 'line-comment') {
        if (char === '\n' || char === '\r') {
          state = 'normal';
        }
        continue;
      }
      if (state === 'block-comment') {
        if (char === '*' && next === '/') {
          state = 'normal';
          index++;
        }
        continue;
      }
      if (state === 'single-quote' || state === 'double-quote' || state === 'backtick') {
        const quote = state === 'single-quote' ? "'" : state === 'double-quote' ? '"' : '`';
        if (char === '\\' && state !== 'backtick') {
          index++;
          continue;
        }
        if (char === quote) {
          if (next === quote) {
            index++;
            continue;
          }
          state = 'normal';
        }
        continue;
      }
      if (char === '-' && next === '-') {
        state = 'line-comment';
        index++;
        continue;
      }
      if (char === '#') {
        state = 'line-comment';
        continue;
      }
      if (char === '/' && next === '*') {
        state = 'block-comment';
        index++;
        continue;
      }
      if (char === "'") {
        state = 'single-quote';
        continue;
      }
      if (char === '"') {
        state = 'double-quote';
        continue;
      }
      if (char === '`') {
        state = 'backtick';
        continue;
      }
      if (char === '(') {
        depth++;
        continue;
      }
      if (char === ')') {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (char === ';' && depth === 0) {
        const statement = sql.slice(start, index).trim();
        if (statement) {
          statements.push(statement);
        }
        start = index + 1;
      }
    }
    const lastStatement = sql.slice(start).trim();
    if (lastStatement) {
      statements.push(lastStatement);
    }
    return statements;
  }

  function splitTopLevelByComma(sql) {
    const segments = [];
    let state = 'normal';
    let depth = 0;
    let start = 0;
    for (let index = 0; index < sql.length; index++) {
      const char = sql[index];
      const next = sql[index + 1];
      if (state === 'line-comment') {
        if (char === '\n' || char === '\r') {
          state = 'normal';
        }
        continue;
      }
      if (state === 'block-comment') {
        if (char === '*' && next === '/') {
          state = 'normal';
          index++;
        }
        continue;
      }
      if (state === 'single-quote' || state === 'double-quote' || state === 'backtick') {
        const quote = state === 'single-quote' ? "'" : state === 'double-quote' ? '"' : '`';
        if (char === '\\' && state !== 'backtick') {
          index++;
          continue;
        }
        if (char === quote) {
          if (next === quote) {
            index++;
            continue;
          }
          state = 'normal';
        }
        continue;
      }
      if (char === '-' && next === '-') {
        state = 'line-comment';
        index++;
        continue;
      }
      if (char === '#') {
        state = 'line-comment';
        continue;
      }
      if (char === '/' && next === '*') {
        state = 'block-comment';
        index++;
        continue;
      }
      if (char === "'") {
        state = 'single-quote';
        continue;
      }
      if (char === '"') {
        state = 'double-quote';
        continue;
      }
      if (char === '`') {
        state = 'backtick';
        continue;
      }
      if (char === '(') {
        depth++;
        continue;
      }
      if (char === ')') {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (char === ',' && depth === 0) {
        segments.push(sql.slice(start, index).trim());
        start = index + 1;
      }
    }
    segments.push(sql.slice(start).trim());
    return segments.filter(Boolean);
  }

  function findTopLevelEquals(sql) {
    let state = 'normal';
    let depth = 0;
    for (let index = 0; index < sql.length; index++) {
      const char = sql[index];
      const next = sql[index + 1];
      if (state === 'line-comment') {
        if (char === '\n' || char === '\r') {
          state = 'normal';
        }
        continue;
      }
      if (state === 'block-comment') {
        if (char === '*' && next === '/') {
          state = 'normal';
          index++;
        }
        continue;
      }
      if (state === 'single-quote' || state === 'double-quote' || state === 'backtick') {
        const quote = state === 'single-quote' ? "'" : state === 'double-quote' ? '"' : '`';
        if (char === '\\' && state !== 'backtick') {
          index++;
          continue;
        }
        if (char === quote) {
          if (next === quote) {
            index++;
            continue;
          }
          state = 'normal';
        }
        continue;
      }
      if (char === '-' && next === '-') {
        state = 'line-comment';
        index++;
        continue;
      }
      if (char === '#') {
        state = 'line-comment';
        continue;
      }
      if (char === '/' && next === '*') {
        state = 'block-comment';
        index++;
        continue;
      }
      if (char === "'") {
        state = 'single-quote';
        continue;
      }
      if (char === '"') {
        state = 'double-quote';
        continue;
      }
      if (char === '`') {
        state = 'backtick';
        continue;
      }
      if (char === '(') {
        depth++;
        continue;
      }
      if (char === ')') {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (char === '=' && depth === 0) {
        return index;
      }
    }
    return -1;
  }

  function unquoteIdentifier(identifier) {
    const value = identifier.trim();
    return value.startsWith('`') && value.endsWith('`')
      ? value.slice(1, -1).replace(/``/g, '`')
      : value;
  }

  function quoteIdentifier(identifier) {
    return '`' + String(identifier).replace(/`/g, '``') + '`';
  }

  function skipWhitespace(sql, start) {
    let index = start;
    while (index < sql.length && /\s/.test(sql[index])) {
      index++;
    }
    return index;
  }

  function readIdentifier(sql, start) {
    let index = skipWhitespace(sql, start);
    if (sql[index] === '`') {
      const identifierStart = index;
      index++;
      while (index < sql.length) {
        if (sql[index] === '`') {
          if (sql[index + 1] === '`') {
            index += 2;
            continue;
          }
          index++;
          break;
        }
        index++;
      }
      if (sql[index - 1] !== '`') {
        return null;
      }
      const raw = sql.slice(identifierStart, index);
      return {raw, name: unquoteIdentifier(raw), end: index};
    }
    const match = sql.slice(index).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (!match) {
      return null;
    }
    return {raw: match[0], name: match[0], end: index + match[0].length};
  }

  function readQualifiedIdentifier(sql, start) {
    const parts = [];
    let identifier = readIdentifier(sql, start);
    if (!identifier) {
      return null;
    }
    parts.push(identifier);
    let index = skipWhitespace(sql, identifier.end);
    while (sql[index] === '.') {
      identifier = readIdentifier(sql, index + 1);
      if (!identifier) {
        return null;
      }
      parts.push(identifier);
      index = skipWhitespace(sql, identifier.end);
    }
    if (parts.length > 2) {
      return null;
    }
    return {
      raw: parts.map(part => part.raw).join('.'),
      schemaName: parts.length === 2 ? parts[0].name : '',
      tableName: parts[parts.length - 1].name,
      tableIdentifierSql: parts[parts.length - 1].raw,
      end: parts[parts.length - 1].end
    };
  }

  function parseTableReferenceAt(fromExpression, start) {
    const table = readQualifiedIdentifier(fromExpression, start);
    if (!table) {
      throw new Error('暂不支持 JOIN 派生表、子查询或复杂表表达式');
    }
    const reservedWords = new Set([
      'use', 'force', 'ignore', 'index', 'key', 'partition', 'join', 'inner', 'left', 'right', 'cross',
      'natural', 'straight_join', 'on', 'using', 'where', 'order', 'limit'
    ]);
    let index = skipWhitespace(fromExpression, table.end);
    let alias = null;
    const possibleAs = readIdentifier(fromExpression, index);
    if (possibleAs && possibleAs.name.toLowerCase() === 'as') {
      alias = readIdentifier(fromExpression, possibleAs.end);
      if (!alias) {
        throw new Error('JOIN 表别名语法不正确');
      }
    } else if (possibleAs && !reservedWords.has(possibleAs.name.toLowerCase())) {
      alias = possibleAs;
    }
    const aliasName = alias ? alias.name : table.tableName;
    return {
      raw: table.raw,
      schemaName: table.schemaName,
      tableName: table.tableName,
      tableIdentifierSql: table.tableIdentifierSql,
      end: table.end,
      aliasName,
      aliasSql: alias ? alias.raw : table.tableIdentifierSql,
      displayAlias: aliasName
    };
  }

  function findTopLevelCommaPositions(sql) {
    const positions = [];
    const segments = splitTopLevelByComma(sql);
    if (segments.length <= 1) {
      return positions;
    }
    let searchStart = 0;
    for (let index = 0; index < segments.length - 1; index++) {
      const segmentIndex = sql.indexOf(segments[index], searchStart);
      const commaIndex = sql.indexOf(',', segmentIndex + segments[index].length);
      positions.push(commaIndex);
      searchStart = commaIndex + 1;
    }
    return positions;
  }

  function parseTableReferences(fromExpression) {
    const words = scanTopLevelWords(fromExpression);
    const starts = [0];
    words.forEach(item => {
      if (item.word === 'join' || item.word === 'straight_join') {
        starts.push(item.end);
      }
    });
    findTopLevelCommaPositions(fromExpression).forEach(position => starts.push(position + 1));
    const references = starts.sort((left, right) => left - right).map(start => parseTableReferenceAt(fromExpression, start));
    const uniqueReferences = [];
    references.forEach(reference => {
      if (!uniqueReferences.some(item => item.aliasName.toLowerCase() === reference.aliasName.toLowerCase())) {
        uniqueReferences.push(reference);
      }
    });
    return uniqueReferences;
  }

  function resolveTargetReference(targetName, tableReferences) {
    const normalizedTarget = unquoteIdentifier(targetName.replace(/\.\s*\*\s*$/, '')).toLowerCase();
    const target = tableReferences.find(reference =>
      reference.aliasName.toLowerCase() === normalizedTarget || reference.tableName.toLowerCase() === normalizedTarget
    );
    if (!target) {
      throw new Error('未找到目标表或别名：' + targetName);
    }
    return target;
  }

  function uniqueTargetReferences(targets) {
    return targets.filter((target, index) => targets.findIndex(item =>
      item.aliasName.toLowerCase() === target.aliasName.toLowerCase()
    ) === index);
  }

  function parseUpdateTargetReferences(assignments, tableReferences) {
    const identifierPart = '(?:`(?:``|[^`])+`|[A-Za-z_$][A-Za-z0-9_$]*)';
    const qualifiedColumnPattern = new RegExp('^(' + identifierPart + ')\\s*\\.\\s*' + identifierPart + '$', 'i');
    const targets = splitTopLevelByComma(assignments).map(assignment => {
      const equalsIndex = findTopLevelEquals(assignment);
      if (equalsIndex < 0) {
        throw new Error('UPDATE SET 赋值语法不正确');
      }
      const leftExpression = assignment.slice(0, equalsIndex).trim();
      const match = leftExpression.match(qualifiedColumnPattern);
      if (!match && tableReferences.length > 1) {
        throw new Error('JOIN UPDATE 的 SET 目标字段必须带表名或别名，避免无法判断实际修改表');
      }
      return match ? resolveTargetReference(match[1], tableReferences) : tableReferences[0];
    });
    return uniqueTargetReferences(targets);
  }

  function parseDeleteTargetReferences(targetList, tableReferences) {
    const targets = splitTopLevelByComma(targetList).map(target => {
      const normalizedTarget = target.trim().replace(/\.\s*\*\s*$/, '');
      return resolveTargetReference(normalizedTarget, tableReferences);
    });
    return uniqueTargetReferences(targets);
  }

  function parseSimpleTarget(target) {
    const identifierPart = '(?:`(?:``|[^`])+`|[A-Za-z_$][A-Za-z0-9_$]*)';
    const qualifiedIdentifier = identifierPart + '(?:\\s*\\.\\s*' + identifierPart + ')?';
    const targetPattern = new RegExp('^(' + qualifiedIdentifier + ')(?:\\s+(?:AS\\s+)?(' + identifierPart + '))?$', 'i');
    const match = target.trim().match(targetPattern);
    if (!match) {
      throw new Error('目标表语法不正确');
    }
    return match[1] + (match[2] ? ' ' + match[2] : '');
  }

  function findTailStart(statement, words, beginIndex) {
    const candidates = words.filter(item => item.start >= beginIndex);
    const where = candidates.find(item => item.word === 'where');
    if (where) {
      return where.start;
    }
    for (let index = candidates.length - 1; index >= 0; index--) {
      const item = candidates[index];
      if (item.word === 'limit' && /^\s+\d+(?:\s*,\s*\d+)?\s*$/.test(statement.slice(item.end))) {
        return item.start;
      }
      if (item.word === 'order' && candidates[index + 1] && candidates[index + 1].word === 'by') {
        return item.start;
      }
    }
    return statement.length;
  }

  function buildSimpleCountQuery(tableExpression, tail) {
    const tailWords = scanTopLevelWords(tail);
    const hasLimit = tailWords.some(item => item.word === 'limit');
    const hasOrderBy = tailWords.some((item, index) => item.word === 'order' && tailWords[index + 1] && tailWords[index + 1].word === 'by');
    if (!hasLimit && !hasOrderBy) {
      return 'SELECT COUNT(*) AS change_row_count FROM ' + tableExpression + (tail ? ' ' + tail : '');
    }
    const innerQuery = 'SELECT 1 FROM ' + tableExpression + (tail ? ' ' + tail : '');
    return 'SELECT COUNT(*) AS change_row_count FROM (' + innerQuery + ') AS _yearning_change_rows';
  }

  function buildInsertSelectCountPlan(cleanStatement, words) {
    const selectWord = words.find(item => item.word === 'select' && item.start > words[0].end);
    if (!selectWord) {
      throw new Error('INSERT 语句缺少顶层 SELECT；当前仅支持 INSERT INTO ... SELECT，不支持 INSERT ... VALUES/SET');
    }
    const hasIgnore = words.some(item => item.word === 'ignore' && item.start > words[0].end && item.start < selectWord.start);
    if (hasIgnore) {
      throw new Error('INSERT IGNORE ... SELECT 可能跳过重复数据，暂时无法准确检测实际变更行数');
    }
    const duplicateKeyIndex = words.findIndex((item, index) => item.start > selectWord.start && item.word === 'on'
      && words[index + 1] && words[index + 1].word === 'duplicate'
      && words[index + 2] && words[index + 2].word === 'key'
      && words[index + 3] && words[index + 3].word === 'update');
    if (duplicateKeyIndex >= 0) {
      throw new Error('INSERT ... SELECT ... ON DUPLICATE KEY UPDATE 暂时无法准确检测实际变更行数');
    }
    const withWord = words.find(item => item.word === 'with' && item.start > words[0].end && item.start < selectWord.start);
    const sourceQueryStart = withWord ? withWord.start : selectWord.start;
    const sourceQuery = cleanStatement.slice(sourceQueryStart).trim();
    const fromWord = words.find(item => item.word === 'from' && item.start > selectWord.end);
    if (fromWord) {
      const selectModifierWords = words.filter(item => item.start > selectWord.end && item.start < fromWord.start);
      const hasDistinct = selectModifierWords.some(item => item.word === 'distinct' || item.word === 'distinctrow');
      const hasSetOperation = words.some(item => item.start > selectWord.end
        && (item.word === 'union' || item.word === 'intersect' || item.word === 'except'));
      if (!hasDistinct && !hasSetOperation) {
        const sourceTailWords = words.filter(item => item.start > fromWord.end);
        const hasGroupBy = sourceTailWords.some((item, index) => item.word === 'group'
          && sourceTailWords[index + 1] && sourceTailWords[index + 1].word === 'by');
        const hasHaving = sourceTailWords.some(item => item.word === 'having');
        const hasLimit = sourceTailWords.some(item => item.word === 'limit');
        const orderByWord = sourceTailWords.find((item, index) => item.word === 'order'
          && sourceTailWords[index + 1] && sourceTailWords[index + 1].word === 'by');
        const ctePrefix = withWord ? cleanStatement.slice(withWord.start, selectWord.start).trim() + ' ' : '';
        if (!hasGroupBy && !hasHaving && !hasLimit) {
          const fromClauseEnd = orderByWord ? orderByWord.start : cleanStatement.length;
          const fromClause = cleanStatement.slice(fromWord.start, fromClauseEnd).trim();
          return {
            kind: 'simple',
            querySql: ctePrefix + 'SELECT COUNT(*) AS change_row_count ' + fromClause
          };
        }
        const normalizedSourceQuery = ctePrefix + 'SELECT 1 AS _yearning_row ' + cleanStatement.slice(fromWord.start).trim();
        return {
          kind: 'simple',
          querySql: 'SELECT COUNT(*) AS change_row_count FROM (' + normalizedSourceQuery + ') AS _yearning_insert_rows'
        };
      }
    }
    return {
      kind: 'simple',
      querySql: 'SELECT COUNT(*) AS change_row_count FROM (' + sourceQuery + ') AS _yearning_insert_rows'
    };
  }

  function buildCountPlan(statement) {
    const cleanStatement = statement.trim().replace(/;\s*$/, '');
    const words = scanTopLevelWords(cleanStatement);
    if (!words.length) {
      throw new Error('未识别到有效 SQL 关键字，请确认没有只选中注释、空白或不完整语句');
    }
    const statementType = words[0].word;
    const ddlStatementTypes = ['create', 'alter', 'drop', 'truncate', 'rename'];
    if (ddlStatementTypes.includes(statementType)) {
      throw new Error('不支持 ' + statementType.toUpperCase() + ' DDL 语句；当前只支持 DML 语句：UPDATE、DELETE、INSERT INTO ... SELECT');
    }
    if (statementType === 'select') {
      throw new Error('独立 SELECT 查询不会变更数据，不支持变更行数检测');
    }
    if (statementType !== 'update' && statementType !== 'delete' && statementType !== 'insert') {
      throw new Error('暂不支持 ' + statementType.toUpperCase() + ' 语句；当前仅支持 UPDATE、DELETE、INSERT INTO ... SELECT');
    }
    if (statementType === 'insert') {
      return buildInsertSelectCountPlan(cleanStatement, words);
    }
    if (statementType === 'update') {
      const setWord = words.find(item => item.word === 'set' && item.start > words[0].end);
      if (!setWord) {
        throw new Error('UPDATE 语句缺少顶层 SET，请确认选中了完整的 UPDATE 语句');
      }
      let updateTarget = cleanStatement.slice(words[0].end, setWord.start).trim();
      updateTarget = updateTarget.replace(/^(?:(?:LOW_PRIORITY|IGNORE)\s+)+/i, '');
      const tailStart = findTailStart(cleanStatement, words, setWord.end);
      const tail = cleanStatement.slice(tailStart).trim();
      const hasJoin = scanTopLevelWords(updateTarget).some(item => item.word === 'join' || item.word === 'straight_join')
        || splitTopLevelByComma(updateTarget).length > 1;
      if (!hasJoin) {
        const tableExpression = parseSimpleTarget(updateTarget);
        return {
          kind: 'simple',
          querySql: buildSimpleCountQuery(tableExpression, tail)
        };
      }
      const tableReferences = parseTableReferences(updateTarget);
      const assignments = cleanStatement.slice(setWord.end, tailStart).trim();
      return {
        kind: 'join',
        fromExpression: updateTarget,
        tail,
        targets: parseUpdateTargetReferences(assignments, tableReferences)
      };
    }
    const fromWord = words.find(item => item.word === 'from' && item.start > words[0].end);
    if (!fromWord) {
      throw new Error('DELETE 语句缺少顶层 FROM，请确认选中了完整的 DELETE 语句');
    }
    const usingWord = words.find(item => item.word === 'using' && item.start > fromWord.end);
    const deletePrefix = cleanStatement.slice(words[0].end, fromWord.start)
      .replace(/\b(?:LOW_PRIORITY|QUICK|IGNORE)\b/gi, '')
      .trim();
    if (!usingWord && !deletePrefix) {
      const tailStart = findTailStart(cleanStatement, words, fromWord.end);
      const tableExpression = parseSimpleTarget(cleanStatement.slice(fromWord.end, tailStart));
      const tail = cleanStatement.slice(tailStart).trim();
      return {
        kind: 'simple',
        querySql: buildSimpleCountQuery(tableExpression, tail)
      };
    }
    let targetList;
    let fromExpressionStart;
    if (usingWord) {
      if (deletePrefix) {
        throw new Error('DELETE ... USING 语法不正确');
      }
      targetList = cleanStatement.slice(fromWord.end, usingWord.start).trim();
      fromExpressionStart = usingWord.end;
    } else {
      targetList = deletePrefix;
      fromExpressionStart = fromWord.end;
    }
    const tailStart = findTailStart(cleanStatement, words, fromExpressionStart);
    const fromExpression = cleanStatement.slice(fromExpressionStart, tailStart).trim();
    const tableReferences = parseTableReferences(fromExpression);
    return {
      kind: 'join',
      fromExpression,
      tail: cleanStatement.slice(tailStart).trim(),
      targets: parseDeleteTargetReferences(targetList, tableReferences)
    };
  }

  function findTargetMonacoEditor() {
    const editors = Array.from(capturedMonacoEditors);
    const editorRoot = document.getElementById('apply');
    const targetEditor = editors.find(editor => {
      const editorDomNode = editor.getDomNode();
      return editorRoot && editorDomNode && (editorDomNode === editorRoot || editorRoot.contains(editorDomNode));
    });
    if (targetEditor) {
      return targetEditor;
    }
    if (editors.length === 1) {
      return editors[0];
    }
    return null;
  }

  async function getMonacoEditor() {
    const editor = findTargetMonacoEditor();
    if (!editor) {
      const hookError = monacoHookError ? '；' + monacoHookError : '';
      throw new Error('未捕获到填写 SQL 的 Monaco Editor 实例，请完整刷新 Yearning 页面后重试' + hookError);
    }
    return editor;
  }

  async function getEditorSql() {
    const editor = await getMonacoEditor();
    const model = editor.getModel();
    if (!model) {
      throw new Error('Monaco Editor 尚未绑定 SQL Model，请稍后重试');
    }
    const selection = editor.getSelection();
    const selectedSql = selection ? model.getValueInRange(selection).trim() : '';
    return selectedSql || model.getValue().trim();
  }

  function getSchema() {
    const databaseItem = Array.from(document.querySelectorAll('.ant-form-item')).find(item => {
      const label = item.querySelector('.ant-form-item-label');
      return label && label.textContent.includes('数据库');
    });
    const selected = databaseItem ? databaseItem.querySelector('.ant-select-selection-item') : null;
    if (selected && selected.textContent.trim()) {
      return selected.textContent.trim();
    }
    const databaseInput = databaseItem ? databaseItem.querySelector('input') : null;
    return databaseInput ? databaseInput.value.trim() : '';
  }

  function getSourceId() {
    const hashQuery = location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?') + 1) : '';
    return new URLSearchParams(hashQuery).get('source_id') || '';
  }

  function getAuthToken() {
    try {
      const vuexState = JSON.parse(sessionStorage.getItem('vuex') || '{}');
      const accountToken = vuexState && vuexState.user && vuexState.user.account
        ? vuexState.user.account.token
        : '';
      if (accountToken) {
        return String(accountToken).replace(/^Bearer\s+/i, '');
      }
    } catch (ignore) {
    }
    return (sessionStorage.getItem('jwt') || '').replace(/^Bearer\s+/i, '');
  }

  function getMessagePackCodec() {
    if (typeof MessagePack !== 'undefined' && MessagePack) {
      return MessagePack;
    }
    if (typeof globalThis !== 'undefined' && globalThis.MessagePack) {
      return globalThis.MessagePack;
    }
    if (typeof window !== 'undefined' && window.MessagePack) {
      return window.MessagePack;
    }
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow.MessagePack) {
      return unsafeWindow.MessagePack;
    }
    return null;
  }

  function extractRowCount(response) {
    const firstResult = response.results && response.results[0];
    const firstRow = firstResult && firstResult.data ? firstResult.data[0] : null;
    if (!firstRow) {
      throw new Error('查询未返回变更行数');
    }
    if (firstRow.change_row_count !== undefined) {
      return firstRow.change_row_count;
    }
    return Object.values(firstRow)[0];
  }

  function executeQuery(sourceId, schema, querySql, token) {
    return new Promise((resolve, reject) => {
      const messagePackCodec = getMessagePackCodec();
      if (!messagePackCodec) {
        reject(new Error('MessagePack 组件加载失败，请重新保存油猴脚本后刷新页面'));
        return;
      }
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socketUrl = protocol + '//' + location.host + '/api/v2/query/results?source_id=' + encodeURIComponent(sourceId);
      let socket;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
          socket.close();
        }
        callback(value);
      };
      const timer = window.setTimeout(() => finish(reject, new Error('查询超时，请稍后重试')), QUERY_TIMEOUT);
      try {
        socket = new WebSocket(socketUrl, [token]);
      } catch (error) {
        finish(reject, error);
        return;
      }
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        socket.send(messagePackCodec.encode({type: 4, sql: querySql, schema}));
      };
      socket.onerror = () => {
        finish(reject, new Error('查询服务连接失败，请确认当前账号具有查询权限'));
      };
      socket.onclose = () => {
        if (!settled) {
          finish(reject, new Error('查询服务已断开连接'));
        }
      };
      socket.onmessage = event => {
        Promise.resolve(event.data instanceof Blob ? event.data.arrayBuffer() : event.data).then(data => {
          if (typeof data === 'string') {
            if (data === 'pong') {
              return;
            }
            throw new Error('Yearning WebSocket 返回：' + data);
          }
          const response = messagePackCodec.decode(new Uint8Array(data));
          if (response.heartbeat === 'pong') {
            return;
          }
          if (response.status) {
            throw new Error('查询会话已过期，请重新登录');
          }
          if (response.error) {
            const responseError = typeof response.error === 'string' ? response.error : JSON.stringify(response.error);
            throw new Error('Yearning 查询接口返回：' + responseError);
          }
          finish(resolve, response);
        }).catch(error => finish(reject, error));
      };
    });
  }

  function escapeSqlLiteral(value) {
    return String(value).replace(/'/g, "''");
  }

  async function getPrimaryKeyColumns(sourceId, schema, tableReference, token) {
    const tableSchema = tableReference.schemaName || schema;
    const cacheKey = (sourceId + ':' + tableSchema + '.' + tableReference.tableName).toLowerCase();
    if (primaryKeyCache.has(cacheKey)) {
      return primaryKeyCache.get(cacheKey);
    }
    const querySql = 'SELECT COLUMN_NAME AS column_name FROM information_schema.KEY_COLUMN_USAGE '
      + "WHERE TABLE_SCHEMA = '" + escapeSqlLiteral(tableSchema) + "' "
      + "AND TABLE_NAME = '" + escapeSqlLiteral(tableReference.tableName) + "' "
      + "AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION";
    const response = await executeQuery(sourceId, schema, querySql, token);
    const firstResult = response.results && response.results[0];
    const rows = firstResult && firstResult.data ? firstResult.data : [];
    const primaryKeys = rows.map(row => {
      if (row.column_name !== undefined && row.column_name !== null) {
        return row.column_name;
      }
      if (row.COLUMN_NAME !== undefined && row.COLUMN_NAME !== null) {
        return row.COLUMN_NAME;
      }
      return Object.values(row)[0];
    }).filter(Boolean);
    if (!primaryKeys.length) {
      throw new Error('目标表 ' + tableSchema + '.' + tableReference.tableName + ' 没有主键，无法准确去重计算 JOIN 变更行数');
    }
    primaryKeyCache.set(cacheKey, primaryKeys);
    return primaryKeys;
  }

  function buildJoinCountQuery(plan, target, primaryKeys, targetIndex) {
    const distinctColumns = primaryKeys.map(column => target.aliasSql + '.' + quoteIdentifier(column)).join(', ');
    const innerQuery = 'SELECT DISTINCT ' + distinctColumns + ' FROM ' + plan.fromExpression + (plan.tail ? ' ' + plan.tail : '');
    return 'SELECT COUNT(*) AS change_row_count FROM (' + innerQuery + ') AS _yearning_change_rows_' + (targetIndex + 1);
  }

  function addRowCounts(left, right) {
    const total = BigInt(String(left)) + BigInt(String(right));
    return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : total.toString();
  }

  async function executeCountPlan(sourceId, schema, plan, token) {
    if (plan.kind === 'simple') {
      const response = await executeQuery(sourceId, schema, plan.querySql, token);
      return {
        rowCount: extractRowCount(response),
        queryTime: response.query_time,
        querySql: plan.querySql,
        targetCounts: []
      };
    }
    let totalRowCount = 0;
    let totalQueryTime = 0;
    const querySqlList = [];
    const targetCounts = [];
    for (let index = 0; index < plan.targets.length; index++) {
      const target = plan.targets[index];
      const primaryKeys = await getPrimaryKeyColumns(sourceId, schema, target, token);
      const querySql = buildJoinCountQuery(plan, target, primaryKeys, index);
      const response = await executeQuery(sourceId, schema, querySql, token);
      const rowCount = extractRowCount(response);
      totalRowCount = addRowCounts(totalRowCount, rowCount);
      totalQueryTime += Number(response.query_time || 0);
      querySqlList.push(querySql);
      targetCounts.push({alias: target.displayAlias, rowCount});
    }
    return {
      rowCount: totalRowCount,
      queryTime: totalQueryTime,
      querySql: querySqlList.join('\n\n'),
      targetCounts
    };
  }

  function setButtonLoading(button, loading) {
    button.disabled = loading;
    button.textContent = loading ? '检测中...' : BUTTON_TEXT;
  }

  async function handleCheck(button) {
    let sql;
    try {
      sql = await getEditorSql();
    } catch (error) {
      showToast(error.message || '无法获取完整的编辑器 SQL，请刷新页面后重试');
      return;
    }
    if (!sql) {
      showToast('请输入或选中需要检测的 SQL');
      return;
    }
    const statements = splitStatements(sql);
    if (!statements.length) {
      showToast('未识别到可检测的 SQL，请确认选中内容不是空白或只有分号');
      return;
    }
    const schema = getSchema();
    if (!schema) {
      showToast('请先选择数据库');
      return;
    }
    const sourceId = getSourceId();
    const token = getAuthToken();
    if (!sourceId || !token) {
      showToast('未获取到数据源或登录信息，请刷新页面后重试');
      return;
    }
    if (!getMessagePackCodec()) {
      showToast('MessagePack 组件加载失败，请重新保存油猴脚本后刷新页面');
      return;
    }
    setButtonLoading(button, true);
    try {
      const results = [];
      for (let index = 0; index < statements.length; index++) {
        const statement = statements[index];
        let plan;
        try {
          plan = buildCountPlan(statement);
        } catch (error) {
          results.push({
            originalSql: statement,
            stage: 'SQL 转换失败',
            error: error.message || UNSUPPORTED_MESSAGE,
            querySql: ''
          });
          continue;
        }
        try {
          const queryResult = await executeCountPlan(sourceId, schema, plan, token);
          results.push({
            originalSql: statement,
            rowCount: queryResult.rowCount,
            queryTime: queryResult.queryTime,
            querySql: queryResult.querySql,
            targetCounts: queryResult.targetCounts
          });
        } catch (error) {
          results.push({
            originalSql: statement,
            stage: '查询执行失败',
            error: error.message || '未知错误',
            querySql: plan.kind === 'simple' ? plan.querySql : ''
          });
        }
      }
      showResults(results, schema);
    } catch (error) {
      showToast(error.message || '变更行数检测失败');
    } finally {
      setButtonLoading(button, false);
    }
  }

  function injectButton() {
    if (!location.hash.startsWith('#/apply/order') || document.getElementById(BUTTON_ID)) {
      return;
    }
    const beautyButton = Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'SQL美化');
    const beautyItem = beautyButton ? beautyButton.closest('.ant-space-item') : null;
    if (!beautyItem) {
      return;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'ant-space-item';
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.className = 'ant-btn';
    button.title = 'v' + SCRIPT_VERSION + '；优先检测光标选中的 SQL；未选中时检测全部 SQL';
    button.textContent = BUTTON_TEXT;
    button.addEventListener('click', () => handleCheck(button));
    wrapper.appendChild(button);
    beautyItem.insertAdjacentElement('afterend', wrapper);
  }

  function initialize() {
    addStyle();
    injectButton();
    new MutationObserver(injectButton).observe(document.body, {childList: true, subtree: true});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, {once: true});
  } else {
    initialize();
  }
})();
