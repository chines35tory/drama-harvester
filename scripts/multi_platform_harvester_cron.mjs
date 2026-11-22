/**
 * UNIVERSAL MULTI-PLATFORM HARVESTER ENGINE
 * Platforms: Melolo, NetShort, DramaBox, PineWave, ReelTales, ShortMax, StarDust, FlexTV
 * Features:
 *   1. Smart Resume First (priority to unfinished archived dramas)
 *   2. Sequential Round-Robin across all 8 platforms from multi_platform_catalog_audit.json
 *   3. Cross-platform de-duplication & duplicate-immunity
 *   4. Native AES-128-CTR MP4 decryption (Melolo) & direct MP4/HLS muxing
 *   5. Automatic video compression (< 19.5 MB) for Telegram CDN
 *   6. 100% Publishing Gate (unarchive only when 100% episodes are in Telegram CDN)
 *   7. Queue audit state persistence (marks COMPLETED / SKIPPED so it never gets stuck)
 */

import { createClient } from '@supabase/supabase-js';
import { execFileSync, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

let ffmpegStatic = null;
try {
  const fModule = await import('ffmpeg-static');
  ffmpegStatic = fModule.default || fModule;
} catch {}

// Auto-load .env.local if present
if (fs.existsSync('.env.local')) {
  const envContent = fs.readFileSync('.env.local', 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

function readEnv(key, fallback = '') {
  return process.env[key] || fallback;
}

const SUPABASE_URL = readEnv('SUPABASE_URL', 'https://api.chinesestory.net');
const SUPABASE_SERVICE_ROLE_KEY = readEnv('SUPABASE_SERVICE_ROLE_KEY', '');
const TELEGRAM_BOT_TOKEN = readEnv('TELEGRAM_BOT_TOKEN', '');
const TELEGRAM_STORAGE_CHANNEL_ID = readEnv('TELEGRAM_STORAGE_CHANNEL_ID', '-1004333112987');

const MAX_FILE_SIZE_BYTES = 19.5 * 1024 * 1024;
const TEMP_DIR = path.resolve('scratch', 'harvester_proc');
const AUDIT_FILE_PATH = path.resolve('scripts', 'multi_platform_catalog_audit.json');
const QUEUE_DOC_PATH = path.resolve('ANTREAN_PANEN_MULTI_PLATFORM.md');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Resolve raw FFmpeg binary path
let FFMPEG_RAW_PATH = 'ffmpeg';
if (process.platform === 'win32') {
  if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
    FFMPEG_RAW_PATH = ffmpegStatic;
  } else {
    const fallbackWin = path.join(process.env.APPDATA || '', 'Python/Python314/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe');
    FFMPEG_RAW_PATH = fs.existsSync(fallbackWin) ? fallbackWin : 'ffmpeg';
  }
} else {
  try {
    const testFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    if (testFfmpeg.status === 0) {
      FFMPEG_RAW_PATH = 'ffmpeg';
    } else if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
      FFMPEG_RAW_PATH = ffmpegStatic;
    }
  } catch {
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) FFMPEG_RAW_PATH = ffmpegStatic;
  }
}

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanTitleText(raw) {
  if (!raw) return '';
  let title = raw.trim();
  let isDub = false;
  if (/^\s*\(dub\)/i.test(title)) {
    title = title.replace(/^\s*\(dub\)\s*/i, '').trim();
    isDub = true;
  }
  if (/\(sulih suara\)|sulih suara/i.test(title)) {
    title = title.replace(/\(sulih suara\)|sulih suara/gi, '').trim();
    isDub = true;
  }
  if (/\(dub indo\)|dub indo/i.test(title)) {
    title = title.replace(/\(dub indo\)|dub indo/gi, '').trim();
    isDub = true;
  }
  if (isDub) {
    title = `${title} (Dub Indo)`;
  }
  return title.replace(/\s+/g, ' ').trim();
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeTitleForCompare(raw) {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/\(sulih suara\)|\(dub indo\)|dub indo|sulih suara|sub indo|\(dub\)/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function getPlatformGenres(platform, cleanTitle) {
  const p = (platform || '').toLowerCase();
  let genres = ['Drama China'];

  if (p === 'melolo') genres.push('Melolo', 'Romantis');
  else if (p === 'netshort') genres.push('NetShort', 'Romantis');
  else if (p === 'dramabox') genres.push('DramaBox', 'Romantis');
  else if (p === 'pinewave') genres.push('PineWave', 'Romantis');
  else if (p === 'reeltales') genres.push('ReelTales', 'Romantis');
  else if (p === 'shortmax') genres.push('ShortMax', 'Romantis');
  else if (p === 'stardust') genres.push('StarDust', 'Romantis');
  else if (p === 'flextv') genres.push('FlexTV', 'Romantis');
  else if (p === 'vigloo') genres = ['Drama Barat', 'Western', 'Vigloo', 'Romantis'];
  else genres.push('Mini Series', 'Romantis');

  if (cleanTitle.includes('(Dub Indo)')) {
    genres.push('Dubbing');
  }

  return [...new Set(genres)].join(', ');
}

// --- ISO BMFF / MP4 DECRYPTION UTILITIES (FOR MELOLO) ---
function readU32(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function readU64(b, o) {
  return readU32(b, o) * 0x100000000 + readU32(b, o + 4);
}
function readTag(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}
function writeTag(b, o, tag) {
  for (let i = 0; i < 4; i++) {
    b[o + i] = tag.charCodeAt(i);
  }
}
function iterBoxes(buf, s, e) {
  const boxes = [];
  let off = s;
  while (off + 8 <= e) {
    const sz = readU32(buf, off);
    if (sz < 8 || off + sz > e) break;
    boxes.push({ offset: off, size: sz, tag: readTag(buf, off + 4), bodyOff: off + 8 });
    off += sz;
  }
  return boxes;
}
function findBox(buf, s, e, tag) {
  const boxes = iterBoxes(buf, s, e);
  for (let i = 0; i < boxes.length; i++) {
    if (boxes[i].tag === tag) return boxes[i];
  }
  return null;
}
function walkPath(buf, s, e, ...tags) {
  let cs = s, ce = e, found = null;
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    found = null;
    const boxes = iterBoxes(buf, cs, ce);
    for (let j = 0; j < boxes.length; j++) {
      if (boxes[j].tag === tag) {
        found = boxes[j];
        cs = found.bodyOff;
        ce = found.offset + found.size;
        break;
      }
    }
    if (!found) return null;
  }
  return found;
}

function parseMeloloSampleTable(buf, stblStart, stblEnd) {
  const stsz = findBox(buf, stblStart, stblEnd, 'stsz');
  const stsc = findBox(buf, stblStart, stblEnd, 'stsc');
  const stco = findBox(buf, stblStart, stblEnd, 'stco');
  const co64 = findBox(buf, stblStart, stblEnd, 'co64');
  const senc = findBox(buf, stblStart, stblEnd, 'senc');
  if (!stsz || !stsc || (!stco && !co64)) return null;

  const defaultSz = readU32(buf, stsz.bodyOff + 4);
  const n = readU32(buf, stsz.bodyOff + 8);
  const sizes = new Array(n);
  if (defaultSz === 0) {
    for (let i = 0; i < n; i++) sizes[i] = readU32(buf, stsz.bodyOff + 12 + i * 4);
  } else {
    for (let i = 0; i < n; i++) sizes[i] = defaultSz;
  }

  let chunkOffs;
  if (stco) {
    const cnt = readU32(buf, stco.bodyOff + 4);
    chunkOffs = new Array(cnt);
    for (let i = 0; i < cnt; i++) chunkOffs[i] = readU32(buf, stco.bodyOff + 8 + i * 4);
  } else {
    const cnt = readU32(buf, co64.bodyOff + 4);
    chunkOffs = new Array(cnt);
    for (let i = 0; i < cnt; i++) chunkOffs[i] = readU64(buf, co64.bodyOff + 8 + i * 8);
  }

  const ne = readU32(buf, stsc.bodyOff + 4);
  const entries = [];
  for (let i = 0; i < ne; i++) {
    entries.push({
      firstChunk: readU32(buf, stsc.bodyOff + 8 + i * 12),
      spc: readU32(buf, stsc.bodyOff + 12 + i * 12),
    });
  }

  const sampleOffs = [];
  let si = 0;
  for (let ci = 0; ci < chunkOffs.length && si < n; ci++) {
    let spc = 1;
    for (let j = 0; j < entries.length; j++) {
      if (ci + 1 >= entries[j].firstChunk) spc = entries[j].spc;
      else break;
    }
    let cur = chunkOffs[ci];
    for (let k = 0; k < spc && si < n; k++) {
      sampleOffs.push(cur);
      cur += sizes[si];
      si++;
    }
  }

  const ivs = [];
  const subsampleMap = [];
  if (senc) {
    const flags = (buf[senc.bodyOff + 1] << 16) | (buf[senc.bodyOff + 2] << 8) | buf[senc.bodyOff + 3];
    const cnt = readU32(buf, senc.bodyOff + 4);
    let off = senc.bodyOff + 8;
    for (let i = 0; i < cnt; i++) {
      ivs.push(buf.subarray(off, off + 8));
      off += 8;
      if (flags & 0x02) {
        const subCount = (buf[off] << 8) | buf[off + 1];
        off += 2;
        const subs = [];
        for (let j = 0; j < subCount; j++) {
          const clear = (buf[off] << 8) | buf[off + 1];
          const enc = readU32(buf, off + 2);
          subs.push({ clear, enc });
          off += 6;
        }
        subsampleMap.push(subs);
      }
    }
  }

  return { sampleOffs, sizes, ivs, subsamples: subsampleMap.length > 0 ? subsampleMap : null };
}

function parseAllMeloloTracks(buf, moov) {
  const tracks = [];
  const boxes = iterBoxes(buf, moov.bodyOff, moov.offset + moov.size);
  for (let i = 0; i < boxes.length; i++) {
    const trak = boxes[i];
    if (trak.tag !== 'trak') continue;
    const mdia = walkPath(buf, trak.bodyOff, trak.offset + trak.size, 'mdia');
    if (!mdia) continue;
    const hdlr = walkPath(buf, mdia.bodyOff, mdia.offset + mdia.size, 'hdlr');
    if (!hdlr) continue;
    const handler = readTag(buf, hdlr.offset + 16);
    if (handler !== 'vide' && handler !== 'soun') continue;
    const stbl = walkPath(buf, mdia.bodyOff, mdia.offset + mdia.size, 'minf', 'stbl');
    if (!stbl) continue;
    const track = parseMeloloSampleTable(buf, stbl.bodyOff, stbl.offset + stbl.size);
    if (track && track.ivs.length > 0) tracks.push(track);
  }
  return tracks;
}

function neutralizeDRM(buf, moovStart, moovEnd) {
  let videoFormat = 'hvc1';
  for (let i = moovStart; i + 8 <= moovEnd; i++) {
    if (buf[i] === 102 && buf[i + 1] === 114 && buf[i + 2] === 109 && buf[i + 3] === 97) {
      const c = String.fromCharCode(buf[i + 4], buf[i + 5], buf[i + 6], buf[i + 7]);
      if (c === 'avc1' || c === 'hvc1' || c === 'hev1') { videoFormat = c; break; }
      if (c === 'byte' || c === 'btvc') { videoFormat = 'hvc1'; break; }
    }
  }

  const rename = {
    encv: videoFormat,
    enca: 'mp4a',
    sinf: 'free',
    schm: 'free',
    schi: 'free',
    senc: 'free',
    saio: 'free',
    saiz: 'free',
    tenc: 'free',
    frma: 'free',
    pssh: 'free',
  };

  for (let i = moovStart + 4; i + 4 <= moovEnd; i++) {
    const tag = readTag(buf, i);
    if (tag in rename) {
      const sz = readU32(buf, i - 4);
      if (sz >= 8 && sz <= moovEnd - i + 4) {
        writeTag(buf, i, rename[tag]);
      }
    }
  }

  let off = 0;
  while (off + 8 <= buf.length) {
    const sz = readU32(buf, off);
    if (sz < 8 || off + sz > buf.length) break;
    const tag = readTag(buf, off + 4);
    if (tag === 'pssh') writeTag(buf, off + 4, 'free');
    off += sz;
  }
}

function decryptMeloloNode(buffer, keyHex) {
  const keyBytes = Buffer.from(keyHex, 'hex');
  const moov = walkPath(buffer, 0, buffer.length, 'moov');
  if (!moov) throw new Error('Box moov tidak ditemukan pada MP4 Melolo');

  const tracks = parseAllMeloloTracks(buffer, moov);

  for (let t = 0; t < tracks.length; t++) {
    const trk = tracks[t];
    const cnt = Math.min(trk.sampleOffs.length, trk.ivs.length);
    for (let i = 0; i < cnt; i++) {
      const counter = Buffer.alloc(16);
      counter.set(trk.ivs[i], 0);

      const off = trk.sampleOffs[i];
      const sz = trk.sizes[i];
      const subs = trk.subsamples && trk.subsamples[i];

      if (subs && subs.length > 0) {
        let curOff = off;
        const cipher = crypto.createCipheriv('aes-128-ctr', keyBytes, counter);
        for (let s = 0; s < subs.length; s++) {
          if (subs[s].clear > 0) curOff += subs[s].clear;
          if (subs[s].enc > 0) {
            const encSlice = buffer.subarray(curOff, curOff + subs[s].enc);
            const dec = cipher.update(encSlice);
            buffer.set(dec, curOff);
            curOff += subs[s].enc;
          }
        }
      } else {
        const cipher = crypto.createCipheriv('aes-128-ctr', keyBytes, counter);
        const encSlice = buffer.subarray(off, off + sz);
        const dec = cipher.update(encSlice);
        buffer.set(dec, off);
      }
    }
  }

  neutralizeDRM(buffer, moov.offset, moov.offset + moov.size);
  return buffer;
}

// --- TELEGRAM UPLOADER ---
async function uploadVideoToTelegram(filePath, captionText) {
  const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const absPath = path.resolve(filePath).replace(/\\/g, '/');
  const caption = captionText || 'Chinese Story Video Episode';

  // Probe metadata durasi dan resolusi secara cepat untuk Telegram Bot API
  let duration = null;
  let width = 720;
  let height = 1280;
  try {
    const probeRes = spawnSync(FFMPEG_RAW_PATH, ['-i', absPath], { encoding: 'utf8' });
    const durMatch = (probeRes.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (durMatch) {
      duration = Math.round(parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3]));
    }
    const resMatch = (probeRes.stderr || '').match(/Stream.*Video:.*,\s*(\d+)x(\d+)/);
    if (resMatch) {
      width = parseInt(resMatch[1], 10);
      height = parseInt(resMatch[2], 10);
    }
  } catch {}

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const args = [
        '-4',
        '-s',
        '--connect-timeout', '30',
        '--max-time', '300',
        '-F', `chat_id=${TELEGRAM_STORAGE_CHANNEL_ID}`,
        '-F', `caption=${caption}`,
        '-F', 'supports_streaming=true',
        '-F', `video=@${absPath};type=video/mp4`,
      ];

      if (duration && duration > 0) args.push('-F', `duration=${duration}`);
      if (width && height) {
        args.push('-F', `width=${width}`, '-F', `height=${height}`);
      }
      args.push(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVideo`);

      const resRaw = execFileSync(curlBin, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
      const data = JSON.parse(resRaw);

      if (data.ok && data.result) {
        const fileId = data.result.video?.file_id || data.result.document?.file_id;
        if (fileId) return fileId;
      }

      if (data.error_code === 429) {
        const retryAfter = data.parameters?.retry_after || 30;
        console.warn(`[Telegram 429 RateLimit] Tidur selama ${retryAfter} detik...`);
        await sleep(retryAfter * 1000);
        continue;
      }

      throw new Error(`Telegram response error: ${JSON.stringify(data)}`);
    } catch (err) {
      console.warn(`[Telegram Upload Attempt ${attempt}/3 Gagal]: ${err.message}`);
      if (attempt < 3) await sleep(5000);
      else throw err;
    }
  }
}

// --- FETCH WATCH PAGE & STREAM URLs ---
async function fetchWatchPageData(platform, bookId, epNum, coverUrl) {
  const encCover = encodeURIComponent(coverUrl || '');
  const targetUrl = `https://nunodrama.my.id/watch/${platform}/${bookId}?ep=${epNum}&c=${encCover}`;

  const res = await fetch(targetUrl, {
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8',
      'Referer': `https://nunodrama.my.id/detail/${platform}/${bookId}`,
      'Cookie': 'nuno_session=1',
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP error ${res.status} fetching watch page ep ${epNum}`);
  }

  const html = await res.text();

  // 1. Check for encrypted direct video (Melolo style)
  const keyMatch = html.match(/data-key="([^"]+)"/);
  const srcMatch = html.match(/data-(?:encrypt-url|src)="([^"]+)"/);
  const keyHex = keyMatch ? keyMatch[1] : null;

  let streamUrl = null;
  if (srcMatch && srcMatch[1]) {
    streamUrl = srcMatch[1].replace(/&amp;/g, '&');
  }

  // 2. Check for HLS m3u8 playlist or direct video
  if (!streamUrl) {
    const m3u8Match = html.match(/(https:\/\/go\.nunodrama\.my\.id\/api\/vigloo\/proxy_video\?[^"'\s<>]*quality=480p[^"'\s<>]*)/i) ||
                      html.match(/(https:\/\/go\.nunodrama\.my\.id\/api\/vigloo\/proxy_video\?[^"'\s<>]*\.m3u8[^"'\s<>]*)/i) ||
                      html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
    if (m3u8Match) {
      streamUrl = (m3u8Match[1] || m3u8Match[0]).replace(/&amp;/g, '&');
    }
  }

  // 3. Extract Subtitle URL if present (Komprehensif: NetShort id_ID / data-label Indonesia, WebVTT, Track)
  let subUrl = null;

  // Search inside <button ... data-sub-option ...>
  const subButtons = html.match(/<button[^>]*data-sub-option[^>]*>[\s\S]*?<\/button>/gi) || [];
  for (const btn of subButtons) {
    if (btn.includes('data-lang="off"')) continue;
    const isIndo = /data-lang=["'](id|id_id|indonesia)["']/i.test(btn) ||
                   /data-label=["']indonesia["']/i.test(btn) ||
                   />\s*Indonesia\s*</i.test(btn);
    if (isIndo) {
      const urlM = btn.match(/data-url=["']([^"']+)["']/i);
      if (urlM && urlM[1] && urlM[1].trim() !== '') {
        subUrl = urlM[1].replace(/&amp;/g, '&').trim();
        break;
      }
    }
  }

  // Fallback 1: Track tags with Indonesian lang
  if (!subUrl) {
    const trackMatch = html.match(/<track[^>]*src=["']([^"']+)["'][^>]*srclang=["'](id|id_ID|indonesia)["']/i) ||
                       html.match(/<track[^>]*srclang=["'](id|id_ID|indonesia)["'][^>]*src=["']([^"']+)["']/i);
    if (trackMatch) {
      subUrl = (trackMatch[1] || trackMatch[2]).replace(/&amp;/g, '&').trim();
    }
  }

  // Fallback 2: Vigloo proxy video subtitle
  if (!subUrl) {
    const viglooSubMatch = html.match(/(https:\/\/go\.nunodrama\.my\.id\/api\/vigloo\/proxy_video\?[^"'\s<>]*_id\.m3u8[^"'\s<>]*)/i);
    if (viglooSubMatch) {
      subUrl = (viglooSubMatch[1] || viglooSubMatch[0]).replace(/&amp;/g, '&').trim();
    }
  }

  // Ensure absolute URL if relative path
  if (subUrl && subUrl.startsWith('/')) {
    subUrl = `https://nunodrama.my.id${subUrl}`;
  }

  return { streamUrl, subUrl, keyHex };
}

// --- PROCESS EPISODE VIDEO (AUTO-DECRYPT & UNIVERSAL TRANSCODE) ---
async function downloadAndProcessEpisode(streamUrl, subUrl, keyHex, epNum) {
  const epPrefix = `ep_${epNum}_${Date.now()}`;
  const rawVideoPath = path.join(TEMP_DIR, `${epPrefix}_raw.mp4`);
  const finalVideoPath = path.join(TEMP_DIR, `${epPrefix}_final.mp4`);

  try {
    if (keyHex) {
      // Melolo AES-CTR Encrypted MP4 stream
      console.log(`  [Melolo Decrypt Ep ${epNum}] Mengunduh dan mendekripsi AES-128-CTR...`);
      let vidRes = await fetch(streamUrl, {
        headers: { 'User-Agent': BROWSER_USER_AGENT, Referer: 'https://nunodrama.my.id/' },
      });
      if (!vidRes.ok) {
        console.warn(`  [Direct CDN Gagal (${vidRes.status})], mencoba via NunoDrama proxy...`);
        vidRes = await fetch(`https://nunodrama.my.id/api/proxy/video?url=${encodeURIComponent(streamUrl)}`, {
          headers: { 'User-Agent': BROWSER_USER_AGENT, Referer: 'https://nunodrama.my.id/' },
        });
      }
      if (!vidRes.ok) throw new Error(`Gagal download stream video Melolo (${vidRes.status})`);

      const arrayBuf = await vidRes.arrayBuffer();
      const rawBuf = Buffer.from(arrayBuf);
      const decBuf = decryptMeloloNode(rawBuf, keyHex);
      fs.writeFileSync(rawVideoPath, decBuf);
    } else {
      // Check if it's direct MP4 or HLS m3u8 (dukung mime_type=video_mp4 untuk NetShort)
      const isDirectMp4 = (streamUrl.toLowerCase().includes('.mp4') || streamUrl.toLowerCase().includes('mime_type=video_mp4') || streamUrl.toLowerCase().includes('video_mp4')) &&
                          !streamUrl.toLowerCase().includes('.m3u8');

      if (isDirectMp4) {
        console.log(`  [Direct Stream Ep ${epNum}] Streaming langsung file MP4...`);
        const vidRes = await fetch(streamUrl, {
          headers: { 'User-Agent': BROWSER_USER_AGENT, Referer: 'https://nunodrama.my.id/' },
        });
        if (!vidRes.ok) throw new Error(`HTTP ${vidRes.status} downloading direct MP4`);
        await pipeline(Readable.fromWeb(vidRes.body), fs.createWriteStream(rawVideoPath));
      } else {
        // HLS Muxing via FFmpeg
        console.log(`  [HLS Mux Ep ${epNum}] Muxing HLS stream via FFmpeg...`);
        const ffmpegHeaders = `User-Agent: ${BROWSER_USER_AGENT}\r\nReferer: https://nunodrama.my.id/\r\n`;
        const muxArgs = [
          '-y',
          '-nostats',
          '-loglevel', 'error',
          '-headers', ffmpegHeaders,
          '-reconnect', '1',
          '-reconnect_streamed', '1',
          '-reconnect_delay_max', '5',
          '-i', streamUrl,
          '-c', 'copy',
          '-movflags', '+faststart',
          rawVideoPath,
        ];
        const muxRes = spawnSync(FFMPEG_RAW_PATH, muxArgs, {
          encoding: 'utf8',
          timeout: 360000,
          maxBuffer: 10 * 1024 * 1024,
        });
        if (muxRes.status !== 0 || !fs.existsSync(rawVideoPath)) {
          throw new Error(`FFmpeg muxing failed (${muxRes.status}): ${muxRes.stderr || 'No output'}`);
        }
      }
    }

    const rawFileSize = fs.statSync(rawVideoPath).size;
    console.log(`  [Diproses Ep ${epNum}] Ukuran mentah: ${(rawFileSize / (1024 * 1024)).toFixed(2)} MB`);

    // 🛡️ WAJIB STANDARDISASI UNIVERSAL DENGAN FFMPEG UNTUK SEMUA VIDEO (ANTI-LAYAR HITAM TELEGRAM)
    // -pix_fmt yuv420p, scale 720p, libx264 veryfast, maxrate 1100k, aac 96k, +faststart
    console.log(`  [Standardize Ep ${epNum}] Menstandarisasi video untuk pemutar Telegram & Web (< 19.5 MB)...`);
    const compressArgs = [
      '-y',
      '-nostats',
      '-loglevel', 'error',
      '-i', rawVideoPath,
      '-vf', "scale='min(720,iw)':-2",
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '27',
      '-maxrate', '1100k',
      '-bufsize', '1800k',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-ar', '44100',
      '-movflags', '+faststart',
      finalVideoPath,
    ];
    const compRes = spawnSync(FFMPEG_RAW_PATH, compressArgs, {
      encoding: 'utf8',
      timeout: 360000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (compRes.status !== 0 || !fs.existsSync(finalVideoPath)) {
      throw new Error(`FFmpeg compress failed (${compRes.status}): ${compRes.stderr}`);
    }
    try { fs.unlinkSync(rawVideoPath); } catch {}

    // Safety Pass: Pastikan file tidak tembus 19.5 MB jika durasi episode sangat panjang
    let compressedSize = fs.statSync(finalVideoPath).size;
    if (compressedSize > MAX_FILE_SIZE_BYTES) {
      console.log(`  [Second-Pass Cap Ep ${epNum}] Ukuran ${(compressedSize / (1024 * 1024)).toFixed(2)} MB > 19.5 MB, mengoptimalkan ulang...`);
      const pass2Path = path.join(TEMP_DIR, `${epPrefix}_pass2.mp4`);
      const pass2Args = [
        '-y',
        '-nostats',
        '-loglevel', 'error',
        '-i', finalVideoPath,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '30',
        '-maxrate', '800k',
        '-bufsize', '1200k',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '64k',
        '-movflags', '+faststart',
        pass2Path,
      ];
      spawnSync(FFMPEG_RAW_PATH, pass2Args);
      if (fs.existsSync(pass2Path) && fs.statSync(pass2Path).size < compressedSize) {
        try { fs.unlinkSync(finalVideoPath); } catch {}
        fs.renameSync(pass2Path, finalVideoPath);
      }
    }

    const finalSize = fs.statSync(finalVideoPath).size;
    console.log(`  ✅ Video Ep ${epNum} siap diunggah: ${(finalSize / (1024 * 1024)).toFixed(2)} MB (H.264 720p YUV420P)`);

    // Extract Subtitle if present
    let vttContent = null;
    if (subUrl) {
      if (subUrl.startsWith('/')) {
        subUrl = `https://nunodrama.my.id${subUrl}`;
      }
      try {
        console.log(`  📝 Mengambil subtitle dari ${subUrl.slice(0, 60)}...`);
        const subRes = await fetch(subUrl, {
          headers: { 'User-Agent': BROWSER_USER_AGENT, Referer: 'https://nunodrama.my.id/' },
        });
        if (subRes.ok) {
          const subText = await subRes.text();
          const rawSegmentLine = subText.split('\n').map((l) => l.trim()).find((l) => l.startsWith('http') || l.includes('.vtt') || l.includes('.cmft'));
          if (rawSegmentLine) {
            const vttSegmentLine = rawSegmentLine.replace(/&amp;/g, '&');
            const vttRes = await fetch(vttSegmentLine, {
              headers: { 'User-Agent': BROWSER_USER_AGENT, Referer: 'https://nunodrama.my.id/' },
            });
            if (vttRes.ok) {
              const body = await vttRes.text();
              if (body.includes('WEBVTT') || body.includes('-->')) {
                vttContent = body;
              }
            }
          } else if (subText.includes('WEBVTT') || subText.includes('-->')) {
            vttContent = subText;
          }
        }
      } catch (err) {
        console.warn(`  [Sub Warning] Gagal fetch subtitle ep ${epNum}:`, err.message);
      }

      // Fallback: Direct worker fetch if proxy fails or returns empty
      if (!vttContent && subUrl.includes('url=')) {
        try {
          const rawParam = subUrl.match(/url=([^&]+)/)?.[1];
          if (rawParam) {
            const directUrl = decodeURIComponent(rawParam);
            const vttRes2 = await fetch(directUrl, {
              headers: { 'User-Agent': BROWSER_USER_AGENT, Referer: 'https://nunodrama.my.id/' },
            });
            if (vttRes2.ok) {
              const body = await vttRes2.text();
              if (body.includes('WEBVTT') || body.includes('-->')) {
                vttContent = body;
              }
            }
          }
        } catch {}
      }
    }

    return { videoPath: finalVideoPath, vttContent };
  } catch (err) {
    try { if (fs.existsSync(rawVideoPath)) fs.unlinkSync(rawVideoPath); } catch {}
    try { if (fs.existsSync(finalVideoPath)) fs.unlinkSync(finalVideoPath); } catch {}
    throw err;
  }
}

// --- UPDATE AUDIT QUEUE AND MARKDOWN ---
function updateQueueStatus(auditData, bookId, platformId, newStatus, reason = '') {
  if (!auditData || !Array.isArray(auditData.roundRobinQueue)) return;
  const item = auditData.roundRobinQueue.find((x) => x.bookId === bookId && x.platformId === platformId);
  if (item) {
    item.status = newStatus;
    item.reason = reason;
    if (newStatus === 'COMPLETED') {
      item.completedAt = new Date().toISOString();
      if (auditData.summary) {
        auditData.summary.readyToHarvest = Math.max(0, (auditData.summary.readyToHarvest || 1) - 1);
        auditData.summary.alreadyPublished = (auditData.summary.alreadyPublished || 0) + 1;
      }
    }
  }

  try {
    fs.writeFileSync(AUDIT_FILE_PATH, JSON.stringify(auditData, null, 2), 'utf8');
    console.log(`💾 Antrean audit JSON diperbarui: ${platformId.toUpperCase()} - BookID ${bookId} -> [${newStatus}]`);
  } catch (e) {
    console.warn('⚠️ Gagal menyimpan JSON audit:', e.message);
  }
}

// --- MAIN ENGINE ---
async function main() {
  console.log('========================================================================');
  console.log('🚀 UNIVERSAL MULTI-PLATFORM HARVESTER ENGINE (CHINESESTORY)');
  console.log('🎯 ATURAN: 1 DRAMA PER SESI | SMART RESUME | ROUND-ROBIN | 100% GATE');
  console.log('========================================================================');

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ FATAL: SUPABASE_SERVICE_ROLE_KEY tidak ditemukan.');
    process.exit(1);
  }
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('❌ FATAL: TELEGRAM_BOT_TOKEN tidak ditemukan.');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // 1. Pre-flight Check: Tes Nadi API NunoDrama
  console.log('📡 Menjalankan Pre-flight Healthcheck NunoDrama...');
  try {
    const pingRes = await fetch('https://nunodrama.my.id/', {
      headers: { 'User-Agent': BROWSER_USER_AGENT },
    });
    if (!pingRes.ok) {
      console.warn(`⚠️ [Circuit Breaker] Server NunoDrama mengembalikan HTTP ${pingRes.status}. Sesi ditunda secara damai.`);
      process.exit(0);
    }
  } catch (err) {
    console.warn(`⚠️ [Circuit Breaker] Server NunoDrama unreachable (${err.message}). Sesi dibatalkan secara damai.`);
    process.exit(0);
  }
  console.log('✅ Server sumber aktif & responsif (HTTP 200).');

  // Load audit data
  let auditData = null;
  if (fs.existsSync(AUDIT_FILE_PATH)) {
    try {
      auditData = JSON.parse(fs.readFileSync(AUDIT_FILE_PATH, 'utf8'));
    } catch {}
  }

  // 2. PRIORITY 1: SMART RESUME (Cek apakah ada drama gantung di arsip Supabase)
  console.log('🔍 Memeriksa apakah ada drama gantung di arsip Supabase yang wajib diselesaikan...');
  const { data: incompleteDramas } = await supabase
    .from('dramas')
    .select('id, title, slug, poster_url, total_episodes, is_archived')
    .eq('is_archived', true)
    .order('created_at', { ascending: true });

  let selectedDramaItem = null;

  if (incompleteDramas && incompleteDramas.length > 0) {
    for (const d of incompleteDramas) {
      const { count } = await supabase
        .from('episodes')
        .select('id', { count: 'exact', head: true })
        .eq('drama_id', d.id);

      if (count > 0 && count < d.total_episodes) {
        console.log(`⚡ [SMART RESUME DITEMUKAN] Drama "${d.title}" baru memiliki ${count}/${d.total_episodes} episode.`);

        const { data: firstEp } = await supabase
          .from('episodes')
          .select('source_url')
          .eq('drama_id', d.id)
          .not('source_url', 'is', null)
          .limit(1);

        let bookId = null;
        let epPlatform = 'melolo';
        if (firstEp && firstEp.length > 0 && firstEp[0].source_url) {
          const parts = firstEp[0].source_url.split(':');
          if (parts.length >= 2) {
            epPlatform = parts[0];
            bookId = parts[1];
          }
        }

        if (!bookId && auditData?.roundRobinQueue) {
          const matched = auditData.roundRobinQueue.find((x) => x.normKey === normalizeTitleForCompare(d.title));
          if (matched) {
            bookId = matched.bookId;
            epPlatform = matched.platformId;
          }
        }

        if (bookId) {
          const nextEp = count + 1;
          try {
            console.log(`🔍 Memeriksa ketersediaan stream episode ${nextEp} untuk "${d.title}" (BookID: ${bookId}, Plat: ${epPlatform})...`);
            const testCheck = await fetchWatchPageData(epPlatform, bookId, nextEp, d.poster_url);
            if (!testCheck.streamUrl) {
              console.warn(`⚠️ [Smart Resume] Episode ${nextEp} mengembalikan stream kosong. Melewati drama "${d.title}" untuk sesi ini tanpa menghapus data...`);
              continue;
            }
          } catch (preErr) {
            console.warn(`⚠️ Pre-flight check gagal untuk ep ${nextEp} (${preErr.message}). Melewati sementara...`);
            continue;
          }

          selectedDramaItem = {
            Platform: epPlatform,
            BookID: bookId,
            BookName: d.title,
            Cover: d.poster_url,
            ChapterCount: d.total_episodes,
            dbId: d.id,
          };
          break;
        }
      }
    }
  }

  // 3. PRIORITY 2: AMBIL 1 DRAMA BERIKUTNYA DARI ANTREAN ROUND-ROBIN AUDIT
  if (!selectedDramaItem) {
    console.log('✨ Tidak ada drama gantung. Mengambil judul berikutnya dari antrean Round-Robin multi-platform...');

    const { data: publishedRows } = await supabase
      .from('dramas')
      .select('title, slug');

    const publishedTitles = new Set((publishedRows || []).map((x) => normalizeTitleForCompare(x.title)));
    const publishedSlugs = new Set((publishedRows || []).map((x) => x.slug));

    if (!auditData?.roundRobinQueue || auditData.roundRobinQueue.length === 0) {
      console.warn('⚠️ File antrean audit kosong. Menjalankan auto-scan untuk membangun antrean...');
      execFileSync('node', ['scripts/scan_multi_platform_catalog.mjs'], { stdio: 'inherit' });
      auditData = JSON.parse(fs.readFileSync(AUDIT_FILE_PATH, 'utf8'));
    }

    // Cari kandidat yang valid dan siap panen
    for (const qItem of auditData.roundRobinQueue) {
      if (qItem.status !== 'READY_TO_HARVEST') {
        continue;
      }

      const norm = normalizeTitleForCompare(qItem.cleanTitle || qItem.rawTitle);
      const sSlug = slugify(qItem.cleanTitle || qItem.rawTitle);

      if (publishedTitles.has(norm) || publishedSlugs.has(sSlug)) {
        console.log(`⏩ [Duplikasi Terlewati] "${qItem.cleanTitle}" sudah ada di database ChineseStory. Memperbarui status antrean...`);
        updateQueueStatus(auditData, qItem.bookId, qItem.platformId, 'ALREADY_PUBLISHED', 'Sudah ada di database');
        continue;
      }

      // Pre-flight check episode 1 di server sumber
      try {
        console.log(`🔍 Pre-flight check Episode 1 untuk [${qItem.platformName}] "${qItem.cleanTitle}" (BookID: ${qItem.bookId})...`);
        const testCheck = await fetchWatchPageData(qItem.platformId, qItem.bookId, 1, qItem.coverUrl);
        if (!testCheck.streamUrl) {
          console.warn(`⚠️ Episode 1 mengembalikan stream kosong di sumber. Melewati judul ini...`);
          updateQueueStatus(auditData, qItem.bookId, qItem.platformId, 'SKIPPED_UNAVAILABLE', 'Stream ep 1 tidak ditemukan');
          continue;
        }
      } catch (checkErr) {
        console.warn(`⚠️ Pre-flight check gagal (${checkErr.message}). Melewati judul ini...`);
        updateQueueStatus(auditData, qItem.bookId, qItem.platformId, 'SKIPPED_UNAVAILABLE', checkErr.message);
        continue;
      }

      selectedDramaItem = {
        Platform: qItem.platformId,
        BookID: qItem.bookId,
        BookName: qItem.cleanTitle || qItem.rawTitle,
        Cover: qItem.coverUrl,
        ChapterCount: qItem.totalEpisodes,
        dbId: null,
      };
      break;
    }
  }

  if (!selectedDramaItem) {
    console.log('ℹ️ Seluruh antrean multi-platform sudah tersimpan atau tidak ada yang valid. Sesi selesai.');
    process.exit(0);
  }

  // 4. EKSEKUSI PEMROSESAN DRAMA TERPILIH
  const dramaPlatform = selectedDramaItem.Platform;
  const cleanTitle = cleanTitleText(selectedDramaItem.BookName);
  const dramaSlug = slugify(cleanTitle);
  const totalEps = parseInt(selectedDramaItem.ChapterCount || 40, 10);
  const coverUrl = selectedDramaItem.Cover;
  const genreTags = getPlatformGenres(dramaPlatform, cleanTitle);

  console.log('\n========================================================================');
  console.log(`🎬 TARGET DRAMA: ${cleanTitle}`);
  console.log(`📁 Platform: ${dramaPlatform.toUpperCase()} | BookID: ${selectedDramaItem.BookID}`);
  console.log(`🔢 Total Episode: ${totalEps}`);
  console.log(`🏷️  Genre: ${genreTags}`);
  console.log(`🔗 Slug: ${dramaSlug}`);
  console.log('========================================================================\n');

  if (process.argv.includes('--dry-run')) {
    console.log('🔍 [DRY-RUN] Pre-flight dan pemilihan drama berhasil diverifikasi 100%. Keluar tanpa mengubah database.');
    process.exit(0);
  }

  // Ambil Sinopsis Resmi dari Detail Page
  let synopsis = `Streaming dan nonton gratis drama pendek ${cleanTitle} subtitle Indonesia full episode kualitas HD hanya di Chinese Story.`;
  try {
    const detailRes = await fetch(`https://nunodrama.my.id/detail/${dramaPlatform}/${selectedDramaItem.BookID}`, {
      headers: { 'User-Agent': BROWSER_USER_AGENT, 'Cookie': 'nuno_session=1' },
    });
    if (detailRes.ok) {
      const detailHtml = await detailRes.text();
      const synMatch = detailHtml.match(/"description":"([^"]+)"/i) ||
                       detailHtml.match(/<p[^>]*class="[^"]*text-gray-[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
      if (synMatch && synMatch[1]) {
        synopsis = synMatch[1].trim();
      }
    }
  } catch {}

  // Inisialisasi Drama di Supabase (Status awal: is_archived = true)
  let dramaId = selectedDramaItem.dbId || null;

  if (!dramaId) {
    const { data: existingRecord } = await supabase
      .from('dramas')
      .select('id, is_archived')
      .eq('slug', dramaSlug)
      .maybeSingle();

    if (existingRecord) {
      dramaId = existingRecord.id;
    } else {
      const { data: newDrama, error: insertDramaErr } = await supabase
        .from('dramas')
        .insert({
          title: cleanTitle,
          slug: dramaSlug,
          synopsis: synopsis,
          poster_url: coverUrl,
          banner_url: coverUrl,
          total_episodes: totalEps,
          genre: genreTags,
          status: 'Completed',
          is_archived: true, // 🛡️ 100% Publishing Gate
          archive_reason: 'Sedang proses harvest episode',
        })
        .select()
        .single();

      if (insertDramaErr) {
        console.error(`❌ Gagal inisialisasi drama ${cleanTitle}:`, insertDramaErr.message);
        process.exit(1);
      }
      dramaId = newDrama.id;
    }
  }

  // Cek episode yang sudah tersimpan untuk Smart Resume
  const { data: existingEps } = await supabase
    .from('episodes')
    .select('episode_number, earnvid_embed_url')
    .eq('drama_id', dramaId);

  const uploadedEpSet = new Set(
    (existingEps || [])
      .filter((e) => e.earnvid_embed_url && e.earnvid_embed_url.includes('/api/stream/tg'))
      .map((e) => e.episode_number)
  );

  console.log(`📊 Progres drama: ${uploadedEpSet.size}/${totalEps} episode sudah tersimpan.`);

  // Loop Episode 1 s/d Tamat
  let totalProcessedEpisodes = 0;

  for (let ep = 1; ep <= totalEps; ep++) {
    if (uploadedEpSet.has(ep)) {
      continue;
    }

    console.log(`\n▶️ [${cleanTitle}] Memproses Episode ${ep}/${totalEps}...`);

    let retryCount = 0;
    let epSuccess = false;

    while (retryCount < 3 && !epSuccess) {
      try {
        retryCount++;
        // 1. Fetch watch page & extract video stream / decryption key
        const { streamUrl, subUrl, keyHex } = await fetchWatchPageData(dramaPlatform, selectedDramaItem.BookID, ep, coverUrl);
        if (!streamUrl) {
          throw new Error(`Stream URL tidak ditemukan di watch page ep ${ep}`);
        }

        // 2. Download, Decrypt (if Melolo), & Auto-Compress
        const { videoPath, vttContent } = await downloadAndProcessEpisode(streamUrl, subUrl, keyHex, ep);

        // 3. Upload video to Telegram Storage Channel
        console.log(`  📤 Mengunggah video ep ${ep} ke Telegram Storage Channel...`);
        const fileId = await uploadVideoToTelegram(videoPath, `${cleanTitle} - Episode ${ep}`);
        console.log(`  ✅ Telegram file_id diperoleh: ${fileId.slice(0, 20)}...`);

        // 4. Upload subtitle to Supabase Storage if available
        let subtitleUrl = null;
        if (vttContent) {
          try {
            const subFileName = `${dramaId}/ep_${ep}.vtt`;
            const { error: subErr } = await supabase.storage
              .from('subtitles')
              .upload(subFileName, Buffer.from(vttContent, 'utf8'), {
                contentType: 'text/vtt; charset=utf-8',
                upsert: true,
              });
            if (!subErr) {
              const { data: pubData } = supabase.storage.from('subtitles').getPublicUrl(subFileName);
              subtitleUrl = pubData?.publicUrl || null;
              console.log(`  📝 Subtitle Indonesia tersimpan ke Supabase Storage.`);
            }
          } catch {}
        }

        // 5. Save to Supabase episodes table
        const embedUrl = `/api/stream/tg?file_id=${fileId}`;
        const { data: existingEp } = await supabase
          .from('episodes')
          .select('id')
          .eq('drama_id', dramaId)
          .eq('episode_number', ep)
          .maybeSingle();

        const payload = {
          drama_id: dramaId,
          episode_number: ep,
          title: `Episode ${ep}`,
          earnvid_embed_url: embedUrl,
          subtitle_url: subtitleUrl,
          is_vip: false,
          source_url: `${dramaPlatform}:${selectedDramaItem.BookID}:${ep}`,
        };

        let epSaveErr = null;
        if (existingEp) {
          const { error } = await supabase.from('episodes').update(payload).eq('id', existingEp.id);
          epSaveErr = error;
        } else {
          const { error } = await supabase.from('episodes').insert(payload);
          epSaveErr = error;
        }

        if (epSaveErr) {
          throw new Error(`Gagal simpan episode ke Supabase: ${epSaveErr.message}`);
        }

        // 6. Cleanup temporary files
        try { if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath); } catch {}

        epSuccess = true;
        totalProcessedEpisodes++;
        uploadedEpSet.add(ep);

        // Jeda santai 2 - 4 detik
        const delayMs = Math.floor(Math.random() * 2000) + 2000;
        await sleep(delayMs);
      } catch (err) {
        console.warn(`  ⚠️ Percobaan ${retryCount}/3 gagal untuk ep ${ep}: ${err.message}`);
        if (retryCount >= 3) {
          console.error(`  ❌ Episode ${ep} gagal total setelah 3 percobaan.`);
          break;
        }
        await sleep(5000 * retryCount);
      }
    }

    if (!epSuccess) {
      console.warn(`⚠️ Sesi dihentikan karena episode ${ep} gagal.`);
      break;
    }
  }

  // 5. 100% Publishing Gate Check
  const { count: finalCount } = await supabase
    .from('episodes')
    .select('id', { count: 'exact', head: true })
    .eq('drama_id', dramaId);

  if (finalCount >= totalEps) {
    console.log(`\n🎉 [PUBLISHING GATE] Drama "${cleanTitle}" 100% LENGKAP (${finalCount}/${totalEps} Episode)!`);
    console.log(`🚀 Mengubah status menjadi TERBIT (is_archived: false)...`);
    await supabase
      .from('dramas')
      .update({
        is_archived: false,
        archive_reason: null,
        genre: genreTags,
        status: 'Completed',
      })
      .eq('id', dramaId);

    console.log(`✅ Drama "${cleanTitle}" resmi terbit di ChineseStory!`);

    // Tandai status COMPLETED di antrean JSON
    updateQueueStatus(auditData, selectedDramaItem.BookID, dramaPlatform, 'COMPLETED');
  } else {
    console.log(`\n⏸️ [PUBLISHING GATE] Drama "${cleanTitle}" baru memiliki ${finalCount}/${totalEps} episode.`);
    console.log(`🔒 Status tetap diarsipkan (is_archived: true) untuk menjaga integritas tayangan.`);
  }

  console.log('\n========================================================================');
  console.log(`🏁 SESI SELESAI: Total ${totalProcessedEpisodes} episode sukses diproses.`);
  console.log('========================================================================');
}

main().catch((err) => {
  console.error('Unhandled fatal error in Harvester:', err);
  process.exit(1);
});
