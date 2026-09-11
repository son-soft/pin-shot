use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use image::{DynamicImage, RgbaImage};
use kreuzberg_paddle_ocr::ocr_lite::OcrLite;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// Screenshots larger than this are expensive for the detector while yielding
// little additional benefit for normal UI text.  The OCR library maps boxes
// back to source coordinates, so the text layer remains aligned.
const MAX_DETECTION_SIDE_LENGTH: u32 = 2560;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrPoint {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrLineResult {
    pub text: String,
    pub score: f32,
    pub box_points: Vec<OcrPoint>,
    pub rect: [i32; 4], // [x, y, width, height]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrResponse {
    pub full_text: String,
    pub lines: Vec<OcrLineResult>,
}

#[derive(Clone)]
pub struct OcrService {
    engine: Arc<Mutex<Option<OcrLite>>>,
    model_dir: Option<PathBuf>,
}

impl Default for OcrService {
    fn default() -> Self {
        Self::new(None)
    }
}

impl OcrService {
    pub fn new(app: Option<&AppHandle>) -> Self {
        let model_dir = find_model_dir(app);
        Self {
            engine: Arc::new(Mutex::new(None)),
            model_dir,
        }
    }

    pub fn is_available(&self) -> bool {
        self.model_dir.is_some()
    }

    pub fn warm_up(&self) -> Result<(), String> {
        self.get_or_init_engine().map(|_| ())
    }

    fn get_or_init_engine(&self) -> Result<std::sync::MutexGuard<'_, Option<OcrLite>>, String> {
        let mut guard = self.engine.lock().map_err(|e| format!("OCR lock failed: {}", e))?;
        if guard.is_none() {
            let dir = self.model_dir.as_ref().ok_or_else(|| {
                "OCR 模型未找到。请确保 resources/models 目录包含 PP-OCR ONNX 模型文件。".to_string()
            })?;

            let det_path = dir.join("ch_PP-OCRv4_det_infer.onnx");
            let cls_path = dir.join("ch_ppocr_mobile_v2.0_cls_infer.onnx");
            let rec_path = dir.join("ch_PP-OCRv4_rec_infer.onnx");
            let dict_path = dir.join("ppocr_keys_v1.txt");

            if !det_path.exists() || !rec_path.exists() {
                return Err(format!(
                    "OCR 模型文件不完整：找不到 {:?} 或 {:?}",
                    det_path, rec_path
                ));
            }

            let mut ocr = OcrLite::new();
            let thread_count = num_cpus();

            let res = if dict_path.exists() {
                ocr.init_models_with_dict(
                    det_path.to_str().ok_or("Invalid det_path")?,
                    cls_path.to_str().ok_or("Invalid cls_path")?,
                    rec_path.to_str().ok_or("Invalid rec_path")?,
                    dict_path.to_str().ok_or("Invalid dict_path")?,
                    thread_count,
                )
            } else {
                ocr.init_models(
                    det_path.to_str().ok_or("Invalid det_path")?,
                    cls_path.to_str().ok_or("Invalid cls_path")?,
                    rec_path.to_str().ok_or("Invalid rec_path")?,
                    thread_count,
                )
            };

            res.map_err(|e| format!("初始化 OCR 模型失败: {:?}", e))?;
            *guard = Some(ocr);
        }
        Ok(guard)
    }

    pub fn recognize(
        &self,
        rgba_pixels: Vec<u8>,
        width: u32,
        height: u32,
    ) -> Result<OcrResponse, String> {
        if rgba_pixels.is_empty() || width == 0 || height == 0 {
            return Ok(OcrResponse {
                full_text: String::new(),
                lines: Vec::new(),
            });
        }

        let rgba_img = RgbaImage::from_raw(width, height, rgba_pixels)
            .ok_or_else(|| "Failed to construct image from raw pixels".to_string())?;
        let rgb_img = DynamicImage::ImageRgba8(rgba_img).to_rgb8();

        let guard = self.get_or_init_engine()?;
        let ocr = guard.as_ref().ok_or_else(|| "OCR engine not available".to_string())?;

        // Screenshot-tuned parameters: preserve native resolution up to 2560px
        // on the long side, then downscale very large captures for responsive
        // detection. Box coordinates are restored to source-image units by
        // OcrLite's ScaleParam.
        // padding: 10, box_score_thresh: 0.5, box_thresh: 0.3, un_clip_ratio: 1.6
        // do_angle: false, most_angle: false
        let ocr_result = ocr
            .detect(
                &rgb_img,
                10,
                MAX_DETECTION_SIDE_LENGTH,
                0.5,
                0.3,
                1.6,
                false,
                false,
            )
            .map_err(|e| format!("OCR 识别执行失败: {:?}", e))?;

        let mut lines = Vec::new();
        let mut full_text_parts = Vec::new();

        for block in ocr_result.text_blocks {
            let text = block.text.trim().to_string();
            if text.is_empty() {
                continue;
            }

            let mut min_x = i32::MAX;
            let mut min_y = i32::MAX;
            let mut max_x = i32::MIN;
            let mut max_y = i32::MIN;

            let box_points: Vec<OcrPoint> = block
                .box_points
                .iter()
                .map(|p| {
                    let px = p.x as i32;
                    let py = p.y as i32;
                    min_x = min_x.min(px);
                    min_y = min_y.min(py);
                    max_x = max_x.max(px);
                    max_y = max_y.max(py);
                    OcrPoint { x: px, y: py }
                })
                .collect();

            let rect = if min_x <= max_x && min_y <= max_y {
                [min_x, min_y, (max_x - min_x).max(1), (max_y - min_y).max(1)]
            } else {
                [0, 0, 0, 0]
            };

            full_text_parts.push(text.clone());
            lines.push(OcrLineResult {
                text,
                score: block.text_score,
                box_points,
                rect,
            });
        }

        let full_text = full_text_parts.join("\n");
        Ok(OcrResponse { full_text, lines })
    }
}

