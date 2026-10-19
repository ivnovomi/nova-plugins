// Pluto TV para NOVA: canales gratis y legales con anuncios (dibujos, anime,
// cine, series, MTV…), con su guía, en la región de quien mira. Usa la misma
// API pública que la web pluto.tv.
//
// Cómo funciona Pluto:
//  1. Se pide una «sesión» a boot.pluto.tv (un token que dura unas horas).
//  2. Con ese token se piden los canales, sus categorías y la guía.
//  3. Para ver un canal, su lista .m3u8 se «firma» con el token. Pluto solo
//     deja leer sus listas a su propia web (CORS), así que van por el proxy de
//     NOVA (proxy: true). Los trozos de vídeo se cargan directos.

import { defineProvider, http, log, settings, storage, type Category, type Channel, type Program } from "@novatv/sdk";

const BOOT = "https://boot.pluto.tv/v4/start";
const API = "https://service-channels.clusters.pluto.tv/v2/guide";
// Pluto responde como a un navegador.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

// ───────────────────────── La sesión ─────────────────────────

interface Boot {
  sessionToken?: string;
  stitcherParams?: string;
  refreshInSec?: number;
  servers?: { stitcher?: string };
  session?: { activeRegion?: string };
}

interface Session {
  token: string;
  /** Lo que Pluto quiere en la dirección de cada emisión. */
  params: string;
  /** El servidor de las emisiones ("https://…stitcher….pluto.tv"). */
  stitcher: string;
  region: string;
  /** ms */
  expiresAt: number;
}

// En memoria: el plugin sigue vivo entre llamadas de NOVA.
let session: Session | undefined;

// ───────────────────────── Registro ─────────────────────────
// Todo sale en Ajustes → Plugins → Pluto TV → Registro (y en la terminal con
// `nova dev`). Nunca se escribe el token: las direcciones van sin su «?…».

/** Milisegundos desde `t0`. */
const ms = (t0: number) => `${Date.now() - t0} ms`;
/** Una dirección sin lo que va tras «?» (ahí viajan los tokens). */
const bare = (url: string) => url.split("?")[0];
/** "12.3 KB" */
const kb = (text: string) => `${(text.length / 1024).toFixed(1)} KB`;
/** { a: 3, b: 1 } → "a 3 · b 1", de más a menos. */
const tally = (counts: Map<string, number>) =>
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(" · ");

/** Un identificador de dispositivo anónimo, como el de una pestaña del navegador (se guarda para siempre). */
function deviceId(): string {
  let id = storage.get<string>("deviceId");
  if (!id) {
    const hex = () => Math.floor(Math.random() * 16).toString(16);
    id = "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, hex);
    storage.set("deviceId", id);
  }
  return id;
}

/** La sesión actual, o una nueva si caducó (o si `fresh`: Pluto rechazó la anterior). */
async function getSession(fresh = false): Promise<Session> {
  if (session && !fresh && Date.now() < session.expiresAt) return session;

  const why = !session ? "la primera" : fresh ? "Pluto rechazó la anterior" : "la anterior caducó";
  const t0 = Date.now();
  const query = [
    "appName=web",
    "appVersion=9.0.0",
    "deviceVersion=140.0.0",
    "deviceModel=web",
    "deviceMake=chrome",
    "deviceType=web",
    `clientID=${deviceId()}`,
    "clientModelNumber=1.0.0",
    "serverSideAds=false",
  ].join("&");
  let boot: Boot;
  try {
    boot = await http.json<Boot>(`${BOOT}?${query}`, { headers: { "user-agent": UA } });
  } catch (e) {
    log.error(`sesión: boot.pluto.tv falló en ${ms(t0)}:`, String(e));
    throw e;
  }

  const stitcher = boot.servers?.stitcher;
  if (!boot.sessionToken || !stitcher?.startsWith("https://")) {
    log.error("sesión: Pluto respondió sin token o sin servidor de emisión", { token: !!boot.sessionToken, stitcher: stitcher ?? null });
    throw new Error("Pluto TV no dio una sesión");
  }
  // Se renueva 10 minutos antes de que caduque.
  const seconds = Math.max(600, (boot.refreshInSec ?? 8 * 3600) - 600);
  session = {
    token: boot.sessionToken,
    params: boot.stitcherParams ?? "",
    stitcher,
    region: boot.session?.activeRegion ?? "ES",
    expiresAt: Date.now() + seconds * 1000,
  };
  log.info(
    `sesión nueva (${why}) en ${ms(t0)}: región ${session.region}, servidor ${bare(stitcher)}, válida ${(seconds / 3600).toFixed(1)} h, ` +
      `parámetros de emisión ${session.params ? `${session.params.split("&").length}` : "ninguno"}, dispositivo ${deviceId().slice(0, 8)}…`,
  );
  return session;
}

