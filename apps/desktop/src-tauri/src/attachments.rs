//! 输入框图片附件（`attachment_image`）：在内存中解码、按最长边缩小并重新编码，返回 base64 与缩略图。
//!
//! 只读取用户选中的文件，结果直接返回给前端，不写任何文件（约束 C2：缩略图与压缩结果只在内存里）。

use std::fs;
use std::io::{Cursor, Read};
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use image::metadata::Orientation;
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageFormat, ImageReader, Limits};
use serde::Serialize;

/// 输入文件大小上限。
pub(crate) const MAX_INPUT_BYTES: u64 = 20 * 1024 * 1024;
/// 解码后的像素上限（宽 × 高），防止小文件解压成超大位图。
const MAX_PIXELS: u64 = 100_000_000;
/// 允许的最长边范围；超出时夹到范围内。
const MIN_EDGE: u32 = 64;
const MAX_EDGE: u32 = 8192;
/// 缩略图短边（图块 56px，按 2 倍屏取整）。
const THUMB_EDGE: u32 = 112;
const JPEG_QUALITY: u8 = 85;
const THUMB_QUALITY: u8 = 80;

/// `attachment_image` 的返回值。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentImage {
    /// `image/png` 或 `image/jpeg`
    pub mime_type: String,
    /// 缩小后图片的 base64（不含 data: 前缀），直接放进 prompt 的 `images`
    pub data: String,
    /// 缩略图的 data URL（短边约 112px），只用于图块显示
    pub thumb: String,
    /// 缩小后的尺寸
    pub width: u32,
    pub height: u32,
}

/// 读取并处理图片；不是支持的图片格式、过大或解码失败时返回中文错误。
pub(crate) fn read_image(path: &Path, max_edge: u32) -> Result<AttachmentImage, String> {
    let meta = fs::metadata(path).map_err(|e| format!("无法读取文件：{e}"))?;
    if !meta.is_file() {
        return Err("不是文件".into());
    }
    if meta.len() > MAX_INPUT_BYTES {
        return Err(format!(
            "图片超过 {} MB，无法作为图片发送",
            MAX_INPUT_BYTES / 1024 / 1024
        ));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    fs::File::open(path)
        .and_then(|f| f.take(MAX_INPUT_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|e| format!("无法读取文件：{e}"))?;
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err(format!(
            "图片超过 {} MB，无法作为图片发送",
            MAX_INPUT_BYTES / 1024 / 1024
        ));
    }
    process(&bytes, max_edge)
}

/// 处理内存中的图片字节（单测直接调用）。
pub(crate) fn process(bytes: &[u8], max_edge: u32) -> Result<AttachmentImage, String> {
    let format = image::guess_format(bytes).map_err(|_| "不是支持的图片格式".to_string())?;
    if !matches!(
        format,
        ImageFormat::Png
            | ImageFormat::Jpeg
            | ImageFormat::Gif
            | ImageFormat::WebP
            | ImageFormat::Bmp
    ) {
        return Err("不是支持的图片格式".into());
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_PIXELS * 4);
    reader.limits(limits);
    let (w, h) = reader
        .into_dimensions()
        .map_err(|e| format!("图片无法解码：{e}"))?;
    if u64::from(w) * u64::from(h) > MAX_PIXELS {
        return Err("图片尺寸过大".into());
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_PIXELS * 4);
    reader.limits(limits);
    let decode_err = |e: image::ImageError| format!("图片无法解码：{e}");
    let mut decoder = reader.into_decoder().map_err(decode_err)?;
    // from_decoder 按 total_bytes 一次分配输出缓冲，不经过 Limits：16 位、浮点等格式每像素字节更多，先按同一预算拦下
    if decoder.total_bytes() > MAX_PIXELS * 4 {
        return Err("图片尺寸过大".into());
    }
    // 先按 EXIF 方向旋转 / 镜像：重新编码会丢掉 EXIF，不校正的话缩略图与发给模型的图片方向都会错
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder).map_err(decode_err)?;
    img.apply_orientation(orientation);

    let edge = max_edge.clamp(MIN_EDGE, MAX_EDGE);
    let img = fit_within(img, edge);
    // 有透明通道的保持 PNG（截图、图标），其余用 JPEG
    let keep_png = img.color().has_alpha() || format == ImageFormat::Png && !is_photo_like(&img);
    let (mime, data) = encode(&img, keep_png, JPEG_QUALITY)?;
    let thumb_img = thumbnail(&img, THUMB_EDGE);
    let (thumb_mime, thumb) = encode(&thumb_img, thumb_img.color().has_alpha(), THUMB_QUALITY)?;
    let (width, height) = img.dimensions();
    Ok(AttachmentImage {
        mime_type: mime.into(),
        data: STANDARD.encode(data),
        thumb: format!("data:{thumb_mime};base64,{}", STANDARD.encode(thumb)),
        width,
        height,
    })
}

/// 最长边超过 `edge` 时等比缩小；否则原样返回。
fn fit_within(img: DynamicImage, edge: u32) -> DynamicImage {
    let (w, h) = img.dimensions();
    if w.max(h) <= edge {
        return img;
    }
    // Triangle（双线性，核随缩放比例放大）：大幅缩小时质量足够，比 Lanczos 快数倍
    img.resize(edge, edge, image::imageops::FilterType::Triangle)
}

