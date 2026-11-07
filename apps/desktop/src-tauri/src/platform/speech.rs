//! 语音输入（`speech_available` / `speech_start` / `speech_stop`）：只用操作系统自带的语音识别，
//! 不引入任何第三方语音 SDK 或云服务（约束 C1）。
//!
//! - Windows：`Windows.Media.SpeechRecognition` 的连续听写（`SpeechRecognizer` + `ContinuousRecognitionSession`）。
//!   识别语言为系统语音语言；系统“联机语音识别”隐私开关关闭时听写不可用，返回明确的错误。
//! - 其他平台：不可用（前端隐藏麦克风按钮）。
//!
//! 麦克风音量（波形）由前端 WebView 的 getUserMedia + AnalyserNode 计算，薄壳不推送音量。
//! 识别结果只经 Channel 推给前端，不落盘。

use serde::Serialize;

/// 推给前端的识别事件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum SpeechEvent {
    /// 识别中的临时文本（当前这一句，随时被替换）
    Interim { text: String },
    /// 定稿的一句
    Final { text: String },
    /// 识别出错（会话随后结束）
    Error { message: String },
    /// 会话结束（主动停止、超时或出错）
    End,
}

/// 事件回调（各平台在自己的线程里调用）。
pub(crate) type SpeechSink = std::sync::Arc<dyn Fn(SpeechEvent) + Send + Sync + 'static>;

#[cfg(windows)]
pub(crate) use windows_speech::Speech;

#[cfg(not(windows))]
pub(crate) use fallback_speech::Speech;

/// 识别会话结束的状态 → 给用户看的错误；正常结束（成功、用户取消）返回 `None`。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn completion_error(status: i32) -> Option<&'static str> {
    match status {
        // Success / UserCanceled
        0 | 5 => None,
        1 => Some("系统语音语言不支持听写，请在 Windows 设置中安装语音包"),
        4 => Some("音频质量太差，未能识别"),
        // TimeoutExceeded / PauseLimitExceeded：长时间没有说话，正常结束
        7 | 8 => None,
        9 => Some("联机语音识别连接失败，请检查网络"),
        10 => Some("麦克风不可用，请检查麦克风权限与设备"),
        _ => Some("语音识别意外结束"),
    }
}

/// 识别启动失败的 HRESULT → 给用户看的错误。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn start_error(hresult: i32, fallback: &str) -> String {
    // SPERR_SPEECH_PRIVACY_POLICY_NOT_ACCEPTED：系统“联机语音识别”未开启
    const PRIVACY_NOT_ACCEPTED: i32 = 0x8004_5509_u32 as i32;
    // 没有麦克风或麦克风权限被拒绝
    const ACCESS_DENIED: i32 = 0x8007_0005_u32 as i32;
    const NO_AUDIO_DEVICE: i32 = 0x8004_5510_u32 as i32;
    match hresult {
        PRIVACY_NOT_ACCEPTED => {
            "语音输入需要开启 Windows 的“联机语音识别”（设置 → 隐私和安全性 → 语音）".into()
        }
        ACCESS_DENIED => "没有麦克风权限（设置 → 隐私和安全性 → 麦克风）".into(),
        NO_AUDIO_DEVICE => "没有找到可用的麦克风".into(),
        _ => format!("语音识别启动失败：{fallback}"),
    }
}

#[cfg(windows)]
mod windows_speech {
    use std::sync::Mutex;
    use std::sync::mpsc;

