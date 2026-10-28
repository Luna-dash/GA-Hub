# 当前 Chat 模型指纹检测

## 链路与隐私边界

Chat 顶部「模型指纹」→ 明确确认费用 → GA-Hub 后端读取启动时的模型绑定 → 独立会话顺序采样 3 次 → 只将提取的数字与预期数量发送到 Cloudflare Worker → 返回参考库排名。

- 模型 API 地址、Key、聊天历史、系统提示词、工具定义不发送给评分端；凭据仅在运行 GA-Hub 的主机使用。
- 不调用正在聊天的 Agent，不借用其会话标识，不修改当前聊天。不支持混合链路。
- 无自动重试；失败可能已经消耗部分 API 额度。关闭弹窗不会取消后台任务。
- 结果为参考库内统计相似度，不是身份鉴定。参考库外模型也可能有高排名。
- 上游若限制活跃会话，独立采样可能被拒绝；应等待额度释放，而不是复用当前 Chat 绕过限制。

## 本地配置

默认评分地址：`https://fingerprint.lunadash.me`。

| 配置 | 含义 |
| --- | --- |
| `GA_FINGERPRINT_URL` | 可选，只允许 HTTPS |
| `GA_FINGERPRINT_TOKEN` | 可选，评分服务令牌，勿写入仓库或日志 |
| `GA_FINGERPRINT_TOKEN_FILE` | 可选，令牌文件路径；默认 `~/.genericagent-admin/fingerprint_token` |

令牌需与 Worker 的 `SCORING_TOKEN` 一致，它是评分服务专用令牌，**不是模型 API Key**。如本机网络需要代理，应给运行 Hub 的进程配置正常 HTTPS 代理；不要关闭 TLS 校验。

开发/浏览器模式：在仓库根目录运行 `python -m server.run`。前端改动需先运行 `cd webui && npm run build`。已冻结的桌面 sidecar 不会读取新的 Python 源文件；桌面版需要在用户退出运行中的桌面程序后执行仓库 `build_all.bat`，不能以源码测试代替桌面交付验证。

## Cloudflare 资产

- Worker：`ga-model-fingerprint`
- 公网入口：`fingerprint.lunadash.me`，经 EdgeOne HTTPS 回源
- Cloudflare 自定义源站域：`fingerprint.lunadash.cc.cd`，回源 Host 与其一致
- `DETECTOR`：KV namespace 绑定；二进制 key 固定为 `detector-v2`
- `SCORING_TOKEN`：Worker secret；本地只引用密钥管理器或令牌文件，不回显
- `RATE_LIMITER`：Workers Rate Limiting binding，必须保留

`worker.ts` 使用本目录 `bank.json` 与 `shared/`，运行时从 KV 读取 `detector.bin` 对应内容。更新参考库必须保持 bank、detector 和 shared 算法版本一致；不要把原项目全部采样数据上传 Worker。当前资产为 64 模型，detector 约 4.67 MB，非原项目约 1.84 GiB 的采样数据集。

更新时先打包 Worker 的 TypeScript 入口（JSON 和 shared 需被打包），使用 Cloudflare 管理入口部署 ES module，并保留上述 bindings；detector 更新写 KV 的 `detector-v2`。部署后分别验证源站及主域。CF/EdgeOne 管理凭据的获取遵循现有云管理 SOP，不在此复制。

## HTTP 契约

- `GET /health`：公开，返回服务状态、参考库版本和模型数。
- `GET /v1/fingerprint/challenges`：Bearer 鉴权，生成 3 个挑战。
- `POST /v1/fingerprint/analyze`：Bearer 鉴权，JSON `{"outputs":[{"text":"数字 空格 序列","expected_count":312}, ...]}`，恰好 3 项。
- 评分只接受数字/逗号/空白；预期数量范围 292–332；每项文本最多 16000 字符，总请求体最多 64 KiB。服务不接收任意模型请求或模型配置。
- 未鉴权返回 401，超限返回 429；响应 `Cache-Control: no-store`。勿记录 Authorization 或样本文本。

本地任务接口：`POST /api/sessions/{session_id}/model-fingerprint` 必须传 `{"confirm_paid_sampling":true}`；随后 GET 同路径 `/{job_id}` 查询。任务只驻留进程内，最多保留 50 项、24 小时；重启后不恢复。

## 验证与已知边界

```sh
python -m pytest tests/test_model_fingerprint.py -q
cd webui
npm run lint
```

2026-10-28：公网两个边缘节点均通过严格 TLS 的 `/health` 200；未鉴权 401、鉴权挑战 200（3 项）、合成数字评分 200。测试时用进程内 DNS 覆写绕过递归解析负缓存，未关闭证书校验。

首次真实采样曾返回 HTTP 422 `active_main_conversation_limit_exceeded`，已加入安全提示，不借用当前 Chat 会话绕限。2026-10-28 用户授权重测后，当前绑定 `gpt-6.1-sol` 经默认公网域名完成真实三次采样及评分，耗时约 183 秒；三份解析数字数量为 304/318/330，全部接受。参考库首位 `gpt-6-astra/6.1-sol`，库内闭集相对概率约 99.9821%；这不是模型身份真实性概率，返回的 evidence.insufficient 仍为 true（不涵盖库外模型）。证据见项目产物 `model-fingerprint/retest-real-result.json`。本次直接调用源码服务验证链路，界面入口与确认弹窗此前在隔离实例验收；未重新打包、替换或重启用户运行中的桌面程序。

## 上游授权

指纹算法与精简参考资产来自本次研究的 lm-detector；保留上游 MIT 授权于 `UPSTREAM-LICENSE`。共享算法源码随本目录保存，后续更新需同步许可证与算法/参考库兼容性。
