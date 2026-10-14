/*
 * qr.js — Generador mínimo de códigos QR (modo byte, versiones 1–40).
 * Implementación propia basada en el algoritmo descripto en ISO/IEC 18004
 * y en la estructura del "QR Code generator library" de Project Nayuki (MIT).
 * Licencia MIT. Sin dependencias, funciona offline.
 *
 * Uso:
 *   const qr = QR.encode("https://...", "M");   // {size, modules: boolean[][]}
 *   QR.toCanvas(qr, canvas, {scale: 8, margin: 4, dark: "#000", light: "#fff"});
 */
(function (global) {
  "use strict";

  // Índice: 0 = L, 1 = M, 2 = Q, 3 = H
  var ECL = { L: 0, M: 1, Q: 2, H: 3 };
  var FORMAT_BITS = [1, 0, 3, 2];

  var ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  ];
  var NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  ];

  function numRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function numDataCodewords(ver, ecl) {
    return Math.floor(numRawDataModules(ver) / 8) -
      ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
  }

  // ---- Reed–Solomon sobre GF(2^8), polinomio 0x11D ----
  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function rsDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var root = 1;
    for (i = 0; i < degree; i++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) { result[i] ^= gfMul(coef, factor); });
    });
    return result;
  }

  function utf8Bytes(str) {
    if (typeof TextEncoder !== "undefined") return Array.from(new TextEncoder().encode(str));
    return unescape(encodeURIComponent(str)).split("").map(function (c) { return c.charCodeAt(0); });
  }

  function encode(text, eclName) {
    var ecl = ECL[eclName || "M"];
    var data = utf8Bytes(String(text));

    // Elegir la versión más chica que alcance
    var ver, capacityBits, dataBits;
    for (ver = 1; ; ver++) {
      if (ver > 40) throw new RangeError("El texto es demasiado largo para un QR");
      capacityBits = numDataCodewords(ver, ecl) * 8;
      dataBits = 4 + (ver <= 9 ? 8 : 16) + data.length * 8;
      if (dataBits <= capacityBits) break;
    }

    // Armar el flujo de bits
    var bits = [];
    function append(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    append(0x4, 4); // modo byte
    append(data.length, ver <= 9 ? 8 : 16);
    data.forEach(function (b) { append(b, 8); });
    append(0, Math.min(4, capacityBits - bits.length));
    append(0, (8 - bits.length % 8) % 8);
    for (var pad = 0xEC; bits.length < capacityBits; pad ^= 0xEC ^ 0x11) append(pad, 8);

    var codewords = [];
    for (var i = 0; i < bits.length; i += 8) {
      var byte = 0;
      for (var k = 0; k < 8; k++) byte = (byte << 1) | bits[i + k];
      codewords.push(byte);
    }

    var allCodewords = addEccAndInterleave(codewords, ver, ecl);
    return buildMatrix(ver, ecl, allCodewords);
  }

  function addEccAndInterleave(data, ver, ecl) {
    var numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
    var blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver];
    var rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    var numShortBlocks = numBlocks - rawCodewords % numBlocks;
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);

    var blocks = [];
    var divisor = rsDivisor(blockEccLen);
    for (var i = 0, k = 0; i < numBlocks; i++) {
      var dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      var ecc = rsRemainder(dat, divisor);
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }

    var result = [];
    for (i = 0; i < blocks[0].length; i++) {
      for (var j = 0; j < blocks.length; j++) {
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i]);
      }
    }
    return result;
  }

  function alignmentPositions(ver, size) {
    if (ver === 1) return [];
    var numAlign = Math.floor(ver / 7) + 2;
    var step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    var result = [6];
    for (var pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  function buildMatrix(ver, ecl, codewords) {
    var size = ver * 4 + 17;
    var modules = [], isFunc = [];
    for (var y = 0; y < size; y++) {
      modules.push(new Array(size).fill(false));
      isFunc.push(new Array(size).fill(false));
    }
    function setFunc(x, y, dark) { modules[y][x] = dark; isFunc[y][x] = true; }
    function bit(x, i) { return ((x >>> i) & 1) !== 0; }

    // Patrones de temporización
    for (var i = 0; i < size; i++) {
      setFunc(6, i, i % 2 === 0);
      setFunc(i, 6, i % 2 === 0);
    }
    // Patrones de búsqueda (las tres esquinas)
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(function (p) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var dist = Math.max(Math.abs(dx), Math.abs(dy));
          var xx = p[0] + dx, yy = p[1] + dy;
          if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFunc(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    });
    // Patrones de alineación
    var align = alignmentPositions(ver, size);
    var n = align.length;
    for (i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (var dy = -2; dy <= 2; dy++) {
          for (var dx = -2; dx <= 2; dx++) {
            setFunc(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }

    function drawFormat(mask) {
      var data = FORMAT_BITS[ecl] << 3 | mask;
      var rem = data;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var bits = (data << 10 | rem) ^ 0x5412;
      for (i = 0; i <= 5; i++) setFunc(8, i, bit(bits, i));
      setFunc(8, 7, bit(bits, 6));
      setFunc(8, 8, bit(bits, 7));
      setFunc(7, 8, bit(bits, 8));
      for (i = 9; i < 15; i++) setFunc(14 - i, 8, bit(bits, i));
      for (i = 0; i < 8; i++) setFunc(size - 1 - i, 8, bit(bits, i));
      for (i = 8; i < 15; i++) setFunc(8, size - 15 + i, bit(bits, i));
      setFunc(8, size - 8, true);
    }
    drawFormat(0); // reserva el área; se reescribe después

    // Información de versión (v7+)
    if (ver >= 7) {
      var rem = ver;
      for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var vbits = ver << 12 | rem;
      for (i = 0; i < 18; i++) {
        var a = size - 11 + i % 3, b = Math.floor(i / 3);
        setFunc(a, b, bit(vbits, i));
        setFunc(b, a, bit(vbits, i));
      }
    }

    // Colocar los datos en zigzag
    var idx = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          y = upward ? size - 1 - vert : vert;
          if (!isFunc[y][x] && idx < codewords.length * 8) {
            modules[y][x] = bit(codewords[idx >>> 3], 7 - (idx & 7));
            idx++;
          }
        }
      }
    }

    function applyMask(mask) {
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
          var inv;
          switch (mask) {
            case 0: inv = (x + y) % 2 === 0; break;
            case 1: inv = y % 2 === 0; break;
            case 2: inv = x % 3 === 0; break;
            case 3: inv = (x + y) % 3 === 0; break;
            case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
            case 5: inv = x * y % 2 + x * y % 3 === 0; break;
            case 6: inv = (x * y % 2 + x * y % 3) % 2 === 0; break;
            default: inv = ((x + y) % 2 + x * y % 3) % 2 === 0;
          }
          if (!isFunc[y][x] && inv) modules[y][x] = !modules[y][x];
        }
      }
    }

    // Elegir la máscara con menor penalización
    var best = 0, bestScore = Infinity;
    for (var m = 0; m < 8; m++) {
      applyMask(m);
      drawFormat(m);
      var score = penalty(modules, size);
      if (score < bestScore) { bestScore = score; best = m; }
      applyMask(m); // XOR otra vez = deshacer
    }
    applyMask(best);
    drawFormat(best);

    return { version: ver, size: size, modules: modules };
  }

  function penalty(mod, size) {
    var score = 0, x, y, run, dark = 0;
    var get = function (x, y, vertical) { return vertical ? mod[x][y] : mod[y][x]; };
    for (var pass = 0; pass < 2; pass++) {
      var vertical = pass === 1;
      for (y = 0; y < size; y++) {
        run = 1;
        for (x = 1; x < size; x++) {
          if (get(x, y, vertical) === get(x - 1, y, vertical)) {
            run++;
            if (run === 5) score += 3; else if (run > 5) score++;
          } else run = 1;
        }
        // Patrón tipo buscador 1:1:3:1:1 con 4 claros a un lado
        for (x = 0; x + 10 < size; x++) {
          var p = [];
          for (var k = 0; k < 11; k++) p.push(get(x + k, y, vertical) ? 1 : 0);
          var s = p.join("");
          if (s === "10111010000" || s === "00001011101") score += 40;
        }
      }
    }
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var c = mod[y][x];
        if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) score += 3;
      }
    }
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (mod[y][x]) dark++;
    var total = size * size;
    score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
    return score;
  }

  function toCanvas(qr, canvas, opts) {
    opts = opts || {};
    var scale = opts.scale || 8, margin = opts.margin == null ? 4 : opts.margin;
    var dim = (qr.size + margin * 2) * scale;
    canvas.width = dim;
    canvas.height = dim;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = opts.light || "#ffffff";
    ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = opts.dark || "#000000";
    for (var y = 0; y < qr.size; y++) {
      for (var x = 0; x < qr.size; x++) {
        if (qr.modules[y][x]) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
      }
    }
    return canvas;
  }

  var api = { encode: encode, toCanvas: toCanvas };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.QR = api;
})(this);
