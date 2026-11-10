//! 版本比较与 updater 签名校验（与 tauri-plugin-updater 同一套规则）。薄壳下载后、安装前与服务复制后都用它。

use std::cmp::Ordering;

use semver::Version;

/// 解析版本（允许前缀 `v`、两端空白）；不合法为 None。
pub fn parse_version(v: &str) -> Option<Version> {
    Version::parse(v.trim().trim_start_matches('v')).ok()
}

/// 版本优先级严格高于当前（SemVer，含预发布：`1.3.0-beta.2` < `1.3.0`；只差构建元数据的不算更新）。
/// 解析不了的版本一律不算更新。
pub fn is_newer(candidate: &str, current: &Version) -> bool {
    parse_version(candidate).is_some_and(|v| v.cmp_precedence(current) == Ordering::Greater)
}

/// 按 tauri-plugin-updater 的规则校验 updater 签名：公钥与签名都是 minisign 文本整体再 base64；
/// `verify(.., allow_legacy = true)` 与插件一致；签名的 trusted comment 必须绑定同一版本
/// （插件的 `requireSignedVersion`），防止用旧版本的合法安装包配上更高的版本号诱导降级。
pub fn verify_signature(
    data: &[u8],
    signature: &str,
    pubkey: &str,
    version: &str,
) -> Result<(), String> {
    use base64::Engine as _;
    let decode = |what: &str, value: &str| -> Result<String, String> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(value.trim())
            .map_err(|e| format!("{what}不是 base64：{e}"))?;
        String::from_utf8(bytes).map_err(|_| format!("{what}不是 UTF-8 文本"))
    };
    let key = minisign_verify::PublicKey::decode(&decode("公钥", pubkey)?)
        .map_err(|e| format!("公钥格式不对：{e}"))?;
    let sig = minisign_verify::Signature::decode(&decode("签名", signature)?)
        .map_err(|e| format!("签名格式不对：{e}"))?;
    key.verify(data, &sig, true)
        .map_err(|e| format!("签名与安装包不符：{e}"))?;
    // trusted comment 只有在上面的全局签名校验通过后才可信
    let signed = sig
        .trusted_comment()
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
        .ok_or("签名没有绑定版本")?;
    match (parse_version(signed), parse_version(version)) {
        (Some(a), Some(b)) if a == b => Ok(()),
        _ => Err(format!(
            "签名绑定的版本 {signed} 与待装版本 {version} 不一致"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // tauri signer 2.12 实际生成的公钥与签名（与 scripts/updater-signature.test.ts 相同的一次性测试密钥，私钥已丢弃）：
    // 对内容 "hello\n" 执行 tauri signer sign --app-version 1.2.3
    pub(crate) const TAURI_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDg5MUM5RTJDM0IzMEFCNzIKUldSeXF6QTdMSjRjaWRMejQ1Wi9vcGF3MS9GRTFJTE0wS3V6a0ZIUGljcWtmQUgwMVVuVW1rQzQK";
    pub(crate) const TAURI_SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSeXF6QTdMSjRjaWRhcW1GNFVHRHFUZHI3SHdMQU90a3hGaEFGUENlY1MyR0JZVjdEOUprb0dOTER5WTVqamw4Z0JxcHlzYXNVaWRWTytRUjhxWm9Nc2FBazcvQ2J1TWdnPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzNDUxMzgwCWZpbGU6aAl2ZXJzaW9uOjEuMi4zCkxORFRMdTVIREZaZThkaWpVdHkrUTk0N0RBVHljNll4SVc1V2lIWmRJanB6aDVGQndpZ3NaeGFjeVY4T0lWWTNEaHd5S1NvL3JyLzhCNFZwanJBS0NRPT0K";
    // 另一把随机生成的公钥（密钥 ID 不同）
    const OTHER_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkKUldRQkFnTUVCUVlIQ09qaVVtQSt6SnlBTFdFSmdBMngraGdObUVIay96Q3FOeDFNQVNzaUdpTlMK";
    const HELLO: &[u8] = b"hello\n";

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn verifies_real_tauri_signature_and_binds_version() {
        assert_eq!(
            verify_signature(HELLO, TAURI_SIG, TAURI_PUBKEY, "1.2.3"),
            Ok(())
        );
        assert_eq!(
            verify_signature(HELLO, TAURI_SIG, TAURI_PUBKEY, "v1.2.3"),
            Ok(())
        );
        assert!(verify_signature(b"hello!\n", TAURI_SIG, TAURI_PUBKEY, "1.2.3").is_err());
        let err = verify_signature(HELLO, TAURI_SIG, TAURI_PUBKEY, "1.2.4").unwrap_err();
        assert!(err.contains("1.2.3"), "{err}");
        assert!(verify_signature(HELLO, TAURI_SIG, OTHER_PUBKEY, "1.2.3").is_err());
        assert!(verify_signature(HELLO, "not base64!", TAURI_PUBKEY, "1.2.3").is_err());
        assert!(verify_signature(HELLO, TAURI_SIG, "", "1.2.3").is_err());
    }

    #[test]
    fn newer_follows_semver_with_prerelease() {
        let cur = v("1.3.0-beta.2");
        assert!(is_newer("1.3.0-beta.3", &cur));
        assert!(is_newer("1.3.0", &cur));
        assert!(is_newer("v1.3.0", &cur));
        assert!(!is_newer("1.3.0-beta.2", &cur));
        assert!(!is_newer("1.3.0-beta.2+build.7", &cur));
        assert!(!is_newer("1.3.0-alpha.9", &cur));
        assert!(!is_newer("1.2.9", &cur));
        assert!(!is_newer("garbage", &cur));
        assert!(!is_newer("1.3.0", &v("1.3.0")));
    }
}
