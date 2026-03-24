import sharp from "sharp";
import type { ImageData } from "./types.js";

export async function loadImageRaw(imagePath: string): Promise<ImageData> {
  const { data, info } = await sharp(imagePath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export function getPixel(img: ImageData, x: number, y: number): [number, number, number] {
  const idx = (y * img.width + x) * 3;
  return [img.data[idx]!, img.data[idx + 1]!, img.data[idx + 2]!];
}
