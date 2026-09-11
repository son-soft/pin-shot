use image::{ImageBuffer, Rgba};
use std::cmp::{max, min};

/// Result of stitching a new frame.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StitchResult {
    pub delta_y: u32,
    pub total_height: u32,
    pub frame_count: u32,
    pub is_bottom: bool,
    pub confidence: f32, // 0.0 to 1.0 (1.0 = perfect match)
}

pub struct Stitcher {
    pub width: u32,
    pub frame_height: u32,
    pub accumulated_pixels: Vec<u8>,
    pub total_height: u32,
    pub last_frame: Vec<u8>,
    pub frame_count: u32,
    pub consecutive_zero_shifts: u32,
    pub max_height: u32,
    fixed_bottom_height: u32,
}

impl Stitcher {
    pub fn new(first_frame: Vec<u8>, width: u32, height: u32) -> Result<Self, String> {
        let expected = (width as usize)
            .checked_mul(height as usize)
            .and_then(|v| v.checked_mul(4))
            .ok_or_else(|| "图像尺寸过大".to_string())?;

        if first_frame.len() != expected {
            return Err("首帧尺寸与图像宽高不匹配".to_string());
        }

        Ok(Self {
            width,
            frame_height: height,
            accumulated_pixels: first_frame.clone(),
            total_height: height,
            last_frame: first_frame,
            frame_count: 1,
            consecutive_zero_shifts: 0,
            max_height: 32000,
            fixed_bottom_height: 0,
        })
    }

    /// Appends a new captured frame to the long screenshot.
    pub fn add_frame(&mut self, next_frame: &[u8]) -> Result<StitchResult, String> {
        self.add_frame_ext(next_frame, true)
    }

    /// Appends a new captured frame, specifying whether this follows an active scroll attempt.
    pub fn add_frame_ext(&mut self, next_frame: &[u8], is_scroll_attempt: bool) -> Result<StitchResult, String> {
        let expected = (self.width as usize) * (self.frame_height as usize) * 4;
        if next_frame.len() != expected {
            return Err("帧尺寸与选区不匹配".to_string());
        }

        if self.total_height >= self.max_height {
            return Ok(StitchResult {
                delta_y: 0,
                total_height: self.total_height,
                frame_count: self.frame_count,
                is_bottom: true,
                confidence: 1.0,
            });
        }

        // Match the previous accepted frame with the current frame.  Long
        // capture is monotonic: only movement below the deepest accepted
        // frame may extend the result.  In particular, do not treat an
        // upward scroll as a positive shift, or scrolling back down would
        // append pixels that are already present in the stitched image.
        let (signed_delta_y, confidence) = find_vertical_scroll_delta(
            &self.last_frame,
            next_frame,
            self.width,
            self.frame_height,
        );

        if signed_delta_y <= 0 {
            // A zero offset with a weak match means "could not match", not
            // "the page did not move". Treating both cases as the bottom of
            // the page made two difficult frames terminate auto capture.
            // Furthermore, passive background frames (when user is idle) should
            // never increment consecutive_zero_shifts.
            if is_scroll_attempt && signed_delta_y == 0 && confidence >= 0.9 {
                self.consecutive_zero_shifts += 1;
            } else if is_scroll_attempt {
                self.consecutive_zero_shifts = 0;
            }
            let is_bottom = is_scroll_attempt && self.consecutive_zero_shifts >= 2;
            return Ok(StitchResult {
                delta_y: 0,
                total_height: self.total_height,
                frame_count: self.frame_count,
                is_bottom,
                confidence,
            });
        }

        let delta_y = signed_delta_y as u32;

        self.consecutive_zero_shifts = 0;

        // A fixed footer (for example a chat input box) stays at the same
        // screen coordinates while the document moves behind it. Keep one
        // copy at the end instead of baking it into every appended frame.
        let detected_footer = detect_fixed_bottom(
            &self.last_frame,
            next_frame,
            self.width,
            self.frame_height,
            delta_y,
        );
        if detected_footer > 0 {
            if self.fixed_bottom_height == 0 {
                self.fixed_bottom_height = detected_footer;
            } else {
                self.fixed_bottom_height = self.fixed_bottom_height.max(detected_footer);
            }
        }

        // Slice the new pixels from the bottom of next_frame
        // (shifted upward by any screen-fixed footer).
        let append_height = delta_y.min(self.max_height - self.total_height);
        let footer_height = self
            .fixed_bottom_height
            .min(self.frame_height.saturating_sub(delta_y));
        let start_row = (self.frame_height - delta_y - footer_height) as usize;
        let end_row = start_row + append_height as usize;
        let row_stride = (self.width as usize) * 4;

        let slice_start = start_row * row_stride;
        let slice_end = end_row * row_stride;

        if slice_end <= next_frame.len() && slice_start < slice_end {
            if footer_height > 0 {
                let footer_bytes = footer_height as usize * row_stride;
                self.accumulated_pixels
                    .truncate(self.accumulated_pixels.len().saturating_sub(footer_bytes));
            }
            self.accumulated_pixels
                .extend_from_slice(&next_frame[slice_start..slice_end]);
            if footer_height > 0 {
                let footer_start = (self.frame_height - footer_height) as usize * row_stride;
                self.accumulated_pixels
                    .extend_from_slice(&next_frame[footer_start..]);
            }
            self.total_height += append_height;
            self.last_frame = next_frame.to_vec();
            self.frame_count += 1;
        }

        Ok(StitchResult {
            delta_y: append_height,
            total_height: self.total_height,
            frame_count: self.frame_count,
            is_bottom: self.total_height >= self.max_height,
            confidence,
        })
    }

