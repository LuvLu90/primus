//! 主窗口首次出现的位置与大小（第 3 章“启动时窗口居中”）。
//!
//! 不用 tauri.conf.json 的 `center: true`：它总是按主显示器居中，且按逻辑像素给出位置，混合缩放的多显示器上
//! 会落到错误的显示器；窗口默认尺寸大于工作区时（如 1920×1080 @150% 只有约 1280×690 逻辑像素）居中位置为负，
//! 标题栏跑到屏幕外，看起来就“没居中”。这里在光标所在的显示器（取不到时为主显示器）的工作区内，
//! 按物理像素计算：首次打开时宽高各取工作区的 70%（不小于窗口最小尺寸），再居中。
//! 之后记住用户调整后的位置、大小与最大化状态（`window-state.json`），下次启动原样恢复；
//! 保存的位置已不在任何显示器上（拔掉外接屏、改了分辨率）时才回到首次打开的摆法。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// 工作区四周至少留出的逻辑像素（窗口缩小时）。
const MARGIN: f64 = 24.0;

/// 显示器工作区（物理像素）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WorkArea {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// 窗口外框（物理像素）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// 首次打开时窗口占工作区的比例：宽、高各 70%。
const FIRST_RUN_FRACTION: f64 = 0.7;
/// 判断保存的位置是否还看得见：标题栏这一条（逻辑像素高）至少要有这么宽、这么高落在某个工作区里。
const TITLE_STRIP: f64 = 32.0;
const VISIBLE_TITLE_W: f64 = 96.0;
const VISIBLE_TITLE_H: f64 = 16.0;

fn valid_scale(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

/// 首次打开：宽、高各为工作区的 70%（不小于最小尺寸），在工作区内居中。
pub(crate) fn first_run_bounds(area: WorkArea, scale: f64, min: (f64, f64)) -> Bounds {
    let scale = valid_scale(scale);
    let size = (
        f64::from(area.width) / scale * FIRST_RUN_FRACTION,
        f64::from(area.height) / scale * FIRST_RUN_FRACTION,
    );
    centered_bounds(area, scale, size, min)
}

/// 上次关闭时的窗口外框（物理像素，未最大化时的位置大小）与是否最大化。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SavedPlacement {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
}

/// 按保存的外框恢复：标题栏要有一段落在某个显示器（`(工作区, 缩放)`）的工作区里，否则返回 None（改用首次摆法）。
/// 尺寸夹在最小尺寸与该工作区之间，位置平移到工作区内，标题栏不出屏。
pub(crate) fn restore_bounds(
    saved: &SavedPlacement,
    monitors: &[(WorkArea, f64)],
    min: (f64, f64),
) -> Option<Bounds> {
    if saved.width == 0 || saved.height == 0 {
        return None;
    }
    let overlap = |a0: i64, a1: i64, b0: i64, b1: i64| (a1.min(b1) - a0.max(b0)).max(0);
    let (area, scale) = monitors.iter().copied().find(|(area, scale)| {
        let scale = valid_scale(*scale);
        let (x0, y0) = (i64::from(saved.x), i64::from(saved.y));
        let strip = (TITLE_STRIP * scale).round() as i64;
        let (ax0, ay0) = (i64::from(area.x), i64::from(area.y));
        let (ax1, ay1) = (ax0 + i64::from(area.width), ay0 + i64::from(area.height));
        let w = overlap(x0, x0 + i64::from(saved.width), ax0, ax1);
        let h = overlap(y0, y0 + strip, ay0, ay1);
        let need_w = (VISIBLE_TITLE_W * scale).min(f64::from(saved.width));
        w as f64 >= need_w && h as f64 >= VISIBLE_TITLE_H * scale
    })?;
    let scale = valid_scale(scale);
    let fit = |len: u32, min: f64, avail: u32| -> u32 {
        let min = (min * scale).round().max(1.0) as u32;
        // 工作区比最小尺寸还小时以最小尺寸为准（与首次摆法一致）
        len.min(avail.max(min)).max(min)
    };
    let width = fit(saved.width, min.0, area.width);
    let height = fit(saved.height, min.1, area.height);
    let clamp = |pos: i32, origin: i32, avail: u32, len: u32| -> i32 {
        let max = i64::from(origin) + (i64::from(avail) - i64::from(len)).max(0);
        i64::from(pos).clamp(i64::from(origin), max) as i32
    };
    Some(Bounds {
        x: clamp(saved.x, area.x, area.width, width),
        y: clamp(saved.y, area.y, area.height, height),
        width,
        height,
    })
}

/// 读取保存的窗口状态；文件不存在或损坏时返回 None。
pub(crate) fn load(path: &Path) -> Option<SavedPlacement> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// 记录主窗口的位置大小，关闭/退出时写入文件。
pub(crate) struct PlacementTracker {
    file: PathBuf,
    state: Mutex<Option<SavedPlacement>>,
}

