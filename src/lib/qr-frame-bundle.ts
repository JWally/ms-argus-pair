const MAGIC = [0x41, 0x51, 0x52, 0x46] as const; // AQRF
const VERSION = 1;
const HEADER_BYTES = 8;
const FRAME_LENGTH_BYTES = 4;

export interface QrFrameBundle {
  frameMs: number;
  frames: Uint8Array[];
}

function asUint8Array(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : new Uint8Array(bytes);
}

export function packQrFrameBundle(bundle: QrFrameBundle): Uint8Array {
  if (!Number.isInteger(bundle.frameMs) || bundle.frameMs < 1 || bundle.frameMs > 65535) {
    throw new Error('invalid_qr_frame_ms');
  }
  if (
    !Number.isInteger(bundle.frames.length) ||
    bundle.frames.length < 1 ||
    bundle.frames.length > 255
  ) {
    throw new Error('invalid_qr_frame_count');
  }
  const totalBytes =
    HEADER_BYTES +
    bundle.frames.reduce((sum, frame) => sum + FRAME_LENGTH_BYTES + frame.byteLength, 0);
  const packed = new Uint8Array(totalBytes);
  packed.set(MAGIC, 0);
  packed[4] = VERSION;
  packed[5] = bundle.frames.length;
  new DataView(packed.buffer).setUint16(6, bundle.frameMs, false);

  let offset = HEADER_BYTES;
  const view = new DataView(packed.buffer);
  for (const frame of bundle.frames) {
    view.setUint32(offset, frame.byteLength, false);
    offset += FRAME_LENGTH_BYTES;
    packed.set(asUint8Array(frame), offset);
    offset += frame.byteLength;
  }
  return packed;
}

export function unpackQrFrameBundle(bytes: Uint8Array): QrFrameBundle {
  if (bytes.byteLength < HEADER_BYTES) throw new Error('invalid_qr_frame_bundle');
  for (let index = 0; index < MAGIC.length; index += 1) {
    // eslint-disable-next-line security/detect-object-injection -- bounded magic header compare.
    if (bytes[index] !== MAGIC[index]) throw new Error('invalid_qr_frame_bundle_magic');
  }
  if (bytes[4] !== VERSION) throw new Error('unsupported_qr_frame_bundle_version');
  const frameCount = bytes[5];
  const frameMs = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
    6,
    false
  );
  if (frameCount < 1) throw new Error('invalid_qr_frame_count');

  let offset = HEADER_BYTES;
  const frames: Uint8Array[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < frameCount; index += 1) {
    if (offset + FRAME_LENGTH_BYTES > bytes.byteLength)
      throw new Error('truncated_qr_frame_bundle');
    const frameLength = view.getUint32(offset, false);
    offset += FRAME_LENGTH_BYTES;
    if (offset + frameLength > bytes.byteLength) throw new Error('truncated_qr_frame_bundle');
    frames.push(bytes.slice(offset, offset + frameLength));
    offset += frameLength;
  }
  if (offset !== bytes.byteLength) throw new Error('trailing_qr_frame_bundle_bytes');
  return { frameMs, frames };
}
