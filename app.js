(() => {
  'use strict';

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const input = document.getElementById('file');
  const drop = document.getElementById('drop');
  const statusEl = document.getElementById('status');

  const SENTENCE_RE = /.+?(?:[.!?…]+["')\]»”]*(?=\s|$)|$)/gs;
  const WORD_RE = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

  const measureCtx = document.createElement('canvas').getContext('2d');

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = kind || '';
  }

  // Extrae el texto de todo el documento y recuerda a qué ítem/página pertenece cada tramo.
  async function extractText(pdf) {
    let text = '';
    const segs = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (item.str) {
          segs.push({
            start: text.length,
            end: text.length + item.str.length,
            item,
            style: content.styles[item.fontName],
            pageIndex: p - 1,
          });
          text += item.str;
        }
        if (item.hasEOL) text += ' ';
      }
      text += ' ';
      page.cleanup();
    }
    return { text, segs };
  }

  function longestWordPerSentence(text) {
    const words = [];
    for (const s of text.matchAll(SENTENCE_RE)) {
      let best = null;
      for (const w of s[0].matchAll(WORD_RE)) {
        if (!best || w[0].length > best.len) best = { len: w[0].length, idx: w.index };
      }
      if (best) {
        const start = s.index + best.idx;
        words.push({ start, end: start + best.len });
      }
    }
    return words;
  }

  // Fracción del ancho del ítem que ocupan los primeros n caracteres.
  function fraction(seg, n) {
    const str = seg.item.str;
    if (n <= 0) return 0;
    if (n >= str.length) return 1;
    const size = Math.hypot(seg.item.transform[2], seg.item.transform[3]) || 10;
    measureCtx.font = `${size}px ${(seg.style && seg.style.fontFamily) || 'sans-serif'}`;
    const full = measureCtx.measureText(str).width;
    return full > 0 ? measureCtx.measureText(str.slice(0, n)).width / full : n / str.length;
  }

  function rectsForWord(word, segs) {
    const rects = [];
    for (const seg of segs) {
      if (seg.end <= word.start) continue;
      if (seg.start >= word.end) break;
      const a = Math.max(word.start, seg.start) - seg.start;
      const b = Math.min(word.end, seg.end) - seg.start;
      const t = seg.item.transform;
      const angle = Math.atan2(t[1], t[0]);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const h = seg.item.height || Math.hypot(t[2], t[3]);
      const d0 = seg.item.width * fraction(seg, a);
      const d1 = seg.item.width * fraction(seg, b);
      const drop = 0.2 * h;
      rects.push({
        pageIndex: seg.pageIndex,
        x: t[4] + cos * d0 + sin * drop,
        y: t[5] + sin * d0 - cos * drop,
        width: d1 - d0,
        height: h * 1.1,
        angle: (angle * 180) / Math.PI,
      });
    }
    return rects;
  }

  async function highlight(file) {
    let buffer = await file.arrayBuffer();
    let pdf = null;
    try {
      pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise;
      const { text, segs } = await extractText(pdf);
      const words = longestWordPerSentence(text);
      if (!words.length) throw new Error('No encontré texto en el PDF (¿es un escaneo?).');

      const doc = await PDFLib.PDFDocument.load(buffer);
      const pages = doc.getPages();
      const yellow = PDFLib.rgb(1, 0.9, 0);
      let count = 0;
      for (const word of words) {
        for (const r of rectsForWord(word, segs)) {
          pages[r.pageIndex].drawRectangle({
            x: r.x, y: r.y, width: r.width, height: r.height,
            rotate: PDFLib.degrees(r.angle),
            color: yellow, opacity: 0.45, borderWidth: 0,
          });
        }
        count++;
      }
      const bytes = await doc.save();
      return { bytes, count };
    } finally {
      if (pdf) await pdf.destroy();
      buffer = null;
    }
  }

  function download(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Una vez entregado al navegador, se libera la memoria.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function handle(file) {
    if (!file) return;
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      setStatus('El archivo tiene que ser un PDF.', 'err');
      return;
    }
    setStatus('Procesando…');
    try {
      const { bytes, count } = await highlight(file);
      download(bytes, file.name.replace(/\.pdf$/i, '') + '-resaltado.pdf');
      setStatus(`Listo: ${count} palabras resaltadas. Descargando…`, 'ok');
    } catch (e) {
      console.error(e);
      setStatus(e.message || 'No se pudo procesar el PDF.', 'err');
    } finally {
      input.value = '';
    }
  }

  input.addEventListener('change', () => handle(input.files[0]));
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => handle(e.dataTransfer.files[0]));
})();