/** GET a la API de Pluto con el token; si lo rechaza, una vez más con sesión nueva. */
async function api<T>(path: string): Promise<T> {
  const name = bare(path);
  const ask = async (fresh: boolean) => {
    const { token } = await getSession(fresh);
    const t0 = Date.now();
    const res = await http.request({ url: `${API}/${path}`, headers: { authorization: `Bearer ${token}`, "user-agent": UA } });
    log.info(`API ${name} → HTTP ${res.status}, ${kb(res.body)}, ${ms(t0)}`);
    return res;
  };
  let res = await ask(false);
  if (res.status === 401 || res.status === 403) {
    log.warn(`API ${name}: Pluto rechazó la sesión (HTTP ${res.status}); se pide otra y se reintenta`);
    res = await ask(true);
  }
  if (res.status !== 200) {
    log.error(`API ${name}: HTTP ${res.status}; respuesta: ${res.body.slice(0, 200)}`);
    throw new Error(`Pluto TV: HTTP ${res.status}`);
  }
  try {
    return JSON.parse(res.body) as T;
  } catch {
    log.error(`API ${name}: la respuesta no es JSON (${kb(res.body)}): ${res.body.slice(0, 120)}`);
    throw new Error(`Pluto TV: respuesta no válida de ${name}`);
  }
}

// ───────────────────────── Categorías ─────────────────────────

/** ¿Contiene alguna de estas palabras? (Pluto habla el idioma de su región: español, inglés…) */
const has = (text: string, words: string[]) => words.some((w) => text.includes(w));

/** Las categorías de Pluto («Películas de acción», «Kids», «Movies»…) → los temas de NOVA. */
function theme(category: string): Category {
  const c = category.toLowerCase();
  // El anime cuenta como infantil solo si lo dice la opción del plugin.
  if (c.includes("anime")) return settings.get<boolean>("animeInfantil") ? "Infantil" : "Entretenimiento";
  if (has(c, ["infantil", "kids", "niños", "familia", "family"])) return "Infantil";
  if (has(c, ["cine", "pelí", "movie", "film", "ficción", "sci-fi", "terror", "horror", "western"])) return "Cine";
  if (has(c, ["noticia", "news"])) return "Noticias";
  if (has(c, ["deporte", "sport"])) return "Deportes";
  if (has(c, ["música", "music"])) return "Música";
  if (has(c, ["cultura", "document", "natural", "nature", "history", "historia", "science", "ciencia"])) return "Documentales";
  if (has(c, ["series", "polic", "crimen", "crime", "drama", "classic tv", "sitcom"])) return "Series";
  return "Entretenimiento";
}

/** Categorías de temporada o de promoción: no son el sitio de verdad de un canal. */
function promo(category: string): boolean {
  return has(category.toLowerCase(), ["nuevo", "new", "halloween", "navidad", "christmas", "holiday", "destacado", "featured", "trending", "verano", "summer"]);
}

// ───────────────────────── Lo que devuelve Pluto ─────────────────────────

