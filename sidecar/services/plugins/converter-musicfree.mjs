/**
 * MusicFree 插件转换器。
 * 把 MusicFree 音源插件（module.exports = { platform, search, getMediaSource, getLyric, ... }）
 * 包装成 CeruMusic/树夏music 兼容的 music-source 模块，运行在同一套沙箱里。
 *
 * 覆盖范围：以 JSON 接口为主的常见插件。内置 axios / crypto-js / qs / he / dayjs 兼容层；
 * 依赖 cheerio 等网页解析库的插件会在运行时抛出明确错误（当前不支持）。
 */

export const MUSICFREE_ADAPTER_MARKER = '/* ceru-musicfree-adapter */'

const MF_QUALITYS = ['128k', '320k', 'flac', 'flac24bit']

function mfHash(input) {
  const text = String(input || '')
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return (hash >>> 0).toString(36)
}

function mfSlug(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24)
  return slug
}

function mfMatch(code, re) {
  const m = String(code || '').match(re)
  return m && m[1] ? m[1].trim() : ''
}

export function looksLikeMusicFreePlugin(code) {
  const text = String(code || '')
  const lower = text.toLowerCase()
  if (!lower.includes('getmediasource')) return false
  const hasExports = /module\.exports\s*=/.test(text) || /exports\s*\.\s*default\s*=/.test(text) || /exports\.default/.test(text)
  const hasMarkers =
    lower.includes('supportedsearchtype') ||
    lower.includes('srcurl') ||
    lower.includes('"platform"') ||
    lower.includes("'platform'") ||
    /\bplatform\s*:/.test(text)
  return hasExports && hasMarkers
}

export function isConvertedMusicFreePlugin(code) {
  return String(code || '').includes(MUSICFREE_ADAPTER_MARKER)
}

