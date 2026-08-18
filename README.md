# Yearning Tampermonkey Toolkit

一组用于增强 [Yearning](https://github.com/cookieY/Yearning) 使用体验的 Tampermonkey（油猴）用户脚本。

项目中的脚本彼此独立，可以按需安装，也可以同时启用。

## 脚本列表

| 脚本 | 英文名称 | 功能 | 额外说明 |
| --- | --- | --- | --- |
| [数据库表名搜索结果过滤](scripts/yearning-table-search-filter.user.js) | Yearning Table Search Filter | 缓存完整表列表，增强表名过滤，并提供复制表名、查看表数据和查看表结构等右键菜单 | 查看表数据时执行 `SELECT * ... LIMIT 100`；默认最多展示 200 行 |
| [左右面板拖拽调整](scripts/yearning-panel-resizer.user.js) | Yearning Panel Resizer | 在数据库树和 SQL 编辑区之间加入可拖拽分隔条 | 面板比例仅保存在当前站点的 `localStorage` |
| [SQL 变更行数检测](scripts/yearning-sql-change-row-counter.user.js) | Yearning SQL Change Row Counter | 将选中的或全部 `UPDATE`、`DELETE`、`INSERT INTO ... SELECT` 转换为只读统计查询，预估实际变更行数 | 依赖固定版本的 `@msgpack/msgpack` CDN 文件；不会执行原始 DML |
| [查询结果时间格式化](scripts/yearning-query-result-datetime-formatter.user.js) | Yearning Query Result Datetime Formatter | 将查询结果中的 JavaScript Date 字符串格式化为 `yyyy-MM-dd HH:mm:ss` | 无额外配置 |
| [查询结果视图切换](scripts/yearning-query-result-view-switcher.user.js) | Yearning Query Result View Switcher | 在网格视图和逐条表单视图之间切换，并显示字段 `COMMENT` | 通过 Yearning 同源接口读取字段注释 |

## 使用前必须修改的内容

为了避免公开真实的 Yearning 地址，仓库内所有脚本都使用 IP 和端口占位符：

```javascript
// @match        *://{IP}:{PORT}/*
```

使用前必须在每个脚本头部完成以下替换，否则脚本不会在实际 Yearning 站点运行：

- 将 `{IP}` 替换为 Yearning 服务器的真实 IP 或域名。
- 将 `{PORT}` 替换为 Yearning 服务的真实端口。

例如，Yearning 地址为 `http://192.0.2.10:8000` 时，应改为：

```javascript
// @match        http://192.0.2.10:8000/*
```

请尽量匹配准确的主机名和路径，不要使用 `*://*/*`。部分脚本需要监听页面的 `fetch`、XHR 或 WebSocket，过宽的规则会让脚本在无关网站运行。

如果 Yearning 使用标准的 `80` 或 `443` 端口，也可以删除端口占位符及其前面的冒号，例如 `https://yearning.company.example/*`。

除 `@match` 中的 `{IP}`、`{PORT}` 外，正常使用不需要填写数据库名、账号、密码、Token 或 API 地址。脚本使用当前浏览器已经登录的 Yearning 会话，并根据 `window.location.origin` 请求同源接口。

## 安装方法

1. 在浏览器中安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展。
2. 打开 Tampermonkey 管理面板，选择“添加新脚本”。
3. 打开本项目 `scripts/` 目录中需要安装的 `.user.js` 文件，复制完整内容到编辑器。
4. 按上一节将脚本头部的 `{IP}` 和 `{PORT}` 替换为实际值。
5. 保存脚本，刷新已经登录的 Yearning 页面。

项目上传到 GitHub 后，也可以打开脚本的 Raw 地址进行安装。Raw 地址格式为：

```text
https://raw.githubusercontent.com/<GitHub 用户名>/yearning-tampermonkey-toolkit/main/scripts/<脚本文件名>.user.js
```

## 可选调整

大多数使用者只需替换 `@match` 中的 `{IP}` 和 `{PORT}`。以下常量可以按实际需求调整：

| 脚本 | 英文名称 | 常量 | 默认值 | 用途 |
| --- | --- | --- | --- | --- |
| 数据库表名搜索结果过滤 | Yearning Table Search Filter | `MAX_ROWS` | `200` | 表数据查看的前端最大展示行数 |
| 数据库表名搜索结果过滤 | Yearning Table Search Filter | `QUERY_TIMEOUT` | `30000` | 查询超时时间，单位为毫秒 |
| 左右面板拖拽调整 | Yearning Panel Resizer | `DEFAULT_RATIO` | `4 / 24` | 首次使用时左侧面板的默认宽度比例 |
| SQL 变更行数检测 | Yearning SQL Change Row Counter | `QUERY_TIMEOUT` | `30000` | 统计查询超时时间，单位为毫秒 |

如果所在网络不能访问 `unpkg.com`，需要将 SQL 变更行数检测脚本的 `@require` 改为可信的内部镜像地址，并确保仍使用兼容的 `@msgpack/msgpack` 版本。

## 兼容性说明

这些脚本依赖 Yearning 当前页面结构和接口，包括 Ant Design 样式类、Monaco Editor 以及部分 `/api/v2/` 接口。Yearning 升级后如果页面 DOM、存储结构或接口协议发生变化，相关功能可能需要同步适配。

目前完成的是源码静态检查和 JavaScript 语法检查；不同 Yearning 版本、浏览器和权限组合仍需在实际环境中验证。

## 隐私与安全

- 仓库版本不包含真实 Yearning 地址、数据库连接、账号密码、固定 Token、真实库名或真实表名。
- 需要认证的功能只读取当前 Yearning 页面已有的登录信息，并将其用于同源 Yearning 请求。
- 脚本没有埋点、遥测或向第三方服务上传查询内容的逻辑。
- SQL 变更行数检测通过 `@require` 从 `unpkg.com` 加载固定版本的 MessagePack 依赖；介意第三方 CDN 时请使用经过审核的内部镜像。
- 不要把包含真实内网地址、Cookie、Token、查询结果或业务 SQL 的本地修改提交到公开仓库。

发现安全问题时，请参考 [SECURITY.md](SECURITY.md)，不要在公开 Issue 中粘贴秘密值或生产数据。

## 许可证

本项目使用 [MIT License](LICENSE)。
