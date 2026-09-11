import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4ArrayBufferTarget } from 'mp4-muxer';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmArrayBufferTarget } from 'webm-muxer';

export interface VideoExportOptions {
  fps: number;
  speed?: number;
  quality?: 'high' | 'medium' | 'low';
  frameCount?: number;
  onProgress?: (progress: number) => void;
  isCancelled?: () => boolean;
}

export type FrameProvider = ImageData[] | ((index: number) => Promise<ImageData | Uint8ClampedArray>);

export async function encodeFramesToMp4(
  frames: FrameProvider,
  width: number,
  height: number,
  options: VideoExportOptions
): Promise<Uint8Array> {
  const totalFrames = Array.isArray(frames) ? frames.length : (options.frameCount ?? 0);
  if (totalFrames === 0 || width < 2 || height < 2) {
    throw new Error('无效的帧序列或画面尺寸');
  }

  // H.264 requires even width and height
  const encWidth = width % 2 === 0 ? width : width - 1;
  const encHeight = height % 2 === 0 ? height : height - 1;
  const speed = options.speed ?? 1.0;
  const effectiveFps = Math.max(1, Math.round(options.fps * speed));

  const bitrateMultiplier = options.quality === 'high' ? 6 : options.quality === 'low' ? 2 : 4;
  const bitrate = Math.min(15_000_000, Math.max(1_000_000, encWidth * encHeight * bitrateMultiplier));

  const mp4Config: VideoEncoderConfig = {
    codec: 'avc1.42001f',
    width: encWidth,
    height: encHeight,
    bitrate,
    framerate: effectiveFps,
  };
  const canEncodeMp4 = typeof VideoEncoder !== 'undefined'
    && await VideoEncoder.isConfigSupported(mp4Config)
      .then((result) => result.supported)
      .catch(() => false);

  if (canEncodeMp4) {
    const target = new Mp4ArrayBufferTarget();
    const muxer = new Mp4Muxer({
      target,
      video: {
        codec: 'avc',
        width: encWidth,
        height: encHeight,
      },
      fastStart: 'in-memory',
    });

    let encoderError: any = null;
    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => {
        encoderError = e;
      },
    });

    try {
      videoEncoder.configure(mp4Config);

      const canvas = document.createElement('canvas');
      canvas.width = encWidth;
      canvas.height = encHeight;
      const ctx = canvas.getContext('2d')!;

      const frameDurationMicros = Math.round(1_000_000 / effectiveFps);

      for (let i = 0; i < totalFrames; i++) {
        if (options.isCancelled?.()) throw new Error('录制导出已取消');
        if (encoderError) throw encoderError;

        const frame = Array.isArray(frames) ? frames[i] : await frames(i);
        if (frame instanceof ImageData) {
          ctx.putImageData(frame, 0, 0, 0, 0, encWidth, encHeight);
        } else {
          const imgData = new ImageData(frame as any, width, height);
          ctx.putImageData(imgData, 0, 0, 0, 0, encWidth, encHeight);
        }

        const videoFrame = new VideoFrame(canvas, {
          timestamp: i * frameDurationMicros,
          duration: frameDurationMicros,
        });

        const keyFrame = i % Math.max(1, effectiveFps * 2) === 0;
        videoEncoder.encode(videoFrame, { keyFrame });
        videoFrame.close();

        await waitForEncoderQueue(videoEncoder, options.isCancelled);

        options.onProgress?.((i + 1) / totalFrames);
      }

      if (options.isCancelled?.()) throw new Error('录制导出已取消');
      await videoEncoder.flush();
      if (options.isCancelled?.()) throw new Error('录制导出已取消');
      muxer.finalize();
      return new Uint8Array(target.buffer);
    } finally {
      if (videoEncoder.state !== 'closed') videoEncoder.close();
    }
  }

  // MediaRecorder commonly falls back to WebM even when asked for MP4.  Saving
  // those bytes with an .mp4 extension creates a corrupt-looking file, so make
  // the limitation explicit instead of silently producing the wrong format.
  throw new Error('当前运行环境不支持 H.264/MP4 编码，请导出 WebM');
}

