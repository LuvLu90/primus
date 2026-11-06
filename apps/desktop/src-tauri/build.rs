fn main() {
    // 自动更新公钥（技术方案第 3.6 节、ADR 0007）：发布构建从环境变量编译进 exe（updater.rs 的 option_env!），
    // 变化时重新编译；没有设置的构建（开发、PR）自动更新整体禁用
    println!("cargo:rerun-if-env-changed=TAURI_SIGNING_PUBLIC_KEY");
    tauri_build::build()
}