impl PlacementTracker {
    pub(crate) fn new(file: PathBuf, initial: Option<SavedPlacement>) -> Self {
        Self {
            file,
            state: Mutex::new(initial),
        }
    }

    /// 窗口移动或改变大小后调用。最小化时不记（Windows 上位置是 -32000）；
    /// 最大化时只记“已最大化”，保留之前未最大化的外框，还原后仍回到那里。
    pub(crate) fn observe(&self, bounds: Bounds, maximized: bool, minimized: bool) {
        if minimized || bounds.width == 0 || bounds.height == 0 {
            return;
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match (state.as_mut(), maximized) {
            (Some(saved), true) => saved.maximized = true,
            (None, true) => {}
            (_, false) => {
                *state = Some(SavedPlacement {
                    x: bounds.x,
                    y: bounds.y,
                    width: bounds.width,
                    height: bounds.height,
                    maximized: false,
                });
            }
        }
    }

    /// 写入文件（先写临时文件再改名）；没有记录时不写。
    pub(crate) fn flush(&self) {
        let Some(saved) = *self.state.lock().unwrap_or_else(|e| e.into_inner()) else {
            return;
        };
        let Ok(json) = serde_json::to_string(&saved) else {
            return;
        };
        let tmp = self.file.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, json).and_then(|()| std::fs::rename(&tmp, &self.file))
        {
            eprintln!("保存窗口位置失败：{e}");
        }
    }
}

