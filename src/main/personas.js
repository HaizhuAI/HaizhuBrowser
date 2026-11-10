'use strict';
// Coherent device personas — data layer.
//
// Sampling hardware axes independently produces machines that do not exist
// (4 cores + 32GB, Mac at 24-bit/1x, Android claiming D3D11). Detectors score
// the *combination*, so these pools bundle CPU/memory/GPU/screen/DPR/depth as
// one shippable unit, selected deterministically per profile seed.
//
// Data provenance: vendor-published strings (Chromium ANGLE outputs, stock OS
// font lists, system speech voices, GPU-class GL limits) — factual tables
// cross-checked against the OpenBrowser audit (docs/SECURITY-OPENBROWSER.md).
// All selection/derivation logic is HaizhuBrowser original.

const crypto = require('crypto');

/* ---------------- personas: hardware bundles ---------------- */

const WINDOWS_PERSONAS = [
  { os: 'windows', cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 1, screen: { width: 1920, height: 1080 },
    webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'intel', architecture: 'gen-9' } } },
  { os: 'windows', cores: 4, memory: 8, colorDepth: 24, devicePixelRatio: 1, screen: { width: 1366, height: 768 },
    webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) HD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'intel', architecture: 'gen-9' } } },
  { os: 'windows', cores: 12, memory: 8, colorDepth: 24, devicePixelRatio: 1, screen: { width: 1920, height: 1080 },
    webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ampere' } } },
  { os: 'windows', cores: 16, memory: 8, colorDepth: 24, devicePixelRatio: 1, screen: { width: 2560, height: 1440 },
    webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ada' } } },
  { os: 'windows', cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 1, screen: { width: 1920, height: 1080 },
    webgl: { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'amd', architecture: 'rdna-2' } } },
  { os: 'windows', cores: 6, memory: 8, colorDepth: 24, devicePixelRatio: 1, screen: { width: 1920, height: 1080 },
    webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'intel', architecture: 'gen-12' } } },
  { os: 'windows', cores: 12, memory: 8, colorDepth: 24, devicePixelRatio: 1.25, screen: { width: 2560, height: 1440 },
    webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ada' } } },
  { os: 'windows', cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 1.5, screen: { width: 2256, height: 1504 },
    webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'intel', architecture: 'gen-12' } } },
  { os: 'windows', cores: 16, memory: 8, colorDepth: 24, devicePixelRatio: 1, screen: { width: 1920, height: 1080 },
    webgl: { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon 780M Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'amd', architecture: 'rdna-3' } } },
  { os: 'windows', cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 1, screen: { width: 1920, height: 1200 },
    webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'turing' } } },
];

