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
  const boot = await http.json<Boot>(`${BOOT}?${query}`, { headers: { "user-agent": UA } });

  const stitcher = boot.servers?.stitcher;
  if (!boot.sessionToken || !stitcher?.startsWith("https://")) throw new Error("Pluto TV no dio una sesión");
  // Se renueva 10 minutos antes de que caduque.
  const seconds = Math.max(600, (boot.refreshInSec ?? 8 * 3600) - 600);
  session = {
    token: boot.sessionToken,
    params: boot.stitcherParams ?? "",
    stitcher,
    region: boot.session?.activeRegion ?? "ES",
    expiresAt: Date.now() + seconds * 1000,
  };
  return session;
}

/** GET a la API de Pluto con el token; si lo rechaza, una vez más con sesión nueva. */
async function api<T>(path: string): Promise<T> {
  const ask = async (fresh: boolean) => {
    const { token } = await getSession(fresh);
    return http.request({ url: `${API}/${path}`, headers: { authorization: `Bearer ${token}`, "user-agent": UA } });
  };
  let res = await ask(false);
  if (res.status === 401 || res.status === 403) res = await ask(true);
  if (res.status !== 200) throw new Error(`Pluto TV: HTTP ${res.status}`);
  return JSON.parse(res.body) as T;
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
      const { region } = await getSession();
      const [channels, categories] = await Promise.all([
        api<{ data: PlutoChannel[] }>("channels?channelIds=&offset=0&limit=1000&sort=number:asc"),
        api<{ data: PlutoCategory[] }>("categories"),
      ]);

      // Pluto da las categorías al revés: cada una con sus canales.
      const categoriesOf = new Map<string, string[]>();
      for (const cat of categories.data) {
        for (const id of cat.channelIDs ?? []) categoriesOf.set(id, [...(categoriesOf.get(id) ?? []), cat.name]);
      }

      const list: Channel[] = [];
      for (const ch of channels.data) {
        // Canales internos de Pluto o que no se pueden emitir.
        if (ch.plutoOfficeOnly || ch.isStitched === false || !/^[A-Za-z0-9]+$/.test(ch.id)) continue;
        const names = categoriesOf.get(ch.id) ?? [];
        const real = names.filter((n) => !promo(n));
        const group = real[0] ?? names[0] ?? "Pluto TV";
        const themes = [...new Set((real.length ? real : [group]).map(theme))];
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
      log.info(`${list.length} canales de Pluto TV (región ${region})`);
      return list;
    },

    // La emisión se pide al sintonizar: va firmada con la sesión, que caduca.
    async stream(id, ctx) {
      // ctx.retry: Pluto rechazó la anterior (401/403) → sesión nueva.
      const s = await getSession(ctx.retry);
      const url = `${s.stitcher}/v2/stitch/hls/channel/${id}/master.m3u8?${s.params}&jwt=${s.token}&masterJWTPassthrough=true`;
      return { type: "hls", url, proxy: true, headers: { "user-agent": UA } };
    },
  },

  guide: {
    refresh: "30m",

    async load(ids) {
      // Las próximas 6 horas, desde el principio de esta hora, en tandas de 60 canales.
      const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
      const programs: Record<string, Program[]> = {};
      for (let i = 0; i < ids.length; i += 60) {
        const batch = ids.slice(i, i + 60);
        try {
          const json = await api<{ data: { channelId: string; timelines: PlutoTimeline[] }[] }>(
            `timelines?start=${hour}&channelIds=${batch.join(",")}&duration=360`,
          );
          for (const ch of json.data) {
            programs[ch.channelId] = ch.timelines.map((t) => ({
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
          log.warn("Guía incompleta:", String(e));
        }
      }
      return programs;
    },
  },
});