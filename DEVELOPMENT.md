# dsh-tool-airtable 开发文档

## 1. 项目概览

| 项 | 内容 |
|---|---|
| 项目名 | `dsh-tool-airtable` |
| 定位 | DeepSeek Harness 的 Airtable 数据库插件 |
| 版本 | v0.1.0 |
| 架构 | Cordis 插件 + `ctx.tools.register(defineTool(...))` |
| API | Airtable Web API v0（契约核对自 developers.airtable.com 官方文档页） |
| 认证 | `Authorization: Bearer` 请求头，令牌从环境变量读取 |

### 1.1 目录

```text
src/client.ts        AirtableClient：fetch 注入、超时、AbortSignal、错误映射、值序列化与限长
src/index.ts         7 个 defineTool 定义与插件 apply
 tests/client.spec.ts 客户端认证、ID 校验、分页、序列化、限长、错误测试
 tests/tools.spec.ts  工具注册、render、写操作 kind 与端到端测试
examples/cordis.yml  dsh 组合配置示例
```

## 2. 技术决策

### 2.1 端点契约（2026-10 对照官方文档核对）

- `GET /v0/meta/whoami` → `{ id, email? }`（email 需 profile scope）。
- `GET /v0/meta/bases?offset=` → `{ bases: [{ id, name, permissionLevel }], offset }`。
- `GET /v0/{baseId}/{table}?pageSize=&maxRecords=&offset=&filterByFormula=` → `{ records: [{ id, createdTime, fields }], offset }`；官方 pageSize ≤100（本插件收紧到 50）。
- `POST /v0/{baseId}/{table}` `{ records: [{ fields }] }`；官方批量上限 10 条/请求，客户端强制。
- `PATCH /v0/{baseId}/{table}/{recordId}` `{ fields }`；`DELETE …/{recordId}` → `{ id, deleted }`。
- 错误体 `{ error: { type, message } }`，客户端优先取 `error.message`。

### 2.2 校验与限长

- baseId 强制 `app` + 14 位字母数字、recordId 强制 `rec` + 14 位；表名非空且 ≤200 字符；所有路径段 `encodeURIComponent`。
- 记录单页 50、maxRecords 200、filterByFormula 2000 字符；响应总量 20000 字符预算，超出置 `truncated`。
- 单元格值序列化：字符串截断 300；数组取前 5 项并标注剩余数量；关联记录/附件取 url/name/id；空字段不输出。
- 创建结果不回显单元格值（只返回数量），更新要求非空 fields。

### 2.3 工具范围

- 读：verify_token、list_bases、list_records、get_record。
- 写：create_records（≤10）、update_record、delete_record，均显式参数并标记 `kind: 'edit'`。
- 不做：表结构列举/修改、评论、webhook、base/表创建、批量删除。

## 3. 测试

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

测试使用注入 fetch 覆盖：Bearer 头与令牌不泄露、base/记录 ID 校验、pageSize/maxRecords 钳制与 filterByFormula 编码、字段序列化（数组/链接对象/空值）、响应总量截断、创建 payload 与不回显断言、批量上限、PATCH/DELETE 路径与谓词、错误体映射、工具注册、render、写操作 kind 与端到端执行。

## 4. 后续方向

- 增加表结构列举（meta/bases/{id}/tables，企业版能力，需探测可用性）。
- 增加 UPSERT（performance 形式）与 view 参数支持。
- 按 Airtable API 变化补充兼容性测试。