function extractMusicFreeMeta(code) {
  const text = String(code || '')
  const platform =
    mfMatch(text, /platform\s*:\s*["'`]([^"'`]+)["'`]/) ||
    mfMatch(text, /@name\s+(.+)/) ||
    'MusicFree音源'
  const version =
    mfMatch(text, /version\s*:\s*["'`]([^"'`]+)["'`]/) ||
    mfMatch(text, /@version\s+(.+)/) ||
    '1.0.0'
  const author =
    mfMatch(text, /author\s*:\s*["'`]([^"'`]+)["'`]/) ||
    mfMatch(text, /@author\s+(.+)/) ||
    'MusicFree'
  const slug = mfSlug(platform)
  const sourceId = 'mf_' + (slug || mfHash(platform))
  const pluginInfo = { name: platform, version, author, description: 'MusicFree 插件（兼容层加载）' }
  const supportedSources = {}
  supportedSources[sourceId] = { name: platform, type: 'music', qualitys: MF_QUALITYS }
  return { pluginInfo, supportedSources, sourceId }
}

export default function convertMusicFreePlugin(originalCode) {
  const meta = extractMusicFreeMeta(originalCode)
  const preamble = MUSICFREE_ADAPTER_MARKER + '\n' +
    '/**\n' +
    ' * 由 CeruMusic MusicFree 转换器转换\n' +
    ' * @name ' + meta.pluginInfo.name + '\n' +
    ' * @version ' + meta.pluginInfo.version + '\n' +
    ' * @author ' + meta.pluginInfo.author + '\n' +
    ' */\n' +
    'const pluginInfo = ' + JSON.stringify(meta.pluginInfo) + ';\n' +
    "const pluginType = 'music-source';\n" +
    'const supportedSources = ' + JSON.stringify(meta.supportedSources) + ';\n' +
    'const __MF_SOURCE_ID = ' + JSON.stringify(meta.sourceId) + ';\n' +
    'const originalMusicFreeCode = ' + JSON.stringify(String(originalCode || '')) + ';\n'
  return preamble + '\n' + MF_ADAPTER_RUNTIME
}

const MF_ADAPTER_RUNTIME = `
var __mfNodeCrypto = (function () { try { return require('crypto'); } catch (e) { return null; } })();

function __mfHeaderValue(headers, key) {
  if (!headers) return '';
  var lk = String(key).toLowerCase();
  for (var k in headers) { if (Object.prototype.hasOwnProperty.call(headers, k) && k.toLowerCase() === lk) return headers[k]; }
  return '';
}

var __mfQs = {
  stringify: function (obj) {
    if (!obj || typeof obj !== 'object') return '';
    var parts = [];
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k];
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v[i])); }
      else parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    }
    return parts.join('&');
  },
  parse: function (str) {
    var out = {}; str = String(str || '').replace(/^\\?/, '');
    if (!str) return out;
    var pairs = str.split('&');
    for (var i = 0; i < pairs.length; i++) {
      var pair = pairs[i]; var idx = pair.indexOf('=');
      var key = idx >= 0 ? pair.slice(0, idx) : pair; var val = idx >= 0 ? pair.slice(idx + 1) : '';
      try { out[decodeURIComponent(key)] = decodeURIComponent(val); } catch (e) { out[key] = val; }
    }
    return out;
  }
};

var __mfHe = {
  decode: function (s) {
    return String(s == null ? '' : s)
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/&#(\\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
      .replace(/&#[xX]([0-9a-fA-F]+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 16)); });
  },
  encode: function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
};

function __mfDayjs(input) {
  var d = input === undefined ? new Date() : new Date(input);
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return {
    format: function (fmt) {
      fmt = fmt || 'YYYY-MM-DDTHH:mm:ss';
      return String(fmt)
        .replace(/YYYY/g, d.getFullYear())
        .replace(/MM/g, pad(d.getMonth() + 1))
        .replace(/DD/g, pad(d.getDate()))
        .replace(/HH/g, pad(d.getHours()))
        .replace(/mm/g, pad(d.getMinutes()))
        .replace(/ss/g, pad(d.getSeconds()));
    },
    valueOf: function () { return d.getTime(); },
    unix: function () { return Math.floor(d.getTime() / 1000); },
    toDate: function () { return d; },
    year: function () { return d.getFullYear(); }
  };
}
function __mfBuildUrl(url, params) {
  if (!params) return url;
  var query = __mfQs.stringify(params);
  if (!query) return url;
  return url + (String(url).indexOf('?') >= 0 ? '&' : '?') + query;
}

async function __mfAxiosRequest(config) {
  config = config || {};
  var method = String(config.method || 'get').toUpperCase();
  var headers = Object.assign({}, config.headers || {});
  var url = __mfBuildUrl(config.url, config.params);
  var body = config.data;
  if (body && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof URLSearchParams)) {
    var ct = String(__mfHeaderValue(headers, 'content-type') || '');
    if (ct.indexOf('application/x-www-form-urlencoded') >= 0) {
      body = __mfQs.stringify(body);
    } else {
      body = JSON.stringify(body);
      if (!ct) headers['Content-Type'] = 'application/json';
    }
  }
  var res = await cerumusic.request(url, { method: method, headers: headers, body: body, timeout: config.timeout });
  var data = res ? res.body : undefined;
  if ((config.responseType === 'json' || config.responseType === undefined) && typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) {}
  }
  var status = res ? res.statusCode : 0;
  var out = { data: data, status: status, statusText: '', headers: res ? res.headers : {}, config: config, request: {} };
  if (status >= 400) {
    var err = new Error('Request failed with status code ' + status);
    err.response = out; err.config = config;
    throw err;
  }
  return out;
}

function __mfAxiosWith(base, url, cfg) {
  var c = Object.assign({}, base || {}, cfg || {});
  if (base && base.baseURL && url) c.url = base.baseURL + url; else c.url = url;
  if (base && base.headers) c.headers = Object.assign({}, base.headers, (cfg && cfg.headers) || {});
  return c;
}

