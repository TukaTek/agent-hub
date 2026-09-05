import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceIconPath = path.join(root, "brand/cortexai-icon.png");
const sourceLogoPath = path.join(root, "brand/cortexai-logo.png");
const charcoal = "#231f20";
const orange = "#f7933b";

await Promise.all([
  mkdir(path.join(root, "apps/www/public/brand"), { recursive: true }),
  mkdir(path.join(root, "apps/desktop/assets"), { recursive: true }),
  mkdir(path.join(root, "apps/mobile/assets"), { recursive: true }),
  mkdir(path.join(root, "apps/web/public"), { recursive: true }),
]);

const sourceIcon = await readFile(sourceIconPath);
const logo720 = await sharp(sourceIcon)
  .resize({ width: 720, height: 720, fit: "contain", kernel: sharp.kernel.lanczos3 })
  .png()
  .toBuffer();
const logo760White = await sharp(sourceIcon)
  .resize({ width: 760, height: 760, fit: "contain", kernel: sharp.kernel.lanczos3 })
  .tint("#ffffff")
  .png()
  .toBuffer();

const appIcon = await sharp({
  create: { width: 1024, height: 1024, channels: 4, background: charcoal },
})
  .composite([{ input: logo720, gravity: "center" }])
  .png()
  .toBuffer();
const transparentIcon = await sharp({
  create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([{ input: logo720, gravity: "center" }])
  .png()
  .toBuffer();
const monochromeIcon = await sharp({
  create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([{ input: logo760White, gravity: "center" }])
  .png()
  .toBuffer();

async function writePng(relativePath, input, width, height = width) {
  const output = await sharp(input)
    .resize({ width, height, fit: "contain", kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();
  await writeFile(path.join(root, relativePath), output);
  return output;
}

await Promise.all([
  writeFile(path.join(root, "apps/desktop/assets/icon.png"), appIcon),
  writeFile(path.join(root, "apps/desktop/assets/icon-macos.png"), appIcon),
  writeFile(path.join(root, "apps/mobile/assets/icon.png"), appIcon),
  writeFile(path.join(root, "apps/mobile/assets/adaptive-icon.png"), transparentIcon),
  writeFile(path.join(root, "apps/mobile/assets/splash-icon.png"), transparentIcon),
  writeFile(path.join(root, "apps/mobile/assets/monochrome-icon.png"), monochromeIcon),
  writePng("apps/mobile/assets/notification-icon.png", monochromeIcon, 96),
  writePng("apps/mobile/assets/favicon.png", appIcon, 48),
  copyFile(sourceIconPath, path.join(root, "apps/www/public/brand/cortexai-icon.png")),
  copyFile(sourceLogoPath, path.join(root, "apps/www/public/brand/cortexai-logo.png")),
  mkdir(path.join(root, "apps/web/public/brand"), { recursive: true }).then(() =>
    copyFile(sourceIconPath, path.join(root, "apps/web/public/brand/cortexai-icon.png")),
  ),
]);

for (const app of ["web", "www"]) {
  const publicDir = `apps/${app}/public`;
  await Promise.all([
    writePng(`${publicDir}/favicon-16x16.png`, appIcon, 16),
    writePng(`${publicDir}/favicon-32x32.png`, appIcon, 32),
    writePng(`${publicDir}/apple-touch-icon.png`, appIcon, 180),
    writePng(`${publicDir}/icon-192.png`, appIcon, 192),
    writePng(`${publicDir}/icon-512.png`, appIcon, 512),
  ]);
  const embedded = sourceIcon.toString("base64");
  const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${charcoal}"/><image href="data:image/png;base64,${embedded}" x="10" y="10" width="44" height="44"/></svg>\n`;
  await writeFile(path.join(root, publicDir, "favicon.svg"), faviconSvg);
}

const icoPng = await sharp(appIcon).resize(256, 256).png().toBuffer();
const icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(1, 4);
icoHeader.writeUInt8(0, 6);
icoHeader.writeUInt8(0, 7);
icoHeader.writeUInt16LE(1, 10);
icoHeader.writeUInt16LE(32, 12);
icoHeader.writeUInt32LE(icoPng.length, 14);
icoHeader.writeUInt32LE(22, 18);
const ico = Buffer.concat([icoHeader, icoPng]);
await Promise.all([
  writeFile(path.join(root, "apps/desktop/assets/icon.ico"), ico),
  writeFile(path.join(root, "apps/web/public/favicon.ico"), ico),
  writeFile(path.join(root, "apps/www/public/favicon.ico"), ico),
]);

const icnsEntries = [];
for (const [type, size] of [
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
]) {
  const png = await sharp(appIcon).resize(size, size).png().toBuffer();
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32BE(png.length + 8, 4);
  icnsEntries.push(header, png);
}
const icnsBody = Buffer.concat(icnsEntries);
const icnsHeader = Buffer.alloc(8);
icnsHeader.write("icns", 0, "ascii");
icnsHeader.writeUInt32BE(icnsBody.length + 8, 4);
await writeFile(
  path.join(root, "apps/desktop/assets/icon.icns"),
  Buffer.concat([icnsHeader, icnsBody]),
);

async function socialCard(width, height) {
  const markSize = Math.round(height * 0.3);
  const mark = await sharp(sourceIcon).resize(markSize, markSize).png().toBuffer();
  const titleSize = Math.round(height * 0.105);
  const subtitleSize = Math.round(height * 0.038);
  const overlay =
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="${charcoal}"/>
    <circle cx="${Math.round(width * 0.86)}" cy="${Math.round(height * 0.2)}" r="${Math.round(height * 0.42)}" fill="${orange}" opacity="0.08"/>
    <text x="${Math.round(width * 0.12)}" y="${Math.round(height * 0.57)}" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="${titleSize}" font-weight="700">CortexAI Agent Hub</text>
    <text x="${Math.round(width * 0.12)}" y="${Math.round(height * 0.68)}" fill="#d7d2d0" font-family="Arial, Helvetica, sans-serif" font-size="${subtitleSize}">Personal, always-on AI assistants</text>
    <rect x="${Math.round(width * 0.12)}" y="${Math.round(height * 0.76)}" width="${Math.round(width * 0.16)}" height="4" rx="2" fill="${orange}"/>
  </svg>`);
  return sharp(overlay)
    .composite([{ input: mark, left: Math.round(width * 0.12), top: Math.round(height * 0.12) }])
    .png()
    .toBuffer();
}

await Promise.all([
  socialCard(1200, 630).then((buffer) =>
    writeFile(path.join(root, "apps/www/public/og-image.png"), buffer),
  ),
  socialCard(1280, 640).then((buffer) =>
    writeFile(path.join(root, "docs/readme-hero.png"), buffer),
  ),
]);

console.log("Generated CortexAI Agent Hub brand assets.");
