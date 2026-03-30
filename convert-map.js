const fs = require('fs');

// Read GeoJSON
const data = JSON.parse(fs.readFileSync('japan.geojson', 'utf8'));

// Prefecture to region mapping
const regionMap = {
  'Hokkaido':  'Hokkaido', 'Hokkai Do': 'Hokkaido',
  'Aomori':    'Tohoku', 'Iwate':     'Tohoku', 'Miyagi':    'Tohoku',
  'Akita':     'Tohoku', 'Yamagata':  'Tohoku', 'Fukushima': 'Tohoku',
  'Ibaraki':   'Kanto',  'Tochigi':   'Kanto',  'Gunma':     'Kanto',
  'Saitama':   'Kanto',  'Chiba':     'Kanto',  'Tokyo':     'Kanto',  'Kanagawa': 'Kanto',
  'Niigata':   'Chubu',  'Toyama':    'Chubu',  'Ishikawa':  'Chubu',
  'Fukui':     'Chubu',  'Yamanashi': 'Chubu',  'Nagano':    'Chubu',
  'Gifu':      'Chubu',  'Shizuoka':  'Chubu',  'Aichi':     'Chubu',
  'Mie':       'Kansai', 'Shiga':     'Kansai', 'Kyoto':     'Kansai',
  'Osaka':     'Kansai', 'Hyogo':     'Kansai', 'Nara':      'Kansai', 'Wakayama': 'Kansai',
  'Tottori':   'Chugoku','Shimane':   'Chugoku','Okayama':   'Chugoku',
  'Hiroshima': 'Chugoku','Yamaguchi': 'Chugoku',
  'Tokushima': 'Shikoku','Kagawa':    'Shikoku','Ehime':     'Shikoku','Kochi': 'Shikoku',
  'Fukuoka':   'Kyushu', 'Saga':      'Kyushu', 'Nagasaki':  'Kyushu',
  'Kumamoto':  'Kyushu', 'Oita':      'Kyushu', 'Miyazaki':  'Kyushu',
  'Kagoshima': 'Kyushu',
  'Okinawa':   'Okinawa'
};

const regionColors = {
  Hokkaido: '#3366CC',
  Tohoku:   '#6699DD',
  Kanto:    '#228B44',
  Chubu:    '#8DB63C',
  Kansai:   '#DDCC22',
  Chugoku:  '#EE8822',
  Shikoku:  '#DD6699',
  Kyushu:   '#DD4444',
  Okinawa:  '#DD4444'
};

// Collect all coordinates to determine bounds
let allCoords = [];
data.features.forEach(f => {
  const processCoords = (coords) => {
    if (typeof coords[0] === 'number') {
      allCoords.push(coords);
    } else {
      coords.forEach(processCoords);
    }
  };
  processCoords(f.geometry.coordinates);
});

// Bounds (excluding extreme outlier islands for better framing)
// Filter: roughly main Japan area lat 24-46, lon 122-146
const filtered = allCoords.filter(c => c[1] >= 24 && c[1] <= 46 && c[0] >= 122 && c[0] <= 146);

const minLon = Math.min(...filtered.map(c => c[0]));
const maxLon = Math.max(...filtered.map(c => c[0]));
const minLat = Math.min(...filtered.map(c => c[1]));
const maxLat = Math.max(...filtered.map(c => c[1]));

console.log(`Bounds: lon ${minLon}-${maxLon}, lat ${minLat}-${maxLat}`);

// SVG dimensions - use Mercator projection
const padding = 20;
const DEG = Math.PI / 180;

function latToMerc(lat) {
  return Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2));
}

const mercMinY = latToMerc(minLat);
const mercMaxY = latToMerc(maxLat);
const mercH = mercMaxY - mercMinY;
const lonRad = (maxLon - minLon) * DEG;

// Both lon and lat need to use the same scale for proper aspect ratio
// Width in Mercator units = lonRange in radians, Height = mercH
// Fit into a target box
const targetH = 760;  // available height
const targetW = 400;  // available width

const scaleH = targetH / mercH;
const scaleW = targetW / lonRad;
const scale = Math.min(scaleH, scaleW);

const actualW = lonRad * scale;
const actualH = mercH * scale;
const svgWidth = Math.round(actualW + 2 * padding);
const svgHeight = Math.round(actualH + 2 * padding);