function __mfMakeAxios(base) {
  base = base || {};
  var instance = function (a, b) {
    if (typeof a === 'string') return __mfAxiosRequest(__mfAxiosWith(base, a, b));
    var c = Object.assign({}, base, a || {});
    if (base.baseURL && c.url) c.url = base.baseURL + c.url;
    return __mfAxiosRequest(c);
  };
  instance.request = function (cfg) { return __mfAxiosRequest(Object.assign({}, base, cfg || {})); };
  ['get', 'delete', 'head', 'options'].forEach(function (m) {
    instance[m] = function (url, cfg) { var c = __mfAxiosWith(base, url, cfg); c.method = m; return __mfAxiosRequest(c); };
  });
  ['post', 'put', 'patch'].forEach(function (m) {
    instance[m] = function (url, data, cfg) { var c = __mfAxiosWith(base, url, cfg); c.method = m; c.data = data; return __mfAxiosRequest(c); };
  });
  instance.create = function (next) { return __mfMakeAxios(Object.assign({}, base, next || {})); };
  instance.interceptors = { request: { use: function () {} }, response: { use: function () {} } };
  instance.defaults = base;
  return instance;
}

var __mfAxios = __mfMakeAxios({});
var __mfCryptoJS = (function () {
  function WordArray(buf) { this._buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []); }
  function wa(buf) { return new WordArray(buf); }
  function toBuf(x) {
    if (x instanceof WordArray) return x._buf;
    if (Buffer.isBuffer(x)) return x;
    return Buffer.from(String(x == null ? '' : x), 'utf8');
  }
  var Hex = { parse: function (s) { return wa(Buffer.from(String(s), 'hex')); }, stringify: function (w) { return w._buf.toString('hex'); } };
  var Base64 = { parse: function (s) { return wa(Buffer.from(String(s), 'base64')); }, stringify: function (w) { return w._buf.toString('base64'); } };
  var Utf8 = { parse: function (s) { return wa(Buffer.from(String(s), 'utf8')); }, stringify: function (w) { return w._buf.toString('utf8'); } };
  var Latin1 = { parse: function (s) { return wa(Buffer.from(String(s), 'latin1')); }, stringify: function (w) { return w._buf.toString('latin1'); } };
  WordArray.prototype.toString = function (encoder) {
    if (!encoder || encoder === Hex) return this._buf.toString('hex');
    if (encoder === Base64) return this._buf.toString('base64');
    if (encoder === Utf8) return this._buf.toString('utf8');
    if (encoder === Latin1) return this._buf.toString('latin1');
    if (encoder && typeof encoder.stringify === 'function') return encoder.stringify(this);
    return this._buf.toString('hex');
  };
  function hashFactory(algo) {
    return function (msg) {
      if (!__mfNodeCrypto) throw new Error('crypto 模块不可用');
      return wa(__mfNodeCrypto.createHash(algo).update(toBuf(msg)).digest());
    };
  }
  function hmacFactory(algo) {
    return function (msg, key) {
      if (!__mfNodeCrypto) throw new Error('crypto 模块不可用');
      return wa(__mfNodeCrypto.createHmac(algo, toBuf(key)).update(toBuf(msg)).digest());
    };
  }
  function modeName(cfg) { return cfg && cfg.mode && cfg.mode._name ? cfg.mode._name : 'CBC'; }
  function aesEncrypt(message, key, cfg) {
    cfg = cfg || {};
    if (!__mfNodeCrypto) throw new Error('crypto 模块不可用');
    var keyBuf = toBuf(key);
    var ivBuf = cfg.iv ? toBuf(cfg.iv) : Buffer.alloc(16);
    var mode = modeName(cfg);
    var algo = 'aes-' + (keyBuf.length * 8) + '-' + (mode === 'ECB' ? 'ecb' : 'cbc');
    var cipher = __mfNodeCrypto.createCipheriv(algo, keyBuf, mode === 'ECB' ? null : ivBuf);
    var enc = Buffer.concat([cipher.update(toBuf(message)), cipher.final()]);
    return {
      ciphertext: wa(enc),
      toString: function (encoder) {
        if (encoder === Hex) return enc.toString('hex');
        if (encoder === Utf8) return enc.toString('utf8');
        return enc.toString('base64');
      }
    };
  }
  function aesDecrypt(cipher, key, cfg) {
    cfg = cfg || {};
    if (!__mfNodeCrypto) throw new Error('crypto 模块不可用');
    var keyBuf = toBuf(key);
    var ivBuf = cfg.iv ? toBuf(cfg.iv) : Buffer.alloc(16);
    var mode = modeName(cfg);
    var encBuf;
    if (typeof cipher === 'string') encBuf = Buffer.from(cipher, 'base64');
    else if (cipher instanceof WordArray) encBuf = cipher._buf;
    else if (cipher && cipher.ciphertext) encBuf = toBuf(cipher.ciphertext);
    else encBuf = toBuf(cipher);
    var algo = 'aes-' + (keyBuf.length * 8) + '-' + (mode === 'ECB' ? 'ecb' : 'cbc');
    var decipher = __mfNodeCrypto.createDecipheriv(algo, keyBuf, mode === 'ECB' ? null : ivBuf);
    return wa(Buffer.concat([decipher.update(encBuf), decipher.final()]));
  }
  return {
    MD5: hashFactory('md5'), SHA1: hashFactory('sha1'), SHA256: hashFactory('sha256'), SHA512: hashFactory('sha512'),
    HmacMD5: hmacFactory('md5'), HmacSHA1: hmacFactory('sha1'), HmacSHA256: hmacFactory('sha256'), HmacSHA512: hmacFactory('sha512'),
    AES: { encrypt: aesEncrypt, decrypt: aesDecrypt },
    enc: { Hex: Hex, Base64: Base64, Utf8: Utf8, Latin1: Latin1 },
    mode: { CBC: { _name: 'CBC' }, ECB: { _name: 'ECB' } },
    pad: { Pkcs7: { _name: 'Pkcs7' }, NoPadding: { _name: 'NoPadding' } },
    lib: { WordArray: { create: function (buf) { return wa(buf); } } }
  };
})();

