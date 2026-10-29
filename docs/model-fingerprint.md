# 当前 Chat 模型指纹检测

## 运行链路

Chat 右侧功能条顶部的圆形指纹按钮，首次单击先展示使用确认，说明费用、数字样本上传及结果限制；只有点击「确认并开始检测」才对当前绑定模型独立采样三次，**会产生模型 API 费用**。取消、按 Escape 或关闭确认窗口均不会启动采样。任务运行中再次点击只查看进度；「重新采样」也需再次确认，取消后保留原结果。

```text
GA-Hub 本机 → 通过 GA bridge 创建独立模型会话并采样
           → 仅发送提取后的数字到 Cloudflare
Cloudflare → 读取云端 KV 的参数库评分 → 返回参考库排名
```

- 模型 API 地址、Key、聊天历史、系统提示词和工具定义不发送给评分端。
- 不调用正在聊天的 Agent，不借用其会话标识，不修改当前聊天；不支持混合链路。
- 无自动重试；失败可能已消耗部分额度，关闭弹窗不会取消后台任务。
- 结果仅为参考库内统计相似度，不是身份鉴定。高排名也不代表覆盖库外模型，`evidence.insufficient` 仍可能为 true。
- 上游活跃会话达限时应等待释放，不得借用 Chat 绕限。

## 本地配置

默认评分地址：`https://fingerprint.lunadash.me`。

| 配置 | 含义 |
| --- | --- |
| `GA_FINGERPRINT_URL` | 可选，只允许 HTTPS |
| `GA_FINGERPRINT_TOKEN` | 可选，评分服务令牌，勿写入仓库或日志 |
| `GA_FINGERPRINT_TOKEN_FILE` | 可选，令牌文件路径；默认 `~/.genericagent-admin/fingerprint_token` |

令牌是评分服务专用令牌，与云端 `SCORING_TOKEN` 一致，**不是模型 API Key**。需要代理时配置 Hub 进程的正常 HTTPS 代理，不关闭 TLS 校验。

## 云端资源独立维护

本仓库不保存、下载或加载评分参数库、参考 bank、Worker 和评分算法，运行及桌面打包也不依赖这些资产。它们已迁至独立维护仓库 **GA-Hub-Fingerprint-Cloud**，本机位置为 `D:\study\GA-Hub-Fingerprint-Cloud`，同级检出约定为 `../GA-Hub-Fingerprint-Cloud/`；详见该仓库的 `README.md`、`assets-manifest.json` 和 `verify_assets.py`。

迁出来源：GA-Hub 提交 `a64990b` 下的 `deploy/model-fingerprint/`，独立仓库的初始迁入提交为 `8481a31`。迁出资产包括 64 模型的约 4.67 MB 参数库，内容逐字节保留并附 SHA-256；算法与上游 MIT 授权一起迁移。独立仓库目前只在本机保存，尚无远端备份。换机维护必须备份该仓库，不要把线上 KV 当作源码备份。

这只是维护边界调整，不更换线上 Worker、KV、域名、接口或令牌。旧 Git 提交中仍有原资产，本次不重写历史。

## 接口与验证

- 云端 `GET /health`：公开健康检查。
- 云端 `GET /v1/fingerprint/challenges`：Bearer 鉴权，生成 3 个挑战。
- 云端 `POST /v1/fingerprint/analyze`：Bearer 鉴权，发送恰好 3 份仅含数字的 `outputs`，返回评分。
- 本地 `POST /api/sessions/{session_id}/model-fingerprint`：必须传 `{"confirm_paid_sampling":true}`；GET 同路径 `/{job_id}` 查询。任务只驻留进程内，最多 50 项、24 小时，重启不恢复。

```sh
python -m pytest tests/test_model_fingerprint.py tests/test_ga_boundary_contract.py tests/test_repo_hygiene.py -q
```

本次仅迁移维护资源，无需重打包桌面或重启运行中的程序。未来修改前端需构建 `webui/dist`，修改冻结 sidecar 中的 Python 则需重新打包，不能用源码测试冒充桌面验收。
