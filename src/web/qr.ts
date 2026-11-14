import { renderSVG } from "uqr";

/** Inline SVG QR (dark modules on white). Sized by CSS; no inline styles, so it passes the strict CSP. */
export function qrSvg(text: string): string {
  const svg = renderSVG(text, { border: 0, blackColor: "#0B0B0E", whiteColor: "#FFFFFF" });
  return svg.replace("<svg ", '<svg class="qr" role="img" aria-label="QR code for the payment address" ');
}
