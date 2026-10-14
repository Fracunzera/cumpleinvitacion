/*
 * Invitación de cumpleaños — lógica de la app. Licencia MIT.
 *
 * Una sola página con dos modos:
 *   - sin datos en el hash  → generador de invitaciones
 *   - con #i=<base64url>    → invitación
 *   - con #e=<base64url>    → generador con los datos cargados (para editar)
 *
 * Los datos viajan como JSON (claves cortas) → UTF-8 → base64url.
 * Nada sale del navegador: no hay requests a terceros, cookies ni analytics.
 */
(function () {
  "use strict";

  // ------------------------------------------------------------------
  // Utilidades
  // ------------------------------------------------------------------
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var THEMES = { k: "kids", e: "elegant", m: "minimal" };
  var FORMAT_VERSION = 1;
  var DEFAULT_DURATION_MIN = 240;
  var LOCALE = "es-AR";

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function clampStr(s, max) { return typeof s === "string" ? s.trim().slice(0, max) : ""; }
  function capitalize(s) { return s ? s.charAt(0).toLocaleUpperCase(LOCALE) + s.slice(1) : s; }
  function slugify(s) {
    return (s || "invitacion").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "invitacion";
  }
  function debounce(fn, ms) {
    var t = 0;
    return function () { var a = arguments, self = this; clearTimeout(t); t = setTimeout(function () { fn.apply(self, a); }, ms); };
  }
  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ------------------------------------------------------------------
  // Codificación del hash: JSON → UTF-8 → base64url
  // ------------------------------------------------------------------
  function utf8Encode(str) {
    if (window.TextEncoder) return new TextEncoder().encode(str);
    var bin = unescape(encodeURIComponent(str)), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function utf8Decode(bytes) {
    if (window.TextDecoder) return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(bin));
  }
  // base64url ⇄ "binary string" (un carácter por byte)
  function binToB64url(bin) {
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64urlToBin(s) {
    s = String(s).trim().replace(/\s+/g, "");
    if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error("caracteres inválidos");
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return atob(s);
  }
  function base64urlEncode(str) {
    var bytes = utf8Encode(str), bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return binToB64url(bin);
  }
  function base64urlDecode(s) {
    var bin = b64urlToBin(s), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return utf8Decode(bytes);
  }

  // ------------------------------------------------------------------
  // Foto: viaja aparte en el hash (&f=), como imagen chiquita comprimida.
  //   f = "w" + base64url(WebP)  o  "j" + base64url(JPEG)
  // Solo se aceptan esos dos formatos (se verifican los bytes mágicos), y se
  // muestra con <img src="data:..."> así que no puede ejecutar nada.
  // ------------------------------------------------------------------
  var PHOTO_MAX_BYTES = 3600;     // ~4,8 KB en el link
  var PHOTO_MAX_PARAM = 12000;    // tope al leer un link
  var PHOTO_TYPES = { w: "image/webp", j: "image/jpeg" };

  function decodePhoto(param) {
    if (!param || param.length > PHOTO_MAX_PARAM) return "";
    var mime = PHOTO_TYPES[param.charAt(0)];
    if (!mime) return "";
    var bin;
    try { bin = b64urlToBin(param.slice(1)); } catch (e) { return ""; }
    var isJpeg = bin.charCodeAt(0) === 0xFF && bin.charCodeAt(1) === 0xD8 && bin.charCodeAt(2) === 0xFF;
    var isWebp = bin.slice(0, 4) === "RIFF" && bin.slice(8, 12) === "WEBP";
    if ((mime === "image/jpeg" && !isJpeg) || (mime === "image/webp" && !isWebp)) return "";
    return "data:" + mime + ";base64," + btoa(bin);
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("imagen ilegible")); };
      img.src = url;
    });
  }

  // Recorta un cuadrado (centrado; en fotos verticales, más arriba para no
  // cortar caras) y lo achica hasta que pese menos de PHOTO_MAX_BYTES.
  function compressPhoto(file) {
    return loadImage(file).then(function (img) {
      var w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) throw new Error("imagen vacía");
      var side = Math.min(w, h);
      var sx = (w - side) / 2;
      var sy = h > w ? (h - side) * 0.3 : (h - side) / 2;

      // Achicar de a mitades mejora mucho la calidad en Safari
      var src = document.createElement("canvas");
      var cur = side, ctx;
      src.width = src.height = cur;
      ctx = src.getContext("2d");
      ctx.drawImage(img, sx, sy, side, side, 0, 0, cur, cur);
      while (cur / 2 >= 200) {
        var half = document.createElement("canvas");
        half.width = half.height = Math.round(cur / 2);
        var hctx = half.getContext("2d");
        hctx.imageSmoothingQuality = "high";
        hctx.drawImage(src, 0, 0, half.width, half.height);
        src = half;
        cur = half.width;
      }

      var probe = document.createElement("canvas");
      probe.width = probe.height = 1;
      var webp = probe.toDataURL("image/webp").indexOf("data:image/webp") === 0;
      var mime = webp ? "image/webp" : "image/jpeg";

      var sizes = [176, 160, 144, 128, 112, 96];
      var qualities = [0.72, 0.62, 0.52, 0.44, 0.36];
      var out = document.createElement("canvas");
      var octx = out.getContext("2d");
      for (var i = 0; i < sizes.length; i++) {
        out.width = out.height = sizes[i];
        octx.imageSmoothingQuality = "high";
        octx.fillStyle = "#ffffff"; // fondo para PNG con transparencia
        octx.fillRect(0, 0, sizes[i], sizes[i]);
        octx.drawImage(src, 0, 0, sizes[i], sizes[i]);
        for (var j = 0; j < qualities.length; j++) {
          var dataUrl = out.toDataURL(mime, qualities[j]);
          var b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
          var bytes = Math.floor(b64.length * 3 / 4) - (b64.match(/=+$/) || [""])[0].length;
          if (bytes <= PHOTO_MAX_BYTES) {
            var param = (webp ? "w" : "j") + binToB64url(atob(b64));
            return { param: param, dataUrl: dataUrl, bytes: bytes, size: sizes[i] };
          }
        }
      }
      throw new Error("no se pudo achicar");
    });
  }

  // ------------------------------------------------------------------
  // "No soy un robot" para el backend opcional: prueba de trabajo.
  // El servidor firma un desafío y el navegador busca un número que, junto
  // con él, dé un SHA-256 con N bits iniciales en cero (~1 s de cálculo).
  // Sin servicios externos ni API keys.
  // ------------------------------------------------------------------
  var SHA_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  // SHA-256 de un texto ASCII; devuelve 8 palabras de 32 bits.
  function sha256Words(ascii) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var len = ascii.length, nWords = ((((len + 8) >> 6) + 1) << 4), m = new Array(nWords), w = new Array(64), i;
    for (i = 0; i < nWords; i++) m[i] = 0;
    for (i = 0; i < len; i++) m[i >> 2] |= ascii.charCodeAt(i) << ((3 - (i & 3)) * 8);
    m[len >> 2] |= 0x80 << ((3 - (len & 3)) * 8);
    m[nWords - 1] = len * 8;
    for (var j = 0; j < nWords; j += 16) {
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        if (i < 16) w[i] = m[j + i] | 0;
        else {
          var x = w[i - 15], y = w[i - 2];
          w[i] = (((x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ (x >>> 3)) + w[i - 16] +
            ((y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ (y >>> 10)) + w[i - 7]) | 0;
        }
        var t1 = (h + ((e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7)) +
          ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) | 0;
        var t2 = (((a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10)) +
          ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H;
  }
  function leadingZeroBits(words) {
    var z = 0;
    for (var i = 0; i < words.length; i++) {
      var c = Math.clz32(words[i]);
      z += c;
      if (c < 32) break;
    }
    return z;
  }
  // Busca el nonce en tandas para no congelar la pantalla.
  function solveChallenge(ch) {
    return new Promise(function (resolve, reject) {
      var bits = ch.bits | 0, prefix = String(ch.salt) + ":", nonce = 0;
      if (bits < 1 || bits > 26) return reject(new Error("desafío inválido"));
      (function chunk() {
        for (var end = nonce + 5000; nonce < end; nonce++) {
          if (leadingZeroBits(sha256Words(prefix + nonce)) >= bits) return resolve(String(nonce));
        }
        setTimeout(chunk, 0);
      })();
    });
  }

  // Modelo "largo" ⇄ objeto compacto con claves cortas
  //   n nombre · a edad · d fecha (AAAA-MM-DD) · t hora (HH:MM) · e hora fin
  //   p lugar · m link de mapa · x mensaje · w WhatsApp · s tema · c color
  //   o offset horario (min, como getTimezoneOffset) · r endpoint RSVP · v versión
  function pack(d) {
    var o = { v: FORMAT_VERSION, n: d.name, d: d.date, t: d.time };
    if (d.age) o.a = d.age;
    if (d.end) o.e = d.end;
    if (d.place) o.p = d.place;
    if (d.maps) o.m = d.maps;
    if (d.message) o.x = d.message;
    if (d.phone) o.w = d.phone;
    if (d.theme && d.theme !== "k") o.s = d.theme;
    if (d.color) o.c = d.color;
    if (typeof d.tz === "number") o.o = d.tz;
    if (d.rsvp) o.r = d.rsvp;
    return o;
  }

  function isValidDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    if (!m) return false;
    var dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return dt.getUTCFullYear() === +m[1] && dt.getUTCMonth() === +m[2] - 1 && dt.getUTCDate() === +m[3];
  }
  function isValidTime(s) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(s || ""); }
  function safeHttpUrl(s) {
    try {
      var u = new URL(s);
      return (u.protocol === "https:" || u.protocol === "http:") ? u.href : "";
    } catch (e) { return ""; }
  }

  // Valida y normaliza lo que viene del link. Nunca confía en el contenido.
  function unpack(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("formato inválido");
    var d = {
      name: clampStr(o.n, 60),
      age: null,
      date: typeof o.d === "string" ? o.d : "",
      time: typeof o.t === "string" ? o.t : "",
      end: isValidTime(o.e) ? o.e : "",
      place: clampStr(o.p, 140),
      maps: safeHttpUrl(clampStr(o.m, 400)),
      message: clampStr(o.x, 400),
      phone: typeof o.w === "string" ? o.w.replace(/\D/g, "").slice(0, 15) : "",
      theme: THEMES[o.s] ? o.s : "k",
      color: /^#[0-9a-f]{6}$/i.test(o.c || "") ? o.c.toLowerCase() : "",
      tz: (typeof o.o === "number" && isFinite(o.o) && Math.abs(o.o) <= 900) ? Math.round(o.o) : null,
      rsvp: clampStr(o.r, 120)
    };
    var age = parseInt(o.a, 10);
    if (age >= 1 && age <= 120) d.age = age;
    if (!d.name) throw new Error("falta el nombre");
    if (!isValidDate(d.date)) throw new Error("fecha inválida");
    if (!isValidTime(d.time)) throw new Error("hora inválida");
    return d;
  }

  function encodeData(d) { return base64urlEncode(JSON.stringify(pack(d))); }
  function decodeData(s) { return unpack(JSON.parse(base64urlDecode(s))); }

  // ------------------------------------------------------------------
  // Fechas y horas
  // ------------------------------------------------------------------
  function parts(date, time) {
    var a = date.split("-").map(Number), b = time.split(":").map(Number);
    return { y: a[0], mo: a[1], d: a[2], h: b[0], mi: b[1] };
  }
  // Instante real (ms UTC) del comienzo de la fiesta.
  function startMs(data) {
    var p = parts(data.date, data.time);
    if (data.tz === null || data.tz === undefined) return new Date(p.y, p.mo - 1, p.d, p.h, p.mi).getTime();
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) + data.tz * 60000;
  }
  function endMs(data) {
    var s = startMs(data);
    if (!data.end) return s + DEFAULT_DURATION_MIN * 60000;
    var a = parts(data.date, data.time), b = parts(data.date, data.end);
    var diff = (b.h * 60 + b.mi) - (a.h * 60 + a.mi);
    if (diff <= 0) diff += 24 * 60; // termina después de medianoche
    return s + diff * 60000;
  }
  // "Hora de pared" del evento, para mostrarla tal cual la escribió quien invita.
  function wallDate(data, time) {
    var p = parts(data.date, time || data.time);
    return new Date(Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi));
  }
  function formatDateLong(data) {
    var s = new Intl.DateTimeFormat(LOCALE, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
      .format(wallDate(data));
    return capitalize(s);
  }
  function formatTimeText(data) {
    var t = data.time + " hs";
    if (data.end) t = "De " + data.time + " a " + data.end + " hs";
    return t;
  }
  function tzNote(data) {
    if (data.tz === null) return "";
    var start = startMs(data);
    var localOffset = new Date(start).getTimezoneOffset();
    if (localOffset === data.tz) return "";
    var local = new Intl.DateTimeFormat(LOCALE, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(start));
    return "Horario del lugar de la fiesta. En tu zona: " + local + " hs";
  }

  // ------------------------------------------------------------------
  // WhatsApp
  // ------------------------------------------------------------------
  // Normaliza un número para wa.me. Si parece argentino sin código de país, agrega 54 9.
  function normalizePhone(raw) {
    var digits = String(raw || "").replace(/\D/g, "");
    if (!digits) return "";
    if (digits.indexOf("00") === 0) digits = digits.slice(2);
    if (digits.charAt(0) === "0") digits = digits.replace(/^0+/, "");
    if (digits.length === 12 && digits.indexOf("54") !== 0) {                                      // 11 15 2345 6789
      for (var i = 2; i <= 4; i++) {
        if (digits.substr(i, 2) === "15") { digits = digits.slice(0, i) + digits.slice(i + 2); break; }
      }
    }
    if (digits.length === 10) digits = "549" + digits;                                             // 11 2345 6789
    else if (digits.length === 12 && digits.indexOf("54") === 0) digits = "549" + digits.slice(2); // 54 11 2345 6789
    return digits;
  }
  function prettyPhone(d) {
    if (/^549\d{10}$/.test(d)) return "+54 9 " + d.slice(3, 5) + " " + d.slice(5, 9) + "-" + d.slice(9);
    return "+" + d;
  }
  function waLink(phone, text) {
    return "https://wa.me/" + (phone || "") + "?text=" + encodeURIComponent(text);
  }

  // ------------------------------------------------------------------
  // Calendario (.ics) — RFC 5545
  // ------------------------------------------------------------------
  function icsEscape(s) {
    return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  }
  function icsDate(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + "T" +
      pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + "Z";
  }
  // Pliega líneas a 75 octetos sin cortar caracteres UTF-8.
  function icsFold(line) {
    var out = [], cur = "", curBytes = 0;
    Array.from(line).forEach(function (ch) {
      var b = utf8Encode(ch).length;
      var limit = out.length ? 74 : 75;
      if (curBytes + b > limit) { out.push(cur); cur = ""; curBytes = 0; }
      cur += ch; curBytes += b;
    });
    out.push(cur);
    return out.join("\r\n ");
  }
  function hashString(s) { // FNV-1a 32 bits, para UID estable
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ("0000000" + h.toString(16)).slice(-8);
  }
  function buildIcs(data, link) {
    var title = "Cumple de " + data.name + (data.age ? " (" + data.age + ")" : "") + " 🎂";
    var desc = [];
    if (data.message) desc.push(data.message);
    if (data.maps) desc.push("Cómo llegar: " + data.maps);
    desc.push("Invitación: " + link);
    var lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Invitacion de cumpleanos//ES",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      "UID:" + hashString(JSON.stringify(pack(data))) + "-" + data.date.replace(/-/g, "") + "@invitacion-cumple",
      "DTSTAMP:" + icsDate(Date.now()),
      "DTSTART:" + icsDate(startMs(data)),
      "DTEND:" + icsDate(endMs(data)),
      "SUMMARY:" + icsEscape(title),
      "DESCRIPTION:" + icsEscape(desc.join("\n\n"))
    ];
    if (data.place) lines.push("LOCATION:" + icsEscape(data.place));
    lines.push("URL:" + link);
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsEscape(title), "TRIGGER:-P1D", "END:VALARM");
    lines.push("END:VEVENT", "END:VCALENDAR");
    return lines.map(icsFold).join("\r\n") + "\r\n";
  }
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  // ------------------------------------------------------------------
  // Colores
  // ------------------------------------------------------------------
  function luminance(hex) {
    var c = [1, 3, 5].map(function (i) {
      var v = parseInt(hex.substr(i, 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function applyTheme(el, data) {
    el.setAttribute("data-theme", THEMES[data.theme] || "kids");
    if (data.color) {
      el.style.setProperty("--accent", data.color);
      el.style.setProperty("--on-accent", luminance(data.color) > 0.4 ? "#141414" : "#ffffff");
    } else {
      el.style.removeProperty("--accent");
      el.style.removeProperty("--on-accent");
    }
  }
  function confettiColors(el) {
    var raw = getComputedStyle(el).getPropertyValue("--confetti");
    var list = raw.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    var accent = getComputedStyle(el).getPropertyValue("--accent").trim();
    if (accent) list.push(accent);
    return list;
  }

  // ------------------------------------------------------------------
  // Tarjeta (compartida entre invitación y vista previa)
  // ------------------------------------------------------------------
  var countdowns = [];
  var cdTimer = 0;

  function setText(root, key, value) {
    $$('[data-f="' + key + '"]', root).forEach(function (el) {
      el.textContent = value == null ? "" : String(value);
      if (el.hasAttribute("hidden") || el.dataset.optional === "1") {
        el.dataset.optional = "1";
        el.hidden = !value;
      }
    });
  }

  function renderCard(container, data, opts) {
    opts = opts || {};
    var tpl = $("#tpl-card");
    var card = tpl.content.firstElementChild.cloneNode(true);
    fillCard(card, data, opts);
    container.textContent = "";
    container.appendChild(card);
    return card;
  }

  function fillCard(card, data, opts) {
    var link = opts.link || location.href;
    setText(card, "name", data.name);
    setText(card, "age", data.age ? "🕯️ ¡Cumple " + data.age + (data.age === 1 ? " añito" : " años") + "!" : "");
    setText(card, "message", data.message);
    setText(card, "dateLong", formatDateLong(data));
    setText(card, "timeText", formatTimeText(data));
    setText(card, "tzNote", tzNote(data));
    setText(card, "place", data.place);
    $('[data-row="place"]', card).hidden = !data.place;

    // Foto (opcional)
    var photoRow = $('[data-row="photo"]', card);
    photoRow.hidden = !data.photo;
    card.classList.toggle("has-photo", !!data.photo);
    if (data.photo) {
      var img = $('[data-img="photo"]', card);
      img.src = data.photo;
      img.alt = "Foto de " + data.name;
    }

    // Mapa: link cargado, o búsqueda por la dirección
    var maps = $('[data-a="maps"]', card);
    var mapsUrl = data.maps || (data.place ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(data.place) : "");
    maps.hidden = !mapsUrl;
    if (mapsUrl) maps.href = mapsUrl;

    // Cuenta regresiva
    registerCountdown(card, data);

    // RSVP por WhatsApp
    var count = 1, lastAuto = "";
    var text = $('[data-f="rsvpText"]', card);
    var out = $('[data-f="count"]', card);
    var rsvpBtn = $('[data-a="rsvp"]', card);
    function autoText(n) {
      return n === 1
        ? "¡Confirmo! Voy al cumple de " + data.name + " 🎉"
        : "¡Confirmo! Vamos " + n + " al cumple de " + data.name + " 🎉";
    }
    function sync() { rsvpBtn.href = waLink(data.phone, text.value.trim() || autoText(count)); }
    function setCount(n) {
      count = Math.max(1, Math.min(30, n));
      out.textContent = count;
      if (text.value === lastAuto) { lastAuto = autoText(count); text.value = lastAuto; }
      sync();
    }
    lastAuto = autoText(1);
    text.value = lastAuto;
    $('[data-a="minus"]', card).addEventListener("click", function () { setCount(count - 1); });
    $('[data-a="plus"]', card).addEventListener("click", function () { setCount(count + 1); });
    text.addEventListener("input", sync);
    $('[data-a="decline"]', card).addEventListener("click", function () {
      text.value = "¡Hola! Lamentablemente no voy a poder ir al cumple de " + data.name + " 😢 ¡Que lo disfruten mucho!";
      sync();
      text.focus();
    });
    sync();
    if (!data.phone) {
      rsvpBtn.setAttribute("title", "Vas a elegir a quién mandarle el mensaje en WhatsApp");
    }

    // Calendario
    $('[data-a="ics"]', card).addEventListener("click", function () {
      var ics = buildIcs(data, link);
      downloadBlob(new Blob([ics], { type: "text/calendar;charset=utf-8" }), "cumple-" + slugify(data.name) + ".ics");
    });

    // Confeti
    $('[data-a="confetti"]', card).addEventListener("click", function () {
      if (window.Confetti) Confetti.burst({ colors: confettiColors(card) });
    });

    // Backend opcional de confirmaciones (solo mismo origen)
    setupApiRsvp(card, data);
  }

  function sameOriginEndpoint(path) {
    if (!path || location.protocol === "file:") return "";
    try {
      var u = new URL(path, location.href);
      return u.origin === location.origin ? u.href : "";
    } catch (e) { return ""; }
  }

  function eventId(data) {
    return hashString(data.name + "|" + data.date + "|" + data.time + "|" + data.phone);
  }

  function challengeUrl(endpoint) {
    var u = new URL(endpoint);
    u.pathname = u.pathname.replace(/\/+$/, "") + "/challenge";
    u.search = "";
    return u.href;
  }

  function setupApiRsvp(card, data) {
    var form = $('[data-a="api-form"]', card);
    var endpoint = sameOriginEndpoint(data.rsvp);
    if (!endpoint) return;
    form.hidden = false;
    var status = $('[data-f="apiStatus"]', card);
    var robot = $('[data-a="robot"]', form);
    var robotStatus = $('[data-f="robotStatus"]', form);
    var submitBtn = form.querySelector('button[type="submit"]');
    var proof = null; // { salt, bits, sig, nonce }

    function resetRobot(msg) {
      proof = null;
      robot.checked = false;
      robot.disabled = false;
      robotStatus.textContent = msg || "";
    }

    robot.addEventListener("change", function () {
      if (proof) { robot.checked = true; return; } // ya verificado: queda tildado
      if (!robot.checked) return;
      robot.disabled = true;
      robotStatus.textContent = "Verificando…";
      fetch(challengeUrl(endpoint), { headers: { Accept: "application/json" } })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (ch) {
          return solveChallenge(ch).then(function (nonce) {
            proof = { salt: ch.salt, bits: ch.bits, sig: ch.sig, nonce: nonce };
            robot.disabled = false;
            robotStatus.textContent = "✓ Verificado";
            status.textContent = "";
          });
        })
        .catch(function () { resetRobot("No se pudo verificar. Probá de nuevo."); });
    });

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var who = form.elements.who.value.trim();
      if (!who) { status.textContent = "Escribí tu nombre."; form.elements.who.focus(); return; }
      if (!proof) {
        status.textContent = robot.disabled ? "Esperá un segundo, estamos verificando…" : "Marcá «No soy un robot».";
        if (!robot.disabled) robot.focus();
        return;
      }
      var count = parseInt($('[data-f="count"]', card).textContent, 10) || 1;
      var msg = $('[data-f="rsvpText"]', card).value;
      var going = !/no voy a poder/i.test(msg);
      var body = {
        event: eventId(data), name: who.slice(0, 60), count: count, going: going, note: msg.slice(0, 300),
        website: form.elements.website.value, pow: proof
      };
      proof = null; // cada desafío sirve una sola vez
      submitBtn.disabled = true;
      status.textContent = "Enviando…";
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).then(function (r) {
        if (!r.ok) throw new Error(r.status);
        status.textContent = going ? "¡Listo! Quedó registrada tu confirmación 🎉" : "Gracias por avisar 💛";
      }).catch(function () {
        submitBtn.disabled = false;
        resetRobot();
        status.textContent = "No se pudo enviar. Probá de nuevo o confirmá por WhatsApp.";
      });
    });
  }

  function registerCountdown(card, data) {
    countdowns = countdowns.filter(function (c) { return document.contains(c.card); });
    countdowns.push({ card: card, start: startMs(data), end: endMs(data) });
    tickCountdowns();
    if (!cdTimer) cdTimer = setInterval(tickCountdowns, 1000);
  }

  function tickCountdowns() {
    var now = Date.now();
    countdowns.forEach(function (c) {
      var card = c.card;
      var grid = $("[data-cd]", card);
      var title = $('[data-f="cdTitle"]', card);
      var msg = $('[data-f="cdMsg"]', card);
      var diff = c.start - now;
      if (diff > 0) {
        var s = Math.floor(diff / 1000);
        var vals = { d: Math.floor(s / 86400), h: Math.floor(s % 86400 / 3600), m: Math.floor(s % 3600 / 60), s: s % 60 };
        Object.keys(vals).forEach(function (k) {
          var el = $('[data-c="' + k + '"]', card);
          var v = k === "d" ? String(vals[k]) : pad2(vals[k]);
          if (el.textContent !== v) el.textContent = v;
        });
        grid.hidden = false;
        title.hidden = false;
        grid.setAttribute("aria-label", "Faltan " + vals.d + " días, " + vals.h + " horas y " + vals.m + " minutos");
        var isToday = new Date(c.start).toDateString() === new Date(now).toDateString();
        msg.hidden = !isToday;
        msg.textContent = isToday ? "¡Es hoy! 🎉" : "";
      } else if (now < c.end) {
        grid.hidden = true;
        title.hidden = true;
        msg.hidden = false;
        msg.textContent = "¡La fiesta es ahora! 🎉🎂";
      } else {
        grid.hidden = true;
        title.hidden = true;
        msg.hidden = false;
        msg.textContent = "Esta fiesta ya pasó. ¡Gracias por ser parte! 💛";
      }
    });
    if (!countdowns.length && cdTimer) { clearInterval(cdTimer); cdTimer = 0; }
  }

  // ------------------------------------------------------------------
  // Modo invitación
  // ------------------------------------------------------------------
  function candleCount(age) {
    if (!age) return 5;
    if (age <= 10) return age;
    return 0; // se usan velas con números
  }

  function buildCandles(container, data) {
    container.textContent = "";
    var list = [];
    var digits = !candleCount(data.age) ? String(data.age).split("") : null;
    var n = digits ? digits.length : candleCount(data.age);
    for (var i = 0; i < n; i++) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "candle" + (digits ? " candle--digit" : "");
      var label = digits ? "Vela con el número " + digits[i] : "Vela " + (i + 1) + " de " + n;
      b.setAttribute("aria-label", label + ", encendida. Tocá para apagarla");
      b.dataset.label = label;
      var flame = document.createElement("span"); flame.className = "flame"; flame.setAttribute("aria-hidden", "true");
      var smoke = document.createElement("span"); smoke.className = "smoke"; smoke.setAttribute("aria-hidden", "true");
      var wick = document.createElement("span"); wick.className = "wick"; wick.setAttribute("aria-hidden", "true");
      var body = document.createElement("span");
      body.setAttribute("aria-hidden", "true");
      if (digits) { body.className = "candle-digit"; body.textContent = digits[i]; }
      else body.className = "candle-stick";
      b.append(flame, smoke, wick, body);
      container.appendChild(b);
      list.push(b);
    }
    return list;
  }

  function showInvite(data) {
    var root = $("#invite");
    document.body.classList.add("mode-invite");
    applyTheme(root, data);
    applyTheme(document.body, data);
    document.title = "Cumple de " + data.name + " 🎂 · ¡Estás invitado/a!";
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", getComputedStyle(root).getPropertyValue("--accent").trim() || "#ff4f8b");

    setText(root, "name", data.name);
    root.hidden = false;
    $("#make-own").href = baseUrl();

    var stage = $("#stage");
    var status = $("#stage-status");
    var btnMic = $("#btn-mic");
    var candlesEl = $("#candles");
    var candles = buildCandles(candlesEl, data);
    var opened = false;
    var mic = null;

    function remaining() { return candles.filter(function (c) { return !c.classList.contains("is-out"); }); }

    function blowOut(c) {
      if (c.classList.contains("is-out")) return;
      c.classList.add("is-out");
      c.setAttribute("aria-label", c.dataset.label + ", apagada");
      c.disabled = true;
    }

    function onAllOut() {
      if (opened) return;
      opened = true;
      stopMic();
      status.textContent = "¡Bien! 🎉 Abriendo la invitación…";
      if (window.Confetti) Confetti.burst({ colors: confettiColors(root), count: 200 });
      setTimeout(reveal, prefersReducedMotion() ? 200 : 900);
    }

    function reveal() {
      opened = true;
      stopMic();
      var slot = $("#card-slot");
      var card = renderCard(slot, data, { link: location.href });
      stage.hidden = true;
      slot.hidden = false;
      window.scrollTo(0, 0);
      var h = $(".card-title", card);
      if (h) h.focus({ preventScroll: true });
    }

    candles.forEach(function (c) {
      c.addEventListener("click", function () {
        var hadFocus = document.activeElement === c; // al deshabilitarse pierde el foco
        blowOut(c);
        var left = remaining().length;
        status.textContent = left ? (left === 1 ? "¡Falta una!" : "Faltan " + left + " velitas") : "";
        if (!left) onAllOut();
        else if (hadFocus) remaining()[0].focus();
      });
    });

    $("#btn-skip").addEventListener("click", function () {
      candles.forEach(blowOut);
      if (window.Confetti) Confetti.burst({ colors: confettiColors(root), count: 120 });
      reveal();
    });

    // --- Soplido con el micrófono ---
    var canMic = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
      (window.AudioContext || window.webkitAudioContext));
    if (!canMic) {
      btnMic.hidden = true;
      $(".stage-or").textContent = "Tocá cada velita para apagarla";
      $("#stage-hint").textContent = "Apagá las velitas para abrirla";
    }

    btnMic.addEventListener("click", function () {
      if (mic) return;
      startMic();
    });

    function startMic() {
      var AC = window.AudioContext || window.webkitAudioContext;
      var ctx;
      try { ctx = new AC(); } catch (e) { return micFailed(); } // se crea dentro del gesto (iOS)
      btnMic.disabled = true;
      status.textContent = "Pidiendo permiso para usar el micrófono…";
      navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      }).then(function (stream) {
        if (opened) { stream.getTracks().forEach(function (t) { t.stop(); }); ctx.close(); return; }
        mic = { ctx: ctx, stream: stream, raf: 0 };
        return ctx.resume().then(function () { listen(ctx, stream); });
      }).catch(function () {
        try { ctx.close(); } catch (e) { /* nada */ }
        micFailed();
      });
    }

    function micFailed() {
      mic = null;
      btnMic.disabled = false;
      btnMic.hidden = true;
      status.textContent = "No pudimos usar el micrófono. ¡No pasa nada! Tocá las velitas para apagarlas 👆";
      if (candles[0]) candles[0].focus();
    }

    function listen(ctx, stream) {
      var src = ctx.createMediaStreamSource(stream);
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.2;
      src.connect(analyser);
      var buf = new Uint8Array(analyser.fftSize);
      var freq = new Uint8Array(analyser.frequencyBinCount);
      var binHz = ctx.sampleRate / analyser.fftSize;
      var lowBins = Math.max(2, Math.round(800 / binHz)); // el soplido tiene mucha energía en graves

      var meter = $("#mic-meter"), fill = $("#mic-meter-fill");
      meter.hidden = false;
      stage.classList.add("is-blowing");
      btnMic.hidden = true;
      status.textContent = "🎤 ¡Ahora soplá fuerte las velitas!";

      var NEEDED = 0.5;      // segundos de soplido sostenido
      var calibrating = 0.35; // segundos midiendo el ruido ambiente
      var floor = 0, floorN = 0;
      var blowTime = 0, last = performance.now();

      function frame(now) {
        if (!mic) return;
        var dt = Math.min((now - last) / 1000, 0.1);
        last = now;
        analyser.getByteTimeDomainData(buf);
        var sum = 0;
        for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; sum += v * v; }
        var rms = Math.sqrt(sum / buf.length);
        analyser.getByteFrequencyData(freq);
        var low = 0;
        for (i = 1; i <= lowBins; i++) low += freq[i];
        low /= lowBins * 255;

        if (calibrating > 0) {
          calibrating -= dt;
          floor += rms; floorN++;
          mic.raf = requestAnimationFrame(frame);
          return;
        }
        var threshold = Math.max(0.09, (floor / Math.max(1, floorN)) * 3.5);
        var blowing = rms > threshold && low > 0.35;
        if (blowing) blowTime += dt;
        else blowTime = Math.max(0, blowTime - dt * 0.6); // tolera micro cortes

        var level = Math.min(1, rms / (threshold * 2));
        candlesEl.style.setProperty("--lean", (blowing ? Math.min(1, level + 0.2) : level * 0.3).toFixed(3));
        fill.style.width = Math.min(100, (blowTime / NEEDED) * 100) + "%";

        if (blowTime >= NEEDED) {
          stopMic();
          extinguishSequence();
          return;
        }
        mic.raf = requestAnimationFrame(frame);
      }
      mic.raf = requestAnimationFrame(frame);
    }

    function extinguishSequence() {
      status.textContent = "¡Wooosh! 💨";
      var list = remaining();
      var step = prefersReducedMotion() ? 0 : Math.max(70, Math.min(160, 900 / list.length));
      list.reduce(function (p, c) {
        return p.then(function () { blowOut(c); return wait(step); });
      }, Promise.resolve()).then(onAllOut);
    }

    function stopMic() {
      stage.classList.remove("is-blowing");
      candlesEl.style.setProperty("--lean", "0");
      $("#mic-meter").hidden = true;
      if (!mic) return;
      cancelAnimationFrame(mic.raf);
      mic.stream.getTracks().forEach(function (t) { t.stop(); }); // libera el micrófono
      try { mic.ctx.close(); } catch (e) { /* nada */ }
      mic = null;
    }

    window.addEventListener("pagehide", stopMic);
  }

  // ------------------------------------------------------------------
  // Modo generador
  // ------------------------------------------------------------------
  function baseUrl() {
    var configured = document.documentElement.getAttribute("data-public-url");
    if (configured) return configured;
    return location.href.split("#")[0].split("?")[0];
  }

  var DEMO = function () {
    var d = new Date();
    d.setDate(d.getDate() + 23);
    while (d.getDay() !== 6) d.setDate(d.getDate() + 1); // un sábado
    return {
      name: "Martina",
      age: 7,
      date: d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()),
      time: "17:00",
      end: "20:00",
      place: "Pelotero Arcoíris, Av. Corrientes 1234, CABA",
      maps: "",
      message: "¡Vení a festejar conmigo! Va a haber pelotero, magia y mucha torta 🎈",
      phone: "11 2345-6789",
      theme: "k",
      color: "",
      rsvp: ""
    };
  };

  function showGenerator(opts) {
    opts = opts || {};
    var gen = $("#generator");
    gen.hidden = false;
    $("#hash-error").hidden = !opts.error;
    $("#file-warning").hidden = !(location.protocol === "file:" && !document.documentElement.getAttribute("data-public-url"));

    var form = $("#form");
    var f = form.elements;
    var preview = $("#preview");
    var touched = {};
    var submitted = false;
    var currentLink = "", qrLink = "", currentData = null;
    var photo = null; // { param, dataUrl } de la foto comprimida

    if (navigator.share) $("#btn-share").hidden = false;

    function readForm() {
      var phone = normalizePhone(f.phone.value);
      var color = $("#f-usecolor").checked ? f.color.value.toLowerCase() : "";
      var d = {
        name: f.name.value.trim(),
        age: f.age.value === "" ? null : Number(f.age.value),
        date: f.date.value,
        time: f.time.value,
        end: f.end.value,
        place: f.place.value.trim(),
        maps: f.maps.value.trim(),
        message: f.message.value.trim(),
        phone: phone,
        theme: (form.querySelector('input[name="theme"]:checked') || {}).value || "k",
        color: color,
        rsvp: f.rsvp.value.trim(),
        tz: null
      };
      if (isValidDate(d.date) && isValidTime(d.time)) {
        var p = parts(d.date, d.time);
        d.tz = new Date(p.y, p.mo - 1, p.d, p.h, p.mi).getTimezoneOffset();
      }
      return d;
    }

    function validate(d) {
      var e = {};
      if (!d.name) e.name = "Escribí el nombre de quien cumple.";
      if (d.age !== null && !(Number.isInteger(d.age) && d.age >= 1 && d.age <= 120)) e.age = "La edad tiene que ser un número entre 1 y 120.";
      if (!d.date) e.date = "Elegí la fecha.";
      else if (!isValidDate(d.date)) e.date = "La fecha no es válida.";
      if (!d.time) e.time = "Elegí la hora.";
      else if (!isValidTime(d.time)) e.time = "La hora no es válida (HH:MM).";
      if (d.end && !isValidTime(d.end)) e.end = "La hora de fin no es válida.";
      if (d.maps && !safeHttpUrl(d.maps)) e.maps = "Pegá un link que empiece con https://";
      var rawPhone = f.phone.value.replace(/\D/g, "");
      if (rawPhone && (d.phone.length < 8 || d.phone.length > 15)) e.phone = "Revisá el número: parece incompleto.";
      if (d.rsvp && !/^\/[^\s]*$/.test(d.rsvp) && !/^https?:\/\//.test(d.rsvp)) e.rsvp = "Tiene que ser una ruta como /api/rsvp.";
      return e;
    }

    function showErrors(errors) {
      ["name", "age", "date", "time", "end", "maps", "phone", "rsvp"].forEach(function (k) {
        var input = f[k], msg = $("#e-" + k);
        var show = errors[k] && (touched[k] || submitted);
        if (input) input.setAttribute("aria-invalid", show ? "true" : "false");
        if (msg) { msg.hidden = !show; msg.textContent = show ? errors[k] : ""; }
      });
    }

    function previewData(d) {
      // La vista previa muestra algo lindo aunque falten datos
      var pd = Object.assign({}, d);
      if (!pd.name) pd.name = "Tu nombre";
      if (!isValidDate(pd.date)) {
        var t = new Date(); t.setDate(t.getDate() + 14);
        pd.date = t.getFullYear() + "-" + pad2(t.getMonth() + 1) + "-" + pad2(t.getDate());
      }
      if (!isValidTime(pd.time)) pd.time = "18:00";
      if (pd.end && !isValidTime(pd.end)) pd.end = "";
      if (pd.maps && !safeHttpUrl(pd.maps)) pd.maps = "";
      if (!(pd.age >= 1 && pd.age <= 120)) pd.age = null;
      pd.photo = photo ? photo.dataUrl : "";
      return pd;
    }

    var renderQr = debounce(function (link) {
      var canvas = $("#qr");
      try {
        var qr = QR.encode(link, "M");
        var scale = Math.max(4, Math.floor(600 / (qr.size + 8)));
        QR.toCanvas(qr, canvas, { scale: scale, margin: 4 });
      } catch (e) {
        var ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }, 150);

    function update() {
      var d = readForm();
      var errors = validate(d);
      showErrors(errors);

      // Teléfono normalizado
      var pn = $("#phone-normalized");
      pn.hidden = !d.phone || !!errors.phone;
      pn.textContent = d.phone ? "Se va a usar: " + prettyPhone(d.phone) : "";

      $("#message-count").textContent = f.message.value.length;

      // Vista previa
      var pd = previewData(d);
      applyTheme(preview, pd);
      renderCard(preview, pd, { link: baseUrl() });

      // Resultado
      var ok = Object.keys(errors).length === 0;
      $("#result-empty").hidden = ok;
      $("#result-body").hidden = !ok;
      if (!ok) { currentLink = ""; currentData = null; return; }

      var payload = encodeData(d);
      var photoPart = photo ? "&f=" + photo.param : "";
      currentData = d;
      qrLink = baseUrl() + "#i=" + payload;  // la foto no entra en un QR
      currentLink = qrLink + photoPart;
      $("#out-link").value = currentLink;
      $("#out-edit").value = baseUrl() + "#e=" + payload + photoPart;
      $("#btn-open").href = currentLink;
      $("#btn-wa").href = "https://wa.me/?text=" + encodeURIComponent(shareText(d, currentLink));
      $("#qr-photo-note").hidden = !photo;
      renderQr(qrLink);

      var admin = $("#rsvp-admin");
      var endpoint = sameOriginEndpoint(d.rsvp);
      admin.hidden = !endpoint;
      if (endpoint) {
        admin.textContent = "Lista de confirmados (backend opcional): " + endpoint +
          (endpoint.indexOf("?") < 0 ? "?" : "&") + "event=" + eventId(d) + "&token=TU_RSVP_TOKEN";
      }
    }

    function shareText(d, link) {
      return "🎂 ¡Estás invitado/a al cumple de " + d.name + (d.age ? " (" + d.age + ")" : "") + "! 🎉\n" +
        "Abrí la invitación y soplá las velitas: " + link;
    }

    function fill(d) {
      f.name.value = d.name || "";
      f.age.value = d.age || "";
      f.date.value = d.date || "";
      f.time.value = d.time || "";
      f.end.value = d.end || "";
      f.place.value = d.place || "";
      f.maps.value = d.maps || "";
      f.message.value = d.message || "";
      f.phone.value = d.phone || "";
      var r = form.querySelector('input[name="theme"][value="' + (d.theme || "k") + '"]');
      if (r) r.checked = true;
      $("#f-usecolor").checked = !!d.color;
      f.color.disabled = !d.color;
      if (d.color) f.color.value = d.color;
      f.rsvp.value = d.rsvp || "";
      if (d.rsvp) $(".advanced").open = true;
    }

    form.addEventListener("input", update);
    form.addEventListener("change", update);
    form.addEventListener("focusout", function (ev) {
      if (ev.target.name) { touched[ev.target.name] = true; update(); }
    });
    $("#f-usecolor").addEventListener("change", function () { f.color.disabled = !this.checked; update(); });

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      submitted = true;
      update();
      var errors = validate(readForm());
      var first = ["name", "age", "date", "time", "end", "maps", "phone", "rsvp"].filter(function (k) { return errors[k]; })[0];
      if (first) {
        if (first === "rsvp") $(".advanced").open = true;
        f[first].focus();
        return;
      }
      var result = $("#result");
      result.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
      result.focus({ preventScroll: true });
    });

    $("#btn-example").addEventListener("click", function () {
      fill(DEMO());
      touched = {};
      update();
      if (window.matchMedia("(max-width: 899px)").matches) {
        $(".gen-preview").scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
      }
    });
    $("#btn-reset").addEventListener("click", function () {
      form.reset();
      setPhoto(null);
      f.color.disabled = true;
      touched = {};
      submitted = false;
      update();
      f.name.focus();
    });

    function copy(text, statusEl, okMsg) {
      function done() { statusEl.textContent = okMsg; setTimeout(function () { statusEl.textContent = ""; }, 3000); }
      function fallback() {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = document.execCommand("copy"); } catch (e) { /* nada */ }
        ta.remove();
        statusEl.textContent = ok ? okMsg : "Seleccioná el link y copialo a mano.";
      }
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
      else fallback();
    }

    $("#btn-copy").addEventListener("click", function () {
      if (currentLink) copy(currentLink, $("#copy-status"), "¡Link copiado! Pegalo donde quieras 📋");
    });
    $("#btn-copy-edit").addEventListener("click", function () {
      copy($("#out-edit").value, $("#copy-status"), "Link de edición copiado. Guardalo para vos.");
    });
    $("#out-link").addEventListener("focus", function () { this.select(); });
    $("#out-edit").addEventListener("focus", function () { this.select(); });

    $("#btn-share").addEventListener("click", function () {
      if (!currentData) return;
      navigator.share({
        title: "Cumple de " + currentData.name + " 🎂",
        text: "🎂 ¡Estás invitado/a al cumple de " + currentData.name + "! Abrí la invitación y soplá las velitas:",
        url: currentLink
      }).catch(function () { /* cancelado */ });
    });

    $("#btn-qr").addEventListener("click", function () {
      if (!qrLink) return;
      var qr = QR.encode(qrLink, "M");
      var canvas = document.createElement("canvas");
      QR.toCanvas(qr, canvas, { scale: Math.max(8, Math.ceil(1024 / (qr.size + 8))), margin: 4 });
      var name = "qr-cumple-" + slugify(currentData && currentData.name) + ".png";
      if (canvas.toBlob) canvas.toBlob(function (blob) { downloadBlob(blob, name); }, "image/png");
      else {
        var a = document.createElement("a");
        a.href = canvas.toDataURL("image/png");
        a.download = name;
        a.click();
      }
    });

    // ---- Sugerir mensaje (IA del navegador o plantillas) ----
    var undoValue = null, lastSuggestion = "";
    var suggestBtn = $("#btn-suggest"), undoBtn = $("#btn-suggest-undo"), suggestStatus = $("#suggest-status");
    suggestBtn.addEventListener("click", function () {
      if (!window.Sugerencias) return;
      var d = readForm();
      suggestBtn.disabled = true;
      suggestStatus.textContent = "Pensando…";
      Sugerencias.suggest({ name: d.name, age: d.age >= 1 && d.age <= 120 ? d.age : null, theme: d.theme, tone: $("#f-tone").value }, lastSuggestion)
        .then(function (res) {
          if (f.message.value !== lastSuggestion) undoValue = f.message.value; // guarda lo que había escrito
          lastSuggestion = res.text;
          f.message.value = res.text;
          undoBtn.hidden = undoValue === null;
          suggestBtn.textContent = "✨ Otra idea";
          suggestStatus.textContent = res.source === "ai"
            ? "Escrito con la IA de tu navegador (en tu dispositivo). Podés editarlo."
            : "Sugerencia al azar. Podés editarla o pedir otra.";
          update();
        })
        .catch(function () { suggestStatus.textContent = "No se pudo sugerir un mensaje. Probá de nuevo."; })
        .then(function () { suggestBtn.disabled = false; });
    });
    undoBtn.addEventListener("click", function () {
      if (undoValue === null) return;
      f.message.value = undoValue;
      undoValue = null;
      lastSuggestion = "";
      undoBtn.hidden = true;
      suggestBtn.textContent = "✨ Sugerir mensaje";
      suggestStatus.textContent = "Volviste a tu mensaje.";
      update();
      f.message.focus();
    });

    // ---- Foto ----
    var photoInput = $("#f-photo");
    function setPhoto(p, info) {
      photo = p;
      var thumb = $("#photo-thumb");
      thumb.hidden = !p;
      $("#photo-empty").hidden = !!p;
      if (p) thumb.src = p.dataUrl; else thumb.removeAttribute("src");
      $("#btn-photo-remove").hidden = !p;
      var infoEl = $("#photo-info");
      infoEl.hidden = !info;
      infoEl.textContent = info || "";
      $("#e-photo").hidden = true;
      photoInput.value = "";
    }
    function photoError(msg) {
      var e = $("#e-photo");
      e.textContent = msg;
      e.hidden = false;
    }
    photoInput.addEventListener("change", function () {
      var file = photoInput.files && photoInput.files[0];
      if (!file) return;
      if (!/^image\//.test(file.type) && file.type) { photoError("Ese archivo no es una imagen."); photoInput.value = ""; return; }
      if (file.size > 25 * 1024 * 1024) { photoError("La imagen es muy pesada (más de 25 MB)."); photoInput.value = ""; return; }
      $("#photo-info").hidden = false;
      $("#photo-info").textContent = "Procesando foto…";
      compressPhoto(file).then(function (p) {
        setPhoto(p, "Foto lista (" + (p.bytes / 1024).toFixed(1).replace(".", ",") + " KB dentro del link)");
        update();
      }).catch(function () {
        $("#photo-info").hidden = true;
        photoError("No pudimos leer esa imagen. Probá con una foto JPG o PNG.");
        photoInput.value = "";
      });
    });
    $("#btn-photo-remove").addEventListener("click", function () {
      setPhoto(null);
      update();
      photoInput.focus();
    });

    if (opts.prefill) fill(opts.prefill);
    if (opts.prefillPhoto) setPhoto({ param: opts.prefillPhoto.param, dataUrl: opts.prefillPhoto.dataUrl });
    update();
  }

  // ------------------------------------------------------------------
  // Ruteo por hash
  // ------------------------------------------------------------------
  function readParams() {
    var hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    var query = new URLSearchParams(location.search);
    return { invite: hash.get("i") || query.get("i"), edit: hash.get("e"), photo: hash.get("f") || query.get("f") };
  }

  function route() {
    $("#loading").hidden = true;
    var p = readParams();
    if (p.invite !== null) {
      var data;
      try { data = decodeData(p.invite); } catch (e) { data = null; }
      if (data) {
        data.photo = decodePhoto(p.photo); // si la foto está rota, se ignora
        showInvite(data);
        return;
      }
      showGenerator({ error: true });
      return;
    }
    if (p.edit !== null) {
      var photoUrl = decodePhoto(p.photo);
      var prefillPhoto = photoUrl ? { param: p.photo, dataUrl: photoUrl } : null;
      try { showGenerator({ prefill: decodeData(p.edit), prefillPhoto: prefillPhoto }); }
      catch (e) { showGenerator({ error: true }); }
      return;
    }
    showGenerator();
  }

  // Si cambia el hash (p. ej. se pega otro link en la misma pestaña), recargamos limpio.
  window.addEventListener("hashchange", function () {
    var p = readParams();
    if (p.invite !== null || p.edit !== null || !location.hash) location.reload();
  });

  // Expuesto solo para pruebas
  window.__invitacion = { encodeData: encodeData, decodeData: decodeData, buildIcs: buildIcs, normalizePhone: normalizePhone,
    decodePhoto: decodePhoto, sha256Words: sha256Words, leadingZeroBits: leadingZeroBits };

  route();
})();
