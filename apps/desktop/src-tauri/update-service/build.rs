fn main() {
    // 服务用来验签的 updater 公钥与 Primus.exe 同源：发布构建从 TAURI_SIGNING_PUBLIC_KEY 编译进来（lib.rs 的 option_env!）。
    // 没有公钥的构建（开发、PR）拒绝一切安装请求
    println!("cargo:rerun-if-env-changed=TAURI_SIGNING_PUBLIC_KEY");
}
