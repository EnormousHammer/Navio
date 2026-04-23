/**
 * Extract human-readable text from common binary / structured files
 * downloaded from Google Drive (or similar) for AI tool responses.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const WordExtractor = require('word-extractor');

const BINARY_MAX_BYTES = 48 * 1024 * 1024;

function extOf(fileName) {
  const m = String(fileName || '')
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function stripXmlishToText(xml) {
  return String(xml || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlToPlain(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function rtfToPlain(rtf) {
  let t = String(rtf);
  t = t.replace(/\\par[d]?/gi, '\n');
  t = t.replace(/\\line/gi, '\n');
  t = t.replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  t = t.replace(/\\u(-?\d+)\??/gi, (_, d) => {
    let n = parseInt(d, 10);
    if (n < 0) n += 65536;
    return n > 0 && n < 0x110000 ? String.fromCharCode(n) : '';
  });
  t = t.replace(/\\[a-z]{1,32}(?:-?\d+)?[ \n]?/gi, '');
  t = t.replace(/[{}]/g, '');
  return t.replace(/[ \t\f\v]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractPptxText(buf) {
  const zip = new AdmZip(buf);
  const chunks = [];
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    if (!/^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName)) continue;
    const xml = e.getData().toString('utf8');
    const seen = new Set();
    const reNs = /<[^>\s:]+:t(?:\s[^>]*)?>([^<]*)<\/[^>\s:]+:t>/g;
    let m;
    while ((m = reNs.exec(xml))) {
      const v = (m[1] || '').trim();
      if (v) seen.add(v);
    }
    const rePlain = /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g;
    while ((m = rePlain.exec(xml))) {
      const v = (m[1] || '').trim();
      if (v) seen.add(v);
    }
    if (seen.size) chunks.push([...seen].join(' '));
  }
  return chunks.join('\n\n').trim();
}

function extractOdfContentXml(buf) {
  try {
    const zip = new AdmZip(buf);
    const xml = zip.readAsText('content.xml', 'utf8');
    return stripXmlishToText(xml);
  } catch {
    return '';
  }
}

function extractZipManifest(buf) {
  try {
    const zip = new AdmZip(buf);
    return zip
      .getEntries()
      .filter((e) => !e.isDirectory)
      .map((e) => e.entryName)
      .join('\n');
  } catch {
    return '';
  }
}

/**
 * @param {string} mimeType
 * @param {string} fileName
 * @returns {boolean}
 */
function shouldDownloadAndExtract(mimeType, fileName) {
  const mt = String(mimeType || '').toLowerCase().trim();
  const ext = extOf(fileName);

  if (mt.startsWith('text/')) return false;

  const officeMimes = [
    'application/pdf',
    'application/rtf',
    'text/rtf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-word.document.macroenabled.12',
    'application/vnd.ms-word.document.macroEnabled.12',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel.sheet.macroenabled.12',
    'application/vnd.ms-excel.sheet.macroEnabled.12',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-powerpoint.presentation.macroenabled.12',
    'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
    'application/epub+zip',
    'text/html',
    'application/xhtml+xml',
    'application/zip'
  ];
  if (officeMimes.some((m) => mt === m || mt.startsWith(m + ';'))) return true;

  const textish = new Set([
    'md',
    'markdown',
    'txt',
    'log',
    'csv',
    'tsv',
    'yaml',
    'yml',
    'ini',
    'cfg',
    'conf',
    'env',
    'sh',
    'bat',
    'ps1',
    'sql',
    'c',
    'h',
    'cpp',
    'hpp',
    'js',
    'ts',
    'tsx',
    'jsx',
    'java',
    'py',
    'rb',
    'go',
    'rs',
    'php',
    'cs',
    'vue',
    'srt',
    'vtt',
    'ics',
    'toml'
  ]);
  const officeExt = new Set([
    'pdf',
    'docx',
    'docm',
    'doc',
    'xlsx',
    'xlsm',
    'xls',
    'pptx',
    'ppt',
    'rtf',
    'odt',
    'ods',
    'odp',
    'epub',
    'html',
    'htm',
    'zip'
  ]);
  if (officeExt.has(ext)) return true;
  if (textish.has(ext) && (mt === 'application/octet-stream' || mt === 'binary/octet-stream' || mt === ''))
    return true;

  return false;
}

