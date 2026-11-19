// Download buttons of the README (SVG, readable on light and dark pages). Usage: node scripts/make-buttons.cjs
const fs = require('fs');
const out = process.argv[2] || 'docs/images';
fs.mkdirSync(out, { recursive: true });
const icons = {
  // Generic glyphs (not the systems' logos): a monitor, a laptop, a terminal.
  windows: '<rect x="2" y="3" width="20" height="13" rx="1.5" fill="none" stroke="#fff" stroke-width="1.8"/><path d="M8 21h8M12 16v5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>',
  macos: '<rect x="4" y="4" width="16" height="11" rx="1.5" fill="none" stroke="#fff" stroke-width="1.8"/><path d="M1.5 18.5h21l-1.5 2h-18z" fill="#fff"/>',
  linux: '<rect x="2" y="3" width="20" height="18" rx="2" fill="none" stroke="#fff" stroke-width="1.8"/><path d="M6 9l3 3-3 3M11 15h6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
};
const buttons = [
  ['windows', 'Windows', 'Installer (.exe)'],
  ['macos', 'macOS', 'Disk image (.dmg)'],
  ['linux', 'Linux', 'AppImage'],
];
for (const [id, name, sub] of buttons) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="236" height="64" viewBox="0 0 236 64" role="img" aria-label="Download for ${name}">
  <rect width="236" height="64" rx="10" fill="#0a74b4"/>
  <rect x="1" y="1" width="234" height="62" rx="9" fill="none" stroke="#3fb6ef" stroke-opacity=".55"/>
  <g transform="translate(18 20)">${icons[id]}</g>
  <text x="56" y="29" fill="#fff" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="17" font-weight="600">Download for ${name}</text>
  <text x="56" y="47" fill="#d3ecfa" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="12.5">${sub}</text>
</svg>
`;
  fs.writeFileSync(`${out}/download-${id}.svg`, svg);
}
console.log('ok');
