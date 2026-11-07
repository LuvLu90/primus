//! 主窗口首次出现的位置与大小（第 3 章“启动时窗口居中”）。
//!
//! 不用 tauri.conf.json 的 `center: true`：它总是按主显示器居中，且按逻辑像素给出位置，混合缩放的多显示器上
//! 会落到错误的显示器；窗口默认尺寸大于工作区时（如 1920×1080 @150% 只有约 1280×690 逻辑像素）居中位置为负，
//! 标题栏跑到屏幕外，看起来就“没居中”。这里在光标所在的显示器（取不到时为主显示器）的工作区内，
//! 按物理像素计算：默认尺寸放不下就缩到工作区内（留边距，不小于窗口最小尺寸），再居中。
//! 目前没有记住窗口位置的功能，每次启动都按这里摆放。

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

/// 在工作区内居中摆放：`size` 为默认逻辑尺寸，`min` 为最小逻辑尺寸，`scale` 为该显示器的缩放比例。
pub(crate) fn centered_bounds(
    area: WorkArea,
    scale: f64,
    size: (f64, f64),
    min: (f64, f64),
) -> Bounds {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
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
}