interface PlutoChannel {
  id: string;
  name: string;
  number: number;
  plutoOfficeOnly?: boolean;
  isStitched?: boolean;
  images?: { type: string; url: string }[];
}

interface PlutoCategory {
  name: string;
  channelIDs: string[];
}

interface PlutoTimeline {
  start: string;
  stop: string;
  title: string;
  episode?: { description?: string; genre?: string; thumbnail?: { path?: string } };
}

// ───────────────────────── El plugin ─────────────────────────

export default defineProvider({
  channels: {
    refresh: "12h",

    async load() {
      const t0 = Date.now();
      const { region } = await getSession();
      const [channels, categories] = await Promise.all([
        api<{ data: PlutoChannel[] }>("channels?channelIds=&offset=0&limit=1000&sort=number:asc"),
        api<{ data: PlutoCategory[] }>("categories"),
      ]);
      log.info(`canales: Pluto da ${channels.data?.length ?? 0} canales y ${categories.data?.length ?? 0} categorías (región ${region})`);

      // Pluto da las categorías al revés: cada una con sus canales.
      const categoriesOf = new Map<string, string[]>();
      for (const cat of categories.data) {
        for (const id of cat.channelIDs ?? []) categoriesOf.set(id, [...(categoriesOf.get(id) ?? []), cat.name]);
      }

      const skipped = { office: [] as string[], notStitched: [] as string[], badId: [] as string[] };
      const themesSeen = new Map<string, number>();
      const groupsSeen = new Map<string, number>();
      let noCategory = 0;
      let noLogo = 0;
      let outOfBlock = 0;
      const animeKids = settings.get<boolean>("animeInfantil") ?? true;

      const list: Channel[] = [];
      for (const ch of channels.data) {
        // Canales internos de Pluto o que no se pueden emitir.
        if (ch.plutoOfficeOnly) {
          skipped.office.push(ch.name);
          continue;
        }
        if (ch.isStitched === false) {
          skipped.notStitched.push(ch.name);
          continue;
        }
        if (!/^[A-Za-z0-9]+$/.test(ch.id)) {
          skipped.badId.push(`${ch.name} (${ch.id})`);
          continue;
        }
        const names = categoriesOf.get(ch.id) ?? [];
        if (!names.length) noCategory++;
        const real = names.filter((n) => !promo(n));
        const group = real[0] ?? names[0] ?? "Pluto TV";
        const themes = [...new Set((real.length ? real : [group]).map(theme))];
        for (const t of themes) themesSeen.set(t, (themesSeen.get(t) ?? 0) + 1);
        groupsSeen.set(group, (groupsSeen.get(group) ?? 0) + 1);
        if (!ch.images?.some((i) => i.type === "colorLogoPNG")) noLogo++;
        if (!(ch.number >= 1 && ch.number <= 500)) outOfBlock++;
        list.push({
          id: ch.id,
          name: ch.name.trim(),
          // Su número en Pluto si cabe en el bloque del plugin (1–500); si no, NOVA le da uno libre.
          number: ch.number >= 1 && ch.number <= 500 ? ch.number : undefined,
          logo: ch.images?.find((i) => i.type === "colorLogoPNG")?.url,
          group,
          categories: themes,
          country: region,
        });
      }
      const total = skipped.office.length + skipped.notStitched.length + skipped.badId.length;
      log.info(`canales: ${list.length} para NOVA en ${ms(t0)} · ${total} descartados (${skipped.office.length} internos, ${skipped.notStitched.length} sin emisión, ${skipped.badId.length} con id raro)`);
      if (skipped.notStitched.length) log.warn("canales sin emisión:", skipped.notStitched.slice(0, 15).join(", "));
      if (skipped.badId.length) log.warn("canales con id raro:", skipped.badId.slice(0, 15).join(", "));
      log.info(`canales por tema: ${tally(themesSeen)} (anime ${animeKids ? "cuenta como infantil" : "no cuenta como infantil"})`);
      log.info(`canales por grupo (${groupsSeen.size} grupos): ${tally(groupsSeen).split(" · ").slice(0, 15).join(" · ")}`);
      if (noCategory || noLogo || outOfBlock) {
        log.info(`canales: ${noCategory} sin categoría, ${noLogo} sin logo, ${outOfBlock} con un número que no cabe en el bloque (NOVA les da uno libre)`);
      }
      log.info("primeros canales:", list.slice(0, 5).map((c) => `${c.number ?? "—"} ${c.name} [${c.group}]`).join(" · "));
      return list;
    },

    // La emisión, sin firmar: una dirección corta que no caduca. Pluto solo deja
    // leer sus listas a su web (CORS), así que van por el proxy de NOVA.
    async stream(id, ctx) {
      const s = await getSession(ctx.retry);
      const url = `${s.stitcher}/v2/stitch/hls/channel/${id}/master.m3u8`;
      log.info(`emisión «${id}»${ctx.retry ? " (reintento)" : ""}: ${url}`);
      return { type: "hls", url, proxy: true, headers: { "user-agent": UA } };
    },

    // Y la firma, justo antes de que NOVA descargue la lista maestra (la sesión
    // del momento: si caducó, ya es la nueva). Las demás listas heredan el token
    // de la maestra (masterJWTPassthrough) y van tal cual.
    async sign(url, ctx) {
      if (!url.endsWith("/master.m3u8")) return url;
      // ctx.retry: Pluto rechazó la firma anterior (401/403) → sesión nueva.
      const s = await getSession(ctx.retry);
      if (ctx.retry) log.warn(`firma: Pluto rechazó la anterior; nueva sesión para ${bare(url)}`);
      return `${url}?${s.params}&jwt=${s.token}&masterJWTPassthrough=true`;
    },
  },

  guide: {
    refresh: "30m",

    async load(ids) {
      // Las próximas 6 horas, desde el principio de esta hora, en tandas de 60 canales.
      const t0 = Date.now();
      const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
      const batches = Math.ceil(ids.length / 60);
      log.info(`guía: ${ids.length} canales en ${batches} tandas, desde ${hour}`);
      const programs: Record<string, Program[]> = {};
      let failed = 0;
      for (let i = 0; i < ids.length; i += 60) {
        const batch = ids.slice(i, i + 60);
        const n = i / 60 + 1;
        const tb = Date.now();
        try {
          const json = await api<{ data: { channelId: string; timelines: PlutoTimeline[] }[] }>(
            `timelines?start=${hour}&channelIds=${batch.join(",")}&duration=360`,
          );
          const count = json.data.reduce((sum, ch) => sum + (ch.timelines?.length ?? 0), 0);
          const empty = batch.length - json.data.filter((ch) => ch.timelines?.length).length;
          log.info(`guía: tanda ${n}/${batches} → ${json.data.length} canales, ${count} programas, ${empty} sin programas, ${ms(tb)}`);
          for (const ch of json.data) {
            programs[ch.channelId] = (ch.timelines ?? []).map((t) => ({
              start: Date.parse(t.start) / 1000,
              end: Date.parse(t.stop) / 1000,
              title: t.title.trim(),
              description: t.episode?.description?.trim().slice(0, 320),
              genre: t.episode?.genre,
              image: t.episode?.thumbnail?.path,
            }));
          }
        } catch (e) {
          // Una tanda que falla no tira la guía entera.
          failed++;
          log.warn(`guía: tanda ${n}/${batches} falló (${batch.length} canales sin guía): ${String(e)}`);
        }
      }
      const total = Object.values(programs).reduce((sum, p) => sum + p.length, 0);
      log.info(`guía: ${Object.keys(programs).length} canales con ${total} programas en ${ms(t0)}${failed ? ` · ${failed} tandas fallidas` : ""}`);
      return programs;
    },
  },
});