# MyKey 管理架构

## 职责与唯一入口

- `routes/mykey.py`：HTTP 请求/响应、线程投递和错误翻译，不直接编辑文件。
- `services/mykey_service.py`：文件生命周期、锁、备份、原子写入、运行时刷新，以及同步脚本适配。
- `services/mykey_codec.py`：纯文本/AST 解析、结构化投影和编辑，不访问运行中的 agent、不读写文件。
- WebUI：草稿、冲突提示、缓存失效和展示；不自行拼接配置修改来替代结构化操作。

结构化写入只经 `POST /api/mykey/mutation`，显式区分 create/update/rename/duplicate/delete/proxy。
raw 写入、结构化修改、备份恢复、同步下载最终共用 `_commit_text`：

```text
调用方持有 LlmRegistry.synchronized()
  → 语法校验 → 备份 → 原子替换 → 运行时刷新 → 统一结构化结果
```

同步下载先写独立暂存目录，脚本成功且产物存在后才进入公共提交链；失败不修改正式配置。
上传、连通性测试、打开编辑器不是配置写入，不强行纳入这条链。

## 编辑与引用不变量

- sessions/mixins/globals 是唯一投影；不再保留重复的单数 mixin 字段。
- rename 原位修改；duplicate 插到源后；目标变量冲突不覆盖。
- AST 定位和替换复用公共原语；不生成 WebUI 标记注释。
- 编辑前后按文件顺序建立槽位映射，统一修复 mixin 的整数索引和有效名称引用。
- 删除旧 upsert/delete 写路由及 service 兼容包装；session test 路由继续有效。
- OpenAPI 快照与前端生成类型同步更新；外部调用者须迁移至 mutate，不保留双实现。

## 边界

- 锁协调 Hub 内写入，不是跨进程文件锁；proxy 有 expected_raw 冲突检查，raw/恢复/同步属于显式整文件替换，不承诺全部操作均有 revision/CAS。
- 语法通过不代表每个配置均能初始化；热加载警告不自动回滚文件。
- 本轮不重写既有备份失败策略；备份失败可能返回空备份并继续写入，不承诺备份失败即终止。
- 不保证修改任意动态 Python 表达式时保持逐字符格式；raw 编辑仍用于非标准配置。

## 2026-10-12 验收

- 冷启动定向后端：111 passed。
- 后端全量：1223 passed、3 skipped、38 subtests passed；仅两条既存 repo_hygiene 失败（仓根过程产物和 .gitattributes 白名单）。
- 前端全量：73 文件、612 测试通过；lint、生产构建、API 生成/检查通过。
- 未读取真实密钥，未进行真实云端同步；未提交、推送或重建/替换桌面 exe。
- 代码快照：`D:/study/GA/temp/mykey_convergence_before`；回归日志：`D:/study/GA/temp/mk-convergence-{cold,full,web-full}.log`。