/// 在工作区内居中摆放：`size` 为默认逻辑尺寸，`min` 为最小逻辑尺寸，`scale` 为该显示器的缩放比例。
pub(crate) fn centered_bounds(
    area: WorkArea,
    scale: f64,
    size: (f64, f64),
    min: (f64, f64),
) -> Bounds {
    let scale = valid_scale(scale);
    let fit = |want: f64, min: f64, avail: u32| -> u32 {
        let want = (want * scale).round();
        let min = (min * scale).round();
        let room = (f64::from(avail) - 2.0 * MARGIN * scale).max(0.0).floor();
        // 放得下就用默认尺寸；放不下缩到工作区内，但不小于最小尺寸（最小尺寸本身放不下时以最小尺寸为准）
        want.min(room).max(min).max(1.0) as u32
    };
    let width = fit(size.0, min.0, area.width);
    let height = fit(size.1, min.1, area.height);
    let center = |origin: i32, avail: u32, len: u32| -> i32 {
        let offset = (i64::from(avail) - i64::from(len)) / 2;
        // 比工作区还大时贴住左/上边，标题栏不出屏
        (i64::from(origin) + offset.max(0)) as i32
    };
    Bounds {
        x: center(area.x, area.width, width),
        y: center(area.y, area.height, height),
        width,
        height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIZE: (f64, f64) = (1120.0, 720.0);
    const MIN: (f64, f64) = (396.0, 640.0);

    #[test]
    fn centers_default_size_when_it_fits() {
        let area = WorkArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        };
        let b = centered_bounds(area, 1.0, SIZE, MIN);
        assert_eq!(
            b,
            Bounds {
                x: 400,
                y: 160,
                width: 1120,
                height: 720
            }
        );
    }

    #[test]
    fn scales_to_physical_pixels() {
        let area = WorkArea {
            x: 0,
            y: 0,
            width: 3840,
            height: 2100,
        };
        let b = centered_bounds(area, 2.0, SIZE, MIN);
        assert_eq!((b.width, b.height), (2240, 1440));
        assert_eq!((b.x, b.y), (800, 330));
    }

    #[test]
    fn shrinks_into_small_work_area_but_not_below_min() {
        // 1920×1080 @150%，任务栏占去 72 物理像素：逻辑工作区约 1280×672
        let area = WorkArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1008,
        };
        let b = centered_bounds(area, 1.5, SIZE, MIN);
        assert_eq!(b.width, 1680);
        // 1008 − 2×36 = 936 < 1080，但最小高度 640×1.5 = 960 优先
        assert_eq!(b.height, 960);
        assert_eq!((b.x, b.y), (120, 24));
    }

    #[test]
    fn never_places_title_bar_above_work_area() {
        let area = WorkArea {
            x: 0,
            y: 40,
            width: 800,
            height: 600,
        };
        let b = centered_bounds(area, 1.0, SIZE, MIN);
        assert_eq!(b.height, 640);
        assert_eq!(b.y, 40);
        assert_eq!(b.width, 752);
        assert_eq!(b.x, 24);
    }

    #[test]
    fn respects_secondary_monitor_origin() {
        let area = WorkArea {
            x: -1920,
            y: -200,
            width: 1920,
            height: 1080,
        };
        let b = centered_bounds(area, 1.0, SIZE, MIN);
        assert_eq!((b.x, b.y), (-1920 + 400, -200 + 180));
    }

    #[test]
    fn invalid_scale_falls_back_to_one() {
        let area = WorkArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        assert_eq!(centered_bounds(area, 0.0, SIZE, MIN).width, 1120);
        assert_eq!(centered_bounds(area, f64::NAN, SIZE, MIN).width, 1120);
    }

    #[test]
    fn first_run_is_70_percent_of_work_area_centered() {
        let area = WorkArea {
            x: 0,
            y: 0,
            width: 2560,
            height: 1400,
        };
        let b = first_run_bounds(area, 1.0, MIN);
        assert_eq!(b.width, 1792);
        // 70% 高度 980 大于最小高度 640
        assert_eq!(b.height, 980);
        assert_eq!((b.x, b.y), (384, 210));
        // 缩放 2：物理像素仍是工作区的 70%
        let hi = first_run_bounds(
            WorkArea {
                x: 0,
                y: 0,
                width: 3840,
                height: 2100,
            },
            2.0,
            MIN,
        );
        assert_eq!((hi.width, hi.height), (2688, 1470));
    }

    #[test]
    fn first_run_never_below_min_size() {
        let area = WorkArea {
            x: 0,
            y: 0,
            width: 1366,
            height: 728,
        };
        let b = first_run_bounds(area, 1.0, (960.0, 640.0));
        // 70% 宽 956 小于最小宽 960，70% 高 510 小于最小高 640
        assert_eq!((b.width, b.height), (960, 640));
        assert_eq!(b.y, 44);
    }

    const MAIN: WorkArea = WorkArea {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };

    fn saved(x: i32, y: i32, width: u32, height: u32) -> SavedPlacement {
        SavedPlacement {
            x,
            y,
            width,
            height,
            maximized: false,
        }
    }

    #[test]
    fn restores_saved_bounds_on_visible_monitor() {
        let b = restore_bounds(&saved(100, 80, 1000, 700), &[(MAIN, 1.0)], MIN).unwrap();
        assert_eq!(
            b,
            Bounds {
                x: 100,
                y: 80,
                width: 1000,
                height: 700
            }
        );
    }

    #[test]
    fn ignores_bounds_on_missing_monitor() {
        // 保存时在左侧外接屏上，现在只剩主屏
        assert!(restore_bounds(&saved(-1500, 100, 1000, 700), &[(MAIN, 1.0)], MIN).is_none());
        // 标题栏在屏幕上方之外
        assert!(restore_bounds(&saved(100, -600, 1000, 700), &[(MAIN, 1.0)], MIN).is_none());
        assert!(restore_bounds(&saved(0, 0, 0, 700), &[(MAIN, 1.0)], MIN).is_none());
    }

    #[test]
    fn clamps_partly_offscreen_or_oversized_bounds_into_work_area() {
        let b = restore_bounds(&saved(1500, 500, 1000, 700), &[(MAIN, 1.0)], MIN).unwrap();
        assert_eq!((b.x, b.y), (920, 340));
        let big = restore_bounds(&saved(10, 10, 3000, 2000), &[(MAIN, 1.0)], MIN).unwrap();
        assert_eq!((big.x, big.y, big.width, big.height), (0, 0, 1920, 1040));
        let small = restore_bounds(&saved(10, 10, 200, 200), &[(MAIN, 1.0)], MIN).unwrap();
        assert_eq!((small.width, small.height), (396, 640));
    }

    #[test]
    fn picks_the_monitor_holding_the_title_bar() {
        let left = WorkArea {
            x: -2560,
            y: 0,
            width: 2560,
            height: 1400,
        };
        let b = restore_bounds(
            &saved(-2000, 100, 1200, 800),
            &[(MAIN, 1.0), (left, 1.5)],
            MIN,
        )
        .unwrap();
        assert_eq!((b.x, b.y, b.width, b.height), (-2000, 100, 1200, 960));
    }

    #[test]
    fn tracker_keeps_restored_bounds_while_maximized_and_skips_minimized() {
        let dir = std::env::temp_dir().join(format!("primus-wp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("window-state.json");
        let t = PlacementTracker::new(file.clone(), None);
        let b = |x, y| Bounds {
            x,
            y,
            width: 900,
            height: 700,
        };
        t.observe(b(10, 20), false, false);
        t.observe(b(0, 0), true, false);
        t.observe(b(-32000, -32000), false, true);
        t.flush();
        let s = load(&file).unwrap();
        assert_eq!((s.x, s.y, s.width, s.maximized), (10, 20, 900, true));
        t.observe(b(30, 40), false, false);
        t.flush();
        assert_eq!(load(&file).unwrap(), saved(30, 40, 900, 700));
        std::fs::write(&file, "not json").unwrap();
        assert!(load(&file).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