    use windows::Foundation::TypedEventHandler;
    use windows::Media::SpeechRecognition::{
        SpeechContinuousRecognitionCompletedEventArgs,
        SpeechContinuousRecognitionResultGeneratedEventArgs, SpeechContinuousRecognitionSession,
        SpeechRecognitionHypothesisGeneratedEventArgs, SpeechRecognitionResultStatus,
        SpeechRecognizer,
    };
    use windows_sys::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};

    use super::{SpeechEvent, SpeechSink, completion_error, start_error};

    /// 当前识别会话：一个专用线程持有识别器，收到停止信号（或会话自行结束）后清理并退出。
    #[derive(Default)]
    pub(crate) struct Speech {
        stop: Mutex<Option<mpsc::Sender<()>>>,
    }

    impl Speech {
        /// 系统有可用的语音语言即视为可用（隐私开关等在启动时才知道，届时返回错误）。
        pub(crate) fn available(&self) -> bool {
            SpeechRecognizer::SystemSpeechLanguage().is_ok()
        }

        /// 开始连续听写；已有会话时先停止旧的。识别器启动失败时直接返回错误。
        pub(crate) fn start(&self, sink: SpeechSink) -> Result<(), String> {
            self.stop();
            let (stop_tx, stop_rx) = mpsc::channel::<()>();
            let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
            let completed_tx = stop_tx.clone();
            std::thread::Builder::new()
                .name("primus-speech".into())
                .spawn(move || {
                    // SAFETY: 本线程专用于语音会话，进入 MTA 后在线程结束前对应地 CoUninitialize。
                    let hr =
                        unsafe { CoInitializeEx(std::ptr::null(), COINIT_MULTITHREADED as u32) };
                    let session = run(&sink, completed_tx);
                    match session {
                        Ok((recognizer, session)) => {
                            let _ = ready_tx.send(Ok(()));
                            // 等待停止（前端停止或会话自行结束）
                            let _ = stop_rx.recv();
                            let _ = session.StopAsync().and_then(|op| op.join());
                            drop(session);
                            drop(recognizer);
                            sink(SpeechEvent::End);
                        }
                        Err(message) => {
                            let _ = ready_tx.send(Err(message));
                        }
                    }
                    if hr >= 0 {
                        // SAFETY: 与上面成功的 CoInitializeEx 配对。
                        unsafe { CoUninitialize() };
                    }
                })
                .map_err(|e| format!("语音识别启动失败：{e}"))?;
            // 先登记停止信号：启动期间收到的 speech_stop 不丢失（专用线程在报告启动成功后才等待它）
            *self.stop.lock().unwrap_or_else(|e| e.into_inner()) = Some(stop_tx);
            let result = ready_rx
                .recv()
                .unwrap_or_else(|_| Err("语音识别启动失败".into()));
            if result.is_err() {
                self.stop.lock().unwrap_or_else(|e| e.into_inner()).take();
            }
            result
        }

        /// 停止当前会话（没有会话时什么也不做）；最后会推送 `End`。
        pub(crate) fn stop(&self) {
            if let Some(tx) = self.stop.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = tx.send(());
            }
        }
    }

    /// 创建识别器、编译默认（听写）约束、挂上事件并开始连续识别。
    fn run(
        sink: &SpeechSink,
        completed: mpsc::Sender<()>,
    ) -> Result<(SpeechRecognizer, SpeechContinuousRecognitionSession), String> {
        let err = |e: windows::core::Error| start_error(e.code().0, &e.message());
        let recognizer = SpeechRecognizer::new().map_err(err)?;
        let compiled = recognizer
            .CompileConstraintsAsync()
            .and_then(|op| op.join())
            .map_err(err)?;
        let status = compiled.Status().map_err(err)?;
        if status != SpeechRecognitionResultStatus::Success {
            return Err(completion_error(status.0)
                .unwrap_or("语音识别启动失败")
                .to_string());
        }

        let interim = sink.clone();
        recognizer
            .HypothesisGenerated(&TypedEventHandler::<
                SpeechRecognizer,
                SpeechRecognitionHypothesisGeneratedEventArgs,
            >::new(move |_, args| {
                if let Some(args) = args.as_ref() {
                    let text = args.Hypothesis()?.Text()?.to_string_lossy();
                    interim(SpeechEvent::Interim { text });
                }
                Ok(())
            }))
            .map_err(err)?;

        let session = recognizer.ContinuousRecognitionSession().map_err(err)?;
        let finals = sink.clone();
        session
            .ResultGenerated(&TypedEventHandler::<
                SpeechContinuousRecognitionSession,
                SpeechContinuousRecognitionResultGeneratedEventArgs,
            >::new(move |_, args| {
                if let Some(args) = args.as_ref() {
                    let result = args.Result()?;
                    if result.Status()? == SpeechRecognitionResultStatus::Success {
                        let text = result.Text()?.to_string_lossy();
                        if !text.is_empty() {
                            finals(SpeechEvent::Final { text });
                        }
                    }
                }
                Ok(())
            }))
            .map_err(err)?;

        let done = sink.clone();
        session
            .Completed(&TypedEventHandler::<
                SpeechContinuousRecognitionSession,
                SpeechContinuousRecognitionCompletedEventArgs,
            >::new(move |_, args| {
                if let Some(args) = args.as_ref()
                    && let Some(message) = completion_error(args.Status()?.0)
                {
                    done(SpeechEvent::Error {
                        message: message.into(),
                    });
                }
                // 会话已结束：通知专用线程清理（重复发送无害）
                let _ = completed.send(());
                Ok(())
            }))
            .map_err(err)?;

        session.StartAsync().and_then(|op| op.join()).map_err(err)?;
        Ok((recognizer, session))
    }
}

#[cfg(not(windows))]
mod fallback_speech {
    use super::SpeechSink;

    /// 非 Windows：语音输入不可用。
    #[derive(Default)]
    pub(crate) struct Speech;

    impl Speech {
        pub(crate) fn available(&self) -> bool {
            false
        }

        pub(crate) fn start(&self, _sink: SpeechSink) -> Result<(), String> {
            Err("当前系统不支持语音输入".into())
        }

        pub(crate) fn stop(&self) {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_status_messages() {
        assert_eq!(completion_error(0), None);
        assert_eq!(completion_error(5), None);
        assert_eq!(completion_error(7), None);
        assert!(completion_error(10).unwrap().contains("麦克风"));
        assert!(completion_error(42).is_some());
    }

    #[test]
    fn start_error_maps_privacy_policy() {
        assert!(start_error(0x8004_5509_u32 as i32, "x").contains("联机语音识别"));
        assert_eq!(start_error(1, "boom"), "语音识别启动失败：boom");
    }

    #[test]
    fn events_serialize_with_type_tag() {
        let json = serde_json::to_string(&SpeechEvent::Interim {
            text: "你好".into(),
        })
        .unwrap();
        assert_eq!(json, r#"{"type":"interim","text":"你好"}"#);
        assert_eq!(
            serde_json::to_string(&SpeechEvent::End).unwrap(),
            r#"{"type":"end"}"#
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn unavailable_off_windows() {
        let speech = Speech;
        assert!(!speech.available());
        assert!(speech.start(std::sync::Arc::new(|_| {})).is_err());
        speech.stop();
    }
}
