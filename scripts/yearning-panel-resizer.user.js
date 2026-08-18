// ==UserScript==
// @name         Yearning 左右面板拖拽调整
// @namespace    https://yearning.io/
// @version      1.0.5
// @description  在 Yearning SQL 编辑页的左侧数据库树与右侧编辑区之间加入可拖拽分隔条。
// @author       codex
// @match        *://{IP}:{PORT}/*
// @license      MIT
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_KEY = 'yearning-panel-resize-ratio';
    const DEFAULT_RATIO = 4 / 24;
    const DIVIDER_CLASS = 'yearning-panel-resize-divider';
    const HISTORY_SQL_CLASS = 'yearning-history-sql-wrap';
    let activePanel = null;
    let installTimer = null;

    /**
     * 判断当前页面是否为 Yearning，避免通配匹配影响其他网站。
     *
     * @returns {boolean} 是否为 Yearning 页面。
     */
    function isYearningPage() {
        return document.title.trim().toLowerCase() === 'yearning';
    }

    /**
     * 在页面中查找左侧 ant-col-4 和右侧 ant-col-20 同级的目标行。
     *
     * @returns {{row: HTMLElement, left: HTMLElement, right: HTMLElement}|null} 目标面板；未找到时返回 null。
     */
    function findPanel() {
        const rows = document.querySelectorAll('.ant-row');

        for (const row of rows) {
            const left = row.querySelector(':scope > .ant-col.ant-col-4');
            const right = row.querySelector(':scope > .ant-col.ant-col-20');

            if (left && right) {
                return { row, left, right };
            }
        }

        return null;
    }

    /**
     * 转义 SQL 中的 HTML 特殊字符，避免 SQL 内容被当作页面标签执行。
     *
     * @param {string} value 待转义的文本。
     * @returns {string} 已转义的 HTML 文本。
     */
    function escapeHtml(value) {
        return value.replace(/[&<>"']/g, (character) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[character]));
    }

    /**
     * 对 SQL 进行轻量级语法高亮，不依赖外部脚本。
     *
     * @param {string} sql 完整 SQL。
     * @returns {string} 可安全写入 innerHTML 的高亮结果。
     */
    function highlightSql(sql) {
        const keywords = new Set([
            'ADD', 'ALL', 'ALTER', 'AND', 'AS', 'ASC', 'BETWEEN', 'BY', 'CASE', 'CREATE', 'CROSS', 'DATABASE',
            'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DROP', 'ELSE', 'END', 'EXISTS', 'FROM', 'FULL', 'GROUP',
            'HAVING', 'IN', 'INDEX', 'INNER', 'INSERT', 'INTO', 'IS', 'JOIN', 'LEFT', 'LIKE', 'LIMIT', 'NOT',
            'NULL', 'ON', 'OR', 'ORDER', 'OUTER', 'PRIMARY', 'RIGHT', 'SELECT', 'SET', 'TABLE', 'THEN', 'UNION',
            'UNIQUE', 'UPDATE', 'VALUES', 'WHEN', 'WHERE'
        ]);
        let index = 0;
        let html = '';

        while (index < sql.length) {
            const current = sql[index];
            const next = sql[index + 1];

            // 处理单行与多行注释，避免注释中的关键字被错误染色。
            if ((current === '-' && next === '-') || (current === '/' && next === '*')) {
                const isLineComment = current === '-';
                const endIndex = isLineComment ? sql.indexOf('\n', index) : sql.indexOf('*/', index + 2);
                const finish = endIndex === -1 ? sql.length : endIndex + (isLineComment ? 0 : 2);
                html += `<span class="yearning-sql-comment">${escapeHtml(sql.slice(index, finish))}</span>`;
                index = finish;
                continue;
            }

            // 保留字符串与反引号标识符的原始语义。
            if (current === "'" || current === '"' || current === '`') {
                const quote = current;
                let finish = index + 1;
                while (finish < sql.length) {
                    if (sql[finish] === quote) {
                        if (sql[finish + 1] === quote) {
                            finish += 2;
                            continue;
                        }
                        finish += 1;
                        break;
                    }
                    finish += 1;
                }
                const className = quote === '`' ? 'yearning-sql-identifier' : 'yearning-sql-string';
                html += `<span class="${className}">${escapeHtml(sql.slice(index, finish))}</span>`;
                index = finish;
                continue;
            }

            const word = sql.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*/)?.[0];
            if (word) {
                const className = keywords.has(word.toUpperCase()) ? 'yearning-sql-keyword' : '';
                html += className ? `<span class="${className}">${word}</span>` : escapeHtml(word);
                index += word.length;
                continue;
            }

            const number = sql.slice(index).match(/^\d+(?:\.\d+)?/)?.[0];
            if (number) {
                html += `<span class="yearning-sql-number">${number}</span>`;
                index += number.length;
                continue;
            }

            html += escapeHtml(current);
            index += 1;
        }

        return html;
    }

    /**
     * 为“历史记录”标签对应的面板增加长 SQL 自动换行样式标识。
     */
    function enableHistorySqlWrap() {
        const historyTab = [...document.querySelectorAll('[role="tab"]')]
            .find((item) => item.textContent?.trim() === '历史记录');
        const panelId = historyTab?.getAttribute('aria-controls');
        const historyPanel = panelId ? document.getElementById(panelId) : null;

        historyPanel?.classList.add(HISTORY_SQL_CLASS);
        historyPanel?.querySelectorAll('.paste[data-clipboard-text]').forEach((item) => {
            // Yearning 在列表文本中主动写入省略号，完整 SQL 实际保存在复制按钮的数据属性中。
            const fullSql = item.getAttribute('data-clipboard-text')?.trim();
            const sqlText = item.querySelector(':scope > span');
            if (fullSql && sqlText && sqlText.dataset.yearningSql !== fullSql) {
                sqlText.innerHTML = highlightSql(fullSql);
                sqlText.title = fullSql;
                sqlText.dataset.yearningSql = fullSql;
            }
        });
    }

    /**
     * 将比例限制在保证两侧仍可操作的范围内。
     *
     * @param {HTMLElement} row 两列所在的容器。
     * @param {number} ratio 左侧面板占容器的比例。
     * @returns {number} 限制后的比例。
     */
    function normalizeRatio(row, ratio) {
        const rowWidth = row.getBoundingClientRect().width;
        if (!rowWidth) {
            return DEFAULT_RATIO;
        }

        // 宽屏下至少给左右面板保留 220px 和 420px；窄屏按比例缩小下限。
        const minLeftRatio = Math.min(220, rowWidth * 0.25) / rowWidth;
        const maxLeftRatio = 1 - Math.min(420, rowWidth * 0.35) / rowWidth;
        return Math.min(Math.max(ratio, minLeftRatio), maxLeftRatio);
    }

    /**
     * 将左右两列改为指定的 flex 宽度，并同步分隔条位置。
     *
     * @param {{row: HTMLElement, left: HTMLElement, right: HTMLElement, divider: HTMLElement}} panel 面板信息。
     * @param {number} ratio 左侧面板占容器的比例。
     */
    function applyRatio(panel, ratio) {
        const normalizedRatio = normalizeRatio(panel.row, ratio);
        const leftPercent = normalizedRatio * 100;
        const rightPercent = 100 - leftPercent;

        panel.left.style.setProperty('flex', `0 0 ${leftPercent}%`, 'important');
        panel.left.style.setProperty('width', `${leftPercent}%`, 'important');
        panel.left.style.setProperty('max-width', `${leftPercent}%`, 'important');
        panel.right.style.setProperty('flex', `0 0 ${rightPercent}%`, 'important');
        panel.right.style.setProperty('width', `${rightPercent}%`, 'important');
        panel.right.style.setProperty('max-width', `${rightPercent}%`, 'important');
        panel.divider.style.left = `calc(${leftPercent}% - 5px)`;

        // Yearning 当前页面的右侧首层 div 写死了像素宽度，需同步改为自适应。
        const rightContent = panel.right.firstElementChild;
        if (rightContent instanceof HTMLElement) {
            rightContent.style.setProperty('width', '100%', 'important');
            rightContent.style.setProperty('max-width', '100%', 'important');
        }

        panel.ratio = normalizedRatio;
    }

    /**
     * 结束拖拽并让 Monaco 编辑器感知新的容器尺寸。
     *
     * @param {PointerEvent} event 指针事件。
     */
    function stopDragging(event) {
        if (!activePanel || event.pointerId !== activePanel.pointerId) {
            return;
        }

        activePanel.divider.classList.remove('yearning-panel-resize-divider--dragging');
        document.body.classList.remove('yearning-panel-resize-no-select');
        localStorage.setItem(STORAGE_KEY, String(activePanel.ratio));
        activePanel.divider.releasePointerCapture?.(event.pointerId);
        activePanel.pointerId = null;
        window.dispatchEvent(new Event('resize'));
    }

    /**
     * 安装面板分隔条。
     */
    function install() {
        if (!isYearningPage()) {
            return;
        }

        enableHistorySqlWrap();
        if (activePanel && activePanel.row.isConnected) {
            return;
        }

        const panel = findPanel();
        if (!panel || panel.row.querySelector(`:scope > .${DIVIDER_CLASS}`)) {
            return;
        }

        const divider = document.createElement('div');
        divider.className = DIVIDER_CLASS;
        divider.title = '拖动调整左右面板宽度；双击恢复默认宽度';
        divider.setAttribute('role', 'separator');
        divider.setAttribute('aria-orientation', 'vertical');
        panel.row.appendChild(divider);

        const savedRatio = Number.parseFloat(localStorage.getItem(STORAGE_KEY));
        activePanel = { ...panel, divider, ratio: Number.isFinite(savedRatio) ? savedRatio : DEFAULT_RATIO, pointerId: null };
        panel.row.classList.add('yearning-panel-resize-row');
        applyRatio(activePanel, activePanel.ratio);

        divider.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            activePanel.pointerId = event.pointerId;
            divider.setPointerCapture?.(event.pointerId);
            divider.classList.add('yearning-panel-resize-divider--dragging');
            document.body.classList.add('yearning-panel-resize-no-select');
        });

        divider.addEventListener('pointermove', (event) => {
            if (activePanel?.pointerId !== event.pointerId) {
                return;
            }

            const bounds = activePanel.row.getBoundingClientRect();
            applyRatio(activePanel, (event.clientX - bounds.left) / bounds.width);
        });

        divider.addEventListener('pointerup', stopDragging);
        divider.addEventListener('pointercancel', stopDragging);
        divider.addEventListener('dblclick', () => {
            applyRatio(activePanel, DEFAULT_RATIO);
            localStorage.removeItem(STORAGE_KEY);
            window.dispatchEvent(new Event('resize'));
        });
    }

    /**
     * 延迟重试安装，以适配 Vue 路由切换和异步渲染。
     */
    function scheduleInstall() {
        window.clearTimeout(installTimer);
        installTimer = window.setTimeout(install, 100);
    }

    const style = document.createElement('style');
    style.textContent = `
        .yearning-panel-resize-row { position: relative !important; }
        .${DIVIDER_CLASS} {
            position: absolute;
            z-index: 20;
            top: 0;
            bottom: 0;
            width: 10px;
            background: rgba(22, 119, 255, .06);
            border-left: 1px solid rgba(22, 119, 255, .22);
            border-right: 1px solid rgba(22, 119, 255, .22);
            cursor: col-resize;
            touch-action: none;
            transition: background-color .15s ease;
        }
        .${DIVIDER_CLASS}::before {
            position: absolute;
            top: 50%;
            left: -1px;
            width: 10px;
            height: 34px;
            border-radius: 5px;
            background: #1677ff;
            color: #fff;
            content: '⋮';
            font-size: 18px;
            font-weight: bold;
            line-height: 30px;
            text-align: center;
            transform: translateY(-50%);
        }
        .${DIVIDER_CLASS}::after {
            position: absolute;
            top: 0;
            bottom: 0;
            left: 4px;
            width: 2px;
            background: #1677ff;
            content: '';
            transition: background-color .15s ease;
        }
        .${DIVIDER_CLASS}:hover,
        .${DIVIDER_CLASS}--dragging {
            background: rgba(22, 119, 255, .16);
        }
        .${DIVIDER_CLASS}:hover::after,
        .${DIVIDER_CLASS}--dragging::after { background: #1677ff; }
        .yearning-panel-resize-no-select,
        .yearning-panel-resize-no-select * { user-select: none !important; }
        .${HISTORY_SQL_CLASS} .ant-list-item,
        .${HISTORY_SQL_CLASS} .ant-list-item-meta,
        .${HISTORY_SQL_CLASS} .ant-list-item-meta-content { min-width: 0 !important; }
        .${HISTORY_SQL_CLASS} .paste,
        .${HISTORY_SQL_CLASS} .paste > span { display: block !important; width: 100% !important; }
        .${HISTORY_SQL_CLASS} .ant-list-item :not(button) {
            overflow: visible !important;
            overflow-wrap: anywhere !important;
            text-overflow: clip !important;
            white-space: pre-wrap !important;
            word-break: break-word !important;
        }
        .${HISTORY_SQL_CLASS} .yearning-sql-keyword { color: #7c3aed; font-weight: 600; }
        .${HISTORY_SQL_CLASS} .yearning-sql-identifier { color: #0369a1; }
        .${HISTORY_SQL_CLASS} .yearning-sql-string { color: #b45309; }
        .${HISTORY_SQL_CLASS} .yearning-sql-number { color: #be123c; }
        .${HISTORY_SQL_CLASS} .yearning-sql-comment { color: #6b7280; font-style: italic; }
    `;
    document.head.appendChild(style);

    window.addEventListener('resize', () => {
        if (activePanel?.row.isConnected) {
            applyRatio(activePanel, activePanel.ratio);
        }
    });

    new MutationObserver(scheduleInstall).observe(document.documentElement, { childList: true, subtree: true });
    install();
})();
