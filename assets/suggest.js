/*
 * suggest.js — Sugerencias de mensaje para la invitación. Licencia MIT.
 *
 * 1. Si el navegador trae IA incorporada y el modelo YA está descargado
 *    (p. ej. Chrome con Gemini Nano: APIs `LanguageModel` o `Writer`), la usa.
 *    Corre en el dispositivo: no hay API keys ni se manda nada a ningún lado.
 *    Nunca dispara la descarga del modelo.
 * 2. Si no, arma el mensaje combinando frases según edad, tema y tono.
 *
 * Uso: Sugerencias.suggest({ name, age, theme: "k"|"e"|"m", tone: ""|"fun"|"warm"|"formal" })
 *        → Promise<{ text, source: "ai" | "templates" }>
 */
(function (global) {
  "use strict";

  var MAX_LEN = 400;
  var AI_TIMEOUT_MS = 20000;

  function pick(list, avoid) {
    var options = list.filter(function (s) { return s !== avoid; });
    if (!options.length) options = list;
    return options[Math.floor(Math.random() * options.length)];
  }

  // ------------------------------------------------------------------
  // Plantillas (español rioplatense, primera persona de quien cumple)
  // ------------------------------------------------------------------
  var T = {
    kids: {
      fun: {
        open: [
          "¡Se viene mi cumple y no puede faltar nadie! 🎈",
          "¡Atención, atención! Cumplo {edad} y lo vamos a festejar a lo grande 🎉",
          "¡Llegó el día más esperado del año: mi cumple! 🥳",
          "¡Preparate para jugar, saltar y comer torta! 🎂",
          "¡Hay fiesta y vos estás invitado/a! 🎊"
        ],
        body: [
          "Va a haber juegos, sorpresas y mucha torta.",
          "Traé tus ganas de jugar, que de lo demás me encargo yo.",
          "Habrá globos, música y la torta más rica del mundo.",
          "Vamos a correr, bailar y reírnos un montón.",
          "Tengo preparadas un montón de sorpresas."
        ],
        close: ["¡Te espero! 💛", "¡No te lo pierdas!", "¡Va a ser genial si venís!", "¡Sumate a la diversión! 🚀"]
      },
      warm: {
        open: [
          "Este año cumplo {edad} y quiero festejarlo con las personas que más quiero 💛",
          "Mi cumple es más lindo si estás vos.",
          "Quiero compartir mi día especial con vos 🌈",
          "¡Cumplo {edad}! Y lo mejor del cumple es festejarlo juntos."
        ],
        body: [
          "Vamos a jugar, comer algo rico y soplar las velitas.",
          "Va a ser una tarde llena de juegos y abrazos.",
          "Preparamos todo con mucho cariño para pasarla bien."
        ],
        close: ["¡Me encantaría que vengas!", "¡Te espero con muchas ganas!", "¡Gracias por ser parte!"]
      }
    },
    teens: {
      fun: {
        open: [
          "¡Se viene mi cumple y va a estar buenísimo! 🎶",
          "Cumplo {edad} y el plan ya está armado: música, amigos y algo rico 🍕",
          "¡Mi cumple, mis reglas: hay que pasarla bien! 😎"
        ],
        body: [
          "Va a haber buena música y mucha diversión.",
          "Traé buena onda, que el resto está resuelto.",
          "Vamos a bailar, comer y sacarnos mil fotos."
        ],
        close: ["¡No me falles! 🙌", "¡Te espero!", "¡Confirmá así cuento con vos!"]
      },
      warm: {
        open: [
          "Cumplo {edad} y lo quiero festejar con la gente que hace mis días mejores ✨",
          "Este cumple es especial y quiero que estés."
        ],
        body: ["Va a ser una noche para recordar.", "Preparé todo con muchas ganas."],
        close: ["¡Te espero!", "¡Sería genial verte ahí!"]
      }
    },
    adults: {
      fun: {
        open: [
          "Otro año más y lo quiero festejar como corresponde 🥂",
          "Dicen que los años no se cumplen, se festejan. Así que… ¡a festejar! 🎉",
          "Sumo una vuelta más al sol y la quiero celebrar con vos ☀️",
          "Un año más sabio/a (o eso dicen) y con más ganas de fiesta 😄"
        ],
        body: [
          "Habrá buena música, algo rico para comer y brindis asegurado.",
          "La idea es pasarla bien, reírnos mucho y bailar un rato.",
          "No hace falta traer nada, solo buena onda."
        ],
        close: ["¡Te espero, no me falles! 😉", "Confirmame así te guardo un lugar.", "¡Nos vemos ahí!"]
      },
      warm: {
        open: [
          "No hay mejor regalo que compartir este día con la gente que quiero 💛",
          "Quiero celebrar este nuevo año con las personas que hacen mi vida más linda.",
          "Cumplir años es más lindo cuando se festeja con quienes uno quiere."
        ],
        body: [
          "Va a ser un encuentro sencillo, con buena comida y mejor compañía.",
          "Tenerte ahí lo haría todavía más especial.",
          "Brindemos juntos por todo lo vivido y lo que viene."
        ],
        close: ["¡Te espero con mucho cariño!", "Ojalá puedas venir.", "¡Gracias por estar siempre!"]
      },
      formal: {
        open: [
          "Tengo el agrado de invitarte a celebrar mi cumpleaños.",
          "Me encantaría contar con tu presencia en la celebración de mi cumpleaños.",
          "Te invito a compartir una velada especial por mi cumpleaños."
        ],
        body: [
          "Será un placer brindar juntos por un nuevo año.",
          "Preparamos una celebración con buena música y buena mesa.",
          "Tu compañía hará que la noche sea inolvidable."
        ],
        close: ["Agradeceré que confirmes tu asistencia.", "Espero poder contar con vos.", "Te espero."]
      }
    }
  };

  var MILESTONES = {
    1: ["¡Cumplo mi primer añito y quiero festejarlo con vos! 👶", "¡Mi primer cumple! Un año lleno de aprendizajes y mimos 🍼"],
    15: ["Cumplo 15 y quiero vivir esta noche única con vos ✨", "Llegaron mis 15 y quiero que seas parte de esta noche soñada 💫"],
    18: ["¡Cumplo 18! Mayoría de edad, mayoría de festejo 🎉", "18 años: ¡hay que celebrarlo en grande! 🥳"],
    round: ["¡{edad} años! Un número redondo merece un festejo a la altura 🥂", "Llegaron los {edad} y los quiero celebrar con toda la gente que quiero 🎉"]
  };

  function audience(age, theme) {
    if (age) return age <= 12 ? "kids" : age <= 17 ? "teens" : "adults";
    return theme === "k" ? "kids" : "adults";
  }
  function defaultTone(theme) { return theme === "e" ? "formal" : theme === "m" ? "warm" : "fun"; }

  function fromTemplates(ctx, previous) {
    var aud = audience(ctx.age, ctx.theme);
    var tone = ctx.tone || defaultTone(ctx.theme);
    var set = T[aud][tone] || T[aud].warm || T[aud].fun;
    var age = ctx.age;
    var opens = set.open.filter(function (s) { return age || s.indexOf("{edad}") < 0; });
    var milestone = MILESTONES[age] || (age >= 20 && age % 10 === 0 ? MILESTONES.round : null);
    if (milestone && tone !== "formal") opens = milestone;
    var text, tries = 0;
    do {
      text = [pick(opens), pick(set.body), pick(set.close)].join(" ").replace(/\{edad\}/g, String(age || ""));
    } while (text === previous && ++tries < 6);
    return text.slice(0, MAX_LEN);
  }

  // ------------------------------------------------------------------
  // IA incorporada en el navegador (opcional, en el dispositivo)
  // ------------------------------------------------------------------
  var LANG = { expectedInputs: [{ type: "text", languages: ["es"] }], expectedOutputs: [{ type: "text", languages: ["es"] }] };
  var aiState = null; // Promise<"prompt" | "writer" | "">

  function detectAI() {
    if (aiState) return aiState;
    aiState = (function () {
      var LM = global.LanguageModel, W = global.Writer;
      var check = function (api, opts) {
        try {
          return Promise.resolve(api.availability(opts)).then(function (a) { return a === "available"; }, function () { return false; });
        } catch (e) { return Promise.resolve(false); }
      };
      var tryPrompt = LM && typeof LM.availability === "function" ? check(LM, LANG) : Promise.resolve(false);
      return tryPrompt.then(function (ok) {
        if (ok) return "prompt";
        if (W && typeof W.availability === "function") {
          return check(W, { expectedInputLanguages: ["es"], outputLanguage: "es" }).then(function (ok2) { return ok2 ? "writer" : ""; });
        }
        return "";
      });
    })();
    return aiState;
  }

  var SYSTEM = "Escribís el mensaje de una invitación de cumpleaños en español de Argentina, con voseo " +
    "(vení, sumate, te espero). Escribís en primera persona, como quien cumple años. Máximo 2 oraciones " +
    "y 220 caracteres. Podés usar 1 o 2 emojis. No incluyas fecha, hora, lugar ni el nombre: ya aparecen " +
    "en la invitación. Respondé solo con el mensaje, sin comillas ni explicaciones.";

  var TONE_WORDS = { fun: "divertido y alegre", warm: "cálido y emotivo", formal: "formal y elegante" };
  var SEEDS = ["globos", "música", "torta", "abrazos", "sorpresas", "brindis", "baile", "risas", "amigos", "juegos", "estrellas", "sol"];

  function userPrompt(ctx) {
    var aud = audience(ctx.age, ctx.theme);
    var who = aud === "kids" ? "un chico o chica" : aud === "teens" ? "un adolescente" : "una persona adulta";
    return "Quien cumple: " + (ctx.name || "alguien") + " (" + who + ")" +
      (ctx.age ? ", cumple " + ctx.age + " años" : "") +
      ". Tono: " + TONE_WORDS[ctx.tone || defaultTone(ctx.theme)] +
      ". Para darle variedad, inspirate en la palabra: " + pick(SEEDS) + ".";
  }

  function clean(text) {
    text = String(text || "").replace(/[*_#`>]/g, "").replace(/^["'«“\s]+|["'»”\s]+$/g, "").replace(/\s+/g, " ").trim();
    return text.slice(0, MAX_LEN);
  }

  function withTimeout(p) {
    return Promise.race([p, new Promise(function (_, reject) { setTimeout(function () { reject(new Error("timeout")); }, AI_TIMEOUT_MS); })]);
  }

  function fromAI(kind, ctx) {
    if (kind === "prompt") {
      var opts = { initialPrompts: [{ role: "system", content: SYSTEM }] };
      opts.expectedInputs = LANG.expectedInputs;
      opts.expectedOutputs = LANG.expectedOutputs;
      return withTimeout(global.LanguageModel.create(opts).then(function (session) {
        return session.prompt(userPrompt(ctx)).then(function (out) {
          if (session.destroy) session.destroy();
          return out;
        });
      }));
    }
    return withTimeout(global.Writer.create({
      tone: (ctx.tone || defaultTone(ctx.theme)) === "formal" ? "formal" : "casual",
      format: "plain-text",
      length: "short",
      sharedContext: SYSTEM,
      expectedInputLanguages: ["es"],
      outputLanguage: "es"
    }).then(function (writer) {
      return writer.write(userPrompt(ctx)).then(function (out) {
        if (writer.destroy) writer.destroy();
        return out;
      });
    }));
  }

  function suggest(ctx, previous) {
    ctx = ctx || {};
    return detectAI().then(function (kind) {
      if (!kind) return { text: fromTemplates(ctx, previous), source: "templates" };
      return fromAI(kind, ctx).then(function (out) {
        var text = clean(out);
        if (text.length < 8) throw new Error("respuesta vacía");
        return { text: text, source: "ai" };
      }).catch(function () {
        return { text: fromTemplates(ctx, previous), source: "templates" };
      });
    });
  }

  global.Sugerencias = { suggest: suggest, detectAI: detectAI, fromTemplates: fromTemplates };
})(this);