fn num_cpus() -> usize {
    std::thread::available_parallelism()
        .map(|n| (n.get() / 2).max(1).min(4))
        .unwrap_or(2)
}

fn find_model_dir(app: Option<&AppHandle>) -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(app) = app {
        if let Ok(resource_dir) = app.path().resource_dir() {
            candidates.push(resource_dir.join("resources").join("models"));
            candidates.push(resource_dir.join("models"));
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.join("resources").join("models"));
            candidates.push(exe_dir.join("models"));
            if let Some(parent) = exe_dir.parent() {
                candidates.push(parent.join("resources").join("models"));
                if let Some(grandparent) = parent.parent() {
                    candidates.push(grandparent.join("src-tauri").join("resources").join("models"));
                }
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("resources").join("models"));
        candidates.push(cwd.join("resources").join("models"));
        candidates.push(cwd.join("models"));
    }

    for path in candidates {
        if path.join("ch_PP-OCRv4_det_infer.onnx").exists()
            && path.join("ch_PP-OCRv4_rec_infer.onnx").exists()
        {
            return Some(path);
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ocr_service_initialization() {
        let service = OcrService::new(None);
        assert!(service.is_available(), "Model directory should be found in src-tauri/resources/models");

        // Verify dictionary file has 6625 characters
        let dir = service.model_dir.as_ref().unwrap();
        let dict = std::fs::read_to_string(dir.join("ppocr_keys_v1.txt")).expect("read dict");
        let dict_lines: Vec<&str> = dict.lines().collect();
        assert_eq!(dict_lines.len(), 6625, "PP-OCRv4 dictionary must have exactly 6625 characters (6623 + blank + space)");

        // Blank image test
        let width = 100u32;
        let height = 100u32;
        let white_pixels = vec![255u8; (width * height * 4) as usize];
        let res = service.recognize(white_pixels, width, height);
        assert!(res.is_ok(), "OCR on white image should succeed: {:?}", res.err());
        let ocr_res = res.unwrap();
        assert!(ocr_res.lines.is_empty(), "White image should have no text detected");
    }
}