/// 缩略图：短边缩到 `edge`（图块按 cover 裁切显示），本身已更小时不放大。
fn thumbnail(img: &DynamicImage, edge: u32) -> DynamicImage {
    let (w, h) = img.dimensions();
    let short = w.min(h).max(1);
    if short <= edge {
        return img.clone();
    }
    let scale = f64::from(edge) / f64::from(short);
    let tw = ((f64::from(w) * scale).round() as u32).max(1);
    let th = ((f64::from(h) * scale).round() as u32).max(1);
    img.thumbnail_exact(tw, th)
}

/// 没有透明通道的 PNG：像素多（照片导出）时改用 JPEG，体积小得多；小图与截图保持 PNG 清晰度。
fn is_photo_like(img: &DynamicImage) -> bool {
    let (w, h) = img.dimensions();
    u64::from(w) * u64::from(h) > 1_500_000
}

fn encode(img: &DynamicImage, png: bool, quality: u8) -> Result<(&'static str, Vec<u8>), String> {
    let mut out = Cursor::new(Vec::new());
    if png {
        img.write_to(&mut out, ImageFormat::Png)
            .map_err(|e| format!("图片编码失败：{e}"))?;
        Ok(("image/png", out.into_inner()))
    } else {
        let rgb = DynamicImage::ImageRgb8(img.to_rgb8());
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality);
        rgb.write_with_encoder(encoder)
            .map_err(|e| format!("图片编码失败：{e}"))?;
        Ok(("image/jpeg", out.into_inner()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage, Rgba, RgbaImage};

    fn png_bytes(img: DynamicImage) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        img.write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    }

    fn jpeg_bytes(w: u32, h: u32) -> Vec<u8> {
        let img = RgbImage::from_fn(w, h, |x, y| Rgb([(x % 256) as u8, (y % 256) as u8, 128]));
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(img)
            .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
                &mut out, 90,
            ))
            .unwrap();
        out.into_inner()
    }

    fn decode_b64(data: &str) -> DynamicImage {
        image::load_from_memory(&STANDARD.decode(data).unwrap()).unwrap()
    }

    #[test]
    fn downscales_to_max_edge_and_keeps_aspect() {
        let out = process(&jpeg_bytes(1200, 600), 512).unwrap();
        assert_eq!(out.mime_type, "image/jpeg");
        assert_eq!((out.width, out.height), (512, 256));
        assert_eq!(decode_b64(&out.data).dimensions(), (512, 256));
        assert!(out.thumb.starts_with("data:image/jpeg;base64,"));
        let thumb = decode_b64(out.thumb.split_once(',').unwrap().1);
        assert_eq!(thumb.dimensions().1, THUMB_EDGE);
    }

    #[test]
    fn exif_orientation_is_applied_before_resizing() {
        use image::ImageEncoder as _;
        // 小端 TIFF 头 + 一个 IFD 项：Orientation(0x0112) = 6（顺时针转 90°）
        let exif = b"II*\x00\x08\x00\x00\x00\x01\x00\x12\x01\x03\x00\x01\x00\x00\x00\x06\x00\x00\x00\x00\x00\x00\x00".to_vec();
        let img = RgbImage::from_pixel(80, 40, Rgb([200, 100, 50]));
        let mut out = Cursor::new(Vec::new());
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90);
        encoder.set_exif_metadata(exif).unwrap();
        encoder
            .write_image(img.as_raw(), 80, 40, image::ExtendedColorType::Rgb8)
            .unwrap();
        let processed = process(&out.into_inner(), 2048).unwrap();
        assert_eq!((processed.width, processed.height), (40, 80));
    }

    #[test]
    fn small_image_is_not_upscaled() {
        let out = process(&jpeg_bytes(80, 60), 2048).unwrap();
        assert_eq!((out.width, out.height), (80, 60));
    }

    #[test]
    fn png_with_alpha_stays_png() {
        let img = RgbaImage::from_pixel(300, 200, Rgba([10, 20, 30, 128]));
        let out = process(&png_bytes(DynamicImage::ImageRgba8(img)), 100).unwrap();
        assert_eq!(out.mime_type, "image/png");
        assert_eq!((out.width, out.height), (100, 67));
        assert!(out.thumb.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn max_edge_is_clamped() {
        let out = process(&jpeg_bytes(500, 500), 1).unwrap();
        assert_eq!(out.width, MIN_EDGE);
    }

    #[test]
    fn rejects_non_images_and_corrupt_data() {
        assert_eq!(
            process(b"hello world, not an image", 2048).unwrap_err(),
            "不是支持的图片格式"
        );
        let mut broken = jpeg_bytes(64, 64);
        broken.truncate(40);
        assert!(
            process(&broken, 2048)
                .unwrap_err()
                .starts_with("图片无法解码")
        );
    }

    #[test]
    fn read_image_checks_file() {
        let dir = std::env::temp_dir().join(format!("primus-attach-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_image(&dir, 2048).unwrap_err(), "不是文件");
        assert!(
            read_image(&dir.join("missing.png"), 2048)
                .unwrap_err()
                .starts_with("无法读取文件")
        );
        let text = dir.join("a.txt");
        fs::write(&text, "plain text").unwrap();
        assert_eq!(read_image(&text, 2048).unwrap_err(), "不是支持的图片格式");
        let big = dir.join("big.png");
        let f = fs::File::create(&big).unwrap();
        f.set_len(MAX_INPUT_BYTES + 1).unwrap();
        assert!(read_image(&big, 2048).unwrap_err().contains("20 MB"));
        let ok = dir.join("ok.jpg");
        fs::write(&ok, jpeg_bytes(10, 10)).unwrap();
        assert_eq!(read_image(&ok, 2048).unwrap().width, 10);
        let _ = fs::remove_dir_all(&dir);
    }
}
