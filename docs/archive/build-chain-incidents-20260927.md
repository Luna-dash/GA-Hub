# 构建链事故与探索记录（2026-08 ~ 2026-09）

这份文档收的是**规矩定下来之前**的探索过程：当时没有固定 rebuild 方案，遇到什么就
补什么，于是 `scripts/build_all.py` 里堆过一大批"事故篱笆"。方案收束之后，代码只保留
契约本身（唯一入口 / 退出码 / 三件产物守卫 / 预检 / 并发锁 / 失败体检），**理由与踩坑
过程全部搬到这里**——代码要简洁，知识不能丢。

- 当前契约与构建纪律：[`docs/BUILD.md`](../BUILD.md)
- 协作红线（agent 必读）：[`AGENTS.md`](../../AGENTS.md)
- 实现：`scripts/build_all.py`（唯一入口，CI 与本机同源）

判断标准：**一条篱笆只有在"今天仍可能发生、且后果不可接受"时才留在代码里**；只是
"历史上发生过"的，留在本文档。

---

## 1. 绕过入口裸跑 `tauri build` → 非正式区污染

- **症状**：`src-tauri/target/release/`（无 `--target` 的 host 落点）出现完整构建树，
  与应用真正使用的 `target/<triple>/release/` 并存。2026-08-22、2026-09-23 两次发生。
- **根因**：有人（含 agent）手拼 `tauri build` 或跑 `npm run desktop:build`，绕过
  sidecar 打包与产物守卫。
- **现在的处置**：唯一入口 + `npm run desktop:build` 改为拒绝式（exit 1 并指引入口）。
- **已删除的篱笆**：曾经在 `build_all.py` 预检里加过"非正式区残留告警"（比较构建前后
  mtime，后来改成"存在即告警"）。删除理由：绕过**只会发生在 build_all 不在场的时候**，
  那个事件永远等不到；而告警既不阻断，命中率也很低。防复发靠入口纪律 + 拒绝脚本，
  残留自查用：

  ```powershell
  Get-ChildItem src-tauri\target\release -Filter *.exe -ErrorAction SilentlyContinue
  ```

## 2. 产物守卫的「增量复用」启发式（2026-09-26 删除）

- **曾经的样子**：守卫会用 `_newest_input_mtime()`（一份手工维护的输入清单）判断
  "产物是否比所有输入都新"，认为"未刷新"可以是一次合法的增量复用，于是**警告放行**。
- **实测否证**：2026-09-26 冷/热各一次真实全链（114.0s / 93.2s），三件产物**每次都被
  重写**——vite 不做内容比对、每次都重写 `webui/dist`；tauri build script 对 dist 下
  **103 个文件**都发 `rerun-if-changed`，cargo 因此必然重链；sidecar 由
  `desktop/build_sidecar.py` 先 unlink 再打包。零改动热构建也重编 18.98s。
- **现在的处置**：守卫语义统一为「缺失 / 为空 / **未被本次构建重写** = 失败」，语义判据
  只有 mtime/size 快照。手工输入清单与两处放行分支都已删除。

## 3. 应用运行中构建 → Windows 映像文件锁

- **症状**（2026-09-27 冒烟实测）：应用在跑时构建，预检没拦住，一路跑到 Tauri 阶段才
  以 rc=3 失败（1.6s），报错来自链接器而不是构建脚本。
- **根因**：运行中的 `.exe` 被映像锁持有。**关键实测**：Python 对正在运行的映像做
  `open(path, "r+b")` 只抛 `PermissionError`，`errno=13`、**`winerror` 是 `None`**。
  曾经的实现按 `winerror in (32, 33)`（`ERROR_SHARING_VIOLATION`）判定 → **漏判**；
  而用伪造 `winerror=32` 的单测反而"通过"，给了假信心。
- **现在的处置**：`artifact_blocker()` —— 可写却被拒 = 被运行中的进程占用（提示先退出
  GA-Hub 含托盘/后台 sidecar）；只读属性同样报 EACCES，单独提示权限问题，不误导排查
  方向。单测用**另一个进程持真实独占句柄**复现，不再伪造错误码。
- **顺带验证**：应用关闭窗口后，`ga-hub-desktop` 与两个 `ga-hub-sidecar` 进程全部退出
  （生命周期管道 + kill-on-close job 生效），连测两次一致。

## 4. 并发构建互踩 `target`

- **处置**：`.build_all.lock`（Windows 用 `msvcrt.locking` 区域锁，POSIX 用
  `fcntl.flock`），持有者把 pid 写进锁文件便于排查，锁随进程退出释放。
- **踩过的坑**：`--full` 会在**持有构建锁**的情况下跑整个 `tests/`，而锁用例去抢同一把
  锁必然失败 → 发布前命令从来跑不通（实测 rc=3）。现在锁用例改用临时锁文件，另有一条
  用例单独锁住锁的**位置**。

## 5. 子进程 stdin 悬挂（2026-09-24 stdin 探针系列）

