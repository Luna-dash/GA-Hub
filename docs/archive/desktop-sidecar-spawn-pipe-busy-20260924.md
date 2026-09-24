# 桌面版启动失败排查报告：管道占用错误（`ERROR_PIPE_BUSY` / os error 231）

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-09-24 |
| 状态 | **已修复并端到端验证**（产物 `15:06:09`） |
| 严重度 | 高 —— 打包版**完全起不来后端**，但无任何报错 |
| 触发场景 | 从桌面快捷方式启动 GA-Hub（任何"经 Tauri 壳启动"的方式） |
| 不受影响 | 单独运行 `ga-hub-sidecar.exe` / `python -m server.desktop_sidecar`（不经壳） |
| 涉及文件 | `src-tauri/src/main.rs`、`src-tauri/Cargo.toml` |
| 性质 | **非本轮改动引入**，属环境条件性失败（见 §4.3） |

---

## 0. 一句话结论

壳（Tauri 桌面程序）在"拉起后端"这一步，因为**给后端接的那根管道拉不上**（Windows 报
`ERROR_PIPE_BUSY`＝"所有的管道范例都在使用中"）而直接失败；`CreateProcess` 根本没执行到，
所以后端进程从未存在过，界面只能干等。

修法：**不让 Rust 标准库去建这根管道，改成壳自己调 `CreatePipe` 建匿名管道**。

---

## 1. 通俗版：一根拉不上的电话线

壳和后端之间必须接一根**电话线**。这根线承担一个关键职责：**判断"主人还在不在"**——
后端靠它读"断线"信号，一旦壳退出（线断了）就自动下线，避免变成赖着不走的僵尸进程。

问题在于**怎么接这根线**，有两种接法：

| 接法 | 说明 | 本机结果 |
| --- | --- | --- |
| 让 Rust 标准库接（原方案 `Stdio::piped()`） | 要**先去系统里登记一个全局唯一的名字**才能接通（Windows 的"命名管道"） | ❌ 登记失败：`ERROR_PIPE_BUSY` |
| 自己动手私接（现方案 `CreatePipe`） | 在两个进程之间**私拉一根匿名线**，不占全局名字 | ✅ 一次成功 |

打个比方：前者像"必须先在电话局登记一个号码才能装机，号码占不上就装不了"；
后者像"两个人之间直接拉一根专线"。本机上偏偏卡在前者的登记环节。

**关键点是：这不是后端程序坏了。** 独立运行后端，11.1 秒就正常就绪——坏的是壳"接线的那个动作"。

---

## 2. 现象

启动打包版后观察到：

**看得到的**

- 桌面上 GA-Hub 窗口正常出现；
- 壳进程（`ga-hub-desktop.exe`）一直活着；
- 8765 调试桥在监听（说明壳自身运行正常）。

**看不到的**（这才是要命的）

- ❌ **没有任何 `ga-hub-sidecar.exe` 进程**（用 100ms 粒度轮询，连一闪而过的短命进程都没有）；
- ❌ `~/.genericagent-admin/logs/backend.log` 无任何新行；
- ❌ 壳的 stdout / stderr 全空；
- ❌ 前端界面上只有"后端未就绪"这类笼统提示。

也就是说：**除了"没反应"，得不到任何线索**。

---

## 3. 定位过程

### 3.1 前置动作：先让失败变得可见

打包版此前**启动失败 100% 不可观测**，三个原因叠加：

1. 壳是 **windows 子系统程序**（`#![windows_subsystem = "windows"]`），没有控制台，`println!` 无处可去；
2. 后端进程的 stdout / stderr 被显式设为丢弃（`Stdio::null()`）——**它连"我要启动了"都没机会说**；
3. 前端拿不到后端，只能笼统报一句"未就绪"。

因此第一步是在壳里加一处**常驻启动诊断** `record_startup_diagnostic()`
（`src-tauri/src/main.rs:730-739`），把关键节点与失败原因追加写到
`%TEMP%\gahub_desktop_shell.log`：