console.log(`SVG: ${svgWidth}x${svgHeight}, scale: ${scale}`);

function project(lon, lat) {
  const x = padding + (lon - minLon) * DEG * scale;
  const y = padding + (mercMaxY - latToMerc(lat)) * scale;
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
}

// Simplify path by skipping points that are very close together
function simplifyCoords(coords, minDist) {
  if (coords.length <= 2) return coords;
  const result = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    const prev = result[result.length - 1];
    const dx = coords[i][0] - prev[0];
    const dy = coords[i][1] - prev[1];
    if (Math.sqrt(dx * dx + dy * dy) >= minDist) {
      result.push(coords[i]);
    }
  }
  result.push(coords[coords.length - 1]);
  return result;
}

// Group features by region
const regions = {};
data.features.forEach(f => {
  const name = f.properties.nam || f.properties.name || f.properties.NAME || f.properties.nam_ja || '';
  // Try to match prefecture name
  let region = null;
  for (const [pref, reg] of Object.entries(regionMap)) {
    if (name.includes(pref) || name === pref) {
      region = reg;
      break;
    }
  }
  if (!region) {
    console.log('Unmatched:', name, Object.keys(f.properties));
    return;
  }
  if (!regions[region]) regions[region] = [];
  regions[region].push(f);
});

// Generate SVG paths for each region
function geometryToPaths(geometry) {
  const paths = [];

  // Calculate polygon area (shoelace formula) to filter tiny islands
  function polyArea(pts) {
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      area += pts[i][0] * pts[j][1];
      area -= pts[j][0] * pts[i][1];
    }
    return Math.abs(area) / 2;
  }

  function processPolygon(rings) {
    rings.forEach(ring => {
      let projected = ring.map(c => project(c[0], c[1]));
      projected = simplifyCoords(projected, 1.2);
      if (projected.length < 3) return;
      // Skip tiny islands (area less than 15 sq pixels)
      if (polyArea(projected) < 15) return;
      const d = projected.map((p, i) => (i === 0 ? 'M' : 'L') + p[0] + ',' + p[1]).join(' ') + ' Z';
      paths.push(d);
    });
  }

  if (geometry.type === 'Polygon') {
    processPolygon(geometry.coordinates);
  } else if (geometry.type === 'MultiPolygon') {
    geometry.coordinates.forEach(poly => processPolygon(poly));
  }
  return paths;
}

// Build SVG
let svg = `<svg class="japan-map" viewBox="0 0 ${svgWidth} ${svgHeight}" xmlns="http://www.w3.org/2000/svg">\n`;

// Region label positions (approximate centers)
const regionCenters = {};

const regionOrder = ['Hokkaido', 'Tohoku', 'Kanto', 'Chubu', 'Kansai', 'Chugoku', 'Shikoku', 'Kyushu', 'Okinawa'];

for (const regionName of regionOrder) {
  const features = regions[regionName];
  if (!features) continue;

  const color = regionColors[regionName];
  svg += `\n        <!-- ${regionName} -->\n`;
  svg += `        <g class="region" data-region="${regionName}">\n`;

  // Collect all projected points for center calculation
  let allPx = [], allPy = [];

  features.forEach(f => {
    const paths = geometryToPaths(f.geometry);
    paths.forEach(d => {
      svg += `          <path d="${d}" fill="${color}" stroke="#0f3460" stroke-width="0.5"/>\n`;
    });

    // Collect centers
    const processCoords2 = (coords) => {
      if (typeof coords[0] === 'number') {
        const [px, py] = project(coords[0], coords[1]);
        allPx.push(px);
        allPy.push(py);
      } else {
        coords.forEach(processCoords2);
      }
    };
    processCoords2(f.geometry.coordinates);
  });

  // Calculate center for label
  const cx = Math.round(allPx.reduce((a, b) => a + b, 0) / allPx.length);
  const cy = Math.round(allPy.reduce((a, b) => a + b, 0) / allPy.length);
  svg += `          <text x="${cx}" y="${cy}">${regionName}</text>\n`;

  svg += `        </g>\n`;
}

svg += `      </svg>`;

fs.writeFileSync('japan-map.svg', svg);
console.log('Generated japan-map.svg');
console.log('Regions found:', Object.keys(regions).join(', '));
Object.entries(regions).forEach(([r, f]) => console.log(`  ${r}: ${f.length} prefectures`));