- **处置**：`run_stage` 一律 `stdin=subprocess.DEVNULL`。继承一个被上游悬挂读取的 stdin
  管道会让子进程静默卡死——这类问题排查成本极高，一行 DEVNULL 就够。
- **同源事故**：这台机器上 `std::process::Command::stdin(Stdio::piped())` 会以
  `ERROR_PIPE_BUSY`（os error 231）失败，桌面壳因此改成自己 `CreatePipe` 建生命线管道，
  详见 [`desktop-sidecar-spawn-pipe-busy-20260924.md`](desktop-sidecar-spawn-pipe-busy-20260924.md)。
  这条也解释了下面的 indexmap 事故为什么"偶发"。

## 6. 控制台编码（GBK/cp437）

- **症状**：`pytest -s` 直连控制台、或 GBK 控制台打印 ✓/✗/⚠ 时抛
  `UnicodeEncodeError: 'gbk' codec can't encode character '\u2717'`，把构建搞崩。
- **现在的处置**：模块级把 stdout/stderr `reconfigure(encoding="utf-8", errors="replace")`。
  放在模块级是因为 argparse 的 `--help`、以及把本模块当库调用（测试、排查脚本）都发生在
  `main()` 之前。
- **已删除的篱笆**：曾经还有第二层 `_log` 内的 `try/except UnicodeEncodeError` 降级。
  reconfigure 成功后那一层不可达，删掉。

## 7. 前端被构建两次（2026-09-27 删除 `beforeBuildCommand`）

- **症状**：`tauri.conf.json` 的 `beforeBuildCommand` 让 tauri 阶段每次都重跑
  `npm --prefix webui run build`（实测 ~9s）；更糟的是主 exe 与 sidecar 内嵌的可能是
  **两次不同构建**的前端产物。
- **现在的处置**：前端构建归 `build_all` 独占，`tauri.conf.json` 不再配
  `beforeBuildCommand`。**不要加回来。**

## 8. 每次强制产出安装包（已下线）

- **实测代价**：`--bundle` 每次额外产出 MSI 49.9MB + NSIS setup 48.8MB（合计 ~98.7MB），
  Tauri 阶段从 62.9s 变成 86.7s（+24s）。而 CI 不上传它们、文档也不当交付物。
- **现在的处置**：Tauri 阶段恒传 `--no-bundle`，`--bundle` 开关已删除（传了会 argparse
  报错 rc=2）。交付物就是便携版两个 exe。需要安装包时另行处理。

## 9. 指纹阶段（已删除）

- **曾经**：构建末尾打印三件产物的 `sha256` 前 16 位 + 大小 + mtime（30 行代码 + 一个阶段）。
- **删除理由**：文档自己都写明"同一份源码两次构建指纹不同"（exe 与 sidecar 都嵌入了
  构建期信息），所以它只能标识"这是哪一次构建"，不能用来判断两次构建是否一致；而任何
  时候都能用 `Get-FileHash` / `certutil -hashfile <file> SHA256` 现算。30 行 + 一个阶段
  换不来这个能力。

## 10. `E0107 struct takes 3 generic arguments`（indexmap / autocfg 探针静默失败）

**这是整份文档里最值得读的一条**：报错出现在 `schemars`，根因却在 `rustc` 探针。

- **链路**（manifest 层核对）：
  `tauri-build` / `tauri-utils` / `tauri-plugin` 2.x → `schemars 0.8.22`，其
  `preserve_order = ["indexmap"]` **只开 indexmap 的 `serde-1`，不开 `std`**；
  `indexmap 1.9.3` 的 `build.rs` 在 `CARGO_FEATURE_STD` 缺席时跑 autocfg 探针：

  ```rust
  match env::var_os("CARGO_FEATURE_STD") {
      Some(_) => autocfg::emit("has_std"),
      None => autocfg::new().emit_sysroot_crate("std"),
  }
  ```

- **为什么静默**：autocfg 探针 spawn `rustc -`，并把源码写进 **`Stdio::piped()`** 的
  stdin（`autocfg-1.5.1/src/lib.rs:327-331`）。探针失败**不报错**，只是不 emit
  `rustc-cfg=has_std`。本机正是 `Stdio::piped()` 的已知问题机器（见第 5 条 / os error 231），
  所以这条失败路径偶发。
- **后果**：没有 `has_std` → indexmap 编译成 no_std 形态（`IndexMap<K, V, S>` 没有默认
  类型参数）→ schemars 里 `IndexMap<K, V>` 的写法报
  `error[E0107]: struct takes 3 generic arguments but 2 generic arguments were supplied`
  `error: could not compile schemars (lib)`。
- **三段实验**（2026-09-27，`temp/dsh_review/indexmap_probe/`；复现用 `RUSTC_WRAPPER`
  强制探针失败）：

  | 场景 | 结果 |
  |---|---|
  | 无干扰，`clean indexmap` + 重建 ×5 | 5/5 `has_std=True`（探针当前正常，与"偶发"一致） |
  | 强制探针失败 | 复现上面两条报错 |
  | 强制探针失败 + 仓库修法 | 编译通过，且 indexmap build 输出为 `has_std=True` 且**无** `rustc-check-cfg` ⇒ 根本没起探针 |

