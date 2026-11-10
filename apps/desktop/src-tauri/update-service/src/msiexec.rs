//! msiexec 命令行与退出码。服务只用固定的参数安装自己复制、验签过的安装包。

/// 静默安装参数：`/quiet` 无界面、`/norestart` 与 `REBOOT=ReallySuppress` 不重启；
/// `MSIRESTARTMANAGERCONTROL=Disable` 不让 Restart Manager 关闭其他会话里的程序（服务事先确认安装目录下没有进程在运行）；
/// `/l*v` 详细日志（每次覆盖）。两个路径都由服务生成，不含双引号。
pub fn install_params(package: &str, log: &str) -> String {
    format!(
        "/i \"{package}\" /quiet /norestart REBOOT=ReallySuppress MSIRESTARTMANAGERCONTROL=Disable /l*v \"{log}\""
    )
}

/// msiexec 退出码的含义。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// 0：成功
    Success,
    /// 3010 / 1641：成功，但部分文件要重启后才替换
    RebootRequired,
    /// 1618：另一个安装正在进行
    Busy,
    /// 1602：用户取消（静默安装中不应出现）
    Cancelled,
    /// 其他：失败
    Failed(u32),
}

impl Outcome {
    pub fn from_exit_code(code: u32) -> Self {
        match code {
            0 => Self::Success,
            3010 | 1641 => Self::RebootRequired,
            1618 => Self::Busy,
            1602 => Self::Cancelled,
            other => Self::Failed(other),
        }
    }

    pub fn installed(self) -> bool {
        matches!(self, Self::Success | Self::RebootRequired)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_are_fixed() {
        assert_eq!(
            install_params(
                r"C:\ProgramData\Primus\Update\package.msi",
                r"C:\ProgramData\Primus\Update\msiexec.log"
            ),
            r#"/i "C:\ProgramData\Primus\Update\package.msi" /quiet /norestart REBOOT=ReallySuppress MSIRESTARTMANAGERCONTROL=Disable /l*v "C:\ProgramData\Primus\Update\msiexec.log""#
        );
    }

    #[test]
    fn exit_codes() {
        assert_eq!(Outcome::from_exit_code(0), Outcome::Success);
        assert_eq!(Outcome::from_exit_code(3010), Outcome::RebootRequired);
        assert_eq!(Outcome::from_exit_code(1641), Outcome::RebootRequired);
        assert_eq!(Outcome::from_exit_code(1618), Outcome::Busy);
        assert_eq!(Outcome::from_exit_code(1602), Outcome::Cancelled);
        assert_eq!(Outcome::from_exit_code(1603), Outcome::Failed(1603));
        assert!(Outcome::Success.installed());
        assert!(Outcome::RebootRequired.installed());
        assert!(!Outcome::Busy.installed());
        assert!(!Outcome::Failed(1603).installed());
    }
}
