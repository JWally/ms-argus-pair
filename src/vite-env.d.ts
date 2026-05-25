/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MERCHANT_CPI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module 'qrcode-svg' {
  interface QRCodeOptions {
    content: string;
    padding?: number;
    width?: number;
    height?: number;
    color?: string;
    background?: string;
    ecl?: 'L' | 'M' | 'Q' | 'H';
    container?: 'svg' | 'svg-viewbox' | 'g' | 'none';
    join?: boolean;
    predefined?: boolean;
    pretty?: boolean;
    swap?: boolean;
    xmlDeclaration?: boolean;
    squareSizePercent?: number;
    mask?: boolean;
  }
  class QRCode {
    constructor(opts: QRCodeOptions | string);
    svg(opt?: { container?: QRCodeOptions['container'] }): string;
  }
  export default QRCode;
}