```rust
fn record_startup_diagnostic(message: &str) {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    let path = env::temp_dir().join("gahub_desktop_shell.log");
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "[{millis}] {message}");
    }
}
```

写入的节点：`setup: enter` → `setup: window ready, spawning supervisor for port N` →
`spawn_sidecar program=… args=[…]` → `sidecar ready on port N` / 失败原因。

> 这一步**是本次定位根因的唯一手段**。以前只能靠调试器，现在靠磁盘上的日志就能诊断。

### 3.2 拿到直接错误

日志第一行有价值的信息就把错误钉住了：

```text
[1790231041350] setup: enter
[1790231041351] setup: window ready, spawning supervisor for port 9158
[1790231350972] supervisor: spawn failed: sidecar spawn failed: 所有的管道范例都在使用中。 (os error 231)
```

`os error 231` = `ERROR_PIPE_BUSY`，抛自 `OwnedProcess::spawn()` 的
`command.spawn()`（`main.rs:413-415`），对应 `Command::stdin(Stdio::piped())` 那一行。

### 3.3 三分实验，把边界收敛到唯一一行

用一个一次性的 Rust 探针（`examples/spawnprobe.rs`，验证后已删除）逐项隔离变量，
结果非常干净：

| 变量 | 取值 | 结果 |
| --- | --- | --- |
| **stdin** | `piped` | ❌ **全部 FAIL(231)** |
| | `null` | ✅ OK |
| | `inherit` | ✅ OK |
| stdout / stderr | `piped` / `null` / `inherit` | 与成败**无关** |
| creation_flags | `CREATE_SUSPENDED`、`CREATE_NO_WINDOW` | 与成败**无关** |
| 是否在沙箱外运行 | 沙箱内 / 沙箱外 | **同样失败**（排除沙箱因素） |

**结论：只要用 `std::process::Command::stdin(Stdio::piped())` 就必然失败**，
与 Tauri 无关、与 Job Object 无关、与创建标志无关、与沙箱无关。

### 3.4 反证：同一台机器，换工具就正常

| 方式 | 底层调用 | 结果 |
| --- | --- | --- |
| Rust `Stdio::piped()` | std 自己的管道实现 | ❌ 231 |
| Python `subprocess.Popen(stdin=PIPE)` | `CreatePipe` | ✅ OK |
| ctypes 直接 `CreatePipe` + `CreateProcess` | `CreatePipe` | ✅ OK |
| 单独运行 sidecar 且不经壳 | —— | ✅ 11.1s 就绪 |

→ 说明 **Windows API 本身、机器资源、后端程序都没有问题**，
失败点在 **Rust 标准库建管道那条特定路径**上。

---

## 4. 根因

### 4.1 直接原因

`src-tauri/src/main.rs` 中壳启动后端的代码，用 `Stdio::piped()` 给子进程的 stdin 接管道
（这根管道是"父死子退"的生命线，08-18 引入的设计）：

```rust
command
    .args(["--host", "127.0.0.1", "--port", &port_arg, "--instance-token", token, "--owned-stdin"])
    .stdin(Stdio::piped())      // ← 这里失败
    .stdout(Stdio::null())
    .stderr(Stdio::null());
```

这一行失败 → 整个 `CreateProcess` 没有发生 → 后端从未被创建。

### 4.2 上游原因：std 用的是"命名管道"

在 Windows 上，std 为实现匿名管道（为支持 overlapped I/O），底层走的是
**`CreateNamedPipeW` 而不是 `CreatePipe`**。命名管道需要先在系统命名空间里占一个唯一名字，
当该名字"没有可用实例"时，Windows 就返回 `ERROR_PIPE_BUSY`(231)。

对照就很清楚：Python / ctypes 用的 `CreatePipe` 建的是**匿名管道**，不涉及全局名字，因此正常。

> 该机制依据 Rust std 的 Windows 管道实现与公开 issue 记录；本次未逐行核对本地 toolchain
> 内 std 源码版本，但 §3.3 / §3.4 的实验已足以把失败边界钉死在这一点上。

