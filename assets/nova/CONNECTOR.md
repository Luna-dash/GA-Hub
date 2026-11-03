# Nova Windows 连接器

前提：本机已安装并打开 GA-Hub；Python 3.11+（加入 PATH）、Node.js LTS。

1. 完整解压 ZIP，保留 `nova` 与 `remote_access` 的相邻目录关系。
2. 双击 `nova/setup.cmd` 安装独立 Python 环境及依赖。
3. 双击 `nova/pair.cmd`，在 https://nova.lunadash.me/devices 登录并填写配对码。
4. 核对门户中显示的设备名称，输入 `YES` 确认远程操作授权。
5. 双击 `nova/run.cmd`，保持窗口与 GA-Hub 在线。关闭窗口即断开；重开会自动重连。

设备凭证保存在当前 Windows 用户的 Credential Manager；配置位于 `%LOCALAPPDATA%/GAHubNova/device.json`，不含设备令牌。一个 Windows 用户当前支持一个配对配置。重新配对前先在门户撤销旧设备。

不需要开放本机端口；只向云端发起 HTTPS/WSS 连接。云端中转可读流量，不是端到端加密。账号与设备授权具有本机 GA-Hub 的实际操作能力，仅给可信成员。连接中断后不自动重发指令；先刷新核对结果再决定重试。

下载包是源码连接器，不是免依赖安装器。不修改既有 GA-Hub 外联入口，不默认设置开机启动。

## Hub 内置组件与开发测试

Hub 内置组件由服务生命周期托管；在本机打开 `/nova` 完成配对后，随 Hub 启停。未配对时不主动建立远程连接。以上 `.cmd` 步骤用于独立源码连接器，不是内置组件的必需步骤。

云端服务与门户在独立的 `GA-Hub-Nova-Cloud` 仓库维护，本目录不保留云端副本。

`tests/test_nova_connector_e2e.py` 默认使用相邻的 `GA-Hub-Nova-Cloud` 检出目录；可通过 `NOVA_CLOUD_ROOT` 指定其他位置。未提供云端源码时，该集成测试明确跳过，本机组件测试仍可运行。
