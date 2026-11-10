import qrcode from 'qrcode-generator';

/**
 * OPS2: a QR code drawn here, in the browser, as inline SVG (no image request, no external service: the authenticator
 * secret it carries never leaves the page). One path of dark modules on a light square with a four-module quiet zone, so
 * it scans in the dark theme too.
 */
export function QrCode({ value, label, size = 220 }: { value: string; label: string; size?: number }) {
  const qr = qrcode(0, 'M');
  qr.addData(value, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  }
  const total = n + quiet * 2;
  return (
    <svg
      className="qr"
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
      data-modules={n}
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