/**
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {string} fileName
 * @returns {Promise<{ ok: true, text: string, note: string } | { ok: false, note: string }>}
 */
async function extractDriveFileText({ buffer, mimeType, fileName }) {
  const mt = String(mimeType || '').toLowerCase().trim();
  const ext = extOf(fileName);
  const nameLower = String(fileName || '').toLowerCase();

  const routePdf = () => mt === 'application/pdf' || ext === 'pdf';
  const routeDocx = () =>
    mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mt === 'application/vnd.ms-word.document.macroenabled.12' ||
    mt === 'application/vnd.ms-word.document.macroEnabled.12' ||
    ext === 'docx' ||
    ext === 'docm';
  const routeDoc = () => mt === 'application/msword' || ext === 'doc';
  const routeXlsx = () =>
    mt === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mt === 'application/vnd.ms-excel.sheet.macroenabled.12' ||
    mt === 'application/vnd.ms-excel.sheet.macroEnabled.12' ||
    ext === 'xlsx' ||
    ext === 'xlsm' ||
    ext === 'xls';
  const routePptx = () =>
    mt === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    mt === 'application/vnd.ms-powerpoint.presentation.macroenabled.12' ||
    mt === 'application/vnd.ms-powerpoint.presentation.macroEnabled.12' ||
    ext === 'pptx';
  const routePpt = () => mt === 'application/vnd.ms-powerpoint' || ext === 'ppt';
  const routeRtf = () => mt === 'application/rtf' || mt === 'text/rtf' || ext === 'rtf';
  const routeOdt = () => mt === 'application/vnd.oasis.opendocument.text' || ext === 'odt';
  const routeOds = () => mt === 'application/vnd.oasis.opendocument.spreadsheet' || ext === 'ods';
  const routeOdp = () => mt === 'application/vnd.oasis.opendocument.presentation' || ext === 'odp';
  const routeHtml = () =>
    mt === 'text/html' || mt === 'application/xhtml+xml' || ext === 'html' || ext === 'htm' || ext === 'xhtml';
  const routeEpub = () => mt === 'application/epub+zip' || ext === 'epub';
  const routeZip = () => mt === 'application/zip' || ext === 'zip';

  try {
    if (routePpt()) {
      return {
        ok: false,
        note: 'Legacy PowerPoint (.ppt) is not converted to text here — open the file in Google Drive or Microsoft Office.'
      };
    }

    if (routePdf()) {
      const parsed = await pdfParse(buffer);
      const extracted = typeof parsed.text === 'string' ? parsed.text.trim() : '';
      return {
        ok: true,
        text: extracted || '(No extractable text — PDF may be scanned images only, empty, or copy-protected.)',
        note: `Extracted from PDF (${parsed.numpages != null ? parsed.numpages : '?'} page(s)).`
      };
    }

    if (routeDocx()) {
      const r = await mammoth.extractRawText({ buffer });
      const t = (r.value || '').trim();
      return {
        ok: true,
        text: t || '(Empty document.)',
        note: 'Extracted text from Word (.docx).'
      };
    }

    if (routeDoc()) {
      const tmp = path.join(os.tmpdir(), `navio-doc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.doc`);
      try {
        fs.writeFileSync(tmp, buffer);
        const extractor = new WordExtractor();
        const doc = await extractor.extract(tmp);
        const body = (doc.getBody() || '').trim();
        return {
          ok: true,
          text: body || '(No body text found in .doc file.)',
          note: 'Extracted text from legacy Word (.doc).'
        };
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
    }

    if (routeXlsx()) {
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const parts = [];
      for (const sheetName of wb.SheetNames || []) {
        const sheet = wb.Sheets[sheetName];
        if (!sheet) continue;
        const csv = XLSX.utils.sheet_to_csv(sheet);
        parts.push(`## ${sheetName}\n${csv}`);
      }
      const t = parts.join('\n\n').trim();
      return {
        ok: true,
        text: t || '(Empty spreadsheet.)',
        note: `Spreadsheet → CSV-style text (${(wb.SheetNames || []).length} sheet(s)).`
      };
    }

    if (routePptx()) {
      const t = extractPptxText(buffer);
      return {
        ok: true,
        text: t || '(No slide text found — deck may be image-only.)',
        note: 'Extracted text from PowerPoint (.pptx) slides.'
      };
    }

    if (routeRtf()) {
      let raw = '';
      try {
        raw = buffer.toString('utf8');
      } catch {
        raw = buffer.toString('latin1');
      }
      const t = rtfToPlain(raw);
      return { ok: true, text: t || '(Empty RTF.)', note: 'Extracted text from RTF (best-effort).' };
    }

    if (routeOdt() || routeOds() || routeOdp()) {
      const t = extractOdfContentXml(buffer);
      return {
        ok: true,
        text: t || '(No text found in OpenDocument file.)',
        note: `Extracted text from OpenDocument (${ext || mt}).`
      };
    }

    if (routeEpub()) {
      try {
        const zip = new AdmZip(buffer);
        const texts = [];
        for (const e of zip.getEntries()) {
          if (e.isDirectory) continue;
          if (!/\.(xhtml|html|htm|xml)$/i.test(e.entryName)) continue;
          if (e.entryName.toLowerCase().includes('nav')) continue;
          const chunk = stripXmlishToText(e.getData().toString('utf8'));
          if (chunk.length > 30) texts.push(chunk);
        }
        const t = texts.join('\n\n').trim();
        return {
          ok: true,
          text: t || '(EPUB opened but little text was found in HTML parts.)',
          note: 'Extracted text from EPUB (HTML-based chapters).'
        };
      } catch (e) {
        return { ok: false, note: `EPUB parse failed (${e.message || String(e)}).` };
      }
    }

    if (routeHtml()) {
      const raw = buffer.toString('utf8');
      const t = htmlToPlain(raw);
      return { ok: true, text: t || '(Empty HTML.)', note: 'Converted HTML to plain text.' };
    }

    if (routeZip() && !routeDocx() && !routeXlsx() && !routePptx() && !routeEpub()) {
      const listing = extractZipManifest(buffer);
      return {
        ok: true,
        text: listing || '(Empty ZIP.)',
        note: 'Listed paths inside ZIP (not unpacked file contents).'
      };
    }

    // Plain code / config / markdown uploaded as octet-stream
    if (
      /\.(md|txt|log|csv|tsv|json|xml|yaml|yml|ini|sql|sh|bat|ps1|js|ts|c|h|cpp|hpp|java|py|go|rs|php|cs|vue|toml)$/i.test(
        nameLower
      )
    ) {
      let t = '';
      try {
        t = buffer.toString('utf8');
      } catch {
        t = buffer.toString('latin1');
      }
      t = t.replace(/\0/g, '').trim();
      return { ok: true, text: t || '(File appears empty.)', note: 'Read as UTF-8 text (by file extension).' };
    }

    return {
      ok: false,
      note: `No text extractor is registered for mime "${mimeType}" / extension ".${ext || '(none)'}". Open the file in Google Drive.`
    };
  } catch (e) {
    return {
      ok: false,
      note: `Extraction failed (${e.message || String(e)}). The file may be corrupted, encrypted, or an unsupported variant.`
    };
  }
}

module.exports = {
  BINARY_MAX_BYTES,
  shouldDownloadAndExtract,
  extractDriveFileText
};