### 4.3 为什么会"现在才炸"——它不是新改动引入的

查 `git log -S` 追溯这段代码的来历：

| 内容 | 引入提交 | 日期 |
| --- | --- | --- |
| 壳用 `Stdio::piped()` 接 stdin | `e8936ed`（最近一次涉及） | 2026-08-17 |
| `--owned-stdin` 生命周期语义 | `09330ff` | 2026-08-18 |
| `take_owner_stdin()` 移交逻辑 | `62fe1b9` | 2026-08-18 |

**从 8 月中旬起就没再动过**，且 09-22 的冒烟测试里后端正**正常启动过**（当时观察到
端口 19284 / 59650 / 1858，`/api/setup/status` 返回 200）。

所以这是**条件性失败**：同一份代码，当机器"管道命名空间"的状态落到触发条件上时必然失败，
之前那次恰好没落到。**排查"打包版起不来"时，不要先怀疑当天的改动。**

### 4.4 尚未取到铁证的一环（诚实标注）

"这次具体是哪一个进程/哪一种状态占住了名字，以及 std 自身的重试为何最终仍返回 231"，
没有拿到现场证据——那要进 std 内部。但**修复不依赖这一环**：只要绕开命名管道即彻底规避。

---

## 5. 修复

### 5.1 采纳方案：壳自己建匿名管道

在 `src-tauri/src/main.rs:370-389` 新增 `owner_stdin_pipe()`：

```rust
fn owner_stdin_pipe() -> Result<(Stdio, OwnedHandle), String> {
    let mut child_end: HANDLE = std::ptr::null_mut();
    let mut owner_end: HANDLE = std::ptr::null_mut();
    let created = unsafe { CreatePipe(&mut child_end, &mut owner_end, std::ptr::null(), 0) };
    if created == 0 {
        return Err(format!("lifecycle CreatePipe failed: {}", std::io::Error::last_os_error()));
    }
    // 只有子进程那一端可继承；owner 端留在壳里，壳一死管道即关闭 → 后端读到断线自行退出。
    unsafe {
        SetHandleInformation(child_end, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        SetHandleInformation(owner_end, HANDLE_FLAG_INHERIT, 0);
    }
    let child_stdio = Stdio::from(unsafe { OwnedHandle::from_raw_handle(child_end as _) });
    let owner_handle = unsafe { OwnedHandle::from_raw_handle(owner_end as _) };
    Ok((child_stdio, owner_handle))
}
```

在 `OwnedProcess::spawn()` 中使用（`main.rs:406-411`）：

```rust
#[cfg(windows)]
let owner_stdin = {
    let (child_stdio, owner_handle) = owner_stdin_pipe()?;
    command.stdin(child_stdio);
    Some(owner_handle)
};
```

配套改动：

- `OwnedProcess` 新增字段 `owner_stdin: Option<OwnedHandle>`；
- `take_owner_stdin()` 改返回 `Option<Box<dyn Write + Send>>`
  （Windows 用 `File::from(handle)`；Unix 仍走 `ChildStdin`）；
- `Cargo.toml` 给 `windows-sys` 补 `Win32_System_Pipes` 特性（`CreatePipe` / `SetHandleInformation`）。

**核心思想**：匿名管道不进全局名字空间，**谁也抢不走、也不会"被占用"**，从原理上规避该错误。
而"父死子退"的生命线语义、句柄继承关系**完全保持不变**。

### 5.2 为什么不选另外两种省事改法

| 备选 | 做法 | 否决理由 |
| --- | --- | --- |
| A | 把 stdin 改成 `Stdio::null()` | 后端读不到断线信号，**丢失"父进程退出→后端自杀"的生命线语义**，会留下僵尸后端 |
| B | 把 stdin 改成 `Stdio::inherit()` | 后端会继承壳的 stdin，语义错误（可能被终端输入干扰），且"线"不再由壳独占 |
| C | **壳自己 `CreatePipe`（采纳）** | 既绕开命名管道，又完整保留原语义 |

