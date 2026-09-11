import { describe, it, expect } from 'vitest';
import { encodeFramesToMp4, encodeFramesToWebm } from './video_export';

if (typeof (globalThis as any).ImageData === 'undefined') {
  (globalThis as any).ImageData = class ImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

describe('video_export', () => {
  it('throws error for empty frame array in mp4 encoding', async () => {
    await expect(
      encodeFramesToMp4([], 100, 100, { fps: 15 })
    ).rejects.toThrow('无效的帧序列或画面尺寸');
  });

  it('throws error for invalid dimensions in webm encoding', async () => {
    const frame = new (globalThis as any).ImageData(new Uint8ClampedArray(400), 10, 10);
    await expect(
      encodeFramesToWebm([frame], 0, 100, { fps: 15 })
    ).rejects.toThrow('无效的帧序列或画面尺寸');
  });
});