const MACOS_APPLE_PERSONAS = [
  { os: 'macos_arm', cores: 8, memory: 8, colorDepth: 30, devicePixelRatio: 2, screen: { width: 1440, height: 900 },
    webgl: { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)', gpu: { vendor: 'apple', architecture: 'common-3' } } },
  { os: 'macos_arm', cores: 10, memory: 8, colorDepth: 30, devicePixelRatio: 2, screen: { width: 1512, height: 982 },
    webgl: { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)', gpu: { vendor: 'apple', architecture: 'common-3' } } },
  { os: 'macos_arm', cores: 12, memory: 8, colorDepth: 30, devicePixelRatio: 2, screen: { width: 1728, height: 1117 },
    webgl: { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)', gpu: { vendor: 'apple', architecture: 'common-3' } } },
];

const MACOS_INTEL_PERSONAS = [
  { os: 'macos', cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 2, screen: { width: 1680, height: 1050 },
    webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics 655, Unspecified Version)', gpu: { vendor: 'intel', architecture: 'gen-9' } } },
  { os: 'macos', cores: 8, memory: 8, colorDepth: 30, devicePixelRatio: 2, screen: { width: 1728, height: 1117 },
    webgl: { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro 5500M, Unspecified Version)', gpu: { vendor: 'amd', architecture: 'rdna-1' } } },
  { os: 'macos', cores: 10, memory: 8, colorDepth: 30, devicePixelRatio: 2, screen: { width: 2560, height: 1440 },
    webgl: { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro Vega 56, Unspecified Version)', gpu: { vendor: 'amd', architecture: 'vega' } } },
];

const LINUX_PERSONAS = [
  { os: 'linux', cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 1, screen: { width: 1920, height: 1080 },
    webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)', gpu: { vendor: 'intel', architecture: 'gen-9' } } },
  { os: 'linux', cores: 12, memory: 8, colorDepth: 24, devicePixelRatio: 1, screen: { width: 2560, height: 1440 },
    webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL 4.6)', gpu: { vendor: 'nvidia', architecture: 'ampere' } } },
  { os: 'linux', cores: 4, memory: 8, colorDepth: 24, devicePixelRatio: 1, screen: { width: 1920, height: 1080 },
    webgl: { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon Graphics (radeonsi, renoir), OpenGL 4.6)', gpu: { vendor: 'amd', architecture: 'rdna-2' } } },
];

const ANDROID_PERSONAS = [
  { os: 'android', cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 3, screen: { width: 412, height: 915 },
    webgl: { vendor: 'Google Inc. (Qualcomm)', renderer: 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)', gpu: { vendor: 'qualcomm', architecture: 'adreno-700' } } },
  { os: 'android', cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 2.625, screen: { width: 412, height: 892 },
    webgl: { vendor: 'Google Inc. (Qualcomm)', renderer: 'ANGLE (Qualcomm, Adreno (TM) 730, OpenGL ES 3.2)', gpu: { vendor: 'qualcomm', architecture: 'adreno-700' } } },
  { os: 'android', cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 2.75, screen: { width: 393, height: 873 },
    webgl: { vendor: 'Google Inc. (ARM)', renderer: 'ANGLE (ARM, Mali-G710, OpenGL ES 3.2)', gpu: { vendor: 'arm', architecture: 'valhall' } } },
  { os: 'android', cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 3, screen: { width: 360, height: 800 },
    webgl: { vendor: 'Google Inc. (Samsung Electronics)', renderer: 'ANGLE (Samsung Electronics, Samsung Xclipse 920, OpenGL ES 3.2)', gpu: { vendor: 'samsung', architecture: 'rdna-2' } } },
];

const PERSONAS_BY_OS = Object.freeze({
  windows: WINDOWS_PERSONAS,
  macos: MACOS_INTEL_PERSONAS,
  macos_arm: MACOS_APPLE_PERSONAS,
  linux: LINUX_PERSONAS,
  android: ANDROID_PERSONAS,
});

/* ---------------- GPU-class WebGL limits ---------------- */

const WEBGL_GPU_LIMITS = {
  nvidia: {
    ada:     { texture: 32768, vertexUniform: 1024, varying: 32, pointSize: 1024, uboAlign: 256, uboSize: 65536, vBlocks: 14, fBlocks: 14, texUnits: 192 },
    ampere:  { texture: 32768, vertexUniform: 1024, varying: 32, pointSize: 1024, uboAlign: 256, uboSize: 65536, vBlocks: 14, fBlocks: 14, texUnits: 192 },
    turing:  { texture: 32768, vertexUniform: 1024, varying: 32, pointSize: 1024, uboAlign: 256, uboSize: 65536, vBlocks: 14, fBlocks: 14, texUnits: 192 },
  },
  amd: {
    'rdna-3': { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 1024, uboAlign: 256, uboSize: 65536, vBlocks: 14, fBlocks: 14, texUnits: 128 },
    'rdna-2': { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 1024, uboAlign: 256, uboSize: 65536, vBlocks: 14, fBlocks: 14, texUnits: 128 },
    'rdna-1': { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 1024, uboAlign: 256, uboSize: 65536, vBlocks: 14, fBlocks: 14, texUnits: 128 },
    'gcn-4':  { texture: 16384, vertexUniform: 4096, varying: 32, pointSize: 1024, uboAlign: 256, uboSize: 65536, vBlocks: 14, fBlocks: 14, texUnits: 128 },
    vega:     { texture: 16384, vertexUniform: 4096, varying: 32, pointSize: 1024, uboAlign: 256, uboSize: 65536, vBlocks: 14, fBlocks: 14, texUnits: 128 },
  },
  intel: {
    alchemist: { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 1024, uboAlign: 256, uboSize: 65536, vBlocks: 14, fBlocks: 14, texUnits: 96 },
    'gen-12':  { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 1024, uboAlign: 256, uboSize: 65536, vBlocks: 14, fBlocks: 14, texUnits: 96 },
    'gen-9':   { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 1024, uboAlign: 256, uboSize: 65536, vBlocks: 14, fBlocks: 14, texUnits: 96 },
    'gen-7':   { texture: 8192,  vertexUniform: 1024, varying: 32, pointSize: 1024, uboAlign: 256, uboSize: 65536, vBlocks: 14, fBlocks: 14, texUnits: 96 },
  },
  apple: {
    'common-3': { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 511, uboAlign: 256, uboSize: 65536, vBlocks: 12, fBlocks: 12, texUnits: 80 },
  },
  qualcomm: {
    'adreno-700': { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 1024, uboAlign: 64, uboSize: 65536, vBlocks: 14, fBlocks: 14, texUnits: 96 },
  },
  arm: {
    valhall: { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 1024, uboAlign: 64, uboSize: 65536, vBlocks: 14, fBlocks: 14, texUnits: 96 },
  },
  samsung: {
    'rdna-2': { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 1024, uboAlign: 256, uboSize: 65536, vBlocks: 14, fBlocks: 14, texUnits: 128 },
  },
};

// GL pname ids that a coerced adapter must answer for.
const GL_PARAM = {
  MAX_TEXTURE_SIZE: 3379,
  MAX_CUBE_MAP_TEXTURE_SIZE: 34076,
  MAX_RENDERBUFFER_SIZE: 34024,
  MAX_VIEWPORT_DIMS: 3386,
  MAX_VERTEX_UNIFORM_VECTORS: 36347,
  MAX_VARYING_VECTORS: 36348,
  MAX_FRAGMENT_UNIFORM_VECTORS: 36349,
  ALIASED_POINT_SIZE_RANGE: 33901,
  MAX_UNIFORM_BLOCK_SIZE: 35633,
  MAX_VERTEX_UNIFORM_BLOCKS: 35371,
  MAX_FRAGMENT_UNIFORM_BLOCKS: 35373,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 35661,
  MAX_COMBINED_UNIFORM_BLOCKS: 35374,
  UNIFORM_BUFFER_OFFSET_ALIGNMENT: 35380,
  UNMASKED_VENDOR_WEBGL: 37445,
  UNMASKED_RENDERER_WEBGL: 37446,
};

// Cap a persona's claimed limits by what the host GPU can actually do — a 32k
// NVIDIA claim on a 16k-cap host is a contradiction detectors check.
function gpuParamOverrides(gpu, hostPlatform = process.platform) {
  if (!gpu || !gpu.vendor) return null;
  const v = String(gpu.vendor).toLowerCase();
  const fam = WEBGL_GPU_LIMITS[v];
  if (!fam) return null;
  let arch = String(gpu.architecture || '').toLowerCase();
  if (v === 'intel') { const m = arch.match(/^gen-?(\d+)/); if (m) arch = 'gen-' + m[1]; }
  if (v === 'apple') arch = 'common-3';
  const e = fam[arch] || Object.values(fam)[0];
  if (!e) return null;
  let texture = e.texture, point = e.pointSize, uboAlign = e.uboAlign,
      uboSize = e.uboSize, vB = e.vBlocks, fB = e.fBlocks, texU = e.texUnits;
  const p = String(hostPlatform).toLowerCase();
  const hostMax = (p === 'darwin' || p === 'linux') ? 16384 : 32768;
  texture = Math.min(texture, hostMax);
  const host2 = p === 'darwin' ? { vb: 12, fb: 12, tex: 80 } : (p === 'linux' ? { vb: 14, fb: 14, tex: 96 } : null);
  if (host2) { vB = Math.min(vB, host2.vb); fB = Math.min(fB, host2.fb); texU = Math.min(texU, host2.tex); }
  const o = {};
  o[GL_PARAM.MAX_TEXTURE_SIZE] = texture;
  o[GL_PARAM.MAX_CUBE_MAP_TEXTURE_SIZE] = texture;
  o[GL_PARAM.MAX_RENDERBUFFER_SIZE] = texture;
  o[GL_PARAM.MAX_VIEWPORT_DIMS] = [texture, texture];
  o[GL_PARAM.MAX_VERTEX_UNIFORM_VECTORS] = e.vertexUniform;
  o[GL_PARAM.MAX_VARYING_VECTORS] = e.varying;
  o[GL_PARAM.ALIASED_POINT_SIZE_RANGE] = [1, point];
  o[GL_PARAM.MAX_UNIFORM_BLOCK_SIZE] = uboSize;
  o[GL_PARAM.MAX_VERTEX_UNIFORM_BLOCKS] = vB;
  o[GL_PARAM.MAX_FRAGMENT_UNIFORM_BLOCKS] = fB;
  o[GL_PARAM.MAX_COMBINED_TEXTURE_IMAGE_UNITS] = texU;
  o[GL_PARAM.UNIFORM_BUFFER_OFFSET_ALIGNMENT] = uboAlign;
  return o;
}

// Extensions exposing another GPU vendor must be filtered for the persona vendor.
function filterExtensions(names, gpuVendor) {
  if (!Array.isArray(names) || !gpuVendor) return names;
  const v = String(gpuVendor).toLowerCase();
  return names.filter((n) => {
    const s = String(n).toLowerCase();
    if (s.startsWith('nv_') && v !== 'nvidia') return false;
    if (s.startsWith('amd_') && v !== 'amd') return false;
    if (s.startsWith('intel_') && v !== 'intel') return false;
    if (s.startsWith('qcom_') && v !== 'qualcomm') return false;
    return true;
  });
}

/* ---------------- media devices ---------------- */

const MEDIA_DEVICES_BY_OS = Object.freeze({
  windows: [
    { input: 'Microphone Array (2- Realtek High Definition Audio)', output: 'Speaker/Headphone (2- Realtek High Definition Audio)', video: 'Integrated Camera' },
    { input: 'Microphone Array (Realtek High Definition Audio)', output: 'Speaker/Headphone (Realtek High Definition Audio)', video: 'Integrated Camera' },
    { input: 'Microphone Array (Realtek(R) Audio)', output: 'Speaker (Realtek(R) Audio)', video: 'Integrated Camera' },
    { input: 'Microphone Array (Conexant SmartAudio HD)', output: 'Speaker (Conexant SmartAudio HD)', video: 'Integrated Camera' },
    { input: 'Microphone Array (Synaptics Audio)', output: 'Speaker (Synaptics Audio)', video: 'Integrated Camera' },
  ],
  macos: [
    { input: 'Built-in Microphone', output: 'MacBook Pro Speakers', video: 'FaceTime HD Camera' },
    { input: 'Built-in Microphone', output: 'MacBook Air Speakers', video: 'FaceTime HD Camera' },
    { input: 'Built-in Microphone', output: 'Internal Speakers', video: 'FaceTime HD Camera' },
    { input: 'MacBook Pro Microphone', output: 'MacBook Pro Speakers', video: 'FaceTime HD Camera (Built-in)' },
    { input: 'Mac mini Microphone', output: 'Mac mini Speakers', video: 'FaceTime HD Camera' },
  ],
  linux: [
    { input: 'Built-in Audio Analog Stereo', output: 'Built-in Audio Analog Stereo', video: 'Integrated Camera' },
    { input: 'PulseAudio Internal Microphone', output: 'PulseAudio Internal Speaker', video: 'USB 2.0 Camera' },
  ],
  android: [
    { input: 'Built-in Audio', output: 'Built-in Speaker', video: 'Back Camera' },
    { input: 'Built-in Microphone', output: 'Speaker', video: 'Front Camera' },
    { input: 'Phone Microphone', output: 'Phone Speaker', video: 'Back Camera' },
    { input: 'Internal Audio Input', output: 'Internal Audio Output', video: 'Rear Camera' },
  ],
});

/* ---------------- speech voices (stock OS pools) ---------------- */

const WINDOWS_VOICES = [
  'Microsoft David - English (United States)|en-US', 'Microsoft Zira - English (United States)|en-US',
  'Microsoft Mark - English (United States)|en-US', 'Microsoft George - English (United Kingdom)|en-GB',
  'Microsoft Susan - English (United Kingdom)|en-GB', 'Microsoft Catherine - English (Australia)|en-AU',
  'Microsoft James - English (Australia)|en-AU', 'Microsoft Linda - English (Canada)|en-CA',
  'Microsoft Richard - English (Canada)|en-CA', 'Microsoft Sean - English (Ireland)|en-IE',
  'Microsoft Heera - English (India)|en-IN', 'Microsoft Ravi - English (India)|en-IN',
  'Microsoft Huihui - Chinese (Simplified, PRC)|zh-CN', 'Microsoft Yaoyao - Chinese (Simplified, PRC)|zh-CN',
  'Microsoft Kangkang - Chinese (Simplified, PRC)|zh-CN', 'Microsoft Hanhan - Chinese (Traditional, Taiwan)|zh-TW',
  'Microsoft Tracy - Chinese (Traditional, Hong Kong S.A.R.)|zh-HK', 'Microsoft Haruka - Japanese|ja-JP',
  'Microsoft Ichiro - Japanese|ja-JP', 'Microsoft Heami - Korean|ko-KR',
  'Microsoft Hortense - French|fr-FR', 'Microsoft Paul - French|fr-FR', 'Microsoft Julie - French (Canada)|fr-CA',
  'Microsoft Hedda - German|de-DE', 'Microsoft Stefan - German|de-DE',
  'Microsoft Helena - Spanish|es-ES', 'Microsoft Laura - Spanish|es-ES', 'Microsoft Sabina - Spanish (Mexico)|es-MX',
  'Microsoft Cosimo - Italian|it-IT', 'Microsoft Elsa - Italian|it-IT',
  'Microsoft Maria - Portuguese (Brazil)|pt-BR', 'Microsoft Daniel - Portuguese (Brazil)|pt-BR',
  'Microsoft Irina - Russian|ru-RU', 'Microsoft Pavel - Russian|ru-RU',
  'Microsoft Frank - Dutch|nl-NL', 'Microsoft Paulina - Polish|pl-PL', 'Microsoft Bengt - Swedish|sv-SE',
  'Microsoft Heidi - Finnish|fi-FI', 'Microsoft Jon - Norwegian|nb-NO', 'Microsoft Tolga - Turkish|tr-TR',
  'Microsoft Kalpana - Hindi|hi-IN', 'Microsoft Pattara - Thai|th-TH', 'Microsoft Andika - Indonesian|id-ID',
  'Microsoft Hoda - Arabic (Egypt)|ar-EG', 'Microsoft Asaf - Hebrew|he-IL', 'Microsoft Stefanos - Greek|el-GR',
  'Microsoft Filip - Czech|cs-CZ', 'Microsoft Szabolcs - Hungarian|hu-HU', 'Microsoft An - Vietnamese|vi-VN',
];
const MACOS_VOICES = [
  'Alex|en-US', 'Samantha|en-US', 'Victoria|en-US', 'Fred|en-US', 'Junior|en-US', 'Kathy|en-US',
  'Daniel|en-GB', 'Kate|en-GB', 'Oliver|en-GB', 'Serena|en-GB', 'Moira|en-IE', 'Fiona|en-GB',
  'Karen|en-AU', 'Lee|en-AU', 'Tessa|en-ZA',
  'Ting-Ting|zh-CN', 'Sin-ji|zh-HK', 'Mei-Jia|zh-TW',
  'Kyoko|ja-JP', 'Otoya|ja-JP', 'Yuna|ko-KR',
  'Thomas|fr-FR', 'Amelie|fr-CA', 'Audrey|fr-FR',
  'Anna|de-DE', 'Helena|de-DE', 'Markus|de-DE',
  'Monica|es-ES', 'Paulina|es-MX', 'Jorge|es-ES',
  'Alice|it-IT', 'Luca|it-IT', 'Luciana|pt-BR', 'Joana|pt-PT',
  'Milena|ru-RU', 'Yuri|ru-RU', 'Xander|nl-NL', 'Ellen|nl-BE',
  'Alva|sv-SE', 'Oskar|sv-SE', 'Satu|fi-FI', 'Nora|nb-NO', 'Zosia|pl-PL', 'Zuzana|cs-CZ',
  'Lekha|hi-IN', 'Kanya|th-TH', 'Damayanti|id-ID', 'Melina|el-GR', 'Carmit|he-IL',
  'Maged|ar-SA', 'Tarik|ar-SA',
];
const ANDROID_VOICES = [
  'English (United States)|en-US', 'English (United Kingdom)|en-GB', 'English (Australia)|en-AU',
  'English (India)|en-IN', 'Chinese (China)|zh-CN', 'Chinese (Taiwan)|zh-TW', 'Chinese (Hong Kong)|zh-HK',
  'Japanese (Japan)|ja-JP', 'Korean (South Korea)|ko-KR', 'French (France)|fr-FR', 'German (Germany)|de-DE',
  'Spanish (Spain)|es-ES', 'Italian (Italy)|it-IT', 'Portuguese (Brazil)|pt-BR', 'Russian (Russia)|ru-RU',
  'Dutch (Netherlands)|nl-NL', 'Polish (Poland)|pl-PL', 'Swedish (Sweden)|sv-SE', 'Finnish (Finland)|fi-FI',
  'Norwegian Bokmål (Norway)|nb-NO', 'Danish (Denmark)|da-DK', 'Czech (Czechia)|cs-CZ',
  'Hungarian (Hungary)|hu-HU', 'Turkish (Turkey)|tr-TR', 'Greek (Greece)|el-GR', 'Hebrew (Israel)|he-IL',
  'Hindi (India)|hi-IN', 'Indonesian (Indonesia)|id-ID', 'Thai (Thailand)|th-TH',
  'Vietnamese (Vietnam)|vi-VN', 'Arabic (Saudi Arabia)|ar-SA', 'Ukrainian (Ukraine)|uk-UA',
];
const GOOGLE_VOICES = [
  'Google US English|en-US', 'Google UK English Female|en-GB', 'Google UK English Male|en-GB',
  'Google 普通话（中国大陆）|zh-CN', 'Google 粤語（香港）|zh-HK', 'Google 國語（臺灣）|zh-TW',
  'Google 日本語|ja-JP', 'Google 한국의|ko-KR', 'Google français|fr-FR', 'Google Deutsch|de-DE',
  'Google español|es-ES', 'Google español de Estados Unidos|es-US', 'Google italiano|it-IT',
  'Google português do Brasil|pt-BR', 'Google русский|ru-RU', 'Google Nederlands|nl-NL',
  'Google svenska|sv-SE', 'Google suomi|fi-FI', 'Google norsk bokmål|nb-NO', 'Google polski|pl-PL',
  'Google čeština|cs-CZ', 'Google हिन्दी|hi-IN', 'Google ไทย|th-TH', 'Google Bahasa Indonesia|id-ID',
  'Google ελληνικά|el-GR', 'Google עברית|he-IL', 'Google العربية|ar-SA',
];

function speechVoicesForOs(os, seedHex) {
  const fam = osFamily(os);
  let pool;
  if (fam === 'android') pool = ANDROID_VOICES.slice();
  else if (fam === 'macos') pool = MACOS_VOICES.concat(GOOGLE_VOICES);
  else if (fam === 'linux') pool = GOOGLE_VOICES.slice();
  else pool = WINDOWS_VOICES.concat(GOOGLE_VOICES);
  const seed = hashSeed(seedHex + '|voices');
  const count = Math.min(pool.length, 18 + (u32(seed, 4) % 15));
  // deterministic partial shuffle
  const order = pool.map((n, i) => ({ n, k: u32(seed, 8 + (i % 24)) + i }));
  order.sort((a, b) => a.k - b.k);
  return order.slice(0, count).map((o) => {
    const [name, lang] = o.n.split('|');
    return { name, lang, default: false, localService: !/^Google\s/i.test(name), voiceURI: name };
  });
}

/* ---------------- stock fonts ---------------- */

const OS_FONTS = Object.freeze({
  windows: Object.freeze([
    'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Cambria Math', 'Candara',
    'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Ebrima',
    'Franklin Gothic Medium', 'Gabriola', 'Gadugi', 'Georgia', 'Impact', 'Ink Free',
    'Javanese Text', 'Leelawadee UI', 'Lucida Console', 'Lucida Sans Unicode',
    'Malgun Gothic', 'Marlett', 'Microsoft Himalaya', 'Microsoft JhengHei',
    'Microsoft New Tai Lue', 'Microsoft PhagsPa', 'Microsoft Sans Serif', 'Microsoft Tai Le',
    'Microsoft YaHei', 'MingLiU-ExtB', 'Mongolian Baiti', 'MS Gothic', 'MV Boli',
    'Myanmar Text', 'Nirmala UI', 'Palatino Linotype', 'Segoe MDL2 Assets', 'Segoe Print',
    'Segoe Script', 'Segoe UI', 'Segoe UI Emoji', 'Segoe UI Historic', 'Segoe UI Symbol',
    'SimSun', 'Sitka', 'Sylfaen', 'Symbol', 'Tahoma', 'Times New Roman', 'Trebuchet MS',
    'Verdana', 'Webdings', 'Wingdings', 'Yu Gothic',
  ]),
  macos: Object.freeze([
    'American Typewriter', 'Andale Mono', 'Arial', 'Arial Black', 'Arial Narrow',
    'Arial Rounded MT Bold', 'Avenir', 'Avenir Next', 'Baskerville', 'Bodoni 72',
    'Bradley Hand', 'Brush Script MT', 'Chalkboard', 'Chalkboard SE', 'Chalkduster',
    'Charter', 'Cochin', 'Comic Sans MS', 'Copperplate', 'Courier', 'Courier New',
    'Didot', 'DIN Alternate', 'Futura', 'Geneva', 'Georgia', 'Gill Sans', 'Helvetica',
    'Helvetica Neue', 'Hoefler Text', 'Impact', 'Lucida Grande', 'Marker Felt', 'Menlo',
    'Monaco', 'Noteworthy', 'Optima', 'Palatino', 'Papyrus', 'Rockwell', 'Savoye LET',
    'SignPainter', 'Skia', 'Snell Roundhand', 'Tahoma', 'Times', 'Times New Roman',
    'Trebuchet MS', 'Verdana', 'Zapfino', 'PingFang SC', 'Hiragino Sans',
    'Apple SD Gothic Neo', 'Kohinoor Devanagari', 'Galvji',
  ]),
  linux: Object.freeze([
    'Abyssinica SIL', 'Cantarell', 'Courier 10 Pitch', 'DejaVu Sans', 'DejaVu Sans Mono',
    'DejaVu Serif', 'FreeMono', 'FreeSans', 'FreeSerif', 'Liberation Mono',
    'Liberation Sans', 'Liberation Serif', 'Nimbus Mono PS', 'Nimbus Roman',
    'Nimbus Sans', 'Noto Color Emoji', 'Noto Mono', 'Noto Sans', 'Noto Sans CJK SC',
    'Noto Serif', 'Ubuntu', 'Ubuntu Condensed', 'Ubuntu Mono', 'URW Bookman',
  ]),
  android: Object.freeze([
    'Roboto', 'Noto Sans', 'Noto Serif', 'Noto Color Emoji', 'Droid Sans',
    'Droid Sans Mono', 'Coming Soon', 'Dancing Script',
  ]),
});

function fontsForOs(os) {
  const fam = osFamily(os);
  return OS_FONTS[fam] || OS_FONTS.windows;
}

// Font-probe answers: families that exist on other OSes but NOT on the persona's.
// `document.fonts.check('12px "Helvetica Neue"')` must say no on a Windows persona.
function foreignFontsForOs(os) {
  const mine = new Set(fontsForOs(os).map((f) => f.toLowerCase()));
  const out = [];
  const seen = new Set();
  const fam = osFamily(os);
  for (const [k, list] of Object.entries(OS_FONTS)) {
    if ((fam === 'macos' && k === 'macos') || (fam !== 'macos' && k === 'macos' && fam === 'ios')) continue;
    if (k === fam || (fam !== 'macos' && k === 'ios')) continue;
    for (const n of list) {
      const l = n.toLowerCase();
      if (!mine.has(l) && !seen.has(l)) { seen.add(l); out.push(n); }
    }
  }
  if (fam !== 'macos') for (const n of ['Apple Color Emoji', 'Apple Symbols']) {
    const l = n.toLowerCase();
    if (!mine.has(l) && !seen.has(l)) { seen.add(l); out.push(n); }
  }
  return out;
}

/* ---------------- locale / timezone presets ---------------- */

const OS_LOCALES = Object.freeze({
  windows: [
    { timezone: 'America/New_York', languages: ['en-US', 'en'] },
    { timezone: 'America/Chicago', languages: ['en-US', 'en'] },
    { timezone: 'America/Los_Angeles', languages: ['en-US', 'en'] },
    { timezone: 'Europe/London', languages: ['en-GB', 'en'] },
    { timezone: 'Europe/Berlin', languages: ['de-DE', 'de', 'en'] },
    { timezone: 'Asia/Tokyo', languages: ['ja-JP', 'ja', 'en'] },
    { timezone: 'Asia/Shanghai', languages: ['zh-CN', 'zh'] },
  ],
  macos: [
    { timezone: 'America/Los_Angeles', languages: ['en-US', 'en'] },
    { timezone: 'America/New_York', languages: ['en-US', 'en'] },
    { timezone: 'Europe/London', languages: ['en-GB', 'en'] },
    { timezone: 'Europe/Paris', languages: ['fr-FR', 'fr', 'en'] },
    { timezone: 'Asia/Tokyo', languages: ['ja-JP', 'ja', 'en'] },
    { timezone: 'Asia/Shanghai', languages: ['zh-CN', 'zh'] },
  ],
  linux: [
    { timezone: 'America/New_York', languages: ['en-US', 'en'] },
    { timezone: 'Europe/London', languages: ['en-GB', 'en'] },
    { timezone: 'Europe/Berlin', languages: ['de-DE', 'de', 'en'] },
  ],
  android: [
    { timezone: 'America/New_York', languages: ['en-US', 'en'] },
    { timezone: 'America/Los_Angeles', languages: ['en-US', 'en'] },
    { timezone: 'Asia/Shanghai', languages: ['zh-CN', 'zh'] },
    { timezone: 'Europe/London', languages: ['en-GB', 'en'] },
  ],
});

// IANA name -> minutes-west-of-UTC (Date#getTimezoneOffset sign convention).
// Fixed offsets: DST-aware correctness would require a tz database; the fixed
// value is the dominant-season offset and stays stable per profile.
const TZ_OFFSETS = {
  'America/New_York': 300, 'America/Chicago': 360, 'America/Los_Angeles': 480,
  'Europe/London': 0, 'Europe/Berlin': -60, 'Europe/Paris': -60,
  'Asia/Tokyo': -540, 'Asia/Shanghai': -480,
};

/* ---------------- high-risk hosts for noise stability ---------------- */

const STABILITY_HOSTS = [
  'amazon.com', 'amazon.co.jp', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.it',
  'shopee.com', 'shopee.sg', 'shopee.co.id', 'shopee.tw', 'shopee.vn', 'shopee.ph',
  'lazada.com', 'lazada.sg', 'tiktok.com', 'bytedance.com',
  'ebay.com', 'ebay.co.uk', 'ebay.de', 'paypal.com', 'stripe.com',
  'binance.com', 'coinbase.com', 'okx.com', 'bybit.com',
  'facebook.com', 'instagram.com', 'x.com', 'linkedin.com',
  'google.com', 'accounts.google.com', 'gmail.com',
  'microsoft.com', 'login.live.com', 'apple.com', 'icloud.com',
];

/* ---------------- helpers ---------------- */

function hashSeed(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
function u32(buf, off) { return buf.readUInt32BE(off % (buf.length - 3)); }
function hex(seed, salt, n = 64) {
  return crypto.createHash('sha256').update(String(seed) + '|' + salt).digest('hex').slice(0, n);
}
function osFamily(os) {
  const k = String(os || '').toLowerCase();
  if (k.startsWith('macos') || k === 'darwin' || k === 'ios') return 'macos';
  if (k.includes('android')) return 'android';
  if (k.includes('linux')) return 'linux';
  return 'windows';
}
function personasForOs(os) {
  const k = String(os || 'windows').toLowerCase();
  return PERSONAS_BY_OS[k] || PERSONAS_BY_OS.windows;
}
function hostWebglMax(platform = process.platform) {
  const p = String(platform).toLowerCase();
  return (p === 'darwin' || p === 'linux') ? 16384 : 32768;
}
function isPersonaWebglCompatible(persona, hostPlatform = process.platform) {
  const gpu = persona && persona.webgl && persona.webgl.gpu;
  if (!gpu) return true;
  const v = String(gpu.vendor || '').toLowerCase();
  const a = String(gpu.architecture || '').toLowerCase();
  if (v === 'nvidia' && /ada|ampere|turing|40|30|20/.test(a)) return hostWebglMax(hostPlatform) >= 32768;
  return true;
}
function pickPersona(os, seedHex, hostPlatform = process.platform) {
  const pool = personasForOs(os);
  const compat = pool.filter((p) => isPersonaWebglCompatible(p, hostPlatform));
  const usable = compat.length ? compat : pool;
  const seed = hashSeed(seedHex + '|persona:' + os);
  const base = usable[u32(seed, 0) % usable.length];
  // deterministic taskbar perturbation -> availHeight
  const isMac = osFamily(base.os) === 'macos';
  const isMobile = base.os === 'android';
  const tb = isMobile ? 0 : (isMac ? 22 + (u32(seed, 8) % 7) : 36 + (u32(seed, 8) % 9));
  return {
    ...base,
    screen: { ...base.screen, availWidth: base.screen.width, availHeight: base.screen.height - tb },
    fonts: fontsForOs(base.os),
    foreignFonts: foreignFontsForOs(base.os),
  };
}
function isCoherent(persona) {
  if (!persona) return false;
  const { cores, memory, colorDepth, devicePixelRatio: dpr, os, webgl } = persona;
  if (!Number.isInteger(cores) || cores < 2 || cores > 64) return false;
  if (!Number.isInteger(memory) || memory < 4 || memory > 8) return false;
  if (cores >= 12 && memory < 8) return false;
  if (![24, 30].includes(colorDepth)) return false;
  const fam = osFamily(os);
  const r = String(webgl && webgl.renderer || '');
  if (fam === 'windows' && !/D3D11/.test(r)) return false;
  if (fam === 'macos' && (!/Metal/.test(r) || dpr < 2)) return false;
  if (fam === 'linux' && !/OpenGL/.test(r)) return false;
  if (os === 'android' && (!/OpenGL ES|Vulkan|Mali|Adreno|Xclipse/i.test(r) || dpr < 1.5)) return false;
  return dpr >= 1 && dpr <= (os === 'android' ? 4 : 3);
}
function seededBattery(seedHex) {
  const s = hashSeed(seedHex + '|battery');
  const charging = (u32(s, 4) % 5) !== 0;
  return {
    charging,
    chargingTime: charging ? 600 + (u32(s, 8) % 5400) : 0,
    dischargingTime: charging ? Infinity : 1800 + (u32(s, 12) % 14400),
    level: (55 + (u32(s, 0) % 40)) / 100,
  };
}
function seededMediaDevices(seedHex, os) {
  const fam = osFamily(os);
  const pool = MEDIA_DEVICES_BY_OS[fam] || MEDIA_DEVICES_BY_OS.windows;
  const s = hashSeed(seedHex + '|media');
  const tpl = pool[u32(s, 0) % pool.length];
  const groupId = hex(seedHex, 'group', 64);
  const usbTag = hex(seedHex, 'usb', 4) + ':' + hex(seedHex, 'usb2', 4);
  const video = fam === 'macos' ? tpl.video : (fam === 'android' ? tpl.video : `${tpl.video} (${usbTag})`);
  return [
    { kind: 'audioinput', label: tpl.input, deviceId: hex(seedHex, 'audioinput', 64), groupId },
    { kind: 'videoinput', label: video, deviceId: hex(seedHex, 'videoinput', 64), groupId },
    { kind: 'audiooutput', label: tpl.output, deviceId: hex(seedHex, 'audiooutput', 64), groupId },
  ];
}
function seededLocalIp(seedHex) {
  const s = hashSeed(seedHex + '|localip');
  const c = u32(s, 0) % 3;
  if (c === 0) return `10.${u32(s, 4) % 256}.${u32(s, 8) % 256}.${1 + (u32(s, 12) % 254)}`;
  if (c === 1) return `192.168.${u32(s, 4) % 256}.${1 + (u32(s, 8) % 254)}`;
  return `172.${16 + (u32(s, 4) % 16)}.${u32(s, 8) % 256}.${1 + (u32(s, 12) % 254)}`;
}
const DEVICE_PREFIX = ['DESKTOP', 'LAPTOP', 'PC', 'WIN', 'HOME', 'WORK', 'STUDIO', 'DEV'];
const DEVICE_SUFFIX = ['Alpha', 'Nova', 'Orbit', 'Pulse', 'Ridge', 'Summit', 'Vertex', 'Atlas', 'Cedar', 'Echo', 'Harbor', 'Jade', 'Kepler', 'Lumen', 'Maple', 'Nimbus'];
function seededDeviceName(seedHex) {
  const s = hashSeed(seedHex + '|devname');
  const n = 1000 + (u32(s, 8) % 9000);
  if ((u32(s, 12) % 3) === 0) return `${DEVICE_SUFFIX[u32(s, 4) % DEVICE_SUFFIX.length]}-${n}`;
  return `${DEVICE_PREFIX[u32(s, 0) % DEVICE_PREFIX.length]}-${DEVICE_SUFFIX[u32(s, 4) % DEVICE_SUFFIX.length]}${String(n).slice(0, 3)}`;
}
function localeFor(os, seedHex) {
  const fam = osFamily(os);
  const pool = OS_LOCALES[fam] || OS_LOCALES.windows;
  const s = hashSeed(seedHex + '|locale');
  const loc = pool[u32(s, 0) % pool.length];
  return { timezone: loc.timezone, tzOffset: TZ_OFFSETS[loc.timezone] ?? 0, languages: loc.languages.slice() };
}

module.exports = {
  PERSONAS_BY_OS, OS_FONTS, OS_LOCALES, STABILITY_HOSTS, WEBGL_GPU_LIMITS, GL_PARAM,
  pickPersona, isCoherent, isPersonaWebglCompatible, personasForOs,
  gpuParamOverrides, filterExtensions, fontsForOs, foreignFontsForOs,
  speechVoicesForOs, seededBattery, seededMediaDevices, seededLocalIp,
  seededDeviceName, localeFor, osFamily, hashSeed, u32, hex,
};
