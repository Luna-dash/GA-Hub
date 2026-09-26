// GA-Hub 构建红线：`npm run desktop:build` 已被有意禁用。
// 原因：绕过 sidecar 打包与产物守卫，裸 tauri build 会把产物落进
// host-target 非正式区（2026-08-22、2026-09-23 两次污染仓库）。
// 唯一入口 = build_all（详见 docs/BUILD.md「构建纪律与验收」）。
console.error("[GA-Hub] `npm run desktop:build` is intentionally disabled.");
console.error("[GA-Hub] 桌面构建唯一入口（single delivery entry）:");
console.error("  Windows  :  build_all.bat");
console.error("  macOS    :  build_all.command");
console.error("  any OS   :  python scripts/build_all.py [--full] [--target <triple>]");
console.error("[GA-Hub] 见 docs/BUILD.md。");
process.exit(1);
