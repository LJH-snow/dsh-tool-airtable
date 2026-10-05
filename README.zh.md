# dsh-tool-airtable

[English](README.md) | [中文](README.zh.md)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的 Airtable Cordis 插件。Agent 可以验证令牌、列出 base、限长查询记录，并执行显式的单用途记录创建/更新/删除——同时令牌和大体积单元格值不会进入工具输出。

## 安装

```sh
npm install @libai168/dsh-tool-airtable
```

需要 peer dependency：`@deepseek-ai/cordis`（^4.0.1）和 `@deepseek-ai/dsh-tools`（^0.1.0-rc.6）。

## 配置

```yaml
- name: 'github:LJH-snow/dsh-tool-airtable'
  config:
    # baseUrl: 'https://api.airtable.com/v0'
    tokenEnv: 'AIRTABLE_TOKEN'
    # timeoutMs: 15000
```

插件从 `tokenEnv` 指定的环境变量读取 Airtable 个人访问令牌（默认 `AIRTABLE_TOKEN`）。不要把可用令牌写入源码、示例、测试或提交的配置文件。在 Airtable 开发者中心创建令牌，只授予部署所需范围（读工具需 `data.records:read`，写工具需 `data.records:write`，列 base 需 `schema.bases:read`）。

## 工具

| 工具 | 说明 | 写操作 |
|---|---|---|
| `airtable_verify_token` | 通过 `meta/whoami` 验证令牌，不回显 | 否 |
| `airtable_list_bases` | 列出可访问的 base（offset 分页） | 否 |
| `airtable_list_records` | 查询记录，支持 `pageSize`/`maxRecords`/`offset` 和 `filterByFormula` | 否 |
| `airtable_get_record` | 读取单条记录的字段预览 | 否 |
| `airtable_create_records` | 从 JSON 数组创建最多 10 条记录 | 是 |
| `airtable_update_record` | PATCH 更新单条记录 | 是 |
| `airtable_delete_record` | 按 ID 删除单条记录 | 是 |

## 安全契约

- 令牌在插件启动时从环境变量读取，不进入工具返回值或渲染文本。
- base 与记录 ID 按官方 `app…`/`rec…` 17 字符格式校验，所有路径段 URL 编码；表名长度受限。
- 记录分页单页上限 50（`maxRecords` 上限 200），响应总量 20000 字符预算并带 `truncated` 标记；单元格值展平为 300 字符预览（含数组、关联记录、附件），空字段不输出。
- `airtable_create_records` 强制官方批量上限（单次 10 条），且不回显单元格值——结果只含数量与 ID；更新工具要求非空 fields 对象。
- 三个写工具均为显式参数操作并标记 `kind: 'edit'`；不提供表结构修改、base 创建或批量删除工具。
- 调用方取消信号会传递给 `fetch`，默认请求超时 15 秒。
- API 错误会规范化为 `{ ok: false, reason }` 或 `{ found: false, reason }`。

## API 范围

当前版本使用 developers.airtable.com 文档记载的 Web API 端点：`GET /v0/meta/whoami`、`GET /v0/meta/bases`，以及记录集合端点（`GET`、带 `records` 数组的 `POST`、单记录 `PATCH`/`DELETE`）。表结构列举、评论、webhook、base/表创建有意未包含。

## 开发

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

测试通过注入 fetch 完全离线运行，不需要 Airtable 账号。

## 许可证

[MIT](LICENSE)