- **现在的处置**：`src-tauri/Cargo.toml` 的 `[dependencies]` 与 `[build-dependencies]` 各留
  一处 `indexmap = { version = "1", features = ["std"] }`（仅用于 feature 统一，代码不直接
  调用）。显式开启 std 即走 `Some(_)` 分支、跳过探针，行为确定。**看起来像"没人引用的多余
  依赖"，但不能删。** 升到不依赖 schemars 0.8 的 tauri 版本后才可以删（indexmap 2.x 没有
  这个 build script 探针）。

## 11. 前端测试 flaky（`settle is not a function`）

- **症状**：`build_all.py --full` 在"刚跑完 50s pytest、机器繁忙"时红：
  `Conductor.test.tsx > speaks with one voice` 报 `TypeError: settle is not a function`。
  带上该文件单跑 55/55 通过、全量 vitest 连跑两次 514/514 通过 → 是竞态不是缺陷。
- **根因**：用例把"header 徽标显示启动中…"当作"bring-up 已发出"，但那个文案也可能来自
  状态轮询，此时 mock 工厂还没跑，`settle` 仍是 `undefined`。
- **处置**：结算前补 `await waitFor(() => expect(settle).toBeTypeOf('function'))`。

## 12. 脚本编码坑（写给后来者）

三条都是本仓库真实踩过的，和构建逻辑无关但同样烧时间：

1. **`.bat` 必须 ASCII**：cmd.exe 按 OEM 码页解析批处理，非 ASCII 字节在某些系统上会产生
   莫名的解析错误。`build_all.bat` 的注释全英文就是这个原因。
2. **PowerShell 脚本要么纯 ASCII、要么带 BOM**：`pwsh -File` 读 UTF-8 **无 BOM** 脚本时会
   按 ANSI/GBK 解码，中文注释会让它**解析失败**（本次排查时实验脚本就是这么挂的：
   报错行是乱码的中文注释）。
3. **`Get-Content` 默认按 ANSI 读**：直接看 UTF-8 的中文文件会显示乱码，**不代表文件坏了**；
   用 `Get-Content -Encoding UTF8` 或编辑器确认。

## 13. PyInstaller `--clean` 的实测（2026-09-27 决策：保留）

一度想删掉 `--clean` 省时间。单独跑 `desktop/build_sidecar.py` 实测：

| 场景 | 耗时 |
|---|---|
| 带 `--clean`（每次强制全量分析） | 35.0s / 34.5s |
| 不带 `--clean`（缓存命中：Analysis/PYZ/PKG 全过，只重写 exe） | **2.2s / 2.0s** |

看起来能省 33s。但真实链里**每轮都先重构建前端**，vite 每次重写 `webui/dist`
（内容哈希文件名不变、mtime 变），PyInstaller 因此每轮都判定输入变了：

```
1358 INFO: Building because D:\study\GA-Hub\webui\dist\assets\Autonomous-CF4kq9Bg.js changed
24083 INFO: Building because toc changed
```

连测两次真实全链：sidecar 阶段 36.2s / 32.4s——与带 `--clean` 的 32.4-35.0s **无差别**。
那 33s 只在"单独跑 sidecar、前面没有前端构建"时存在，真实链净收益 ≈ 0。于是**保留
`--clean`**：不引入环境指纹文件，也不承担"缓存过期产出旧依赖"的风险，而收益为零。

顺带记录两条相关事实：

- `build_sidecar.py` 里的 `built.unlink(missing_ok=True)` 才是"产物一定是本次的"那道保障
  ——它让 PyInstaller 每轮都重写 exe，守卫的"已重写"判定因此永远成立；`--clean` 管的是
  分析缓存的**正确性**，不是新鲜度。
- 也正是这层 mtime churn（vite 重写 dist → cargo 重链、PyInstaller 重分析），让"未被本次
  构建重写 = 失败"成为**不可能误报**的判据（见第 2 条）。

## 14. 未验证的部分（诚实口径）

- **平台**：只有 `x86_64-pc-windows-msvc` 端到端验证过。`--target` 可传别的 triple、
  `build_all.command` 也留着 macOS 入口，路径里的 `.exe` 后缀按 `"windows" in target`
  推断——**这些分支都未经实测**。要真正支持某个平台，得在那台机器上跑一遍 `--full`。
- **CI**：`.github/workflows/desktop-build.yml` 只调 `python scripts/build_all.py`
  （不带 `--full`），是**便捷构建通道、不是发布测试门**。原因是 `--full` 的后端测试需要
  GA 核心仓库（注入 `GA_ROOT`/`PYTHONPATH`），而云端 runner 没有它——预检会以 rc=2 挡下。
  发布前验证在本地做：`python scripts\build_all.py --full`。
- **安装包**：本链不产出 MSI/NSIS（见第 8 条）；若将来需要，属于单独一条打包流程。