export async function encodeFramesToWebm(
  frames: FrameProvider,
  width: number,
  height: number,
  options: VideoExportOptions
): Promise<Uint8Array> {
  const totalFrames = Array.isArray(frames) ? frames.length : (options.frameCount ?? 0);
  if (totalFrames === 0 || width < 2 || height < 2) {
    throw new Error('无效的帧序列或画面尺寸');
  }

  const encWidth = width % 2 === 0 ? width : width - 1;
  const encHeight = height % 2 === 0 ? height : height - 1;
  const speed = options.speed ?? 1.0;
  const effectiveFps = Math.max(1, Math.round(options.fps * speed));

  const bitrateMultiplier = options.quality === 'high' ? 5 : options.quality === 'low' ? 1.5 : 3;
  const bitrate = Math.min(12_000_000, Math.max(800_000, encWidth * encHeight * bitrateMultiplier));

  const webmConfig: VideoEncoderConfig = {
    codec: 'vp09.00.10.08',
    width: encWidth,
    height: encHeight,
    bitrate,
    framerate: effectiveFps,
  };
  const canEncodeWebm = typeof VideoEncoder !== 'undefined'
    && await VideoEncoder.isConfigSupported(webmConfig)
      .then((result) => result.supported)
      .catch(() => false);

  if (canEncodeWebm) {
    const target = new WebmArrayBufferTarget();
    const muxer = new WebmMuxer({
      target,
      video: {
        codec: 'V_VP9',
        width: encWidth,
        height: encHeight,
        frameRate: effectiveFps,
      },
    });

    let encoderError: any = null;
    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => {
        encoderError = e;
      },
    });

    try {
      videoEncoder.configure(webmConfig);

      const canvas = document.createElement('canvas');
      canvas.width = encWidth;
      canvas.height = encHeight;
      const ctx = canvas.getContext('2d')!;

      const frameDurationMicros = Math.round(1_000_000 / effectiveFps);

      for (let i = 0; i < totalFrames; i++) {
        if (options.isCancelled?.()) throw new Error('录制导出已取消');
        if (encoderError) throw encoderError;

        const frame = Array.isArray(frames) ? frames[i] : await frames(i);
        if (frame instanceof ImageData) {
          ctx.putImageData(frame, 0, 0, 0, 0, encWidth, encHeight);
        } else {
          const imgData = new ImageData(frame as any, width, height);
          ctx.putImageData(imgData, 0, 0, 0, 0, encWidth, encHeight);
        }

        const videoFrame = new VideoFrame(canvas, {
          timestamp: i * frameDurationMicros,
          duration: frameDurationMicros,
        });

        const keyFrame = i % Math.max(1, effectiveFps * 2) === 0;
        videoEncoder.encode(videoFrame, { keyFrame });
        videoFrame.close();

        await waitForEncoderQueue(videoEncoder, options.isCancelled);

        options.onProgress?.((i + 1) / totalFrames);
      }

      if (options.isCancelled?.()) throw new Error('录制导出已取消');
      await videoEncoder.flush();
      if (options.isCancelled?.()) throw new Error('录制导出已取消');
      muxer.finalize();
      return new Uint8Array(target.buffer);
    } finally {
      if (videoEncoder.state !== 'closed') videoEncoder.close();
    }
  }

  return encodeViaMediaRecorder(
    frames,
    totalFrames,
    width,
    height,
    encWidth,
    encHeight,
    effectiveFps,
    'video/webm',
    options.onProgress,
    options.isCancelled,
  );
}

async function waitForEncoderQueue(encoder: VideoEncoder, isCancelled?: () => boolean) {
  // VideoEncoder accepts work faster than it necessarily processes it.  Keep a
  // small queue so long clips do not retain every VideoFrame in memory.
  while (encoder.encodeQueueSize > 2) {
    if (isCancelled?.()) throw new Error('录制导出已取消');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function encodeViaMediaRecorder(
  frames: FrameProvider,
  totalFrames: number,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  fps: number,
  mimeType: string,
  onProgress?: (progress: number) => void,
  isCancelled?: () => boolean,
): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const stream = canvas.captureStream(fps);
  const actualMimeType = MediaRecorder.isTypeSupported(mimeType)
    ? mimeType
    : MediaRecorder.isTypeSupported('video/webm')
    ? 'video/webm'
    : '';

  const recorder = new MediaRecorder(stream, actualMimeType ? { mimeType: actualMimeType } : undefined);
  const chunks: Blob[] = [];
  const stopTracks = () => stream.getTracks().forEach((track) => track.stop());

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const recordingPromise = new Promise<Uint8Array>((resolve, reject) => {
    recorder.onstop = async () => {
      try {
        const blob = new Blob(chunks, { type: actualMimeType || 'video/webm' });
        const buf = await blob.arrayBuffer();
        resolve(new Uint8Array(buf));
      } catch (err) {
        reject(err);
      } finally {
        stopTracks();
      }
    };
    recorder.onerror = (e) => {
      stopTracks();
      reject(e);
    };
  });

  try {
    recorder.start();

    const frameIntervalMs = 1000 / fps;
    for (let i = 0; i < totalFrames; i++) {
      if (isCancelled?.()) throw new Error('录制导出已取消');
      const source = Array.isArray(frames) ? frames[i] : await frames(i);
      const frame = source instanceof ImageData
        ? source
        : new ImageData(
            source as Uint8ClampedArray<ArrayBuffer>,
            sourceWidth,
            sourceHeight,
          );
      ctx.putImageData(frame, 0, 0, 0, 0, width, height);
      onProgress?.((i + 1) / totalFrames);
      await new Promise((r) => setTimeout(r, frameIntervalMs));
    }

    if (isCancelled?.()) throw new Error('录制导出已取消');
    recorder.stop();
    return recordingPromise;
  } catch (error) {
    stopTracks();
    if (recorder.state !== 'inactive') recorder.stop();
    throw error;
  }
}