    /// Generates a small preview JPEG or PNG thumbnail as a base64 Data URL.
    pub fn generate_preview_data_url(&self, target_preview_width: u32) -> Option<String> {
        if self.width == 0 || self.total_height == 0 {
            return None;
        }

        let scale = (target_preview_width as f32 / self.width as f32).min(1.0);
        let preview_w = max(1, (self.width as f32 * scale).round() as u32);
        let preview_h = max(1, (self.total_height as f32 * scale).round() as u32);

        // Subsample into smaller RGBA buffer
        let mut preview_buffer: ImageBuffer<Rgba<u8>, Vec<u8>> =
            ImageBuffer::new(preview_w, preview_h);

        for py in 0..preview_h {
            let src_y = min(
                self.total_height - 1,
                ((py as f64 / preview_h as f64) * self.total_height as f64) as u32,
            );
            let src_row_offset = (src_y as usize) * (self.width as usize) * 4;

            for px in 0..preview_w {
                let src_x = min(
                    self.width - 1,
                    ((px as f64 / preview_w as f64) * self.width as f64) as u32,
                );
                let idx = src_row_offset + (src_x as usize) * 4;
                if idx + 3 < self.accumulated_pixels.len() {
                    let pixel = Rgba([
                        self.accumulated_pixels[idx],
                        self.accumulated_pixels[idx + 1],
                        self.accumulated_pixels[idx + 2],
                        self.accumulated_pixels[idx + 3],
                    ]);
                    preview_buffer.put_pixel(px, py, pixel);
                }
            }
        }

        // Encode preview as PNG
        let mut png_bytes = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut png_bytes);
        use image::ImageEncoder;
        if encoder
            .write_image(
                preview_buffer.as_raw(),
                preview_w,
                preview_h,
                image::ExtendedColorType::Rgba8,
            )
            .is_ok()
        {
            let mut b64 = String::from("data:image/png;base64,");
            let encoded = base64_encode(&png_bytes);
            b64.push_str(&encoded);
            Some(b64)
        } else {
            None
        }
    }

    /// Finish and return the stitched RGBA buffer, width, and height.
    pub fn finish(self) -> (Vec<u8>, u32, u32) {
        (self.accumulated_pixels, self.width, self.total_height)
    }
}

fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };

        let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((n >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(n & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// Computes the vertical scroll shift between two frames.
/// Returns (delta_y, confidence) where confidence is between 0.0 and 1.0.
#[cfg(test)]
pub fn find_vertical_scroll_offset(
    prev_rgba: &[u8],
    curr_rgba: &[u8],
    width: u32,
    height: u32,
) -> (u32, f32) {
    let (signed_delta, confidence) = find_vertical_scroll_delta(prev_rgba, curr_rgba, width, height);
    if signed_delta > 0 {
        (signed_delta as u32, confidence)
    } else if signed_delta == 0 {
        (0, confidence)
    } else {
        // Preserve the historical API: callers of this helper only ask for
        // downward movement, so an upward frame is reported as no offset.
        (0, 0.0)
    }
}

/// Computes the signed vertical movement between two frames.
///
/// A positive value means the document moved down (new content appears at the
/// bottom); a negative value means the user scrolled back up.  The stitcher
/// uses the sign to keep the output monotonic and avoid duplicate content.
fn find_vertical_scroll_delta(
    prev_rgba: &[u8],
    curr_rgba: &[u8],
    width: u32,
    height: u32,
) -> (i32, f32) {
    if width < 30 || height < 60 {
        return (0, 0.0);
    }

    // Horizontal margins to exclude scrollbars on the right and borders on the left
    let x_start = min(16, width / 12);
    let x_end = if width > 40 { width - 24 } else { width - 4 };
    if x_end <= x_start + 10 {
        return (0, 0.0);
    }

    let prev_luma = rgba_to_luma(prev_rgba, width, height);
    let curr_luma = rgba_to_luma(curr_rgba, width, height);

    // 1. Check if the screen has NOT scrolled (shift = 0)
    let zero_score = compute_overlap_mad(&prev_luma, &curr_luma, width, x_start, x_end, height, 0);
    if zero_score < 1.0 {
        return (0, 1.0);
    }

    // Search both directions.  The old implementation only searched the
    // positive direction, which can mistake a reverse scroll for a new
    // downward overlap when the page contains repeated rows.
    let (down_shift, down_score) = search_vertical_shift(
        &prev_luma,
        &curr_luma,
        width,
        x_start,
        x_end,
        height,
        zero_score,
    );
    let (up_shift, up_score) = search_vertical_shift(
        &curr_luma,
        &prev_luma,
        width,
        x_start,
        x_end,
        height,
        zero_score,
    );

    let down_valid = down_shift > 3 && down_score < zero_score && down_score <= 18.0;
    let up_valid = up_shift > 3 && up_score < zero_score && up_score <= 18.0;

    match (down_valid, up_valid) {
        (true, false) => {
            let confidence = (1.0 - down_score / 25.0).clamp(0.4, 1.0);
            (down_shift as i32, confidence)
        }
        (false, true) => {
            let confidence = (1.0 - up_score / 25.0).clamp(0.4, 1.0);
            (-(up_shift as i32), confidence)
        }
        (true, true) if down_score < up_score => {
            let confidence = (1.0 - down_score / 25.0).clamp(0.4, 1.0);
            (down_shift as i32, confidence)
        }
        (true, true) if up_score < down_score => {
            let confidence = (1.0 - up_score / 25.0).clamp(0.4, 1.0);
            (-(up_shift as i32), confidence)
        }
        // Ambiguous matches are safer to ignore than to append twice.
        _ => (0, 0.0),
    }
}

fn search_vertical_shift(
    first: &[u8],
    second: &[u8],
    width: u32,
    x_start: u32,
    x_end: u32,
    height: u32,
    zero_score: f32,
) -> (u32, f32) {
    // Search candidate shifts: from 4px up to 85% of frame height
    let max_shift = height.saturating_sub(max(30, height / 10));
    let mut best_shift = 0;
    let mut best_score = zero_score;

    for shift in (4..=max_shift).step_by(2) {
        let score = compute_overlap_mad(first, second, width, x_start, x_end, height, shift);
        if score < best_score {
            best_score = score;
            best_shift = shift;
        }
    }

    // 3. Fine search around best_shift with 1px step
    if best_shift > 0 {
        let fine_start = best_shift.saturating_sub(3).max(4);
        let fine_end = min(max_shift, best_shift + 3);
        for shift in fine_start..=fine_end {
            let score = compute_overlap_mad(first, second, width, x_start, x_end, height, shift);
            if score < best_score {
                best_score = score;
                best_shift = shift;
            }
        }
    }

    (best_shift, best_score)
}

#[inline]
fn rgba_to_luma(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let size = (width as usize) * (height as usize);
    let mut luma = Vec::with_capacity(size);
    for chunk in rgba.chunks_exact(4) {
        let r = chunk[0] as u32;
        let g = chunk[1] as u32;
        let b = chunk[2] as u32;
        // Standard Rec. 601 luma: (77 * R + 150 * G + 29 * B) >> 8
        let y = ((77 * r + 150 * g + 29 * b) >> 8) as u8;
        luma.push(y);
    }
    luma
}

#[inline]
fn compute_overlap_mad(
    prev: &[u8],
    curr: &[u8],
    width: u32,
    x_start: u32,
    x_end: u32,
    height: u32,
    shift: u32,
) -> f32 {
    let overlap = height - shift;
    if overlap < 24 {
        return f32::MAX;
    }
    // Avoid fixed headers / footers at the very edges of the overlap
    let y_margin = (overlap / 24).clamp(1, 24);
    let y_start = y_margin;
    let y_end = overlap - y_margin;
    if y_end <= y_start {
        return f32::MAX;
    }

    let step_x = max(1, (x_end - x_start) / 128) as usize;
    let step_y = max(1, (y_end - y_start) / 128) as usize;

    let mut total_diff = 0u64;
    let mut total_count = 0u64;

    for y in (y_start..y_end).step_by(step_y) {
        let prev_off = ((y + shift) * width) as usize;
        let curr_off = (y * width) as usize;
        for x in (x_start..x_end).step_by(step_x) {
            let p = prev[prev_off + x as usize] as i32;
            let c = curr[curr_off + x as usize] as i32;
            total_diff += (p - c).unsigned_abs() as u64;
            total_count += 1;
        }
    }

    if total_count == 0 {
        return f32::MAX;
    }

    total_diff as f32 / total_count as f32
}

fn detect_fixed_bottom(
    prev_rgba: &[u8],
    curr_rgba: &[u8],
    width: u32,
    height: u32,
    shift: u32,
) -> u32 {
    if shift < 4 || height < 60 || shift >= height {
        return 0;
    }
    let prev = rgba_to_luma(prev_rgba, width, height);
    let curr = rgba_to_luma(curr_rgba, width, height);

    // Margins to exclude scrollbars on right and window borders on left
    let x_start = min(20, width / 10);
    let x_end = if width > 50 { width - 30 } else { width - 4 };
    if x_end <= x_start + 20 {
        return 0;
    }
    let step_x = max(1, (x_end - x_start) / 120) as usize;

    // A fixed bottom (like ChatGPT input bar or sticky navigation)
    // typically occupies 18px up to 45% of frame height.
    let max_footer = min((height * 45) / 100, height.saturating_sub(shift.max(15)));
    if max_footer < 18 {
        return 0;
    }

    // Scan upwards from the bottom of the screen (height - 1)
    // In a fixed footer, row y in prev matches row y in curr (the footer is stationary).
    let mut footer_rows = 0u32;
    let mut consecutive_moving = 0u32;
    let mut has_features = false;

    for dy in 0..max_footer {
        let y = height - 1 - dy;
        let off = (y * width) as usize;

        let mut diff = 0u64;
        let mut count = 0u64;
        let mut min_val = 255u8;
        let mut max_val = 0u8;

        for x in (x_start..x_end).step_by(step_x) {
            let p = prev[off + x as usize];
            let c = curr[off + x as usize];
            diff += (p as i32 - c as i32).unsigned_abs() as u64;
            min_val = min_val.min(c);
            max_val = max_val.max(c);
            count += 1;
        }

        if count == 0 {
            break;
        }

        let row_mad = diff as f32 / count as f32;
        if max_val.saturating_sub(min_val) >= 10 {
            has_features = true;
        }

        // Row is stationary between prev and curr
        if row_mad <= 4.0 {
            consecutive_moving = 0;
            footer_rows = dy + 1;
        } else {
            // Row has moved (scrolling document content)
            consecutive_moving += 1;
            if consecutive_moving >= 2 {
                // Encountered moving document content; footer has ended
                break;
            }
        }
    }

    // A valid fixed footer must be at least 18px tall, must have visual features,
    // and must not exceed max_footer.
    if footer_rows >= 18 && footer_rows <= max_footer && has_features {
        footer_rows
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_browser_repeating_list_retains_distinguishing_text() {
        let width = 800;
        let height = 720;
        let shift = 120;
        let total_h = height + shift;
        let source = patterned_image(width, total_h);
        let stride = (width * 4) as usize;

        let before = source[..height as usize * stride].to_vec();
        let after = source[shift as usize * stride..total_h as usize * stride].to_vec();

        let mut stitcher = Stitcher::new(before.clone(), width, height).unwrap();
        let result = stitcher.add_frame(&after).unwrap();
        assert_eq!(result.delta_y, shift);

        let (pixels, w, h) = stitcher.finish();
        assert_eq!((w, h), (width, total_h));
        assert_eq!(pixels, source);
    }

    #[test]
    fn test_full_long_capture_pipeline_multi_frame_and_preview() {
        let width = 800;
        let height = 720;
        let shift = 120;
        let total_h = height + shift;
        let source = patterned_image(width, total_h);
        let stride = (width * 4) as usize;

        let before = source[..height as usize * stride].to_vec();
        let after = source[shift as usize * stride..total_h as usize * stride].to_vec();

        let mut stitcher = Stitcher::new(before.clone(), width, height).unwrap();

        // 1. Check initial preview URL
        let preview = stitcher.generate_preview_data_url(160);
        assert!(preview.is_some());
        assert!(preview.unwrap().starts_with("data:image/png;base64,"));

        // 2. Simulate passive background frames (user idling): should NOT trigger is_bottom
        let passive_res1 = stitcher.add_frame_ext(&before, false).unwrap();
        let passive_res2 = stitcher.add_frame_ext(&before, false).unwrap();
        assert_eq!(passive_res1.delta_y, 0);
        assert_eq!(passive_res2.delta_y, 0);
        assert!(!passive_res1.is_bottom);
        assert!(!passive_res2.is_bottom);

        // 3. Add scrolled frame
        let scroll_res = stitcher.add_frame_ext(&after, true).unwrap();
        assert_eq!(scroll_res.delta_y, shift);
        assert_eq!(scroll_res.total_height, total_h);
        assert_eq!(scroll_res.frame_count, 2);
        assert!(!scroll_res.is_bottom);

        // 4. Finish and verify image dimensions and buffer integrity
        let (pixels, w, h) = stitcher.finish();
        assert_eq!(w, width);
        assert_eq!(h, total_h);
        assert_eq!(pixels, source);
    }

    #[test]
    fn test_native_before_after_matching() {
        let dir = std::path::Path::new("../output/playwright");
        if !dir.join("native-before.png").exists() { return; }
        let before = image::open(dir.join("native-before.png")).unwrap().to_rgba8();
        let after = image::open(dir.join("native-after.png")).unwrap().to_rgba8();
        let (shift, conf) = find_vertical_scroll_offset(before.as_raw(), after.as_raw(), 780, 720);
        eprintln!("test_native_before_after_matching: shift={shift}, conf={conf}");
        assert!(shift > 0, "must find non-zero scroll shift");
    }

    #[test]
    #[ignore = "requires browser frames from output/playwright/capture-frames.js"]
    fn browser_frames_match_reference_pixels() {
        let dir = std::path::Path::new("../output/playwright");
        let first = image::open(dir.join("frame-0.png")).unwrap().to_rgba8();
        let mut stitcher = Stitcher::new(first.as_raw().clone(), first.width(), first.height()).unwrap();
        for offset in (120..=1200).step_by(120) {
            let frame = image::open(dir.join(format!("frame-{offset}.png"))).unwrap().to_rgba8();
            let result = stitcher.add_frame(frame.as_raw()).unwrap();
            eprintln!("offset={offset}: {result:?}");
            assert_eq!(result.delta_y, 120, "wrong scroll at {offset}");
        }
        let (pixels, width, height) = stitcher.finish();
        let reference = image::open(dir.join("reference-page.png")).unwrap().to_rgba8();
        let expected = image::imageops::crop_imm(&reference, 100, 60, width, height).to_image();
        let different = pixels.chunks_exact(4).zip(expected.as_raw().chunks_exact(4))
            .filter(|(a, b)| a != b).count();
        image::save_buffer(dir.join("stitched-browser.png"), &pixels, width, height,
            image::ColorType::Rgba8).unwrap();
        assert_eq!(different, 0, "browser stitched pixels differ from reference");
    }

    fn patterned_image(width: u32, height: u32) -> Vec<u8> {
        let mut pixels = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                pixels.extend_from_slice(&[
                    ((y * 7 + x * 3) % 251) as u8,
                    ((x * 11 + y / 3) % 253) as u8,
                    ((y * 5 + x / 2) % 247) as u8,
                    255,
                ]);
            }
        }
        pixels
    }

    fn frame_at(source: &[u8], width: u32, height: u32, offset: u32) -> Vec<u8> {
        let stride = (width * 4) as usize;
        let start = offset as usize * stride;
        let end = start + height as usize * stride;
        source[start..end].to_vec()
    }

    fn overwrite_rows(frame: &mut [u8], width: u32, start: u32, end: u32, seed: u8) {
        for y in start..end {
            for x in 0..width {
                let i = ((y * width + x) * 4) as usize;
                frame[i..i + 4].copy_from_slice(&[
                    seed.wrapping_add((x % 17) as u8),
                    seed.wrapping_add((y % 13) as u8),
                    seed,
                    255,
                ]);
            }
        }
    }

    #[test]
    fn test_stitching_exact_scroll() {
        let width = 200;
        let height = 300;
        let scroll_step = 60; // scrolled by 60 pixels

        // Create a long virtual pattern of height 360
        let total_virtual_h = height + scroll_step;
        let mut virtual_img = Vec::with_capacity((width * total_virtual_h * 4) as usize);

        for y in 0..total_virtual_h {
            for x in 0..width {
                // Generate distinct horizontal & vertical patterns with clear vertical gradient
                let r = (y.min(255)) as u8;
                let g = ((x * 2) % 256) as u8;
                let b = ((y * 2 + x) % 256) as u8;
                virtual_img.extend_from_slice(&[r, g, b, 255]);
            }
        }

        // Frame 0: rows 0..300
        let frame0 = virtual_img[0..(width * height * 4) as usize].to_vec();

        // Frame 1: rows 60..360 (simulating scroll down by 60)
        let start_f1 = (scroll_step * width * 4) as usize;
        let end_f1 = start_f1 + (width * height * 4) as usize;
        let frame1 = virtual_img[start_f1..end_f1].to_vec();

        let mut stitcher = Stitcher::new(frame0, width, height).unwrap();
        let result = stitcher.add_frame(&frame1).unwrap();

        assert_eq!(result.delta_y, scroll_step);
        assert_eq!(result.total_height, height + scroll_step);
        assert_eq!(stitcher.frame_count, 2);

        // Verify the stitched pixels match the virtual image exactly
        let (stitched, w, h) = stitcher.finish();
        assert_eq!(w, width);
        assert_eq!(h, total_virtual_h);
        assert_eq!(stitched, virtual_img);
    }

    #[test]
    fn unchanged_textureless_frames_reach_bottom_without_fake_growth() {
        let width = 160;
        let height = 240;
        let frame = vec![245; (width * height * 4) as usize];
        let mut stitcher = Stitcher::new(frame.clone(), width, height).unwrap();

        let first = stitcher.add_frame(&frame).unwrap();
        let second = stitcher.add_frame(&frame).unwrap();

        assert_eq!(first.delta_y, 0);
        assert!(!first.is_bottom);
        assert!(second.is_bottom);
        assert_eq!(stitcher.total_height, height);
    }

    #[test]
    fn sticky_header_and_footer_do_not_break_scroll_match() {
        let width = 240;
        let height = 360;
        let shift = 84;
        let source = patterned_image(width, height + shift);
        let stride = (width * 4) as usize;
        let mut first = source[..height as usize * stride].to_vec();
        let mut second =
            source[shift as usize * stride..(shift + height) as usize * stride].to_vec();

        // Simulate fixed page chrome which remains in the same screen rows.
        overwrite_rows(&mut first, width, 0, 28, 30);
        overwrite_rows(&mut second, width, 0, 28, 30);
        overwrite_rows(&mut first, width, height - 20, height, 180);
        overwrite_rows(&mut second, width, height - 20, height, 180);

        let (actual, confidence) = find_vertical_scroll_offset(&first, &second, width, height);
        assert_eq!(actual, shift);
        assert!(confidence >= 0.65, "confidence was {confidence}");

        let footer_height = 20;
        let mut stitcher = Stitcher::new(first, width, height).unwrap();
        stitcher.add_frame(&second).unwrap();
        let (stitched, _, stitched_height) = stitcher.finish();
        let document_end = height + shift - footer_height;
        let mut expected = source[..document_end as usize * stride].to_vec();
        overwrite_rows(&mut expected, width, 0, 28, 30);
        expected.extend_from_slice(&second[(height - footer_height) as usize * stride..]);
        assert_eq!(stitched_height, height + shift);
        assert_eq!(stitched, expected);
    }

    #[test]
    fn unreliable_frames_are_not_mistaken_for_page_bottom() {
        let width = 180;
        let height = 260;
        let first = patterned_image(width, height);
        let second = vec![17; (width * height * 4) as usize];
        let mut stitcher = Stitcher::new(first, width, height).unwrap();

        let result1 = stitcher.add_frame(&second).unwrap();
        let result2 = stitcher.add_frame(&second).unwrap();

        assert!(!result1.is_bottom);
        // Once the same second frame is observed again it is valid evidence
        // that the target stopped moving, but never before that observation.
        assert!(!result2.is_bottom);
        assert_eq!(stitcher.total_height, height);
    }

    #[test]
    fn scrolling_back_up_then_down_does_not_duplicate_content() {
        let width = 200;
        let height = 300;
        let base = patterned_image(width, height + 180);
        let stride = (width * 4) as usize;
        let mut source = base.clone();
        // Repeat one visible section at a later position.  A positive-only
        // matcher can mistake the return from offset 60 to offset 0 for a
        // new downward shift when these rows overlap.
        for row in 120..360 {
            let source_start = (row - 120) as usize * stride;
            let target_start = row as usize * stride;
            let repeated = base[source_start..source_start + stride].to_vec();
            source[target_start..target_start + stride].copy_from_slice(&repeated);
        }
        let frame0 = frame_at(&source, width, height, 0);
        let frame60 = frame_at(&source, width, height, 60);
        let frame180 = frame_at(&source, width, height, 180);

        let mut stitcher = Stitcher::new(frame0, width, height).unwrap();

        let first_down = stitcher.add_frame(&frame60).unwrap();
        assert_eq!(first_down.delta_y, 60);

        // Moving back up must not change the stitched output or its deepest
        // accepted frame.
        let back_up = stitcher.add_frame(&frame_at(&source, width, height, 0)).unwrap();
        assert_eq!(back_up.delta_y, 0);
        assert_eq!(back_up.total_height, height + 60);

        // Returning down to a new position appends only the new suffix from
        // the deepest accepted frame, rather than appending the already
        // captured 0..60 region again.
        let second_down = stitcher.add_frame(&frame180).unwrap();
        assert_eq!(second_down.delta_y, 120);
        assert_eq!(second_down.total_height, height + 180);

        let (stitched, _, stitched_height) = stitcher.finish();
        assert_eq!(stitched_height, height + 180);
        assert_eq!(stitched, source[..(height + 180) as usize * stride]);
    }

    #[test]
    fn maximum_height_keeps_a_contiguous_prefix() {
        let width = 120;
        let height = 200;
        let shift = 50;
        let source = patterned_image(width, height + shift);
        let stride = (width * 4) as usize;
        let first = source[..height as usize * stride].to_vec();
        let second = source[shift as usize * stride..(shift + height) as usize * stride].to_vec();
        let mut stitcher = Stitcher::new(first, width, height).unwrap();
        stitcher.max_height = height + 13;

        let result = stitcher.add_frame(&second).unwrap();
        let (stitched, _, stitched_height) = stitcher.finish();

        assert_eq!(result.delta_y, 13);
        assert_eq!(stitched_height, height + 13);
        assert_eq!(stitched, source[..(height + 13) as usize * stride]);
    }
}