function __mfRequire(name) {
  switch (String(name)) {
    case 'axios': return __mfAxios;
    case 'crypto-js': return __mfCryptoJS;
    case 'he': return __mfHe;
    case 'qs': return __mfQs;
    case 'dayjs': return __mfDayjs;
    case 'crypto': return __mfNodeCrypto;
    case 'buffer': return { Buffer: Buffer };
    case 'cheerio':
      throw new Error('当前不支持依赖 cheerio 的 MusicFree 插件（需要网页解析能力）');
    default:
      throw new Error('MusicFree 插件依赖了不受支持的模块: ' + name);
  }
}
var __mfPluginModule = null;
function __mfEnsureModule() {
  if (__mfPluginModule) return __mfPluginModule;
  var moduleObj = { exports: {} };
  var g = {}; g.globalThis = g; g.window = g; g.self = g; g.global = g;
  var envApi = { getUserVariables: function () { return {}; }, os: 'nodejs', lang: 'zh-CN', appVersion: (pluginInfo && pluginInfo.version) || '1.0.0' };
  g.env = envApi;
  var requireShim = function (name) { return __mfRequire(name); };
  try {
    var runner = new Function(
      'module', 'exports', 'require', 'console', 'globalThis', 'window', 'self', 'global',
      'env', 'process', 'Buffer', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'Promise', 'Math', 'Date', 'JSON',
      originalMusicFreeCode
    );
    runner(
      moduleObj, moduleObj.exports, requireShim, console, g, g, g, g,
      envApi, (typeof process !== 'undefined' ? process : { env: {} }), Buffer,
      setTimeout, clearTimeout, setInterval, clearInterval,
      URL, URLSearchParams, TextEncoder, TextDecoder, Promise, Math, Date, JSON
    );
  } catch (err) {
    throw new Error('MusicFree 插件初始化失败: ' + (err && err.message || err));
  }
  var mod = moduleObj.exports;
  if (mod && mod.default && typeof mod.default === 'object') mod = mod.default;
  if (!mod || typeof mod !== 'object') throw new Error('MusicFree 插件未导出有效模块');
  __mfPluginModule = mod;
  return mod;
}

