// Original artwork for the "show" in each screenshot: layered landscapes in
// SVG, so nothing here is anyone's footage or branding.
window.scene = function (kind) {
  const P = {
    dusk:   { sky: ['#1b1440', '#5b2a6e', '#d9576b', '#f6a96b'], sun: '#ffd7a0', hills: ['#3a2154', '#2a1842', '#1d1131', '#120a21'], water: true, stars: 0.35 },
    aurora: { sky: ['#030914', '#071a2e', '#0b3044', '#0f4a52'], sun: null, hills: ['#16313f', '#0f2431', '#0a1a24', '#050d14'], water: false, stars: 1, aurora: true },
    dunes:  { sky: ['#2b1a3a', '#8a3f5c', '#e8875a', '#ffd08a'], sun: '#fff1c7', hills: ['#c06a45', '#9a4c36', '#6e3329', '#41201d'], water: false, stars: 0.1, dunes: true },
  }[kind];
  const W = 1600, H = 900;
  const ridge = (y, amp, seed, smooth) => {
    let d = `M0 ${H} L0 ${y}`;
    for (let x = 0; x <= W; x += 40) {
      const n = Math.sin(x * 0.004 + seed) * amp + Math.sin(x * 0.011 + seed * 2.3) * amp * 0.45 + (smooth ? 0 : Math.sin(x * 0.037 + seed * 5.1) * amp * 0.12);
      d += ` L${x} ${(y - n).toFixed(1)}`;
    }
    return d + ` L${W} ${H} Z`;
  };
  let stars = '';
  for (let i = 0; i < 160 * P.stars; i++) {
    const x = (i * 9973) % W, y = (i * 7919) % (H * 0.5), r = ((i * 31) % 10) / 10 + 0.3;
    stars += `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" opacity="${0.25 + ((i * 17) % 60) / 100}"/>`;
  }
  const horizon = H * 0.62;
  const hills = P.hills.map((c, i) => `<path d="${ridge(horizon - 140 + i * 70, 70 - i * 10, i * 1.7 + 0.5, P.dunes)}" fill="${c}" ${i === 0 ? 'filter="url(#haze)"' : ''}/>`).join('');
  const aurora = P.aurora ? `<g filter="url(#blurBig)" opacity="0.85">
      <path d="M-100 260 C 300 120, 600 380, 900 200 S 1500 160, 1700 280 L1700 420 C 1300 300, 1000 470, 700 330 S 200 330, -100 420 Z" fill="url(#aur)"/>
      <path d="M-100 330 C 400 230, 700 430, 1100 300 S 1500 260, 1700 360 L1700 430 C 1200 360, 900 500, 500 400 S 100 400, -100 460 Z" fill="url(#aur2)" opacity="0.7"/></g>` : '';
  const sun = P.sun ? `<circle cx="${W * 0.62}" cy="${horizon - 90}" r="70" fill="${P.sun}"/><circle cx="${W * 0.62}" cy="${horizon - 90}" r="260" fill="url(#glow)"/>` : '';
  const water = P.water ? `<rect x="0" y="${horizon + 40}" width="${W}" height="${H}" fill="#1a1030"/>
      <g opacity="0.55" filter="url(#blurSmall)" transform="translate(0 ${2 * (horizon + 40)}) scale(1 -1)">${sun}</g>
      <g filter="url(#blurSmall)" opacity="0.9">${Array.from({ length: 14 }, (_, i) => `<ellipse cx="${W * 0.62 + Math.sin(i * 2.7) * 22}" cy="${horizon + 58 + i * 15}" rx="${90 - i * 5}" ry="1.6" fill="#ffd7a0" opacity="${0.55 - i * 0.035}"/>`).join('')}</g>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" style="position:absolute;inset:0;width:100%;height:100%">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">${P.sky.map((c, i) => `<stop offset="${i / (P.sky.length - 1) * 0.66}" stop-color="${c}"/>`).join('')}</linearGradient>
      <radialGradient id="glow"><stop offset="0" stop-color="${P.sun || '#fff'}" stop-opacity="0.55"/><stop offset="1" stop-color="${P.sun || '#fff'}" stop-opacity="0"/></radialGradient>
      <linearGradient id="aur" x1="0" x2="1"><stop offset="0" stop-color="#2cf5b0" stop-opacity="0"/><stop offset="0.35" stop-color="#2cf5b0"/><stop offset="0.7" stop-color="#5ad1ff"/><stop offset="1" stop-color="#a77bff" stop-opacity="0.2"/></linearGradient>
      <linearGradient id="aur2" x1="0" x2="1"><stop offset="0" stop-color="#7d5cff" stop-opacity="0"/><stop offset="0.5" stop-color="#36e6a6"/><stop offset="1" stop-color="#36e6a6" stop-opacity="0"/></linearGradient>
      <filter id="haze"><feGaussianBlur stdDeviation="1.5"/></filter>
      <filter id="blurSmall"><feGaussianBlur stdDeviation="6"/></filter>
      <filter id="blurBig"><feGaussianBlur stdDeviation="28"/></filter>
      <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.07 0"/></filter>
      <radialGradient id="vig" cx="0.5" cy="0.5" r="0.75"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.65"/></radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#sky)"/>${stars}${aurora}${sun}${hills}${water}
    <rect width="${W}" height="${H}" filter="url(#grain)"/><rect width="${W}" height="${H}" fill="url(#vig)"/>
  </svg>`;
};