---

## 6. 验证

| 验证项 | 结果 |
| --- | --- |
| 构建 | `python scripts/build_all.py` 154.3s；`ga-hub-desktop.exe` **15:06:09**、`ga-hub-sidecar.exe` **15:04:46** |
| 进包验收 | **7/7 通过**：前端 100=100、sha256 100/100、`index.html` 哈希 MATCH、6 个中文功能标记命中、6 个后端模块字节一致、壳内新标记 `lifecycle CreatePipe failed` 命中 |
| `_up_` 资源新鲜度 | 100 文件，`index.html` 哈希 == 当前 `webui/dist` |
| **启动冒烟** | ✅ **sidecar 12.1s 就绪（端口 48354）**（修复前：150s 内毫无动静） |
| GA 连接 | `/api/setup/status` 200 `configured:true` `ga_root:D:\study\GA` |
| 核心契约 | `/api/health/core-contract` 200 `ok:true` `core_commit cfb3f66` |
| 其它接口 | `/api/sessions` 200（total 30）；`/api/feishu/status` 200 |
| Rust 单元测试 | `cargo test` **14 passed / 0 failed** |
| 快捷方式 | `~/Desktop/GA-Hub.lnk` → `…\x86_64-pc-windows-msvc\release\ga-hub-desktop.exe`（15:06:09 新产物） |
| 清理 | 无残留 `ga-hub` 进程；一次性探针与临时脚本已删 |

---

## 7. 遗留与后续

1. **Unix 分支未受影响但仍是老写法**：`main.rs` 里 `#[cfg(unix)] command.stdin(Stdio::piped())`
   保留原样（Linux/macOS 无此问题）。若将来在其他平台复现同类错误，用同一套 `CreatePipe`
   思路处理即可。
2. **诊断日志入口应写进构建文档**：建议在 `docs/BUILD.md` 增加一条
   "打包版启动异常 → 先看 `%TEMP%\gahub_desktop_shell.log`"。
3. **启动诊断文件无轮转**：目前是追加写，长期运行会持续增长（当前量级极小，暂不处理；
   与飞书日志 `temp/feishuapp.log` 的轮转问题同类，可一并规划）。

---

## 8. 可复用的排查经验

1. **"程序起来了但没反应" 类问题，先建立可观测性，再谈定位。**
   本次若没有那行诊断日志，只能靠调试器逐点下断。
2. **打包版的静默失败是复合原因**：无控制台 + 子进程 stdio 被丢弃 + 前端提示笼统。
   三者任一存在都会显著抬高排查成本。
3. **用"变体隔离"快速收敛**：只改一个变量、跑一遍矩阵，比读代码猜要快得多。
   本次矩阵一轮就把范围锁到 `stdin=piped` 这一行。
4. **换工具做反证**：Rust 失败、Python/ctypes 成功，立刻把责任从"操作系统/机器"划到"特定实现路径"。
5. **追溯 `git log -S` 判断是否新引入**：本次证明代码 8 月就没动过，避免了误伤当天的改动。
6. **注意本机环境特性**：`cargo run --example` 走 dev profile 首次编译约 24 分钟
   （比 release 还慢）——排查这类问题应复用已编译的 example，或直接落文件再读输出。


---

## 9. 后续补记（同日）：匿名管道的"后代继承"副作用（已定位并修复）

壳改用 CreatePipe 后，这根匿名管道由 sidecar 的 desktop-owner-stdin 线程持挂起读取。修复前，sidecar 内的一次性子进程（飞书 check/save_keys/send_text 探针）若**继承**该管道，stdio 初始化同样阻塞：探针永不启动 → check 恒 25s 超时、子进程 CPU=0 僵死。

修复：生命线上任何一次性子进程显式 `stdin=DEVNULL`（已修 feishu 三处；与引擎侧 20ad092a 同因同修）。实验与证据：`FEISHU_STDIN_FINDING.md`；回归：`tests/test_feishu_service.py::test_check_send_save_pin_devnull_stdin`。