function __mfArtist(item) {
  if (Array.isArray(item.artists)) return item.artists.map(function (a) { return a && (a.name || a); }).filter(Boolean).join(' / ');
  return item.artist || item.singer || '';
}

function __mfNormalizeSong(item) {
  if (!item || typeof item !== 'object') return item;
  var id = item.id != null ? String(item.id) : (item.songmid != null ? String(item.songmid) : '');
  var artist = __mfArtist(item);
  var album = (item.album && item.album.name) || item.album || item.albumName || '';
  var artwork = item.artwork || item.img || item.pic || item.coverImg || '';
  return {
    id: id, songmid: id,
    name: item.title || item.name || '未知歌曲', title: item.title || item.name || '',
    singer: artist || '未知歌手', artist: artist,
    albumName: album, album: album,
    img: artwork, artwork: artwork,
    interval: item.duration || item.interval || '',
    source: __MF_SOURCE_ID, platform: __MF_SOURCE_ID,
    _mf: item
  };
}

function __mfUnwrap(songInfo) {
  if (songInfo && typeof songInfo === 'object') return songInfo._mf || songInfo;
  return songInfo;
}

function __mfPickSongInfo(a, b) {
  if (b && typeof b === 'object') return b;
  if (a && typeof a === 'object') return a;
  return {};
}

function __mfMapQuality(q) {
  q = String(q || '').toLowerCase();
  if (q === '128k' || q === 'low' || q === '128') return 'low';
  if (q === '320k' || q === 'standard' || q === '320') return 'standard';
  if (q === 'flac' || q === 'high' || q === 'lossless') return 'high';
  return 'super';
}

async function search(keyword, page, limit) {
  var mod = __mfEnsureModule();
  if (typeof mod.search !== 'function') return { result: { songs: [], songCount: 0 } };
  var res = await mod.search(String(keyword || ''), Number(page) || 1, 'music');
  var data = [];
  if (Array.isArray(res)) data = res;
  else if (res && Array.isArray(res.data)) data = res.data;
  else if (res && Array.isArray(res.list)) data = res.list;
  else if (res && res.data && Array.isArray(res.data.list)) data = res.data.list;
  var songs = data.map(__mfNormalizeSong);
  return { result: { songs: songs, songCount: songs.length } };
}

async function musicUrl(source, songInfo, quality) {
  var mod = __mfEnsureModule();
  if (typeof mod.getMediaSource !== 'function') return '';
  var item = __mfUnwrap(songInfo);
  var res = await mod.getMediaSource(item, __mfMapQuality(quality));
  if (!res) return '';
  if (typeof res === 'string') return res;
  return res.url || res.url128 || res.url320 || res.flac || '';
}

async function getLyric(a, b) {
  var mod = __mfEnsureModule();
  if (typeof mod.getLyric !== 'function') return { lrc: '' };
  var item = __mfUnwrap(__mfPickSongInfo(a, b));
  var res = await mod.getLyric(item);
  if (!res) return { lrc: '' };
  if (typeof res === 'string') return { lrc: res, lyric: res };
  var rawLrc = res.rawLrc || res.lrc || res.lyric || '';
  var translation = res.translation || res.tlyric || res.trans || '';
  return { lrc: rawLrc, lyric: rawLrc, tlyric: translation, translation: translation, rawLrc: rawLrc };
}

module.exports = {
  pluginInfo: pluginInfo,
  pluginType: pluginType,
  sources: supportedSources,
  supportedSources: supportedSources,
  search: search,
  musicUrl: musicUrl,
  getLyric: getLyric
};
`;

