// ==UserScript==
// @name         Yearning 数据库表名搜索结果过滤
// @namespace    https://yearning.io/
// @version      0.4.2
// @description  缓存 /api/v2/query/tables 返回的完整表列表，并为筛选结果提供右键菜单、复制、查看表数据和独立表结构查看能力
// @author       codex
// @match        *://{IP}:{PORT}/*
// @license      MIT
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const TABLE_API_PATH = '/api/v2/query/tables';
  const QUERY_RESULTS_WS_PATH = '/api/v2/query/results';
  const FILTERING_CLASS = 'ym-api-table-filtering';
  const PANEL_CLASS = 'ym-api-table-filter-panel';
  const ROW_CLASS = 'ym-api-table-filter-row';
  const ROW_ACTIVE_CLASS = 'ym-api-table-filter-row-active';
  const MENU_CLASS = 'ym-api-table-context-menu';
  const MENU_ITEM_CLASS = 'ym-api-table-context-menu-item';
  const MENU_DIVIDER_CLASS = 'ym-api-table-context-menu-divider';
  const NATIVE_COPY_MENU_CLASS = 'ym-api-table-native-copy-menu';
  const STRUCTURE_TAB_CLASS = 'ym-api-table-structure-tab';
  const STRUCTURE_PANE_CLASS = 'ym-api-table-structure-pane';
  const STRUCTURE_ACTIVE_CLASS = 'ym-api-table-structure-active';
  const TOAST_CLASS = 'ym-api-table-filter-toast';
  const MAX_ROWS = 200;
  const QUERY_TIMEOUT = 30000;

  const tableCache = new Map();
  const authTokens = [];
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  let renderTimer = 0;
  let clickTimer = 0;
  let toastTimer = 0;
  let lastSearchRoot = null;

  installFetchCacheHook();
  installXhrCacheHook();
  installWebSocketTokenHook();

  onReady(() => {
    injectStyle();
    bindEvents();
    scheduleRender(200);
  });

  function installFetchCacheHook() {
    if (typeof window.fetch !== 'function') {
      return;
    }

    const nativeFetch = window.fetch;
    window.fetch = function yearningTableFilterFetch(input, init) {
      const responsePromise = nativeFetch.apply(this, arguments);
      const requestUrl = getRequestUrl(input);
      rememberAuthHeaders(input && input.headers);
      rememberAuthHeaders(init && init.headers);

      if (isTablesApi(requestUrl)) {
        responsePromise
          .then((response) => response.clone().text())
          .then((text) => cacheTablesResponse(text, requestUrl))
          .catch(() => {});
      }

      return responsePromise;
    };
  }

  function installXhrCacheHook() {
    if (typeof window.XMLHttpRequest !== 'function') {
      return;
    }

    const prototype = window.XMLHttpRequest.prototype;
    const nativeOpen = prototype.open;
    const nativeSend = prototype.send;
    const nativeSetRequestHeader = prototype.setRequestHeader;

    prototype.open = function yearningTableFilterOpen(method, url) {
      this.__ymTableFilterUrl = String(url || '');
      this.__ymTableFilterBound = false;
      return nativeOpen.apply(this, arguments);
    };

    prototype.setRequestHeader = function yearningTableFilterSetRequestHeader(name, value) {
      rememberAuthHeader(name, value);
      return nativeSetRequestHeader.apply(this, arguments);
    };

    prototype.send = function yearningTableFilterSend() {
      if (isTablesApi(this.__ymTableFilterUrl) && !this.__ymTableFilterBound) {
        this.__ymTableFilterBound = true;
        this.addEventListener('load', () => {
          try {
            cacheTablesResponse(this.responseText, this.__ymTableFilterUrl);
          } catch (error) {
            // 缓存失败不影响 Yearning 原页面。
          }
        }, true);
      }

      return nativeSend.apply(this, arguments);
    };
  }

  function installWebSocketTokenHook() {
    if (typeof window.WebSocket !== 'function') {
      return;
    }

    const NativeWebSocket = window.WebSocket;
    window.WebSocket = function yearningTableFilterWebSocket(url, protocols) {
      rememberWebSocketProtocol(url, protocols);
      return protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);
    };
    window.WebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(window.WebSocket, NativeWebSocket);
  }

  function cacheTablesResponse(text, requestUrl) {
    const data = JSON.parse(text);
    const tables = data && data.payload && data.payload.table;

    if (!Array.isArray(tables)) {
      return;
    }

    const requestInfo = parseTablesRequest(requestUrl);
    const schema = requestInfo.schema || inferSchema(tables) || '';
    const sourceId = requestInfo.sourceId || '';
    const cacheKey = `${sourceId}::${schema}`;

    tableCache.set(cacheKey, {
      sourceId,
      schema,
      updatedAt: Date.now(),
      tables: tables
        .map((table) => ({
          title: String(table.title || table.name || ''),
          key: String(table.key || ''),
          meta: String(table.meta || ''),
          schema,
          sourceId,
        }))
        .filter((table) => table.title),
    });

    scheduleRender(80);
  }

  function injectStyle() {
    const style = document.createElement('style');
    style.textContent = `
      .ant-tree.${FILTERING_CLASS} .ant-tree-list {
        display: none !important;
      }

      .${PANEL_CLASS} {
        background: #fff;
        border: 1px solid #f0f0f0;
        border-radius: 4px;
        box-sizing: border-box;
        margin: 8px 0;
        max-height: 540px;
        overflow: auto;
      }

      .${PANEL_CLASS} .ym-api-table-filter-summary {
        color: #8c8c8c;
        font-size: 12px;
        line-height: 28px;
        padding: 0 8px;
      }

      .${PANEL_CLASS} .ym-api-table-filter-schema {
        background: #fafafa;
        color: #595959;
        font-size: 12px;
        font-weight: 600;
        line-height: 28px;
        padding: 0 8px;
        position: sticky;
        top: 0;
      }

      .${ROW_CLASS} {
        color: #262626;
        cursor: pointer;
        font-size: 13px;
        line-height: 28px;
        overflow: hidden;
        padding: 0 8px 0 24px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .${ROW_CLASS}:hover,
      .${ROW_CLASS}.${ROW_ACTIVE_CLASS} {
        background: #e6f7ff;
      }

      .${ROW_CLASS} mark {
        background: transparent;
        color: #f5222d;
        padding: 0;
      }

      .${MENU_CLASS} {
        background: #fff;
        border: 1px solid #f0f0f0;
        border-radius: 2px;
        box-shadow: 0 3px 6px -4px rgba(0, 0, 0, 0.12), 0 6px 16px 0 rgba(0, 0, 0, 0.08), 0 9px 28px 8px rgba(0, 0, 0, 0.05);
        box-sizing: border-box;
        color: #262626;
        display: none;
        min-width: 132px;
        padding: 4px 0;
        position: fixed;
        z-index: 2147483647;
      }

      .${MENU_ITEM_CLASS} {
        cursor: pointer;
        font-size: 14px;
        line-height: 32px;
        padding: 0 16px;
        user-select: none;
        white-space: nowrap;
      }

      .${MENU_ITEM_CLASS}:hover {
        background: #f5f5f5;
      }

      .${MENU_DIVIDER_CLASS} {
        background: #f0f0f0;
        height: 1px;
        margin: 4px 0;
      }

      .${NATIVE_COPY_MENU_CLASS} {
        color: #262626;
      }

      .${TOAST_CLASS} {
        background: rgba(0, 0, 0, 0.78);
        border-radius: 4px;
        color: #fff;
        display: none;
        font-size: 13px;
        left: 50%;
        line-height: 20px;
        max-width: 360px;
        padding: 8px 12px;
        position: fixed;
        top: 72px;
        transform: translateX(-50%);
        z-index: 2147483647;
      }

      .${STRUCTURE_TAB_CLASS} {
        user-select: none;
      }

      .ant-tabs.${STRUCTURE_ACTIVE_CLASS} .ant-tabs-ink-bar {
        display: none;
      }

      .${STRUCTURE_TAB_CLASS} .ant-tabs-tab-btn {
        color: inherit;
      }

      .${STRUCTURE_PANE_CLASS} {
        background: #fff;
        box-sizing: border-box;
        color: #262626;
        min-height: 360px;
        padding: 16px;
      }

      .ym-api-table-structure-card {
        border: 1px solid #f0f0f0;
        border-radius: 4px;
        margin-bottom: 16px;
        overflow: hidden;
      }

      .ym-api-table-structure-title {
        background: #fafafa;
        border-bottom: 1px solid #f0f0f0;
        color: #595959;
        font-size: 13px;
        font-weight: 600;
        line-height: 36px;
        padding: 0 12px;
      }

      .ym-api-table-structure-code {
        background: #1f2329;
        color: #d6deeb;
        font-family: Consolas, Monaco, "Courier New", monospace;
        font-size: 13px;
        line-height: 20px;
        margin: 0;
        max-height: 560px;
        overflow: auto;
        padding: 12px;
        white-space: pre;
      }

      .ym-api-table-structure-message {
        color: #8c8c8c;
        font-size: 13px;
        line-height: 22px;
        padding: 12px;
      }

      .ym-api-table-structure-error {
        color: #cf1322;
      }

      .ym-api-table-structure-meta {
        color: #8c8c8c;
        font-size: 12px;
        margin: -8px 0 12px;
      }

      .ym-api-table-structure-table-wrap {
        overflow: auto;
      }

      .ym-api-table-structure-table {
        border-collapse: collapse;
        font-size: 12px;
        min-width: 100%;
      }

      .ym-api-table-structure-table th,
      .ym-api-table-structure-table td {
        border: 1px solid #f0f0f0;
        max-width: 480px;
        padding: 8px;
        text-align: left;
        vertical-align: top;
      }

      .ym-api-table-structure-table th {
        background: #fafafa;
        color: #595959;
        font-weight: 600;
      }

      .ym-sql-keyword {
        color: #82aaff;
        font-weight: 600;
      }

      .ym-sql-string {
        color: #c3e88d;
      }

      .ym-sql-number {
        color: #f78c6c;
      }

      .ym-sql-comment {
        color: #697586;
        font-style: italic;
      }
    `;
    document.head.appendChild(style);
  }

  function bindEvents() {
    document.addEventListener('input', (event) => {
      if (!isTreeSearchInput(event.target)) {
        return;
      }

      lastSearchRoot = getSearchRoot(event.target);
      scheduleRender(120);
    }, true);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideContextMenu();
        return;
      }

      if (event.key !== 'Enter' || !isTreeSearchInput(event.target)) {
        return;
      }

      lastSearchRoot = getSearchRoot(event.target);
      scheduleRender(80);
    }, true);

    document.addEventListener('click', (event) => {
      if (!event.target.closest || !event.target.closest(`.${MENU_CLASS}`)) {
        hideContextMenu();
      }

      const searchWrapper = event.target.closest && event.target.closest('.ant-input-search');
      if (!searchWrapper || !getTree(searchWrapper)) {
        return;
      }

      lastSearchRoot = getSearchRoot(searchWrapper);
      scheduleRender(120);
    }, true);

    document.addEventListener('click', handleStructureTabClick, true);
    document.addEventListener('contextmenu', handleNativeTreeContextMenu, true);
    document.addEventListener('dblclick', handleNativeTreeDoubleClick, true);

    window.addEventListener('resize', hideContextMenu, true);
    window.addEventListener('scroll', hideContextMenu, true);
  }

  function scheduleRender(delay) {
    window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(renderFilterResult, delay);
  }

  function renderFilterResult() {
    const root = lastSearchRoot || getActiveTreeSearchRoot();
    if (!root) {
      return;
    }

    const input = root.querySelector('.ant-input-search input.ant-input');
    const tree = getTree(root);

    if (!input || !tree) {
      return;
    }

    const keyword = input.value.trim();
    if (!keyword) {
      tree.classList.remove(FILTERING_CLASS);
      removePanel(root);
      hideContextMenu();
      return;
    }

    const groups = getMatchedGroups(keyword);
    if (groups.length === 0 && tableCache.size === 0) {
      tree.classList.remove(FILTERING_CLASS);
      removePanel(root);
      return;
    }

    tree.classList.add(FILTERING_CLASS);
    renderPanel(root, groups, keyword);
  }

  function renderPanel(root, groups, keyword) {
    const searchWrapper = root.querySelector('.ant-input-search');
    if (!searchWrapper) {
      return;
    }

    const panel = ensurePanel(root, searchWrapper);
    const fragment = document.createDocumentFragment();
    const total = groups.reduce((count, group) => count + group.tables.length, 0);
    let renderedCount = 0;

    if (total === 0) {
      fragment.appendChild(createElement('div', 'ym-api-table-filter-summary', '未找到匹配表名'));
    } else {
      fragment.appendChild(createElement('div', 'ym-api-table-filter-summary', `命中 ${total} 个表${total > MAX_ROWS ? `，仅显示前 ${MAX_ROWS} 个` : ''}`));
    }

    groups.forEach((group) => {
      if (renderedCount >= MAX_ROWS) {
        return;
      }

      fragment.appendChild(createElement('div', 'ym-api-table-filter-schema', group.schema || 'unknown_schema'));
      group.tables.forEach((table) => {
        if (renderedCount >= MAX_ROWS) {
          return;
        }

        renderedCount += 1;
        const row = createElement('div', ROW_CLASS, '');
        row.title = table.title;
        row.innerHTML = highlightKeyword(table.title, keyword);
        row.addEventListener('click', (event) => handleRowClick(event, row));
        row.addEventListener('dblclick', (event) => handleRowDoubleClick(event, table));
        row.addEventListener('contextmenu', (event) => showTableContextMenu(event, root, table, row));
        fragment.appendChild(row);
      });
    });

    panel.replaceChildren(fragment);
  }

  function handleRowClick(event, row) {
    event.stopPropagation();
    window.clearTimeout(clickTimer);
    clickTimer = window.setTimeout(() => {
      markActiveRow(row);
    }, 220);
  }

  async function handleRowDoubleClick(event, table) {
    event.preventDefault();
    event.stopPropagation();
    window.clearTimeout(clickTimer);
    hideContextMenu();

    await copyText(table.title);
    const inserted = appendToSqlEditor(table.title, 'inline');
    showToast(inserted ? `已复制并插入表名：${table.title}` : `已复制表名：${table.title}`);
  }

  function showTableContextMenu(event, root, table, row) {
    event.preventDefault();
    event.stopPropagation();
    window.clearTimeout(clickTimer);
    markActiveRow(row);

    const menu = ensureContextMenu();
    menu.replaceChildren(
      createMenuItem('查看表数据', () => runTableAction(root, table, 'data')),
      createMenuItem('查看表结构', () => runTableAction(root, table, 'schema')),
      createElement('div', MENU_DIVIDER_CLASS, ''),
      createMenuItem('复制表名', async () => {
        await copyText(table.title);
        showToast(`已复制表名：${table.title}`);
      })
    );

    menu.style.display = 'block';
    positionContextMenu(menu, event.clientX, event.clientY);
  }

  function handleNativeTreeContextMenu(event) {
    const target = getNativeTableTargetFromEvent(event);
    if (!target) {
      return;
    }

    [60, 160, 320].forEach((delay) => {
      window.setTimeout(() => injectCopyIntoNativeMenu(target.table), delay);
    });
  }

  async function handleNativeTreeDoubleClick(event) {
    const target = getNativeTableTargetFromEvent(event);
    if (!target) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    hideContextMenu();

    await copyText(target.table.title);
    const inserted = appendToSqlEditor(target.table.title, 'inline');
    showToast(inserted ? `已复制并插入表名：${target.table.title}` : `已复制表名：${target.table.title}`);
  }

  function getNativeTableTargetFromEvent(event) {
    if (!event.target.closest || event.target.closest(`.${PANEL_CLASS}`) || event.target.closest(`.${MENU_CLASS}`)) {
      return null;
    }

    const node = event.target.closest('.ant-tree-treenode');
    const tree = node && node.closest('.ant-tree');
    if (!node || !tree) {
      return null;
    }

    const root = getSearchRoot(tree);
    if (isSearchKeywordActive(root)) {
      return null;
    }

    const titleElement = node.querySelector('.ant-tree-title');
    const title = titleElement ? titleElement.textContent.trim() : '';
    const table = getTableFromNativeNode(node, title);
    if (!table) {
      return null;
    }

    return {
      node,
      root,
      table,
      tree,
    };
  }

  function getTableFromNativeNode(node, title) {
    if (!title) {
      return null;
    }

    const cached = getCachedTable(title);
    if (cached) {
      return cached;
    }

    if (!isLikelyTableLeaf(node)) {
      return null;
    }

    return {
      title,
      key: '',
      schema: '',
      sourceId: '',
      meta: 'Table',
    };
  }

  function injectCopyIntoNativeMenu(table) {
    const menu = findVisibleNativeMenu();
    if (!menu || menu.querySelector(`.${NATIVE_COPY_MENU_CLASS}`)) {
      return;
    }

    const firstItem = menu.querySelector('.ant-dropdown-menu-item, .ant-menu-item, [role="menuitem"]');
    const item = document.createElement(firstItem && firstItem.tagName === 'LI' ? 'li' : 'div');
    const className = firstItem && firstItem.className ? String(firstItem.className) : 'ant-dropdown-menu-item';

    item.className = className;
    item.classList.remove('ant-dropdown-menu-item-selected', 'ant-menu-item-selected');
    item.classList.add(NATIVE_COPY_MENU_CLASS);
    item.setAttribute('role', 'menuitem');
    item.tabIndex = -1;

    const label = document.createElement('span');
    label.textContent = '复制表名';
    item.replaceChildren(label);

    item.addEventListener('mousedown', (event) => event.preventDefault());
    item.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await copyText(table.title);
      showToast(`已复制表名：${table.title}`);
      closeNativeMenu();
    });

    menu.appendChild(item);
  }

  function findVisibleNativeMenu() {
    const menus = Array.from(document.querySelectorAll('.ant-dropdown-menu, .ant-menu[role="menu"], [role="menu"]'));
    return menus.reverse().find((menu) => {
      return !menu.closest(`.${MENU_CLASS}`) &&
        !menu.closest('.ant-select-dropdown') &&
        isVisible(menu);
    });
  }

  function closeNativeMenu() {
    document.body.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      view: window,
    }));
  }

  function getCachedTable(title) {
    const normalizedTitle = normalize(title);
    const latestCache = Array.from(tableCache.values())
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];

    if (latestCache) {
      const latestTable = latestCache.tables.find((table) => normalize(table.title) === normalizedTitle);
      if (latestTable) {
        return latestTable;
      }
    }

    for (const cache of tableCache.values()) {
      const table = cache.tables.find((item) => normalize(item.title) === normalizedTitle);
      if (table) {
        return table;
      }
    }

    return null;
  }

  function isLikelyTableLeaf(node) {
    if (!node) {
      return false;
    }

    if (node.querySelector('.ant-tree-switcher-noop')) {
      return true;
    }

    return !node.querySelector('.ant-tree-switcher_open, .ant-tree-switcher_close');
  }

  function isSearchKeywordActive(root) {
    const input = root && root.querySelector('.ant-input-search input.ant-input');
    return Boolean(input && input.value.trim());
  }

  async function runTableAction(root, table, action) {
    if (action === 'schema') {
      await runTableStructureAction(table);
      return;
    }

    const labels = action === 'data'
      ? ['查看表数据', 'Viewing Table Data']
      : ['查看表结构', 'Viewing Table Architecture'];
    const nativeActionDone = await triggerNativeContextMenuAction(root, table, labels);

    if (nativeActionDone) {
      return;
    }

    const sql = action === 'data'
      ? `SELECT * FROM ${getQualifiedTableName(table)} LIMIT 100;`
      : `SHOW CREATE TABLE ${getQualifiedTableName(table)};`;

    const inserted = appendToSqlEditor(sql, 'statement');
    showToast(inserted ? '原生菜单不可见，已插入等价 SQL' : '原生菜单不可见，未找到 SQL 编辑器');
  }

  async function runTableStructureAction(table) {
    const contextTable = hydrateTableContext(table);
    const sql = `SHOW CREATE TABLE ${getQualifiedTableName(contextTable)};`;
    const view = ensureTableStructureView(contextTable);

    if (!view) {
      const inserted = appendToSqlEditor(sql, 'statement');
      showToast(inserted ? '未找到“表数据查看”Tab，已插入查询表结构 SQL' : '未找到“表数据查看”Tab，且未找到 SQL 编辑器');
      return;
    }

    renderStructureLoading(view, sql);

    if (!contextTable.sourceId || !contextTable.schema) {
      renderStructureError(view, '缺少 source_id 或 schema，无法自动执行查询表结构 SQL。');
      return;
    }

    try {
      const result = await executeQuerySql(contextTable, sql);
      renderStructureResult(view, result);
    } catch (error) {
      const inserted = appendToSqlEditor(sql, 'statement');
      renderStructureError(
        view,
        error && error.message ? error.message : String(error),
        inserted ? '已把查询表结构 SQL 插入编辑器，可手动执行。' : ''
      );
    }
  }

  function hydrateTableContext(table) {
    const cached = getCachedTable(table.title);
    const latestCache = getLatestTableCache();
    const nextTable = {
      ...(cached || {}),
      ...table,
    };

    if (!nextTable.schema && latestCache) {
      nextTable.schema = latestCache.schema;
    }

    if (!nextTable.sourceId && latestCache) {
      nextTable.sourceId = latestCache.sourceId;
    }

    return nextTable;
  }

  function getLatestTableCache() {
    return Array.from(tableCache.values())
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] || null;
  }

  function ensureTableStructureView(table) {
    const dataTab = findTableDataTab();
    const tabsRoot = dataTab && dataTab.closest('.ant-tabs');
    if (!dataTab || !tabsRoot) {
      return null;
    }

    const navList = tabsRoot.querySelector('.ant-tabs-nav-list');
    const content = tabsRoot.querySelector('.ant-tabs-content');
    if (!navList || !content) {
      return null;
    }

    let tab = tabsRoot.querySelector(`.${STRUCTURE_TAB_CLASS}`);
    if (!tab) {
      tab = document.createElement('div');
      tab.className = `ant-tabs-tab ${STRUCTURE_TAB_CLASS}`;
      tab.setAttribute('data-node-key', 'ym-api-table-structure');

      const button = createElement('div', 'ant-tabs-tab-btn', '表结构查看');
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', 'false');
      tab.replaceChildren(button);
      navList.insertBefore(tab, dataTab.nextSibling);
    }

    let pane = tabsRoot.querySelector(`.${STRUCTURE_PANE_CLASS}`);
    if (!pane) {
      pane = document.createElement('div');
      pane.className = `ant-tabs-tabpane ${STRUCTURE_PANE_CLASS}`;
      pane.setAttribute('role', 'tabpanel');
      content.appendChild(pane);
    }

    tab.title = table.schema ? `${table.schema}.${table.title}` : table.title;
    activateTableStructureView(tabsRoot, tab, pane);
    return { tabsRoot, tab, pane };
  }

  function findTableDataTab() {
    const labels = ['表数据查看', 'Table Data View', 'Table Data'];
    return Array.from(document.querySelectorAll('.ant-tabs-tab')).find((tab) => {
      const text = normalizeText(tab.textContent);
      return isVisible(tab) && labels.some((label) => text.includes(label));
    });
  }

  function activateTableStructureView(tabsRoot, tab, pane) {
    tabsRoot.classList.add(STRUCTURE_ACTIVE_CLASS);
    tabsRoot.querySelectorAll('.ant-tabs-tab').forEach((item) => {
      item.classList.toggle('ant-tabs-tab-active', item === tab);
      const button = item.querySelector('[role="tab"], .ant-tabs-tab-btn');
      if (button) {
        button.setAttribute('aria-selected', item === tab ? 'true' : 'false');
      }
    });

    tabsRoot.querySelectorAll('.ant-tabs-tabpane').forEach((item) => {
      if (item === pane) {
        item.classList.add('ant-tabs-tabpane-active');
        item.style.display = '';
        return;
      }

      if (!item.classList.contains(STRUCTURE_PANE_CLASS)) {
        if (!Object.prototype.hasOwnProperty.call(item.dataset, 'ymStructureDisplay')) {
          item.dataset.ymStructureDisplay = item.style.display || '';
        }
        item.classList.remove('ant-tabs-tabpane-active');
        item.style.display = 'none';
      }
    });
  }

  function deactivateTableStructureView(tabsRoot) {
    if (!tabsRoot || !tabsRoot.classList.contains(STRUCTURE_ACTIVE_CLASS)) {
      return;
    }

    const tab = tabsRoot.querySelector(`.${STRUCTURE_TAB_CLASS}`);
    const pane = tabsRoot.querySelector(`.${STRUCTURE_PANE_CLASS}`);
    if (tab) {
      tab.classList.remove('ant-tabs-tab-active');
      const button = tab.querySelector('[role="tab"], .ant-tabs-tab-btn');
      if (button) {
        button.setAttribute('aria-selected', 'false');
      }
    }

    if (pane) {
      pane.classList.remove('ant-tabs-tabpane-active');
      pane.style.display = 'none';
    }

    tabsRoot.querySelectorAll('.ant-tabs-tabpane').forEach((item) => {
      if (item.classList.contains(STRUCTURE_PANE_CLASS)) {
        return;
      }

      item.style.display = item.dataset.ymStructureDisplay || '';
      delete item.dataset.ymStructureDisplay;
    });
    tabsRoot.classList.remove(STRUCTURE_ACTIVE_CLASS);
  }

  function handleStructureTabClick(event) {
    if (!event.target.closest) {
      return;
    }

    const structureTab = event.target.closest(`.${STRUCTURE_TAB_CLASS}`);
    if (structureTab) {
      const tabsRoot = structureTab.closest('.ant-tabs');
      const pane = tabsRoot && tabsRoot.querySelector(`.${STRUCTURE_PANE_CLASS}`);
      if (tabsRoot && pane) {
        event.preventDefault();
        event.stopPropagation();
        activateTableStructureView(tabsRoot, structureTab, pane);
      }
      return;
    }

    const nativeTab = event.target.closest('.ant-tabs-tab');
    if (nativeTab && !nativeTab.classList.contains(STRUCTURE_TAB_CLASS)) {
      deactivateTableStructureView(nativeTab.closest('.ant-tabs'));
    }
  }

  function renderStructureLoading(view, sql) {
    const sqlCard = createStructureCard('查询 SQL', createSqlCodeBlock(sql));
    const resultMessage = createElement('div', 'ym-api-table-structure-message ym-api-table-structure-result-body', '正在执行查询表结构 SQL...');
    const resultCard = createStructureCard('执行结果', resultMessage);

    view.pane.replaceChildren(sqlCard, resultCard);
  }

  function renderStructureResult(view, result) {
    const body = view.pane.querySelector('.ym-api-table-structure-result-body');
    if (!body) {
      return;
    }

    if (!result || typeof result !== 'object') {
      renderStructureError(view, '查询已返回，但结果格式无法识别。');
      return;
    }

    if (result && result.error) {
      renderStructureError(view, result.error);
      return;
    }

    if (result && result.status === true) {
      renderStructureError(view, '查询会话未开启或已过期，请重新申请查询权限后再试。');
      return;
    }

    const createTableSql = extractCreateTableSql(result);
    const fragment = document.createDocumentFragment();

    if (typeof result.query_time === 'number') {
      fragment.appendChild(createElement('div', 'ym-api-table-structure-meta', `执行耗时：${result.query_time} ms`));
    }

    if (createTableSql) {
      fragment.appendChild(createSqlCodeBlock(createTableSql));
    } else {
      fragment.appendChild(renderResultTable(result));
    }

    body.classList.remove('ym-api-table-structure-message');
    body.replaceChildren(fragment);
  }

  function renderStructureError(view, message, detail) {
    const body = view.pane.querySelector('.ym-api-table-structure-result-body');
    if (!body) {
      return;
    }

    const error = createElement('div', 'ym-api-table-structure-message ym-api-table-structure-error', message);
    if (detail) {
      const hint = createElement('div', 'ym-api-table-structure-message', detail);
      body.replaceChildren(error, hint);
      return;
    }

    body.replaceChildren(error);
  }

  function createStructureCard(title, body) {
    const card = document.createElement('div');
    card.className = 'ym-api-table-structure-card';
    const header = createElement('div', 'ym-api-table-structure-title', title);
    card.replaceChildren(header, body);
    return card;
  }

  function createSqlCodeBlock(sql) {
    const pre = document.createElement('pre');
    pre.className = 'ym-api-table-structure-code';
    pre.innerHTML = highlightMysql(sql);
    return pre;
  }

  function extractCreateTableSql(result) {
    const firstResult = result && Array.isArray(result.results) && result.results[0];
    const firstRow = firstResult && Array.isArray(firstResult.data) && firstResult.data[0];
    if (!firstRow) {
      return '';
    }

    const createKey = Object.keys(firstRow).find((key) => /create\s+table/i.test(key));
    if (createKey) {
      return String(firstRow[createKey] || '');
    }

    return Object.values(firstRow).find((value) => /create\s+table/i.test(String(value || ''))) || '';
  }

  function renderResultTable(result) {
    const firstResult = result && Array.isArray(result.results) && result.results[0];
    const fields = firstResult && Array.isArray(firstResult.field) ? firstResult.field : [];
    const rows = firstResult && Array.isArray(firstResult.data) ? firstResult.data : [];
    const columns = fields.map((field) => String(field.title || field.dataIndex || '')).filter(Boolean);

    if (columns.length === 0 || rows.length === 0) {
      return createElement('div', 'ym-api-table-structure-message', '查询已完成，但没有返回可展示的结果。');
    }

    const wrap = document.createElement('div');
    wrap.className = 'ym-api-table-structure-table-wrap';
    const table = document.createElement('table');
    table.className = 'ym-api-table-structure-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    columns.forEach((column) => {
      headRow.appendChild(createElement('th', '', column));
    });
    thead.appendChild(headRow);

    const tbody = document.createElement('tbody');
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      columns.forEach((column) => {
        const td = document.createElement('td');
        td.textContent = row[column] == null ? '' : String(row[column]);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    table.append(thead, tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function executeQuerySql(table, sql) {
    return new Promise((resolve, reject) => {
      const token = getAuthToken();
      if (!token) {
        reject(new Error('未捕获到 Yearning 查询 WebSocket Token，请刷新页面或先在当前查询窗口执行一次普通查询后再试。'));
        return;
      }

      let settled = false;
      const websocket = new WebSocket(buildQueryResultsWsUrl(table.sourceId), token);
      const timer = window.setTimeout(() => {
        settleQuery(false, new Error('查询表结构超时，请稍后重试。'));
      }, QUERY_TIMEOUT);

      websocket.binaryType = 'arraybuffer';
      websocket.addEventListener('open', () => {
        websocket.send(encodeMsgpack({
          type: 0,
          sql,
          schema: table.schema,
          source_id: table.sourceId,
        }));
      });

      websocket.addEventListener('message', async (event) => {
        try {
          const message = await decodeWebSocketMessage(event.data);
          if (message === 'pong' || (message && message.heartbeat)) {
            return;
          }

          settleQuery(true, message);
          websocket.close();
        } catch (error) {
          settleQuery(false, error);
          websocket.close();
        }
      });

      websocket.addEventListener('error', () => {
        settleQuery(false, new Error('查询 WebSocket 连接失败。'));
      });

      websocket.addEventListener('close', () => {
        if (!settled) {
          settleQuery(false, new Error('查询 WebSocket 已关闭，未收到结果。'));
        }
      });

      function settleQuery(success, value) {
        if (settled) {
          return;
        }

        settled = true;
        window.clearTimeout(timer);
        if (success) {
          resolve(value);
        } else {
          reject(value);
        }
      }
    });
  }

  function buildQueryResultsWsUrl(sourceId) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(QUERY_RESULTS_WS_PATH, `${protocol}//${window.location.host}`);
    url.searchParams.set('source_id', sourceId);
    return url.toString();
  }

  async function triggerNativeContextMenuAction(root, table, labels) {
    const tree = getTree(root);
    if (!tree) {
      return false;
    }

    const wasFiltering = tree.classList.contains(FILTERING_CLASS);
    tree.classList.remove(FILTERING_CLASS);

    const target = findNativeTableTarget(tree, table.title);
    if (!target) {
      if (wasFiltering) {
        tree.classList.add(FILTERING_CLASS);
      }
      return false;
    }

    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 2,
      buttons: 2,
      clientX: Math.max(0, rect.left + 12),
      clientY: Math.max(0, rect.top + 12),
    }));

    await wait(90);
    const menuItem = findNativeMenuItem(labels);
    if (!menuItem) {
      if (wasFiltering) {
        tree.classList.add(FILTERING_CLASS);
      }
      return false;
    }

    menuItem.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window,
    }));

    await wait(40);
    if (wasFiltering) {
      tree.classList.add(FILTERING_CLASS);
    }
    return true;
  }

  function findNativeTableTarget(tree, title) {
    const node = Array.from(tree.querySelectorAll('.ant-tree-treenode')).find((treeNode) => {
      const titleElement = treeNode.querySelector('.ant-tree-title');
      return titleElement && titleElement.textContent.trim() === title;
    });

    return node && node.querySelector('.ant-tree-node-content-wrapper');
  }

  function findNativeMenuItem(labels) {
    const labelSet = new Set(labels.map((label) => normalizeText(label)));
    const candidates = Array.from(document.querySelectorAll('.ant-dropdown-menu-item, .ant-menu-item, [role="menuitem"], li'));

    return candidates.find((element) => {
      if (element.closest(`.${MENU_CLASS}`) || !isVisible(element)) {
        return false;
      }

      return labelSet.has(normalizeText(element.textContent));
    });
  }

  function markActiveRow(row) {
    const panel = row.closest(`.${PANEL_CLASS}`);
    if (!panel) {
      return;
    }

    panel.querySelectorAll(`.${ROW_ACTIVE_CLASS}`).forEach((item) => {
      item.classList.remove(ROW_ACTIVE_CLASS);
    });
    row.classList.add(ROW_ACTIVE_CLASS);
  }

  function ensureContextMenu() {
    let menu = document.querySelector(`.${MENU_CLASS}`);
    if (!menu) {
      menu = document.createElement('div');
      menu.className = MENU_CLASS;
      document.body.appendChild(menu);
    }

    return menu;
  }

  function hideContextMenu() {
    const menu = document.querySelector(`.${MENU_CLASS}`);
    if (menu) {
      menu.style.display = 'none';
    }
  }

  function positionContextMenu(menu, clientX, clientY) {
    const gap = 4;
    const rect = menu.getBoundingClientRect();
    const left = Math.min(clientX, window.innerWidth - rect.width - gap);
    const top = Math.min(clientY, window.innerHeight - rect.height - gap);
    menu.style.left = `${Math.max(gap, left)}px`;
    menu.style.top = `${Math.max(gap, top)}px`;
  }

  function createMenuItem(label, action) {
    const item = createElement('div', MENU_ITEM_CLASS, label);
    item.addEventListener('mousedown', (event) => event.preventDefault());
    item.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideContextMenu();
      action();
    });
    return item;
  }

  function ensurePanel(root, searchWrapper) {
    let panel = root.querySelector(`.${PANEL_CLASS}`);
    if (!panel) {
      panel = document.createElement('div');
      panel.className = PANEL_CLASS;
      searchWrapper.insertAdjacentElement('afterend', panel);
    }

    return panel;
  }

  function removePanel(root) {
    const panel = root && root.querySelector(`.${PANEL_CLASS}`);
    if (panel) {
      panel.remove();
    }
  }

  function getMatchedGroups(keyword) {
    const normalizedKeyword = normalize(keyword);
    if (!normalizedKeyword) {
      return [];
    }

    return Array.from(tableCache.values())
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((cache) => ({
        ...cache,
        tables: cache.tables.filter((table) => {
          return normalize(table.title).includes(normalizedKeyword) ||
            normalize(table.key).includes(normalizedKeyword);
        }),
      }))
      .filter((cache) => cache.tables.length > 0);
  }

  function appendToSqlEditor(text, mode) {
    if (appendWithMonacoModel(text, mode)) {
      return true;
    }

    return appendWithFocusedEditor(text, mode);
  }

  function appendWithMonacoModel(text, mode) {
    const monaco = window.monaco;
    if (!monaco || !monaco.editor || typeof monaco.editor.getModels !== 'function') {
      return false;
    }

    const models = monaco.editor.getModels().filter((model) => {
      return model && typeof model.getValue === 'function' && !(typeof model.isDisposed === 'function' && model.isDisposed());
    });

    if (models.length === 0) {
      return false;
    }

    const model = chooseMonacoModel(models);
    const currentValue = model.getValue();
    const insertion = buildInsertion(currentValue, text, mode);

    if (monaco.Range && typeof model.pushEditOperations === 'function') {
      const lineNumber = model.getLineCount();
      const column = model.getLineMaxColumn(lineNumber);
      model.pushEditOperations([], [{
        range: new monaco.Range(lineNumber, column, lineNumber, column),
        text: insertion,
        forceMoveMarkers: true,
      }], () => null);
      return true;
    }

    if (typeof model.setValue === 'function') {
      model.setValue(currentValue + insertion);
      return true;
    }

    return false;
  }

  function chooseMonacoModel(models) {
    return models.find((model) => {
      return typeof model.getLanguageId === 'function' && /sql/i.test(model.getLanguageId());
    }) || models[0];
  }

  function appendWithFocusedEditor(text, mode) {
    const textarea = document.querySelector('.monaco-editor textarea.inputarea');
    if (!textarea) {
      return false;
    }

    textarea.focus();
    textarea.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'End',
      ctrlKey: true,
      key: 'End',
    }));

    const insertion = buildInsertion('', text, mode);
    return Boolean(document.execCommand && document.execCommand('insertText', false, insertion));
  }

  function buildInsertion(currentValue, text, mode) {
    if (!currentValue) {
      return text;
    }

    if (mode === 'statement') {
      return /\n\s*$/.test(currentValue) ? text : `\n${text}`;
    }

    return /\s$/.test(currentValue) ? text : ` ${text}`;
  }

  function getQualifiedTableName(table) {
    const key = String(table.key || '');
    if (/^`[^`]+`\.`[^`]+`$/.test(key)) {
      return key;
    }

    if (table.schema) {
      return `\`${escapeMysqlIdentifier(table.schema)}\`.\`${escapeMysqlIdentifier(table.title)}\``;
    }

    return `\`${escapeMysqlIdentifier(table.title)}\``;
  }

  function getActiveTreeSearchRoot() {
    const panels = Array.from(document.querySelectorAll('.ant-tabs-tabpane-active, [role="tabpanel"]:not([aria-hidden="true"])'));
    const activePanel = panels.find((panel) => {
      return panel.querySelector('.ant-input-search input.ant-input') && panel.querySelector('.ant-tree');
    });

    if (activePanel) {
      return activePanel;
    }

    const input = document.querySelector('.ant-input-search input.ant-input');
    return input ? getSearchRoot(input) : null;
  }

  function getSearchRoot(element) {
    return element.closest('[role="tabpanel"], .ant-tabs-tabpane, .ant-card-body') || document.body;
  }

  function getTree(element) {
    const root = getSearchRoot(element);
    return root.querySelector('.ant-tree');
  }

  function isTreeSearchInput(element) {
    return element instanceof HTMLInputElement &&
      Boolean(element.closest('.ant-input-search')) &&
      Boolean(getTree(element));
  }

  function isTablesApi(requestUrl) {
    if (!requestUrl) {
      return false;
    }

    try {
      const url = new URL(requestUrl, window.location.href);
      return url.pathname === TABLE_API_PATH || url.pathname.endsWith(TABLE_API_PATH);
    } catch (error) {
      return String(requestUrl).includes(TABLE_API_PATH);
    }
  }

  function parseTablesRequest(requestUrl) {
    try {
      const url = new URL(requestUrl, window.location.href);
      return {
        sourceId: url.searchParams.get('source_id') || '',
        schema: url.searchParams.get('schema') || '',
      };
    } catch (error) {
      return {
        sourceId: '',
        schema: '',
      };
    }
  }

  function inferSchema(tables) {
    const firstKey = tables && tables[0] && tables[0].key;
    const match = String(firstKey || '').match(/^`([^`]+)`\.`[^`]+`$/);
    return match ? match[1] : '';
  }

  function getRequestUrl(input) {
    if (typeof input === 'string') {
      return input;
    }

    if (input && typeof input.url === 'string') {
      return input.url;
    }

    return '';
  }

  function highlightKeyword(title, keyword) {
    const normalizedTitle = normalize(title);
    const normalizedKeyword = normalize(keyword);
    const index = normalizedTitle.indexOf(normalizedKeyword);

    if (index < 0) {
      return escapeHtml(title);
    }

    return `${escapeHtml(title.slice(0, index))}<mark>${escapeHtml(title.slice(index, index + keyword.length))}</mark>${escapeHtml(title.slice(index + keyword.length))}`;
  }

  function highlightMysql(sql) {
    const keywords = new Set([
      'add', 'alter', 'and', 'auto_increment', 'bigint', 'binary', 'bit', 'blob', 'boolean',
      'by', 'cascade', 'case', 'char', 'character', 'charset', 'check', 'collate', 'column',
      'comment', 'constraint', 'create', 'current_timestamp', 'database', 'datetime', 'decimal',
      'default', 'delete', 'desc', 'describe', 'double', 'drop', 'engine', 'enum', 'exists',
      'false', 'float', 'foreign', 'from', 'fulltext', 'if', 'index', 'insert', 'int', 'integer',
      'into', 'is', 'json', 'key', 'limit', 'longblob', 'longtext', 'mediumblob', 'mediumint',
      'mediumtext', 'not', 'null', 'on', 'or', 'primary', 'references', 'select', 'set', 'show',
      'smallint', 'table', 'text', 'time', 'timestamp', 'tinyblob', 'tinyint', 'tinytext', 'true',
      'unique', 'unsigned', 'update', 'use', 'values', 'varchar', 'where', 'zerofill',
    ]);
    const pattern = /(--[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|''|[^'])*'|"(?:\\.|""|[^"])*"|`(?:``|[^`])*`|\b\d+(?:\.\d+)?\b|\b[a-z_][a-z0-9_]*\b)/gi;
    let html = '';
    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(sql)) !== null) {
      html += escapeHtml(sql.slice(lastIndex, match.index));
      const token = match[0];
      const lowerToken = token.toLowerCase();
      if (token.startsWith('--') || token.startsWith('/*')) {
        html += `<span class="ym-sql-comment">${escapeHtml(token)}</span>`;
      } else if (token.startsWith("'") || token.startsWith('"') || token.startsWith('`')) {
        html += `<span class="ym-sql-string">${escapeHtml(token)}</span>`;
      } else if (/^\d/.test(token)) {
        html += `<span class="ym-sql-number">${escapeHtml(token)}</span>`;
      } else if (keywords.has(lowerToken)) {
        html += `<span class="ym-sql-keyword">${escapeHtml(token)}</span>`;
      } else {
        html += escapeHtml(token);
      }
      lastIndex = pattern.lastIndex;
    }

    return html + escapeHtml(sql.slice(lastIndex));
  }

  function rememberAuthHeaders(headers) {
    if (!headers) {
      return;
    }

    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      headers.forEach((value, name) => rememberAuthHeader(name, value));
      return;
    }

    if (Array.isArray(headers)) {
      headers.forEach((item) => {
        if (Array.isArray(item) && item.length >= 2) {
          rememberAuthHeader(item[0], item[1]);
        }
      });
      return;
    }

    Object.keys(headers).forEach((name) => rememberAuthHeader(name, headers[name]));
  }

  function rememberAuthHeader(name, value) {
    if (!/authorization|token/i.test(String(name || ''))) {
      return;
    }

    rememberAuthToken(value);
  }

  function rememberWebSocketProtocol(url, protocols) {
    if (!isQueryResultsWs(url)) {
      return;
    }

    if (Array.isArray(protocols)) {
      protocols.forEach(rememberAuthToken);
      return;
    }

    rememberAuthToken(protocols);
  }

  function rememberAuthToken(value) {
    const token = extractJwtToken(value);
    if (!token || authTokens.includes(token)) {
      return;
    }

    authTokens.unshift(token);
    if (authTokens.length > 8) {
      authTokens.length = 8;
    }
  }

  function getAuthToken() {
    const cachedToken = authTokens.find(Boolean);
    if (cachedToken) {
      return cachedToken;
    }

    scanStorageForAuthToken(window.localStorage);
    scanStorageForAuthToken(window.sessionStorage);
    scanCookiesForAuthToken();
    return authTokens.find(Boolean) || '';
  }

  function scanStorageForAuthToken(storage) {
    if (!storage) {
      return;
    }

    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        rememberAuthToken(storage.getItem(key));
      }
    } catch (error) {
      // 浏览器隐私策略可能禁止读取 storage，忽略后继续走已捕获 token。
    }
  }

  function scanCookiesForAuthToken() {
    String(document.cookie || '').split(';').forEach((item) => {
      const separatorIndex = item.indexOf('=');
      const value = separatorIndex >= 0 ? item.slice(separatorIndex + 1) : item;
      rememberAuthToken(value);
    });
  }

  function extractJwtToken(value) {
    if (!value) {
      return '';
    }

    let text = String(value).trim();
    try {
      text = decodeURIComponent(text).trim();
    } catch (error) {
      // storage/cookie 中可能存在非 URL 编码内容，直接按原文继续匹配 JWT。
    }
    const match = text.match(/(?:Bearer\s+)?([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i);
    return match ? match[1] : '';
  }

  function isQueryResultsWs(requestUrl) {
    if (!requestUrl) {
      return false;
    }

    try {
      const url = new URL(requestUrl, window.location.href);
      return url.pathname === QUERY_RESULTS_WS_PATH || url.pathname.endsWith(QUERY_RESULTS_WS_PATH);
    } catch (error) {
      return String(requestUrl).includes(QUERY_RESULTS_WS_PATH);
    }
  }

  async function decodeWebSocketMessage(data) {
    if (typeof data === 'string') {
      return data;
    }

    if (data instanceof Blob) {
      return decodeMsgpack(new Uint8Array(await data.arrayBuffer()));
    }

    if (data instanceof ArrayBuffer) {
      return decodeMsgpack(new Uint8Array(data));
    }

    if (ArrayBuffer.isView(data)) {
      return decodeMsgpack(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }

    return data;
  }

  function encodeMsgpack(value) {
    const bytes = [];
    encodeMsgpackValue(value, bytes);
    return new Uint8Array(bytes);
  }

  function encodeMsgpackValue(value, bytes) {
    if (value == null) {
      bytes.push(0xc0);
      return;
    }

    if (typeof value === 'boolean') {
      bytes.push(value ? 0xc3 : 0xc2);
      return;
    }

    if (typeof value === 'number') {
      encodeMsgpackNumber(value, bytes);
      return;
    }

    if (typeof value === 'string') {
      encodeMsgpackString(value, bytes);
      return;
    }

    if (Array.isArray(value)) {
      encodeMsgpackArray(value, bytes);
      return;
    }

    encodeMsgpackMap(value, bytes);
  }

  function encodeMsgpackNumber(value, bytes) {
    const integer = Math.trunc(value);
    if (integer >= 0 && integer <= 0x7f) {
      bytes.push(integer);
    } else if (integer >= 0 && integer <= 0xff) {
      bytes.push(0xcc, integer);
    } else if (integer >= 0 && integer <= 0xffff) {
      bytes.push(0xcd);
      pushUint16(bytes, integer);
    } else if (integer >= 0 && integer <= 0xffffffff) {
      bytes.push(0xce);
      pushUint32(bytes, integer);
    } else if (integer >= -32 && integer < 0) {
      bytes.push(0xe0 | (integer + 32));
    } else if (integer >= -128 && integer < 0) {
      bytes.push(0xd0, integer & 0xff);
    } else if (integer >= -32768 && integer < 0) {
      bytes.push(0xd1);
      pushUint16(bytes, integer & 0xffff);
    } else {
      bytes.push(0xd2);
      pushUint32(bytes, integer >>> 0);
    }
  }

  function encodeMsgpackString(value, bytes) {
    const encoded = textEncoder.encode(value);
    const length = encoded.length;
    if (length <= 31) {
      bytes.push(0xa0 | length);
    } else if (length <= 0xff) {
      bytes.push(0xd9, length);
    } else if (length <= 0xffff) {
      bytes.push(0xda);
      pushUint16(bytes, length);
    } else {
      bytes.push(0xdb);
      pushUint32(bytes, length);
    }

    encoded.forEach((byte) => bytes.push(byte));
  }

  function encodeMsgpackArray(value, bytes) {
    const length = value.length;
    if (length <= 15) {
      bytes.push(0x90 | length);
    } else if (length <= 0xffff) {
      bytes.push(0xdc);
      pushUint16(bytes, length);
    } else {
      bytes.push(0xdd);
      pushUint32(bytes, length);
    }

    value.forEach((item) => encodeMsgpackValue(item, bytes));
  }

  function encodeMsgpackMap(value, bytes) {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]);
    const length = entries.length;
    if (length <= 15) {
      bytes.push(0x80 | length);
    } else if (length <= 0xffff) {
      bytes.push(0xde);
      pushUint16(bytes, length);
    } else {
      bytes.push(0xdf);
      pushUint32(bytes, length);
    }

    entries.forEach(([key, item]) => {
      encodeMsgpackString(key, bytes);
      encodeMsgpackValue(item, bytes);
    });
  }

  function decodeMsgpack(bytes) {
    let offset = 0;

    function read() {
      const prefix = bytes[offset++];
      if (prefix <= 0x7f) {
        return prefix;
      }

      if (prefix >= 0x80 && prefix <= 0x8f) {
        return readMap(prefix & 0x0f);
      }

      if (prefix >= 0x90 && prefix <= 0x9f) {
        return readArray(prefix & 0x0f);
      }

      if (prefix >= 0xa0 && prefix <= 0xbf) {
        return readString(prefix & 0x1f);
      }

      if (prefix >= 0xe0) {
        return prefix - 0x100;
      }

      switch (prefix) {
        case 0xc0:
          return null;
        case 0xc2:
          return false;
        case 0xc3:
          return true;
        case 0xc4:
          return readBinary(readUint8());
        case 0xc5:
          return readBinary(readUint16());
        case 0xc6:
          return readBinary(readUint32());
        case 0xca:
          return readFloat32();
        case 0xcb:
          return readFloat64();
        case 0xcc:
          return readUint8();
        case 0xcd:
          return readUint16();
        case 0xce:
          return readUint32();
        case 0xcf:
          return readUint64();
        case 0xd0:
          return readInt8();
        case 0xd1:
          return readInt16();
        case 0xd2:
          return readInt32();
        case 0xd3:
          return readInt64();
        case 0xd9:
          return readString(readUint8());
        case 0xda:
          return readString(readUint16());
        case 0xdb:
          return readString(readUint32());
        case 0xdc:
          return readArray(readUint16());
        case 0xdd:
          return readArray(readUint32());
        case 0xde:
          return readMap(readUint16());
        case 0xdf:
          return readMap(readUint32());
        default:
          throw new Error(`暂不支持的 msgpack 类型：0x${prefix.toString(16)}`);
      }
    }

    function readUint8() {
      return bytes[offset++];
    }

    function readUint16() {
      const value = (bytes[offset] << 8) | bytes[offset + 1];
      offset += 2;
      return value;
    }

    function readUint32() {
      const value = ((bytes[offset] * 0x1000000) + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])) >>> 0;
      offset += 4;
      return value;
    }

    function readUint64() {
      const high = readUint32();
      const low = readUint32();
      const value = high * 0x100000000 + low;
      return Number.isSafeInteger(value) ? value : String(value);
    }

    function readInt8() {
      const value = readUint8();
      return value & 0x80 ? value - 0x100 : value;
    }

    function readInt16() {
      const value = readUint16();
      return value & 0x8000 ? value - 0x10000 : value;
    }

    function readInt32() {
      return readUint32() | 0;
    }

    function readInt64() {
      const high = readInt32();
      const low = readUint32();
      const value = high * 0x100000000 + low;
      return Number.isSafeInteger(value) ? value : String(value);
    }

    function readFloat32() {
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
      offset += 4;
      return view.getFloat32(0, false);
    }

    function readFloat64() {
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
      offset += 8;
      return view.getFloat64(0, false);
    }

    function readString(length) {
      const value = textDecoder.decode(bytes.slice(offset, offset + length));
      offset += length;
      return value;
    }

    function readBinary(length) {
      const value = bytes.slice(offset, offset + length);
      offset += length;
      return value;
    }

    function readArray(length) {
      const value = [];
      for (let index = 0; index < length; index += 1) {
        value.push(read());
      }
      return value;
    }

    function readMap(length) {
      const value = {};
      for (let index = 0; index < length; index += 1) {
        value[read()] = read();
      }
      return value;
    }

    return read();
  }

  function pushUint16(bytes, value) {
    bytes.push((value >>> 8) & 0xff, value & 0xff);
  }

  function pushUint32(bytes, value) {
    bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }

  async function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (error) {
        // HTTP 页面可能没有 Clipboard API 权限，继续走兼容复制。
      }
    }

    return fallbackCopyText(text);
  }

  function fallbackCopyText(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.left = '-9999px';
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.select();

    let copied = false;
    try {
      copied = Boolean(document.execCommand && document.execCommand('copy'));
    } finally {
      textarea.remove();
    }

    return copied;
  }

  function showToast(message) {
    let toast = document.querySelector(`.${TOAST_CLASS}`);
    if (!toast) {
      toast = document.createElement('div');
      toast.className = TOAST_CLASS;
      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.style.display = 'block';
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.style.display = 'none';
    }, 1800);
  }

  function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    element.className = className;
    element.textContent = text;
    return element;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => {
      const entities = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      };
      return entities[character];
    });
  }

  function escapeMysqlIdentifier(value) {
    return String(value).replace(/`/g, '``');
  }

  function normalize(value) {
    return String(value || '').trim().toLowerCase();
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function onReady(callback) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback, { once: true });
      return;
    }

    callback();
  }
})();
