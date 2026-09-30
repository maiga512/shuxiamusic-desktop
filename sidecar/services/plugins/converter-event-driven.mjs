/**
 * 洛雪事件插件转换器。
 * 主结构对齐 Electron `src/main/services/plugin/manager/converter-event-driven.ts`。
 * Tauri 适配：pluginInfo 用 JSON.stringify；给混淆插件补 window/self/global 别名；
 * 额外导出 getLyric/search/request，方便 sidecar 把歌词和搜索转到同一套 requestHandler。
 */
export default function convertEventDrivenPlugin(originalCode) {
  const nameMatch = originalCode.match(/@name\s+(.+)/)
  const versionMatch = originalCode.match(/@version\s+(.+)/)
  const authorMatch = originalCode.match(/@author\s+(.+)/)
  const descMatch = originalCode.match(/@description\s+(.+)/)
  const homepageMatch = originalCode.match(/@homepage\s+(.+)/)
  const author = authorMatch ? authorMatch[1].trim() : 'Unknown'
  const pluginName = nameMatch ? nameMatch[1].trim() : '未知插件'
  const pluginVersion = versionMatch ? versionMatch[1].trim() : '1.0.0'
  const pluginDesc = descMatch ? descMatch[1].trim() : '从事件驱动插件转换而来'
  const pluginHomepage = homepageMatch ? homepageMatch[1].trim() : ''
  const pluginInfoLiteral = JSON.stringify({
    name: pluginName,
    version: pluginVersion,
    author,
    description: pluginDesc
  })
  const homepageLiteral = JSON.stringify(pluginHomepage)
  const originalCodeLiteral = JSON.stringify(originalCode)

  return `/**
 * 由 CeruMusic 插件转换器转换 - @author sqj
 * @name ${pluginName}
 * @author ${author}
 * @version ${pluginVersion}
 * @description ${pluginDesc}
 */

const pluginInfo = ${pluginInfoLiteral};
const pluginType = 'music-source';
const originalPluginCode = ${originalCodeLiteral};

let sources = {};

function getSourceName(sourceId) {
  const nameMap = {
    'kw': '酷我音乐',
    'kg': '酷狗音乐',
    'tx': 'QQ音乐',
    'wy': '网易云音乐',
    'mg': '咪咕音乐'
  };
  return nameMap[sourceId] || String(sourceId || '').toUpperCase() + '音乐';
}

function extractDefaultSources() {
  const qualityMatch = originalPluginCode.match(/const\\s+MUSIC_QUALITY\\s*=\\s*JSON\\.parse\\(([^)]+)\\)/);
  if (qualityMatch) {
    try {
      let qualityStr = qualityMatch[1].trim();
      if (qualityStr.startsWith("'") && qualityStr.endsWith("'")) {
        qualityStr = qualityStr.slice(1, -1);
      } else if (qualityStr.startsWith('"') && qualityStr.endsWith('"')) {
        qualityStr = qualityStr.slice(1, -1);
      }
      const qualityData = JSON.parse(qualityStr);
      const extractedSources = {};
      Object.keys(qualityData).forEach(sourceId => {
        extractedSources[sourceId] = {
          name: getSourceName(sourceId),
          type: 'music',
          qualitys: qualityData[sourceId] || ['128k', '320k']
        };
      });
      return extractedSources;
    } catch (e) {
      console.log('解析 MUSIC_QUALITY 失败:', e.message);
    }
  }

  return {
    kw: { name: "酷我音乐", type: "music", qualitys: ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'master'] },
    kg: { name: "酷狗音乐", type: "music", qualitys: ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'master'] },
    tx: { name: "QQ音乐", type: "music", qualitys: ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'master'] },
    wy: { name: "网易云音乐", type: "music", qualitys: ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'master'] },
    mg: { name: "咪咕音乐", type: "music", qualitys: ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'master'] }
  };
}

sources = extractDefaultSources();

let isInitialized = false;
let pluginSources = {};
let requestHandler = null;
let updateAlertSent = false;

function handleUpdateAlert(data, cerumusicApi) {
  if (updateAlertSent) {
    console.warn(\`[\${pluginInfo.name}] updateAlert 事件每次运行脚本只能调用一次，忽略重复调用\`);
    return;
  }

  if (!data || !data.log) {
    console.error(\`[\${pluginInfo.name}] updateAlert 事件缺少必需的 log 参数\`);
    return;
  }

  let log = String(data.log);
  let updateUrl = data.updateUrl ? String(data.updateUrl) : undefined;

  if (log.length > 1024) {
    log = log.substring(0, 1024);
    console.warn(\`[\${pluginInfo.name}] 更新日志超过 1024 字符，已截断\`);
  }

  if (updateUrl) {
    if (updateUrl.length > 1024) {
      updateUrl = updateUrl.substring(0, 1024);
      console.warn(\`[\${pluginInfo.name}] 更新地址超过 1024 字符，已截断\`);
    }

    if (!updateUrl.startsWith('http://') && !updateUrl.startsWith('https://')) {
      console.error(\`[\${pluginInfo.name}] updateUrl 必须是 HTTP 协议的 URL 地址\`);
      updateUrl = undefined;
    }
  }

  updateAlertSent = true;

  try {
    if (cerumusicApi && cerumusicApi.NoticeCenter) {
      cerumusicApi.NoticeCenter('update', {
        title: pluginInfo.name + ' 有新版本可用',
        content: log,
        url: updateUrl,
        pluginInfo: {
          name: pluginInfo.name,
          type: 'lx',
          forcedUpdate: false
        }
      });
    }
  } catch (error) {
    console.error(\`[\${pluginInfo.name}] 发送更新提示失败:\`, error.message);
  }
}

initializePlugin()
function initializePlugin() {
  if (isInitialized) return;

  const { request, utils } = cerumusic;

  const mockLx = {
    EVENT_NAMES: {
      request: 'request',
      inited: 'inited',
      updateAlert: 'updateAlert'
    },
    on: (event, handler) => {
      if (event === 'request') {
        requestHandler = handler;
      }
    },
    send: (event, data) => {
      if (event === 'inited' && data && data.sources) {
        pluginSources = data.sources;
        Object.keys(pluginSources).forEach(sourceId => {
          const sourceInfo = pluginSources[sourceId] || {};
          const originalQualitys = sources[sourceId] && sources[sourceId].qualitys;
          sources[sourceId] = {
            name: sourceInfo.name || getSourceName(sourceId),
            type: sourceInfo.type || 'music',
            qualitys: sourceInfo.qualitys || sourceInfo.qualities || originalQualitys || ['128k', '320k']
          };
        });
      } else if (event === 'updateAlert' && data) {
        handleUpdateAlert(data, cerumusic);
      }
    },
    request: request,
    utils: {
      buffer: utils && utils.buffer,
      crypto: {
        aesEncrypt: (data, mode, key, iv) => {
          try {
            return utils && utils.crypto ? utils.crypto.aesEncrypt(data, mode, key, iv) : data;
          } catch (e) {
            return data;
          }
        },
        md5: (str) => {
          try {
            return utils && utils.crypto ? utils.crypto.md5(str) : str;
          } catch (e) {
            return str;
          }
        },
        sha256: (str) => {
          try {
            return utils && utils.crypto ? utils.crypto.sha256(str) : str;
          } catch (e) {
            return str;
          }
        },
        randomBytes: (size) => {
          try {
            return utils && utils.crypto ? utils.crypto.randomBytes(size) : Buffer.alloc(size);
          } catch (e) {
            return Buffer.alloc(size);
          }
        },
        rsaEncrypt: (data, key) => {
          try {
            return utils && utils.crypto ? utils.crypto.rsaEncrypt(data, key) : data;
          } catch (e) {
            return data;
          }
        }
      }
    },
    version: '1.0.0',
    apiVersion: '1.0.0',
    currentScriptInfo: {
      rawScript: originalPluginCode,
      name: pluginInfo.name,
      version: pluginInfo.version,
      author: pluginInfo.author,
      description: pluginInfo.description,
      homepage: ${homepageLiteral}
    },
    env: 'nodejs'
  };

  const lxGlobal = {
    lx: mockLx
  };
  lxGlobal.globalThis = lxGlobal;
  lxGlobal.window = lxGlobal;
  lxGlobal.self = lxGlobal;
  lxGlobal.global = lxGlobal;

  try {
    const pluginFunction = new Function(
      'globalThis', 'window', 'self', 'global', 'lx', 'console', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'Buffer', 'JSON', 'require',
      'module', 'exports', 'process',
      originalPluginCode
    );

    pluginFunction(
      lxGlobal, lxGlobal, lxGlobal, lxGlobal, mockLx, console, setTimeout, clearTimeout,
      setInterval, clearInterval, Buffer, JSON, () => ({}),
      { exports: {} }, {}, { env: { NODE_ENV: 'production' } }
    );

    isInitialized = true;
  } catch (error) {
    console.log('[CeruMusic] 插件初始化完成: ' + (error && error.message || error));
    isInitialized = true;
  }
}

async function waitForRequestHandler(timeoutMs) {
  if (requestHandler) return requestHandler;
  initializePlugin();
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (!requestHandler && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return requestHandler;
}

async function callRequestHandler(payload, emptyMessage) {
  const handler = await waitForRequestHandler(800);

  if (!handler) {
    throw new Error('插件请求处理器未初始化');
  }

  const result = await handler(payload);
  if (!result) {
    throw new Error(emptyMessage);
  }
  if (typeof result === 'object' && result.error) {
    throw new Error(result.error || emptyMessage);
  }
  if (typeof result === 'object' && result.code && result.code !== 200) {
    throw new Error(result.msg || ('接口错误 (Code: ' + result.code + ')'));
  }
  return result;
}

async function musicUrl(source, musicInfo, quality) {
  return await callRequestHandler({
    source: source,
    action: 'musicUrl',
    info: {
      musicInfo: musicInfo,
      type: quality
    }
  }, '获取 ' + source + ' 音源链接失败: 返回结果为空');
}

async function getLyric(songInfo) {
  const handler = await waitForRequestHandler(800);
  if (!handler) {
    throw new Error('插件请求处理器未初始化');
  }
  const source = songInfo && songInfo.source || 'wy';
  const info = { musicInfo: songInfo, songInfo };
  let result = null;
  let lastError = null;
  for (const action of ['getLyric', 'lyric', 'musicLyric']) {
    try {
      result = await handler({ source, action, info });
      if (result) break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!result && lastError) throw lastError;
  if (!result) throw new Error('获取歌词失败: 返回结果为空');
  if (typeof result === 'object' && result.error) throw new Error(result.error);
  if (typeof result === 'string') return { lrc: { lyric: result } };
  return result;
}

async function search(keyword, page, limit) {
  const handler = await waitForRequestHandler(800);
  if (!handler) {
    throw new Error('插件请求处理器未初始化');
  }
  const result = await handler({
    source: 'all',
    action: 'search',
    info: { keyword, page, limit }
  });
  if (!result) return { result: { songs: [], songCount: 0 } };
  if (result.result) return result;
  if (Array.isArray(result)) return { result: { songs: result, songCount: result.length } };
  if (result.songs) return { result: { songs: result.songs, songCount: result.songs.length } };
  return { result: { songs: [], songCount: 0 } };
}

async function request(source, action, info) {
  return await callRequestHandler({ source, action, info }, '插件 ' + action + ' 返回空结果');
}

module.exports = {
  pluginInfo,
  pluginType,
  sources,
  supportedSources: sources,
  musicUrl,
  getLyric,
  search,
  request
};
`
}
